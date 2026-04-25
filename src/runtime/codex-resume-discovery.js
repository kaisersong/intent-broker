import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveRuntimeStatePath } from '../../adapters/hook-installer-core/state-paths.js';
import {
  resolveParticipantStatePath,
  resolveRealtimeQueueStatePath
} from '../../adapters/hook-installer-core/state-paths.js';
import {
  registerParticipant as registerParticipantDefault,
  updateWorkState as updateWorkStateDefault
} from '../../adapters/session-bridge/api.js';
import {
  deriveSessionBridgeConfig,
  resolveSessionCwdFromTranscript as resolveSessionCwdFromTranscriptDefault
} from '../../adapters/session-bridge/config.js';
import {
  ensureRealtimeBridge as ensureRealtimeBridgeDefault,
  maybeAutoDispatchRealtimeQueue as maybeAutoDispatchRealtimeQueueDefault
} from '../../adapters/session-bridge/realtime-bridge.js';
import {
  loadReplyMirrorState as loadReplyMirrorStateDefault
} from '../../adapters/session-bridge/reply-mirror.js';
import {
  loadRuntimeState as loadRuntimeStateDefault,
  saveRuntimeState as saveRuntimeStateDefault
} from '../../adapters/session-bridge/runtime-state.js';
import { ensureSessionKeeper as ensureSessionKeeperDefault } from '../../adapters/session-bridge/session-keeper.js';

const execFileDefault = promisify(execFileCallback);
const DEFAULT_INTERVAL_MS = 2000;
const SESSION_ID_PATTERN = /\bresume\s+([0-9a-f]{8}-[0-9a-f-]{27,})\b/i;
const DISCOVERY_ENV_BLOCKLIST = [
  'PORT',
  'INTENT_BROKER_DB',
  'INTENT_BROKER_CONFIG',
  'INTENT_BROKER_LOCAL_CONFIG'
];

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

function parseProcessLine(line = '') {
  const match = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!match) {
    return null;
  }

  return {
    pid: Number(match[1]),
    command: match[2]
  };
}

function normalizeCommand(command = '') {
  return String(command || '').replaceAll('\\', '/');
}

function parseWindowsProcessList(stdout = '') {
  const parsed = JSON.parse(String(stdout || 'null'));
  const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

  return items
    .map((item) => ({
      pid: Number(item?.ProcessId),
      command: typeof item?.CommandLine === 'string' ? item.CommandLine : ''
    }))
    .filter((item) => Number.isInteger(item.pid) && item.pid > 0 && item.command);
}

function isCodexResumeCandidate(command = '') {
  return /\bcodex\b/i.test(command)
    && SESSION_ID_PATTERN.test(command)
    && !/\bexec\b/i.test(command);
}

function candidateRank(command = '') {
  const normalized = normalizeCommand(command);

  if (/\/codex\/codex(?:\.exe)?\b/.test(normalized) || (/\bcodex\b/.test(normalized) && !/\bnode\b/.test(normalized))) {
    return 0;
  }
  if (/\bnode(?:\.exe)?\b/.test(normalized) && /(?:^|\s).*\/bin\/codex(?:\.js)?\b/.test(normalized)) {
    return 1;
  }
  return 2;
}

function buildDiscoveryBridgeEnv(env = {}, brokerUrl, sessionId) {
  const nextEnv = { ...env };

  for (const key of DISCOVERY_ENV_BLOCKLIST) {
    delete nextEnv[key];
  }

  nextEnv.BROKER_URL = brokerUrl;
  nextEnv.CODEX_THREAD_ID = sessionId;
  nextEnv.INTENT_BROKER_INBOX_MODE = 'realtime';

  return nextEnv;
}

function shouldResetStaleAutoDispatchRuntime(runtimeState, mirrorState) {
  return runtimeState?.status === 'running'
    && runtimeState?.source === 'auto-dispatch'
    && !mirrorState?.pending;
}

export async function discoverCodexResumeSessions({
  execFileImpl = execFileDefault
} = {}) {
  const processEntries = process.platform === 'win32'
    ? parseWindowsProcessList((await execFileImpl(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
      ],
      {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      }
    )).stdout)
    : String((await execFileImpl('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    })).stdout || '')
      .split('\n')
      .map((rawLine) => parseProcessLine(rawLine))
      .filter(Boolean);

  const sessions = new Map();

  for (const parsed of processEntries) {
    if (!parsed?.pid || !parsed.command || !isCodexResumeCandidate(parsed.command)) {
      continue;
    }

    const sessionIdMatch = parsed.command.match(SESSION_ID_PATTERN);
    const sessionId = sessionIdMatch?.[1];
    if (!sessionId) {
      continue;
    }

    const next = {
      pid: parsed.pid,
      sessionId,
      rank: candidateRank(parsed.command)
    };
    const current = sessions.get(sessionId);

    if (
      !current
      || next.rank < current.rank
      || (next.rank === current.rank && next.pid > current.pid)
    ) {
      sessions.set(sessionId, next);
    }
  }

  return [...sessions.values()]
    .sort((left, right) => left.pid - right.pid)
    .map(({ pid, sessionId }) => ({ pid, sessionId }));
}

export async function attachDiscoveredCodexSession({
  brokerUrl,
  repoRoot = process.cwd(),
  sessionId,
  parentPid,
  env = process.env,
  homeDir = os.homedir(),
  resolveSessionCwdFromTranscript = resolveSessionCwdFromTranscriptDefault,
  ensureSessionKeeper = ensureSessionKeeperDefault,
  ensureRealtimeBridge = ensureRealtimeBridgeDefault,
  registerParticipant = registerParticipantDefault,
  updateWorkState = updateWorkStateDefault,
  loadRuntimeState = loadRuntimeStateDefault,
  saveRuntimeState = saveRuntimeStateDefault,
  loadReplyMirrorState = loadReplyMirrorStateDefault,
  maybeAutoDispatchRealtimeQueue = maybeAutoDispatchRealtimeQueueDefault
} = {}) {
  if (!brokerUrl) {
    throw new Error('brokerUrl is required');
  }
  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  const sessionCwd = resolveSessionCwdFromTranscript('codex', sessionId, { homeDir }) || repoRoot;
  const bridgeEnv = buildDiscoveryBridgeEnv(env, brokerUrl, sessionId);
  const config = deriveSessionBridgeConfig({
    toolName: 'codex',
    env: bridgeEnv,
    cwd: sessionCwd,
    sessionCwd
  });
  const runtimeStatePath = resolveRuntimeStatePath('codex', config.participantId, { homeDir });
  const queueStatePath = resolveRealtimeQueueStatePath('codex', config.participantId, { homeDir });
  const cursorStatePath = resolveParticipantStatePath('codex', config.participantId, { homeDir });
  const cliPath = path.join(repoRoot, 'adapters', 'codex-plugin', 'bin', 'codex-broker.js');
  const runtimeState = loadRuntimeState(runtimeStatePath);
  const mirrorState = loadReplyMirrorState('codex', config.participantId, { homeDir });
  const resetStaleRuntime = shouldResetStaleAutoDispatchRuntime(runtimeState, mirrorState);

  if (resetStaleRuntime) {
    saveRuntimeState(runtimeStatePath, {
      ...runtimeState,
      status: 'idle',
      source: 'resume-discovery',
      taskId: null,
      threadId: null,
      updatedAt: new Date().toISOString()
    });
    await updateWorkState(config, { status: 'idle', summary: null });
  }

  await ensureSessionKeeper({
    toolName: 'codex',
    cliPath,
    config,
    sessionId,
    cwd: sessionCwd,
    env: bridgeEnv,
    homeDir,
    parentPid
  });
  await ensureRealtimeBridge({
    toolName: 'codex',
    cliPath,
    config,
    sessionId,
    cwd: sessionCwd,
    env: bridgeEnv,
    homeDir,
    parentPid
  });
  await registerParticipant(config);

  if (runtimeState.status !== 'running' && !resetStaleRuntime) {
    await updateWorkState(config, { status: 'idle', summary: null });
  }
  await maybeAutoDispatchRealtimeQueue({
    toolName: 'codex',
    config,
    sessionId,
    cwd: sessionCwd,
    env: bridgeEnv,
    queueStatePath,
    cursorStatePath,
    runtimeStatePath
  }).catch(() => null);

  return config;
}

export function createCodexResumeDiscoveryRuntime({
  brokerUrl,
  repoRoot = process.cwd(),
  env = process.env,
  homeDir = os.homedir(),
  logger = console,
  intervalMs = Number(env.INTENT_BROKER_CODEX_DISCOVERY_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  discoverSessions = discoverCodexResumeSessions,
  attachSession = attachDiscoveredCodexSession
} = {}) {
  let timer = null;
  let running = false;

  async function scanOnce() {
    if (running) {
      return;
    }
    running = true;

    try {
      const sessions = await discoverSessions();
      for (const session of sessions) {
        await attachSession({
          brokerUrl,
          repoRoot,
          sessionId: session.sessionId,
          parentPid: session.pid,
          env,
          homeDir
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(logger, 'warn', `intent-broker codex discovery: failed (${message})`);
    } finally {
      running = false;
    }
  }

  return {
    async start() {
      if (env.INTENT_BROKER_DISABLE_CODEX_DISCOVERY === '1') {
        return;
      }

      await scanOnce();
      timer = setInterval(() => {
        void scanOnce();
      }, intervalMs);
      timer.unref?.();
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}
