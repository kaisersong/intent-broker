/**
 * Broker generic-surface guards for Room (design §9.1, §10.2, §10.3, §16.1).
 *
 * RED until Phase 1 implementation lands.
 *
 * These tests drive the PRODUCTION broker service (createBrokerService) —
 * the final gate for every sibling path (raw /intents, relay, session
 * bridge, adapters) — and assert:
 *   - reserved Room intents are rejected by the generic surface with
 *     room_intent_must_use_room_service, even with opaque: true, and never
 *     materialize a RoomMessage.
 *   - Room messages never dual-write into generic events / inbox_entries /
 *     participant_cursors.
 *   - the generic recipient resolver default-denies missing or unknown
 *     to.mode instead of falling back to broadcast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { createBrokerService } from '../../src/broker/service.js';
import { initializeSchema as initializeLegacySchema } from '../../src/store/schema.js';

function registerAgent(broker, participantId, overrides = {}) {
  const result = broker.registerParticipant({
    participantId,
    alias: participantId,
    kind: 'agent',
    ...overrides,
  });
  assert.ok(result, `failed to register ${participantId}`);
}

test('generic sendIntent rejects reserved room kinds even when opaque', () => {
  const dbPath = createTempDbPath();
  const broker = createBrokerService({ dbPath });
  try {
    registerAgent(broker, 'agent.a');
    registerAgent(broker, 'agent.b');

    const attempts = [
      { kind: 'room_message', opaque: true },
      { kind: 'room_system_event' },
      { kind: 'room_wake_claim' },
      {
        kind: 'custom_kind',
        to: { mode: 'participant', participants: ['room:room-1'] },
      },
    ];

    for (const attempt of attempts) {
      const result = broker.sendIntent({
        intentId: `reserved-${attempt.kind}-${Math.random()}`,
        fromParticipantId: 'agent.a',
        ...attempt,
        payload: { body: { summary: 'forged room intent' } },
      });
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(attempt)}`);
      assert.equal(result.code, 'room_intent_must_use_room_service');
    }

    // nothing landed in the generic event store either
    const db = new DatabaseSync(dbPath);
    try {
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE kind LIKE 'room%' OR kind = 'room_message'")
        .get();
      assert.equal(count.n, 0);
    } finally {
      db.close();
    }
  } finally {
    broker.close();
  }
});

test('room intents carrying payload.roomId but no reserved markers are not blocked', () => {
  const dbPath = createTempDbPath();
  const broker = createBrokerService({ dbPath });
  try {
    registerAgent(broker, 'agent.a');
    registerAgent(broker, 'agent.b');

    // audit-only payload fields do not trigger the reserved matcher...
    const result = broker.sendIntent({
      intentId: `audit-only-${Math.random()}`,
      kind: 'request_task',
      fromParticipantId: 'agent.a',
      to: { mode: 'participant', participants: ['agent.b'] },
      payload: { roomId: 'room-1', body: { summary: 'generic work with audit field' } },
    });
    assert.ok(result.ok !== false, `generic intent with payload.roomId must not be rejected: ${JSON.stringify(result)}`);

    // ...and it must NOT materialize a room message
    const db = new DatabaseSync(dbPath);
    try {
      const count = db.prepare('SELECT COUNT(*) AS n FROM room_messages').get();
      assert.equal(count.n, 0, 'generic intents must never write room_messages');
    } finally {
      db.close();
    }
  } finally {
    broker.close();
  }
});

test('sendIntent default-denies a missing or unknown to.mode instead of broadcasting', () => {
  const dbPath = createTempDbPath();
  const broker = createBrokerService({ dbPath });
  try {
    registerAgent(broker, 'agent.a');
    registerAgent(broker, 'agent.b');
    registerAgent(broker, 'agent.c');

    const missing = broker.sendIntent({
      intentId: `no-to-${Math.random()}`,
      kind: 'request_task',
      fromParticipantId: 'agent.a',
      payload: {},
    });
    assert.equal(missing.ok, false, 'missing to.mode must be rejected');

    const unknown = broker.sendIntent({
      intentId: `unknown-to-${Math.random()}`,
      kind: 'request_task',
      fromParticipantId: 'agent.a',
      to: { mode: 'everyone_everywhere' },
      payload: {},
    });
    assert.equal(unknown.ok, false, 'unknown to.mode must be rejected');

    // no participant received anything through a broadcast fallback
    // (registration-time presence broadcasts are expected broker noise)
    for (const participantId of ['agent.b', 'agent.c']) {
      const inbox = broker.readInbox(participantId, { after: 0 });
      const nonPresence = inbox.items.filter((item) => item.kind !== 'participant_presence_updated');
      assert.equal(nonPresence.length, 0, `${participantId} must not receive broadcast fallback`);
    }
  } finally {
    broker.close();
  }
});

test('room message writes never dual-write generic inbox or participant cursors', async () => {
  const dbPath = createTempDbPath();

  // generic broker tables exist so their emptiness is a meaningful assertion
  const bootstrap = new DatabaseSync(dbPath);
  initializeLegacySchema(bootstrap);
  bootstrap.close();

  // room side writes through the production room service
  const { createRoomStore } = await import('../../src/room/store.js');
  const { createRoomService } = await import('../../src/room/service.js');
  const store = createRoomStore({ dbPath });
  store.migrate();
  const roomService = createRoomService({ store });

  const userCtx = {
    sessionId: 'sess-user-1',
    requestSource: 'user',
    actor: { kind: 'user', userId: 'user.local' },
    allowedLogicalAgentIds: [],
    issuedAt: new Date().toISOString(),
  };

  const created = roomService.createRoom(
    { title: 'No dual write', memberAgentIds: ['agent-alpha'], clientRequestKey: 'crk-dual-1' },
    userCtx
  );
  assert.ok(created.ok, JSON.stringify(created));

  const sent = roomService.sendRoomMessage(
    {
      roomId: created.room.roomId,
      mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
      responsePolicy: 'mentioned',
      idempotencyKey: 'im-dual-1',
    },
    userCtx
  );
  assert.ok(sent.ok, JSON.stringify(sent));

  const db = new DatabaseSync(dbPath);
  try {
    // the room tables hold the truth...
    const deliveries = db
      .prepare('SELECT COUNT(*) AS n FROM room_message_deliveries WHERE room_message_id = ?')
      .get(sent.message.messageId);
    assert.ok(deliveries.n >= 2);

    // ...and generic tables stay untouched by room writes
    const genericEvents = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind IN ('room_message', 'room_system_event')")
      .get();
    assert.equal(genericEvents.n, 0, 'room messages must not dual-write generic events');

    const genericInbox = db
      .prepare('SELECT COUNT(*) AS n FROM inbox_entries')
      .get();
    assert.equal(genericInbox.n, 0, 'room obligations must not dual-write inbox_entries');

    const genericCursors = db.prepare('SELECT COUNT(*) AS n FROM participant_cursors').get();
    assert.equal(genericCursors.n, 0, 'room cursors must not dual-write participant_cursors');
  } finally {
    db.close();
  }
});
