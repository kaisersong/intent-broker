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
  buildCodexAutoContinuePrompt,
  buildCodexHookContext,
  highestEventId
} from '../session-bridge/codex-hooks.js';
import {
  deriveSessionBridgeConfig,
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
const cliPath = path.resolve(path.dirname(__filename), 'bin', 'codex-broker.js');

function configFromHookInput(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault
  } = {}
) {
  const sessionId = input.session_id || env.CODEX_THREAD_ID || '';
  const sessionCwd = resolveSessionCwdFromTranscript('codex', sessionId, { homeDir });
  return deriveSessionBridgeConfig({
    toolName: 'codex',
    env: {
      ...env,
      INTENT_BROKER_INBOX_MODE: env.INTENT_BROKER_INBOX_MODE || 'realtime',
      CODEX_THREAD_ID: sessionId
    },
    cwd,
    sessionCwd
  });
}

function cursorPathForParticipant(participantId, homeDir) {
  return resolveParticipantStatePath('codex', participantId, { homeDir });
}

function queuePathForParticipant(participantId, homeDir) {
  return resolveRealtimeQueueStatePath('codex', participantId, { homeDir });
}

function runtimePathForParticipant(participantId, homeDir) {
  return resolveRuntimeStatePath('codex', participantId, { homeDir });
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
    || item?.kind === 'request_approval';
}

function pickActionableReplyContext(items = []) {
  return pickRecentContext(items.filter(isActionableItem));
}

export async function runSessionStartHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault,
    ensureSessionKeeper = ensureSessionKeeperDefault,
    ensureRealtimeBridge = ensureRealtimeBridgeDefault,
    loadCursorState = loadCursorStateDefault,
    saveRuntimeState = saveRuntimeStateDefault,
    registerParticipant = registerParticipantDefault,
    updateWorkState = updateWorkStateDefault,
    pollInbox = pollInboxDefault
  } = {}
) {
  if (env.INTENT_BROKER_SKIP_INBOX_SYNC === '1') {
    return null;
  }

  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd, homeDir, resolveSessionCwdFromTranscript });
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const runtimeStatePath = runtimePathForParticipant(config.participantId, homeDir);
    const state = loadCursorState(statePath);

    await ensureSessionKeeper({
      toolName: 'codex',
      cliPath,
      config,
      sessionId: input.session_id,
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);
    await ensureRealtimeBridge({
      toolName: 'codex',
      cliPath,
      config,
      sessionId: input.session_id,
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);
    const registration = await registerParticipant(config);
    await updateWorkState(config, { status: 'idle', summary: null });
    saveRuntimeState(runtimeStatePath, {
      status: 'idle',
      sessionId: input.session_id || null,
      turnId: null,
      source: 'session-start',
      taskId: state.recentContext?.taskId || null,
      threadId: state.recentContext?.threadId || null,
      alias: registration?.alias || null,
      updatedAt: new Date().toISOString()
    });
    const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit: 20 });
    const items = inbox.items || [];

    return {
      context: buildCodexHookContext(items, { participantId: config.participantId, alias: registration?.alias }),
      registration
    };
  });
}

export async function runUserPromptSubmitHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault,
    ensureSessionKeeper = ensureSessionKeeperDefault,
    ensureRealtimeBridge = ensureRealtimeBridgeDefault,
    loadCursorState = loadCursorStateDefault,
    saveRuntimeState = saveRuntimeStateDefault,
    loadRealtimeQueueState = loadRealtimeQueueStateDefault,
    saveRealtimeQueueState = saveRealtimeQueueStateDefault,
    markPendingReplyMirror = markPendingReplyMirrorDefault,
    registerParticipant = registerParticipantDefault,
    updateWorkState = updateWorkStateDefault,
    saveCursorState = saveCursorStateDefault,
    pollInbox = pollInboxDefault,
    ackInbox = ackInboxDefault
  } = {}
) {
  if (env.INTENT_BROKER_SKIP_INBOX_SYNC === '1') {
    return null;
  }

  if (typeof input.prompt === 'string' && input.prompt.trimStart().startsWith('/')) {
    return null;
  }

  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd, homeDir, resolveSessionCwdFromTranscript });
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const queueStatePath = queuePathForParticipant(config.participantId, homeDir);
    const runtimeStatePath = runtimePathForParticipant(config.participantId, homeDir);
    const state = loadCursorState(statePath);

    await ensureSessionKeeper({
      toolName: 'codex',
      cliPath,
      config,
      sessionId: input.session_id,
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);
    await ensureRealtimeBridge({
      toolName: 'codex',
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
      const context = buildCodexHookContext(drainedQueue.items, { participantId: config.participantId });
      const lastSeenEventId = highestEventId(drainedQueue.items);
      const recentContext = pickRecentContext(drainedQueue.items) || state.recentContext;
      const activeContext = pickActiveWorkContext(drainedQueue.items, recentContext);

      if (!context || !lastSeenEventId) {
        return null;
      }

      await ackInbox(config, lastSeenEventId);
      saveCursorState(statePath, {
        lastSeenEventId: Math.max(state.lastSeenEventId, lastSeenEventId),
        recentContext
      });
      saveRealtimeQueueState(queueStatePath, drainedQueue.state);
      saveRuntimeState(runtimeStatePath, {
        status: 'running',
        sessionId: input.session_id || null,
        turnId: input.turn_id || null,
        source: 'queued-context',
        taskId: activeContext?.taskId || null,
        threadId: activeContext?.threadId || null,
        updatedAt: new Date().toISOString()
      });
      await updateWorkState(
        config,
        buildAutomaticWorkState('implementing', activeContext)
      ).catch(() => null);
      const replyContext = pickActionableReplyContext(drainedQueue.items);
      if (replyContext) {
        markPendingReplyMirror(
          'codex',
          config.participantId,
          {
            sessionId: input.session_id || null,
            turnId: input.turn_id || null,
            recentContext: replyContext
          },
          { homeDir }
        );
      }
      return context;
    }

    await registerParticipant(config);
    const activeContext = pickActiveWorkContext([], state.recentContext);
    saveRuntimeState(runtimeStatePath, {
      status: 'running',
      sessionId: input.session_id || null,
      turnId: input.turn_id || null,
      source: 'user-prompt-submit',
      taskId: activeContext?.taskId || null,
      threadId: activeContext?.threadId || null,
      updatedAt: new Date().toISOString()
    });
    await updateWorkState(
      config,
      buildAutomaticWorkState('implementing', activeContext)
    ).catch(() => null);
    const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit: 20 });
    const items = inbox.items || [];
    const context = buildCodexHookContext(items, { participantId: config.participantId });

    if (!context) {
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
        'codex',
        config.participantId,
        {
          sessionId: input.session_id || null,
          turnId: input.turn_id || null,
          recentContext: replyContext
        },
        { homeDir }
      );
    }
    return context;
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

    await maybeMirrorPendingReply(config, {
      toolName: 'codex',
      sessionId: input.session_id || runtimeState.sessionId || null,
      turnId: input.turn_id || null,
      homeDir,
      sendProgress
    });

    if (!queueState.actionable.length) {
      saveRuntimeState(runtimeStatePath, {
        ...runtimeState,
        status: 'idle',
        sessionId: input.session_id || runtimeState.sessionId,
        turnId: input.turn_id || null,
        source: 'stop-hook',
        updatedAt: new Date().toISOString()
      });
      await updateWorkState(
        config,
        buildAutomaticWorkState('idle')
      ).catch(() => null);
      return null;
    }

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
      sessionId: input.session_id || runtimeState.sessionId,
      turnId: input.turn_id || null,
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
        'codex',
        config.participantId,
        {
          sessionId: input.session_id || runtimeState.sessionId || null,
          recentContext: replyContext
        },
        { homeDir }
      );
    }

    return buildCodexAutoContinuePrompt(items, { participantId: config.participantId });
  });
}
