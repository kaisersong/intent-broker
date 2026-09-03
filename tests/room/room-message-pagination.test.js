/**
 * Room message pagination (design §6.2).
 *
 * listRoomMessages/store.listMessages now support afterSequence/beforeSequence/
 * limit bounded queries using the room_sequence index, instead of always
 * materializing the full room history. Calls with no bounds must keep the
 * legacy full-materialization semantics for backward compatibility.
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

function createService() {
  const store = createRoomStore({ dbPath: createTempDbPath() });
  store.migrate();
  return createRoomService({ store });
}

function createRoom(service, memberAgentIds = ['agent-alpha']) {
  const result = service.createRoom(
    { title: '分页测试 Room', memberAgentIds, clientRequestKey: `crk-${Math.random()}` },
    userCtx()
  );
  assert.ok(result.ok, JSON.stringify(result));
  return result.room;
}

function sendMessages(service, room, count) {
  const sent = [];
  for (let i = 0; i < count; i += 1) {
    const result = service.sendRoomMessage(
      {
        roomId: room.roomId,
        text: `message-${i}`,
        responsePolicy: 'none',
        idempotencyKey: `im-page-${i}-${Math.random()}`,
      },
      userCtx()
    );
    assert.ok(result.ok, JSON.stringify(result));
    sent.push(result.message);
  }
  return sent;
}

test('no-bounds call keeps the legacy full-materialization shape (messages only, no pagination metadata)', () => {
  const service = createService();
  const room = createRoom(service);
  sendMessages(service, room, 5);

  const result = service.listRoomMessages({ roomId: room.roomId }, userCtx());
  assert.ok(result.ok);
  assert.equal(result.messages.length, 5);
  assert.equal(result.totalMessages, undefined, 'legacy no-bounds call must not add pagination metadata');
});

test('a bounded call with limit returns only that many messages plus pagination metadata', () => {
  const service = createService();
  const room = createRoom(service);
  sendMessages(service, room, 10);

  const result = service.listRoomMessages({ roomId: room.roomId, limit: 3 }, userCtx());
  assert.ok(result.ok);
  assert.equal(result.messages.length, 3);
  assert.equal(result.totalMessages, 10);
  assert.equal(result.hasMoreAfter, true);
});

test('afterSequence returns only messages strictly after the given sequence', () => {
  const service = createService();
  const room = createRoom(service);
  const sent = sendMessages(service, room, 10);
  const midSequence = sent[4].roomSequence;

  const result = service.listRoomMessages({ roomId: room.roomId, afterSequence: midSequence, limit: 100 }, userCtx());
  assert.ok(result.ok);
  assert.equal(result.messages.length, 5);
  assert.ok(result.messages.every(m => m.roomSequence > midSequence));
});

test('beforeSequence returns only messages strictly before the given sequence', () => {
  const service = createService();
  const room = createRoom(service);
  const sent = sendMessages(service, room, 10);
  const midSequence = sent[5].roomSequence;

  const result = service.listRoomMessages({ roomId: room.roomId, beforeSequence: midSequence, limit: 100 }, userCtx());
  assert.ok(result.ok);
  assert.equal(result.messages.length, 5);
  assert.ok(result.messages.every(m => m.roomSequence < midSequence));
});

test('[design §6.2] default page size is 50 when limit is not specified but bounds are used', () => {
  const service = createService();
  const room = createRoom(service);
  sendMessages(service, room, 60);

  const result = service.listRoomMessages({ roomId: room.roomId, afterSequence: 0 }, userCtx());
  assert.ok(result.ok);
  assert.equal(result.messages.length, 50);
});

test('[SECURITY design §6.2] limit is capped at 200 and does not silently enlarge beyond the max', () => {
  const service = createService();
  const room = createRoom(service);
  sendMessages(service, room, 250);

  const result = service.listRoomMessages({ roomId: room.roomId, afterSequence: 0, limit: 10000 }, userCtx());
  assert.ok(result.ok);
  assert.equal(result.messages.length, 200, 'an oversized limit must be clamped to the frozen maximum of 200');
});

test('a non-integer or non-positive limit falls back to the default page size instead of silently enlarging', () => {
  const service = createService();
  const room = createRoom(service);
  sendMessages(service, room, 60);

  const zeroLimit = service.listRoomMessages({ roomId: room.roomId, afterSequence: 0, limit: 0 }, userCtx());
  assert.equal(zeroLimit.messages.length, 50);

  const negativeLimit = service.listRoomMessages({ roomId: room.roomId, afterSequence: 0, limit: -5 }, userCtx());
  assert.equal(negativeLimit.messages.length, 50);

  const nonIntegerLimit = service.listRoomMessages({ roomId: room.roomId, afterSequence: 0, limit: 3.7 }, userCtx());
  assert.equal(nonIntegerLimit.messages.length, 50);
});

test('hasMoreAfter is false once the page reaches the newest message', () => {
  const service = createService();
  const room = createRoom(service);
  const sent = sendMessages(service, room, 5);

  const result = service.listRoomMessages({ roomId: room.roomId, afterSequence: 0, limit: 100 }, userCtx());
  assert.equal(result.messages.length, 5);
  assert.equal(result.hasMoreAfter, false);
});

test('[SECURITY] a non-member cannot page through room messages either', () => {
  const service = createService();
  const room = createRoom(service);
  sendMessages(service, room, 5);

  const nonMemberCtx = { ...userCtx(), sessionId: 'sess-outsider', actor: { kind: 'user', userId: 'outsider.local' } };
  const result = service.listRoomMessages({ roomId: room.roomId, limit: 10 }, nonMemberCtx);
  assert.equal(result.ok, false);
});

test('bounded pagination via afterSequence walks the full history without gaps or duplicates', () => {
  const service = createService();
  const room = createRoom(service);
  const sent = sendMessages(service, room, 137);

  const collected = [];
  let cursor = 0;
  for (let i = 0; i < 10; i += 1) {
    const page = service.listRoomMessages({ roomId: room.roomId, afterSequence: cursor, limit: 20 }, userCtx());
    assert.ok(page.ok);
    if (page.messages.length === 0) break;
    collected.push(...page.messages);
    cursor = page.messages[page.messages.length - 1].roomSequence;
    if (!page.hasMoreAfter) break;
  }

  assert.equal(collected.length, 137);
  const sequences = collected.map(m => m.roomSequence);
  const uniqueSequences = new Set(sequences);
  assert.equal(uniqueSequences.size, sequences.length, 'no duplicate messages across pages');
  assert.deepEqual([...sequences].sort((a, b) => a - b), sequences, 'pages must be returned in sequence order');
});
