import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSessionBridgeConfig } from '../../adapters/session-bridge/config.js';

test('deriveSessionBridgeConfig prefers explicit participant id', () => {
  const config = deriveSessionBridgeConfig({
    toolName: 'codex',
    env: {
      BROKER_URL: 'http://127.0.0.1:9999',
      PARTICIPANT_ID: 'codex.manual',
      CODEX_THREAD_ID: 'thread-from-env'
    },
    cwd: '/Users/song/projects/intent-broker'
  });

  assert.equal(config.brokerUrl, 'http://127.0.0.1:9999');
  assert.equal(config.participantId, 'codex.manual');
  assert.deepEqual(config.roles, ['coder']);
  assert.deepEqual(config.context, { projectName: 'intent-broker' });
});

test('deriveSessionBridgeConfig derives participant id from thread id', () => {
  const config = deriveSessionBridgeConfig({
    toolName: 'codex',
    env: {
      CODEX_THREAD_ID: '019d42b4-f5bd-7f51-91b7-5df7eee4fdbb'
    },
    cwd: '/Users/song/projects/intent-broker'
  });

  assert.equal(config.brokerUrl, 'http://127.0.0.1:4318');
  assert.equal(config.participantId, 'codex-session-019d42b4');
  assert.deepEqual(config.context, { projectName: 'intent-broker' });
});

test('deriveSessionBridgeConfig falls back to tool name when no thread id exists', () => {
  const config = deriveSessionBridgeConfig({
    toolName: 'claude-code',
    env: {
      PROJECT_NAME: 'manual-project'
    },
    cwd: '/Users/song/projects/intent-broker'
  });

  assert.equal(config.participantId, 'claude-code-session');
  assert.deepEqual(config.context, { projectName: 'manual-project' });
});
