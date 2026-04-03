import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ackInbox as ackInboxDefault,
  pollInbox as pollInboxDefault,
  registerParticipant as registerParticipantDefault,
  updateWorkState as updateWorkStateDefault
} from '../session-bridge/api.js';
import {
  buildToolHookContext,
  highestEventId
} from '../session-bridge/codex-hooks.js';
import { deriveSessionBridgeConfig } from '../session-bridge/config.js';
import { pickRecentContext } from '../session-bridge/recent-context.js';
import {
  loadCursorState as loadCursorStateDefault,
  saveCursorState as saveCursorStateDefault
} from '../session-bridge/state.js';
import {
  drainRealtimeQueue,
  ensureRealtimeBridge as ensureRealtimeBridgeDefault,
  loadRealtimeQueueState as loadRealtimeQueueStateDefault,
  saveRealtimeQueueState as saveRealtimeQueueStateDefault
} from '../session-bridge/realtime-bridge.js';
import {
  ensureSessionKeeper as ensureSessionKeeperDefault,
  resolveObservedParentPid
} from '../session-bridge/session-keeper.js';
import {
  resolveParticipantStatePath,
  resolveRealtimeQueueStatePath
} from '../hook-installer-core/state-paths.js';

const __filename = fileURLToPath(import.meta.url);
const cliPath = path.resolve(path.dirname(__filename), 'bin', 'claude-code-broker.js');

function configFromHookInput(input, { env = process.env, cwd = process.cwd() } = {}) {
  const sessionId = input.session_id || env.CLAUDE_CODE_SESSION_ID || '';
  return deriveSessionBridgeConfig({
    toolName: 'claude-code',
    env: {
      ...env,
      INTENT_BROKER_INBOX_MODE: env.INTENT_BROKER_INBOX_MODE || 'realtime',
      CLAUDE_CODE_SESSION_ID: sessionId
    },
    cwd
  });
}

function cursorPathForParticipant(participantId, homeDir) {
  return resolveParticipantStatePath('claude-code', participantId, { homeDir });
}

function queuePathForParticipant(participantId, homeDir) {
  return resolveRealtimeQueueStatePath('claude-code', participantId, { homeDir });
}

async function safelyRunHook(work) {
  try {
    return await work();
  } catch {
    return null;
  }
}

export async function runSessionStartHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    ensureSessionKeeper = ensureSessionKeeperDefault,
    ensureRealtimeBridge = ensureRealtimeBridgeDefault,
    loadCursorState = loadCursorStateDefault,
    registerParticipant = registerParticipantDefault,
    updateWorkState = updateWorkStateDefault,
    pollInbox = pollInboxDefault
  } = {}
) {
  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd });
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const state = loadCursorState(statePath);

    await ensureSessionKeeper({
      toolName: 'claude-code',
      cliPath,
      config,
      sessionId: input.session_id,
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);
    await ensureRealtimeBridge({
      toolName: 'claude-code',
      cliPath,
      config,
      sessionId: input.session_id,
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);
    await registerParticipant(config);
    await updateWorkState(config, { status: 'idle', summary: null });
    const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit: 20 });
    const items = inbox.items || [];

    return buildToolHookContext(items, {
      participantId: config.participantId,
      sessionLabel: 'Claude Code session'
    });
  });
}

export async function runUserPromptSubmitHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    ensureSessionKeeper = ensureSessionKeeperDefault,
    ensureRealtimeBridge = ensureRealtimeBridgeDefault,
    loadCursorState = loadCursorStateDefault,
    loadRealtimeQueueState = loadRealtimeQueueStateDefault,
    saveRealtimeQueueState = saveRealtimeQueueStateDefault,
    registerParticipant = registerParticipantDefault,
    saveCursorState = saveCursorStateDefault,
    pollInbox = pollInboxDefault,
    ackInbox = ackInboxDefault
  } = {}
) {
  if (typeof input.prompt === 'string' && input.prompt.trimStart().startsWith('/')) {
    return null;
  }

  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd });
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const queueStatePath = queuePathForParticipant(config.participantId, homeDir);
    const state = loadCursorState(statePath);

    await ensureSessionKeeper({
      toolName: 'claude-code',
      cliPath,
      config,
      sessionId: input.session_id,
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);
    await ensureRealtimeBridge({
      toolName: 'claude-code',
      cliPath,
      config,
      sessionId: input.session_id,
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);

    const drainedQueue = drainRealtimeQueue(loadRealtimeQueueState(queueStatePath));

    if (drainedQueue.items.length) {
      await registerParticipant(config);
      const context = buildToolHookContext(drainedQueue.items, {
        participantId: config.participantId,
        sessionLabel: 'Claude Code session'
      });
      const lastSeenEventId = highestEventId(drainedQueue.items);

      if (!context || !lastSeenEventId) {
        return null;
      }

      await ackInbox(config, lastSeenEventId);
      saveCursorState(statePath, {
        lastSeenEventId: Math.max(state.lastSeenEventId, lastSeenEventId),
        recentContext: pickRecentContext(drainedQueue.items) || state.recentContext
      });
      saveRealtimeQueueState(queueStatePath, drainedQueue.state);
      return context;
    }

    await registerParticipant(config);
    const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit: 20 });
    const items = inbox.items || [];

    const context = buildToolHookContext(items, {
      participantId: config.participantId,
      sessionLabel: 'Claude Code session'
    });

    if (!context) {
      return null;
    }

    const lastSeenEventId = highestEventId(items);
    await ackInbox(config, lastSeenEventId);
    saveCursorState(statePath, {
      lastSeenEventId,
      recentContext: pickRecentContext(items) || state.recentContext
    });
    return context;
  });
}
