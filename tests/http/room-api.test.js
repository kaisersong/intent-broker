import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/http/server.js';
import { createBrokerService } from '../../src/broker/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

const DESKTOP_TOKEN = 'desktop-room-test-token';
const KSWARM_TOKEN = 'kswarm-room-test-token';

async function startRoomServer(t) {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({
    broker,
    roomService: broker.room,
    roomDesktopToken: DESKTOP_TOKEN,
    roomKSwarmToken: KSWARM_TOKEN,
  });
  await server.listen(0, '127.0.0.1');
  t.after(async () => {
    await server.close();
    broker.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(baseUrl, path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { 'x-intent-broker-room-token': token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}

test('Room HTTP surface rejects missing and wrong internal tokens', { concurrency: false }, async (t) => {
  const baseUrl = await startRoomServer(t);
  for (const token of [undefined, 'wrong-token']) {
    const { response, payload } = await request(baseUrl, '/rooms', { token });
    assert.equal(response.status, 401);
    assert.equal(payload.error, 'room_authentication_required');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('Desktop Room HTTP flow persists create, list, message, member and archive operations', { concurrency: false }, async (t) => {
  const baseUrl = await startRoomServer(t);
  const created = await request(baseUrl, '/rooms', {
    token: DESKTOP_TOKEN,
    method: 'POST',
    body: {
      title: 'Desktop integration room',
      description: 'real production surface',
      memberAgentIds: ['agent-alpha'],
      clientRequestKey: 'room-create-http-1',
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.ok, true);
  const roomId = created.payload.room.roomId;

  const listed = await request(baseUrl, '/rooms', { token: DESKTOP_TOKEN });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.payload.rooms.length, 1);
  assert.equal(listed.payload.rooms[0].roomId, roomId);

  const sent = await request(baseUrl, `/rooms/${encodeURIComponent(roomId)}/messages`, {
    token: DESKTOP_TOKEN,
    method: 'POST',
    body: {
      text: 'Please inspect the renderer and report risks.',
      mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
      responsePolicy: 'mentioned',
      idempotencyKey: 'room-message-http-1',
    },
  });
  assert.equal(sent.response.status, 201, JSON.stringify(sent.payload));

  const updated = await request(baseUrl, `/rooms/${encodeURIComponent(roomId)}/members`, {
    token: DESKTOP_TOKEN,
    method: 'PUT',
    body: {
      expectedRoomRevision: created.payload.room.revision,
      addAgentIds: ['agent-beta'],
    },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.payload));
  assert.ok(updated.payload.members.some((member) => member.subject.logicalAgentId === 'agent-beta'));

  const detail = await request(baseUrl, `/rooms/${encodeURIComponent(roomId)}`, { token: DESKTOP_TOKEN });
  assert.equal(detail.response.status, 200);
  assert.equal(detail.payload.messages[0].text, 'Please inspect the renderer and report risks.');

  const archived = await request(baseUrl, `/rooms/${encodeURIComponent(roomId)}/archive`, {
    token: DESKTOP_TOKEN,
    method: 'POST',
    body: { expectedRoomRevision: updated.payload.room.revision },
  });
  assert.equal(archived.response.status, 200, JSON.stringify(archived.payload));
  assert.equal(archived.payload.room.status, 'archiving');
});

test('Desktop wake dispatcher can claim exactly one pending mention and complete it with an agent reply', { concurrency: false }, async (t) => {
  const baseUrl = await startRoomServer(t);
  const created = await request(baseUrl, '/rooms', {
    token: DESKTOP_TOKEN,
    method: 'POST',
    body: { title: 'Wake room', memberAgentIds: ['agent-alpha'], clientRequestKey: 'room-create-http-wake' },
  });
  const roomId = created.payload.room.roomId;
  const sent = await request(baseUrl, `/rooms/${encodeURIComponent(roomId)}/messages`, {
    token: DESKTOP_TOKEN,
    method: 'POST',
    body: {
      text: '@agent-alpha review this',
      mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
      responsePolicy: 'mentioned',
      idempotencyKey: 'room-message-http-wake',
    },
  });
  assert.equal(sent.response.status, 201, JSON.stringify(sent.payload));

  const pending = await request(baseUrl, '/room-wakes?logicalAgentId=agent-alpha', { token: DESKTOP_TOKEN });
  assert.equal(pending.response.status, 200, JSON.stringify(pending.payload));
  assert.deepEqual(pending.payload.obligations.map(item => item.roomMessageId), [sent.payload.message.messageId]);

  const claimed = await request(baseUrl, '/room-wakes/claim', {
    token: DESKTOP_TOKEN,
    method: 'POST',
    body: {
      roomMessageId: sent.payload.message.messageId,
      logicalAgentId: 'agent-alpha',
      hostParticipantId: 'xiaok-desktop',
    },
  });
  assert.equal(claimed.response.status, 200, JSON.stringify(claimed.payload));
  assert.equal(typeof claimed.payload.claimToken, 'string');

  const completed = await request(baseUrl, '/room-wakes/complete', {
    token: DESKTOP_TOKEN,
    method: 'POST',
    body: { claimToken: claimed.payload.claimToken, reply: { kind: 'text', text: 'Three risks found.' } },
  });
  assert.equal(completed.response.status, 201, JSON.stringify(completed.payload));

  const detail = await request(baseUrl, `/rooms/${encodeURIComponent(roomId)}`, { token: DESKTOP_TOKEN });
  const reply = detail.payload.messages.find(message => message.sender?.logicalAgentId === 'agent-alpha');
  assert.equal(reply?.text, 'Three risks found.');
  assert.equal(reply?.responsePolicy, 'none');
});

test('KSwarm token can publish project events and acquire leases but cannot impersonate a user', { concurrency: false }, async (t) => {
  const baseUrl = await startRoomServer(t);
  const created = await request(baseUrl, '/rooms', {
    token: DESKTOP_TOKEN,
    method: 'POST',
    body: { title: 'Project room', memberAgentIds: ['agent-alpha'], clientRequestKey: 'room-create-http-2' },
  });
  const roomId = created.payload.room.roomId;

  const forbidden = await request(baseUrl, '/rooms', {
    token: KSWARM_TOKEN,
    method: 'POST',
    body: { title: 'forged', memberAgentIds: [] },
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.payload.code, 'room_actor_forbidden');

  const lease = await request(baseUrl, `/rooms/${encodeURIComponent(roomId)}/membership-leases`, {
    token: KSWARM_TOKEN,
    method: 'POST',
    body: { logicalAgentId: 'agent-alpha', operationId: 'project-create-1' },
  });
  assert.equal(lease.response.status, 201, JSON.stringify(lease.payload));
  assert.equal(lease.payload.ok, true);

  const event = await request(baseUrl, `/rooms/${encodeURIComponent(roomId)}/project-events`, {
    token: KSWARM_TOKEN,
    method: 'POST',
    body: {
      projectId: 'project-1',
      projectRevision: 1,
      eventType: 'artifact.registered',
      text: 'Artifact report.html registered',
      idempotencyKey: 'project-event-http-1',
      projectionEventId: 'proj:project-1#7',
      sourceRefs: {
        projectId: 'forged-project',
        projectRevision: 999,
        eventType: 'forged.event',
        projectionEventId: 'forged-projection',
        taskId: 'task-report',
        artifactId: 'artifact-report-html',
        artifact: {
          projectId: 'project-1',
          filename: 'report.html',
          kind: 'html',
          mimeType: 'text/html',
        },
      },
    },
  });
  assert.equal(event.response.status, 201, JSON.stringify(event.payload));

  const detail = await request(baseUrl, `/rooms/${encodeURIComponent(roomId)}`, { token: DESKTOP_TOKEN });
  assert.equal(detail.response.status, 200);
  const projectEvent = detail.payload.messages.find((message) => message.kind === 'project_event');
  assert.deepEqual(projectEvent.sourceRef, {
    projectId: 'project-1',
    projectRevision: 1,
    eventType: 'artifact.registered',
    projectionEventId: 'proj:project-1#7',
    taskId: 'task-report',
    artifactId: 'artifact-report-html',
    artifact: {
      projectId: 'project-1',
      filename: 'report.html',
      kind: 'html',
      mimeType: 'text/html',
    },
  });
});
