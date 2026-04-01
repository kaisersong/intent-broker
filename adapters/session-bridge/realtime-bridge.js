import { spawn as spawnDefault } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import {
  resolveRealtimeBridgeStatePath,
  resolveRealtimeQueueStatePath
} from '../hook-installer-core/state-paths.js';
import { registerParticipant as registerParticipantDefault } from './api.js';
import { deriveSessionBridgeConfig } from './config.js';
import { isProcessAlive } from './session-keeper.js';

const DEFAULT_RETRY_MS = 2000;

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readProcessState(statePath) {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function removeProcessState(statePath) {
  rmSync(statePath, { force: true });
}

function normalizeQueueState(state) {
  return {
    actionable: Array.isArray(state?.actionable) ? state.actionable : [],
    informational: Array.isArray(state?.informational) ? state.informational : [],
    lastEventId: Number(state?.lastEventId || 0)
  };
}

function hasEvent(state, eventId) {
  return state.actionable.some((item) => item.eventId === eventId)
    || state.informational.some((item) => item.eventId === eventId);
}

export function createRealtimeQueueState() {
  return {
    actionable: [],
    informational: [],
    lastEventId: 0
  };
}

export function loadRealtimeQueueState(statePath) {
  try {
    return normalizeQueueState(JSON.parse(readFileSync(statePath, 'utf8')));
  } catch {
    return createRealtimeQueueState();
  }
}

export function saveRealtimeQueueState(statePath, state) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(normalizeQueueState(state), null, 2));
}

export function appendRealtimeEvent(state, event) {
  const normalized = normalizeQueueState(state);
  const eventId = Number(event?.eventId || 0);
  const nextLastEventId = Math.max(normalized.lastEventId, eventId);

  if (!eventId || hasEvent(normalized, eventId)) {
    return {
      ...normalized,
      lastEventId: nextLastEventId
    };
  }

  const semantic = event?.payload?.delivery?.semantic === 'actionable'
    ? 'actionable'
    : 'informational';

  return {
    ...normalized,
    [semantic]: [...normalized[semantic], event],
    lastEventId: nextLastEventId
  };
}

export async function ensureRealtimeBridge({
  toolName,
  cliPath,
  config,
  sessionId,
  cwd = process.cwd(),
  env = process.env,
  homeDir = os.homedir(),
  parentPid = process.ppid,
  retryMs = DEFAULT_RETRY_MS,
  nodePath = process.execPath,
  spawnImpl = spawnDefault,
  isProcessAlive: isProcessAliveImpl = isProcessAlive
} = {}) {
  if (!cliPath) {
    throw new Error('cliPath is required');
  }

  const statePath = resolveRealtimeBridgeStatePath(toolName, config.participantId, { homeDir });
  const queueStatePath = resolveRealtimeQueueStatePath(toolName, config.participantId, { homeDir });
  mkdirSync(path.dirname(statePath), { recursive: true });

  const existing = readProcessState(statePath);
  if (
    existing?.sessionId === sessionId &&
    existing?.pid &&
    isProcessAliveImpl(existing.pid)
  ) {
    return {
      started: false,
      pid: existing.pid,
      statePath,
      queueStatePath
    };
  }

  if (existing?.pid && !isProcessAliveImpl(existing.pid)) {
    removeProcessState(statePath);
  }

  const child = spawnImpl(nodePath, [cliPath, 'realtime-bridge'], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: {
      ...env,
      BROKER_URL: config.brokerUrl,
      PARTICIPANT_ID: config.participantId,
      ALIAS: config.alias,
      PROJECT_NAME: config.context?.projectName || '',
      INTENT_BROKER_REALTIME_PARENT_PID: String(parentPid || ''),
      INTENT_BROKER_REALTIME_RETRY_MS: String(retryMs),
      INTENT_BROKER_REALTIME_STATE_PATH: statePath,
      INTENT_BROKER_REALTIME_QUEUE_STATE_PATH: queueStatePath,
      INTENT_BROKER_REALTIME_SESSION_ID: sessionId || '',
      INTENT_BROKER_REALTIME_TOOL_NAME: toolName
    }
  });

  child.unref?.();

  writeFileSync(statePath, JSON.stringify({
    pid: child.pid,
    sessionId: sessionId || '',
    parentPid: parentPid || null,
    queueStatePath,
    startedAt: new Date().toISOString()
  }, null, 2));

  return {
    started: true,
    pid: child.pid,
    statePath,
    queueStatePath
  };
}

async function connectRealtimeSocket({
  config,
  queueStatePath,
  parentPid,
  isProcessAlive: isProcessAliveImpl = isProcessAlive,
  registerParticipant = registerParticipantDefault
} = {}) {
  try {
    await registerParticipant(config);
  } catch {
    // Broker may be starting up. The websocket attempt below will retry.
  }

  const wsUrl = `${config.brokerUrl.replace(/^http/, 'ws')}/ws?participantId=${encodeURIComponent(config.participantId)}`;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const socket = new WebSocket(wsUrl);
    const normalizedParentPid = normalizePid(parentPid);
    const parentWatcher = normalizedParentPid
      ? setInterval(() => {
        if (!isProcessAliveImpl(normalizedParentPid)) {
          socket.close();
        }
      }, 2000)
      : null;
    parentWatcher?.unref?.();

    socket.on('message', (buffer) => {
      let message;
      try {
        message = JSON.parse(buffer.toString());
      } catch {
        return;
      }

      if (message?.type !== 'new_intent' || !message.event) {
        return;
      }

      const current = loadRealtimeQueueState(queueStatePath);
      const next = appendRealtimeEvent(current, message.event);
      saveRealtimeQueueState(queueStatePath, next);
    });

    socket.on('error', () => {
      // Close will drive the reconnect loop.
    });
    socket.on('close', () => {
      if (parentWatcher) {
        clearInterval(parentWatcher);
      }
      finish();
    });
  });
}

export async function runRealtimeBridgeProcess({
  toolName,
  cwd = process.cwd(),
  env = process.env,
  statePath = env.INTENT_BROKER_REALTIME_STATE_PATH,
  queueStatePath = env.INTENT_BROKER_REALTIME_QUEUE_STATE_PATH,
  retryMs = Number(env.INTENT_BROKER_REALTIME_RETRY_MS || DEFAULT_RETRY_MS),
  parentPid = env.INTENT_BROKER_REALTIME_PARENT_PID,
  registerParticipant = registerParticipantDefault,
  isProcessAlive: isProcessAliveImpl = isProcessAlive,
  sleepImpl = sleep
} = {}) {
  if (!toolName) {
    throw new Error('toolName is required');
  }

  const config = deriveSessionBridgeConfig({ toolName, env, cwd });
  const resolvedQueueStatePath = queueStatePath
    || resolveRealtimeQueueStatePath(toolName, config.participantId, { homeDir: os.homedir() });

  saveRealtimeQueueState(resolvedQueueStatePath, loadRealtimeQueueState(resolvedQueueStatePath));

  if (statePath) {
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      pid: process.pid,
      sessionId: env.INTENT_BROKER_REALTIME_SESSION_ID || '',
      parentPid: normalizePid(parentPid),
      queueStatePath: resolvedQueueStatePath,
      startedAt: new Date().toISOString()
    }, null, 2));
  }

  try {
    while (!normalizePid(parentPid) || isProcessAliveImpl(parentPid)) {
      await connectRealtimeSocket({
        config,
        queueStatePath: resolvedQueueStatePath,
        parentPid,
        isProcessAlive: isProcessAliveImpl,
        registerParticipant
      });

      if (normalizePid(parentPid) && !isProcessAliveImpl(parentPid)) {
        break;
      }
      await sleepImpl(retryMs);
    }
  } finally {
    if (statePath) {
      const current = readProcessState(statePath);
      if (current?.pid === process.pid) {
        removeProcessState(statePath);
      }
    }
  }
}
