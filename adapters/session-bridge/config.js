import { closeSync, openSync, readSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

  // xiaok sessions are JSON objects, not JSONL — parse the whole file at once
  if (toolName === 'xiaok-code') {
    try {
      const doc = JSON.parse(rawHead);
      if (doc?.sessionId === sessionId && typeof doc?.cwd === 'string' && doc.cwd) {
        return doc.cwd;
      }
    } catch {
      // fall through
    }
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

function normalizeTerminalApp(termProgram) {
  const normalized = String(termProgram || '').trim();
  if (!normalized) {
    return 'unknown';
  }

  const byTermProgram = {
    ghostty: 'Ghostty',
    'iTerm.app': 'iTerm',
    Apple_Terminal: 'Terminal.app',
    WezTerm: 'WezTerm',
    WarpTerminal: 'Warp',
    vscode: 'VS Code'
  };

  return byTermProgram[normalized] || normalized;
}

function commandOutput(executablePath, execArgs, execFileSyncImpl = execFileSync) {
  try {
    return String(execFileSyncImpl(executablePath, execArgs, { encoding: 'utf8' })).trim();
  } catch {
    return null;
  }
}

function normalizeTTY(rawTTY) {
  const tty = String(rawTTY || '').trim();
  if (!tty || tty === '??' || tty === '-') {
    return null;
  }

  return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
}

export function resolveCurrentTTY({ execFileSyncImpl = execFileSync } = {}) {
  const directTTY = commandOutput('/usr/bin/tty', [], execFileSyncImpl);
  if (directTTY && !directTTY.includes('not a tty')) {
    const normalized = normalizeTTY(directTTY);
    if (normalized) {
      return normalized;
    }
  }

  if (!process.ppid) {
    return null;
  }

  return normalizeTTY(commandOutput('/bin/ps', ['-p', String(process.ppid), '-o', 'tty='], execFileSyncImpl));
}

function osascriptValues(script, execFileSyncImpl = execFileSync) {
  const output = commandOutput('/usr/bin/osascript', ['-e', script], execFileSyncImpl);
  if (!output) {
    return [];
  }

  return output.split(String.fromCharCode(31)).map((value) => value.trim());
}

export function focusedTerminalLocator(terminalApp, { execFileSyncImpl = execFileSync } = {}) {
  const normalized = String(terminalApp || '').toLowerCase();

  if (normalized.includes('ghostty')) {
    const values = osascriptValues(
      `
tell application "Ghostty"
    if not (it is running) then return ""
    tell focused terminal of selected tab of front window
        return (id as text) & (ASCII character 31) & (working directory as text) & (ASCII character 31) & (name as text)
    end tell
end tell
      `,
      execFileSyncImpl
    );
    return {
      sessionID: values[0] || null,
      workingDirectory: values[1] || null,
      tty: null,
      title: values[2] || null
    };
  }

  if (normalized.includes('terminal')) {
    const values = osascriptValues(
      `
tell application "Terminal"
    if not (it is running) then return ""
    tell selected tab of front window
        return (tty as text) & (ASCII character 31) & (custom title as text)
    end tell
end tell
      `,
      execFileSyncImpl
    );
    return {
      sessionID: null,
      workingDirectory: null,
      tty: values[0] || null,
      title: values[1] || null
    };
  }

  if (normalized.includes('iterm')) {
    const values = osascriptValues(
      `
tell application "iTerm2"
    if not (it is running) then return ""
    tell current session of current window
        return (id as text) & (ASCII character 31) & (tty as text) & (ASCII character 31) & (name as text)
    end tell
end tell
      `,
      execFileSyncImpl
    );
    return {
      sessionID: values[0] || null,
      workingDirectory: null,
      tty: values[1] || null,
      title: values[2] || null
    };
  }

  return { sessionID: null, workingDirectory: null, tty: null, title: null };
}

function deriveTerminalMetadata({ env, cwd, sessionCwd }) {
  const projectPath = sessionCwd || cwd || null;
  const terminalApp = normalizeTerminalApp(env.TERM_PROGRAM);
  const terminalTTY = resolveCurrentTTY();

  return {
    terminalApp,
    sessionHint: terminalApp === 'Terminal.app' ? terminalTTY : null,
    terminalTTY,
    projectPath
  };
}

export function enrichConfigWithFocusedTerminalLocator(
  config,
  { execFileSyncImpl = execFileSync } = {}
) {
  if (!config?.metadata?.terminalApp) {
    return config;
  }

  const locator = focusedTerminalLocator(config.metadata.terminalApp, { execFileSyncImpl });
  if (locator.tty && !config.metadata.terminalTTY) {
    config.metadata.terminalTTY = locator.tty;
  }

  const ghosttyLocatorSessionId = (() => {
    if (config.metadata.terminalApp !== 'Ghostty' || !hasStringValue(locator.sessionID)) {
      return null;
    }

    const expectedProjectPath = normalizeComparablePath(config.metadata.projectPath);
    const focusedProjectPath = normalizeComparablePath(locator.workingDirectory);
    if (expectedProjectPath && focusedProjectPath && expectedProjectPath !== focusedProjectPath) {
      return null;
    }

    return locator.sessionID;
  })();

  if (config.metadata.terminalApp === 'Ghostty' && ghosttyLocatorSessionId) {
    config.metadata.terminalSessionID = ghosttyLocatorSessionId;
    config.metadata.sessionHint = ghosttyLocatorSessionId;
    return config;
  }

  const locatorSessionHint = config.metadata.terminalApp === 'Ghostty'
    ? ghosttyLocatorSessionId
    : locator.sessionID;

  if (!config.metadata.sessionHint) {
    config.metadata.sessionHint = locatorSessionHint || locator.tty || config.metadata.terminalTTY || null;
  }

  if (!config.metadata.terminalSessionID && locatorSessionHint) {
    config.metadata.terminalSessionID = locatorSessionHint;
  }

  return config;
}

function hasStringValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeComparablePath(value) {
  if (!hasStringValue(value)) {
    return null;
  }

  const normalized = path.resolve(String(value).trim());
  return normalized.endsWith(path.sep) && normalized !== path.sep
    ? normalized.slice(0, -1)
    : normalized;
}

export function applyRuntimeMetadataToConfig(config, runtimeState) {
  if (!config) {
    return config;
  }

  const existingMetadata = config.metadata && typeof config.metadata === 'object' ? config.metadata : {};
  const nextMetadata = { ...existingMetadata };

  for (const key of ['terminalApp', 'projectPath', 'sessionHint', 'terminalTTY', 'terminalSessionID']) {
    if (!hasStringValue(nextMetadata[key]) && hasStringValue(runtimeState?.[key])) {
      nextMetadata[key] = runtimeState[key];
    }
  }

  if (
    nextMetadata.terminalApp === 'Ghostty'
    && !hasStringValue(nextMetadata.sessionHint)
    && hasStringValue(nextMetadata.terminalSessionID)
  ) {
    nextMetadata.sessionHint = nextMetadata.terminalSessionID;
  }

  if (
    nextMetadata.terminalApp === 'Terminal.app'
    && !hasStringValue(nextMetadata.sessionHint)
    && hasStringValue(nextMetadata.terminalTTY)
  ) {
    nextMetadata.sessionHint = nextMetadata.terminalTTY;
  }

  config.metadata = nextMetadata;
  return config;
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
    context: projectName ? { projectName } : {},
    metadata: deriveTerminalMetadata({ env, cwd, sessionCwd })
  };
}
