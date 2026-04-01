import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ensureSessionKeeper,
  resolveObservedParentPid,
  runSessionKeeperIteration
} from '../../adapters/session-bridge/session-keeper.js';

test('ensureSessionKeeper spawns a detached background keeper and records its pid', async () => {
  const spawnCalls = [];
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-keeper-'));

  const result = await ensureSessionKeeper({
    toolName: 'codex',
    cliPath: '/repo/adapters/codex-plugin/bin/codex-broker.js',
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    cwd: '/Users/song/projects/intent-broker',
    homeDir,
    parentPid: 4242,
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d448e',
      alias: 'codex',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'intent-broker' }
    },
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return {
        pid: 5151,
        unref() {}
      };
    }
  });

  assert.equal(result.started, true);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args.slice(-1), ['keepalive']);
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(spawnCalls[0].options.env.INTENT_BROKER_KEEPALIVE_PARENT_PID, '4242');
  assert.equal(
    JSON.parse(readFileSync(result.statePath, 'utf8')).pid,
    5151
  );
});

test('ensureSessionKeeper reuses a live keeper for the same session', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-keeper-'));

  await ensureSessionKeeper({
    toolName: 'codex',
    cliPath: '/repo/adapters/codex-plugin/bin/codex-broker.js',
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    cwd: '/Users/song/projects/intent-broker',
    homeDir,
    parentPid: 4242,
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d448e',
      alias: 'codex',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'intent-broker' }
    },
    isProcessAlive: () => true,
    spawnImpl: () => ({
      pid: 5151,
      unref() {}
    })
  });

  let spawnedAgain = false;
  const reused = await ensureSessionKeeper({
    toolName: 'codex',
    cliPath: '/repo/adapters/codex-plugin/bin/codex-broker.js',
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    cwd: '/Users/song/projects/intent-broker',
    homeDir,
    parentPid: 4242,
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d448e',
      alias: 'codex',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'intent-broker' }
    },
    isProcessAlive: () => true,
    spawnImpl: () => {
      spawnedAgain = true;
      return {
        pid: 6161,
        unref() {}
      };
    }
  });

  assert.equal(reused.started, false);
  assert.equal(reused.pid, 5151);
  assert.equal(spawnedAgain, false);
});

test('resolveObservedParentPid skips shell wrapper processes when possible', () => {
  const outputs = new Map([
    ['ps -o comm= -p 200', '/bin/zsh\n'],
    ['ps -o ppid= -p 200', '300\n']
  ]);

  const resolved = resolveObservedParentPid(200, {
    execFileSyncImpl: (command, args) => outputs.get(`${command} ${args.join(' ')}`)
  });

  assert.equal(resolved, 300);
});

test('runSessionKeeperIteration marks the participant offline once the parent exits', async () => {
  const calls = [];
  const shouldContinue = await runSessionKeeperIteration({
    config: {
      participantId: 'codex-session-019d448e'
    },
    parentPid: 4242,
    isProcessAlive: () => false,
    registerParticipant: async () => {
      calls.push('register');
    },
    updatePresence: async (config, status, metadata) => {
      calls.push({ participantId: config.participantId, status, metadata });
    }
  });

  assert.equal(shouldContinue, false);
  assert.deepEqual(calls, [
    {
      participantId: 'codex-session-019d448e',
      status: 'offline',
      metadata: {
        source: 'session-keeper',
        reason: 'parent-exit',
        parentPid: 4242
      }
    }
  ]);
});
