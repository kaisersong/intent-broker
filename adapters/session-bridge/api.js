import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);
const CONNECTIVITY_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT', 'EPERM']);
const CURL_COULD_NOT_CONNECT_EXIT_CODE = 7;

export class BrokerUnavailableError extends Error {
  constructor(url, { cause } = {}) {
    const brokerUrl = new URL(url).origin;
    super(`intent_broker_unavailable:${brokerUrl}`, cause ? { cause } : undefined);
    this.name = 'BrokerUnavailableError';
    this.code = 'INTENT_BROKER_UNAVAILABLE';
    this.brokerUrl = brokerUrl;
  }
}

function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

function normalizeDelivery(delivery, defaults) {
  return {
    semantic: delivery?.semantic ?? defaults.semantic,
    source: delivery?.source ?? defaults.source
  };
}

function shouldFallbackToCurl(error, url) {
  const parsedUrl = new URL(url);
  const isLoopback = LOOPBACK_HOSTNAMES.has(parsedUrl.hostname);
  return isLoopback && error?.cause?.code === 'EPERM';
}

function isLoopbackUrl(url) {
  return LOOPBACK_HOSTNAMES.has(new URL(url).hostname);
}

function shouldWrapFetchConnectivityError(error, url) {
  if (!isLoopbackUrl(url) || error?.message !== 'fetch failed') {
    return false;
  }

  const causeCode = error?.cause?.code;
  return !causeCode || CONNECTIVITY_ERROR_CODES.has(causeCode);
}

function shouldWrapCurlConnectivityError(error, url) {
  return isLoopbackUrl(url) && error?.code === CURL_COULD_NOT_CONNECT_EXIT_CODE;
}

function asBrokerUnavailableError(url, cause) {
  if (cause instanceof BrokerUnavailableError) {
    return cause;
  }

  return new BrokerUnavailableError(url, { cause });
}

export function isBrokerUnavailableError(error) {
  return error?.code === 'INTENT_BROKER_UNAVAILABLE';
}

async function curlJson(url, options = {}, execFileImpl = execFile) {
  const args = ['-s'];

  if (options.method && options.method !== 'GET') {
    args.push('-X', options.method);
  }
  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      args.push('-H', `${key}: ${value}`);
    }
  }
  if (options.body) {
    args.push('--data', options.body);
  }

  args.push(url);
  const { stdout } = await execFileImpl('curl', args, { encoding: 'utf8' });
  return JSON.parse(stdout);
}

export async function requestJson(
  url,
  options = {},
  { fetchImpl = fetch, execFileImpl = execFile } = {}
) {
  try {
    const response = await fetchImpl(url, options);
    return response.json();
  } catch (error) {
    if (shouldFallbackToCurl(error, url)) {
      try {
        return await curlJson(url, options, execFileImpl);
      } catch (curlError) {
        if (shouldWrapCurlConnectivityError(curlError, url)) {
          throw asBrokerUnavailableError(url, curlError);
        }
        throw curlError;
      }
    }

    if (shouldWrapFetchConnectivityError(error, url)) {
      throw asBrokerUnavailableError(url, error);
    }

    throw error;
  }
}

export async function registerParticipant(config, fetchImpl = fetch) {
  return requestJson(`${config.brokerUrl}/participants/register`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      participantId: config.participantId,
      kind: 'agent',
      roles: config.roles,
      capabilities: config.capabilities,
      alias: config.alias,
      context: config.context || {},
      inboxMode: config.inboxMode ?? 'pull'
    })
  }, { fetchImpl });
}

export async function pollInbox(config, { after = 0, limit = 50 } = {}, fetchImpl = fetch) {
  return requestJson(
    `${config.brokerUrl}/inbox/${config.participantId}?after=${Number(after)}&limit=${Number(limit)}`,
    {},
    { fetchImpl }
  );
}

export async function ackInbox(config, eventId, fetchImpl = fetch) {
  return requestJson(`${config.brokerUrl}/inbox/${config.participantId}/ack`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ eventId: Number(eventId) })
  }, { fetchImpl });
}

export async function updateWorkState(config, state, fetchImpl = fetch) {
  return requestJson(`${config.brokerUrl}/participants/${config.participantId}/work-state`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      status: state.status,
      summary: state.summary,
      taskId: state.taskId,
      threadId: state.threadId
    })
  }, { fetchImpl });
}

export async function updatePresence(config, status, metadata = {}, fetchImpl = fetch) {
  return requestJson(`${config.brokerUrl}/presence/${config.participantId}`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      status,
      metadata
    })
  }, { fetchImpl });
}

export async function listWorkStates(config, filters = {}, fetchImpl = fetch) {
  const params = new URLSearchParams();
  if (filters.projectName) {
    params.set('projectName', filters.projectName);
  }
  if (filters.participantId) {
    params.set('participantId', filters.participantId);
  }
  if (filters.status) {
    params.set('status', filters.status);
  }

  const query = params.toString();
  const suffix = query ? `?${query}` : '';

  return requestJson(`${config.brokerUrl}/work-state${suffix}`, {}, { fetchImpl });
}

export async function listParticipants(config, filters = {}, fetchImpl = fetch) {
  const params = new URLSearchParams();
  if (filters.projectName) {
    params.set('projectName', filters.projectName);
  }

  const query = params.toString();
  const suffix = query ? `?${query}` : '';

  return requestJson(`${config.brokerUrl}/participants${suffix}`, {}, { fetchImpl });
}

export async function resolveParticipantAliases(config, aliases = [], fetchImpl = fetch) {
  const filtered = aliases.map((item) => String(item || '').trim().replace(/^@+/, '')).filter(Boolean);
  const params = new URLSearchParams();
  params.set('aliases', filtered.join(','));
  return requestJson(`${config.brokerUrl}/participants/resolve?${params.toString()}`, {}, { fetchImpl });
}

export async function sendTask(config, request, fetchImpl = fetch) {
  return requestJson(`${config.brokerUrl}/intents`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      intentId: request.intentId,
      kind: 'request_task',
      fromParticipantId: config.participantId,
      taskId: request.taskId,
      threadId: request.threadId,
      to: { mode: 'participant', participants: [request.toParticipantId] },
      payload: {
        body: { summary: request.summary },
        delivery: normalizeDelivery(request.delivery, {
          semantic: 'actionable',
          source: 'default'
        })
      }
    })
  }, { fetchImpl });
}

export async function sendAsk(config, request, fetchImpl = fetch) {
  return requestJson(`${config.brokerUrl}/intents`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      intentId: request.intentId,
      kind: 'ask_clarification',
      fromParticipantId: config.participantId,
      taskId: request.taskId,
      threadId: request.threadId,
      to: { mode: 'participant', participants: [request.toParticipantId] },
      payload: {
        body: { summary: request.summary },
        delivery: normalizeDelivery(request.delivery, {
          semantic: 'actionable',
          source: 'default'
        })
      }
    })
  }, { fetchImpl });
}

export async function sendProgress(config, request, fetchImpl = fetch) {
  const to = request.toParticipantId
    ? { mode: 'participant', participants: [request.toParticipantId] }
    : request.toParticipantIds?.length
      ? { mode: 'participant', participants: request.toParticipantIds }
      : { mode: 'broadcast' };

  return requestJson(`${config.brokerUrl}/intents`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      intentId: request.intentId,
      kind: 'report_progress',
      fromParticipantId: config.participantId,
      taskId: request.taskId,
      threadId: request.threadId,
      to,
      payload: {
        stage: 'in_progress',
        body: { summary: request.summary },
        ...(request.metadata ? { metadata: request.metadata } : {}),
        delivery: normalizeDelivery(request.delivery, {
          semantic: 'informational',
          source: 'default'
        })
      }
    })
  }, { fetchImpl });
}
