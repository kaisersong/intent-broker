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

  const tags = visibleItems.map((item) => summarizePayload(item.payload)).filter(Boolean);
  if (hiddenCount > 0) {
    tags.push(`+${hiddenCount} more`);
  }
  return tags.join(', ');
}

function stripMarkdown(text = '') {
  return text
    .replace(/#{1,6}\s+/g, '')
    .replace(/---+/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[-_]{3,}/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

function truncateSummary(text = '', maxLen = 60) {
  if (!text || text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen).trimEnd() + '...';
}

export function summarizeInboxItems(items = [], { maxItems = Infinity, maxSummaryLength = Infinity, compact = false } = {}) {
  if (!items.length) {
    return '0 new broker events.';
  }

  const lines = [`${items.length} new broker event${items.length === 1 ? '' : 's'}:`];
  const visible = maxItems < Infinity ? items.slice(0, maxItems) : items;
  const hidden = items.length - visible.length;

  for (const item of visible) {
    const summary = truncateSummary(maxSummaryLength < Infinity
      ? stripMarkdown(summarizePayload(item.payload))
      : summarizePayload(item.payload), maxSummaryLength);
    const sender = item.fromAlias || item.fromParticipantId || 'unknown';
    const parts = [`- ${item.kind} from ${sender}`];
    if (item.fromProjectName) {
      parts.push(`[project=${item.fromProjectName}]`);
    }
    if (!compact) {
      if (item.taskId) {
        parts.push(`task=${item.taskId}`);
      }
      if (item.threadId) {
        parts.push(`thread=${item.threadId}`);
      }
    }
    if (summary) {
      parts.push(compact ? `— ${summary}` : `- ${summary}`);
    }
    lines.push(parts.join(' '));
  }

  if (hidden > 0) {
    lines.push(`- ... and ${hidden} more`);
  }

  return lines.join('\n');
}

export function buildToolHookContext(
  items = [],
  {
    participantId,
    alias = null,
    sessionLabel = 'session',
    actionableReplyStyle = 'explicit'
  } = {}
) {
  if (!items.length && !alias) {
    return null;
  }

  const lines = [];
  if (alias) {
    lines.push(`Intent Broker: this session is @${alias} (${participantId || sessionLabel})`);
  }
  if (!items.length) {
    return lines.join('\n') || null;
  }

  lines.push(`Intent Broker update for ${participantId || `this ${sessionLabel}`}:`);

  const actionable = items.filter((item) => deliverySemanticForItem(item) === 'actionable');
  const informational = items.filter((item) => deliverySemanticForItem(item) !== 'actionable');
  const presenceUpdates = informational.filter(isPresenceUpdate);
  const otherInformational = informational.filter((item) => !isPresenceUpdate(item));

  if (actionable.length) {
    lines.push('Actionable items:');
    lines.push(summarizeInboxItems(actionable));
    lines.push('Treat the actionable items as commands or blocking asks. Execute them in this turn unless you have a clear reason not to.');
    if (actionableReplyStyle === 'mirror') {
      lines.push('If an actionable item expects a response, write that response as your final response in this turn.');
      lines.push('The stop hook will auto-mirror your final response back through Intent Broker from the transcript.');
      lines.push('Do not send a manual broker CLI reply or progress update from inside this auto-continue turn unless the task explicitly requires an out-of-band status update.');
    } else if (actionableReplyStyle === 'xiaok-cli') {
      lines.push('If you need the user to choose or approve something, use the xiaok broker shell helpers instead of claiming that broker tools are unavailable.');
      lines.push('Use `xiaok-broker ask-and-wait <taskId> <threadId> "<summary>" ["<prompt>"]` for a real single-select clarification card.');
      lines.push('Use `xiaok-broker approval-and-wait <taskId> <threadId> "<summary>" ["<detailText>"]` for a real approval card.');
      lines.push('For plain replies that do not need a decision, keep using your final plain-text reply so the stop hook can mirror completion.');
    } else {
      lines.push('If an actionable item expects a response, send that response back through the broker in this turn instead of only answering locally.');
      lines.push('Use `intent-broker reply "<summary>"` for the remembered task/thread, or `intent-broker progress <taskId> <threadId> "<summary>"` when you need to publish an intermediate status update.');
    }
  }

  if (otherInformational.length || presenceUpdates.length) {
    const parts = [];
    if (otherInformational.length) {
      parts.push(`${otherInformational.length} info event${otherInformational.length === 1 ? '' : 's'}`);
    }
    if (presenceUpdates.length) {
      parts.push(`${presenceUpdates.length} presence update${presenceUpdates.length === 1 ? '' : 's'}`);
    }
    lines.push(parts.join(', '));

    if (otherInformational.length) {
      const visibleInfo = otherInformational.slice(0, 2);
      const infoLine = visibleInfo.map((item) => {
        const sender = item.fromAlias || item.fromParticipantId || '?';
        const summary = truncateSummary(stripMarkdown(summarizePayload(item.payload)), 50);
        return `${sender}: ${summary}`;
      }).join(' | ');
      const hidden = otherInformational.length - visibleInfo.length;
      const suffix = hidden > 0 ? ` | +${hidden} more` : '';
      lines.push(infoLine + suffix);
    }

    if (presenceUpdates.length) {
      lines.push(summarizePresenceItems(presenceUpdates));
    }
  }

  return lines.join('\n');
}

export function buildToolAutoContinuePrompt(
  items = [],
  {
    participantId,
    sessionLabel = 'session',
    actionableReplyStyle = 'explicit'
  } = {}
) {
  const context = buildToolHookContext(items, {
    participantId,
    sessionLabel,
    actionableReplyStyle
  });
  if (!context) {
    return null;
  }

  return [
    `Intent Broker auto-continue for ${participantId || `this ${sessionLabel}`}.`,
    'The previous turn has completed. Continue immediately with the actionable items below without waiting for new local user input.',
    context
  ].join('\n');
}

export function buildCodexHookContext(items = [], { participantId, alias = null } = {}) {
  return buildToolHookContext(items, {
    participantId,
    alias,
    sessionLabel: 'Codex session'
  });
}

export function buildXiaokHookContext(items = [], { participantId, alias = null } = {}) {
  return buildToolHookContext(items, {
    participantId,
    alias,
    sessionLabel: 'xiaok session',
    actionableReplyStyle: 'xiaok-cli'
  });
}

export function buildCodexAutoContinuePrompt(items = [], { participantId } = {}) {
  return buildToolAutoContinuePrompt(items, {
    participantId,
    sessionLabel: 'Codex session',
    actionableReplyStyle: 'mirror'
  });
}

export function buildClaudeAutoContinuePrompt(items = [], { participantId } = {}) {
  const context = buildToolHookContext(items, {
    participantId,
    sessionLabel: 'Claude Code session'
  });

  if (!context) {
    return null;
  }

  return [
    `Intent Broker auto-continue for ${participantId || 'this Claude Code session'}.`,
    'The previous turn has completed. Continue immediately with the actionable items below without waiting for new local user input.',
    'Handle the work, then output only the reply summary that should be sent back through Intent Broker as plain text.',
    'Do not wrap the final reply in markdown fences or add commentary outside the reply itself.',
    'If no reply should be sent, output exactly NO_REPLY.',
    context
  ].join('\n');
}

export function buildXiaokAutoContinuePrompt(items = [], { participantId } = {}) {
  const context = buildXiaokHookContext(items, {
    participantId
  });

  if (!context) {
    return null;
  }

  return [
    `Intent Broker auto-continue for ${participantId || 'this xiaok session'}.`,
    'The previous turn has completed. Continue immediately with the actionable items below without waiting for new local user input.',
    'If you need a real user decision during this turn, run `xiaok-broker ask-and-wait ...` or `xiaok-broker approval-and-wait ...` from the shell.',
    'Handle the work, then output only the reply summary that should be sent back through Intent Broker as plain text.',
    'The stop hook will auto-mirror your final plain-text reply back through Intent Broker as completion progress.',
    'Do not wrap the final reply in markdown fences or add commentary outside the reply itself.',
    'If no reply should be sent, output exactly NO_REPLY.',
    context
  ].join('\n');
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
