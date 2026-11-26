import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRoomService } from '../../src/room/service.js';
import { sharedRoomSession } from '../../src/room/shared-service.js';
import { createRoomStore, getDefaultMigrations } from '../../src/room/store.js';

const claims = { workspaceId: 'workspace', principalId: 'owner', deviceId: 'one',
  deviceGeneration: 1, recoveryGeneration: 1 };
const owner = sharedRoomSession(claims);
const local = { sessionId: 'desktop', requestSource: 'user', actor: { kind: 'user', userId: 'user.local' },
  allowedLogicalAgentIds: [], issuedAt: new Date().toISOString() };
const pending = 'shared_operation_pending_verification';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'broker-shared-store-'));
  const dbPath = join(directory, 'broker.sqlite');
  let clock = new Date('2026-11-26T00:00:00Z');
  const connections = [];
  t.after(() => {
    for (const connection of connections) connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function open(migrations) {
    const store = createRoomStore({ dbPath, migrations });
    store.migrate();
    const rooms = createRoomService({ store, now: () => clock });
    const connection = { store, rooms, shared: rooms.shared, close() {
      if (store.db.isOpen) rooms.close();
    } };
    connections.push(connection);
    return connection;
  }
  return { open, setClock: value => { clock = new Date(value); } };
}

function create(shared, requestId = 'new') {
  return shared.write(owner, null, 'create', { requestId, title: '共享群', memberAgentIds: ['bot'] });
}

test('v7 data stays local and shared rooms reject local service and workspace paths', t => {
  const { open } = fixture(t);
  const legacy = open(getDefaultMigrations().filter(migration => migration.version <= 7));
  const localRoom = legacy.rooms.createRoom({ title: '本机群', memberAgentIds: [] }, local).room;
  assert.equal(legacy.shared.ready(), false);
  legacy.close();

  const { store, rooms, shared } = open();
  assert.equal(shared.ready(), true);
  assert.equal(store.getRoomRow(localRoom.roomId).sharedWorkspaceId, undefined);
  const { room } = create(shared);
  const input = { roomId: room.roomId, expectedRoomRevision: 1 };
  assert.deepEqual(rooms.listCollaborationRooms({}, local).rooms.map(row => row.roomId), [localRoom.roomId]);
  assert.deepEqual(shared.list(owner).rooms.map(row => row.roomId), [room.roomId]);
  assert.equal(shared.history(owner, localRoom.roomId, {}).code, 'room_not_found');
  const outsider = sharedRoomSession({ ...claims, principalId: 'outsider' });
  assert.equal(shared.history(outsider, room.roomId, {}).code, 'room_membership_required');
  assert.equal(shared.history(sharedRoomSession({ ...claims, workspaceId: 'foreign' }), room.roomId, {}).code, 'room_not_found');
  assert.equal(rooms.getCollaborationRoom(input, local).code, 'room_not_found');
  assert.equal(rooms.deleteRoom(input, local).code, 'room_not_found');
  assert.equal(rooms.updateRoomMembers({ ...input, addAgentIds: ['local-bot'] }, local).code, 'room_not_found');
  assert.equal(rooms.sendRoomMessage({ ...input, text: '旁路', idempotencyKey: 'm' }, local).code, 'room_not_found');
  assert.equal(rooms.workspace.getState(input, local).code, 'room_not_found');
});

test('Room commits exact scoped receipts across connections and archives only the result', t => {
  const { open, setClock } = fixture(t);
  const first = open();
  const { room } = create(first.shared);
  const { room: other } = create(first.shared, 'other');
  const { roomId } = room;
  const message = { requestId: 'one', expectedRoomRevision: 1, text: '原文' };
  const sent = first.shared.write(owner, roomId, 'message', message);
  assert.equal(sent.message.roomSequence, 1);
  assert.equal(first.shared.write(owner, other.roomId, 'message', message).message.roomSequence, 1);
  const members = { requestId: 'one', expectedRoomRevision: 1, addAgentIds: ['new-bot'], removeAgentIds: ['bot'] };
  const changed = first.shared.write(owner, roomId, 'members', members);
  assert.equal(changed.room.revision, 2);
  const metadata = { requestId: 'one', expectedRoomRevision: 2, title: '变更后' };
  const renamed = first.shared.write(owner, roomId, 'metadata', metadata);
  assert.equal(renamed.room.revision, 3);
  first.close();

  const { store, shared } = open();
  assert.deepEqual(shared.write(owner, roomId, 'members', members), changed);
  assert.deepEqual(shared.write(owner, roomId, 'metadata', metadata), renamed);
  assert.deepEqual(shared.receipt(owner, roomId, 'message', 'one'), sent);
  assert.deepEqual(shared.write(owner, roomId, 'message', message), sent);
  assert.equal(shared.write(owner, roomId, 'message', { ...message, text: '不同' }).code, 'shared_operation_conflict');
  assert.equal(shared.write(owner, roomId, 'message', { ...message, requestId: 'stale' }).code, 'room_revision_conflict');
  assert.equal(shared.receipt(owner, roomId, 'message', 'stale').code, pending);
  assert.equal(shared.receipt(sharedRoomSession({ ...claims, deviceGeneration: 2 }), roomId, 'message', 'one').code, pending);
  assert.equal(store.listMessages(roomId).length, 1);

  setClock('2026-12-25T00:00:00Z');
  assert.deepEqual(shared.receipt(owner, roomId, 'message', 'one'), sent);
  setClock('2026-12-27T00:00:00Z');
  assert.equal(shared.receipt(owner, roomId, 'message', 'one').code, pending);
  assert.equal(shared.write(owner, roomId, 'message', message).code, pending);
  const evidence = store.db.prepare(`SELECT request_digest, device_id, device_generation, receipt_json
    FROM shared_room_operations WHERE room_id=? AND operation='message'`).get(roomId);
  assert.match(evidence.request_digest, /^[0-9a-f]{64}$/);
  assert.equal(evidence.device_id, claims.deviceId);
  assert.equal(evidence.device_generation, claims.deviceGeneration);
  assert.equal(evidence.receipt_json, null);
  assert.equal(store.listMessages(roomId).length, 1);
});

test('failed receipt persistence rolls back room creation and message sequence allocation', t => {
  const { open } = fixture(t);
  const { store, shared } = open();
  const blockReceipt = () => store.db.exec(`CREATE TRIGGER test_deny_receipt BEFORE UPDATE OF receipt_json
    ON shared_room_operations BEGIN SELECT RAISE(ABORT, 'test_storage_failure'); END`);
  const unblock = () => store.db.exec('DROP TRIGGER test_deny_receipt');
  blockReceipt();
  assert.throws(() => create(shared), /test_storage_failure/);
  assert.deepEqual(shared.list(owner).rooms, []);
  assert.equal(shared.receipt(owner, null, 'create', 'new').code, pending);
  unblock();

  const { room } = create(shared);
  const { roomId } = room;
  const input = { requestId: 'message', expectedRoomRevision: 1, text: '事务' };
  blockReceipt();
  assert.throws(() => shared.write(owner, roomId, 'message', input), /test_storage_failure/);
  assert.equal(shared.receipt(owner, roomId, 'message', input.requestId).code, pending);
  assert.equal(shared.history(owner, roomId, {}).roomSequenceUpperBound, 0);
  unblock();
  assert.equal(shared.write(owner, roomId, 'message', input).message.roomSequence, 1);
});

test('history freezes an authorized Room waterline and persists signed cursors across restart', t => {
  const { open } = fixture(t);
  const writer = open();
  const reader = open();
  const { room: { roomId } } = create(writer.shared);
  const otherRoomId = create(writer.shared, 'other').room.roomId;
  const append = n => writer.shared.write(owner, roomId, 'message', {
    requestId: `msg-${n}`, expectedRoomRevision: 1, text: String(n),
  }).message.roomSequence;
  for (const n of [1, 2, 3]) assert.equal(append(n), n);
  const page = reader.shared.history(owner, roomId, { limit: 1 });
  assert.equal(page.room.revision, 1);
  assert.equal(page.members.length, 2);
  assert.equal(page.earliestAvailableSequence, 1);
  assert.equal(page.roomSequenceUpperBound, 3);
  assert.deepEqual(page.messages.map(message => message.roomSequence), [1]);
  assert.equal(append(4), 4);
  reader.close();

  const { shared } = open();
  const cursor = { cursor: page.nextCursor, limit: 1 };
  assert.equal(shared.history(owner, otherRoomId, cursor).code, 'shared_history_rebuild_required');
  assert.equal(shared.history(owner, roomId, { ...cursor, cursor: page.nextCursor + '!' }).code, 'shared_history_rebuild_required');
  assert.equal(shared.history(sharedRoomSession({ ...claims, recoveryGeneration: 2 }), roomId, cursor).code, 'shared_history_rebuild_required');
  const next = shared.history(owner, roomId, cursor);
  assert.equal(next.roomSequenceUpperBound, 3);
  assert.deepEqual(next.messages.map(message => message.roomSequence), [2]);
  const last = shared.history(owner, roomId, { cursor: next.nextCursor });
  assert.equal(last.nextCursor, null);
  assert.deepEqual(last.messages.map(message => message.roomSequence), [3]);
  const catchup = shared.history(owner, roomId, { afterSequence: last.roomSequenceUpperBound });
  assert.deepEqual(catchup.messages.map(message => message.roomSequence), [4]);
  assert.equal(shared.history(owner, roomId, { afterSequence: 999 }).code, 'shared_history_rebuild_required');
  assert.equal(shared.history(owner, roomId, { relaySequence: 1 }).code, 'room_input_invalid');

  writer.store.db.prepare('DELETE FROM room_messages WHERE room_id=? AND room_sequence<=2').run(roomId);
  const trimmed = shared.history(owner, roomId, {});
  assert.equal(trimmed.earliestAvailableSequence, 3);
  assert.equal(trimmed.truncated, true);
  assert.equal(trimmed.roomSequenceUpperBound, 4);
});
