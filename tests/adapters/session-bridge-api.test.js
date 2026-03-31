import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ackInbox,
  pollInbox,
  registerParticipant,
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
    context: { projectName: 'intent-broker' }
  });
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
    payload: { body: { summary: 'Pick up the regression' } }
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
    payload: { stage: 'in_progress', body: { summary: 'Still investigating' } }
  });
});
