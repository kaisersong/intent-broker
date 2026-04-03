import test from 'node:test';
import assert from 'node:assert/strict';

import { startBrokerApp } from '../../src/runtime/start-broker-app.js';

test('startBrokerApp syncs local agent bridges before managed channels start', async () => {
  const order = [];
  const logger = { log() {}, warn() {} };
  const broker = {
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
    }
  });

  assert.deepEqual(order.slice(0, 4), [
    'sync:/Users/song/projects/intent-broker',
    'listen',
    'attach-ws',
    'channels-start'
  ]);
  assert.equal(order[4], 'discovery-start');

  await app.close();

  assert.deepEqual(order.slice(-4), ['discovery-stop', 'channels-stop', 'broker-close', 'server-close']);
});
