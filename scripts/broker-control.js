#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  loadBrokerHeartbeat,
  resolveBrokerRuntimePaths,
  saveBrokerHeartbeat,
  isTerminalBrokerHeartbeatStatus
} from '../src/runtime/broker-runtime-state.js';

export function isBrokerCommand(command = '') {
  return String(command).includes('src/cli.js');
}

function defaultRunCommand({ command, args, options = {} }) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', ...options });
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

function parseWindowsNetstatPids(output = '', port = 4318) {
  const targetSuffix = `:${port}`;
  return uniqueNumbers(
    String(output)
      .split(/\r?\n/)
      .flatMap((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5 || parts[0] !== 'TCP' || parts[3] !== 'LISTENING') {
          return [];
        }
        if (!parts[1]?.endsWith(targetSuffix)) {
          return [];
        }
        const pid = Number(parts[4]);
        return Number.isInteger(pid) && pid > 0 ? [pid] : [];
      })
  );
}

function uniqueNumbers(values = []) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))];
}

function parseWindowsProcessJson(output = '') {
  if (!String(output || '').trim()) {
    return [];
  }
  const parsed = JSON.parse(output);
  const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return items
    .map((item) => ({
      pid: Number(item?.ProcessId),
      command: typeof item?.CommandLine === 'string' ? item.CommandLine : ''
    }))
    .filter((item) => Number.isInteger(item.pid) && item.pid > 0 && item.command);
}

export function findBrokerProcesses({
  port = 4318,
  runCommand = defaultRunCommand,
  platform = process.platform
} = {}) {
  if (platform === 'win32') {
    const pids = parseWindowsNetstatPids(
      runCommand({
        command: 'netstat',
        args: ['-ano', '-p', 'tcp']
      }),
      port
    );

    if (!pids.length) {
      return [];
    }

    const pidList = pids.join(',');
    const command = [
      '$ErrorActionPreference = "Stop";',
      `$pids = @(${pidList});`,
      'Get-CimInstance Win32_Process |',
      'Where-Object { $pids -contains $_.ProcessId } |',
      'Select-Object ProcessId,CommandLine |',
      'ConvertTo-Json -Compress'
    ].join(' ');

    return parseWindowsProcessJson(runCommand({
      command: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command],
      options: {
        encoding: 'utf8',
        windowsHide: true
      }
    })).filter((item) => isBrokerCommand(item.command));
  }

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

export function isBrokerControlEntrypoint({
  moduleUrl = import.meta.url,
  argv1 = process.argv[1]
} = {}) {
  return Boolean(argv1) && moduleUrl === pathToFileURL(path.resolve(argv1)).href;
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
  repoRoot = process.cwd(),
  port = 4318,
  env = process.env,
  termWaitMs = 3000,
  killWaitMs = 1000,
  intervalMs = 100,
  runCommand = defaultRunCommand,
  killProcess = defaultKillProcess,
  isProcessAlive = defaultIsProcessAlive,
  sleep = defaultSleep,
  platform = process.platform,
  loadHeartbeatState = loadBrokerHeartbeat,
  saveHeartbeatState = saveBrokerHeartbeat,
  now = () => new Date()
} = {}) {
  const processes = findBrokerProcesses({ port, runCommand, platform });
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

  const stopped = remaining.length === 0;
  if (stopped) {
    const runtimePaths = resolveBrokerRuntimePaths({ cwd: repoRoot, env });
    const heartbeat = loadHeartbeatState(runtimePaths.heartbeat);
    if (
      heartbeat?.pid
      && pids.includes(heartbeat.pid)
      && !isTerminalBrokerHeartbeatStatus(heartbeat.status)
    ) {
      const stoppedAt = now().toISOString();
      saveHeartbeatState(
        runtimePaths.heartbeat,
        {
          ...heartbeat,
          status: 'stopped',
          signal: forceKilled ? 'SIGKILL' : 'SIGTERM',
          exitAt: stoppedAt,
          updatedAt: stoppedAt
        },
        { onlyIfOwnedByPid: heartbeat.pid }
      );
    }
  }

  return {
    found: true,
    stopped,
    forceKilled,
    pids
  };
}

function defaultSpawnProcess(command, args, options) {
  return spawn(command, args, options);
}

function markStaleHeartbeatStopped({
  heartbeatPath,
  loadHeartbeatState,
  saveHeartbeatState,
  isProcessAlive,
  now
}) {
  const heartbeat = loadHeartbeatState(heartbeatPath);
  if (
    !heartbeat?.pid
    || isTerminalBrokerHeartbeatStatus(heartbeat.status)
    || isProcessAlive(heartbeat.pid)
  ) {
    return false;
  }

  const stoppedAt = now().toISOString();
  return saveHeartbeatState(
    heartbeatPath,
    {
      ...heartbeat,
      status: 'stopped',
      exitAt: stoppedAt,
      updatedAt: stoppedAt
    },
    { onlyIfOwnedByPid: heartbeat.pid }
  );
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

export function summarizeHeartbeat(heartbeat, processes = []) {
  if (!heartbeat) {
    return {
      state: 'missing',
      matchesRunningProcess: false,
      reason: 'heartbeat_missing'
    };
  }

  const runningPids = new Set(processes.map((item) => item.pid));
  const matchesRunningProcess = runningPids.has(heartbeat.pid);
  if (matchesRunningProcess && heartbeat.status === 'running') {
    return {
      state: 'fresh',
      matchesRunningProcess: true,
      reason: null
    };
  }

  if (matchesRunningProcess) {
    return {
      state: 'mismatch',
      matchesRunningProcess: true,
      reason: `heartbeat_status_${heartbeat.status || 'unknown'}`
    };
  }

  if (isTerminalBrokerHeartbeatStatus(heartbeat.status)) {
    return {
      state: 'stale',
      matchesRunningProcess: false,
      reason: `terminal_heartbeat_for_pid_${heartbeat.pid || 'unknown'}`
    };
  }

  return {
    state: 'stale',
    matchesRunningProcess: false,
    reason: `heartbeat_pid_${heartbeat.pid || 'unknown'}_not_listening`
  };
}

export function startBroker({
  repoRoot = process.cwd(),
  nodePath = process.execPath,
  env = process.env,
  spawnProcess = defaultSpawnProcess,
  isProcessAlive = defaultIsProcessAlive,
  loadHeartbeatState = loadBrokerHeartbeat,
  saveHeartbeatState = saveBrokerHeartbeat,
  now = () => new Date()
} = {}) {
  const runtimePaths = resolveBrokerRuntimePaths({ cwd: repoRoot, env });
  mkdirSync(path.dirname(runtimePaths.stdout), { recursive: true });
  markStaleHeartbeatStopped({
    heartbeatPath: runtimePaths.heartbeat,
    loadHeartbeatState,
    saveHeartbeatState,
    isProcessAlive,
    now
  });

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
  loadHeartbeatState = loadBrokerHeartbeat,
  platform = process.platform
} = {}) {
  const processes = findBrokerProcesses({ port, runCommand, platform });
  const runtimePaths = resolveBrokerRuntimePaths({ cwd: repoRoot, env });
  const heartbeat = loadHeartbeatState(runtimePaths.heartbeat);
  const heartbeatSummary = summarizeHeartbeat(heartbeat, processes);
  return {
    running: processes.length > 0,
    status: processes.length > 0
      ? (heartbeatSummary.state === 'stale' ? 'running_with_stale_heartbeat' : 'running')
      : 'stopped',
    port,
    processes,
    heartbeat,
    heartbeatSummary,
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

if (isBrokerControlEntrypoint()) {
  await main();
}
