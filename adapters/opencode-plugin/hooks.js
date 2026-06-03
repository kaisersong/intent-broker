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
import { highestEventId } from '../session-bridge/codex-hooks.js';
import {
  deriveSessionBridgeConfig,
  enrichConfigWithFocusedTerminalLocator,
  resolveSessionCwdFromTranscript as resolveSessionCwdFromTranscriptDefault
} from '../session-bridge/config.js';
import { pickRecentContext } from '../session-bridge/recent-context.js';
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
const cliPath = path.resolve(path.dirname(__filename), 'bin', 'opencode-broker.js');

const TOOL_NAME = 'opencode';
const SESSION_ID_ENV = 'OPENCODE_SESSION_ID';

function configFromHookInput(input, { env = process.env, cwd = process.cwd(), homeDir } = {}) {
  const sessionId = input.sessionID || input.session_id || env[SESSION_ID_ENV] || '';
  return deriveSessionBridgeConfig({
    toolName: TOOL_NAME,
    env: { ...env, OPENCODE_SESSION_ID: sessionId },
    cwd,
    sessionCwd: cwd
  });
}

function cursorPathForParticipant(participantId, homeDir) {
  return resolveParticipantStatePath(TOOL_NAME, participantId, { homeDir });
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

function sessionIdFromInput(input, env = process.env) {
  return input.sessionID || input.session_id || env[SESSION_ID_ENV] || null;
}

// OpenCode plugin hooks map to Intent Broker hooks:
// session.started → SessionStart
// chat.prompt → UserPromptSubmit
// tool.execute.before → PreToolUse
// tool.execute.after → PostToolUse
// session.stopping → Stop

export async function runSessionStartedHook(
  input,
  { env = process.env, cwd = process.cwd(), homeDir, registerParticipant = registerParticipantDefault, updateWorkState = updateWorkStateDefault } = {}
) {
  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd, homeDir });
    const registration = await registerParticipant(config);
    await updateWorkState(config, { status: 'idle', summary: null });
    return { registration };
  });
}

export async function runChatPromptHook(
  input,
  { env = process.env, cwd = process.cwd(), homeDir, updateWorkState = updateWorkStateDefault } = {}
) {
  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd, homeDir });
    await updateWorkState(config, { status: 'implementing', summary: input.messageID || null });
    return null;
  });
}

export async function runToolExecuteBeforeHook(
  input,
  { env = process.env, cwd = process.cwd(), homeDir, pollInbox = pollInboxDefault, ackInbox = ackInboxDefault, loadCursorState = loadCursorStateDefault, saveCursorState = saveCursorStateDefault } = {}
) {
  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd, homeDir });
    const statePath = cursorPathForParticipant(config.participantId, homeDir);
    const state = loadCursorState(statePath);

    const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit: 20 });
    const items = inbox.items || [];

    if (items.length) {
      const lastSeenEventId = highestEventId(items);
      await ackInbox(config, lastSeenEventId);
      saveCursorState(statePath, { lastSeenEventId, recentContext: pickRecentContext(items) || state.recentContext });
      return { items };
    }
    return null;
  });
}

export async function runToolExecuteAfterHook(
  input,
  { env = process.env, cwd = process.cwd(), homeDir, updateWorkState = updateWorkStateDefault } = {}
) {
  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd, homeDir });
    await updateWorkState(config, { status: 'running', summary: input.tool || null });
    return null;
  });
}

export async function runSessionStoppingHook(
  input,
  { env = process.env, cwd = process.cwd(), homeDir, updateWorkState = updateWorkStateDefault } = {}
) {
  return safelyRunHook(async () => {
    const config = configFromHookInput(input, { env, cwd, homeDir });
    await updateWorkState(config, { status: 'offline' });
    return null;
  });
}