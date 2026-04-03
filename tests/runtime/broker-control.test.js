import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findBrokerProcesses,
  isBrokerCommand,
  restartBroker,
  stopBroker
} from '../../scripts/broker-control.js';

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

test('stopBroker sends SIGTERM first and escalates to SIGKILL only if needed', async () => {
  const killed = [];
  let forceKilled = false;

  const result = await stopBroker({
    port: 4318,
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
    sleep: async () => {}
  });

  assert.deepEqual(killed, [
    { pid: 47069, signal: 'SIGTERM' },
    { pid: 47069, signal: 'SIGKILL' }
  ]);
  assert.equal(result.stopped, true);
  assert.equal(result.forceKilled, true);
});

test('restartBroker stops an existing broker and starts a new detached process', async () => {
  const killed = [];
  const spawned = [];
  let lsofCalls = 0;

  const result = await restartBroker({
    repoRoot: '/Users/song/projects/intent-broker',
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
    isProcessAlive: () => false,
    sleep: async () => {},
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
  assert.equal(result.started, true);
  assert.equal(result.ready, true);
  assert.equal(result.pid, 49000);
});
