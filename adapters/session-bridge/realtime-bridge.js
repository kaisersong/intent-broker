import { execFile as execFileCallback, spawn as spawnDefault } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';

import {
  resolveParticipantStatePath,
  resolveRealtimeBridgeStatePath,
  resolveRealtimeQueueStatePath,
  resolveRuntimeStatePath
} from '../hook-installer-core/state-paths.js';
import {
  ackInbox as ackInboxDefault,
  registerParticipant as registerParticipantDefault,
  sendProgress as sendProgressDefault,
  updateWorkState as updateWorkStateDefault
} from './api.js';
import {
  buildAutomaticWorkState,
  pickActiveWorkContext
} from './automatic-work-state.js';
import { deriveSessionBridgeConfig } from './config.js';
import {
  buildClaudeAutoContinuePrompt,
  buildCodexAutoContinuePrompt,
  highestEventId
} from './codex-hooks.js';
import { pickRecentContext } from './recent-context.js';
import { markPendingReplyMirror as markPendingReplyMirrorDefault } from './reply-mirror.js';
import { isProcessAlive } from './session-keeper.js';
import {
  loadCursorState as loadCursorStateDefault,
  saveCursorState as saveCursorStateDefault
} from './state.js';
import {
  loadRuntimeState as loadRuntimeStateDefault,
  saveRuntimeState as saveRuntimeStateDefault
} from './runtime-state.js';

const DEFAULT_RETRY_MS = 2000;
const DEFAULT_CLAUDE_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_CLAUDE_AUTO_DISPATCH_STALE_MS = 30 * 1000;
const execFileDefault = promisify(execFileCallback);

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

function parseTimestampMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
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

export function drainRealtimeQueue(state) {
  const normalized = normalizeQueueState(state);
  const items = [...normalized.actionable, ...normalized.informational]
    .sort((left, right) => Number(left?.eventId || 0) - Number(right?.eventId || 0));

  return {
    items,
    state: {
      actionable: [],
      informational: [],
      lastEventId: normalized.lastEventId
    }
  };
}

function restoreRealtimeQueue(state, items = []) {
  return [...items]
    .sort((left, right) => Number(left?.eventId || 0) - Number(right?.eventId || 0))
    .reduce((current, item) => appendRealtimeEvent(current, item), normalizeQueueState(state));
}

function shouldRecoverStaleAutoDispatchRuntime(toolName, runtimeState, staleMs) {
  if (toolName !== 'claude-code') {
    return false;
  }
  if (runtimeState?.status !== 'running' || runtimeState?.source !== 'auto-dispatch') {
    return false;
  }

  const updatedAtMs = parseTimestampMs(runtimeState.updatedAt);
  if (updatedAtMs === null) {
    return true;
  }

  return Date.now() - updatedAtMs >= staleMs;
}

function buildAutoDispatchPrompt(toolName, items, participantId) {
  if (toolName === 'codex') {
    return buildCodexAutoContinuePrompt(items, { participantId });
  }

  if (toolName === 'claude-code') {
    return buildClaudeAutoContinuePrompt(items, { participantId });
  }

  return null;
}

function normalizeAutoDispatchReply(output) {
  const text = String(output || '').trim();
  if (!text || text === 'NO_REPLY') {
    return null;
  }

  return text;
}

export async function maybeAutoDispatchRealtimeQueue({
  toolName,
  config,
  sessionId,
  cwd = process.cwd(),
  env = process.env,
  queueStatePath,
  cursorStatePath,
  runtimeStatePath,
  spawnImpl = spawnDefault,
  execFileImpl = execFileDefault,
  ackInbox = ackInboxDefault,
  sendProgress = sendProgressDefault,
  updateWorkState = updateWorkStateDefault,
  markPendingReplyMirror = markPendingReplyMirrorDefault,
  loadRealtimeQueueState: loadRealtimeQueueStateImpl = loadRealtimeQueueState,
  saveRealtimeQueueState: saveRealtimeQueueStateImpl = saveRealtimeQueueState,
  loadCursorState = loadCursorStateDefault,
  saveCursorState = saveCursorStateDefault,
  loadRuntimeState = loadRuntimeStateDefault,
  saveRuntimeState = saveRuntimeStateDefault
} = {}) {
  if (toolName !== 'codex' && toolName !== 'claude-code') {
    return { dispatched: false, reason: 'unsupported-tool' };
  }
  if (env.INTENT_BROKER_DISABLE_AUTO_DISPATCH === '1') {
    return { dispatched: false, reason: 'disabled' };
  }
  if (!sessionId) {
    return { dispatched: false, reason: 'missing-session' };
  }

  const staleAutoDispatchMs = Number(
    env.INTENT_BROKER_CLAUDE_AUTO_DISPATCH_STALE_MS || DEFAULT_CLAUDE_AUTO_DISPATCH_STALE_MS
  );
  const runtimeState = loadRuntimeState(runtimeStatePath);
  if (runtimeState.status !== 'idle') {
    if (!shouldRecoverStaleAutoDispatchRuntime(toolName, runtimeState, staleAutoDispatchMs)) {
      return { dispatched: false, reason: 'busy' };
    }

    saveRuntimeState(runtimeStatePath, {
      status: 'idle',
      sessionId: runtimeState.sessionId || sessionId,
      turnId: null,
      source: 'auto-dispatch-recovered',
      taskId: null,
      threadId: null,
      updatedAt: new Date().toISOString()
    });
    await updateWorkState(
      config,
      buildAutomaticWorkState('idle')
    ).catch(() => null);
  }

  const queueState = loadRealtimeQueueStateImpl(queueStatePath);
  if (!queueState.actionable.length) {
    return { dispatched: false, reason: 'no-actionable' };
  }

  const drainedQueue = drainRealtimeQueue(queueState);
  const cursorState = loadCursorState(cursorStatePath);
  const recentContext = pickRecentContext(drainedQueue.items) || cursorState.recentContext;
  const activeContext = pickActiveWorkContext(drainedQueue.items, recentContext);
  const prompt = buildAutoDispatchPrompt(toolName, drainedQueue.items, config.participantId);

  if (!prompt) {
    return { dispatched: false, reason: 'empty-prompt' };
  }

  const lastSeenEventId = highestEventId(drainedQueue.items);
  if (lastSeenEventId) {
    await ackInbox(config, lastSeenEventId);
  }
  saveCursorState(cursorStatePath, {
    lastSeenEventId: Math.max(cursorState.lastSeenEventId, lastSeenEventId),
    recentContext
  });
  saveRealtimeQueueStateImpl(queueStatePath, drainedQueue.state);
  saveRuntimeState(runtimeStatePath, {
    status: 'running',
    sessionId,
    turnId: null,
    source: 'auto-dispatch',
    taskId: activeContext?.taskId || null,
    threadId: activeContext?.threadId || null,
    updatedAt: new Date().toISOString()
  });
  await updateWorkState(
    config,
    buildAutomaticWorkState('implementing', activeContext)
  ).catch(() => null);

  if (toolName === 'codex') {
    if (recentContext?.fromParticipantId && recentContext?.taskId && recentContext?.threadId) {
      markPendingReplyMirror('codex', config.participantId, {
        sessionId,
        autoMirror: true,
        recentContext
      });
    }

    const child = spawnImpl(
      env.INTENT_BROKER_CODEX_COMMAND || 'codex',
      ['exec', '--json', '--full-auto', '--skip-git-repo-check', 'resume', sessionId, prompt],
      {
        cwd,
        detached: true,
        stdio: 'ignore',
        env: {
          ...env,
          INTENT_BROKER_SKIP_INBOX_SYNC: '1'
        }
      }
    );
    child.unref?.();

    return {
      dispatched: true,
      pid: child.pid,
      lastSeenEventId
    };
  }

  try {
    const { stdout } = await execFileImpl(
      env.INTENT_BROKER_CLAUDE_COMMAND || 'claude',
      ['--resume', sessionId, '--print', prompt],
      {
        cwd,
        env: {
          ...env,
          INTENT_BROKER_SKIP_INBOX_SYNC: '1'
        },
        encoding: 'utf8',
        maxBuffer: DEFAULT_CLAUDE_MAX_BUFFER
      }
    );

    const replySummary = normalizeAutoDispatchReply(stdout);
    if (replySummary && recentContext?.fromParticipantId) {
      await sendProgress(config, {
        intentId: `${config.participantId}-auto-reply-${lastSeenEventId}`,
        taskId: activeContext?.taskId || recentContext.taskId,
        threadId: activeContext?.threadId || recentContext.threadId,
        toParticipantId: recentContext.fromParticipantId,
        summary: replySummary,
        metadata: recentContext.metadata || undefined
      }).catch(() => null);
    }

    return {
      dispatched: true,
      pid: null,
      lastSeenEventId
    };
  } catch (error) {
    saveRealtimeQueueStateImpl(
      queueStatePath,
      restoreRealtimeQueue(loadRealtimeQueueStateImpl(queueStatePath), drainedQueue.items)
    );

    return {
      dispatched: false,
      reason: 'dispatch-failed',
      lastSeenEventId,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    saveRuntimeState(runtimeStatePath, {
      status: 'idle',
      sessionId,
      turnId: null,
      source: 'auto-dispatch-complete',
      taskId: null,
      threadId: null,
      updatedAt: new Date().toISOString()
    });
    await updateWorkState(
      config,
      buildAutomaticWorkState('idle')
    ).catch(() => null);
  }

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
  killImpl = process.kill.bind(process),
  isProcessAlive: isProcessAliveImpl = isProcessAlive
} = {}) {
  if (!cliPath) {
    throw new Error('cliPath is required');
  }

  const statePath = resolveRealtimeBridgeStatePath(toolName, config.participantId, { homeDir });
  const queueStatePath = resolveRealtimeQueueStatePath(toolName, config.participantId, { homeDir });
  mkdirSync(path.dirname(statePath), { recursive: true });
  const desiredInboxMode = config.inboxMode || 'pull';
  const normalizedParentPid = normalizePid(parentPid);

  const existing = readProcessState(statePath);
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
      statePath,
      queueStatePath
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
    removeProcessState(statePath);
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
      INTENT_BROKER_INBOX_MODE: desiredInboxMode,
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
    inboxMode: desiredInboxMode,
    brokerUrl: config.brokerUrl,
    parentPid: normalizedParentPid,
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
  toolName,
  config,
  queueStatePath,
  cursorStatePath,
  runtimeStatePath,
  sessionId,
  cwd = process.cwd(),
  env = process.env,
  parentPid,
  isProcessAlive: isProcessAliveImpl = isProcessAlive,
  registerParticipant = registerParticipantDefault,
  ackInbox = ackInboxDefault,
  spawnImpl = spawnDefault,
  loadCursorState = loadCursorStateDefault,
  saveCursorState = saveCursorStateDefault,
  loadRuntimeState = loadRuntimeStateDefault,
  saveRuntimeState = saveRuntimeStateDefault
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
      void maybeAutoDispatchRealtimeQueue({
        toolName,
        config,
        sessionId,
        cwd,
        env,
        queueStatePath,
        cursorStatePath,
        runtimeStatePath,
        spawnImpl,
        ackInbox,
        loadRealtimeQueueState: loadRealtimeQueueState,
        saveRealtimeQueueState: saveRealtimeQueueState,
        loadCursorState,
        saveCursorState,
        loadRuntimeState,
        saveRuntimeState
      }).catch(() => null);
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
  ackInbox = ackInboxDefault,
  isProcessAlive: isProcessAliveImpl = isProcessAlive,
  spawnImpl = spawnDefault,
  loadCursorState = loadCursorStateDefault,
  saveCursorState = saveCursorStateDefault,
  loadRuntimeState = loadRuntimeStateDefault,
  saveRuntimeState = saveRuntimeStateDefault,
  sleepImpl = sleep
} = {}) {
  if (!toolName) {
    throw new Error('toolName is required');
  }

  const config = deriveSessionBridgeConfig({ toolName, env, cwd });
  const resolvedQueueStatePath = queueStatePath
    || resolveRealtimeQueueStatePath(toolName, config.participantId, { homeDir: os.homedir() });
  const cursorStatePath = resolveParticipantStatePath(toolName, config.participantId, { homeDir: os.homedir() });
  const runtimeStatePath = resolveRuntimeStatePath(toolName, config.participantId, { homeDir: os.homedir() });

  saveRealtimeQueueState(resolvedQueueStatePath, loadRealtimeQueueState(resolvedQueueStatePath));
  await maybeAutoDispatchRealtimeQueue({
    toolName,
    config,
    sessionId: env.INTENT_BROKER_REALTIME_SESSION_ID || '',
    cwd,
    env,
    queueStatePath: resolvedQueueStatePath,
    cursorStatePath,
    runtimeStatePath,
    spawnImpl,
    ackInbox,
    loadRealtimeQueueState: loadRealtimeQueueState,
    saveRealtimeQueueState: saveRealtimeQueueState,
    loadCursorState,
    saveCursorState,
    loadRuntimeState,
    saveRuntimeState
  }).catch(() => null);

  if (statePath) {
    mkdirSync(path.dirname(statePath), { recursive: true });
    const desiredInboxMode = config.inboxMode || 'pull';
    writeFileSync(statePath, JSON.stringify({
      pid: process.pid,
      sessionId: env.INTENT_BROKER_REALTIME_SESSION_ID || '',
      inboxMode: desiredInboxMode,
      brokerUrl: config.brokerUrl,
      parentPid: normalizePid(parentPid),
      queueStatePath: resolvedQueueStatePath,
      startedAt: new Date().toISOString()
    }, null, 2));
  }

  try {
    while (!normalizePid(parentPid) || isProcessAliveImpl(parentPid)) {
      await connectRealtimeSocket({
        toolName,
        config,
        queueStatePath: resolvedQueueStatePath,
        cursorStatePath,
        runtimeStatePath,
        sessionId: env.INTENT_BROKER_REALTIME_SESSION_ID || '',
        cwd,
        env,
        parentPid,
        isProcessAlive: isProcessAliveImpl,
        registerParticipant,
        ackInbox,
        spawnImpl,
        loadRealtimeQueueState: loadRealtimeQueueState,
        saveRealtimeQueueState: saveRealtimeQueueState,
        loadCursorState,
        saveCursorState,
        loadRuntimeState,
        saveRuntimeState
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
