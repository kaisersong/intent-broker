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
import { resolveParticipantStatePath } from '../hook-installer-core/state-paths.js';

function configFromHookInput(input, { env = process.env, cwd = process.cwd() } = {}) {
  const sessionId = input.session_id || env.CLAUDE_CODE_SESSION_ID || '';
  return deriveSessionBridgeConfig({
    toolName: 'claude-code',
    env: {
      ...env,
      CLAUDE_CODE_SESSION_ID: sessionId
    },
    cwd
  });
}

function cursorPathForParticipant(participantId, homeDir) {
  return resolveParticipantStatePath('claude-code', participantId, { homeDir });
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
    loadCursorState = loadCursorStateDefault,
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
    const state = loadCursorState(statePath);

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
    saveCursorState(statePath, {
      lastSeenEventId,
      recentContext: pickRecentContext(items) || state.recentContext
    });
    await ackInbox(config, lastSeenEventId);
    return context;
  });
}
