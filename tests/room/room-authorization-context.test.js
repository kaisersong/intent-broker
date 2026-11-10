import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomStore } from '../../src/room/store.js';
import { createRoomService } from '../../src/room/service.js';
import { createServer } from '../../src/http/server.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

const user = (id = 'user.local') => ({ sessionId: 'halo-user', requestSource: 'user', actor: { kind: 'user', userId: id }, issuedAt: '2026-10-29T00:00:00Z' });
const agent = { sessionId: 'halo-agent', requestSource: 'agent', actor: { kind: 'agent', logicalAgentId: 'agent-a' }, allowedLogicalAgentIds: ['agent-a'], issuedAt: '2026-10-29T00:00:00Z' };
const system = { sessionId: 'halo-system', requestSource: 'system', actor: { kind: 'system', service: 'kswarm' }, scopes: ['room-read'], issuedAt: '2026-10-29T00:00:00Z' };

function fixture(t) {
  const store = createRoomStore({ dbPath: createTempDbPath() });
  store.migrate();
  const originalOwnPrepare=Object.getOwnPropertyDescriptor(store.db,'prepare');
  t.after(() => {if(originalOwnPrepare)Object.defineProperty(store.db,'prepare',originalOwnPrepare);else delete store.db.prepare;store.close();});
  const service = createRoomService({ store });
  const room = service.createRoom({ title: 'PRIVATE_TITLE', memberAgentIds: ['agent-a'], clientRequestKey: 'halo-room' }, user()).room;
  const other = service.createRoom({ title: 'other', memberAgentIds: ['agent-a'], clientRequestKey: 'halo-other' }, user()).room;
  const send = (roomId, key, scope = { kind: 'room_only' }) => {
    const result = service.sendRoomMessage({ roomId, text: 'PRIVATE_BODY', contextScope: scope, mentions: [], responsePolicy: 'none', idempotencyKey: key }, user());
    assert.equal(result.ok, true);
    return result.message;
  };
  const source = send(room.roomId, 'source', { kind: 'project', projectId: 'project-a' });
  const unrelated = send(room.roomId, 'unrelated');
  const foreign = send(other.roomId, 'foreign');
  const read = (ctx = user(), roomMessageId = source.messageId) => service.getRoomAuthorizationContext({ roomId: room.roomId, roomMessageId }, ctx);
  return { store, service, room, source, unrelated, foreign, read };
}

test('authorization projection uses real indexed point lookup and returns only source identity/scope', t => {
  const f = fixture(t);
  const statements = [];
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => { statements.push(sql); return prepare(sql); };
  const result = f.read();
  assert.deepEqual(result, { ok: true, schema: 'room-authorization-context/v1', room: { roomId: f.room.roomId }, source: { messageId: f.source.messageId, roomId: f.room.roomId, contextScope: f.source.contextScope } });
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  const messageReads = statements.filter(sql => /SELECT/i.test(sql) && /FROM\s+room_messages\b/i.test(sql));
  assert.equal(messageReads.length, 1);
  assert.match(messageReads[0], /SELECT\s+room_message_id\s*,\s*room_id\s*,\s*context_scope_json\s+FROM/i);
  assert.match(messageReads[0], /WHERE\s+room_id\s*=\s*\?\s+AND\s+room_message_id\s*=\s*\?/i);
  assert.ok(!statements.some(sql => /SELECT.*room_members.*ORDER BY/is.test(sql)));
  const plan = prepare(`EXPLAIN QUERY PLAN ${messageReads[0]}`).all(f.room.roomId, f.source.messageId);
  assert.ok(plan.some(row => /SEARCH.*room_messages.*INDEX/i.test(row.detail)));
  assert.ok(!plan.some(row => /SCAN.*room_messages/i.test(row.detail)));
});

for (const [name, ctx, code] of [
  ['missing context', null, 'room_authentication_required'],
  ['agent', agent, 'room_actor_forbidden'],
  ['system room reader', system, 'room_actor_forbidden'],
  ['nonmember', user('outsider'), 'room_membership_required'],
]) test(`authorization service refuses ${name} before source lookup`, t => {
  const f = fixture(t);
  let sourceReads = 0;
  const lookup = f.store.getAuthorizationMessage;
  f.store.getAuthorizationMessage = (...args) => { sourceReads++; return lookup(...args); };
  for (const id of [f.source.messageId, f.foreign.messageId, 'missing']) assert.deepEqual(f.read(ctx, id), { ok: false, code });
  assert.equal(sourceReads, 0);
});

test('old snapshot preserves its KSwarm room-read exception; projection does not inherit it', t => {
  const f = fixture(t);
  assert.equal(f.service.getCollaborationRoom({ roomId: f.room.roomId }, system).ok, true);
  assert.deepEqual(f.read(system), { ok: false, code: 'room_actor_forbidden' });
});

test('missing/cross-room source is checked after active user membership', t => {
  const f = fixture(t);
  for (const id of [f.foreign.messageId, 'missing']) assert.deepEqual(f.read(user(), id), { ok: false, code: 'room_message_not_found' });
  f.store.db.prepare("UPDATE room_members SET status='removed' WHERE room_id=? AND subject_kind='user'").run(f.room.roomId);
  assert.deepEqual(f.read(), { ok: false, code: 'room_membership_required' });
});

for (const value of ['null', 'false', '17', '[]', '"scope"', '{"kind":"room_only","kind":"project","projectId":"p"}']) {
  test(`target scope uses original JSON semantics: ${value}`, t => {
    const f = fixture(t);
    f.store.db.prepare('UPDATE room_messages SET context_scope_json=? WHERE room_message_id=?').run(value, f.source.messageId);
    assert.deepEqual(f.read().source.contextScope, JSON.parse(value) ?? { kind: 'room_only' });
  });
}

for (const field of ['sender_json', 'mentions_json', 'source_ref_json']) test(`unrelated display JSON ${field} is never read by projection`, t => {
  const f = fixture(t);
  // Both target and other-message display fields are outside the authorization projection.
  f.store.db.prepare(`UPDATE room_messages SET ${field}='not-json' WHERE room_id=?`).run(f.room.roomId);
  assert.throws(() => f.service.getCollaborationRoom({ roomId: f.room.roomId }, user()), SyntaxError);
  assert.equal(f.read().ok, true);
});

test('other-message scope and other-member display JSON are allowed fault differences', t => {
  const f = fixture(t);
  f.store.db.prepare("UPDATE room_messages SET context_scope_json='not-json' WHERE room_message_id=?").run(f.unrelated.messageId);
  f.store.db.prepare("UPDATE room_members SET added_by_json='not-json' WHERE room_id=? AND subject_kind='agent'").run(f.room.roomId);
  assert.throws(() => f.service.getCollaborationRoom({ roomId: f.room.roomId }, user()), SyntaxError);
  assert.equal(f.read().ok, true);
});

for (const field of ['created_by_json', 'deleted_by_json']) test(`room JSON ${field} corruption must still fail`, t => {
  const f = fixture(t);
  f.store.db.prepare(`UPDATE rooms SET ${field}='not-json' WHERE room_id=?`).run(f.room.roomId);
  assert.throws(() => f.read(), SyntaxError);
});

test('current member, target scope and workspace minimum corruption still fail', t => {
  const f = fixture(t);
  const db = f.store.db;
  db.prepare("UPDATE room_members SET added_by_json='not-json' WHERE room_id=? AND subject_kind='user'").run(f.room.roomId);
  assert.throws(() => f.read(), SyntaxError);
  db.prepare("UPDATE room_members SET added_by_json='{}' WHERE room_id=? AND subject_kind='user'").run(f.room.roomId);
  db.prepare("UPDATE room_messages SET context_scope_json='not-json' WHERE room_message_id=?").run(f.source.messageId);
  assert.throws(() => f.read(), SyntaxError);
  db.prepare("UPDATE room_messages SET context_scope_json='null' WHERE room_message_id=?").run(f.source.messageId);
  db.prepare("INSERT INTO room_workspace_records(kind,record_key,room_id,value_json) VALUES('minimum',?,?,?)").run(f.room.roomId, f.room.roomId, 'not-json');
  assert.throws(() => f.read(), SyntaxError);
});

test('archived room remains readable just as old snapshot; deleted room is refused', t => {
  const f = fixture(t);
  f.store.db.prepare("UPDATE rooms SET status='archived' WHERE room_id=?").run(f.room.roomId);
  assert.equal(f.service.getCollaborationRoom({ roomId: f.room.roomId }, user()).ok, true);
  assert.equal(f.read().ok, true);
  f.store.db.prepare("UPDATE rooms SET deleted_at='2026-10-29' WHERE room_id=?").run(f.room.roomId);
  assert.deepEqual(f.read(), { ok: false, code: 'room_not_found' });
});

test('real HTTP route is Desktop-only, cannot accept query actor, and preserves business 404 distinction', async t => {
  const f = fixture(t);
  const server = createServer({ roomService: f.service, roomDesktopToken: 'qa-desktop', roomKSwarmToken: 'qa-system' });
  await server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = `/rooms/${encodeURIComponent(f.room.roomId)}/authorization-context?roomMessageId=${encodeURIComponent(f.source.messageId)}`;
  for (const [token, status] of [[undefined, 401], ['bad', 401], ['qa-system', 403]]) {
    const response = await fetch(base + path + '&requestSource=user&actor=user.local', { headers: token ? { 'x-intent-broker-room-token': token } : {} });
    assert.equal(response.status, status);
  }
  const response = await fetch(base + path, { headers: { 'x-intent-broker-room-token': 'qa-desktop' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await response.json(), f.read());
  const missing = await fetch(base + path.replace(encodeURIComponent(f.source.messageId), 'missing'), { headers: { 'x-intent-broker-room-token': 'qa-desktop' } });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { ok: false, code: 'room_message_not_found' });
  const unsupported = await fetch(base + `/rooms/${f.room.roomId}/old-unknown-route`, { headers: { 'x-intent-broker-room-token': 'qa-desktop' } });
  assert.equal(unsupported.status, 404);
  assert.deepEqual(await unsupported.json(), { error: 'not_found' });
});
