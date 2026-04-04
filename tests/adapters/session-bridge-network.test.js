import test from 'node:test';
import assert from 'node:assert/strict';

import { requestJson } from '../../adapters/session-bridge/api.js';

test('requestJson falls back to curl when fetch gets localhost EPERM', async () => {
  const fetchImpl = async () => {
    const error = new TypeError('fetch failed');
    error.cause = {
      code: 'EPERM',
      address: '127.0.0.1',
      port: 4318
    };
    throw error;
  };

  const calls = [];
  const execFileImpl = async (file, args, options) => {
    calls.push({ file, args, options });
    return {
      stdout: JSON.stringify({ ok: true })
    };
  };

  const response = await requestJson(
    'http://127.0.0.1:4318/health',
    {},
    { fetchImpl, execFileImpl }
  );

  assert.deepEqual(response, { ok: true });
  assert.equal(calls[0].file, 'curl');
  assert.deepEqual(calls[0].args, ['-s', 'http://127.0.0.1:4318/health']);
});

test('requestJson rethrows non-EPERM fetch failures', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };

  await assert.rejects(
    requestJson('https://example.com/health', {}, { fetchImpl }),
    /fetch failed/
  );
});

test('requestJson wraps curl connection failures as broker unavailable', async () => {
  const fetchImpl = async () => {
    const error = new TypeError('fetch failed');
    error.cause = {
      code: 'EPERM',
      address: '127.0.0.1',
      port: 4318
    };
    throw error;
  };

  const execFileImpl = async () => {
    const error = new Error('Command failed: curl -s http://127.0.0.1:4318/health');
    error.code = 7;
    error.cmd = 'curl -s http://127.0.0.1:4318/health';
    throw error;
  };

  await assert.rejects(
    requestJson('http://127.0.0.1:4318/health', {}, { fetchImpl, execFileImpl }),
    (error) => {
      assert.equal(error?.name, 'BrokerUnavailableError');
      assert.equal(error?.code, 'INTENT_BROKER_UNAVAILABLE');
      assert.equal(error?.brokerUrl, 'http://127.0.0.1:4318');
      return true;
    }
  );
});
