import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { resolveToolStateRoot } from '../../adapters/hook-installer-core/state-paths.js';
import { deriveSessionBridgeConfig, resolveSessionCwdFromTranscript as resolveSessionCwdFromTranscriptDefault } from '../../adapters/session-bridge/config.js';
import { registerParticipant as registerParticipantDefault } from '../../adapters/session-bridge/api.js';
import { isProcessAlive as isProcessAliveDefault } from '../../adapters/session-bridge/session-keeper.js';

const REFRESHABLE_TOOLS = ['codex', 'claude-code', 'xiaok-code'];

function log(logger, level, message) {
  const fn = logger?.[level];
  if (typeof fn === 'function') {
    fn.call(logger, message);
    return;
  }

  if (typeof logger?.log === 'function') {
    logger.log(message);
  }
}

function readJsonFile(filePath, readFileSyncImpl = readFileSync) {
  try {
    return JSON.parse(readFileSyncImpl(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function resolveTerminalTTYFromPid(
  pid,
  { execFileSyncImpl = execFileSync } = {}
) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) {
    return null;
  }

  try {
    const tty = String(
      execFileSyncImpl('ps', ['-o', 'tty=', '-p', String(normalizedPid)], { encoding: 'utf8' })
    ).trim();

    if (!tty || tty === '??') {
      return null;
    }

    return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
  } catch {
    return null;
  }
}

export function appendAliasToTTYTitle({ ttyPath, alias, projectName }) {
  if (!ttyPath || !alias) {
    return false;
  }

  const title = projectName ? `${projectName} · @${alias}` : `@${alias}`;
  writeFileSync(ttyPath, `\u001b]0;${title}\u0007`);
  return true;
}

function buildRefreshEnv(session, env = {}) {
  const nextEnv = {
    ...env,
    BROKER_URL: session.brokerUrl,
    PARTICIPANT_ID: session.participantId,
    INTENT_BROKER_INBOX_MODE: session.inboxMode || 'pull'
  };

  if (session.alias) {
    nextEnv.ALIAS = session.alias;
  } else {
    delete nextEnv.ALIAS;
  }

  if (session.toolName === 'codex') {
    nextEnv.CODEX_THREAD_ID = session.sessionId;
  }
  if (session.toolName === 'claude-code') {
    nextEnv.CLAUDE_CODE_SESSION_ID = session.sessionId;
  }
  if (session.toolName === 'xiaok-code') {
    nextEnv.XIAOK_CODE_SESSION_ID = session.sessionId;
  }

  return nextEnv;
}

export function listPersistedAgentSessions({
  toolNames = REFRESHABLE_TOOLS,
  homeDir = os.homedir(),
  readdirSyncImpl = readdirSync,
  readFileSyncImpl = readFileSync,
  isProcessAliveImpl = isProcessAliveDefault
} = {}) {
  const sessions = [];

  for (const toolName of toolNames) {
    const stateRoot = resolveToolStateRoot(toolName, { homeDir });

    let names = [];
    try {
      names = readdirSyncImpl(stateRoot);
    } catch {
      continue;
    }

    for (const fileName of names) {
      if (!fileName.endsWith('.keeper.json')) {
        continue;
      }

      const participantId = fileName.slice(0, -'.keeper.json'.length);
      const keeperState = readJsonFile(path.join(stateRoot, fileName), readFileSyncImpl);
      if (!keeperState?.pid || !isProcessAliveImpl(keeperState.pid) || !keeperState?.sessionId) {
        continue;
      }

      const runtimeState = readJsonFile(path.join(stateRoot, `${participantId}.runtime.json`), readFileSyncImpl);

      sessions.push({
        toolName,
        participantId,
        sessionId: keeperState.sessionId,
        alias: typeof runtimeState?.alias === 'string' && runtimeState.alias ? runtimeState.alias : null,
        terminalApp: typeof runtimeState?.terminalApp === 'string' ? runtimeState.terminalApp : null,
        projectPath: typeof runtimeState?.projectPath === 'string' ? runtimeState.projectPath : null,
        sessionHint: typeof runtimeState?.sessionHint === 'string' ? runtimeState.sessionHint : null,
        terminalTTY: typeof runtimeState?.terminalTTY === 'string' ? runtimeState.terminalTTY : null,
        terminalSessionID: typeof runtimeState?.terminalSessionID === 'string' ? runtimeState.terminalSessionID : null,
        brokerUrl: keeperState.brokerUrl || 'http://127.0.0.1:4318',
        inboxMode: keeperState.inboxMode || 'pull',
        pid: keeperState.pid,
        parentPid: normalizePid(keeperState.parentPid)
      });
    }
  }

  return sessions;
}

export async function refreshPersistedAgentSessions({
  repoRoot = process.cwd(),
  env = process.env,
  brokerUrl = env.BROKER_URL || 'http://127.0.0.1:4318',
  homeDir = os.homedir(),
  logger = console,
  listSessions = listPersistedAgentSessions,
  resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault,
  registerParticipant = registerParticipantDefault,
  resolveTerminalTTYFromPid: resolveTerminalTTYFromPidImpl = resolveTerminalTTYFromPid,
  appendAliasToTTYTitle: appendAliasToTTYTitleImpl = appendAliasToTTYTitle
} = {}) {
  const sessions = listSessions({ homeDir });
  const refreshed = [];

  for (const session of sessions) {
    const sessionCwd = resolveSessionCwdFromTranscript(session.toolName, session.sessionId, { homeDir }) || repoRoot;
    const config = deriveSessionBridgeConfig({
      toolName: session.toolName,
      env: buildRefreshEnv({ ...session, brokerUrl }, env),
      cwd: sessionCwd,
      sessionCwd
    });
    const effectiveAlias = config.alias || session.alias || null;
    const terminalTTY = resolveTerminalTTYFromPidImpl(session.parentPid ?? session.pid);

    config.metadata = {
      ...(config.metadata || {}),
      ...(session.terminalApp ? { terminalApp: session.terminalApp } : {}),
      ...(session.projectPath ? { projectPath: session.projectPath } : {}),
      ...(session.sessionHint ? { sessionHint: session.sessionHint } : {}),
      ...(session.terminalTTY ? { terminalTTY: session.terminalTTY } : {}),
      ...(session.terminalSessionID ? { terminalSessionID: session.terminalSessionID } : {})
    };

    if (terminalTTY && !config.metadata.terminalTTY) {
      config.metadata.terminalTTY = terminalTTY;
    }

    if (
      config.metadata?.terminalApp === 'Ghostty'
      && !config.metadata.sessionHint
      && config.metadata.terminalSessionID
    ) {
      config.metadata.sessionHint = config.metadata.terminalSessionID;
    }

    if (
      config.metadata?.terminalApp === 'Terminal.app'
      && !config.metadata.sessionHint
      && config.metadata.terminalTTY
    ) {
      config.metadata.sessionHint = config.metadata.terminalTTY;
    }

    if (terminalTTY && effectiveAlias) {
      try {
        appendAliasToTTYTitleImpl({
          ttyPath: terminalTTY,
          alias: effectiveAlias,
          projectName: config.context?.projectName || ''
        });
      } catch {
        // best effort only
      }
    }

    try {
      await registerParticipant(config);
      refreshed.push(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        logger,
        'warn',
        `intent-broker persisted session refresh: ${session.participantId}=failed (${message})`
      );
    }
  }

  log(logger, 'log', `intent-broker persisted session refresh: ${refreshed.length} session(s)`);
  return refreshed;
}
