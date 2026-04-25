import { execFileSync, spawn as spawnDefault } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveRuntimeStatePath, resolveToolStateRoot } from '../hook-installer-core/state-paths.js';
import {
  registerParticipant as registerParticipantDefault,
  updatePresence as updatePresenceDefault
} from './api.js';
import { applyRuntimeMetadataToConfig, deriveSessionBridgeConfig } from './config.js';
import { acquireInterprocessLock } from './interprocess-lock.js';
import { loadRuntimeState } from './runtime-state.js';

const DEFAULT_INTERVAL_MS = 30000;
const SHELL_PROCESS_NAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
const WINDOWS_WRAPPER_PROCESS_NAMES = new Set([
  'cmd.exe',
  'conhost.exe',
  'powershell.exe',
  'pwsh.exe',
  'wscript.exe',
  'cscript.exe'
]);

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isProcessAlive(pid) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function normalizeProcessName(value) {
  return String(value || '').trim().toLowerCase();
}

function lookupWindowsProcessInfo(pid, { execFileSyncImpl = execFileSync } = {}) {
  try {
    const json = execFileSyncImpl(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        [
          '$ErrorActionPreference = "Stop"',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}"`,
          'if (-not $p) { return }',
          '$p | Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Compress'
        ].join('; ')
      ],
      { encoding: 'utf8' }
    ).trim();

    if (!json) {
      return null;
    }

    const parsed = JSON.parse(json);
    return {
      pid: normalizePid(parsed?.ProcessId),
      parentPid: normalizePid(parsed?.ParentProcessId),
      name: normalizeProcessName(parsed?.Name),
      commandLine: typeof parsed?.CommandLine === 'string' ? parsed.CommandLine : ''
    };
  } catch {
    return null;
  }
}

function shouldSkipWindowsObservedParent(info) {
  if (!info?.pid) {
    return false;
  }

  if (WINDOWS_WRAPPER_PROCESS_NAMES.has(info.name)) {
    return true;
  }

  return info.name === 'node.exe'
    && /codex-broker\.js.+hook\b/i.test(info.commandLine || '');
}

export function resolveObservedParentPid(
  parentPid = process.ppid,
  { execFileSyncImpl = execFileSync, platform = process.platform } = {}
) {
  const normalizedParentPid = normalizePid(parentPid);
  if (!normalizedParentPid) {
    return null;
  }

  if (platform === 'win32') {
    let currentPid = normalizedParentPid;
    const seen = new Set();

    while (currentPid && !seen.has(currentPid)) {
      seen.add(currentPid);
      const info = lookupWindowsProcessInfo(currentPid, { execFileSyncImpl });

      if (!info) {
        return null;
      }

      if (!shouldSkipWindowsObservedParent(info)) {
        return info.pid;
      }

      currentPid = info.parentPid;
    }

    return null;
  }

  try {
    const commandName = execFileSyncImpl(
      'ps',
      ['-o', 'comm=', '-p', String(normalizedParentPid)],
      { encoding: 'utf8' }
    )
      .trim()
      .split('/')
      .pop()
      ?.toLowerCase();

    if (!commandName || !SHELL_PROCESS_NAMES.has(commandName)) {
      return normalizedParentPid;
    }

    const parentOfShell = normalizePid(
      execFileSyncImpl(
        'ps',
        ['-o', 'ppid=', '-p', String(normalizedParentPid)],
        { encoding: 'utf8' }
      ).trim()
    );

    return parentOfShell || normalizedParentPid;
  } catch {
    return normalizedParentPid;
  }
}

export function resolveSessionKeeperStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return path.join(resolveToolStateRoot(toolName, { homeDir }), `${participantId}.keeper.json`);
}

function readKeeperState(statePath) {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function removeKeeperState(statePath) {
  rmSync(statePath, { force: true });
}

function listSiblingKeeperStatePaths(toolName, currentStatePath, { homeDir = os.homedir() } = {}) {
  const stateRoot = resolveToolStateRoot(toolName, { homeDir });

  try {
    return readdirSync(stateRoot)
      .filter((name) => name.endsWith('.keeper.json'))
      .map((name) => path.join(stateRoot, name))
      .filter((candidatePath) => candidatePath !== currentStatePath);
  } catch {
    return [];
  }
}

function pruneSiblingKeepersForParentPid({
  toolName,
  homeDir = os.homedir(),
  statePath,
  parentPid,
  killImpl,
  isProcessAlive: isProcessAliveImpl
} = {}) {
  const normalizedParentPid = normalizePid(parentPid);
  if (!normalizedParentPid) {
    return [];
  }

  const removed = [];

  for (const siblingStatePath of listSiblingKeeperStatePaths(toolName, statePath, { homeDir })) {
    const sibling = readKeeperState(siblingStatePath);
    if (normalizePid(sibling?.parentPid) !== normalizedParentPid) {
      continue;
    }

    const siblingPid = normalizePid(sibling?.pid);
    if (siblingPid && isProcessAliveImpl(siblingPid)) {
      try {
        killImpl(siblingPid);
      } catch {
        // best effort only
      }
    }

    removeKeeperState(siblingStatePath);
    removed.push({ statePath: siblingStatePath, pid: siblingPid });
  }

  return removed;
}

export async function ensureSessionKeeper({
  toolName,
  cliPath,
  config,
  sessionId,
  cwd = process.cwd(),
  env = process.env,
  homeDir = os.homedir(),
  parentPid = process.ppid,
  intervalMs = DEFAULT_INTERVAL_MS,
  nodePath = process.execPath,
  spawnImpl = spawnDefault,
  killImpl = process.kill.bind(process),
  isProcessAlive: isProcessAliveImpl = isProcessAlive
} = {}) {
  if (!cliPath) {
    throw new Error('cliPath is required');
  }

  const statePath = resolveSessionKeeperStatePath(toolName, config.participantId, { homeDir });
  mkdirSync(path.dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  const desiredInboxMode = config.inboxMode || 'pull';
  const normalizedParentPid = normalizePid(parentPid);
  let releaseLock = null;

  try {
    releaseLock = await acquireInterprocessLock(lockPath, {
      isProcessAlive: isProcessAliveImpl
    });
  } catch (error) {
    const waitingExisting = readKeeperState(statePath);
    if (waitingExisting?.pid && isProcessAliveImpl(waitingExisting.pid)) {
      return {
        started: false,
        pid: waitingExisting.pid,
        statePath
      };
    }
    throw error;
  }

  try {
    const existing = readKeeperState(statePath);
    const sameBrokerUrl = existing?.brokerUrl === config.brokerUrl;
    const sameParentPid = normalizedParentPid
      ? normalizePid(existing?.parentPid) === normalizedParentPid
      : true;
    if (
      existing?.sessionId === sessionId &&
      existing?.inboxMode === desiredInboxMode &&
      sameBrokerUrl &&
      sameParentPid &&
      existing?.pid &&
      isProcessAliveImpl(existing.pid)
    ) {
      return {
        started: false,
        pid: existing.pid,
        statePath
      };
    }

    if (
      existing?.sessionId === sessionId &&
      existing?.pid &&
      isProcessAliveImpl(existing.pid) &&
      (existing?.inboxMode !== desiredInboxMode || !sameBrokerUrl || !sameParentPid)
    ) {
      try {
        killImpl(existing.pid);
      } catch {
        // best effort only
      }
      removeKeeperState(statePath);
    }

    if (existing?.pid && !isProcessAliveImpl(existing.pid)) {
      removeKeeperState(statePath);
    }

    pruneSiblingKeepersForParentPid({
      toolName,
      homeDir,
      statePath,
      parentPid: normalizedParentPid,
      killImpl,
      isProcessAlive: isProcessAliveImpl
    });

    const child = spawnImpl(nodePath, [cliPath, 'keepalive'], {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: process.platform === 'win32',
      env: {
        ...env,
        BROKER_URL: config.brokerUrl,
        PARTICIPANT_ID: config.participantId,
        ALIAS: config.alias,
        PROJECT_NAME: config.context?.projectName || '',
        INTENT_BROKER_INBOX_MODE: desiredInboxMode,
        INTENT_BROKER_KEEPALIVE_PARENT_PID: String(parentPid || ''),
        INTENT_BROKER_KEEPALIVE_INTERVAL_MS: String(intervalMs),
        INTENT_BROKER_KEEPALIVE_STATE_PATH: statePath,
        INTENT_BROKER_KEEPALIVE_SESSION_ID: sessionId || '',
        INTENT_BROKER_KEEPALIVE_TOOL_NAME: toolName
      }
    });

    child.unref?.();

    writeFileSync(statePath, JSON.stringify({
      pid: child.pid,
      sessionId: sessionId || '',
      inboxMode: desiredInboxMode,
      brokerUrl: config.brokerUrl,
      parentPid: normalizedParentPid,
      startedAt: new Date().toISOString()
    }, null, 2));

    return {
      started: true,
      pid: child.pid,
      statePath
    };
  } finally {
    releaseLock?.();
  }
}

export async function runSessionKeeperIteration({
  config,
  parentPid,
  isProcessAlive: isProcessAliveImpl = isProcessAlive,
  registerParticipant = registerParticipantDefault,
  updatePresence = updatePresenceDefault
} = {}) {
  const normalizedParentPid = normalizePid(parentPid);

  if (normalizedParentPid && !isProcessAliveImpl(normalizedParentPid)) {
    try {
      await updatePresence(config, 'offline', {
        source: 'session-keeper',
        reason: 'parent-exit',
        parentPid: normalizedParentPid
      });
    } catch {
      // best effort only
    }
    return false;
  }

  try {
    await registerParticipant(config);
  } catch {
    // Broker might be restarting; keep retrying in the background.
  }

  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runSessionKeeperProcess({
  toolName,
  cwd = process.cwd(),
  env = process.env,
  statePath = env.INTENT_BROKER_KEEPALIVE_STATE_PATH,
  intervalMs = Number(env.INTENT_BROKER_KEEPALIVE_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  parentPid = env.INTENT_BROKER_KEEPALIVE_PARENT_PID,
  registerParticipant = registerParticipantDefault,
  updatePresence = updatePresenceDefault,
  isProcessAlive: isProcessAliveImpl = isProcessAlive,
  sleepImpl = sleep
} = {}) {
  if (!toolName) {
    throw new Error('toolName is required');
  }

  const baseConfig = deriveSessionBridgeConfig({ toolName, env, cwd });
  const runtimeStatePath = resolveRuntimeStatePath(toolName, baseConfig.participantId, { homeDir: os.homedir() });
  const config = applyRuntimeMetadataToConfig(baseConfig, loadRuntimeState(runtimeStatePath));
  if (statePath) {
    mkdirSync(path.dirname(statePath), { recursive: true });
    const desiredInboxMode = config.inboxMode || 'pull';
    writeFileSync(statePath, JSON.stringify({
      pid: process.pid,
      sessionId: env.INTENT_BROKER_KEEPALIVE_SESSION_ID || '',
      inboxMode: desiredInboxMode,
      brokerUrl: config.brokerUrl,
      parentPid: normalizePid(parentPid),
      startedAt: new Date().toISOString()
    }, null, 2));
  }

  try {
    while (await runSessionKeeperIteration({
      config,
      parentPid,
      isProcessAlive: isProcessAliveImpl,
      registerParticipant,
      updatePresence
    })) {
      await sleepImpl(intervalMs);
    }
  } finally {
    if (statePath) {
      const current = readKeeperState(statePath);
      if (current?.pid === process.pid) {
        removeKeeperState(statePath);
      }
    }
  }
}
