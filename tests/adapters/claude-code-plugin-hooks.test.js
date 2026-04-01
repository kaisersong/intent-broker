import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeCodeHookOutput } from '../../adapters/claude-code-plugin/format.js';
import {
  runSessionStartHook,
  runUserPromptSubmitHook
} from '../../adapters/claude-code-plugin/hooks.js';

test('buildClaudeCodeHookOutput wraps additional context for SessionStart', () => {
  const output = buildClaudeCodeHookOutput('SessionStart', 'broker context');

  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'broker context'
    }
  });
});

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
  assert.equal(calls[0].type, 'register');
  assert.equal(calls[0].config.participantId, 'claude-code-session-019d448e');
  assert.deepEqual(calls[0].config.context, { projectName: 'intent-broker' });
  assert.equal(calls[1].type, 'work-state');
  assert.deepEqual(calls[1].state, { status: 'idle', summary: null });
});

test('session start hook prefers hook session id over inherited CLAUDE_CODE_SESSION_ID', async () => {
  const calls = [];

  await runSessionStartHook(
    {
      session_id: '019d9999-1234-5678-9999-aaaaaaaaaaaa'
    },
    {
      env: {
        CLAUDE_CODE_SESSION_ID: '019d1111-1234-5678-9999-bbbbbbbbbbbb'
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

  assert.deepEqual(calls, ['claude-code-session-019d9999']);
});

test('user prompt submit hook skips slash commands', async () => {
  const calls = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: '/status'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      pollInbox: async () => {
        calls.push('poll');
        return { items: [] };
      }
    }
  );

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('user prompt submit hook injects context, saves cursor, and acks inbox', async () => {
  const saved = [];
  const acked = [];
  const calls = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: 'check collaboration context'
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
            fromAlias: 'codex2',
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

  assert.match(result, /Intent Broker update for claude-code-session-019d4489/);
  assert.match(result, /from codex2/);
  assert.match(result, /task=real-task-1/);
  assert.match(result, /thread=real-thread-1/);
  assert.equal(saved[0].state.lastSeenEventId, 77);
  assert.equal(saved[0].state.recentContext.fromParticipantId, 'codex-peer');
  assert.equal(saved[0].state.recentContext.fromAlias, 'codex2');
  assert.equal(saved[0].state.recentContext.taskId, 'real-task-1');
  assert.equal(saved[0].state.recentContext.threadId, 'real-thread-1');
  assert.deepEqual(acked, [{ participantId: 'claude-code-session-019d4489', eventId: 77 }]);
  assert.deepEqual(calls, [
    { type: 'register', participantId: 'claude-code-session-019d4489', alias: 'claude' }
  ]);
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
      prompt: 'check collaboration context'
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

test('user prompt submit hook surfaces alias rename broadcasts in injected context', async () => {
  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: 'check collaboration context'
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
              participantId: 'codex-peer',
              previousAlias: 'codex',
              alias: 'backend',
              body: { summary: 'codex-peer alias updated: codex -> backend' }
            }
          }
        ]
      }),
      ackInbox: async () => {}
    }
  );

  assert.match(result, /participant_alias_updated/);
  assert.match(result, /codex-peer alias updated: codex -> backend/);
});
