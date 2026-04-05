import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/http/server.js';
import { createBrokerService } from '../../src/broker/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

async function startServer() {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({ broker });
  await server.listen(0, '127.0.0.1');
  return { broker, server, port: server.address().port };
}

test('GET /health returns ok payload', { concurrency: false }, async (t) => {
  const { server, port } = await startServer();
  t.after(async () => {
    await server.close();
  });

  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });
});

test('participant can register, receive inbox items, ack them, and respond to approval', { concurrency: false }, async (t) => {
  const { server, port } = await startServer();
  t.after(async () => {
    await server.close();
  });

  const registerAgent = await fetch(`http://127.0.0.1:${port}/participants/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: 'agent.a', kind: 'agent', roles: ['coder'], capabilities: ['frontend.react'] })
  });
  assert.equal(registerAgent.status, 200);

  const registerHuman = await fetch(`http://127.0.0.1:${port}/participants/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [] })
  });
  assert.equal(registerHuman.status, 200);

  const sendTask = await fetch(`http://127.0.0.1:${port}/intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intentId: 'int-1',
      kind: 'request_task',
      fromParticipantId: 'human.song',
      taskId: 'task-1',
      threadId: 'thread-1',
      to: { mode: 'participant', participants: ['agent.a'] },
      payload: { body: { summary: 'fix it' } }
    })
  });
  const sendTaskBody = await sendTask.json();
  assert.equal(sendTask.status, 202, JSON.stringify(sendTaskBody));

  const inboxResponse = await fetch(`http://127.0.0.1:${port}/inbox/agent.a?after=0`);
  const inboxBody = await inboxResponse.json();
  const taskItems = inboxBody.items.filter((item) => item.kind === 'request_task');
  assert.equal(inboxResponse.status, 200);
  assert.equal(taskItems.length, 1);
  assert.equal(taskItems[0].intentId, 'int-1');

  const ackResponse = await fetch(`http://127.0.0.1:${port}/inbox/agent.a/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventId: taskItems[0].eventId })
  });
  assert.equal(ackResponse.status, 200);

  await fetch(`http://127.0.0.1:${port}/intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intentId: 'int-approval',
      kind: 'request_approval',
      fromParticipantId: 'agent.a',
      taskId: 'task-1',
      threadId: 'thread-1',
      to: { mode: 'participant', participants: ['human.song'] },
      payload: { approvalId: 'app-1', approvalScope: 'submit_result' }
    })
  });

  const approvalResponse = await fetch(`http://127.0.0.1:${port}/approvals/app-1/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'task-1', fromParticipantId: 'human.song', decision: 'approved' })
  });
  const approvalBody = await approvalResponse.json();

  assert.equal(approvalResponse.status, 200);
  assert.equal(approvalBody.approval.status, 'approved');
});

test('inbox endpoint returns delivery semantics for stored events', { concurrency: false }, async (t) => {
  const { server, port } = await startServer();
  t.after(async () => {
    await server.close();
  });

  await fetch(`http://127.0.0.1:${port}/participants/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [] })
  });
  await fetch(`http://127.0.0.1:${port}/participants/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: 'agent.a', kind: 'agent', roles: ['coder'], capabilities: [] })
  });

  const sendTask = await fetch(`http://127.0.0.1:${port}/intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intentId: 'int-delivery-1',
      kind: 'request_task',
      fromParticipantId: 'human.song',
      taskId: 'task-delivery-1',
      threadId: 'thread-delivery-1',
      to: { mode: 'participant', participants: ['agent.a'] },
      payload: { body: { summary: 'handle this' } }
    })
  });
  assert.equal(sendTask.status, 202);

  const inboxResponse = await fetch(`http://127.0.0.1:${port}/inbox/agent.a?after=0`);
  const inboxBody = await inboxResponse.json();

  assert.equal(inboxResponse.status, 200);
  assert.equal(inboxBody.items[0].payload.delivery.semantic, 'actionable');
  assert.equal(inboxBody.items[0].payload.delivery.source, 'default');
});

test('query endpoints return task view, thread timeline, and replay slices', { concurrency: false }, async (t) => {
  const { server, port } = await startServer();
  t.after(async () => {
    await server.close();
  });

  await fetch(`http://127.0.0.1:${port}/participants/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: 'agent.a', kind: 'agent', roles: ['coder'], capabilities: ['frontend.react'] })
  });

  await fetch(`http://127.0.0.1:${port}/intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intentId: 'int-task-2',
      kind: 'request_task',
      fromParticipantId: 'human.song',
      taskId: 'task-2',
      threadId: 'thread-2',
      to: { mode: 'participant', participants: ['agent.a'] },
      payload: { body: { summary: 'build api' } }
    })
  });

  await fetch(`http://127.0.0.1:${port}/intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intentId: 'int-progress-2',
      kind: 'report_progress',
      fromParticipantId: 'agent.a',
      taskId: 'task-2',
      threadId: 'thread-2',
      to: { mode: 'participant', participants: ['human.song'] },
      payload: { stage: 'started' }
    })
  });

  const taskResponse = await fetch(`http://127.0.0.1:${port}/tasks/task-2`);
  const taskBody = await taskResponse.json();
  assert.equal(taskResponse.status, 200);
  assert.equal(taskBody.task.taskId, 'task-2');
  assert.equal(taskBody.task.status, 'in_progress');

  const threadResponse = await fetch(`http://127.0.0.1:${port}/threads/thread-2`);
  const threadBody = await threadResponse.json();
  assert.equal(threadResponse.status, 200);
  assert.equal(threadBody.thread.threadId, 'thread-2');
  assert.equal(threadBody.thread.events.length, 2);
  assert.equal(threadBody.thread.events[0].intentId, 'int-task-2');

  const replayResponse = await fetch(`http://127.0.0.1:${port}/events/replay?taskId=task-2&after=0`);
  const replayBody = await replayResponse.json();
  assert.equal(replayResponse.status, 200);
  assert.equal(replayBody.items.length, 2);
  assert.equal(replayBody.items[1].intentId, 'int-progress-2');
});

test('register endpoint accepts projectName context and participants endpoint filters by projectName', { concurrency: false }, async (t) => {
  const { server, port } = await startServer();
  t.after(async () => {
    await server.close();
  });

  const registerA = await fetch(`http://127.0.0.1:${port}/participants/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      participantId: 'codex.a',
      kind: 'agent',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'intent-broker' }
    })
  });
  const registerABody = await registerA.json();

  assert.equal(registerA.status, 200);
  assert.deepEqual(registerABody.context, { projectName: 'intent-broker' });

  await fetch(`http://127.0.0.1:${port}/participants/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      participantId: 'codex.b',
      kind: 'agent',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'other-project' }
    })
  });

  const participantsResponse = await fetch(
    `http://127.0.0.1:${port}/participants?projectName=intent-broker`
  );
  const participantsBody = await participantsResponse.json();

  assert.equal(participantsResponse.status, 200);
  assert.equal(participantsBody.participants.length, 1);
  assert.equal(participantsBody.participants[0].participantId, 'codex.a');
  assert.deepEqual(participantsBody.participants[0].context, { projectName: 'intent-broker' });
});

test('work-state endpoints store and query current project work', { concurrency: false }, async (t) => {
  const { server, port } = await startServer();
  t.after(async () => {
    await server.close();
  });

  await fetch(`http://127.0.0.1:${port}/participants/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      participantId: 'codex.a',
      kind: 'agent',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'intent-broker' }
    })
  });

  const updateResponse = await fetch(`http://127.0.0.1:${port}/participants/codex.a/work-state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status: 'implementing',
      summary: 'Add broker work-state endpoint',
      taskId: 'task-5',
      threadId: 'thread-5'
    })
  });
  const updateBody = await updateResponse.json();

  assert.equal(updateResponse.status, 200);
  assert.equal(updateBody.participantId, 'codex.a');
  assert.equal(updateBody.projectName, 'intent-broker');
  assert.equal(updateBody.status, 'implementing');

  const detailResponse = await fetch(`http://127.0.0.1:${port}/participants/codex.a/work-state`);
  const detailBody = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(detailBody.workState.summary, 'Add broker work-state endpoint');

  const listResponse = await fetch(
    `http://127.0.0.1:${port}/work-state?projectName=intent-broker`
  );
  const listBody = await listResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(listBody.items.length, 1);
  assert.equal(listBody.items[0].participantId, 'codex.a');
  assert.equal(listBody.items[0].taskId, 'task-5');
});

test('GET /projects/:projectName/snapshot returns aggregated project snapshot', { concurrency: false }, async (t) => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({ broker });
  await server.listen(0, '127.0.0.1');
  t.after(async () => { await server.close(); });

  broker.registerParticipant({
    participantId: 'codex.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex',
    context: { projectName: 'intent-broker' }
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/projects/intent-broker/snapshot`);
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.snapshot.projectName, 'intent-broker');
  assert.ok(Array.isArray(json.snapshot.participants));
  assert.ok(typeof json.snapshot.counts === 'object');
});

test('GET /projects/:projectName/approvals returns pending approvals', { concurrency: false }, async (t) => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({ broker });
  await server.listen(0, '127.0.0.1');
  t.after(async () => { await server.close(); });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/projects/intent-broker/approvals?status=pending`);
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(json.items));
});

test('GET /health includes degraded and managed channel state fields when healthProvider is set', { concurrency: false }, async (t) => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({
    broker,
    healthProvider: () => ({
      ok: true,
      status: 'degraded',
      degraded: true,
      reasons: ['yunzhijia:disconnected'],
      channels: [{ name: 'yunzhijia', status: 'disconnected' }]
    })
  });
  await server.listen(0, '127.0.0.1');
  t.after(async () => { await server.close(); });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.degraded, true);
  assert.equal(json.channels[0].status, 'disconnected');
});

test('participant alias endpoints assign unique aliases, rename them, and resolve mentions', { concurrency: false }, async (t) => {
  const { server, port } = await startServer();
  t.after(async () => {
    await server.close();
  });

  const firstRegister = await fetch(`http://127.0.0.1:${port}/participants/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      participantId: 'codex.a',
      kind: 'agent',
      roles: ['coder'],
      capabilities: [],
      alias: 'codex'
    })
  });
  const firstBody = await firstRegister.json();

  const secondRegister = await fetch(`http://127.0.0.1:${port}/participants/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      participantId: 'codex.b',
      kind: 'agent',
      roles: ['coder'],
      capabilities: [],
      alias: 'codex'
    })
  });
  const secondBody = await secondRegister.json();

  const renameResponse = await fetch(`http://127.0.0.1:${port}/participants/codex.b/alias`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alias: 'reviewer' })
  });
  const renameBody = await renameResponse.json();

  const resolveResponse = await fetch(
    `http://127.0.0.1:${port}/participants/resolve?aliases=codex,reviewer,missing`
  );
  const resolveBody = await resolveResponse.json();

  assert.equal(firstRegister.status, 200);
  assert.equal(secondRegister.status, 200);
  assert.equal(firstBody.alias, 'codex');
  assert.equal(secondBody.alias, 'codex2');
  assert.equal(renameResponse.status, 200);
  assert.equal(renameBody.participant.alias, 'reviewer');
  assert.deepEqual(
    resolveBody.participants.map((participant) => participant.participantId),
    ['codex.a', 'codex.b']
  );
  assert.deepEqual(resolveBody.missingAliases, ['missing']);
});

test('POST /away enables away mode, GET /away returns state, DELETE /away disables it', { concurrency: false }, async (t) => {
  const { server, port } = await startServer();
  t.after(async () => { await server.close(); });

  const getOff = await fetch(`http://127.0.0.1:${port}/away`);
  assert.equal(getOff.status, 200);
  assert.equal((await getOff.json()).away, false);

  const enable = await fetch(`http://127.0.0.1:${port}/away`, { method: 'POST' });
  assert.equal(enable.status, 200);
  assert.equal((await enable.json()).away, true);

  const getOn = await fetch(`http://127.0.0.1:${port}/away`);
  assert.equal((await getOn.json()).away, true);

  const disable = await fetch(`http://127.0.0.1:${port}/away`, { method: 'DELETE' });
  assert.equal(disable.status, 200);
  assert.equal((await disable.json()).away, false);
});
