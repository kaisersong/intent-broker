function summarizePayload(payload = {}) {
  if (payload?.body?.summary) {
    return payload.body.summary;
  }
  if (payload?.summary) {
    return payload.summary;
  }
  return '';
}

export function summarizeInboxItems(items = []) {
  if (!items.length) {
    return '0 new broker events.';
  }

  const lines = [`${items.length} new broker event${items.length === 1 ? '' : 's'}:`];
  for (const item of items) {
    const summary = summarizePayload(item.payload);
    const sender = item.fromAlias || item.fromParticipantId || 'unknown';
    const parts = [`- ${item.kind} from ${sender}`];
    if (item.fromProjectName) {
      parts.push(`[project=${item.fromProjectName}]`);
    }
    if (item.taskId) {
      parts.push(`task=${item.taskId}`);
    }
    if (item.threadId) {
      parts.push(`thread=${item.threadId}`);
    }
    if (summary) {
      parts.push(`- ${summary}`);
    }
    lines.push(parts.join(' '));
  }

  return lines.join('\n');
}

export function buildToolHookContext(items = [], { participantId, sessionLabel = 'session' } = {}) {
  if (!items.length) {
    return null;
  }

  return [
    `Intent Broker update for ${participantId || `this ${sessionLabel}`}:`,
    summarizeInboxItems(items),
    'If relevant, respond in this turn or continue the newly assigned work.'
  ].join('\n');
}

export function buildCodexHookContext(items = [], { participantId } = {}) {
  return buildToolHookContext(items, {
    participantId,
    sessionLabel: 'Codex session'
  });
}

export function buildCodexHookOutput(hookEventName, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext
    }
  };
}

export function highestEventId(items = []) {
  return items.reduce((max, item) => Math.max(max, Number(item?.eventId || 0)), 0);
}
