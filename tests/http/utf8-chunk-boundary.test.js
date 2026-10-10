import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../../src/http/server.js';
import { createBrokerService } from '../../src/broker/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

async function fixture(t) {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({ broker, roomService: broker.room, roomDesktopToken: 'utf8-test-token' });
  await server.listen(0, '127.0.0.1');
  t.after(async () => { await server.close(); broker.close(); });
  return server;
}

async function splitRequest(server, buffers, { path = '/rooms', token = 'utf8-test-token' } = {}) {
  let incoming;
  const observed = [];
  server.raw().prependOnceListener('request', (req) => {
    incoming = req;
    req.prependListener('data', (chunk) => observed.push(Buffer.from(chunk)));
  });
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-intent-broker-room-token': token } });
  const response = new Promise((resolve, reject) => {
    req.once('error', reject);
    req.once('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
  });
  req.flushHeaders();
  while (!incoming) await new Promise((resolve) => setImmediate(resolve));
  for (const buffer of buffers) {
    const received = once(incoming, 'data');
    req.write(buffer);
    await received;
  }
  req.end();
  return { ...await response, observed };
}

for (const [name, character] of [['two-byte', 'é'], ['three-byte', '中'], ['four-byte', '😀']]) {
  test(`Room HTTP preserves ${name} UTF-8 across actual received chunks`, async (t) => {
    const server = await fixture(t);
    const description = `prefix-${character}-suffix`;
    const bytes = Buffer.from(JSON.stringify({ title: name, description, memberAgentIds: [], clientRequestKey: name }));
    const offset = bytes.indexOf(Buffer.from(character)) + 1;
    const result = await splitRequest(server, [bytes.subarray(0, offset), bytes.subarray(offset)]);
    assert.equal(result.observed.length, 2);
    assert.deepEqual(result.observed[0], bytes.subarray(0, offset));
    assert.deepEqual(Buffer.concat(result.observed), bytes);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.room.description, description);
    assert.equal(Buffer.byteLength(result.body.room.description), Buffer.byteLength(description));
  });
}

test('Room HTTP preserves 90 KB mixed Chinese description across received chunks', async (t) => {
  const server = await fixture(t);
  const description = '中'.repeat(30000) + 'é😀';
  const bytes = Buffer.from(JSON.stringify({ title: 'large', description, memberAgentIds: [], clientRequestKey: 'large' }));
  const offset = bytes.indexOf(Buffer.from('中')) + 1;
  const result = await splitRequest(server, [bytes.subarray(0, offset), bytes.subarray(offset, offset + 32000), bytes.subarray(offset + 32000)]);
  assert.deepEqual(Buffer.concat(result.observed), bytes);
  assert.deepEqual(result.observed[0], bytes.subarray(0, offset));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.room.description, description);
});

test('HTTP reader retains empty, malformed, incomplete UTF-8 and authorization outcomes', async (t) => {
  const server = await fixture(t);
  const request = async (body, token = 'utf8-test-token') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/rooms`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-intent-broker-room-token': token }, body,
    });
    return { status: response.status, body: await response.json() };
  };
  const empty = await request('');
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'room_input_invalid');
  const malformed = await request('{');
  assert.equal(malformed.status, 500);
  assert.equal(malformed.body.error, 'internal_error');
  const incomplete = Buffer.concat([Buffer.from('{"title":"incomplete","description":"'), Buffer.from([0xe4]),
    Buffer.from('","memberAgentIds":[],"clientRequestKey":"incomplete"}')]);
  const decoded = await splitRequest(server, [incomplete]);
  assert.equal(decoded.status, 201);
  assert.equal(decoded.body.room.description, '\uFFFD');
  const unauthorized = await request('{"title":"denied"}', 'wrong');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error, 'room_authentication_required');
});

test('intents counts original bytes at exact 16 KiB and one byte above', async (t) => {
  const server = await fixture(t);
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const participantId of ['utf8-sender', 'utf8-receiver']) {
    const response = await fetch(`${base}/participants/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantId, kind: 'agent', roles: ['coder'], capabilities: [] }) });
    assert.equal(response.status, 200);
  }
  const body = Buffer.from(JSON.stringify({ intentId: 'utf8-exact-limit', kind: 'request_task', fromParticipantId: 'utf8-sender',
    taskId: 'utf8-task', threadId: 'utf8-thread', to: { mode: 'participant', participants: ['utf8-receiver'] },
    payload: { body: { summary: '中文😀' } } }));
  const exact = Buffer.concat([body, Buffer.alloc(16384 - body.length, 0x20)]);
  const offset = body.indexOf(Buffer.from('中')) + 1;
  const accepted = await splitRequest(server, [exact.subarray(0, offset), exact.subarray(offset)], { path: '/intents' });
  assert.equal(Buffer.concat(accepted.observed).length, 16384);
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const denied = await splitRequest(server, [Buffer.concat([exact, Buffer.from(' ')])], { path: '/intents' });
  assert.equal(denied.status, 413);
  assert.equal(denied.body.error, 'request_body_too_large');
});
