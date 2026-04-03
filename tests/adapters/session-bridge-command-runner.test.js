import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runInboxCommand,
  runReplyCommand,
  runWhoCommand
} from '../../adapters/session-bridge/command-runner.js';

test('runInboxCommand prints unread events, saves recent context, and acks highest event id', async () => {
  const outputs = [];
  const saved = [];
  const acked = [];

  const result = await runInboxCommand(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main',
      context: { projectName: 'intent-broker' }
    },
    {
      toolName: 'codex',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      saveCursorState: (statePath, state) => saved.push({ statePath, state }),
      pollInbox: async () => ({
        items: [
          {
            eventId: 90,
            kind: 'request_task',
            fromParticipantId: 'claude.session',
            fromAlias: 'claude2',
            fromProjectName: 'intent-broker',
            taskId: 'task-9',
            threadId: 'thread-9',
            payload: { body: { summary: 'Please review the hook bridge' } }
          }
        ]
      }),
      ackInbox: async (config, eventId) => acked.push({ participantId: config.participantId, eventId }),
      out: (line) => outputs.push(line)
    }
  );

  assert.equal(result.lastSeenEventId, 90);
  assert.equal(result.recentContext.fromAlias, 'claude2');
  assert.equal(result.recentContext.taskId, 'task-9');
  assert.equal(result.recentContext.threadId, 'thread-9');
  assert.equal(saved[0].state.lastSeenEventId, 90);
  assert.equal(saved[0].state.recentContext.fromParticipantId, 'claude.session');
  assert.deepEqual(acked, [{ participantId: 'codex.main', eventId: 90 }]);
  assert.match(outputs[0], /request_task from claude2/);
  assert.match(outputs[0], /task=task-9/);
});

test('runReplyCommand reuses recent context and sends targeted progress reply', async () => {
  const outputs = [];
  const sent = [];
  const cleared = [];

  const result = await runReplyCommand(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main',
      context: { projectName: 'intent-broker' }
    },
    ['已收到，开始处理'],
    {
      toolName: 'codex',
      loadCursorState: () => ({
        lastSeenEventId: 90,
        recentContext: {
          fromParticipantId: 'claude.session',
          fromAlias: 'claude2',
          taskId: 'task-9',
          threadId: 'thread-9'
        }
      }),
      sendProgress: async (config, payload) => {
        sent.push({ participantId: config.participantId, payload });
        return { eventId: 91, recipients: ['claude.session'] };
      },
      clearPendingReplyMirror: (toolName, participantId) => {
        cleared.push({ toolName, participantId });
      },
      out: (line) => outputs.push(line)
    }
  );

  assert.equal(result.recipients[0], 'claude.session');
  assert.equal(sent[0].payload.toParticipantId, 'claude.session');
  assert.equal(sent[0].payload.taskId, 'task-9');
  assert.equal(sent[0].payload.threadId, 'thread-9');
  assert.equal(sent[0].payload.summary, '已收到，开始处理');
  assert.deepEqual(cleared, [{ toolName: 'codex', participantId: 'codex.main' }]);
  assert.match(outputs[0], /Replied to claude2/);
  assert.match(outputs[0], /task=task-9/);
});

test('runReplyCommand can resolve explicit alias override', async () => {
  const sent = [];

  await runReplyCommand(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main',
      context: { projectName: 'intent-broker' }
    },
    ['@reviewer', '请看最新测试结果'],
    {
      toolName: 'codex',
      loadCursorState: () => ({
        lastSeenEventId: 90,
        recentContext: {
          fromParticipantId: 'claude.session',
          fromAlias: 'claude2',
          taskId: 'task-9',
          threadId: 'thread-9'
        }
      }),
      resolveParticipantAliases: async () => ({
        participants: [{ participantId: 'claude.reviewer', alias: 'reviewer' }],
        missingAliases: []
      }),
      sendProgress: async (_config, payload) => {
        sent.push(payload);
        return { eventId: 92, recipients: ['claude.reviewer'] };
      },
      out: () => {}
    }
  );

  assert.equal(sent[0].toParticipantId, 'claude.reviewer');
});

test('runWhoCommand prints same-project roster with work states', async () => {
  const outputs = [];

  await runWhoCommand(
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex.main',
      context: { projectName: 'intent-broker' }
    },
    {
      listParticipants: async () => ({
        participants: [
          { participantId: 'codex.main', alias: 'codex', context: { projectName: 'intent-broker' } },
          { participantId: 'claude.session', alias: 'claude2', context: { projectName: 'intent-broker' } }
        ]
      }),
      listWorkStates: async () => ({
        items: [
          { participantId: 'claude.session', status: 'implementing', summary: 'Working on alias sync', taskId: 'task-9', threadId: 'thread-9' }
        ]
      }),
      out: (line) => outputs.push(line)
    }
  );

  assert.match(outputs[0], /intent-broker/);
  assert.match(outputs[0], /codex/);
  assert.match(outputs[0], /claude2/);
  assert.match(outputs[0], /implementing/);
  assert.match(outputs[0], /task=task-9/);
});
