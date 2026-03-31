import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

function shouldFallbackToCurl(error, url) {
  const parsedUrl = new URL(url);
  const isLoopback = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost';
  return isLoopback && error?.cause?.code === 'EPERM';
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
    if (!shouldFallbackToCurl(error, url)) {
      throw error;
    }
    return curlJson(url, options, execFileImpl);
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
      context: config.context || {}
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
      payload: { body: { summary: request.summary } }
    })
  }, { fetchImpl });
}

export async function sendProgress(config, request, fetchImpl = fetch) {
  return requestJson(`${config.brokerUrl}/intents`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      intentId: request.intentId,
      kind: 'report_progress',
      fromParticipantId: config.participantId,
      taskId: request.taskId,
      threadId: request.threadId,
      to: { mode: 'broadcast' },
      payload: { stage: 'in_progress', body: { summary: request.summary } }
    })
  }, { fetchImpl });
}
