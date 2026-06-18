import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runSessionStartHook,
  runUserPromptSubmitHook
} from '../../adapters/qodercli-plugin/hooks.js';

test('qoder session start hook repairs incompatible managed plugin hooks before broker sync', async () => {
  const calls = [];

  const result = await runSessionStartHook(
    {
      session_id: 'efcb5a58-3b22-4fd8-ab79-0c4763b67239',
      cwd: '/Users/song/projects/xiaok-cli'
    },
    {
      env: {},
      cwd: '/Users/song/projects/xiaok-cli',
      homeDir: '/tmp/qoder-home',
      repairManagedPluginHooks: (input) => {
        calls.push({ type: 'repair', input });
        return { repairedFiles: ['/tmp/qoder-home/.qoder/plugins/qoder-update/hooks/hooks.json'] };
      },
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      saveRuntimeState: () => {},
      ensureSessionKeeper: async (input) => {
        calls.push({ type: 'keeper', input });
      },
      ensureRealtimeBridge: async (input) => {
        calls.push({ type: 'bridge', input });
      },
      registerParticipant: async (config) => {
        calls.push({ type: 'register', config });
        return { ok: true, alias: 'qoder' };
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

  assert.equal(result.registration.ok, true);
  assert.deepEqual(calls.map((item) => item.type), [
    'repair',
    'keeper',
    'bridge',
    'register',
    'work-state',
    'poll'
  ]);
  assert.deepEqual(calls[0].input, {
    homeDir: '/tmp/qoder-home',
    platform: process.platform
  });
});

test('qoder user prompt submit hook repairs incompatible managed plugin hooks for already-running sessions', async () => {
  const calls = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: 'efcb5a58-3b22-4fd8-ab79-0c4763b67239',
      cwd: '/Users/song/projects/xiaok-cli',
      prompt: '继续'
    },
    {
      env: {},
      cwd: '/Users/song/projects/xiaok-cli',
      homeDir: '/tmp/qoder-home',
      repairManagedPluginHooks: (input) => {
        calls.push({ type: 'repair', input });
        return { repairedFiles: ['/tmp/qoder-home/.qoder/plugins/qoder-update/hooks/hooks.json'] };
      },
      loadCursorState: () => ({ lastSeenEventId: 0, recentContext: null }),
      saveRuntimeState: () => {},
      loadRealtimeQueueState: () => ({ actionable: [], informational: [], lastEventId: 0 }),
      saveRealtimeQueueState: () => {},
      ensureSessionKeeper: async (input) => {
        calls.push({ type: 'keeper', input });
      },
      ensureRealtimeBridge: async (input) => {
        calls.push({ type: 'bridge', input });
      },
      registerParticipant: async (config) => {
        calls.push({ type: 'register', config });
        return { ok: true, alias: 'qoder' };
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
  assert.deepEqual(calls.map((item) => item.type), [
    'repair',
    'keeper',
    'bridge',
    'register',
    'work-state',
    'poll'
  ]);
});
