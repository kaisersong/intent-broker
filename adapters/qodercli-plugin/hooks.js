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
  buildQodercliAutoContinuePrompt,
  buildQodercliHookContext,
  highestEventId
} from '../session-bridge/codex-hooks.js';
import {
  deriveSessionBridgeConfig,
  enrichConfigWithFocusedTerminalLocator
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
import { requestHookApprovalFailOpen as requestHookApprovalFailOpenDefault } from '../session-bridge/hook-approval.js';
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
const cliPath = path.resolve(path.dirname(__filename), 'bin', 'qodercli-broker.js');

const TOOL_NAME = 'qodercli';

function configFromHookInput(
  input,
  { env = process.env, cwd = process.cwd(), homeDir } = {}
) {
  const sessionId = input.session_id || env.QODER_SESSION_ID || '';
  return deriveSessionBridgeConfig({
    toolName: TOOL_NAME,
    env: {
      ...env,
      INTENT_BROKER_INBOX_MODE: env.INTENT_BROKER_INBOX_MODE || 'realtime',
      QODER_SESSION_ID: sessionId
    },
    cwd: input.cwd || cwd,
    sessionCwd: null
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

function pickToolName(input = {}) {
  return input.tool_name || input.toolName || input.name || input.tool || 'tool';
}

function pickToolInput(input = {}) {
  return input.tool_input || input.toolInput || input.arguments || input.input || {};
}

function pickToolUseId(input = {}) {
  return input.tool_use_id || input.toolUseId || input.tool_call_id || input.toolCallId || input.call_id || input.callId || input.id || null;
}

function pickExecCommand(toolInput = {}) {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return '';
  }

  return [toolInput.command, toolInput.cmd]
    .find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() || '';
}

function hasShellCommand(command, pattern) {
  return new RegExp('(^|[;&|]\\s*|&&\\s*|\\|\\|\\s*)(sudo\\s+)?' + pattern + '(\\s|$)', 'i').test(command);
}

function isDestructiveExecCommand(command) {
  const trimmed = typeof command === 'string' ? command.trim() : '';
  if (!trimmed) {
    return false;
  }

  return hasShellCommand(trimmed, 'rm')
    || hasShellCommand(trimmed, 'rmdir')
    || hasShellCommand(trimmed, 'mv')
    || hasShellCommand(trimmed, 'chmod')
    || hasShellCommand(trimmed, 'chown')
    || hasShellCommand(trimmed, 'dd')
    || /git\s+reset\s+--hard/i.test(trimmed)
    || /git\s+clean\b[^\n]*\s-f/i.test(trimmed)
    || /git\s+checkout\s+--/i.test(trimmed)
    || /git\s+push\b[^\n]*--force(?:-with-lease)?/i.test(trimmed)
    || /git\s+branch\s+-D\b/i.test(trimmed)
    || /git\s+tag\s+-d\b/i.test(trimmed);
}

function shouldMirrorPreToolUseApproval(toolName, toolInput) {
  if (toolName !== 'Bash') {
    return false;
  }

  const command = pickExecCommand(toolInput);
  return isDestructiveExecCommand(command);
}

export async function runPreToolUseHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    requestHookApproval = requestHookApprovalFailOpenDefault
  } = {}
) {
  if (env.INTENT_BROKER_SKIP_APPROVAL_SYNC === '1') {
    return { approved: true, skipped: true };
  }

  const sessionId = input.session_id || env.QODER_SESSION_ID || '';
  const toolName = pickToolName(input);
  const toolInput = pickToolInput(input);

  if (!shouldMirrorPreToolUseApproval(toolName, toolInput)) {
    return { approved: true, skipped: true };
  }

  return requestHookApproval({
    config: configFromHookInput(input, { env, cwd, homeDir }),
    agentTool: TOOL_NAME,
    hookEventName: 'PreToolUse',
    sessionId,
    cwd: input.cwd || cwd,
    toolName,
    toolInput,
    toolUseId: pickToolUseId(input) || `${sessionId || 'qodercli'}-${toolName}`
  });
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
    const config = enrichConfigWithFocusedTerminalLocator(
      configFromHookInput(input, { env, cwd, homeDir })
    );
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const runtimeStatePath = runtimePathForParticipant(config.participantId, homeDir);
    const state = loadCursorState(statePath);

    await ensureSessionKeeper({
      toolName: TOOL_NAME,
      cliPath,
      config,
      sessionId: input.session_id || null,
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);
    await ensureRealtimeBridge({
      toolName: TOOL_NAME,
      cliPath,
      config,
      sessionId: input.session_id || null,
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
      terminalApp: config.metadata?.terminalApp || null,
      projectPath: config.metadata?.projectPath || null,
      sessionHint: config.metadata?.sessionHint || null,
      terminalTTY: config.metadata?.terminalTTY || null,
      terminalSessionID: config.metadata?.terminalSessionID || null,
      updatedAt: new Date().toISOString()
    });
    const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit: 20 });
    const items = inbox.items || [];

    return {
      context: buildQodercliHookContext(items, { participantId: config.participantId, alias: registration?.alias }),
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
    const config = enrichConfigWithFocusedTerminalLocator(
      configFromHookInput(input, { env, cwd, homeDir })
    );
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const queueStatePath = queuePathForParticipant(config.participantId, homeDir);
    const runtimeStatePath = runtimePathForParticipant(config.participantId, homeDir);
    const state = loadCursorState(statePath);

    await ensureSessionKeeper({
      toolName: TOOL_NAME,
      cliPath,
      config,
      sessionId: input.session_id || null,
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);
    await ensureRealtimeBridge({
      toolName: TOOL_NAME,
      cliPath,
      config,
      sessionId: input.session_id || null,
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);

    const drainedQueue = drainRealtimeQueue(loadRealtimeQueueState(queueStatePath));

    if (drainedQueue.items.length) {
      await registerParticipant(config);
      const context = buildQodercliHookContext(drainedQueue.items, { participantId: config.participantId });
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
            sessionId: input.session_id || null,
            turnId: null,
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
      turnId: null,
      source: 'user-prompt-submit',
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
    const context = buildQodercliHookContext(items, { participantId: config.participantId });

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
        TOOL_NAME,
        config.participantId,
        {
          sessionId: input.session_id || null,
          turnId: null,
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
    const config = configFromHookInput(input, { env, cwd, homeDir });
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const queueStatePath = queuePathForParticipant(config.participantId, homeDir);
    const runtimeStatePath = runtimePathForParticipant(config.participantId, homeDir);
    const cursorState = loadCursorState(statePath);
    const runtimeState = loadRuntimeState(runtimeStatePath);
    const queueState = loadRealtimeQueueState(queueStatePath);

    const currentSessionId = input.session_id || runtimeState.sessionId || null;

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

      return buildQodercliAutoContinuePrompt(items, { participantId: config.participantId });
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
