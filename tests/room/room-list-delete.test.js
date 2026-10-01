import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomStore, getDefaultMigrations } from '../../src/room/store.js';
import { createRoomService } from '../../src/room/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';
const user = (id = 'user.local') => ({ sessionId: 'test-user', requestSource: 'user', actor: { kind: 'user', userId: id }, allowedLogicalAgentIds: [], issuedAt: new Date().toISOString() });
const agent = () => ({ sessionId: 'test-agent', requestSource: 'agent', actor: {kind: 'agent', logicalAgentId: 'agent-a'}, hostParticipantId: 'xiaok-desktop', allowedLogicalAgentIds: ['agent-a'], issuedAt: new Date().toISOString() });
function fixture(t) {
  const dbPath = createTempDbPath();
  const store = createRoomStore({dbPath}); store.migrate(); t.after(() => store.close());
  let clock = new Date('2026-01-01T00:00:00Z');
  const service = createRoomService({store, now: () => clock});
  const create = title => service.createRoom({title, memberAgentIds: ['agent-a'], clientRequestKey: title}, user()).room;
  return {dbPath, store, service, create, time: value => {clock = new Date(value);}};
}
test('list uses latest message or creation, never archive/read timestamps', t => {
  const {service, create, time} = fixture(t);
  const first = create('first'); time('2026-01-02T00:00:00Z'); const second = create('second');
  time('2026-01-03T00:00:00Z'); service.sendRoomMessage({roomId: first.roomId, text: 'activity', responsePolicy: 'none', idempotencyKey: 'm'}, user());
  time('2026-01-04T00:00:00Z'); service.archiveRoom({roomId: second.roomId, expectedRoomRevision: second.revision}, user()); service.settleArchiveGrace({roomId: second.roomId});
  const result = service.listCollaborationRooms({}, user());
  assert.deepEqual(result.rooms.map(r => r.roomId), [first.roomId, second.roomId]);
  assert.equal(result.rooms[0].lastActivityAt, '2026-01-03T00:00:00.000Z');
  assert.equal(result.rooms[1].lastActivityAt, second.createdAt);
});
test('delete default denies, requires owner and revision, persists tombstone without losing messages', t => {
  const {service, store, dbPath, create} = fixture(t); const room = create('delete');
  const input = {roomId: room.roomId, expectedRoomRevision: room.revision};
  assert.equal(service.deleteRoom(input).ok, false);
  assert.equal(service.deleteRoom(input, agent()).ok, false);
  assert.equal(service.deleteRoom(input, user('other')).ok, false);
  assert.equal(service.deleteRoom({roomId: room.roomId}, user()).code, 'room_input_invalid');
  assert.equal(service.deleteRoom({...input, expectedRoomRevision: 999}, user()).code, 'room_revision_conflict');
  service.sendRoomMessage({roomId: room.roomId, text: 'retained', responsePolicy: 'none', idempotencyKey: 'saved'}, user());
  assert.equal(service.deleteRoom(input, user()).ok, true);
  assert.ok(store.getRoomRow(room.roomId).deletedAt); assert.equal(store.listMessages(room.roomId).length, 1);
  assert.equal(service.listCollaborationRooms({}, user()).rooms.length, 0);
  assert.equal(service.getCollaborationRoom({roomId: room.roomId}, user()).code, 'room_not_found');
  assert.equal(service.sendRoomMessage({roomId: room.roomId, text: 'late', responsePolicy: 'none', idempotencyKey: 'late'}, user()).code, 'room_not_found');
  assert.equal(service.deleteRoom(input, user()).ok, true);
  assert.equal(service.deleteRoom(input, user('other')).ok, false);
  assert.equal(service.deleteRoom({...input, expectedRoomRevision: 999}, user()).code, 'room_revision_conflict');
  const reopened = createRoomStore({dbPath}); t.after(() => reopened.close()); reopened.migrate();
  assert.equal(createRoomService({store: reopened}).listCollaborationRooms({}, user()).rooms.length, 0);
});
test('delete settles archive first and refuses live claimed wake', t => {
  const {service, store, create, time} = fixture(t); const room = create('pending');
  const message = service.sendRoomMessage({roomId: room.roomId, text: 'wake', mentions: [{kind: 'agent', logicalAgentId: 'agent-a'}], responsePolicy: 'mentioned', idempotencyKey: 'wake'}, user()).message;
  assert.equal(service.claimWake({roomMessageId: message.messageId, logicalAgentId: 'agent-a', hostParticipantId: 'xiaok-desktop'}, agent()).ok, true);
  const input = {roomId: room.roomId, expectedRoomRevision: room.revision};
  assert.equal(service.deleteRoom(input, user()).code, 'room_delete_pending');
  assert.equal(store.getRoomRow(room.roomId).status, 'archiving'); assert.equal(store.getRoomRow(room.roomId).deletedAt, undefined);
  time('2026-01-02T00:00:00Z'); assert.equal(service.deleteRoom(input, user()).ok, true);
});
test('v6 upgrade preserves room and v7 DDL failure rolls back columns and version', t => {
  const dbPath = createTempDbPath(); const old = createRoomStore({dbPath, migrations: getDefaultMigrations().filter(m => m.version <= 6)});
  old.migrate(); const room = createRoomService({store: old}).createRoom({title: 'legacy', memberAgentIds: [], clientRequestKey: 'legacy'}, user()).room;
  old.close(); const upgraded = createRoomStore({dbPath}); t.after(() => upgraded.close()); assert.equal(upgraded.migrate().schemaVersion, 7);
  assert.equal(upgraded.getRoomRow(room.roomId).title, 'legacy'); assert.equal(upgraded.getRoomRow(room.roomId).deletedAt, undefined);
  const failedPath = createTempDbPath(); const seed = createRoomStore({dbPath: failedPath, migrations: getDefaultMigrations().filter(m => m.version <= 6)}); seed.migrate();
  seed.db.exec('ALTER TABLE rooms ADD COLUMN deleted_by_json TEXT'); seed.close();
  const failed = createRoomStore({dbPath: failedPath}); t.after(() => failed.close()); assert.throws(() => failed.migrate());
  assert.equal(failed.getSchemaVersion(), 6); assert.equal(failed.db.prepare('PRAGMA table_info(rooms)').all().some(c => c.name === 'deleted_at'), false);
});

test('held disclosure cannot delete; released claims allow deletion and workspace deep links then deny', t => {
  const {service, store, create} = fixture(t); const room = create('disclosure');
  const input = {roomId: room.roomId, expectedRoomRevision: room.revision};
  store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run('held-delete', room.roomId, '{}');
  assert.equal(service.deleteRoom(input, user()).code, 'room_delete_pending');
  assert.equal(store.getRoomRow(room.roomId).status, 'active');
  store.db.prepare("UPDATE room_disclosure_leases SET state='RELEASED' WHERE attempt_id='held-delete'").run();
  store.db.prepare('INSERT INTO room_workspace_records VALUES(?,?,?,?)').run('claim', 'delete-claim', room.roomId, JSON.stringify({executionState: 'running'}));
  assert.equal(service.deleteRoom(input, user()).code, 'room_delete_pending');
  store.db.prepare('UPDATE room_workspace_records SET value_json=? WHERE record_key=?').run(JSON.stringify({executionState: 'released'}), 'delete-claim');
  assert.equal(service.deleteRoom(input, user()).ok, true);
  assert.equal(service.workspace.getState({roomId: room.roomId}, user()).code, 'room_not_found');
  assert.equal(store.listRoomRows().length, 0);
});

test('missing/null claim execution state fails closed rather than allowing deletion', t => {
  const {service, store, create} = fixture(t);
  for (const [index, claim] of [{}, {executionState: null}].entries()) {
    const room = create(`malformed-claim-${index}`); const input = {roomId: room.roomId, expectedRoomRevision: room.revision};
    service.archiveRoom(input, user()); service.settleArchiveGrace({roomId: room.roomId});
    store.db.prepare('INSERT INTO room_workspace_records VALUES(?,?,?,?)').run('claim', `malformed-${index}`, room.roomId, JSON.stringify(claim));
    assert.equal(service.deleteRoom(input, user()).code, 'room_delete_pending');
    assert.equal(store.getRoomRow(room.roomId).deletedAt, undefined);
  }
});
