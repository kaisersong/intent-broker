#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';

import {
  loadBrokerHeartbeat,
  resolveBrokerRuntimePaths
} from '../src/runtime/broker-runtime-state.js';

export function isBrokerCommand(command = '') {
  return String(command).includes('src/cli.js');
}

function defaultRunCommand({ command, args }) {
  try {
    return execFileSync(command, args, { encoding: 'utf8' });
  } catch (error) {
    if (typeof error?.stdout === 'string') {
      return error.stdout;
    }
    return '';
  }
}

function parsePidList(output = '') {
  return String(output)
    .split(/\s+/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

export function findBrokerProcesses({
  port = 4318,
  runCommand = defaultRunCommand
} = {}) {
  const pids = parsePidList(
    runCommand({
      command: 'lsof',
      args: ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']
    })
  );

  return pids.flatMap((pid) => {
    const command = String(
      runCommand({
        command: 'ps',
        args: ['-p', String(pid), '-o', 'command=']
      })
    ).trim();

    if (!isBrokerCommand(command)) {
      return [];
    }

    return [{ pid, command }];
  });
}

function defaultKillProcess(pid, signal) {
  process.kill(pid, signal);
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilExited(pids, {
  timeoutMs,
  intervalMs,
  isProcessAlive,
  sleep
}) {
  const deadline = Date.now() + timeoutMs;
  let remaining = [...pids];

  while (remaining.length && Date.now() < deadline) {
    remaining = remaining.filter((pid) => isProcessAlive(pid));
    if (!remaining.length) {
      return [];
    }
    await sleep(intervalMs);
  }

  return remaining.filter((pid) => isProcessAlive(pid));
}

export async function stopBroker({
  port = 4318,
  termWaitMs = 3000,
  killWaitMs = 1000,
  intervalMs = 100,
  runCommand = defaultRunCommand,
  killProcess = defaultKillProcess,
  isProcessAlive = defaultIsProcessAlive,
  sleep = defaultSleep
} = {}) {
  const processes = findBrokerProcesses({ port, runCommand });
  const pids = processes.map((item) => item.pid);

  if (!pids.length) {
    return {
      found: false,
      stopped: false,
      forceKilled: false,
      pids: []
    };
  }

  for (const pid of pids) {
    killProcess(pid, 'SIGTERM');
  }

  let remaining = await waitUntilExited(pids, {
    timeoutMs: termWaitMs,
    intervalMs,
    isProcessAlive,
    sleep
  });

  let forceKilled = false;
  if (remaining.length) {
    forceKilled = true;
    for (const pid of remaining) {
      killProcess(pid, 'SIGKILL');
    }
    remaining = await waitUntilExited(remaining, {
      timeoutMs: killWaitMs,
      intervalMs,
      isProcessAlive,
      sleep
    });
  }

  return {
    found: true,
    stopped: remaining.length === 0,
    forceKilled,
    pids
  };
}

function defaultSpawnProcess(command, args, options) {
  return spawn(command, args, options);
}

async function defaultHealthCheck({ port }) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) {
      return false;
    }

    const payload = await response.json();
    return payload?.ok === true;
  } catch {
    return false;
  }
}

export function startBroker({
  repoRoot = process.cwd(),
  nodePath = process.execPath,
  env = process.env,
  spawnProcess = defaultSpawnProcess
} = {}) {
  const runtimePaths = resolveBrokerRuntimePaths({ cwd: repoRoot, env });
  mkdirSync(path.dirname(runtimePaths.stdout), { recursive: true });
  const stdoutFd = openSync(runtimePaths.stdout, 'a');
  const stderrFd = openSync(runtimePaths.stderr, 'a');

  let child;
  try {
    child = spawnProcess(
      nodePath,
      ['--experimental-sqlite', 'src/cli.js'],
      {
        cwd: repoRoot,
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        env: {
          ...env,
          INTENT_BROKER_HEARTBEAT_PATH: runtimePaths.heartbeat
        }
      }
    );
    child.unref?.();
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  return {
    started: true,
    pid: child.pid,
    logPaths: {
      stdout: runtimePaths.stdout,
      stderr: runtimePaths.stderr
    },
    heartbeatPath: runtimePaths.heartbeat
  };
}

async function waitUntilBrokerReady({
  port,
  pid,
  heartbeatPath,
  startWaitMs,
  intervalMs,
  sleep,
  isProcessAlive,
  healthCheck,
  loadHeartbeatState
}) {
  const deadline = Date.now() + startWaitMs;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return false;
    }

    const [healthy, heartbeat] = await Promise.all([
      healthCheck({ port, pid }),
      Promise.resolve(loadHeartbeatState(heartbeatPath))
    ]);

    if (
      healthy
      && heartbeat?.pid === pid
      && heartbeat?.status === 'running'
    ) {
      return true;
    }
    await sleep(intervalMs);
  }

  return false;
}

export async function restartBroker(options = {}) {
  const stopResult = await stopBroker(options);
  const startResult = startBroker(options);
  const ready = await waitUntilBrokerReady({
    port: options.port ?? 4318,
    pid: startResult.pid,
    heartbeatPath: startResult.heartbeatPath,
    startWaitMs: options.startWaitMs ?? 3000,
    intervalMs: options.intervalMs ?? 100,
    sleep: options.sleep ?? defaultSleep,
    isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
    healthCheck: options.healthCheck ?? defaultHealthCheck,
    loadHeartbeatState: options.loadHeartbeatState ?? loadBrokerHeartbeat
  });

  return {
    ...startResult,
    ready,
    previous: stopResult
  };
}

export function statusBroker({
  repoRoot = process.cwd(),
  port = 4318,
  env = process.env,
  runCommand = defaultRunCommand,
  loadHeartbeatState = loadBrokerHeartbeat
} = {}) {
  const processes = findBrokerProcesses({ port, runCommand });
  const runtimePaths = resolveBrokerRuntimePaths({ cwd: repoRoot, env });
  return {
    running: processes.length > 0,
    port,
    processes,
    heartbeat: loadHeartbeatState(runtimePaths.heartbeat),
    logPaths: {
      stdout: runtimePaths.stdout,
      stderr: runtimePaths.stderr
    }
  };
}

function usage() {
  console.log(`Usage:
  node scripts/broker-control.js status
  node scripts/broker-control.js stop
  node scripts/broker-control.js restart`);
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];

  switch (command) {
    case 'status':
      console.log(JSON.stringify(statusBroker(), null, 2));
      return;
    case 'stop':
      console.log(JSON.stringify(await stopBroker(), null, 2));
      return;
    case 'restart':
      console.log(JSON.stringify(await restartBroker(), null, 2));
      return;
    default:
      usage();
      process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
