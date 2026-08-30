/**
 * Room archive settlement (design §7.4, §16.1).
 *
 * RED until Phase 1 implementation lands.
 *
 * Invariants under test:
 *   - archive is a state machine: active -> archiving -> archived.
 *   - entering archiving increments the discussion epoch in the same
 *     transaction and cancels unclaimed wake obligations.
 *   - new messages and member mutations are rejected once archiving.
 *   - an in-flight claimed execution gets a grace window: completing inside
 *     it appends the reply; completing after it only writes execution audit.
 *   - the room only becomes archived once inflight claims are settled.
 *   - new user messages also advance the epoch (stale runs stop appending).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { createRoomStore } from '../../src/room/store.js';
import { createRoomService } from '../../src/room/service.js';

const GRACE_MS = 60_000;

function userCtx() {
  return {
    sessionId: 'sess-user-1',
    requestSource: 'user',
    actor: { kind: 'user', userId: 'user.local' },
    allowedLogicalAgentIds: [],
    issuedAt: new Date().toISOString(),
  };
}

function agentCtx(logicalAgentId) {
  return {
    sessionId: 'sess-agent-1',
    requestSource: 'agent',
    actor: { kind: 'agent', logicalAgentId },
    hostParticipantId: 'xiaok-desktop',
    allowedLogicalAgentIds: [logicalAgentId],
    issuedAt: new Date().toISOString(),
  };
}

function createService(overrides = {}) {
  const store = createRoomStore({ dbPath: createTempDbPath() });
  store.migrate();
  return createRoomService({ store, wakeClaimGraceMs: GRACE_MS, ...overrides });
}

async function setup(service) {
  const created = service.createRoom(
    { title: 'Archive', memberAgentIds: ['agent-alpha', 'agent-beta'], clientRequestKey: `crk-arc-${Math.random()}` },
    userCtx()
  );
  assert.ok(created.ok, JSON.stringify(created));
  return created;
}

test('archive moves the room to archiving and bumps the discussion epoch', async () => {
  const service = createService();
  const created = await setup(service);

  const epochBefore = service.getDiscussionEpoch({ roomId: created.room.roomId });

  const archived = service.archiveRoom(
    { roomId: created.room.roomId, expectedRoomRevision: created.room.revision },
    userCtx()
  );
  assert.ok(archived.ok, JSON.stringify(archived));
  assert.equal(archived.room.status, 'archiving');

  const epochAfter = service.getDiscussionEpoch({ roomId: created.room.roomId });
  assert.ok(epochAfter > epochBefore, 'epoch must advance when archiving starts');
});

test('archiving rooms reject new messages and member mutations with room_archived', async () => {
  const service = createService();
  const created = await setup(service);

  const archived = service.archiveRoom(
    { roomId: created.room.roomId, expectedRoomRevision: created.room.revision },
    userCtx()
  );
  assert.ok(archived.ok);

  const send = service.sendRoomMessage(
    { roomId: created.room.roomId, text: 'too late', responsePolicy: 'none', idempotencyKey: 'im-arc-1' },
    userCtx()
  );
  assert.equal(send.ok, false);
  assert.equal(send.code, 'room_archived');

  const mutate = service.updateRoomMembers(
    { roomId: created.room.roomId, expectedRoomRevision: archived.room.revision, addAgentIds: ['agent-gamma'] },
    userCtx()
  );
  assert.equal(mutate.ok, false);
  assert.equal(mutate.code, 'room_archived');
});

test('unclaimed wakes are cancelled when archiving starts', async () => {
  const service = createService();
  const created = await setup(service);

  const sent = service.sendRoomMessage(
    {
      roomId: created.room.roomId,
      mentions: [
        { kind: 'agent', logicalAgentId: 'agent-alpha' },
        { kind: 'agent', logicalAgentId: 'agent-beta' },
      ],
      responsePolicy: 'mentioned',
      idempotencyKey: 'im-arc-unclaimed',
    },
    userCtx()
  );
  assert.ok(sent.ok);

  // only agent-alpha claimed its wake before archive
  const alphaClaim = service.claimWake(
    { roomMessageId: sent.message.messageId, logicalAgentId: 'agent-alpha', hostParticipantId: 'xiaok-desktop' },
    agentCtx('agent-alpha')
  );
  assert.ok(alphaClaim.ok);

  service.archiveRoom(
    { roomId: created.room.roomId, expectedRoomRevision: created.room.revision },
    userCtx()
  );

  const deliveries = service.listDeliveries({ roomMessageId: sent.message.messageId });
  const beta = deliveries.find((d) => d.recipientKey === 'agent:agent-beta');
  assert.equal(beta.wakeStatus, 'cancelled');

  // the unclaimed beta wake can no longer be claimed after archive
  const lateClaim = service.claimWake(
    { roomMessageId: sent.message.messageId, logicalAgentId: 'agent-beta', hostParticipantId: 'xiaok-desktop' },
    agentCtx('agent-beta')
  );
  assert.equal(lateClaim.ok, false);
});

test('a claimed execution completing inside the grace window lands in the transcript', async () => {
  const service = createService({ now: () => new Date('2026-01-01T00:00:00Z') });
  const created = await setup(service);

  const sent = service.sendRoomMessage(
    {
      roomId: created.room.roomId,
      mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
      responsePolicy: 'mentioned',
      idempotencyKey: 'im-arc-grace-ok',
    },
    userCtx()
  );
  const claim = service.claimWake(
    { roomMessageId: sent.message.messageId, logicalAgentId: 'agent-alpha', hostParticipantId: 'xiaok-desktop' },
    agentCtx('agent-alpha')
  );
  assert.ok(claim.ok);

  service.archiveRoom(
    { roomId: created.room.roomId, expectedRoomRevision: created.room.revision },
    userCtx()
  );

  // complete 30s into the 60s grace window
  const completed = await service.completeWake({
    claimToken: claim.claimToken,
    reply: { kind: 'text', text: 'made it in time' },
    now: new Date('2026-01-01T00:00:30Z'),
  });
  assert.ok(completed.ok, JSON.stringify(completed));

  const messages = service.listRoomMessages({ roomId: created.room.roomId }, userCtx());
  assert.equal(messages.messages.filter((m) => m.text === 'made it in time').length, 1);
});

test('a claimed execution completing after the grace window only writes execution audit', async () => {
  const service = createService({ now: () => new Date('2026-01-01T00:00:00Z') });
  const created = await setup(service);

  const sent = service.sendRoomMessage(
    {
      roomId: created.room.roomId,
      mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
      responsePolicy: 'mentioned',
      idempotencyKey: 'im-arc-grace-late',
    },
    userCtx()
  );
  const claim = service.claimWake(
    { roomMessageId: sent.message.messageId, logicalAgentId: 'agent-alpha', hostParticipantId: 'xiaok-desktop' },
    agentCtx('agent-alpha')
  );
  assert.ok(claim.ok);

  service.archiveRoom(
    { roomId: created.room.roomId, expectedRoomRevision: created.room.revision },
    userCtx()
  );

  // complete past the 60s grace window
  const completed = await service.completeWake({
    claimToken: claim.claimToken,
    reply: { kind: 'text', text: 'too late, audit only' },
    now: new Date('2026-01-01T00:02:00Z'),
  });

  const messages = service.listRoomMessages({ roomId: created.room.roomId }, userCtx());
  assert.equal(messages.messages.filter((m) => m.text === 'too late, audit only').length, 0);

  // the outcome is recorded as durable execution audit, not silently dropped
  const audit = service.listExecutionAudit({ roomId: created.room.roomId });
  const entry = audit.entries.find((e) => e.roomMessageId === sent.message.messageId);
  assert.ok(entry, 'late execution must be recorded in room_execution_audit');
  assert.ok(completed.ok || completed.code === 'room_archived');
});

test('the room only becomes archived after inflight claims settle or expire', async () => {
  const service = createService({ now: () => new Date('2026-01-01T00:00:00Z') });
  const created = await setup(service);

  const sent = service.sendRoomMessage(
    {
      roomId: created.room.roomId,
      mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
      responsePolicy: 'mentioned',
      idempotencyKey: 'im-arc-finalize',
    },
    userCtx()
  );
  const claim = service.claimWake(
    { roomMessageId: sent.message.messageId, logicalAgentId: 'agent-alpha', hostParticipantId: 'xiaok-desktop' },
    agentCtx('agent-alpha')
  );

  service.archiveRoom(
    { roomId: created.room.roomId, expectedRoomRevision: created.room.revision },
    userCtx()
  );
  assert.equal(service.getCollaborationRoom({ roomId: created.room.roomId }, userCtx()).room.status, 'archiving');

  // grace window passes without completion
  service.settleArchiveGrace({ roomId: created.room.roomId, now: new Date('2026-01-01T00:02:00Z') });
  assert.equal(service.getCollaborationRoom({ roomId: created.room.roomId }, userCtx()).room.status, 'archived');

  // the expired claim can no longer append anything
  const late = await service.completeWake({
    claimToken: claim.claimToken,
    reply: { kind: 'text', text: 'zombie claim' },
    now: new Date('2026-01-01T00:03:00Z'),
  });
  assert.equal(late.ok, false);
});

test('new user messages advance the discussion epoch so stale runs stop appending', async () => {
  const service = createService();
  const created = await setup(service);

  const epochBefore = service.getDiscussionEpoch({ roomId: created.room.roomId });

  service.sendRoomMessage(
    { roomId: created.room.roomId, text: 'new turn', responsePolicy: 'none', idempotencyKey: 'im-epoch-1' },
    userCtx()
  );

  const epochAfter = service.getDiscussionEpoch({ roomId: created.room.roomId });
  assert.ok(epochAfter > epochBefore, 'a new user message must advance the epoch');
});
