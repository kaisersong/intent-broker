function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

async function jsonRequest(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  return response.json();
}

export async function registerParticipant(config, fetchImpl = fetch) {
  return jsonRequest(fetchImpl, `${config.brokerUrl}/participants/register`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      participantId: config.participantId,
      kind: 'agent',
      roles: config.roles,
      capabilities: config.capabilities
    })
  });
}

export async function pollInbox(config, { after = 0, limit = 50 } = {}, fetchImpl = fetch) {
  return jsonRequest(
    fetchImpl,
    `${config.brokerUrl}/inbox/${config.participantId}?after=${Number(after)}&limit=${Number(limit)}`
  );
}

export async function ackInbox(config, eventId, fetchImpl = fetch) {
  return jsonRequest(fetchImpl, `${config.brokerUrl}/inbox/${config.participantId}/ack`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ eventId: Number(eventId) })
  });
}

export async function sendTask(config, request, fetchImpl = fetch) {
  return jsonRequest(fetchImpl, `${config.brokerUrl}/intents`, {
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
  });
}

export async function sendProgress(config, request, fetchImpl = fetch) {
  return jsonRequest(fetchImpl, `${config.brokerUrl}/intents`, {
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
  });
}
