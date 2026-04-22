import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ackInbox as ackInboxDefault,
  pollInbox as pollInboxDefault,
  registerParticipant as registerParticipantDefault,
  sendProgress as sendProgressDefault,
  sendAsk as sendAskDefault,
  updateWorkState as updateWorkStateDefault
} from '../session-bridge/api.js';
import {
  buildToolHookContext,
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
  clearPendingToolUseContext as clearPendingToolUseContextDefault,
  loadPendingToolUseContext as loadPendingToolUseContextDefault,
  savePendingToolUseContext as savePendingToolUseContextDefault
} from '../session-bridge/pending-tool-use.js';
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
const cliPath = path.resolve(path.dirname(__filename), 'bin', 'claude-code-broker.js');
const MIRRORED_ASK_USER_QUESTION_CONTEXT =
  'AskUserQuestion has been mirrored to Intent Broker. Wait for the human response in HexDeck instead of opening the native terminal menu.';

function configFromHookInput(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault
  } = {}
) {
  const sessionId = input.session_id || env.CLAUDE_CODE_SESSION_ID || '';
  const sessionCwd = resolveSessionCwdFromTranscript('claude-code', sessionId, { homeDir });
  return deriveSessionBridgeConfig({
    toolName: 'claude-code',
    env: {
      ...env,
      INTENT_BROKER_INBOX_MODE: env.INTENT_BROKER_INBOX_MODE || 'realtime',
      CLAUDE_CODE_SESSION_ID: sessionId
    },
    cwd,
    sessionCwd
  });
}

function cursorPathForParticipant(participantId, homeDir) {
  return resolveParticipantStatePath('claude-code', participantId, { homeDir });
}

function queuePathForParticipant(participantId, homeDir) {
  return resolveRealtimeQueueStatePath('claude-code', participantId, { homeDir });
}

function runtimePathForParticipant(participantId, homeDir) {
  return resolveRuntimeStatePath('claude-code', participantId, { homeDir });
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

function pickToolUseId(input = {}) {
  return input.tool_use_id || input.toolUseId || input.tool_call_id || input.toolCallId || input.call_id || input.callId || input.id || null;
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

function pickAskUserQuestionSource(toolInput = {}) {
  if (!Array.isArray(toolInput.questions) || toolInput.questions.length === 0) {
    return toolInput;
  }

  const singleSelectQuestion = toolInput.questions.find((question) => (
    question
    && typeof question === 'object'
    && !Array.isArray(question)
    && readBooleanValue(question, ['multiSelect', 'multiple']) !== true
  ));

  if (singleSelectQuestion && typeof singleSelectQuestion === 'object' && !Array.isArray(singleSelectQuestion)) {
    return singleSelectQuestion;
  }

  const firstQuestion = toolInput.questions[0];
  if (firstQuestion && typeof firstQuestion === 'object' && !Array.isArray(firstQuestion)) {
    return firstQuestion;
  }

  return toolInput;
}

function buildAskUserQuestionRequest(config, input = {}) {
  const toolName = pickToolName(input);
  if (toolName !== 'AskUserQuestion') {
    return null;
  }

  const toolInput = pickToolInput(input);
  const source = pickAskUserQuestionSource(toolInput);
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
      agentTool: 'claude-code',
      hookEventName: 'PreToolUse',
      toolName
    },
    delivery: {
      semantic: 'actionable',
      source: 'claude-ask-user-question'
    }
  };
}

function mergeCorrelatedToolContext(input = {}, correlated = null) {
  if (!correlated || typeof correlated !== 'object') {
    return {
      toolName: pickToolName(input),
      toolInput: pickToolInput(input),
      toolUseId: pickToolUseId(input)
    };
  }

  const directToolName = pickToolName(input);
  const directToolInput = pickToolInput(input);
  const directToolUseId = pickToolUseId(input);

  return {
    toolName: directToolName === 'tool' && correlated.toolName ? correlated.toolName : directToolName,
    toolInput:
      (directToolInput && Object.keys(directToolInput).length > 0)
        ? directToolInput
        : (correlated.toolInput ?? directToolInput),
    toolUseId: directToolUseId || correlated.toolUseId || null
  };
}

export async function runPreToolUseHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault,
    savePendingToolUseContext = savePendingToolUseContextDefault,
    sendAsk = sendAskDefault
  } = {}
) {
  if (env.INTENT_BROKER_SKIP_APPROVAL_SYNC === '1') {
    return null;
  }

  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd, homeDir, resolveSessionCwdFromTranscript });
    const sessionId = input.session_id || env.CLAUDE_CODE_SESSION_ID || '';
    const askUserQuestionRequest = buildAskUserQuestionRequest(config, input);
    savePendingToolUseContext('claude-code', config.participantId, {
      sessionId,
      toolName: pickToolName(input),
      toolInput: pickToolInput(input),
      toolUseId: pickToolUseId(input)
    }, { homeDir });
    if (askUserQuestionRequest) {
      await sendAsk(config, askUserQuestionRequest);
      return {
        permissionDecision: 'deny',
        permissionDecisionReason: MIRRORED_ASK_USER_QUESTION_CONTEXT,
        additionalContext: MIRRORED_ASK_USER_QUESTION_CONTEXT
      };
    }
    return null;
  });
}

export async function runPermissionRequestHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir,
    resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault,
    loadPendingToolUseContext = loadPendingToolUseContextDefault,
    requestHookApproval = requestHookApprovalFailOpenDefault
  } = {}
) {
  if (env.INTENT_BROKER_SKIP_APPROVAL_SYNC === '1') {
    return { approved: true, skipped: true, updatedInput: pickToolInput(input) };
  }

  const sessionId = input.session_id || env.CLAUDE_CODE_SESSION_ID || '';
  const config = configFromHookInput(input, { env, cwd, homeDir, resolveSessionCwdFromTranscript });
  const correlated = loadPendingToolUseContext('claude-code', config.participantId, { homeDir });
  const effectiveTool = mergeCorrelatedToolContext(
    input,
    !correlated?.sessionId || !sessionId || correlated.sessionId === sessionId ? correlated : null
  );
  const result = await requestHookApproval({
    config,
    agentTool: 'claude-code',
    hookEventName: 'PermissionRequest',
    sessionId,
    cwd: input.cwd || cwd,
    toolName: effectiveTool.toolName,
    toolInput: effectiveTool.toolInput,
    toolUseId: effectiveTool.toolUseId || `${sessionId || 'claude-code'}-${effectiveTool.toolName}`
  });

  if (result?.approved === false) {
    return result;
  }

  return {
    ...result,
    updatedInput: effectiveTool.toolInput
  };
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
      context: buildToolHookContext(items, {
        participantId: config.participantId,
        alias: registration?.alias,
        sessionLabel: 'Claude Code session'
      }),
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
    markPendingReplyMirror = markPendingReplyMirrorDefault,
    saveRealtimeQueueState = saveRealtimeQueueStateDefault,
    registerParticipant = registerParticipantDefault,
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
      saveRuntimeState(runtimeStatePath, {
        status: 'running',
        sessionId: input.session_id || null,
        turnId: null,
        source: 'queued-context',
        taskId: state.recentContext?.taskId || null,
        threadId: state.recentContext?.threadId || null,
        terminalApp: config.metadata?.terminalApp || null,
        projectPath: config.metadata?.projectPath || null,
        sessionHint: config.metadata?.sessionHint || null,
        terminalTTY: config.metadata?.terminalTTY || null,
        terminalSessionID: config.metadata?.terminalSessionID || null,
        updatedAt: new Date().toISOString()
      });
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
      const replyContext = pickActionableReplyContext(drainedQueue.items);
      if (replyContext) {
        markPendingReplyMirror(
          'claude-code',
          config.participantId,
          {
            sessionId: input.session_id || null,
            recentContext: replyContext
          },
          { homeDir }
        );
      }
      return context;
    }

    await registerParticipant(config);
    saveRuntimeState(runtimeStatePath, {
      status: 'running',
      sessionId: input.session_id || null,
      turnId: null,
      source: 'user-prompt-submit',
      taskId: state.recentContext?.taskId || null,
      threadId: state.recentContext?.threadId || null,
      terminalApp: config.metadata?.terminalApp || null,
      projectPath: config.metadata?.projectPath || null,
      sessionHint: config.metadata?.sessionHint || null,
      terminalTTY: config.metadata?.terminalTTY || null,
      terminalSessionID: config.metadata?.terminalSessionID || null,
      updatedAt: new Date().toISOString()
    });
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
    const replyContext = pickActionableReplyContext(items);
    if (replyContext) {
      markPendingReplyMirror(
        'claude-code',
        config.participantId,
        {
          sessionId: input.session_id || null,
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
    clearPendingToolUseContext = clearPendingToolUseContextDefault,
    maybeMirrorPendingReply = maybeMirrorPendingReplyDefault,
    loadRuntimeState = loadRuntimeStateDefault,
    saveRuntimeState = saveRuntimeStateDefault,
    resolveCompletedTurnSummary = resolveCompletedTurnSummaryFromHookInput,
    sendProgress = sendProgressDefault,
    updateWorkState = updateWorkStateDefault
  } = {}
) {
  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd, homeDir, resolveSessionCwdFromTranscript });
    const runtimeStatePath = runtimePathForParticipant(config.participantId, homeDir);
    const runtimeState = loadRuntimeState(runtimeStatePath);
    const currentSessionId = input.session_id || runtimeState.sessionId || null;

    try {
      clearPendingToolUseContext('claude-code', config.participantId, { homeDir });
    } catch {
      // Completion mirroring is more important than clearing cached pre-tool context.
    }

    const mirroredReply = await maybeMirrorPendingReply(config, {
      toolName: 'claude-code',
      sessionId: currentSessionId,
      homeDir
    });

    if (
      mirroredReply?.mirrored !== true
      && runtimeState.status === 'running'
      && runtimeState.taskId
      && runtimeState.threadId
    ) {
      const completedTurn = await resolveCompletedTurnSummary(input, {
        toolName: 'claude-code',
        sessionId: currentSessionId,
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
      { status: 'idle', summary: null, taskId: null, threadId: null }
    ).catch(() => null);

    return null;
  });
}
