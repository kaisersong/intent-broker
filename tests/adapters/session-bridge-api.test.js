import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ackInbox,
  listParticipants,
  listWorkStates,
  pollInbox,
  registerParticipant,
  resolveParticipantAliases,
  sendAsk,
  updateWorkState,
  sendProgress,
  sendTask
} from '../../adapters/session-bridge/api.js';

function createFetchStub() {
  const calls = [];
  const fetchStub = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      async json() {
        return { ok: true };
      }
    };
  };

  return { calls, fetchStub };
}

test('registerParticipant posts participant metadata to broker', async () => {
  const { calls, fetchStub } = createFetchStub();

  await registerParticipant(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main',
      roles: ['coder'],
      capabilities: ['backend.node'],
      alias: 'codex',
      context: { projectName: 'intent-broker' }
    },
    fetchStub
  );

  assert.equal(calls[0].url, 'http://127.0.0.1:4318/participants/register');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    participantId: 'codex.main',
    kind: 'agent',
    roles: ['coder'],
    capabilities: ['backend.node'],
    alias: 'codex',
    context: { projectName: 'intent-broker' },
    inboxMode: 'pull'
  });
});

test('registerParticipant preserves explicit inbox mode metadata', async () => {
  const { calls, fetchStub } = createFetchStub();

  await registerParticipant(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main',
      roles: ['coder'],
      capabilities: [],
      alias: 'codex',
      inboxMode: 'realtime'
    },
    fetchStub
  );

  assert.equal(JSON.parse(calls[0].options.body).inboxMode, 'realtime');
});

test('pollInbox pulls inbox with after cursor and limit', async () => {
  const { calls, fetchStub } = createFetchStub();

  await pollInbox(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main'
    },
    { after: 61, limit: 10 },
    fetchStub
  );

  assert.equal(calls[0].url, 'http://127.0.0.1:4318/inbox/codex.main?after=61&limit=10');
});

test('ackInbox acknowledges the highest consumed event', async () => {
  const { calls, fetchStub } = createFetchStub();

  await ackInbox(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main'
    },
    72,
    fetchStub
  );

  assert.equal(calls[0].url, 'http://127.0.0.1:4318/inbox/codex.main/ack');
  assert.deepEqual(JSON.parse(calls[0].options.body), { eventId: 72 });
});

test('sendTask posts request_task intent', async () => {
  const { calls, fetchStub } = createFetchStub();

  await sendTask(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main'
    },
    {
      intentId: 'intent-1',
      toParticipantId: 'claude.main',
      taskId: 'task-1',
      threadId: 'thread-1',
      summary: 'Pick up the regression'
    },
    fetchStub
  );

  assert.equal(calls[0].url, 'http://127.0.0.1:4318/intents');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    intentId: 'intent-1',
    kind: 'request_task',
    fromParticipantId: 'codex.main',
    taskId: 'task-1',
    threadId: 'thread-1',
    to: { mode: 'participant', participants: ['claude.main'] },
    payload: {
      body: { summary: 'Pick up the regression' },
      delivery: { semantic: 'actionable', source: 'default' }
    }
  });
});

test('sendProgress posts report_progress intent', async () => {
  const { calls, fetchStub } = createFetchStub();

  await sendProgress(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main'
    },
    {
      intentId: 'intent-2',
      taskId: 'task-1',
      threadId: 'thread-1',
      summary: 'Still investigating'
    },
    fetchStub
  );

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    intentId: 'intent-2',
    kind: 'report_progress',
    fromParticipantId: 'codex.main',
    taskId: 'task-1',
    threadId: 'thread-1',
    to: { mode: 'broadcast' },
    payload: {
      stage: 'in_progress',
      body: { summary: 'Still investigating' },
      delivery: { semantic: 'informational', source: 'default' }
    }
  });
});

test('sendProgress can target a specific participant for reply-style updates', async () => {
  const { calls, fetchStub } = createFetchStub();

  await sendProgress(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main'
    },
    {
      intentId: 'intent-2b',
      taskId: 'task-1',
      threadId: 'thread-1',
      toParticipantId: 'claude.main',
      summary: 'Picked this up'
    },
    fetchStub
  );

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    intentId: 'intent-2b',
    kind: 'report_progress',
    fromParticipantId: 'codex.main',
    taskId: 'task-1',
    threadId: 'thread-1',
    to: { mode: 'participant', participants: ['claude.main'] },
    payload: {
      stage: 'in_progress',
      body: { summary: 'Picked this up' },
      delivery: { semantic: 'informational', source: 'default' }
    }
  });
});

test('sendAsk posts ask_clarification intent with explicit actionable delivery', async () => {
  const { calls, fetchStub } = createFetchStub();

  await sendAsk(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main'
    },
    {
      intentId: 'intent-ask',
      toParticipantId: 'claude.main',
      taskId: 'task-ask',
      threadId: 'thread-ask',
      summary: 'Need a decision',
      delivery: { semantic: 'actionable', source: 'explicit' }
    },
    fetchStub
  );

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    intentId: 'intent-ask',
    kind: 'ask_clarification',
    fromParticipantId: 'codex.main',
    taskId: 'task-ask',
    threadId: 'thread-ask',
    to: { mode: 'participant', participants: ['claude.main'] },
    payload: {
      body: { summary: 'Need a decision' },
      delivery: { semantic: 'actionable', source: 'explicit' }
    }
  });
});

test('sendProgress forwards explicit delivery overrides', async () => {
  const { calls, fetchStub } = createFetchStub();

  await sendProgress(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main'
    },
    {
      intentId: 'intent-override',
      taskId: 'task-1',
      threadId: 'thread-1',
      summary: 'FYI',
      delivery: { semantic: 'actionable', source: 'explicit' }
    },
    fetchStub
  );

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    intentId: 'intent-override',
    kind: 'report_progress',
    fromParticipantId: 'codex.main',
    taskId: 'task-1',
    threadId: 'thread-1',
    to: { mode: 'broadcast' },
    payload: {
      stage: 'in_progress',
      body: { summary: 'FYI' },
      delivery: { semantic: 'actionable', source: 'explicit' }
    }
  });
});

test('updateWorkState posts current work summary for the participant', async () => {
  const { calls, fetchStub } = createFetchStub();

  await updateWorkState(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main'
    },
    {
      status: 'implementing',
      summary: 'Wire up work-state to broker',
      taskId: 'task-7',
      threadId: 'thread-7'
    },
    fetchStub
  );

  assert.equal(calls[0].url, 'http://127.0.0.1:4318/participants/codex.main/work-state');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    status: 'implementing',
    summary: 'Wire up work-state to broker',
    taskId: 'task-7',
    threadId: 'thread-7'
  });
});

test('listWorkStates queries broker by projectName', async () => {
  const { calls, fetchStub } = createFetchStub();

  await listWorkStates(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main'
    },
    { projectName: 'intent-broker' },
    fetchStub
  );

  assert.equal(calls[0].url, 'http://127.0.0.1:4318/work-state?projectName=intent-broker');
});

test('listParticipants queries broker by projectName', async () => {
  const { calls, fetchStub } = createFetchStub();

  await listParticipants(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main'
    },
    { projectName: 'intent-broker' },
    fetchStub
  );

  assert.equal(calls[0].url, 'http://127.0.0.1:4318/participants?projectName=intent-broker');
});

test('resolveParticipantAliases queries broker alias resolution endpoint', async () => {
  const { calls, fetchStub } = createFetchStub();

  await resolveParticipantAliases(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main'
    },
    ['codex', 'claude2'],
    fetchStub
  );

  assert.equal(calls[0].url, 'http://127.0.0.1:4318/participants/resolve?aliases=codex%2Cclaude2');
});
