import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    findBrokerProcesses,
    isBrokerControlEntrypoint,
    isBrokerCommand,
    restartBroker,
    startBroker,
    statusBroker,
    summarizeHeartbeat,
    stopBroker
} from '../../scripts/broker-control.js';

test('isBrokerControlEntrypoint handles Windows-style argv paths', () => {
  const moduleUrl = new URL('../../scripts/broker-control.js', import.meta.url).href;

  assert.equal(isBrokerControlEntrypoint({
    moduleUrl,
    argv1: path.join(process.cwd(), 'scripts', 'broker-control.js')
  }), true);
  assert.equal(isBrokerControlEntrypoint({
    moduleUrl,
    argv1: path.join(process.cwd(), 'scripts', 'other.js')
  }), false);
});

test('isBrokerCommand matches the broker main process only', () => {
  assert.equal(isBrokerCommand('node --experimental-sqlite src/cli.js'), true);
  assert.equal(isBrokerCommand('/usr/local/bin/node /Users/song/projects/intent-broker/src/cli.js'), true);
  assert.equal(isBrokerCommand('node adapters/codex-plugin/bin/codex-broker.js keepalive'), false);
  assert.equal(isBrokerCommand('node scripts/broker-control.js stop'), false);
});

test('findBrokerProcesses returns only broker listener processes on the target port', () => {
  const commands = new Map([
    [47069, 'node --experimental-sqlite src/cli.js'],
    [47070, 'node adapters/codex-plugin/bin/codex-broker.js keepalive']
  ]);

  const processes = findBrokerProcesses({
    port: 4318,
    platform: 'darwin',
    runCommand: ({ command, args }) => {
      if (command === 'lsof') {
        assert.deepEqual(args, ['-nP', '-iTCP:4318', '-sTCP:LISTEN', '-t']);
        return '47069\n47070\n';
      }
      if (command === 'ps') {
        const pid = Number(args[1]);
        return commands.get(pid) || '';
      }
      throw new Error(`unexpected command: ${command}`);
    }
  });

  assert.deepEqual(processes, [
    { pid: 47069, command: 'node --experimental-sqlite src/cli.js' }
  ]);
});

test('findBrokerProcesses uses hidden PowerShell process lookup on Windows', () => {
  const calls = [];

  const processes = findBrokerProcesses({
    port: 4318,
    platform: 'win32',
    runCommand: ({ command, args, options }) => {
      calls.push({ command, args, options });
      if (command === 'netstat') {
        return [
          '  TCP    127.0.0.1:4318    0.0.0.0:0    LISTENING    47069',
          '  TCP    127.0.0.1:4319    0.0.0.0:0    LISTENING    47070'
        ].join('\n');
      }
      if (command === 'powershell') {
        assert.ok(args.includes('-NoProfile'));
        assert.ok(args.includes('-NonInteractive'));
        assert.ok(args.includes('-WindowStyle'));
        assert.ok(args.includes('Hidden'));
        assert.equal(options.windowsHide, true);
        return JSON.stringify([
          { ProcessId: 47069, CommandLine: 'node --experimental-sqlite src/cli.js' },
          { ProcessId: 47070, CommandLine: 'node adapters/codex-plugin/bin/codex-broker.js keepalive' }
        ]);
      }
      throw new Error(`unexpected command: ${command}`);
    }
  });

  assert.deepEqual(processes, [
    { pid: 47069, command: 'node --experimental-sqlite src/cli.js' }
  ]);
  assert.equal(calls[0].command, 'netstat');
  assert.equal(calls[1].command, 'powershell');
});

test('summarizeHeartbeat marks terminal heartbeat for a non-listening pid as stale', () => {
  assert.deepEqual(
    summarizeHeartbeat(
      { pid: 47173, status: 'stopped' },
      [{ pid: 15693, command: 'node --experimental-sqlite src/cli.js' }]
    ),
    {
      state: 'stale',
      matchesRunningProcess: false,
      reason: 'terminal_heartbeat_for_pid_47173'
    }
  );
});

test('statusBroker reports running_with_stale_heartbeat when port listener and heartbeat disagree', () => {
  const status = statusBroker({
    repoRoot: '/Users/song/projects/intent-broker',
    platform: 'darwin',
    runCommand: ({ command, args }) => {
      if (command === 'lsof') {
        assert.deepEqual(args, ['-nP', '-iTCP:4318', '-sTCP:LISTEN', '-t']);
        return '15693\n';
      }
      if (command === 'ps') {
        assert.equal(args[1], '15693');
        return '/opt/homebrew/bin/node --experimental-sqlite src/cli.js';
      }
      throw new Error(`unexpected command: ${command}`);
    },
    loadHeartbeatState: () => ({
      pid: 47173,
      status: 'stopped',
      updatedAt: '2026-05-26T01:31:42.646Z'
    })
  });

  assert.equal(status.running, true);
  assert.equal(status.status, 'running_with_stale_heartbeat');
  assert.deepEqual(status.heartbeatSummary, {
    state: 'stale',
    matchesRunningProcess: false,
    reason: 'terminal_heartbeat_for_pid_47173'
  });
});

test('stopBroker sends SIGTERM first and escalates to SIGKILL only if needed', async () => {
  const killed = [];
  const savedHeartbeats = [];
  let forceKilled = false;

  const result = await stopBroker({
    repoRoot: '/Users/song/projects/intent-broker',
    port: 4318,
    platform: 'darwin',
    termWaitMs: 10,
    killWaitMs: 10,
    intervalMs: 1,
    runCommand: ({ command, args }) => {
      if (command === 'lsof') {
        return '47069\n';
      }
      if (command === 'ps') {
        return 'node --experimental-sqlite src/cli.js';
      }
      throw new Error(`unexpected command: ${command}`);
    },
    killProcess: (pid, signal) => {
      killed.push({ pid, signal });
      if (signal === 'SIGKILL') {
        forceKilled = true;
      }
    },
    isProcessAlive: () => !forceKilled,
    sleep: async () => {},
    loadHeartbeatState: () => ({
      pid: 47069,
      status: 'running',
      startedAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:01.000Z'
    }),
    saveHeartbeatState: (heartbeatPath, state, options) => {
      savedHeartbeats.push({ heartbeatPath, state, options });
      return true;
    },
    now: () => new Date('2026-06-01T00:00:02.000Z')
  });

  assert.deepEqual(killed, [
    { pid: 47069, signal: 'SIGTERM' },
    { pid: 47069, signal: 'SIGKILL' }
  ]);
  assert.equal(result.stopped, true);
  assert.equal(result.forceKilled, true);
  assert.equal(savedHeartbeats.length, 1);
  assert.ok(savedHeartbeats[0].heartbeatPath.endsWith(path.join('.tmp', 'broker.heartbeat.json')));
  assert.deepEqual(savedHeartbeats[0].options, { onlyIfOwnedByPid: 47069 });
  assert.equal(savedHeartbeats[0].state.status, 'stopped');
  assert.equal(savedHeartbeats[0].state.signal, 'SIGKILL');
  assert.equal(savedHeartbeats[0].state.exitAt, '2026-06-01T00:00:02.000Z');
});

test('restartBroker stops an existing broker and starts a new detached process', async () => {
  const killed = [];
  const spawned = [];
  let lsofCalls = 0;

  const result = await restartBroker({
    repoRoot: '/Users/song/projects/intent-broker',
    platform: 'darwin',
    port: 4318,
    termWaitMs: 1,
    startWaitMs: 10,
    killWaitMs: 1,
    intervalMs: 1,
    runCommand: ({ command, args }) => {
      if (command === 'lsof') {
        lsofCalls += 1;
        return lsofCalls === 1 ? '47069\n' : '49000\n';
      }
      if (command === 'ps') {
        const pid = Number(args[1]);
        return pid === 47069
          ? 'node --experimental-sqlite src/cli.js'
          : '/opt/homebrew/bin/node --experimental-sqlite src/cli.js';
      }
      throw new Error(`unexpected command: ${command}`);
    },
    killProcess: (pid, signal) => {
      killed.push({ pid, signal });
    },
    isProcessAlive: (pid) => pid === 49000,
    sleep: async () => {},
    healthCheck: async () => true,
    loadHeartbeatState: () => ({ pid: 49000, status: 'running' }),
    spawnProcess: (command, args, options) => {
      spawned.push({ command, args, options });
      return {
        pid: 49000,
        unref() {}
      };
    }
  });

  assert.deepEqual(killed, [
    { pid: 47069, signal: 'SIGTERM' }
  ]);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, process.execPath);
  assert.deepEqual(spawned[0].args, ['--experimental-sqlite', 'src/cli.js']);
  assert.equal(spawned[0].options.cwd, '/Users/song/projects/intent-broker');
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.windowsHide, false);
  assert.equal(result.started, true);
  assert.equal(result.ready, true);
  assert.equal(result.pid, 49000);
});

test('startBroker redirects broker output to log files and passes a heartbeat path', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'intent-broker-start-'));
  const spawned = [];

  const result = startBroker({
    repoRoot,
    nodePath: '/opt/homebrew/bin/node',
    platform: 'win32',
    spawnProcess: (command, args, options) => {
      spawned.push({ command, args, options });
      return {
        pid: 49000,
        unref() {}
      };
    }
  });

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.windowsHide, true);
  assert.ok(Array.isArray(spawned[0].options.stdio));
  assert.equal(spawned[0].options.stdio.length, 3);
  assert.equal(
    spawned[0].options.env.INTENT_BROKER_HEARTBEAT_PATH,
    result.heartbeatPath
  );
  assert.equal(
    result.logPaths.stdout,
    path.join(repoRoot, '.tmp', 'broker.stdout.log')
  );
  assert.equal(
    result.logPaths.stderr,
    path.join(repoRoot, '.tmp', 'broker.stderr.log')
  );
  statSync(result.logPaths.stdout);
  statSync(result.logPaths.stderr);
});

test('startBroker marks a dead running heartbeat stopped before spawning', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'intent-broker-start-'));
  const savedHeartbeats = [];

  const result = startBroker({
    repoRoot,
    nodePath: '/opt/homebrew/bin/node',
    isProcessAlive: (pid) => pid !== 47069,
    loadHeartbeatState: () => ({
      pid: 47069,
      status: 'running',
      startedAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:01.000Z'
    }),
    saveHeartbeatState: (heartbeatPath, state, options) => {
      savedHeartbeats.push({ heartbeatPath, state, options });
      return true;
    },
    now: () => new Date('2026-06-01T00:00:02.000Z'),
    spawnProcess: () => ({
      pid: 49000,
      unref() {}
    })
  });

  assert.equal(result.pid, 49000);
  assert.equal(savedHeartbeats.length, 1);
  assert.ok(savedHeartbeats[0].heartbeatPath.endsWith(path.join('.tmp', 'broker.heartbeat.json')));
  assert.deepEqual(savedHeartbeats[0].options, { onlyIfOwnedByPid: 47069 });
  assert.equal(savedHeartbeats[0].state.status, 'stopped');
  assert.equal(savedHeartbeats[0].state.exitAt, '2026-06-01T00:00:02.000Z');
});

test('restartBroker waits for broker health and a running heartbeat before reporting ready', async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'intent-broker-restart-'));
  const heartbeatPath = path.join(repoRoot, '.tmp', 'broker.heartbeat.json');
  let lsofCalls = 0;
  let healthChecks = 0;

  const result = await restartBroker({
    repoRoot,
    platform: 'darwin',
    port: 4318,
    termWaitMs: 1,
    startWaitMs: 10,
    killWaitMs: 1,
    intervalMs: 1,
    runCommand: ({ command, args }) => {
      if (command === 'lsof') {
        lsofCalls += 1;
        return lsofCalls === 1 ? '47069\n' : '49000\n';
      }
      if (command === 'ps') {
        const pid = Number(args[1]);
        return pid === 47069
          ? 'node --experimental-sqlite src/cli.js'
          : '/opt/homebrew/bin/node --experimental-sqlite src/cli.js';
      }
      throw new Error(`unexpected command: ${command}`);
    },
    killProcess: () => {},
    isProcessAlive: (pid) => pid === 49000,
    sleep: async () => {
      if (healthChecks === 1) {
        writeFileSync(heartbeatPath, JSON.stringify({
          pid: 49000,
          status: 'running',
          updatedAt: '2026-04-04T00:00:00.000Z'
        }));
      }
    },
    spawnProcess: () => ({
      pid: 49000,
      unref() {}
    }),
    healthCheck: async () => {
      healthChecks += 1;
      return healthChecks >= 2;
    }
  });

  assert.equal(result.ready, true);
  assert.equal(healthChecks, 2);
});
