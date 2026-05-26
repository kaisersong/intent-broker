import test from 'node:test';
import assert from 'node:assert/strict';

import { requestJson } from '../../adapters/session-bridge/api.js';
import { formatCliError } from '../../adapters/session-bridge/cli-errors.js';

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
      assert.equal(error?.reason, 'loopback_access_blocked_or_unavailable');
      assert.equal(error?.fetchCause?.cause?.code, 'EPERM');
      assert.equal(error?.curlCause?.code, 7);
      return true;
    }
  );
});

test('formatCliError explains local sandbox EPERM instead of only saying broker unavailable', () => {
  const fetchError = new TypeError('fetch failed');
  fetchError.cause = { code: 'EPERM' };
  const curlError = new Error('Command failed: curl -s http://127.0.0.1:4318/health');
  curlError.code = 7;

  const error = new Error('intent_broker_unavailable:http://127.0.0.1:4318');
  error.code = 'INTENT_BROKER_UNAVAILABLE';
  error.brokerUrl = 'http://127.0.0.1:4318';
  error.fetchCause = fetchError;
  error.curlCause = curlError;

  const message = formatCliError(error);

  assert.match(message, /could not be reached from this process/);
  assert.match(message, /EPERM/);
  assert.match(message, /curl fallback also failed with exit code 7/);
  assert.match(message, /curl -sS http:\/\/127\.0\.0\.1:4318\/health/);
});
