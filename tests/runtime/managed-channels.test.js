import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedChannelsRuntime } from '../../src/runtime/managed-channels.js';

test('createManagedChannelsRuntime starts and stops managed yunzhijia channel', async () => {
  const calls = [];
  const stops = [];

  const runtime = createManagedChannelsRuntime({
    brokerUrl: 'http://127.0.0.1:4318',
    channels: {
      yunzhijia: {
        enabled: true,
        sendUrl: 'https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken'
      }
    },
    factories: {
      yunzhijia: (options) => {
        calls.push(options);
        return {
          async start() {},
          stop() {
            stops.push(options.sendUrl);
          }
        };
      }
    }
  });

  await runtime.startAll();

  assert.deepEqual(calls, [{
    brokerUrl: 'http://127.0.0.1:4318',
    sendUrl: 'https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken'
  }]);
  assert.deepEqual(runtime.describe(), [{
    name: 'yunzhijia',
    enabled: true,
    managed: true
  }]);

  await runtime.stopAll();
  assert.deepEqual(stops, ['https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken']);
});

test('createManagedChannelsRuntime skips disabled channels', async () => {
  const runtime = createManagedChannelsRuntime({
    brokerUrl: 'http://127.0.0.1:4318',
    channels: {
      yunzhijia: {
        enabled: false,
        sendUrl: 'https://example.com'
      }
    },
    factories: {
      yunzhijia: () => {
        throw new Error('should_not_start');
      }
    }
  });

  await runtime.startAll();
  assert.deepEqual(runtime.describe(), [{
    name: 'yunzhijia',
    enabled: false,
    managed: false
  }]);
});

test('createManagedChannelsRuntime fails fast when enabled yunzhijia is missing sendUrl', async () => {
  const runtime = createManagedChannelsRuntime({
    brokerUrl: 'http://127.0.0.1:4318',
    channels: {
      yunzhijia: {
        enabled: true
      }
    }
  });

  await assert.rejects(
    runtime.startAll(),
    /yunzhijia\.sendUrl/
  );
});
