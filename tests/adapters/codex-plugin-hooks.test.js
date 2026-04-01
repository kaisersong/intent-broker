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
      ensureSessionKeeper: async (input) => {
        calls.push({ type: 'keeper', input });
      },
      ensureRealtimeBridge: async (input) => {
        calls.push({ type: 'bridge', input });
      },
      registerParticipant: async (config) => {
        calls.push({ type: 'register', config });
        return { ok: true };
      },
      updateWorkState: async (config, state) => {
        calls.push({ type: 'work-state', config, state });
        return { ok: true };
      },
      pollInbox: async (config, options) => {
        calls.push({ type: 'poll', config, options });
        return { items: [] };
      }
    }
  );

  assert.equal(result, null);
  assert.equal(calls[0].type, 'keeper');
  assert.equal(calls[0].input.config.participantId, 'codex-session-019d448e');
  assert.equal(calls[0].input.sessionId, '019d448e-1234-5678-9999-aaaaaaaaaaaa');
  assert.equal(calls[1].type, 'bridge');
  assert.equal(calls[1].input.config.participantId, 'codex-session-019d448e');
  assert.equal(calls[2].type, 'register');
  assert.equal(calls[2].config.participantId, 'codex-session-019d448e');
  assert.deepEqual(calls[2].config.context, { projectName: 'intent-broker' });
  assert.equal(calls[3].type, 'work-state');
  assert.deepEqual(calls[3].state, { status: 'idle', summary: null });
  assert.equal(calls[4].type, 'poll');
});

test('session start hook still launches keeper when broker is unavailable', async () => {
  const calls = [];

  const result = await runSessionStartHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      ensureSessionKeeper: async (input) => {
        calls.push({ type: 'keeper', input });
      },
      ensureRealtimeBridge: async (input) => {
        calls.push({ type: 'bridge', input });
      },
      registerParticipant: async () => {
        calls.push({ type: 'register' });
        throw new Error('fetch failed');
      }
    }
  );

  assert.equal(result, null);
  assert.deepEqual(calls.map((item) => item.type), ['keeper', 'bridge', 'register']);
});

test('session start hook prefers hook session id over inherited CODEX_THREAD_ID', async () => {
  const calls = [];

  await runSessionStartHook(
    {
      session_id: '019d9999-1234-5678-9999-aaaaaaaaaaaa'
    },
    {
      env: {
        CODEX_THREAD_ID: '019d1111-1234-5678-9999-bbbbbbbbbbbb'
      },
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      registerParticipant: async (config) => {
        calls.push(config.participantId);
        return { ok: true };
      },
      updateWorkState: async () => ({ ok: true }),
      pollInbox: async () => ({ items: [] })
    }
  );

  assert.deepEqual(calls, ['codex-session-019d9999']);
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
      registerParticipant: async (config) => {
        calls.push({ type: 'register', participantId: config.participantId, alias: config.alias });
        return { ok: true };
      },
      pollInbox: async () => ({
        items: [
          {
            eventId: 77,
            kind: 'request_task',
            fromParticipantId: 'codex-peer',
            fromAlias: 'claude2',
            fromProjectName: 'intent-broker',
            taskId: 'real-task-1',
            threadId: 'real-thread-1',
            payload: { body: { summary: 'Please pick this up' } }
          }
        ]
      }),
      ackInbox: async (config, eventId) => acked.push({ participantId: config.participantId, eventId })
    }
  );

  assert.match(result, /Intent Broker update for codex-session-019d4489/);
  assert.match(result, /from claude2/);
  assert.match(result, /task=real-task-1/);
  assert.match(result, /thread=real-thread-1/);
  assert.equal(saved[0].state.lastSeenEventId, 77);
  assert.equal(saved[0].state.recentContext.fromParticipantId, 'codex-peer');
  assert.equal(saved[0].state.recentContext.fromAlias, 'claude2');
  assert.equal(saved[0].state.recentContext.taskId, 'real-task-1');
  assert.equal(saved[0].state.recentContext.threadId, 'real-thread-1');
  assert.deepEqual(acked, [{ participantId: 'codex-session-019d4489', eventId: 77 }]);
  assert.deepEqual(calls, [
    { type: 'register', participantId: 'codex-session-019d4489', alias: 'codex' }
  ]);
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
      registerParticipant: async (config) => {
        calls.push({ type: 'register', participantId: config.participantId });
      },
      updateWorkState: async () => {},
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
  assert.deepEqual(calls, [
    { type: 'register', participantId: 'codex-session-019d4489' },
    { type: 'poll', participantId: 'codex-session-019d4489' }
  ]);
});

test('user prompt submit hook surfaces alias rename broadcasts in injected context', async () => {
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
      registerParticipant: async () => ({ ok: true }),
      updateWorkState: async () => ({ ok: true }),
      pollInbox: async () => ({
        items: [
          {
            eventId: 88,
            kind: 'participant_alias_updated',
            fromParticipantId: 'broker.system',
            taskId: null,
            threadId: null,
            payload: {
              participantId: 'claude-peer',
              previousAlias: 'claude',
              alias: 'reviewer',
              body: { summary: 'claude-peer alias updated: claude -> reviewer' }
            }
          }
        ]
      }),
      ackInbox: async () => {}
    }
  );

  assert.match(result, /participant_alias_updated/);
  assert.match(result, /claude-peer alias updated: claude -> reviewer/);
});

test('session start hook degrades gracefully when broker is unavailable', async () => {
  const result = await runSessionStartHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      registerParticipant: async () => {
        throw new Error('fetch failed');
      }
    }
  );

  assert.equal(result, null);
});

test('user prompt submit hook degrades gracefully when broker is unavailable', async () => {
  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: '检查一下当前协作上下文'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      pollInbox: async () => {
        throw new Error('fetch failed');
      }
    }
  );

  assert.equal(result, null);
});
