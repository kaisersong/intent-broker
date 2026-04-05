import { closeSync, openSync, readSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveTranscriptPath as resolveTranscriptPathDefault } from './reply-mirror.js';

function deriveProjectName({ env, cwd, sessionCwd }) {
  if (env.PROJECT_NAME) {
    return env.PROJECT_NAME;
  }

  if (sessionCwd) {
    return path.basename(sessionCwd);
  }

  if (!cwd) {
    return '';
  }

  return path.basename(cwd);
}

function readTranscriptHead(transcriptPath, { byteLimit = 32768 } = {}) {
  let fd;

  try {
    fd = openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(byteLimit);
    const bytesRead = readSync(fd, buffer, 0, byteLimit, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function extractSessionCwdFromEntries(toolName, sessionId, rawHead = '') {
  if (!rawHead) {
    return null;
  }

  for (const line of rawHead.split('\n')) {
    if (!line) {
      continue;
    }

    try {
      const entry = JSON.parse(line);

      if (
        toolName === 'codex'
        && entry?.type === 'session_meta'
        && entry?.payload?.id === sessionId
        && typeof entry?.payload?.cwd === 'string'
        && entry.payload.cwd
      ) {
        return entry.payload.cwd;
      }

      if (
        toolName === 'claude-code'
        && entry?.sessionId === sessionId
        && typeof entry?.cwd === 'string'
        && entry.cwd
      ) {
        return entry.cwd;
      }

      // xiaok sessions are stored as JSON objects with a top-level cwd field
      if (
        toolName === 'xiaok-code'
        && entry?.sessionId === sessionId
        && typeof entry?.cwd === 'string'
        && entry.cwd
      ) {
        return entry.cwd;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function resolveSessionCwdFromTranscript(
  toolName,
  sessionId,
  {
    homeDir = os.homedir(),
    resolveTranscriptPath = resolveTranscriptPathDefault
  } = {}
) {
  if (!sessionId) {
    return null;
  }

  const transcriptPath = resolveTranscriptPath(toolName, sessionId, { homeDir });
  if (!transcriptPath) {
    return null;
  }

  return extractSessionCwdFromEntries(toolName, sessionId, readTranscriptHead(transcriptPath));
}

function deriveAlias({ toolName, env }) {
  if (env.ALIAS) {
    return env.ALIAS;
  }

  const aliasMap = {
    codex: 'codex',
    'claude-code': 'claude',
    opencode: 'opencode',
    'xiaok-code': 'xiaok'
  };

  return aliasMap[toolName] || toolName.replace(/-code$/, '');
}

function deriveCapabilities({ toolName }) {
  if (toolName === 'codex' || toolName === 'claude-code' || toolName === 'xiaok-code') {
    return ['broker.auto_dispatch'];
  }

  return [];
}

export function deriveSessionBridgeConfig({
  toolName,
  env = process.env,
  cwd = process.cwd(),
  sessionCwd = null
} = {}) {
  const brokerUrl = env.BROKER_URL || 'http://127.0.0.1:4318';
  const explicitParticipantId = env.PARTICIPANT_ID;
  const threadId = env.CODEX_THREAD_ID || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || env.XIAOK_CODE_SESSION_ID || '';
  const projectName = deriveProjectName({ env, cwd, sessionCwd });
  const inboxMode = env.INTENT_BROKER_INBOX_MODE || 'pull';

  let participantId = explicitParticipantId;
  if (!participantId && threadId) {
    participantId = `${toolName}-session-${threadId.slice(0, 8)}`;
  }
  if (!participantId) {
    participantId = `${toolName}-session`;
  }

  return {
    brokerUrl,
    participantId,
    alias: deriveAlias({ toolName, env }),
    inboxMode,
    roles: ['coder'],
    capabilities: deriveCapabilities({ toolName }),
    context: projectName ? { projectName } : {}
  };
}
