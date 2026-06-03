import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ackInbox as ackInboxDefault,
  pollInbox as pollInboxDefault,
  registerParticipant as registerParticipantDefault,
  sendProgress as sendProgressDefault,
  updateWorkState as updateWorkStateDefault
} from '../session-bridge/api.js';
import {
  buildAutomaticWorkState,
  pickActiveWorkContext
} from '../session-bridge/automatic-work-state.js';
import {
  highestEventId
} from '../session-bridge/codex-hooks.js';
import {
  deriveSessionBridgeConfig,
  enrichConfigWithFocusedTerminalLocator,
  resolveSessionCwdFromTranscript as resolveSessionCwdFromTranscriptDefault
} from '../session-bridge/config.js';
import { pickRecentContext } from '../session-bridge/recent-context.js';
import {
  markPendingReplyMirror as markPendingReplyMirrorDefault,
  maybeMirrorPendingReply as maybeMirrorPendingReplyDefault
} from '../session-bridge/reply-mirror.js';
import {
  loadCursorState as loadCursorStateDefault,
  saveCursorState as saveCursorStateDefault
} from '../session-bridge/state.js';
import {
  loadRuntimeState as loadRuntimeStateDefault,
  saveRuntimeState as saveRuntimeStateDefault
} from '../session-bridge/runtime-state.js';
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
  resolveRealtimeQueueStatePath,
  resolveRuntimeStatePath
} from '../hook-installer-core/state-paths.js';

const __filename = fileURLToPath(import.meta.url);
const cliPath = path.resolve(path.dirname(__filename), 'bin', 'agy-broker.js');

const TOOL_NAME = 'agy';
const SESSION_ID_ENV = 'ANTIGRAVITY_CONVERSATION_ID';

function configFromHookInput(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault
  } = {}
) {
  const sessionId = input.conversation_id || input.session_id || env[SESSION_ID_ENV] || '';
  const sessionCwd = resolveSessionCwdFromTranscript(TOOL_NAME, sessionId, { homeDir });
  return deriveSessionBridgeConfig({
    toolName: TOOL_NAME,
    env: {
      ...env,
      INTENT_BROKER_INBOX_MODE: env.INTENT_BROKER_INBOX_MODE || 'realtime',
      AGY_CONVERSATION_ID: sessionId
    },
    cwd,
    sessionCwd
  });
}

function cursorPathForParticipant(participantId, homeDir) {
  return resolveParticipantStatePath(TOOL_NAME, participantId, { homeDir });
}

function queuePathForParticipant(participantId, homeDir) {
  return resolveRealtimeQueueStatePath(TOOL_NAME, participantId, { homeDir });
}

function runtimePathForParticipant(participantId, homeDir) {
  return resolveRuntimeStatePath(TOOL_NAME, participantId, { homeDir });
}

async function safelyRunHook(work) {
  try {
    return await work();
  } catch {
    return null;
  }
}

function isActionableItem(item = {}) {
  if (item?.payload?.delivery?.semantic === 'actionable') {
    return true;
  }

  return item?.kind === 'request_task'
    || item?.kind === 'ask_clarification'
    || item?.kind === 'request_approval'
    || item?.kind === 'reply_message';
}

function pickActionableReplyContext(items = []) {
  return pickRecentContext(items.filter(isActionableItem));
}

function highestInformationalPrefixEventId(items = []) {
  let lastEventId = 0;
  const sortedItems = [...items].sort((left, right) => Number(left?.eventId || 0) - Number(right?.eventId || 0));

  for (const item of sortedItems) {
    if (isActionableItem(item)) {
      break;
    }
    lastEventId = Math.max(lastEventId, Number(item?.eventId || 0));
  }

  return lastEventId;
}

function sessionIdFromInput(input, env = process.env) {
  return input.conversation_id || input.session_id || env[SESSION_ID_ENV] || null;
}

// agy has no SessionStart hook, so PreToolUse doubles as the registration trigger.
// The first PreToolUse in a session registers the participant and starts the realtime bridge.
export async function runPreToolUseHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault,
    ensureSessionKeeper = ensureSessionKeeperDefault,
    ensureRealtimeBridge = ensureRealtimeBridgeDefault,
    loadCursorState = loadCursorStateDefault,
    saveCursorState = saveCursorStateDefault,
    saveRuntimeState = saveRuntimeStateDefault,
    registerParticipant = registerParticipantDefault,
    updateWorkState = updateWorkStateDefault,
    pollInbox = pollInboxDefault,
    ackInbox = ackInboxDefault
  } = {}
) {
  if (env.INTENT_BROKER_SKIP_INBOX_SYNC === '1') {
    return null;
  }

  return safelyRunHook(async () => {
    const config = enrichConfigWithFocusedTerminalLocator(
      configFromHookInput(input, { env, cwd, homeDir, resolveSessionCwdFromTranscript })
    );
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const runtimeStatePath = runtimePathForParticipant(config.participantId, homeDir);
    const state = loadCursorState(statePath);

    await ensureSessionKeeper({
      toolName: TOOL_NAME,
      cliPath,
      config,
      sessionId: sessionIdFromInput(input, env),
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);
    await ensureRealtimeBridge({
      toolName: TOOL_NAME,
      cliPath,
      config,
      sessionId: sessionIdFromInput(input, env),
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);

    const registration = await registerParticipant(config);
    await updateWorkState(config, { status: 'idle', summary: null });

    saveRuntimeState(runtimeStatePath, {
      status: 'idle',
      sessionId: sessionIdFromInput(input, env),
      turnId: null,
      source: 'pre-tool-use',
      taskId: state.recentContext?.taskId || null,
      threadId: state.recentContext?.threadId || null,
      alias: registration?.alias || null,
      terminalApp: config.metadata?.terminalApp || null,
      projectPath: config.metadata?.projectPath || null,
      sessionHint: config.metadata?.sessionHint || null,
      terminalTTY: config.metadata?.terminalTTY || null,
      terminalSessionID: config.metadata?.terminalSessionID || null,
      updatedAt: new Date().toISOString()
    });

    const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit: 20 });
    const items = inbox.items || [];
    const informationalPrefixEventId = highestInformationalPrefixEventId(items);

    if (informationalPrefixEventId > Number(state.lastSeenEventId || 0)) {
      await ackInbox(config, informationalPrefixEventId);
      saveCursorState(statePath, {
        lastSeenEventId: informationalPrefixEventId,
        recentContext: state.recentContext ?? null
      });
    }

    return { registration, items };
  });
}

// PostToolUse replaces UserPromptSubmit for agy — polls inbox and updates work state.
export async function runPostToolUseHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault,
    ensureSessionKeeper = ensureSessionKeeperDefault,
    ensureRealtimeBridge = ensureRealtimeBridgeDefault,
    loadCursorState = loadCursorStateDefault,
    saveCursorState = saveCursorStateDefault,
    saveRuntimeState = saveRuntimeStateDefault,
    loadRealtimeQueueState = loadRealtimeQueueStateDefault,
    saveRealtimeQueueState = saveRealtimeQueueStateDefault,
    markPendingReplyMirror = markPendingReplyMirrorDefault,
    registerParticipant = registerParticipantDefault,
    updateWorkState = updateWorkStateDefault,
    pollInbox = pollInboxDefault,
    ackInbox = ackInboxDefault
  } = {}
) {
  if (env.INTENT_BROKER_SKIP_INBOX_SYNC === '1') {
    return null;
  }

  return safelyRunHook(async () => {
    const config = enrichConfigWithFocusedTerminalLocator(
      configFromHookInput(input, { env, cwd, homeDir, resolveSessionCwdFromTranscript })
    );
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const queueStatePath = queuePathForParticipant(config.participantId, homeDir);
    const runtimeStatePath = runtimePathForParticipant(config.participantId, homeDir);
    const state = loadCursorState(statePath);

    await ensureSessionKeeper({
      toolName: TOOL_NAME,
      cliPath,
      config,
      sessionId: sessionIdFromInput(input, env),
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);
    await ensureRealtimeBridge({
      toolName: TOOL_NAME,
      cliPath,
      config,
      sessionId: sessionIdFromInput(input, env),
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);

    const drainedQueue = drainRealtimeQueue(loadRealtimeQueueState(queueStatePath));

    if (drainedQueue.items.length) {
      await registerParticipant(config);
      const lastSeenEventId = highestEventId(drainedQueue.items);
      const recentContext = pickRecentContext(drainedQueue.items) || state.recentContext;
      const activeContext = pickActiveWorkContext(drainedQueue.items, recentContext);

      if (lastSeenEventId) {
        await ackInbox(config, lastSeenEventId);
      }
      saveCursorState(statePath, {
        lastSeenEventId: Math.max(state.lastSeenEventId, lastSeenEventId),
        recentContext
      });
      saveRealtimeQueueState(queueStatePath, drainedQueue.state);
      saveRuntimeState(runtimeStatePath, {
        status: 'running',
        sessionId: sessionIdFromInput(input, env),
        turnId: null,
        source: 'queued-context',
        taskId: activeContext?.taskId || null,
        threadId: activeContext?.threadId || null,
        terminalApp: config.metadata?.terminalApp || null,
        projectPath: config.metadata?.projectPath || null,
        sessionHint: config.metadata?.sessionHint || null,
        terminalTTY: config.metadata?.terminalTTY || null,
        terminalSessionID: config.metadata?.terminalSessionID || null,
        updatedAt: new Date().toISOString()
      });
      await updateWorkState(
        config,
        buildAutomaticWorkState('implementing', activeContext)
      ).catch(() => null);
      const replyContext = pickActionableReplyContext(drainedQueue.items);
      if (replyContext) {
        markPendingReplyMirror(
          TOOL_NAME,
          config.participantId,
          {
            sessionId: sessionIdFromInput(input, env),
            turnId: null,
            recentContext: replyContext
          },
          { homeDir }
        );
      }
      return { items: drainedQueue.items, context: recentContext };
    }

    await registerParticipant(config);
    const activeContext = pickActiveWorkContext([], state.recentContext);
    saveRuntimeState(runtimeStatePath, {
      status: 'running',
      sessionId: sessionIdFromInput(input, env),
      turnId: null,
      source: 'post-tool-use',
      taskId: activeContext?.taskId || null,
      threadId: activeContext?.threadId || null,
      terminalApp: config.metadata?.terminalApp || null,
      projectPath: config.metadata?.projectPath || null,
      sessionHint: config.metadata?.sessionHint || null,
      terminalTTY: config.metadata?.terminalTTY || null,
      terminalSessionID: config.metadata?.terminalSessionID || null,
      updatedAt: new Date().toISOString()
    });
    await updateWorkState(
      config,
      buildAutomaticWorkState('implementing', activeContext)
    ).catch(() => null);

    const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit: 20 });
    const items = inbox.items || [];
    if (!items.length) {
      return null;
    }
    const lastSeenEventId = highestEventId(items);
    await ackInbox(config, lastSeenEventId);
    saveCursorState(statePath, {
      lastSeenEventId,
      recentContext: pickRecentContext(items) || state.recentContext
    });
    const replyContext = pickActionableReplyContext(items);
    if (replyContext) {
      markPendingReplyMirror(
        TOOL_NAME,
        config.participantId,
        {
          sessionId: sessionIdFromInput(input, env),
          turnId: null,
          recentContext: replyContext
        },
        { homeDir }
      );
    }
    return { items, context: pickRecentContext(items) || state.recentContext };
  });
}

export async function runStopHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault,
    loadCursorState = loadCursorStateDefault,
    saveCursorState = saveCursorStateDefault,
    loadRuntimeState = loadRuntimeStateDefault,
    saveRuntimeState = saveRuntimeStateDefault,
    loadRealtimeQueueState = loadRealtimeQueueStateDefault,
    saveRealtimeQueueState = saveRealtimeQueueStateDefault,
    maybeMirrorPendingReply = maybeMirrorPendingReplyDefault,
    markPendingReplyMirror = markPendingReplyMirrorDefault,
    sendProgress = sendProgressDefault,
    updateWorkState = updateWorkStateDefault,
    ackInbox = ackInboxDefault
  } = {}
) {
  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd, homeDir, resolveSessionCwdFromTranscript });
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const queueStatePath = queuePathForParticipant(config.participantId, homeDir);
    const runtimeStatePath = runtimePathForParticipant(config.participantId, homeDir);
    const cursorState = loadCursorState(statePath);
    const runtimeState = loadRuntimeState(runtimeStatePath);
    const queueState = loadRealtimeQueueState(queueStatePath);

    const currentSessionId = sessionIdFromInput(input, env) || runtimeState.sessionId || null;

    await maybeMirrorPendingReply(config, {
      toolName: TOOL_NAME,
      sessionId: currentSessionId,
      turnId: null,
      homeDir,
      sendProgress
    });

    if (queueState.actionable.length) {
      const drainedQueue = drainRealtimeQueue(queueState);
      const items = drainedQueue.items;
      const recentContext = pickRecentContext(items) || cursorState.recentContext;
      const activeContext = pickActiveWorkContext(items, recentContext);
      const lastSeenEventId = highestEventId(items);

      if (lastSeenEventId) {
        await ackInbox(config, lastSeenEventId);
      }
      saveCursorState(statePath, {
        lastSeenEventId: Math.max(cursorState.lastSeenEventId, lastSeenEventId),
        recentContext
      });
      saveRealtimeQueueState(queueStatePath, drainedQueue.state);
      saveRuntimeState(runtimeStatePath, {
        status: 'running',
        sessionId: currentSessionId,
        turnId: null,
        source: 'stop-hook',
        taskId: activeContext?.taskId || null,
        threadId: activeContext?.threadId || null,
        updatedAt: new Date().toISOString()
      });
      await updateWorkState(
        config,
        buildAutomaticWorkState('implementing', activeContext)
      ).catch(() => null);
      const replyContext = pickActionableReplyContext(items);
      if (replyContext) {
        markPendingReplyMirror(
          TOOL_NAME,
          config.participantId,
          {
            sessionId: currentSessionId,
            recentContext: replyContext
          },
          { homeDir }
        );
      }
      return { items, context: recentContext };
    }

    saveRuntimeState(runtimeStatePath, {
      ...runtimeState,
      status: 'idle',
      sessionId: currentSessionId,
      turnId: null,
      source: 'stop-hook',
      updatedAt: new Date().toISOString()
    });
    await updateWorkState(
      config,
      buildAutomaticWorkState('idle')
    ).catch(() => null);
    return null;
  });
}
