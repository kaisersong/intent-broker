import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runSessionStartHook,
  runUserPromptSubmitHook
} from '../../adapters/codex-plugin/hooks.js';

test('session start hook always registers and returns no output when inbox is empty', async () => {
  const calls = [];
  const result = await runSessionStartHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      registerParticipant: async (config) => {
        calls.push({ type: 'register', config });
        return { ok: true };
      },
      pollInbox: async (config, options) => {
        calls.push({ type: 'poll', config, options });
        return { items: [] };
      }
    }
  );

  assert.equal(result, null);
  assert.equal(calls[0].type, 'register');
  assert.equal(calls[0].config.participantId, 'codex-session-019d448e');
  assert.deepEqual(calls[0].config.context, { projectName: 'intent-broker' });
  assert.equal(calls[1].type, 'poll');
});

test('user prompt submit hook skips slash commands without registering', async () => {
  const calls = [];
  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: '/status'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      registerParticipant: async () => {
        calls.push('register');
      },
      pollInbox: async () => {
        calls.push('poll');
        return { items: [] };
      }
    }
  );

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('user prompt submit hook injects context, saves cursor, and acks inbox without registering', async () => {
  const saved = [];
  const acked = [];
  const calls = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: '检查一下当前协作上下文'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      saveCursorState: (statePath, state) => saved.push({ statePath, state }),
      pollInbox: async () => ({
        items: [
          {
            eventId: 77,
            kind: 'request_task',
            fromParticipantId: 'codex-peer',
            taskId: 'real-task-1',
            threadId: 'real-thread-1',
            payload: { body: { summary: 'Please pick this up' } }
          }
        ]
      }),
      ackInbox: async (config, eventId) => acked.push({ participantId: config.participantId, eventId }),
      registerParticipant: async () => {
        calls.push('register');
        return { ok: true };
      }
    }
  );

  assert.match(result, /Intent Broker update for codex-session-019d4489/);
  assert.equal(saved[0].state.lastSeenEventId, 77);
  assert.deepEqual(acked, [{ participantId: 'codex-session-019d4489', eventId: 77 }]);
  assert.deepEqual(calls, []);
});

test('user prompt submit hook can poll inbox without prior register call in the same hook', async () => {
  const calls = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: '检查一下当前协作上下文'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      saveCursorState: () => {},
      pollInbox: async (config) => {
        calls.push({ type: 'poll', participantId: config.participantId });
        return {
          items: [
            {
              eventId: 1,
              kind: 'report_progress',
              fromParticipantId: 'codex-peer',
              taskId: 'task',
              threadId: 'thread',
              payload: { body: { summary: 'progress' } }
            }
          ]
        };
      },
      ackInbox: async () => {}
    }
  );

  assert.match(result, /codex-session-019d4489/);
  assert.deepEqual(calls, [{ type: 'poll', participantId: 'codex-session-019d4489' }]);
});
