/**
 * Reserved Room materialization namespace (design §9, §10.3, §16.1).
 *
 * RED until Phase 1 implementation lands.
 *
 * The generic intent surface (POST /intents, WS inbound, relay, session
 * bridge, KSwarm generic sender) must never materialize Room state.
 * Reserved namespaces are rejected with `room_intent_must_use_room_service`
 * even when `opaque: true` is set.
 *
 * Matcher rules (design §10.3):
 *   - kind exactly `room_message` or `room_system_event`
 *   - kind matching ^room(_|$)
 *   - any destination token matching ^room:
 *   - payload.roomId / payload.primaryRoomId are NOT matcher conditions
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isReservedRoomIntent, ROOM_INTENT_REJECTION_CODE } from '../../src/room/reserved-namespace.js';

test('exact room kinds are reserved', () => {
  assert.equal(isReservedRoomIntent({ kind: 'room_message' }), true);
  assert.equal(isReservedRoomIntent({ kind: 'room_system_event' }), true);
  assert.equal(isReservedRoomIntent({ kind: 'room' }), true);
});

test('room-prefixed kinds with underscore boundaries are reserved', () => {
  assert.equal(isReservedRoomIntent({ kind: 'room_discussion' }), true);
  assert.equal(isReservedRoomIntent({ kind: 'room_wake_claim' }), true);
});

test('kinds that merely contain "room" without the boundary are not reserved', () => {
  assert.equal(isReservedRoomIntent({ kind: 'roombroadcast' }), false);
  assert.equal(isReservedRoomIntent({ kind: 'classroom_event' }), false);
  assert.equal(isReservedRoomIntent({ kind: 'request_task' }), false);
});

test('destination tokens starting with room: are reserved', () => {
  assert.equal(
    isReservedRoomIntent({ kind: 'request_task', to: { mode: 'participant', participants: ['room:abc'] } }),
    true
  );
  assert.equal(
    isReservedRoomIntent({ kind: 'reply_message', to: { mode: 'participant', participants: ['agent-ok', 'room:abc'] } }),
    true
  );
  assert.equal(
    isReservedRoomIntent({ kind: 'request_task', to: { mode: 'participant', participants: ['agent-ok'] } }),
    false
  );
});

test('opaque: true never bypasses the reserved namespace check', () => {
  assert.equal(isReservedRoomIntent({ kind: 'room_message', opaque: true }), true);
  assert.equal(
    isReservedRoomIntent({ kind: 'custom', opaque: true, to: { mode: 'participant', participants: ['room:x'] } }),
    true
  );
});

test('payload roomId / primaryRoomId alone do not make an intent reserved', () => {
  assert.equal(isReservedRoomIntent({ kind: 'request_task', payload: { roomId: 'room-1' } }), false);
  assert.equal(isReservedRoomIntent({ kind: 'task_done', payload: { primaryRoomId: 'room-1' } }), false);
  assert.equal(isReservedRoomIntent({ kind: 'unknown_kind_xyz', payload: { roomId: 'room-1' } }), false);
});

test('the rejection code is the stable contract value', () => {
  assert.equal(ROOM_INTENT_REJECTION_CODE, 'room_intent_must_use_room_service');
});
