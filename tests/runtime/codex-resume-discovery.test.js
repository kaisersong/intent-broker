import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  attachDiscoveredCodexSession,
  discoverCodexResumeSessions
} from '../../src/runtime/codex-resume-discovery.js';

test('discoverCodexResumeSessions prefers the real codex binary and ignores exec auto-dispatch helpers', async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin' });

  try {
    const sessions = await discoverCodexResumeSessions({
      execFileImpl: async () => ({
        stdout: [
          '101 node /Users/song/.nvm/versions/node/v22.9.0/bin/codex --no-alt-screen resume 019d4c08-f640-7423-8ab8-b4f3d96715ec',
          '102 /Users/song/.nvm/versions/node/v22.9.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex --no-alt-screen resume 019d4c08-f640-7423-8ab8-b4f3d96715ec',
          '201 node /Users/song/.nvm/versions/node/v22.9.0/bin/codex exec --json --full-auto resume 019d4c08-f640-7423-8ab8-b4f3d96715ec "auto prompt"',
          '301 /Users/song/.nvm/versions/node/v22.9.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex --no-alt-screen resume 019d48da-9b3f-7f00-b9a2-1abf0d20c001'
        ].join('\n')
      })
    });

    assert.deepEqual(sessions, [
      {
        pid: 102,
        sessionId: '019d4c08-f640-7423-8ab8-b4f3d96715ec'
      },
      {
        pid: 301,
        sessionId: '019d48da-9b3f-7f00-b9a2-1abf0d20c001'
      }
    ]);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});

test('discoverCodexResumeSessions parses Windows process JSON and normalizes codex paths', async () => {
  const originalPlatform = process.platform;

  Object.defineProperty(process, 'platform', {
    value: 'win32'
  });

  try {
    const sessions = await discoverCodexResumeSessions({
      execFileImpl: async () => ({
        stdout: JSON.stringify([
          {
            ProcessId: 4100,
            CommandLine: '"C:\\Users\\song\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" resume 019d4c08-f640-7423-8ab8-b4f3d96715ec'
          },
          {
            ProcessId: 4200,
            CommandLine: 'C:\\Users\\song\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe resume 019d4c08-f640-7423-8ab8-b4f3d96715ec'
          }
        ])
      })
    });

    assert.deepEqual(sessions, [
      {
        pid: 4200,
        sessionId: '019d4c08-f640-7423-8ab8-b4f3d96715ec'
      }
    ]);
  } finally {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform
    });
  }
});

test('attachDiscoveredCodexSession starts broker sidecars for a resumed codex process', async () => {
  const calls = [];

  await attachDiscoveredCodexSession({
    brokerUrl: 'http://127.0.0.1:4318',
    repoRoot: '/Users/song/projects/intent-broker',
    sessionId: '019d4c08-f640-7423-8ab8-b4f3d96715ec',
    parentPid: 90210,
    env: {},
    homeDir: '/Users/song',
    resolveSessionCwdFromTranscript: () => '/Users/song/projects/projects',
    loadRuntimeState: () => ({
      status: 'idle',
      sessionId: null,
      turnId: null,
      source: null,
      taskId: null,
      threadId: null,
      updatedAt: null
    }),
    ensureSessionKeeper: async (input) => {
      calls.push({ type: 'keeper', input });
      return { started: true };
    },
    ensureRealtimeBridge: async (input) => {
      calls.push({ type: 'bridge', input });
      return { started: true };
    },
    registerParticipant: async (config) => {
      calls.push({ type: 'register', config });
      return { ok: true };
    },
    updateWorkState: async (config, state) => {
      calls.push({ type: 'work-state', config, state });
      return { ok: true };
    }
  });

  assert.equal(calls[0].type, 'keeper');
  assert.equal(calls[0].input.parentPid, 90210);
  assert.equal(calls[0].input.config.participantId, 'codex-session-019d4c08');
  assert.equal(calls[0].input.config.inboxMode, 'realtime');
  assert.deepEqual(calls[0].input.config.context, { projectName: 'projects' });
  assert.equal(calls[0].input.cwd, '/Users/song/projects/projects');
  assert.equal(calls[1].type, 'bridge');
  assert.equal(calls[2].type, 'register');
  assert.equal(calls[2].config.participantId, 'codex-session-019d4c08');
  assert.deepEqual(calls[3], {
    type: 'work-state',
    config: calls[2].config,
    state: { status: 'idle', summary: null }
  });
});

test('attachDiscoveredCodexSession strips leaked smoke-test broker env before spawning sidecars', async () => {
  const calls = [];

  await attachDiscoveredCodexSession({
    brokerUrl: 'http://127.0.0.1:4318',
    repoRoot: '/Users/song/projects/intent-broker',
    sessionId: '019d4be0-70eb-7721-915c-be9164b8f0d0',
    parentPid: 18760,
    env: {
      BROKER_URL: 'http://127.0.0.1:62629',
      PORT: '62629',
      INTENT_BROKER_DB: '/tmp/smoke/intent-broker.db',
      INTENT_BROKER_CONFIG: '/tmp/smoke/intent-broker.config.json',
      INTENT_BROKER_LOCAL_CONFIG: '/tmp/smoke/intent-broker.local.json'
    },
    homeDir: '/Users/song',
    resolveSessionCwdFromTranscript: () => '/Users/song/projects/projects',
    loadRuntimeState: () => ({
      status: 'idle',
      sessionId: null,
      turnId: null,
      source: null,
      taskId: null,
      threadId: null,
      updatedAt: null
    }),
    ensureSessionKeeper: async (input) => {
      calls.push({ type: 'keeper', input });
      return { started: true };
    },
    ensureRealtimeBridge: async (input) => {
      calls.push({ type: 'bridge', input });
      return { started: true };
    },
    registerParticipant: async () => ({ ok: true }),
    updateWorkState: async () => ({ ok: true })
  });

  assert.equal(calls[0].input.env.BROKER_URL, 'http://127.0.0.1:4318');
  assert.equal(calls[0].input.env.CODEX_THREAD_ID, '019d4be0-70eb-7721-915c-be9164b8f0d0');
  assert.equal(calls[0].input.env.INTENT_BROKER_INBOX_MODE, 'realtime');
  assert.equal('PORT' in calls[0].input.env, false);
  assert.equal('INTENT_BROKER_DB' in calls[0].input.env, false);
  assert.equal('INTENT_BROKER_CONFIG' in calls[0].input.env, false);
  assert.equal('INTENT_BROKER_LOCAL_CONFIG' in calls[0].input.env, false);
  assert.deepEqual(calls[0].input.env, calls[1].input.env);
});

test('attachDiscoveredCodexSession resets stale auto-dispatch runtime and replays queued work', async () => {
  const calls = [];
  const savedRuntime = [];

  await attachDiscoveredCodexSession({
    brokerUrl: 'http://127.0.0.1:4318',
    repoRoot: '/Users/song/projects/intent-broker',
    sessionId: '019d4c08-f640-7423-8ab8-b4f3d96715ec',
    parentPid: 19324,
    env: {},
    homeDir: '/Users/song',
    resolveSessionCwdFromTranscript: () => '/Users/song/projects/projects',
    loadRuntimeState: () => ({
      status: 'running',
      sessionId: '019d4c08-f640-7423-8ab8-b4f3d96715ec',
      turnId: null,
      source: 'auto-dispatch',
      taskId: 'task-stale',
      threadId: 'thread-stale',
      updatedAt: '2026-04-03T13:02:06.794Z'
    }),
    loadReplyMirrorState: () => ({
      pending: null,
      lastMirrored: null,
      lastFailure: null
    }),
    saveRuntimeState: (statePath, state) => {
      savedRuntime.push({ statePath, state });
    },
    maybeAutoDispatchRealtimeQueue: async (input) => {
      calls.push({ type: 'auto-dispatch', input });
      return { dispatched: true };
    },
    ensureSessionKeeper: async (input) => {
      calls.push({ type: 'keeper', input });
      return { started: true };
    },
    ensureRealtimeBridge: async (input) => {
      calls.push({ type: 'bridge', input });
      return { started: true };
    },
    registerParticipant: async (config) => {
      calls.push({ type: 'register', config });
      return { ok: true };
    },
    updateWorkState: async (config, state) => {
      calls.push({ type: 'work-state', config, state });
      return { ok: true };
    }
  });

  assert.equal(savedRuntime.length, 1);
  assert.equal(savedRuntime[0].statePath, path.join('/Users/song', '.intent-broker', 'codex', 'codex-session-019d4c08.runtime.json'));
  assert.deepEqual(savedRuntime[0].state, {
    status: 'idle',
    sessionId: '019d4c08-f640-7423-8ab8-b4f3d96715ec',
    turnId: null,
    source: 'resume-discovery',
    taskId: null,
    threadId: null,
    updatedAt: savedRuntime[0].state.updatedAt
  });
  assert.deepEqual(calls.find((entry) => entry.type === 'work-state'), {
    type: 'work-state',
    config: calls.find((entry) => entry.type === 'register').config,
    state: { status: 'idle', summary: null }
  });
  assert.equal(calls.at(-1).type, 'auto-dispatch');
  assert.equal(calls.at(-1).input.runtimeStatePath, path.join('/Users/song', '.intent-broker', 'codex', 'codex-session-019d4c08.runtime.json'));
  assert.equal(calls.at(-1).input.queueStatePath, path.join('/Users/song', '.intent-broker', 'codex', 'codex-session-019d4c08.queue.json'));
});
