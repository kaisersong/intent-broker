function summarizePayload(payload = {}) {
  if (payload?.body?.summary) {
    return payload.body.summary;
  }
  if (payload?.summary) {
    return payload.summary;
  }
  return '';
}

function deliverySemanticForItem(item = {}) {
  if (item?.payload?.delivery?.semantic === 'actionable') {
    return 'actionable';
  }
  if (
    item?.kind === 'request_task'
    || item?.kind === 'ask_clarification'
    || item?.kind === 'request_approval'
  ) {
    return 'actionable';
  }
  return 'informational';
}

function isPresenceUpdate(item = {}) {
  return item?.kind === 'participant_presence_updated';
}

function summarizePresenceItems(items = [], { limit = 8 } = {}) {
  if (!items.length) {
    return '';
  }

  const latestByParticipant = new Map();
  for (const item of items) {
    const participantId = item?.payload?.participantId || item?.participantId || String(item?.eventId || '');
    const existing = latestByParticipant.get(participantId);
    if (!existing || Number(item?.eventId || 0) >= Number(existing?.eventId || 0)) {
      latestByParticipant.set(participantId, item);
    }
  }

  const latestItems = [...latestByParticipant.values()]
    .sort((left, right) => Number(left?.eventId || 0) - Number(right?.eventId || 0));
  const visibleItems = latestItems.slice(-limit);
  const hiddenCount = latestItems.length - visibleItems.length;
  const lines = [
    `${items.length} broker presence update${items.length === 1 ? '' : 's'} collapsed into ${latestItems.length} latest collaborator state${latestItems.length === 1 ? '' : 's'}:`
  ];

  for (const item of visibleItems) {
    const summary = summarizePayload(item.payload);
    if (summary) {
      lines.push(`- ${summary}`);
    }
  }

  if (hiddenCount > 0) {
    lines.push(`- ... and ${hiddenCount} more collaborator state update${hiddenCount === 1 ? '' : 's'}`);
  }
  lines.push('Use `intent-broker who` if you need the full live roster.');

  return lines.join('\n');
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

  const actionable = items.filter((item) => deliverySemanticForItem(item) === 'actionable');
  const informational = items.filter((item) => deliverySemanticForItem(item) !== 'actionable');
  const presenceUpdates = informational.filter(isPresenceUpdate);
  const otherInformational = informational.filter((item) => !isPresenceUpdate(item));
  const lines = [`Intent Broker update for ${participantId || `this ${sessionLabel}`}:`];

  if (actionable.length) {
    lines.push('Actionable items:');
    lines.push(summarizeInboxItems(actionable));
    lines.push('Treat the actionable items as commands or blocking asks. Execute them in this turn unless you have a clear reason not to.');
  }

  if (otherInformational.length || presenceUpdates.length) {
    lines.push('Informational items:');
    if (otherInformational.length) {
      lines.push(summarizeInboxItems(otherInformational));
    }
    if (presenceUpdates.length) {
      lines.push(summarizePresenceItems(presenceUpdates));
    }
    lines.push('Informational items are context updates by default. Acknowledge or use them only when relevant.');
  }

  return lines.join('\n');
}

export function buildToolAutoContinuePrompt(items = [], { participantId, sessionLabel = 'session' } = {}) {
  const context = buildToolHookContext(items, { participantId, sessionLabel });
  if (!context) {
    return null;
  }

  return [
    `Intent Broker auto-continue for ${participantId || `this ${sessionLabel}`}.`,
    'The previous turn has completed. Continue immediately with the actionable items below without waiting for new local user input.',
    context
  ].join('\n');
}

export function buildCodexHookContext(items = [], { participantId } = {}) {
  return buildToolHookContext(items, {
    participantId,
    sessionLabel: 'Codex session'
  });
}

export function buildCodexAutoContinuePrompt(items = [], { participantId } = {}) {
  return buildToolAutoContinuePrompt(items, {
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
