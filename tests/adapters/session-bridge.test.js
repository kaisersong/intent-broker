import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveSessionBridgeConfig,
  enrichConfigWithFocusedTerminalLocator
} from '../../adapters/session-bridge/config.js';

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
  assert.equal(config.alias, 'codex');
  assert.deepEqual(config.roles, ['coder']);
  assert.deepEqual(config.context, { projectName: 'intent-broker' });
  assert.deepEqual(config.metadata, {
    terminalApp: 'unknown',
    sessionHint: null,
    terminalTTY: null,
    projectPath: '/Users/song/projects/intent-broker'
  });
});

test('deriveSessionBridgeConfig derives participant id from codex thread id', () => {
  const config = deriveSessionBridgeConfig({
    toolName: 'codex',
    env: {
      CODEX_THREAD_ID: '019d42b4-f5bd-7f51-91b7-5df7eee4fdbb'
    },
    cwd: '/Users/song/projects/intent-broker'
  });

  assert.equal(config.brokerUrl, 'http://127.0.0.1:4318');
  assert.equal(config.participantId, 'codex-session-019d42b4');
  assert.equal(config.alias, 'codex');
  assert.deepEqual(config.capabilities, ['broker.auto_dispatch']);
  assert.deepEqual(config.context, { projectName: 'intent-broker' });
  assert.deepEqual(config.metadata, {
    terminalApp: 'unknown',
    sessionHint: null,
    terminalTTY: null,
    projectPath: '/Users/song/projects/intent-broker'
  });
});

test('deriveSessionBridgeConfig derives participant id from claude code session id', () => {
  const config = deriveSessionBridgeConfig({
    toolName: 'claude-code',
    env: {
      CLAUDE_CODE_SESSION_ID: '019d42d0-1111-2222-3333-444444444444'
    },
    cwd: '/Users/song/projects/intent-broker'
  });

  assert.equal(config.participantId, 'claude-code-session-019d42d0');
  assert.equal(config.alias, 'claude');
  assert.deepEqual(config.capabilities, ['broker.auto_dispatch']);
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
  assert.equal(config.alias, 'claude');
  assert.deepEqual(config.context, { projectName: 'manual-project' });
});

test('deriveSessionBridgeConfig prefers explicit alias override', () => {
  const config = deriveSessionBridgeConfig({
    toolName: 'xiaok-code',
    env: {
      ALIAS: 'backend'
    },
    cwd: '/Users/song/projects/intent-broker'
  });

  assert.equal(config.alias, 'backend');
});

test('deriveSessionBridgeConfig honors explicit inbox mode override', () => {
  const config = deriveSessionBridgeConfig({
    toolName: 'codex',
    env: {
      INTENT_BROKER_INBOX_MODE: 'realtime'
    },
    cwd: '/Users/song/projects/intent-broker'
  });

  assert.equal(config.inboxMode, 'realtime');
});

test('deriveSessionBridgeConfig prefers explicit session cwd over process cwd for project name', () => {
  const config = deriveSessionBridgeConfig({
    toolName: 'codex',
    env: {},
    cwd: '/Users/song/projects',
    sessionCwd: '/Users/song/projects/intent-broker'
  });

  assert.deepEqual(config.context, { projectName: 'intent-broker' });
  assert.deepEqual(config.metadata, {
    terminalApp: 'unknown',
    sessionHint: null,
    terminalTTY: null,
    projectPath: '/Users/song/projects/intent-broker'
  });
});

test('deriveSessionBridgeConfig maps TERM_PROGRAM into jump metadata', () => {
  const config = deriveSessionBridgeConfig({
    toolName: 'codex',
    env: {
      TERM_PROGRAM: 'ghostty'
    },
    cwd: '/Users/song/projects/hexdeck'
  });

  assert.deepEqual(config.metadata, {
    terminalApp: 'Ghostty',
    sessionHint: null,
    terminalTTY: null,
    projectPath: '/Users/song/projects/hexdeck'
  });
});

test('enrichConfigWithFocusedTerminalLocator ignores Ghostty locator when focused project mismatches', () => {
  const config = {
    metadata: {
      terminalApp: 'Ghostty',
      sessionHint: null,
      terminalTTY: '/dev/ttys003',
      projectPath: '/Users/song/projects/hexdeck'
    }
  };

  const enriched = enrichConfigWithFocusedTerminalLocator(config, {
    execFileSyncImpl(command) {
      assert.equal(command, '/usr/bin/osascript');
      return `ghostty-claude${String.fromCharCode(31)}/Users/song/projects/xiaok-cli${String.fromCharCode(31)}Claude`;
    }
  });

  assert.deepEqual(enriched.metadata, {
    terminalApp: 'Ghostty',
    sessionHint: '/dev/ttys003',
    terminalTTY: '/dev/ttys003',
    projectPath: '/Users/song/projects/hexdeck'
  });
});

test('enrichConfigWithFocusedTerminalLocator accepts Ghostty locator when focused project matches', () => {
  const config = {
    metadata: {
      terminalApp: 'Ghostty',
      sessionHint: null,
      terminalTTY: '/dev/ttys003',
      projectPath: '/Users/song/projects/hexdeck'
    }
  };

  const enriched = enrichConfigWithFocusedTerminalLocator(config, {
    execFileSyncImpl() {
      return `ghostty-codex${String.fromCharCode(31)}/Users/song/projects/hexdeck${String.fromCharCode(31)}Codex`;
    }
  });

  assert.deepEqual(enriched.metadata, {
    terminalApp: 'Ghostty',
    sessionHint: 'ghostty-codex',
    terminalTTY: '/dev/ttys003',
    projectPath: '/Users/song/projects/hexdeck',
    terminalSessionID: 'ghostty-codex'
  });
});
