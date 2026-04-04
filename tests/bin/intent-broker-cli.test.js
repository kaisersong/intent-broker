import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const brokerUrl = 'http://127.0.0.1:65234';

async function assertBrokerUnavailable({ scriptPath, args }) {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [scriptPath, ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          BROKER_URL: brokerUrl
        }
      }
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, new RegExp(`Intent Broker is unavailable at ${brokerUrl.replaceAll('.', '\\.')}`));
      assert.doesNotMatch(error.stderr, /node:internal\/errors/);
      return true;
    }
  );
}

test('intent-broker who prints a friendly message when broker is unavailable', async () => {
  await assertBrokerUnavailable({
    scriptPath: path.join(repoRoot, 'bin', 'intent-broker.js'),
    args: ['who']
  });
});

test('intent-broker task prints a friendly message when broker is unavailable', async () => {
  await assertBrokerUnavailable({
    scriptPath: path.join(repoRoot, 'bin', 'intent-broker.js'),
    args: ['task', 'claude-real-1', 'real-task-1', 'real-thread-1', 'Please', 'pick', 'this', 'up']
  });
});

test('codex-broker who prints a friendly message when broker is unavailable', async () => {
  await assertBrokerUnavailable({
    scriptPath: path.join(repoRoot, 'adapters', 'codex-plugin', 'bin', 'codex-broker.js'),
    args: ['who']
  });
});

test('claude-code-broker who prints a friendly message when broker is unavailable', async () => {
  await assertBrokerUnavailable({
    scriptPath: path.join(repoRoot, 'adapters', 'claude-code-plugin', 'bin', 'claude-code-broker.js'),
    args: ['who']
  });
});
