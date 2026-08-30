/**
 * Room service requestSource permission matrix (design §10.1, §16.1).
 *
 * RED until Phase 1 implementation lands. All calls go through the
 * production createRoomService(); no permission logic is re-implemented here.
 *
 * TrustedActorContext (design §10.3) is constructed by authenticated
 * transport sessions. These tests exercise the service gate itself:
 * every mutation method must receive a valid TrustedActorContext and
 * default deny anything outside the matrix below.
 *
 * Matrix (design §10.1):
 *   create Room:          user yes | agent no (proposal only) | system migration/recovery allowlist only
 *   archive Room:         owner user yes | agent no | system explicit recovery policy only
 *   add/remove member:    owner user yes | agent no | system KSwarm reconcile allowlist only
 *   send text message:    active user member yes | active agent member yes | system no
 *   send project event:   user/agent forged no | system KSwarm publisher identity only
 *   start team_once:      user yes | agent no | system no
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { createRoomStore } from '../../src/room/store.js';
import { createRoomService } from '../../src/room/service.js';

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

function agentCtx(logicalAgentId, overrides = {}) {
  return {
    sessionId: 'sess-agent-1',
    requestSource: 'agent',
    actor: { kind: 'agent', logicalAgentId },
    hostParticipantId: 'xiaok-desktop',
    allowedLogicalAgentIds: [logicalAgentId],
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

function systemCtx(service, overrides = {}) {
  return {
    sessionId: 'sess-system-1',
    requestSource: 'system',
    actor: { kind: 'system', service },
    allowedLogicalAgentIds: [],
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createService(overrides = {}) {
  const store = createRoomStore({ dbPath: createTempDbPath() });
  store.migrate();
  return createRoomService({ store, ...overrides });
}

function createRoomForUser(service, { memberAgentIds = ['agent-alpha'] } = {}) {
  const result = service.createRoom(
    { title: '测试 Room', memberAgentIds, clientRequestKey: `crk-${Math.random()}` },
    userCtx()
  );
  assert.ok(result.ok, `setup createRoom failed: ${JSON.stringify(result)}`);
  return result.room;
}

test('user with requestSource user can create a room and becomes its owner member', () => {
  const service = createService();
  const result = service.createRoom(
    { title: 'Room', memberAgentIds: ['agent-alpha'], clientRequestKey: 'crk-1' },
    userCtx()
  );

  assert.ok(result.ok);
  assert.equal(result.room.origin, 'user_created');
  assert.equal(result.room.status, 'active');
  const owner = result.members.find((m) => m.subject.kind === 'user');
  assert.equal(owner.role, 'owner');
  assert.equal(owner.status, 'active');
});

test('agent cannot create a room regardless of payload content', () => {
  const service = createService();
  const result = service.createRoom(
    {
      title: 'agent made this',
      memberAgentIds: ['agent-alpha'],
      clientRequestKey: 'crk-agent-1',
      // forged payload-level identity fields must not grant anything
      requestSource: 'user',
      actor: { kind: 'user', userId: 'user.local' },
    },
    agentCtx('agent-alpha')
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'room_actor_forbidden');
});

test('system cannot create a room without the migration/recovery allowlist', () => {
  const service = createService();
  const result = service.createRoom(
    { title: 'system room', memberAgentIds: [], clientRequestKey: 'crk-sys-1' },
    systemCtx('desktop')
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'room_actor_forbidden');
});

test('system with migration scope can create a legacy migration room', () => {
  const service = createService({
    systemCreateRoomAllowlist: ['migration', 'recovery'],
  });
  const result = service.createRoom(
    {
      title: 'legacy project room',
      memberAgentIds: ['agent-alpha'],
      origin: 'legacy_project_migration',
      clientRequestKey: 'crk-sys-mig-1',
    },
    systemCtx('intent-broker', { scopes: ['migration'] })
  );

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.room.origin, 'legacy_project_migration');
});

test('agent cannot archive a room, only the owning user can', () => {
  const service = createService();
  const room = createRoomForUser(service);

  const agentAttempt = service.archiveRoom(
    { roomId: room.roomId, expectedRoomRevision: room.revision },
    agentCtx('agent-alpha')
  );
  assert.equal(agentAttempt.ok, false);
  assert.equal(agentAttempt.code, 'room_actor_forbidden');

  const ownerAttempt = service.archiveRoom(
    { roomId: room.roomId, expectedRoomRevision: room.revision },
    userCtx()
  );
  assert.ok(ownerAttempt.ok, JSON.stringify(ownerAttempt));
  assert.notEqual(ownerAttempt.room.status, 'active');
});

test('a non-owner user member cannot archive the room', () => {
  const service = createService();
  const room = createRoomForUser(service);

  const otherUser = userCtx({
    sessionId: 'sess-user-2',
    actor: { kind: 'user', userId: 'user.other' },
  });
  // user.other is not a member at all — membership check fires first
  const attempt = service.archiveRoom(
    { roomId: room.roomId, expectedRoomRevision: room.revision },
    otherUser
  );
  assert.equal(attempt.ok, false);
  assert.equal(attempt.code, 'room_membership_required');
});

test('agent cannot add or remove room members', () => {
  const service = createService();
  const room = createRoomForUser(service);

  const add = service.updateRoomMembers(
    { roomId: room.roomId, expectedRoomRevision: room.revision, addAgentIds: ['agent-beta'] },
    agentCtx('agent-alpha')
  );
  assert.equal(add.ok, false);
  assert.equal(add.code, 'room_actor_forbidden');

  const remove = service.updateRoomMembers(
    { roomId: room.roomId, expectedRoomRevision: room.revision, removeAgentIds: ['agent-alpha'] },
    agentCtx('agent-alpha')
  );
  assert.equal(remove.ok, false);
  assert.equal(remove.code, 'room_actor_forbidden');
});

test('agent cannot start a team_once discussion', () => {
  const service = createService();
  const room = createRoomForUser(service);

  const attempt = service.startTeamDiscussion(
    { roomId: room.roomId, expectedRoomRevision: room.revision, topic: 'self invited' },
    agentCtx('agent-alpha')
  );
  assert.equal(attempt.ok, false);
  assert.equal(attempt.code, 'room_actor_forbidden');
});

test('system cannot send a room text message', () => {
  const service = createService();
  const room = createRoomForUser(service);

  const attempt = service.sendRoomMessage(
    { roomId: room.roomId, text: 'from system', responsePolicy: 'none', idempotencyKey: 'im-sys-1' },
    systemCtx('desktop')
  );
  assert.equal(attempt.ok, false);
  assert.equal(attempt.code, 'room_actor_forbidden');
});

test('project_event messages are only accepted from the KSwarm publisher identity', () => {
  const service = createService();
  const room = createRoomForUser(service);

  const forged = service.sendRoomMessage(
    {
      roomId: room.roomId,
      kind: 'project_event',
      text: 'fake project event',
      responsePolicy: 'none',
      idempotencyKey: 'im-forged-1',
    },
    userCtx()
  );
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'room_actor_forbidden');

  const publisherOk = service.sendRoomMessage(
    {
      roomId: room.roomId,
      kind: 'project_event',
      text: 'project created',
      responsePolicy: 'none',
      idempotencyKey: 'im-pub-1',
      sourceRef: { projectId: 'proj-1' },
      projectionEventId: 'pev-1',
    },
    systemCtx('kswarm', { scopes: ['room-project-event-publisher'] })
  );
  assert.ok(publisherOk.ok, JSON.stringify(publisherOk));
});

test('mutations without a trusted actor context are rejected as unauthenticated', () => {
  const service = createService();
  const room = createRoomForUser(service);

  assert.equal(service.sendRoomMessage(
    { roomId: room.roomId, text: 'no ctx', responsePolicy: 'none', idempotencyKey: 'im-noctx-1' },
    null
  ).code, 'room_authentication_required');

  assert.equal(service.createRoom(
    { title: 'no ctx', memberAgentIds: [], clientRequestKey: 'crk-noctx' },
    { actor: { kind: 'user', userId: 'user.local' } } // missing sessionId/requestSource
  ).code, 'room_authentication_required');
});

test('stale expectedRoomRevision is rejected with room_revision_conflict', () => {
  const service = createService();
  const room = createRoomForUser(service);

  const attempt = service.archiveRoom(
    { roomId: room.roomId, expectedRoomRevision: room.revision - 1 },
    userCtx()
  );
  assert.equal(attempt.ok, false);
  assert.equal(attempt.code, 'room_revision_conflict');
});
