import process from 'node:process';
import readline from 'node:readline';
import { spawn as spawnDefault } from 'node:child_process';

import { requestJson as requestJsonDefault } from './api.js';

const DEFAULT_POLL_MS = 250;
const DEFAULT_RETRY_MS = 1000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HUMAN_PARTICIPANT_ID = 'human.local';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteWindowsCommandSegment(value) {
  const text = String(value ?? '');
  return /[\s"]/u.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

function buildWindowsCommandLine(command, args = []) {
  return [command, ...args].map(quoteWindowsCommandSegment).join(' ');
}

export function resolveCodexAppServerSpawn(env = process.env, platform = process.platform) {
  const configuredCommand = String(
    env.INTENT_BROKER_CODEX_NATIVE_APP_SERVER_COMMAND
      || env.INTENT_BROKER_CODEX_COMMAND
      || 'codex'
  ).trim() || 'codex';

  if (platform !== 'win32') {
    return {
      command: configuredCommand,
      args: ['app-server'],
      windowsHide: false
    };
  }

  if (configuredCommand.toLowerCase().endsWith('.exe')) {
    return {
      command: configuredCommand,
      args: ['app-server'],
      windowsHide: true
    };
  }

  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', buildWindowsCommandLine(configuredCommand, ['app-server'])],
    windowsHide: true
  };
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeIdentifier(value) {
  return String(value || Date.now()).replace(/[^A-Za-z0-9_-]/g, '-');
}

function stableStringify(value) {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function deepEqualNativeDecision(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function resolveResponseTimeoutMs(env = process.env) {
  const rawValue = env.INTENT_BROKER_CODEX_NATIVE_APPROVAL_TIMEOUT_MS;
  if (!rawValue) {
    return DEFAULT_RESPONSE_TIMEOUT_MS;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RESPONSE_TIMEOUT_MS;
}

function normalizeNativeRequestId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  return null;
}

function nativeDecisionKey(decision, index) {
  if (typeof decision === 'string' && decision.trim()) {
    return decision.trim();
  }

  if (decision && typeof decision === 'object' && !Array.isArray(decision)) {
    const [kind] = Object.keys(decision);
    if (kind) {
      return `${kind}-${index}`;
    }
  }

  return `unsupported-${index}`;
}

function nativeDecisionMode(decision) {
  if (decision === 'accept') {
    return 'yes';
  }
  if (decision === 'acceptForSession') {
    return 'always';
  }
  if (decision === 'decline') {
    return 'no';
  }
  if (decision === 'cancel') {
    return 'cancel';
  }

  return 'yes';
}

function nativeDecisionLabel(decision) {
  if (decision === 'accept') {
    return 'Allow once';
  }
  if (decision === 'acceptForSession') {
    return 'Always';
  }
  if (decision === 'decline') {
    return 'Decline';
  }
  if (decision === 'cancel') {
    return 'Cancel';
  }
  if (decision?.acceptWithExecpolicyAmendment) {
    return 'Allow with exec policy change';
  }
  if (decision?.applyNetworkPolicyAmendment) {
    return 'Allow with network policy change';
  }

  return 'Unsupported';
}

function isSupportedNativeDecision(decision) {
  return decision === 'accept'
    || decision === 'acceptForSession'
    || decision === 'decline'
    || decision === 'cancel';
}

export function buildNativeApprovalActions(availableDecisions = []) {
  return availableDecisions.map((decision, index) => {
    const supported = isSupportedNativeDecision(decision);
    return {
      key: nativeDecisionKey(decision, index),
      label: nativeDecisionLabel(decision),
      decisionMode: nativeDecisionMode(decision),
      nativeDecision: decision,
      disabled: !supported,
      unsupportedReason: supported
        ? null
        : 'HexDeck does not yet support amendment-bearing native Codex approval decisions.'
    };
  });
}

export function buildCodexNativeApprovalRequest({
  config,
  sessionId,
  ownerInstanceId,
  serverRequest
}) {
  const params = serverRequest?.params ?? {};
  const safeSessionId = safeIdentifier(sessionId || config?.participantId);
  const safeTurnId = safeIdentifier(params.turnId || 'turn');
  const safeItemId = safeIdentifier(params.itemId || normalizeNativeRequestId(serverRequest?.id) || 'item');
  const approvalId = `codex-native-${safeSessionId}-${safeTurnId}-${safeItemId}`;
  const taskId = `codex-native-approval-${safeSessionId}-${safeTurnId}-${safeItemId}`;
  const threadId = `codex-native-approval-${safeSessionId}`;
  const availableDecisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
  const createdAt = new Date().toISOString();

  return {
    approvalId,
    taskId,
    threadId,
    body: {
      intentId: `intent-${approvalId}-${Date.now()}`,
      kind: 'request_approval',
      fromParticipantId: config.participantId,
      taskId,
      threadId,
      createdAt,
      to: { mode: 'participant', participants: [DEFAULT_HUMAN_PARTICIPANT_ID] },
      payload: {
        participantId: config.participantId,
        approvalId,
        approvalScope: 'run_command',
        body: {
          summary: params.reason || 'Codex command approval requested',
          detailText: 'Resolved in-band by the live Codex native approval owner. Approval buttons preserve the native Codex decision semantics.',
          commandTitle: 'Codex',
          commandLine: params.command || '',
          commandPreview: params.cwd || ''
        },
        actions: buildNativeApprovalActions(availableDecisions),
        nativeCodexApproval: {
          sessionId: normalizeOptionalString(sessionId),
          nativeRequestId: normalizeNativeRequestId(serverRequest?.id),
          ownerInstanceId: normalizeOptionalString(ownerInstanceId),
          threadId: normalizeOptionalString(params.threadId),
          turnId: normalizeOptionalString(params.turnId),
          itemId: normalizeOptionalString(params.itemId),
          availableDecisions,
          responseTransport: 'native-app-server'
        },
        delivery: {
          semantic: 'actionable',
          source: 'codex-native-approval'
        }
      }
    }
  };
}

async function waitForApprovalResponse({
  config,
  approvalId,
  afterEventId,
  requestJson = requestJsonDefault,
  sleep: sleepImpl = sleep,
  timeoutMs = resolveResponseTimeoutMs(),
  pollMs = DEFAULT_POLL_MS
}) {
  let after = Math.max(0, Number(afterEventId || 0) - 1);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const replay = await requestJson(`${config.brokerUrl}/events/replay?after=${after}&limit=100`);
    for (const event of replay.items || []) {
      after = Math.max(after, Number(event.eventId || event.id || 0));
      if (
        (event.kind || event.type) === 'respond_approval'
        && event.payload?.approvalId === approvalId
      ) {
        return event;
      }
    }
    await sleepImpl(pollMs);
  }

  throw new Error(`timeout waiting for ${approvalId}`);
}

function resolveFallbackDecisionByMode(mode, availableDecisions = []) {
  if (mode === 'always' && availableDecisions.includes('acceptForSession')) {
    return 'acceptForSession';
  }
  if (mode === 'yes' && availableDecisions.includes('accept')) {
    return 'accept';
  }
  if (mode === 'no' && availableDecisions.includes('decline')) {
    return 'decline';
  }
  if (mode === 'cancel' && availableDecisions.includes('cancel')) {
    return 'cancel';
  }
  if (mode === 'cancel' && availableDecisions.includes('decline')) {
    return 'decline';
  }
  if (mode === 'no' && availableDecisions.includes('cancel')) {
    return 'cancel';
  }

  return null;
}

export function resolveCodexNativeDecision({
  responseEvent,
  availableDecisions = []
}) {
  const payload = responseEvent?.payload ?? {};
  const explicitNativeDecision = payload.nativeDecision;
  if (explicitNativeDecision !== undefined) {
    const matched = availableDecisions.find((decision) => deepEqualNativeDecision(decision, explicitNativeDecision));
    if (matched !== undefined) {
      return matched;
    }
    throw new Error(`unsupported nativeDecision ${stableStringify(explicitNativeDecision)}`);
  }

  const decisionMode = typeof payload.decisionMode === 'string' ? payload.decisionMode : null;
  if (decisionMode) {
    const byMode = resolveFallbackDecisionByMode(decisionMode, availableDecisions);
    if (byMode) {
      return byMode;
    }
  }

  const decision = typeof payload.decision === 'string' ? payload.decision : null;
  if (decision === 'approved') {
    return availableDecisions.includes('acceptForSession')
      && decisionMode === 'always'
      ? 'acceptForSession'
      : availableDecisions.includes('accept')
        ? 'accept'
        : null;
  }
  if (decision === 'denied') {
    return availableDecisions.includes('decline')
      ? 'decline'
      : availableDecisions.includes('cancel')
        ? 'cancel'
        : null;
  }
  if (decision === 'cancelled') {
    return availableDecisions.includes('cancel')
      ? 'cancel'
      : availableDecisions.includes('decline')
        ? 'decline'
        : null;
  }

  throw new Error(`unsupported approval response ${stableStringify(payload)}`);
}

function chooseAbortDecision(availableDecisions = []) {
  if (availableDecisions.includes('cancel')) {
    return 'cancel';
  }
  if (availableDecisions.includes('decline')) {
    return 'decline';
  }
  return null;
}

export async function mirrorCodexNativeApproval({
  config,
  sessionId,
  ownerInstanceId,
  serverRequest,
  requestJson = requestJsonDefault,
  sleep: sleepImpl = sleep,
  timeoutMs = resolveResponseTimeoutMs()
}) {
  const approval = buildCodexNativeApprovalRequest({
    config,
    sessionId,
    ownerInstanceId,
    serverRequest
  });
  const sent = await requestJson(`${config.brokerUrl}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(approval.body)
  });
  const requestEventId = sent.event?.eventId ?? sent.eventId ?? 0;
  const responseEvent = await waitForApprovalResponse({
    config,
    approvalId: approval.approvalId,
    afterEventId: requestEventId,
    requestJson,
    sleep: sleepImpl,
    timeoutMs
  });
  const availableDecisions = approval.body.payload.nativeCodexApproval.availableDecisions;
  const nativeDecision = resolveCodexNativeDecision({
    responseEvent,
    availableDecisions
  });

  return {
    approvalId: approval.approvalId,
    taskId: approval.taskId,
    threadId: approval.threadId,
    requestEventId,
    responseEventId: responseEvent.eventId,
    nativeDecision,
    serverResponse: { decision: nativeDecision }
  };
}

class CodexAppServerClient {
  constructor({
    cwd,
    env = process.env,
    spawnImpl = spawnDefault,
    onServerRequest = null,
    onNotification = null
  } = {}) {
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.onServerRequest = onServerRequest;
    this.onNotification = onNotification;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.exited = false;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  async start() {
    const spawnTarget = resolveCodexAppServerSpawn(this.env);

    this.proc = this.spawnImpl(spawnTarget.command, spawnTarget.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: spawnTarget.windowsHide === true
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.on('exit', () => {
      this.handleExit();
    });
    this.proc.on('error', (error) => {
      this.handleExit(error);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on('line', (line) => {
      this.handleLine(line);
    });

    await this.request('initialize', {
      clientInfo: {
        title: 'Intent Broker Native Approval Owner',
        name: 'Intent Broker',
        version: '0.0.0'
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: []
      }
    });
    this.notify('initialized', {});
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  request(method, params) {
    if (this.closed) {
      throw new Error('codex app-server client is closed');
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ id, method, params });
    });
  }

  send(message) {
    if (!this.proc?.stdin || this.closed) {
      return;
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(error);
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${stableStringify(message.error)}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.onNotification) {
      this.onNotification(message);
    }
  }

  async handleServerRequest(message) {
    try {
      if (!this.onServerRequest) {
        throw new Error(`unsupported ${message.method}`);
      }
      const result = await this.onServerRequest(message);
      this.send({ id: message.id, result });
    } catch (error) {
      this.send({
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  handleExit(error = null) {
    if (this.exited) {
      return;
    }

    this.exited = true;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(error ?? new Error('codex app-server connection closed'));
    }
    this.pending.clear();
    this.resolveExit?.();
  }

  async close() {
    if (this.exited) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    this.readline?.close();
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
      this.proc.kill('SIGTERM');
    } else {
      this.handleExit();
    }
    await this.exitPromise;
  }

  async waitForExit() {
    await this.exitPromise;
  }
}

export function startCodexNativeApprovalWatcher({
  config,
  sessionId,
  cwd = process.cwd(),
  env = process.env,
  requestJson = requestJsonDefault,
  sleep: sleepImpl = sleep,
  retryMs = DEFAULT_RETRY_MS,
  timeoutMs = resolveResponseTimeoutMs(env),
  spawnImpl = spawnDefault,
  onError = () => {}
} = {}) {
  let stopped = false;
  let activeClient = null;
  const ownerInstanceId = `owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const done = (async () => {
    if (!config || !sessionId) {
      return;
    }

    while (!stopped) {
      const client = new CodexAppServerClient({
        cwd,
        env,
        spawnImpl,
        onServerRequest: async (serverRequest) => {
          if (serverRequest.method !== 'item/commandExecution/requestApproval') {
            throw new Error(`unsupported ${serverRequest.method}`);
          }

          const availableDecisions = Array.isArray(serverRequest?.params?.availableDecisions)
            ? serverRequest.params.availableDecisions
            : [];

          try {
            const result = await mirrorCodexNativeApproval({
              config,
              sessionId,
              ownerInstanceId,
              serverRequest,
              requestJson,
              sleep: sleepImpl,
              timeoutMs
            });
            return result.serverResponse;
          } catch (error) {
            onError(error);
            const abortDecision = chooseAbortDecision(availableDecisions);
            if (abortDecision) {
              return { decision: abortDecision };
            }
            throw error;
          }
        }
      });

      activeClient = client;
      try {
        await client.start();
        await client.request('thread/resume', {
          threadId: sessionId,
          cwd,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          model: null,
          experimentalRawEvents: false
        });
        await client.waitForExit();
      } catch (error) {
        onError(error);
      } finally {
        await client.close().catch(() => null);
        activeClient = null;
      }

      if (!stopped) {
        await sleepImpl(retryMs);
      }
    }
  })();

  return {
    stop() {
      stopped = true;
      void activeClient?.close();
    },
    done
  };
}
