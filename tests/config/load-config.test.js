import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadIntentBrokerConfig } from '../../src/config/load-config.js';

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-broker-config-'));
  try {
    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('loadIntentBrokerConfig returns defaults when config file is missing', () => withTempDir((cwd) => {
  const config = loadIntentBrokerConfig({ cwd, env: {} });

  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.server.port, 4318);
  assert.equal(config.server.dbPath, './.tmp/intent-broker.db');
  assert.deepEqual(config.channels, {});
}));

test('loadIntentBrokerConfig merges file config and resolves yunzhijia env references', () => withTempDir((cwd) => {
  fs.writeFileSync(path.join(cwd, 'intent-broker.config.json'), JSON.stringify({
    server: {
      host: '0.0.0.0',
      port: 5000,
      dbPath: './data/broker.sqlite'
    },
    channels: {
      yunzhijia: {
        enabled: true,
        sendUrlEnv: 'YZJ_SEND_URL'
      }
    }
  }, null, 2));

  const config = loadIntentBrokerConfig({
    cwd,
    env: {
      YZJ_SEND_URL: 'https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken'
    }
  });

  assert.equal(config.server.host, '0.0.0.0');
  assert.equal(config.server.port, 5000);
  assert.equal(config.server.dbPath, './data/broker.sqlite');
  assert.equal(config.channels.yunzhijia.enabled, true);
  assert.equal(config.channels.yunzhijia.sendUrlEnv, 'YZJ_SEND_URL');
  assert.equal(
    config.channels.yunzhijia.sendUrl,
    'https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken'
  );
}));

test('loadIntentBrokerConfig applies local override file on top of shared config', () => withTempDir((cwd) => {
  fs.writeFileSync(path.join(cwd, 'intent-broker.config.json'), JSON.stringify({
    channels: {
      yunzhijia: {
        enabled: false,
        sendUrlEnv: 'YZJ_SEND_URL'
      }
    }
  }, null, 2));

  fs.writeFileSync(path.join(cwd, 'intent-broker.local.json'), JSON.stringify({
    channels: {
      yunzhijia: {
        enabled: true,
        sendUrl: 'https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=localtoken'
      }
    }
  }, null, 2));

  const config = loadIntentBrokerConfig({ cwd, env: {} });

  assert.equal(config.channels.yunzhijia.enabled, true);
  assert.equal(
    config.channels.yunzhijia.sendUrl,
    'https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=localtoken'
  );
}));

test('loadIntentBrokerConfig lets env override server settings from config file', () => withTempDir((cwd) => {
  fs.writeFileSync(path.join(cwd, 'intent-broker.config.json'), JSON.stringify({
    server: {
      host: '0.0.0.0',
      port: 5000,
      dbPath: './data/broker.sqlite'
    }
  }, null, 2));

  const config = loadIntentBrokerConfig({
    cwd,
    env: {
      PORT: '4318',
      INTENT_BROKER_DB: './.tmp/override.sqlite'
    }
  });

  assert.equal(config.server.host, '0.0.0.0');
  assert.equal(config.server.port, 4318);
  assert.equal(config.server.dbPath, './.tmp/override.sqlite');
}));
