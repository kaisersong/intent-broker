import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ackInbox as ackInboxDefault,
  pollInbox as pollInboxDefault,
  registerParticipant as registerParticipantDefault,
  sendAsk as sendAskDefault,
  sendProgress as sendProgressDefault,
  updateWorkState as updateWorkStateDefault
} from '../session-bridge/api.js';
import {
  buildAutomaticWorkState,
  pickActiveWorkContext
} from '../session-bridge/automatic-work-state.js';
import {
  buildXiaokAutoContinuePrompt,
  buildXiaokHookContext,
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
const cliPath = path.resolve(path.dirname(__filename), 'bin', 'xiaok-broker.js');

function configFromHookInput(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault
  } = {}
) {
  const sessionId = input.session_id || env.XIAOK_CODE_SESSION_ID || '';
  const sessionCwd = resolveSessionCwdFromTranscript('xiaok-code', sessionId, { homeDir });
  return deriveSessionBridgeConfig({
    toolName: 'xiaok-code',
    env: {
      ...env,
      INTENT_BROKER_INBOX_MODE: env.INTENT_BROKER_INBOX_MODE || 'realtime',
      XIAOK_CODE_SESSION_ID: sessionId
    },
    cwd,
    sessionCwd
  });
}

function cursorPathForParticipant(participantId, homeDir) {
  return resolveParticipantStatePath('xiaok-code', participantId, { homeDir });
}

function queuePathForParticipant(participantId, homeDir) {
  return resolveRealtimeQueueStatePath('xiaok-code', participantId, { homeDir });
}

function runtimePathForParticipant(participantId, homeDir) {
  return resolveRuntimeStatePath('xiaok-code', participantId, { homeDir });
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

function pickToolName(input = {}) {
  return input.tool_name || input.toolName || input.name || input.tool || 'tool';
}

function pickToolInput(input = {}) {
  return input.tool_input || input.toolInput || input.arguments || input.input || {};
}

function pickToolUseId(input = {}) {
  return input.tool_use_id || input.toolUseId || input.tool_call_id || input.toolCallId || input.call_id || input.callId || input.id || null;
}

async function runXiaokApprovalHook(input, hookEventName, {
  env = process.env,
  cwd = process.cwd(),
  homeDir,
  resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault,
  requestHookApproval = requestHookApprovalFailOpenDefault
} = {}) {
  if (env.INTENT_BROKER_SKIP_APPROVAL_SYNC === '1') {
    return { approved: true, skipped: true };
  }

  const sessionId = input.session_id || env.XIAOK_CODE_SESSION_ID || '';
  const toolName = pickToolName(input);
  const toolInput = pickToolInput(input);

  return requestHookApproval({
    config: configFromHookInput(input, { env, cwd, homeDir, resolveSessionCwdFromTranscript }),
    agentTool: 'xiaok-code',
    hookEventName,
    sessionId,
    cwd: input.cwd || cwd,
    toolName,
    toolInput,
    toolUseId: pickToolUseId(input) || `${sessionId || 'xiaok-code'}-${toolName}`
  });
}

export async function runPermissionRequestHook(input, options = {}) {
  return runXiaokApprovalHook(input, 'PermissionRequest', options);
}

function readStringValue(source, keys = []) {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function readBooleanValue(source, keys = []) {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }

  return undefined;
}

function hasExplicitPreToolUseApprovalSignal(toolInput = {}) {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return false;
  }

  return readStringValue(toolInput, ['sandbox_permissions', 'sandboxPermissions']) === 'require_escalated'
    || readBooleanValue(toolInput, ['with_escalated_permissions', 'withEscalatedPermissions']) === true
    || readBooleanValue(toolInput, ['requiresApproval', 'approvalRequired']) === true
    || readBooleanValue(toolInput, ['requires_confirmation', 'requiresConfirmation']) === true
    || readBooleanValue(toolInput, ['askForConfirmation']) === true
    || typeof readStringValue(toolInput, ['justification']) === 'string';
}

function normalizeAskUserQuestionOption(option, index) {
  if (typeof option === 'string' && option.trim()) {
    return {
      value: option.trim(),
      label: option.trim()
    };
  }

  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    return null;
  }

  const value = readStringValue(option, ['value', 'id', 'key', 'name'])
    ?? readStringValue(option, ['label', 'title', 'text'])
    ?? String(index);
  const label = readStringValue(option, ['label', 'title', 'text', 'name']) ?? value;
  const description = readStringValue(option, ['description', 'detail', 'subtitle', 'helpText']);

  return {
    value,
    label,
    description
  };
}

function buildAskUserQuestionRequest(config, input = {}) {
  const toolName = pickToolName(input);
  if (toolName !== 'AskUserQuestion') {
    return null;
  }

  const toolInput = pickToolInput(input);
  const firstQuestion = Array.isArray(toolInput.questions) && toolInput.questions.length > 0
    ? toolInput.questions[0]
    : null;
  const source = firstQuestion && typeof firstQuestion === 'object'
    ? firstQuestion
    : toolInput;
  const optionSource = Array.isArray(source.options)
    ? source.options
    : Array.isArray(source.choices)
      ? source.choices
      : Array.isArray(source.answers)
        ? source.answers
        : [];
  const options = optionSource
    .map((option, index) => normalizeAskUserQuestionOption(option, index))
    .filter((option) => option !== null);

  if (options.length === 0) {
    return null;
  }

  const prompt = readStringValue(source, ['question', 'prompt', 'message', 'text'])
    ?? readStringValue(source, ['header', 'title', 'summary'])
    ?? 'Clarification requested';
  const summary = readStringValue(source, ['header', 'title', 'summary']) ?? prompt;
  const detailText = readStringValue(source, ['detailText', 'detail', 'description', 'context', 'warning']);
  const isMultiSelect = readBooleanValue(source, ['multiSelect', 'multiple']) === true;
  const selectionMode = isMultiSelect ? 'multi-select' : 'single-select';
  const toolUseId = pickToolUseId(input) ?? 'ask-user-question';
  const taskId = input.task_id || input.taskId || `${config.participantId}-ask-${toolUseId}`;
  const threadId = input.thread_id || input.threadId || taskId;

  return {
    intentId: `${config.participantId}-ask-${toolUseId}`,
    toParticipantId: 'human.local',
    taskId,
    threadId,
    participantId: config.participantId,
    summary,
    prompt,
    detailText,
    selectionMode,
    options,
    metadata: {
      agentTool: 'xiaok-code',
      hookEventName: 'PreToolUse',
      toolName
    },
    delivery: {
      semantic: 'actionable',
      source: 'xiaok-ask-user-question'
    }
  };
}

async function resolveCompletedTurnSummaryFromHookInput(input) {
  const summary = [
    input.last_assistant_message,
    input.lastAssistantMessage,
    input.assistant_message_preview,
    input.assistantMessagePreview
  ].find((value) => typeof value === 'string' && value.trim());

  return {
    summary: summary || '',
    transcriptPath: (typeof input.transcript_path === 'string' && input.transcript_path)
      || (typeof input.transcriptPath === 'string' && input.transcriptPath)
      || null
  };
}

export async function runPreToolUseHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault,
    requestHookApproval = requestHookApprovalFailOpenDefault,
    sendAsk = sendAskDefault
  } = {}
) {
  if (env.INTENT_BROKER_SKIP_APPROVAL_SYNC === '1') {
    return null;
  }

  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd, homeDir, resolveSessionCwdFromTranscript });
    const askUserQuestionRequest = buildAskUserQuestionRequest(config, input);
    if (askUserQuestionRequest) {
      await sendAsk(config, askUserQuestionRequest);
      return {
        preventContinuation: true,
        additionalContext: 'AskUserQuestion has been mirrored to Intent Broker. Wait for the human response in HexDeck instead of opening the native terminal menu.',
        message: 'AskUserQuestion forwarded to Intent Broker'
      };
    }

    const sessionId = input.session_id || env.XIAOK_CODE_SESSION_ID || '';
    const toolName = pickToolName(input);
    const toolInput = pickToolInput(input);
    if (!hasExplicitPreToolUseApprovalSignal(toolInput)) {
      return { approved: true, skipped: true };
    }

    return requestHookApproval({
      config,
      agentTool: 'xiaok-code',
      hookEventName: 'PreToolUse',
      sessionId,
      cwd: input.cwd || cwd,
      toolName,
      toolInput,
      toolUseId: pickToolUseId(input) || `${sessionId || 'xiaok-code'}-${toolName}`
    });
  });
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
    const config = enrichConfigWithFocusedTerminalLocator(
      configFromHookInput(input, { env, cwd, homeDir, resolveSessionCwdFromTranscript })
    );
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const runtimeStatePath = runtimePathForParticipant(config.participantId, homeDir);
    const state = loadCursorState(statePath);

    await ensureSessionKeeper({
      toolName: 'xiaok-code',
      cliPath,
      config,
      sessionId: input.session_id,
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);
    await ensureRealtimeBridge({
      toolName: 'xiaok-code',
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
      context: buildXiaokHookContext(items, { participantId: config.participantId, alias: registration?.alias }),
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
    const config = enrichConfigWithFocusedTerminalLocator(
      configFromHookInput(input, { env, cwd, homeDir, resolveSessionCwdFromTranscript })
    );
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const queueStatePath = queuePathForParticipant(config.participantId, homeDir);
    const runtimeStatePath = runtimePathForParticipant(config.participantId, homeDir);
    const state = loadCursorState(statePath);

    await ensureSessionKeeper({
      toolName: 'xiaok-code',
      cliPath,
      config,
      sessionId: input.session_id,
      cwd,
      env,
      homeDir,
      parentPid: resolveObservedParentPid()
    }).catch(() => null);
    await ensureRealtimeBridge({
      toolName: 'xiaok-code',
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
      const context = buildXiaokHookContext(drainedQueue.items, { participantId: config.participantId });
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
          'xiaok-code',
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
    const context = buildXiaokHookContext(items, { participantId: config.participantId });

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
        'xiaok-code',
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
    resolveCompletedTurnSummary = resolveCompletedTurnSummaryFromHookInput,
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

    const currentSessionId = input.session_id || runtimeState.sessionId || null;
    const currentTurnId = input.turn_id || null;

    const mirroredReply = await maybeMirrorPendingReply(config, {
      toolName: 'xiaok-code',
      sessionId: currentSessionId,
      turnId: currentTurnId,
      homeDir,
      sendProgress
    });

    if (
      mirroredReply?.mirrored !== true
      && runtimeState.status === 'running'
      && runtimeState.taskId
      && runtimeState.threadId
    ) {
      const completedTurn = await resolveCompletedTurnSummary(input, {
        toolName: 'xiaok-code',
        sessionId: currentSessionId,
        turnId: currentTurnId,
        homeDir
      });

      if (completedTurn?.summary) {
        await sendProgress(config, {
          intentId: `${config.participantId}-stop-complete-${Date.now()}`,
          taskId: runtimeState.taskId,
          threadId: runtimeState.threadId,
          stage: 'completed',
          summary: completedTurn.summary,
          delivery: {
            semantic: 'informational',
            source: 'stop-fallback'
          }
        }).catch(() => null);
      }
    }

    if (!queueState.actionable.length) {
      saveRuntimeState(runtimeStatePath, {
        ...runtimeState,
        status: 'idle',
        sessionId: currentSessionId,
        turnId: currentTurnId,
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
      sessionId: currentSessionId,
      turnId: currentTurnId,
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
        'xiaok-code',
        config.participantId,
        {
          sessionId: currentSessionId,
          recentContext: replyContext
        },
        { homeDir }
      );
    }

    return buildXiaokAutoContinuePrompt(items, { participantId: config.participantId });
  });
}
