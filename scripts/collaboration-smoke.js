import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

function appendText(chunks, value) {
  if (value) {
    chunks.push(value.toString());
  }
}

function writeLog(logDir, name, content) {
  writeFileSync(join(logDir, name), content ?? '', 'utf8');
}

function writeJsonLog(logDir, name, payload) {
  writeLog(logDir, name, JSON.stringify(payload, null, 2));
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function waitForValue(description, readValue, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await readValue();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(intervalMs);
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`timeout_waiting_for:${description}`);
}

function createFakeClaudeCommand(logDir) {
  const commandPath = join(logDir, 'fake-claude.cjs');
  const invocationLogPath = join(logDir, 'fake-claude.invocations.json');

  writeJsonLog(logDir, 'fake-claude.invocations.json', []);
  writeFileSync(commandPath, `#!/usr/bin/env node
const fs = require('node:fs');

const logPath = process.env.INTENT_BROKER_SMOKE_CLAUDE_LOG;
const args = process.argv.slice(2);
let invocations = [];

try {
  invocations = JSON.parse(fs.readFileSync(logPath, 'utf8'));
} catch {
  invocations = [];
}

invocations.push({
  args,
  sessionId: args[1] || null,
  prompt: args[3] || ''
});

fs.writeFileSync(logPath, JSON.stringify(invocations, null, 2));
process.stdout.write('Smoke auto reply from Claude: verified collaboration smoke path\\n');
`, 'utf8');
  chmodSync(commandPath, 0o755);

  return {
    commandPath,
    invocationLogPath
  };
}

async function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForHealth(url, timeoutMs = 10000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore until broker is ready
    }

    await delay(100);
  }

  throw new Error(`broker_not_ready:${url}`);
}

async function runCommand({
  cwd,
  env,
  logDir,
  logPrefix,
  args,
  stdinText = ''
}) {
  return new Promise((resolveResult, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        ...env
      }
    });

    child.stdout.on('data', (chunk) => appendText(stdoutChunks, chunk));
    child.stderr.on('data', (chunk) => appendText(stderrChunks, chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      writeLog(logDir, `${logPrefix}.stdout.log`, stdout);
      writeLog(logDir, `${logPrefix}.stderr.log`, stderr);

      if (code !== 0) {
        reject(new Error(`${logPrefix}_failed:${code}\n${stderr}`));
        return;
      }

      resolveResult({ stdout, stderr });
    });

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

function spawnBroker({ repoRoot, port, dbPath, logDir }) {
  const configPath = join(logDir, 'intent-broker.smoke.config.json');
  const localConfigPath = join(logDir, 'intent-broker.smoke.local.json');
  writeJsonLog(logDir, 'intent-broker.smoke.config.json', {
    server: {
      host: '127.0.0.1',
      port,
      dbPath
    },
    channels: {}
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn(process.execPath, ['--experimental-sqlite', 'src/cli.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      INTENT_BROKER_DB: dbPath,
      INTENT_BROKER_CONFIG: configPath,
      INTENT_BROKER_LOCAL_CONFIG: localConfigPath
    }
  });

  child.stdout.on('data', (chunk) => appendText(stdoutChunks, chunk));
  child.stderr.on('data', (chunk) => appendText(stderrChunks, chunk));

  function flushLogs() {
    writeLog(logDir, 'broker.stdout.log', stdoutChunks.join(''));
    writeLog(logDir, 'broker.stderr.log', stderrChunks.join(''));
  }

  child.stdout.on('data', flushLogs);
  child.stderr.on('data', flushLogs);
  child.on('close', flushLogs);
  child.on('error', flushLogs);

  return {
    child,
    flushLogs
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();

  if (!response.ok) {
    throw new Error(`http_${response.status}:${url}\n${JSON.stringify(body)}`);
  }

  return body;
}

function parseJson(text) {
  return text.trim() ? JSON.parse(text) : null;
}

function buildAnalysis(summary) {
  const claudeState = summary.finalWorkStates.find((item) => item.participantId === summary.claudeParticipantId);
  const codexState = summary.finalWorkStates.find((item) => item.participantId === summary.codexParticipantId);

  return [
    '# Collaboration Smoke Analysis',
    '',
    '## Result',
    '',
    '- Codex and Claude Code both auto-registered through their real hook entrypoints.',
    '- Both sessions were immediately discoverable in the same project via `projectName=intent-broker` and reached websocket-online presence.',
    '- Claude Code received the Codex task through the realtime bridge auto-dispatch path.',
    '- The realtime bridge invoked the configured Claude command once, captured its plain-text reply, and sent that reply back through broker as `report_progress`.',
    '- Claude Code returned to `idle` after the automatic reply, so the session remained ready for the next command.',
    '',
    '## Final State',
    '',
    `- Codex state: ${codexState?.status || 'missing'}`,
    `- Claude Code state: ${claudeState?.status || 'missing'}`,
    `- Thread events: ${summary.thread.events.map((event) => event.kind).join(' -> ')}`,
    '',
    '## Log Reading',
    '',
    '- `broker.stdout.log`: broker startup and server binding.',
    '- `codex.session-start.stdout.log`: Codex hook output after silent auto-registration.',
    '- `claude.session-start.stdout.log`: Claude Code hook output after silent auto-registration.',
    '- `codex.send-task.stdout.log`: broker accepted the Codex task handoff and reported realtime delivery.',
    '- `fake-claude.invocations.json`: realtime bridge invocation record, including session id and prompt sent to Claude.'
  ].join('\n');
}

export async function runCollaborationSmoke({ repoRoot, logDir } = {}) {
  const resolvedRepoRoot = resolve(repoRoot || process.cwd());
  const resolvedLogDir = resolve(logDir || join(resolvedRepoRoot, '.tmp', `collaboration-smoke-${Date.now()}`));
  mkdirSync(resolvedLogDir, { recursive: true });
  const runId = randomUUID().slice(0, 8);
  const codexParticipantId = `codex-smoke-${runId}`;
  const claudeParticipantId = `claude-smoke-${runId}`;
  const homeDir = join(resolvedLogDir, '.home');
  mkdirSync(homeDir, { recursive: true });
  const fakeClaude = createFakeClaudeCommand(resolvedLogDir);

  const port = await getFreePort();
  const brokerUrl = `http://127.0.0.1:${port}`;
  const dbPath = join(resolvedLogDir, 'intent-broker.db');
  const broker = spawnBroker({
    repoRoot: resolvedRepoRoot,
    port,
    dbPath,
    logDir: resolvedLogDir
  });

  try {
    await waitForHealth(`${brokerUrl}/health`);

    const baseEnv = {
      BROKER_URL: brokerUrl,
      PROJECT_NAME: 'intent-broker',
      HOME: homeDir,
      INTENT_BROKER_CLAUDE_COMMAND: fakeClaude.commandPath,
      INTENT_BROKER_SMOKE_CLAUDE_LOG: fakeClaude.invocationLogPath
    };

    const codexSessionStart = await runCommand({
      cwd: resolvedRepoRoot,
      env: {
        ...baseEnv,
        PARTICIPANT_ID: codexParticipantId
      },
      logDir: resolvedLogDir,
      logPrefix: 'codex.session-start',
      args: ['adapters/codex-plugin/bin/codex-broker.js', 'hook', 'session-start'],
      stdinText: JSON.stringify({ session_id: 'codex-smoke-session-1' })
    });

    const claudeSessionStart = await runCommand({
      cwd: resolvedRepoRoot,
      env: {
        ...baseEnv,
        PARTICIPANT_ID: claudeParticipantId
      },
      logDir: resolvedLogDir,
      logPrefix: 'claude.session-start',
      args: ['adapters/claude-code-plugin/bin/claude-code-broker.js', 'hook', 'session-start'],
      stdinText: JSON.stringify({ session_id: 'claude-smoke-session-1' })
    });

    const participants = await requestJson(`${brokerUrl}/participants?projectName=intent-broker`);
    writeJsonLog(resolvedLogDir, 'broker.participants.json', participants);

    const initialWorkStates = await requestJson(`${brokerUrl}/work-state?projectName=intent-broker`);
    writeJsonLog(resolvedLogDir, 'broker.work-state.initial.json', initialWorkStates);

    const realtimePresence = await waitForValue(
      'codex and claude websocket presence',
      async () => {
        const [codexPresence, claudePresence] = await Promise.all([
          requestJson(`${brokerUrl}/presence/${codexParticipantId}`),
          requestJson(`${brokerUrl}/presence/${claudeParticipantId}`)
        ]);

        if (
          codexPresence?.status === 'online'
          && codexPresence?.metadata?.transport === 'websocket'
          && claudePresence?.status === 'online'
          && claudePresence?.metadata?.transport === 'websocket'
        ) {
          return { codexPresence, claudePresence };
        }

        return null;
      },
      { timeoutMs: 5000, intervalMs: 100 }
    );
    writeJsonLog(resolvedLogDir, 'broker.presence.realtime.json', realtimePresence);

    const codexSendTask = await runCommand({
      cwd: resolvedRepoRoot,
      env: {
        ...baseEnv,
        PARTICIPANT_ID: codexParticipantId
      },
      logDir: resolvedLogDir,
      logPrefix: 'codex.send-task',
      args: [
        'adapters/codex-plugin/bin/codex-broker.js',
        'send-task',
        claudeParticipantId,
        'smoke-task-1',
        'smoke-thread-1',
        'Please verify the collaboration smoke path'
      ]
    });

    const claudeAutoDispatchInvocations = await waitForValue(
      'claude auto-dispatch invocation',
      async () => {
        const invocations = readJsonFile(fakeClaude.invocationLogPath, []);
        return invocations.length ? invocations : null;
      },
      { timeoutMs: 5000, intervalMs: 100 }
    );

    const threadResponse = await waitForValue(
      'claude auto-reply in thread',
      async () => {
        const value = await requestJson(`${brokerUrl}/threads/smoke-thread-1`);
        const progressEvent = value?.thread?.events?.find(
          (event) => event.kind === 'report_progress' && event.fromParticipantId === claudeParticipantId
        );
        return progressEvent ? value : null;
      },
      { timeoutMs: 5000, intervalMs: 100 }
    );

    const finalWorkStates = await waitForValue(
      'claude returned to idle',
      async () => {
        const value = await requestJson(`${brokerUrl}/work-state?projectName=intent-broker`);
        const claudeState = value?.items?.find((item) => item.participantId === claudeParticipantId);
        return claudeState?.status === 'idle' ? value : null;
      },
      { timeoutMs: 5000, intervalMs: 100 }
    );
    writeJsonLog(resolvedLogDir, 'broker.work-state.final.json', finalWorkStates);

    const thread = threadResponse;
    writeJsonLog(resolvedLogDir, 'broker.thread.json', thread);

    const replay = await requestJson(`${brokerUrl}/events/replay?threadId=smoke-thread-1&after=0`);
    writeJsonLog(resolvedLogDir, 'broker.replay.json', replay);

    const summary = {
      projectName: 'intent-broker',
      brokerUrl,
      logDir: resolvedLogDir,
      homeDir,
      codexParticipantId,
      claudeParticipantId,
      participants: participants.participants,
      initialWorkStates: initialWorkStates.items,
      finalWorkStates: finalWorkStates.items,
      thread: thread.thread,
      replayItems: replay.items,
      realtimePresence,
      codexSessionStart: parseJson(codexSessionStart.stdout),
      claudeSessionStart: parseJson(claudeSessionStart.stdout),
      codexSendTask: parseJson(codexSendTask.stdout),
      claudeAutoDispatchInvocations
    };

    writeJsonLog(resolvedLogDir, 'summary.json', summary);
    writeLog(resolvedLogDir, 'analysis.md', buildAnalysis(summary));
    return summary;
  } finally {
    broker.child.kill('SIGTERM');
    await new Promise((resolveClose) => broker.child.once('close', resolveClose));
    broker.flushLogs();
  }
}
