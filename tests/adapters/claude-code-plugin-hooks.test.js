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
      ackInbox: async (config, eventId) => acked.push({ participantId: config.participantId, eventId })
    }
  );

  assert.match(result, /Intent Broker update for claude-code-session-019d4489/);
  assert.equal(saved[0].state.lastSeenEventId, 77);
  assert.deepEqual(acked, [{ participantId: 'claude-code-session-019d4489', eventId: 77 }]);
});
