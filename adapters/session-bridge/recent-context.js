function summarizePayload(payload = {}) {
  if (payload?.body?.summary) {
    return payload.body.summary;
  }
  if (payload?.summary) {
    return payload.summary;
  }
  return '';
}

export function pickRecentContext(items = []) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item?.fromParticipantId || item.fromParticipantId === 'broker.system') {
      continue;
    }
    if (!item.taskId || !item.threadId) {
      continue;
    }

    return {
      eventId: Number(item.eventId || 0) || null,
      kind: item.kind || null,
      fromParticipantId: item.fromParticipantId,
      fromAlias: item.fromAlias ?? null,
      fromProjectName: item.fromProjectName ?? null,
      taskId: item.taskId,
      threadId: item.threadId,
      summary: summarizePayload(item.payload)
    };
  }

  return null;
}
