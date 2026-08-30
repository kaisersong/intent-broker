/**
 * Room membership invariants (design §4.1, §6.2, §8.5, §16.1).
 *
 * RED until Phase 1 implementation lands.
 *
 * Invariants under test:
 *   - active agent member cap is 6; human owner does not count toward it.
 *   - duplicate agent ids in one mutation are rejected.
 *   - agents can never hold the owner role.
 *   - the last active user owner cannot be removed or demoted
 *     (including self-removal and concurrent owner changes).
 *   - removal uses the reservation protocol: pending_removal first,
 *     finalized only after KSwarm reports no blockers.
 *   - non-members and removed members cannot send or read room transcript.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { createRoomStore } from '../../src/room/store.js';
import { createRoomService } from '../../src/room/service.js';

const SIX_AGENTS = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5', 'agent-6'];

function userCtx(overrides = {}) {
  return {
    sessionId: 'sess-user-1',
    requestSource: 'user',
    actor: { kind: 'user', userId: 'user.local' },
    allowedLogicalAgentIds: [],
    issuedAt: new Date().toISOString(),
    ...overrides,
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
  return createRoomService({ store, ...overrides });
}

function createRoom(service, memberAgentIds) {
  const result = service.createRoom(
    { title: 'Room', memberAgentIds, clientRequestKey: `crk-${Math.random()}` },
    userCtx()
  );
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

test('allows exactly six active agent members plus the human owner', () => {
  const service = createService();
  const result = createRoom(service, SIX_AGENTS);
  const activeAgents = result.members.filter(
    (m) => m.subject.kind === 'agent' && m.status === 'active'
  );
  assert.equal(activeAgents.length, 6);
});

test('rejects a seventh active agent at creation', () => {
  const service = createService();
  const result = service.createRoom(
    { title: 'too big', memberAgentIds: [...SIX_AGENTS, 'agent-7'], clientRequestKey: 'crk-7' },
    userCtx()
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'room_member_limit_exceeded');
});

test('rejects adding a seventh active agent after creation', () => {
  const service = createService();
  const created = createRoom(service, SIX_AGENTS);

  const attempt = service.updateRoomMembers(
    {
      roomId: created.room.roomId,
      expectedRoomRevision: created.room.revision,
      addAgentIds: ['agent-7'],
    },
    userCtx()
  );
  assert.equal(attempt.ok, false);
  assert.equal(attempt.code, 'room_member_limit_exceeded');
});

test('rejects duplicate agent ids inside one mutation', () => {
  const service = createService();
  const result = service.createRoom(
    { title: 'dup', memberAgentIds: ['agent-1', 'agent-1'], clientRequestKey: 'crk-dup' },
    userCtx()
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'room_member_duplicate');
});

test('agent members can never be granted the owner role', () => {
  const service = createService();
  const created = createRoom(service, ['agent-alpha']);

  const attempt = service.updateRoomMembers(
    {
      roomId: created.room.roomId,
      expectedRoomRevision: created.room.revision,
      roleChanges: [{ logicalAgentId: 'agent-alpha', role: 'owner' }],
    },
    userCtx()
  );
  assert.equal(attempt.ok, false);
  assert.equal(attempt.code, 'room_actor_forbidden');
});

test('the last active user owner cannot be removed by anyone', () => {
  const service = createService();
  const created = createRoom(service, ['agent-alpha']);

  const selfRemoval = service.updateRoomMembers(
    {
      roomId: created.room.roomId,
      expectedRoomRevision: created.room.revision,
      removeUserIds: ['user.local'],
    },
    userCtx()
  );
  assert.equal(selfRemoval.ok, false);
  assert.equal(selfRemoval.code, 'room_last_owner_removal_forbidden');

  const demote = service.updateRoomMembers(
    {
      roomId: created.room.roomId,
      expectedRoomRevision: created.room.revision,
      roleChanges: [{ userId: 'user.local', role: 'member' }],
    },
    userCtx()
  );
  assert.equal(demote.ok, false);
  assert.equal(demote.code, 'room_last_owner_removal_forbidden');
});

test('self-removal succeeds once another active owner exists', () => {
  const service = createService();
  const created = createRoom(service, ['agent-alpha']);

  const addOwner = service.updateRoomMembers(
    {
      roomId: created.room.roomId,
      expectedRoomRevision: created.room.revision,
      addUserIds: ['user.second'],
      roleChanges: [{ userId: 'user.second', role: 'owner' }],
    },
    userCtx()
  );
  assert.ok(addOwner.ok, JSON.stringify(addOwner));

  const selfRemoval = service.updateRoomMembers(
    {
      roomId: addOwner.room.roomId,
      expectedRoomRevision: addOwner.room.revision,
      removeUserIds: ['user.local'],
    },
    userCtx()
  );
  assert.ok(selfRemoval.ok, JSON.stringify(selfRemoval));
});

test('agent removal goes through pending_removal and needs a blocker check before finalize', async () => {
  const service = createService({
    // blocker provider simulates KSwarm's project-side fact ownership
    listProjectBlockers: async () => ({ blockers: [] }),
  });
  const created = createRoom(service, ['agent-alpha', 'agent-beta']);

  const removal = service.updateRoomMembers(
    {
      roomId: created.room.roomId,
      expectedRoomRevision: created.room.revision,
      removeAgentIds: ['agent-alpha'],
    },
    userCtx()
  );
  assert.ok(removal.ok, JSON.stringify(removal));
  const alpha = removal.members.find(
    (m) => m.subject.kind === 'agent' && m.subject.logicalAgentId === 'agent-alpha'
  );
  assert.equal(alpha.status, 'pending_removal');

  // with no blockers the finalize step completes the removal
  const finalized = await service.finalizeMemberRemovals({ roomId: created.room.roomId });
  assert.ok(finalized.ok, JSON.stringify(finalized));
  const after = finalized.members.find(
    (m) => m.subject.kind === 'agent' && m.subject.logicalAgentId === 'agent-alpha'
  );
  assert.equal(after.status, 'removed');
});

test('pending_removal blocks new membership-use leases and is restored when blockers exist', async () => {
  const service = createService({
    listProjectBlockers: async ({ logicalAgentId }) =>
      logicalAgentId === 'agent-alpha'
        ? { blockers: ['project_po:proj-1'] }
        : { blockers: [] },
  });
  const created = createRoom(service, ['agent-alpha']);

  const removal = service.updateRoomMembers(
    {
      roomId: created.room.roomId,
      expectedRoomRevision: created.room.revision,
      removeAgentIds: ['agent-alpha'],
    },
    userCtx()
  );
  assert.ok(removal.ok);

  const lease = service.acquireMembershipLease(
    { roomId: created.room.roomId, logicalAgentId: 'agent-alpha', operationId: 'op-1' },
    {
      sessionId: 'kswarm-system',
      requestSource: 'system',
      actor: { kind: 'system', service: 'kswarm' },
      scopes: ['room-membership-lease'],
      issuedAt: new Date().toISOString(),
    }
  );
  assert.equal(lease.ok, false);
  assert.equal(lease.code, 'room_member_removal_pending');

  // blockers exist -> removal must roll back to active (design §8.5)
  const finalized = await service.finalizeMemberRemovals({ roomId: created.room.roomId });
  assert.ok(finalized.ok);
  const restored = finalized.members.find(
    (m) => m.subject.kind === 'agent' && m.subject.logicalAgentId === 'agent-alpha'
  );
  assert.equal(restored.status, 'active');
});

test('non-members cannot send messages or read the room transcript', () => {
  const service = createService();
  const created = createRoom(service, ['agent-alpha']);

  const outsider = userCtx({
    sessionId: 'sess-user-outside',
    actor: { kind: 'user', userId: 'user.outside' },
  });

  const send = service.sendRoomMessage(
    { roomId: created.room.roomId, text: 'hi', responsePolicy: 'none', idempotencyKey: 'im-out-1' },
    outsider
  );
  assert.equal(send.ok, false);
  assert.equal(send.code, 'room_membership_required');

  const read = service.listRoomMessages({ roomId: created.room.roomId }, outsider);
  assert.equal(read.ok, false);
  assert.equal(read.code, 'room_membership_required');
});

test('removed agents can no longer read the transcript or be woken', async () => {
  const service = createService({ listProjectBlockers: async () => ({ blockers: [] }) });
  const created = createRoom(service, ['agent-alpha']);

  const send = service.sendRoomMessage(
    {
      roomId: created.room.roomId,
      text: 'hello @agent-alpha',
      mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
      responsePolicy: 'mentioned',
      idempotencyKey: 'im-pre-remove',
    },
    userCtx()
  );
  assert.ok(send.ok, JSON.stringify(send));

  const removal = service.updateRoomMembers(
    {
      roomId: created.room.roomId,
      expectedRoomRevision: created.room.revision,
      removeAgentIds: ['agent-alpha'],
    },
    userCtx()
  );
  assert.ok(removal.ok);
  await service.finalizeMemberRemovals({ roomId: created.room.roomId });

  const read = service.listRoomMessages({ roomId: created.room.roomId }, agentCtx('agent-alpha'));
  assert.equal(read.ok, false);
  assert.equal(read.code, 'room_membership_required');

  const wake = service.claimWake(
    { roomMessageId: send.message.messageId, logicalAgentId: 'agent-alpha', hostParticipantId: 'xiaok-desktop' },
    agentCtx('agent-alpha')
  );
  assert.equal(wake.ok, false);
});
