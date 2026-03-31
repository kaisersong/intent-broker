import os from 'node:os';
import path from 'node:path';

import {
  ackInbox as ackInboxDefault,
  pollInbox as pollInboxDefault,
  registerParticipant as registerParticipantDefault
} from '../session-bridge/api.js';
import {
  buildCodexHookContext,
  highestEventId
} from '../session-bridge/codex-hooks.js';
import { deriveSessionBridgeConfig } from '../session-bridge/config.js';
import {
  loadCursorState as loadCursorStateDefault,
  saveCursorState as saveCursorStateDefault
} from '../session-bridge/state.js';

function configFromHookInput(input, { env = process.env, cwd = process.cwd() } = {}) {
  return deriveSessionBridgeConfig({
    toolName: 'codex',
    env: {
      ...env,
      CODEX_THREAD_ID: env.CODEX_THREAD_ID || input.session_id || ''
    },
    cwd
  });
}

function cursorPathForParticipant(participantId, homeDir = os.homedir()) {
  return path.join(homeDir, '.intent-broker', 'codex', `${participantId}.json`);
}

export async function runSessionStartHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir = os.homedir(),
    loadCursorState = loadCursorStateDefault,
    registerParticipant = registerParticipantDefault,
    pollInbox = pollInboxDefault
  } = {}
) {
  const config = configFromHookInput(input, { env, cwd });
  const statePath = cursorPathForParticipant(config.participantId, homeDir);
  const state = loadCursorState(statePath);

  await registerParticipant(config);
  const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit: 20 });
  const items = inbox.items || [];

  return buildCodexHookContext(items, { participantId: config.participantId });
}

export async function runUserPromptSubmitHook(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    homeDir = os.homedir(),
    loadCursorState = loadCursorStateDefault,
    saveCursorState = saveCursorStateDefault,
    pollInbox = pollInboxDefault,
    ackInbox = ackInboxDefault
  } = {}
) {
  if (typeof input.prompt === 'string' && input.prompt.trimStart().startsWith('/')) {
    return null;
  }

  const config = configFromHookInput(input, { env, cwd });
  const statePath = cursorPathForParticipant(config.participantId, homeDir);
  const state = loadCursorState(statePath);

  const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit: 20 });
  const items = inbox.items || [];
  const context = buildCodexHookContext(items, { participantId: config.participantId });

  if (!context) {
    return null;
  }

  const lastSeenEventId = highestEventId(items);
  saveCursorState(statePath, { lastSeenEventId });
  await ackInbox(config, lastSeenEventId);
  return context;
}
