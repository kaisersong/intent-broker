import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listPersistedAgentSessions,
  refreshPersistedAgentSessions
} from '../../src/runtime/persisted-agent-sessions.js';

test('listPersistedAgentSessions returns live codex and claude sessions from keeper state', () => {
  const filesByDir = new Map([
    ['/Users/song/.intent-broker/codex', ['codex-session-019d6cc6.keeper.json', 'codex-session-019d6cc6.runtime.json']],
    ['/Users/song/.intent-broker/claude-code', ['claude-code-session-45ba7f3d.keeper.json', 'claude-code-session-45ba7f3d.runtime.json']]
  ]);
  const fileBodies = new Map([
    ['/Users/song/.intent-broker/codex/codex-session-019d6cc6.keeper.json', JSON.stringify({
      pid: 4368,
      sessionId: '019d6cc6-5fbf-7183-b6ed-4af2158ce09a',
      inboxMode: 'realtime',
      brokerUrl: 'http://127.0.0.1:4318'
    })],
    ['/Users/song/.intent-broker/codex/codex-session-019d6cc6.runtime.json', JSON.stringify({
      alias: null
    })],
    ['/Users/song/.intent-broker/claude-code/claude-code-session-45ba7f3d.keeper.json', JSON.stringify({
      pid: 89988,
      sessionId: '45ba7f3d-eae1-4e6d-af25-7113e006bd26',
      inboxMode: 'realtime',
      brokerUrl: 'http://127.0.0.1:4318'
    })],
    ['/Users/song/.intent-broker/claude-code/claude-code-session-45ba7f3d.runtime.json', JSON.stringify({
      alias: 'claude6'
    })]
  ]);

  const sessions = listPersistedAgentSessions({
    homeDir: '/Users/song',
    readdirSyncImpl: (dirPath) => filesByDir.get(dirPath) || [],
    readFileSyncImpl: (filePath) => {
      const body = fileBodies.get(filePath);
      if (!body) {
        throw new Error(`missing fixture: ${filePath}`);
      }
      return body;
    },
    isProcessAliveImpl: (pid) => pid === 4368 || pid === 89988
  });

  assert.deepEqual(sessions, [
      {
        toolName: 'codex',
        participantId: 'codex-session-019d6cc6',
        sessionId: '019d6cc6-5fbf-7183-b6ed-4af2158ce09a',
        alias: null,
        terminalApp: null,
        projectPath: null,
        sessionHint: null,
        terminalTTY: null,
        terminalSessionID: null,
        brokerUrl: 'http://127.0.0.1:4318',
        inboxMode: 'realtime',
        pid: 4368,
        parentPid: null
      },
      {
        toolName: 'claude-code',
        participantId: 'claude-code-session-45ba7f3d',
        sessionId: '45ba7f3d-eae1-4e6d-af25-7113e006bd26',
        alias: 'claude6',
        terminalApp: null,
        projectPath: null,
        sessionHint: null,
        terminalTTY: null,
        terminalSessionID: null,
        brokerUrl: 'http://127.0.0.1:4318',
        inboxMode: 'realtime',
        pid: 89988,
        parentPid: null
      }
    ]);
});

test('listPersistedAgentSessions preserves the observed parent pid from keeper state', () => {
  const filesByDir = new Map([
    ['/Users/song/.intent-broker/claude-code', ['claude-code-session-45ba7f3d.keeper.json', 'claude-code-session-45ba7f3d.runtime.json']]
  ]);
  const fileBodies = new Map([
    ['/Users/song/.intent-broker/claude-code/claude-code-session-45ba7f3d.keeper.json', JSON.stringify({
      pid: 89988,
      parentPid: 5206,
      sessionId: '45ba7f3d-eae1-4e6d-af25-7113e006bd26',
      inboxMode: 'realtime',
      brokerUrl: 'http://127.0.0.1:4318'
    })],
    ['/Users/song/.intent-broker/claude-code/claude-code-session-45ba7f3d.runtime.json', JSON.stringify({
      alias: 'claude6'
    })]
  ]);

  const sessions = listPersistedAgentSessions({
    homeDir: '/Users/song',
    readdirSyncImpl: (dirPath) => filesByDir.get(dirPath) || [],
    readFileSyncImpl: (filePath) => {
      const body = fileBodies.get(filePath);
      if (!body) {
        throw new Error(`missing fixture: ${filePath}`);
      }
      return body;
    },
    isProcessAliveImpl: (pid) => pid === 89988
  });

  assert.equal(sessions[0].parentPid, 5206);
});

test('refreshPersistedAgentSessions re-registers live sessions with derived terminal metadata', async () => {
  const calls = [];
  const titled = [];

  const refreshed = await refreshPersistedAgentSessions({
    repoRoot: '/Users/song/projects/intent-broker',
    homeDir: '/Users/song',
    env: {
      TERM_PROGRAM: 'ghostty'
    },
    logger: { log() {}, warn() {} },
    listSessions: () => ([
      {
        toolName: 'codex',
        participantId: 'codex-session-019d6cc6',
        sessionId: '019d6cc6-5fbf-7183-b6ed-4af2158ce09a',
        alias: null,
        terminalApp: null,
        projectPath: null,
        sessionHint: null,
        terminalTTY: null,
        terminalSessionID: null,
        brokerUrl: 'http://127.0.0.1:4318',
        inboxMode: 'realtime',
        pid: 4368,
        parentPid: 3216
      },
      {
        toolName: 'claude-code',
        participantId: 'claude-code-session-45ba7f3d',
        sessionId: '45ba7f3d-eae1-4e6d-af25-7113e006bd26',
        alias: 'claude6',
        terminalApp: null,
        projectPath: null,
        sessionHint: null,
        terminalTTY: null,
        terminalSessionID: null,
        brokerUrl: 'http://127.0.0.1:4318',
        inboxMode: 'realtime',
        pid: 89988,
        parentPid: 5206
      }
    ]),
    resolveSessionCwdFromTranscript: (toolName, sessionId) => {
      if (toolName === 'codex') {
        assert.equal(sessionId, '019d6cc6-5fbf-7183-b6ed-4af2158ce09a');
        return '/Users/song/projects/hexdeck';
      }
      if (toolName === 'claude-code') {
        assert.equal(sessionId, '45ba7f3d-eae1-4e6d-af25-7113e006bd26');
        return '/Users/song/projects/xiaok-cli';
      }
      return null;
    },
    registerParticipant: async (config) => {
      calls.push(config);
      return { ok: true };
    },
    resolveTerminalTTYFromPid: (pid) => {
      if (pid === 3216) {
        return '/dev/ttys003';
      }
      if (pid === 5206) {
        return '/dev/ttys007';
      }
      return null;
    },
    appendAliasToTTYTitle: ({ ttyPath, alias, projectName }) => {
      titled.push({ ttyPath, alias, projectName });
    },
  });

  assert.equal(refreshed.length, 2);
  assert.deepEqual(calls, [
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d6cc6',
      alias: 'codex',
      inboxMode: 'realtime',
      roles: ['coder'],
      capabilities: ['broker.auto_dispatch'],
      context: { projectName: 'hexdeck' },
      metadata: {
        terminalApp: 'Ghostty',
        projectPath: '/Users/song/projects/hexdeck',
        sessionHint: null,
        terminalTTY: '/dev/ttys003'
      }
    },
    {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'claude-code-session-45ba7f3d',
      alias: 'claude6',
      inboxMode: 'realtime',
      roles: ['coder'],
      capabilities: ['broker.auto_dispatch'],
      context: { projectName: 'xiaok-cli' },
      metadata: {
        terminalApp: 'Ghostty',
        projectPath: '/Users/song/projects/xiaok-cli',
        sessionHint: null,
        terminalTTY: '/dev/ttys007'
      }
    }
  ]);
  assert.deepEqual(titled, [
    {
      ttyPath: '/dev/ttys003',
      alias: 'codex',
      projectName: 'hexdeck'
    },
    {
      ttyPath: '/dev/ttys007',
      alias: 'claude6',
      projectName: 'xiaok-cli'
    }
  ]);
});
