/**
 * Room durable state recovery (design §11.3, §16.1).
 *
 * RED until Phase 1 implementation lands.
 *
 * Invariants under test:
 *   - Room, members, messages, deliveries and cursors survive a broker
 *     restart (store reopen from the same SQLite file).
 *   - runtime participant presence sweeps never delete logical Room
 *     obligations; re-registration only refreshes the transport address.
 *   - offline agents keep pending wake obligations that can be claimed
 *     after they come back; completed obligations are never re-executed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { createRoomStore } from '../../src/room/store.js';
import { createRoomService } from '../../src/room/service.js';

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

test('room state fully survives a broker restart from the same database file', async () => {
  const dbPath = createTempDbPath();

  const storeOne = createRoomStore({ dbPath });
  storeOne.migrate();
  const serviceOne = createRoomService({ store: storeOne });

  const created = serviceOne.createRoom(
    { title: 'Durable', memberAgentIds: ['agent-alpha'], clientRequestKey: 'crk-restart-1' },
    userCtx()
  );
  assert.ok(created.ok);

  const sent = serviceOne.sendRoomMessage(
    {
      roomId: created.room.roomId,
      text: 'hello @agent-alpha',
      mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
      responsePolicy: 'mentioned',
      idempotencyKey: 'im-restart-1',
    },
    userCtx()
  );
  assert.ok(sent.ok);

  const wake = serviceOne.claimWake(
    { roomMessageId: sent.message.messageId, logicalAgentId: 'agent-alpha', hostParticipantId: 'xiaok-desktop' },
    agentCtx('agent-alpha')
  );
  assert.ok(wake.ok);
  await serviceOne.completeWake({ claimToken: wake.claimToken, reply: { kind: 'text', text: 'done' } });
  storeOne.close();

  // broker "restart": fresh store + service over the same file
  const storeTwo = createRoomStore({ dbPath });
  const serviceTwo = createRoomService({ store: storeTwo });

  const recovered = serviceTwo.getCollaborationRoom({ roomId: created.room.roomId }, userCtx());
  assert.ok(recovered.ok, JSON.stringify(recovered));
  assert.equal(recovered.room.title, 'Durable');

  const messages = serviceTwo.listRoomMessages({ roomId: created.room.roomId }, userCtx());
  assert.equal(messages.messages.length, 2); // user message + agent reply

  const deliveries = serviceTwo.listDeliveries({ roomMessageId: sent.message.messageId });
  const alpha = deliveries.find((d) => d.recipientKey === 'agent:agent-alpha');
  assert.equal(alpha.wakeStatus, 'completed');
  assert.ok(alpha.runtimeParticipantIdSnapshot);

  // a completed obligation is not offered again after restart
  const pending = serviceTwo.listPendingWakeObligations({ logicalAgentId: 'agent-alpha' });
  assert.equal(pending.obligations.filter((o) => o.roomMessageId === sent.message.messageId).length, 0);
});

test('presence sweep keeps logical room obligations intact', async () => {
  const dbPath = createTempDbPath();
  const store = createRoomStore({ dbPath });
  store.migrate();
  const service = createRoomService({ store });

  const created = service.createRoom(
    { title: 'Sweep', memberAgentIds: ['agent-alpha'], clientRequestKey: 'crk-sweep-1' },
    userCtx()
  );
  const sent = service.sendRoomMessage(
    {
      roomId: created.room.roomId,
      mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
      responsePolicy: 'mentioned',
      idempotencyKey: 'im-sweep-1',
    },
    userCtx()
  );
  assert.ok(sent.ok);

  // production presence sweep runs (participants come and go);
  // it must not touch logical room obligations
  await service.sweepRuntimePresence();

  const deliveries = service.listDeliveries({ roomMessageId: sent.message.messageId });
  const alpha = deliveries.find((d) => d.recipientKey === 'agent:agent-alpha');
  assert.equal(alpha.visibilityStatus, 'pending');
  assert.equal(alpha.wakeStatus, 'pending');
});

test('offline agent obligations stay pending and are claimable after the agent returns', async () => {
  const dbPath = createTempDbPath();
  const store = createRoomStore({ dbPath });
  store.migrate();
  const service = createRoomService({ store });

  const created = service.createRoom(
    { title: 'Offline', memberAgentIds: ['agent-alpha'], clientRequestKey: 'crk-off-1' },
    userCtx()
  );
  const sent = service.sendRoomMessage(
    {
      roomId: created.room.roomId,
      mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
      responsePolicy: 'mentioned',
      idempotencyKey: 'im-off-1',
    },
    userCtx()
  );
  assert.ok(sent.ok);

  // agent is offline: obligation stays pending across sweeps
  await service.sweepRuntimePresence();
  await service.sweepRuntimePresence();

  const pendingBefore = service.listPendingWakeObligations({ logicalAgentId: 'agent-alpha' });
  assert.equal(pendingBefore.obligations.length, 1);
  assert.equal(pendingBefore.obligations[0].roomMessageId, sent.message.messageId);

  // agent comes back online and claims the same obligation
  const wake = service.claimWake(
    { roomMessageId: sent.message.messageId, logicalAgentId: 'agent-alpha', hostParticipantId: 'xiaok-desktop' },
    agentCtx('agent-alpha')
  );
  assert.ok(wake.ok, JSON.stringify(wake));

  // claim is lease-bound: a second concurrent claim of the same obligation fails
  const secondClaim = service.claimWake(
    { roomMessageId: sent.message.messageId, logicalAgentId: 'agent-alpha', hostParticipantId: 'xiaok-desktop' },
    agentCtx('agent-alpha')
  );
  assert.equal(secondClaim.ok, false);

  await service.completeWake({ claimToken: wake.claimToken, reply: { kind: 'text', text: 'back online' } });

  const pendingAfter = service.listPendingWakeObligations({ logicalAgentId: 'agent-alpha' });
  assert.equal(pendingAfter.obligations.length, 0);
});
