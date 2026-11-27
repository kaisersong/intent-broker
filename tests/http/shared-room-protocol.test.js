import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSharedRoomAuthenticator } from '../../src/http/shared-room-auth.js';
import { createServer } from '../../src/http/server.js';
import { createRoomService } from '../../src/room/service.js';
import { createRoomStore } from '../../src/room/store.js';

const capabilities = [
  'shared-session-authority-v1', 'shared-room-scope-v1',
  'exact-operation-receipt-v1', 'room-history-snapshot-v1',
];
const localToken = 'desktop-test-token';
const systemToken = 'kswarm-test-token';
const scope = '/rooms/shared/rooms';
const alice = {
  workspaceId: 'workspace-a', principalId: 'alice', deviceId: 'device-a',
  deviceGeneration: 1, recoveryGeneration: 1,
};
const bob = { ...alice, principalId: 'bob', deviceId: 'device-b' };
const secondDevice = { ...alice, deviceId: 'device-c' };

function issue(key, claims, issuedAt = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ ...claims, issuedAt, expiresAt: issuedAt + 10_000 })).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(key, 'hex')).update('shared-room-session.v1.' + payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

test('the independent authenticator verifies the coordinator signature, expiry and bound subject', () => {
  const key = randomBytes(32).toString('hex');
  const now = Date.now();
  const authenticate = createSharedRoomAuthenticator(key, () => now);
  const assertion = issue(key, { ...alice, requestSource: 'system', actor: { userId: 'user.local' } }, now);
  assert.deepEqual(authenticate(assertion), { ...alice, requestSource: 'user',
    actor: { kind: 'user', userId: alice.principalId } });
  const [payload, signature] = assertion.split('.');
  const modifiedPayload = Buffer.from(JSON.stringify({ ...alice, workspaceId: 'other' })).toString('base64url');
  assert.equal(authenticate(modifiedPayload + '.' + signature), null);
  assert.equal(authenticate(payload + '.invalid'), null);
  assert.equal(authenticate(issue(key, alice, now - 10_000)), null);
  assert.equal(authenticate(issue(key, { ...alice, principalId: 'user.local' }, now)), null);
  assert.equal(authenticate(issue(key, { ...alice, deviceGeneration: 0 }, now)), null);
  assert.equal(authenticate(localToken), null);
});

test('shared Room HTTP protocol authenticates, scopes, reconciles and pages authoritative writes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'broker-shared-http-'));
  const dbPath = join(directory, 'broker.sqlite');
  const key = randomBytes(32).toString('hex');
  let clock = new Date('2026-11-26T00:00:00Z');
  let store;
  let roomService;
  let server;
  let base;
  t.after(async () => {
    try {
      if (server?.raw().listening) await server.close();
    } finally {
      roomService?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function start(enabled) {
    store = createRoomStore({ dbPath });
    store.migrate();
    roomService = createRoomService({ store, now: () => clock });
    server = createServer({ roomService, roomDesktopToken: localToken, roomKSwarmToken: systemToken,
      sharedRoomAuthorityKey: enabled ? key : null });
    await server.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${server.address().port}`;
  }

  async function stop() {
    await server.close();
    roomService.close();
    roomService = undefined;
  }

  async function request(path, { body, method, claims, token, headers = {}, status = 200 } = {}) {
    const assertion = claims ? {
      'x-intent-broker-shared-assertion': issue(key, claims),
      'x-intent-broker-shared-version': '1',
      'x-intent-broker-shared-device-generation': String(claims.deviceGeneration),
      'x-intent-broker-shared-recovery-generation': String(claims.recoveryGeneration),
    } : {};
    const result = await fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', ...assertion,
        ...(token ? { 'x-intent-broker-room-token': token } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await result.json();
    assert.equal(result.status, status, JSON.stringify(response));
    return response;
  }

  await start(false);
  const disabled = await request('/rooms/workspace-protocol', { token: localToken });
  assert.ok(capabilities.every(capability => !disabled.capabilities.includes(capability)));
  await request('/rooms/shared/protocol', { claims: alice, status: 503 });
  await stop();

  await start(true);
  const enabled = await request('/rooms/workspace-protocol', { token: localToken });
  assert.ok(capabilities.every(capability => enabled.capabilities.includes(capability)));
  assert.deepEqual((await request('/rooms/shared/protocol', { claims: alice })).capabilities, capabilities);
  await request('/rooms/shared/protocol', { token: localToken, status: 401 });
  await request('/rooms/shared/protocol', { claims: { ...alice, principalId: 'user.local' }, status: 401 });
  await request('/rooms/shared/protocol', { claims: alice, headers: {
    'x-intent-broker-shared-assertion': issue(key, alice, Date.now() - 20_000),
  }, status: 401 });

  const local = await request('/rooms', { token: localToken, body: { title: '本机', memberAgentIds: [] }, status: 201 });
  assert.equal(local.room.createdBy.userId, 'user.local');
  const create = { requestId: 'create-1', title: '共享', memberAgentIds: ['bot-b', 'bot-a'] };
  const created = await request(scope, { claims: alice, body: create });
  const roomId = created.room.roomId;
  const path = scope + '/' + roomId;
  assert.equal(created.room.sharedWorkspaceId, alice.workspaceId);
  assert.equal(created.room.createdBy.userId, alice.principalId);
  assert.deepEqual(await request(scope, { claims: alice, body: { ...create, title: ' 共享 ', memberAgentIds: ['bot-a', 'bot-b'] } }), created);
  assert.deepEqual(await request(scope + '/receipt', { claims: alice, body: { requestId: create.requestId, operation: 'create' } }), created);
  assert.equal((await request(scope, { claims: secondDevice })).rooms[0].roomId, roomId);
  assert.deepEqual((await request(scope, { claims: bob })).rooms, []);
  assert.deepEqual((await request('/rooms', { token: localToken })).rooms.map(room => room.roomId), [local.room.roomId]);
  await request('/rooms', { claims: alice, status: 401 });
  await request(scope + '/' + local.room.roomId + '/history', { claims: alice, body: {}, status: 404 });
  await request(path + '/history', { claims: bob, body: {}, status: 403 });
  await request(path + '/history', { claims: { ...alice, workspaceId: 'workspace-b' }, body: {}, status: 404 });
  for (const [endpoint, body, token] of [
    ['', undefined, localToken], ['/messages', undefined, localToken],
    ['/messages', { text: '旁路', idempotencyKey: 'bypass' }, localToken],
    ['/members', { addAgentIds: ['bot-c'] }, localToken],
    ['/workspace', undefined, localToken], ['/aimp/tasks', undefined, localToken],
    ['/project-events', {}, systemToken],
  ]) {
    await request('/rooms/' + roomId + endpoint, { token, body, status: 404 });
  }

  const message = { requestId: 'message-1', text: '第一条', expectedRoomRevision: 1 };
  const members = { requestId: 'members-1', expectedRoomRevision: 1, addAgentIds: ['bot-c'], removeAgentIds: ['bot-b'] };
  await request(path + '/message', { claims: alice, body: { ...message, actor: { userId: 'user.local' } }, status: 400 });
  await request(path + '/message', { claims: alice, body: { ...message, requestSource: 'system' }, status: 400 });
  await request(path + '/message', { claims: bob, body: message, status: 403 });
  await request(path + '/members', { claims: bob, body: members, status: 403 });
  await request(path + '/message', { claims: alice, body: message,
    headers: { 'x-intent-broker-shared-version': '0' }, status: 503 });
  await request(path + '/message', { claims: alice, body: message,
    headers: { 'x-intent-broker-shared-device-generation': '0' }, status: 409 });

  const sent = await request(path + '/message', { claims: alice, body: message });
  assert.equal(sent.message.roomSequence, 1);
  assert.equal(sent.message.sender.userId, 'alice');
  assert.equal(sent.message.responsePolicy, 'none');
  assert.deepEqual(store.listDeliveries(sent.message.messageId), []);
  const changed = await request(path + '/members', { claims: alice, body: members });
  assert.equal(changed.room.revision, 2);
  assert.equal(changed.members.find(member => member.subject.logicalAgentId === 'bot-b').status, 'removed');
  assert.deepEqual(await request(path + '/members', { claims: alice, body: members }), changed);
  assert.deepEqual(await request(path + '/message', { claims: alice, body: message }), sent);
  assert.equal((await request(path + '/message', { claims: secondDevice, body: { ...message, text: '修改' }, status: 409 })).code,
    'shared_operation_conflict');
  assert.equal((await request(path + '/members', { claims: alice, body: { ...members, requestId: 'stale' }, status: 409 })).code,
    'room_revision_conflict');

  const receipt = { operation: 'message', requestId: message.requestId };
  assert.deepEqual(await request(path + '/receipt', { claims: alice, body: receipt }), sent);
  assert.equal((await request(path + '/receipt', { claims: secondDevice, body: receipt, status: 409 })).code,
    'shared_operation_pending_verification');
  await request(path + '/receipt', { claims: bob, body: receipt, status: 403 });

  const metadata = { requestId: 'meta', title: '共享群', expectedRoomRevision: 2 };
  const renamed = await request(path + '/metadata', { claims: alice, body: metadata });
  assert.equal(renamed.room.revision, 3);
  assert.deepEqual(await request(path + '/metadata', { claims: alice, body: metadata }), renamed);
  for (const n of [2, 3]) {
    await request(path + '/message', { claims: secondDevice, body: {
      requestId: `message-${n}`, text: String(n), expectedRoomRevision: 3,
    } });
  }
  const first = await request(path + '/history', { claims: alice, body: { limit: 1 } });
  assert.equal(first.room.revision, 3);
  assert.deepEqual(first.members, renamed.members);
  assert.equal(first.roomSequenceUpperBound, 3);
  assert.equal(first.earliestAvailableSequence, 1);
  assert.equal(first.truncated, false);
  assert.deepEqual(first.messages.map(item => item.roomSequence), [1]);
  assert.ok(first.nextCursor);

  const later = await request(path + '/message', { claims: secondDevice, body: {
    requestId: 'message-4', text: '页间新增', expectedRoomRevision: 3,
  } });
  assert.equal(later.message.roomSequence, first.roomSequenceUpperBound + 1);

  await stop();
  await start(true);
  assert.deepEqual(await request(path + '/receipt', { claims: alice, body: receipt }), sent);
  assert.deepEqual(await request(path + '/receipt', { claims: alice, body: { operation: 'members', requestId: members.requestId } }), changed);
  const archived = 'shared_operation_pending_verification';
  const cursorBody = { cursor: first.nextCursor, limit: 1 };
  for (const claims of [{ ...alice, recoveryGeneration: 2 }, { ...alice, deviceGeneration: 2 }, secondDevice]) {
    assert.equal((await request(path + '/history', { claims, body: cursorBody, status: 409 })).code, 'shared_history_rebuild_required');
  }
  const next = await request(path + '/history', { claims: alice, body: cursorBody });
  assert.deepEqual(next.messages.map(item => item.roomSequence), [2]);
  const last = await request(path + '/history', { claims: alice, body: { cursor: next.nextCursor } });
  assert.equal(last.roomSequenceUpperBound, 3);
  assert.deepEqual(last.messages.map(item => item.roomSequence), [3]);
  assert.equal(last.nextCursor, null);
  const catchup = await request(path + '/history', { claims: alice, body: { afterSequence: last.roomSequenceUpperBound } });
  assert.deepEqual(catchup.messages.map(item => item.roomSequence), [4]);

  clock = new Date('2026-12-27T00:00:00Z');
  assert.equal((await request(path + '/receipt', { claims: alice, body: receipt, status: 409 })).code, archived);
  assert.equal((await request(path + '/message', { claims: alice, body: message, status: 409 })).code, archived);
  assert.equal((await request(path + '/message', { claims: alice, body: { ...message, text: '冲突' }, status: 409 })).code,
    'shared_operation_conflict');
  assert.equal((await request(path + '/receipt', { claims: alice, body: { ...receipt, requestId: 'unknown' }, status: 409 })).code, archived);
  store.db.prepare('DELETE FROM room_messages WHERE room_id=? AND room_sequence<=2').run(roomId);
  const trimmed = await request(path + '/history', { claims: alice, body: {} });
  assert.equal(trimmed.truncated, true);
  assert.equal(trimmed.earliestAvailableSequence, 3);
  assert.equal(trimmed.roomSequenceUpperBound, 4);
});
