import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveDefaultSocketPath, SOCKET_PATH, startBrokerApp } from '../../src/runtime/start-broker-app.js';

test('resolveDefaultSocketPath disables the local socket by default on Windows', () => {
  assert.equal(resolveDefaultSocketPath({ env: {}, platform: 'win32' }), null);
  assert.equal(resolveDefaultSocketPath({ env: {}, platform: 'linux' }), SOCKET_PATH);
  assert.equal(
    resolveDefaultSocketPath({
      env: { INTENT_BROKER_SOCKET_PATH: 'C:\\tmp\\intent-broker.sock' },
      platform: 'win32'
    }),
    'C:\\tmp\\intent-broker.sock'
  );
  assert.equal(
    resolveDefaultSocketPath({
      env: { INTENT_BROKER_SOCKET_PATH: '' },
      platform: 'linux'
    }),
    null
  );
});

test('startBrokerApp syncs local agent bridges before managed channels start', async () => {
  const order = [];
  const registrations = [];
  const logger = { log() {}, warn() {} };
  const broker = {
    registerParticipant(participant) {
      registrations.push(participant);
      return participant;
    },
    attachWebSocket() {
      order.push('attach-ws');
    },
    close() {
      order.push('broker-close');
    }
  };
  const server = {
    async listen() {
      order.push('listen');
    },
    raw() {
      return {};
    },
    address() {
      return { port: 4318 };
    },
    async close() {
      order.push('server-close');
    }
  };
  const channels = {
    async startAll() {
      order.push('channels-start');
    },
    async stopAll() {
      order.push('channels-stop');
    },
    describe() {
      return [];
    }
  };
  const discovery = {
    async start() {
      order.push('discovery-start');
    },
    async stop() {
      order.push('discovery-stop');
    }
  };

  const app = await startBrokerApp({
    cwd: '/Users/song/projects/intent-broker',
    env: {},
    logger,
    persistedSessionRefreshIntervalMs: 0,
    socketPath: null,
    loadConfig: () => ({
      server: { dbPath: '.tmp/test.db', host: '127.0.0.1', port: 4318 },
      channels: {},
      configPath: '/repo/intent-broker.config.json',
      localConfigPath: '/repo/intent-broker.local.json'
    }),
    createBroker: () => broker,
    createHttpServer: () => server,
    createChannelsRuntime: () => channels,
    createCodexResumeDiscoveryRuntime: () => discovery,
    syncAgentBridges: async (options) => {
      order.push(`sync:${options.repoRoot}`);
      return [];
    },
    refreshPersistedAgentSessions: async (options) => {
      await options.registerParticipant({
        participantId: 'codex-session-019dc3ee',
        roles: ['coder'],
        capabilities: ['broker.auto_dispatch'],
        alias: 'codex',
        context: { projectName: 'hexdeck' },
        metadata: { projectPath: '/Users/song/projects/hexdeck' },
        inboxMode: 'realtime'
      });
      order.push(`refresh:${options.repoRoot}`);
      return [];
    }
  });

  assert.deepEqual(order.slice(0, 5), [
    'sync:/Users/song/projects/intent-broker',
    'listen',
    'attach-ws',
    'refresh:/Users/song/projects/intent-broker',
    'channels-start'
  ]);
  assert.equal(order[5], 'discovery-start');
  assert.deepEqual(registrations, [
    {
      participantId: 'codex-session-019dc3ee',
      kind: 'agent',
      roles: ['coder'],
      capabilities: ['broker.auto_dispatch'],
      alias: 'codex',
      context: { projectName: 'hexdeck' },
      metadata: { projectPath: '/Users/song/projects/hexdeck' },
      inboxMode: 'realtime'
    }
  ]);

  await app.close();

  assert.deepEqual(order.slice(-4), ['discovery-stop', 'channels-stop', 'broker-close', 'server-close']);
});

test('startBrokerApp separates writable runtime cwd from packaged repo root', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'intent-broker-runtime-'));
  const repoRoot = '/Applications/xiaok.app/Contents/Resources/services/intent-broker';
  const seen = {};
  const logger = { log() {}, warn() {} };
  const broker = {
    registerParticipant(participant) {
      return participant;
    },
    attachWebSocket() {},
    close() {}
  };
  const server = {
    async listen() {},
    raw() {
      return {};
    },
    address() {
      return { port: 4318 };
    },
    async close() {}
  };
  const channels = {
    async startAll() {},
    async stopAll() {},
    describe() {
      return [];
    }
  };
  const discovery = {
    async start() {},
    async stop() {}
  };

  try {
    const app = await startBrokerApp({
      cwd: runtimeRoot,
      env: { INTENT_BROKER_REPO_ROOT: repoRoot },
      logger,
      persistedSessionRefreshIntervalMs: 0,
      socketPath: null,
      loadConfig: ({ cwd, env }) => {
        seen.configCwd = cwd;
        seen.configRepoRoot = env.INTENT_BROKER_REPO_ROOT;
        return {
          server: { dbPath: '.tmp/test.db', host: '127.0.0.1', port: 4318 },
          channels: {},
          configPath: join(repoRoot, 'intent-broker.config.json'),
          localConfigPath: join(runtimeRoot, 'intent-broker.local.json')
        };
      },
      createBroker: ({ dbPath }) => {
        seen.dbPath = dbPath;
        return broker;
      },
      createHttpServer: () => server,
      createChannelsRuntime: () => channels,
      createCodexResumeDiscoveryRuntime: (options) => {
        seen.discoveryRepoRoot = options.repoRoot;
        return discovery;
      },
      syncAgentBridges: async (options) => {
        seen.syncRepoRoot = options.repoRoot;
        seen.syncCwd = options.cwd;
        return [];
      },
      refreshPersistedAgentSessions: async (options) => {
        seen.refreshRepoRoot = options.repoRoot;
        return [];
      }
    });

    assert.equal(seen.configCwd, runtimeRoot);
    assert.equal(seen.configRepoRoot, repoRoot);
    assert.equal(seen.dbPath, join(runtimeRoot, '.tmp', 'test.db'));
    assert.equal(seen.syncRepoRoot, repoRoot);
    assert.equal(seen.syncCwd, runtimeRoot);
    assert.equal(seen.refreshRepoRoot, repoRoot);
    assert.equal(seen.discoveryRepoRoot, repoRoot);

    await app.close();
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
