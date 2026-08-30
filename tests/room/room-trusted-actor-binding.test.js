/**
 * TrustedActorContext construction and binding (design §10.3, §16.1).
 *
 * RED until Phase 1 implementation lands.
 *
 * Invariants under test:
 *   - requestSource / actor / logicalAgentId are not payload fields; they
 *     come from an authenticated transport session as TrustedActorContext.
 *   - malformed or self-inconsistent contexts fail verification with
 *     room_authentication_required / room_actor_identity_mismatch.
 *   - payload-level identity spoofing never upgrades a context.
 *   - hosted logical agent identity is constrained by allowedLogicalAgentIds
 *     from the host session; caller-declared targetAgentId cannot expand it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { createRoomStore } from '../../src/room/store.js';
import { createRoomService } from '../../src/room/service.js';
import {
  verifyTrustedActorContext,
} from '../../src/room/trusted-context.js';

function validUserCtx() {
  return {
    sessionId: 'sess-user-1',
    requestSource: 'user',
    actor: { kind: 'user', userId: 'user.local' },
    allowedLogicalAgentIds: [],
    issuedAt: new Date().toISOString(),
  };
}

test('a well-formed context passes verification', () => {
  const result = verifyTrustedActorContext(validUserCtx());
  assert.deepEqual(result, { ok: true });
});

test('missing sessionId, requestSource or actor fails verification', () => {
  const { sessionId, ...noSession } = validUserCtx();
  assert.equal(verifyTrustedActorContext(noSession).code, 'room_authentication_required');

  const { requestSource, ...noSource } = validUserCtx();
  assert.equal(verifyTrustedActorContext(noSource).code, 'room_authentication_required');

  const { actor, ...noActor } = validUserCtx();
  assert.equal(verifyTrustedActorContext(noActor).code, 'room_authentication_required');
});

test('unknown requestSource values are rejected', () => {
  const result = verifyTrustedActorContext({
    ...validUserCtx(),
    requestSource: 'superuser',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'room_authentication_required');
});

test('agent requestSource requires an agent actor whose logicalAgentId is in the allowlist', () => {
  const ok = verifyTrustedActorContext({
    sessionId: 'sess-agent-1',
    requestSource: 'agent',
    actor: { kind: 'agent', logicalAgentId: 'agent-alpha' },
    hostParticipantId: 'xiaok-desktop',
    allowedLogicalAgentIds: ['agent-alpha', 'agent-beta'],
    issuedAt: new Date().toISOString(),
  });
  assert.deepEqual(ok, { ok: true });

  const kindMismatch = verifyTrustedActorContext({
    sessionId: 'sess-agent-2',
    requestSource: 'agent',
    actor: { kind: 'user', userId: 'user.local' },
    allowedLogicalAgentIds: [],
    issuedAt: new Date().toISOString(),
  });
  assert.equal(kindMismatch.ok, false);

  const notAllowed = verifyTrustedActorContext({
    sessionId: 'sess-agent-3',
    requestSource: 'agent',
    actor: { kind: 'agent', logicalAgentId: 'agent-gamma' },
    hostParticipantId: 'xiaok-desktop',
    allowedLogicalAgentIds: ['agent-alpha'],
    issuedAt: new Date().toISOString(),
  });
  assert.equal(notAllowed.ok, false);
  assert.equal(notAllowed.code, 'room_actor_identity_mismatch');
});

test('user requestSource cannot carry an agent actor and vice versa', () => {
  const userWithAgentActor = verifyTrustedActorContext({
    ...validUserCtx(),
    actor: { kind: 'agent', logicalAgentId: 'agent-alpha' },
  });
  assert.equal(userWithAgentActor.ok, false);
});

test('system requestSource requires a system actor with a known service', () => {
  const ok = verifyTrustedActorContext({
    sessionId: 'sess-sys-1',
    requestSource: 'system',
    actor: { kind: 'system', service: 'kswarm' },
    allowedLogicalAgentIds: [],
    issuedAt: new Date().toISOString(),
  });
  assert.deepEqual(ok, { ok: true });

  const unknownService = verifyTrustedActorContext({
    sessionId: 'sess-sys-2',
    requestSource: 'system',
    actor: { kind: 'system', service: 'some-random-tool' },
    allowedLogicalAgentIds: [],
    issuedAt: new Date().toISOString(),
  });
  assert.equal(unknownService.ok, false);
});

test('the room service rejects a host worker acting outside its allowedLogicalAgentIds', () => {
  const store = createRoomStore({ dbPath: createTempDbPath() });
  store.migrate();
  const service = createRoomService({ store });

  const created = service.createRoom(
    { title: 'Room', memberAgentIds: ['agent-po', 'agent-worker'], clientRequestKey: 'crk-allow-1' },
    {
      sessionId: 'sess-user-1',
      requestSource: 'user',
      actor: { kind: 'user', userId: 'user.local' },
      allowedLogicalAgentIds: [],
      issuedAt: new Date().toISOString(),
    }
  );
  assert.ok(created.ok, JSON.stringify(created));

  // the host session is registered for agent-po only; agent-po tries to
  // speak as agent-worker via payload fields
  const spoof = service.sendRoomMessage(
    {
      roomId: created.room.roomId,
      text: 'i am the worker, honest',
      // payload-level identity spoof attempts:
      logicalAgentId: 'agent-worker',
      actor: { kind: 'agent', logicalAgentId: 'agent-worker' },
      requestSource: 'agent',
      responsePolicy: 'none',
      idempotencyKey: 'im-spoof-1',
    },
    {
      sessionId: 'sess-host-1',
      requestSource: 'agent',
      actor: { kind: 'agent', logicalAgentId: 'agent-po' },
      hostParticipantId: 'xiaok-desktop',
      allowedLogicalAgentIds: ['agent-po'],
      issuedAt: new Date().toISOString(),
    }
  );
  assert.equal(spoof.ok, false);
  assert.equal(spoof.code, 'room_actor_identity_mismatch');

  // the same host session speaking as its own allowed agent succeeds
  const legit = service.sendRoomMessage(
    { roomId: created.room.roomId, text: 'po speaking', responsePolicy: 'none', idempotencyKey: 'im-legit-1' },
    {
      sessionId: 'sess-host-1',
      requestSource: 'agent',
      actor: { kind: 'agent', logicalAgentId: 'agent-po' },
      hostParticipantId: 'xiaok-desktop',
      allowedLogicalAgentIds: ['agent-po'],
      issuedAt: new Date().toISOString(),
    }
  );
  assert.ok(legit.ok, JSON.stringify(legit));
  assert.deepEqual(legit.message.sender, { kind: 'agent', logicalAgentId: 'agent-po' });
});
