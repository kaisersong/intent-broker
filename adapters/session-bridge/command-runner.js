import os from 'node:os';

import { resolveParticipantStatePath } from '../hook-installer-core/state-paths.js';
import {
  ackInbox as ackInboxDefault,
  listParticipants as listParticipantsDefault,
  listWorkStates as listWorkStatesDefault,
  pollInbox as pollInboxDefault,
  resolveParticipantAliases as resolveParticipantAliasesDefault,
  sendProgress as sendProgressDefault
} from './api.js';
import { highestEventId } from './codex-hooks.js';
import { pickRecentContext } from './recent-context.js';
import {
  loadCursorState as loadCursorStateDefault,
  saveCursorState as saveCursorStateDefault
} from './state.js';

function summarizePayload(payload = {}) {
  if (payload?.body?.summary) {
    return payload.body.summary;
  }
  if (payload?.summary) {
    return payload.summary;
  }
  return '';
}

function formatInbox(items = [], recentContext = null) {
  if (!items.length) {
    if (!recentContext) {
      return '0 unread broker events.';
    }

    const target = recentContext.fromAlias || recentContext.fromParticipantId || 'unknown';
    return [
      '0 unread broker events.',
      `Recent reply context: to ${target} task=${recentContext.taskId} thread=${recentContext.threadId}`
    ].join('\n');
  }

  const lines = [`${items.length} unread broker event${items.length === 1 ? '' : 's'}:`];
  for (const item of items) {
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
    const summary = summarizePayload(item.payload);
    if (summary) {
      parts.push(`- ${summary}`);
    }
    lines.push(parts.join(' '));
  }

  const target = recentContext?.fromAlias || recentContext?.fromParticipantId;
  if (target && recentContext?.taskId && recentContext?.threadId) {
    lines.push(`Recent reply context: to ${target} task=${recentContext.taskId} thread=${recentContext.threadId}`);
  }

  return lines.join('\n');
}

function formatWho(participants = [], workStates = [], { selfParticipantId, projectName } = {}) {
  const headerProject = projectName || 'all projects';
  const byParticipantId = new Map(workStates.map((item) => [item.participantId, item]));
  const lines = [`Participants for ${headerProject}:`];

  for (const participant of participants) {
    const alias = participant.alias || participant.participantId;
    const selfLabel = participant.participantId === selfParticipantId ? ' (you)' : '';
    const workState = byParticipantId.get(participant.participantId);
    const parts = [`- ${alias}${selfLabel}`, `[${participant.participantId}]`];
    if (workState?.status) {
      parts.push(workState.status);
    }
    if (workState?.taskId) {
      parts.push(`task=${workState.taskId}`);
    }
    if (workState?.threadId) {
      parts.push(`thread=${workState.threadId}`);
    }
    if (workState?.summary) {
      parts.push(`- ${workState.summary}`);
    }
    lines.push(parts.join(' '));
  }

  if (participants.length === 0) {
    lines.push('- none');
  }

  return lines.join('\n');
}

function parseReplyArgs(args = []) {
  if (!args.length) {
    return { targetAlias: null, summary: '' };
  }

  if (String(args[0]).startsWith('@')) {
    return {
      targetAlias: String(args[0]).replace(/^@+/, ''),
      summary: args.slice(1).join(' ').trim()
    };
  }

  return {
    targetAlias: null,
    summary: args.join(' ').trim()
  };
}

export async function runInboxCommand(
  config,
  {
    toolName,
    homeDir = os.homedir(),
    limit = 20,
    loadCursorState = loadCursorStateDefault,
    saveCursorState = saveCursorStateDefault,
    pollInbox = pollInboxDefault,
    ackInbox = ackInboxDefault,
    out = console.log
  } = {}
) {
  const statePath = resolveParticipantStatePath(toolName, config.participantId, { homeDir });
  const state = loadCursorState(statePath);
  const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit });
  const items = inbox.items || [];

  if (!items.length) {
    out(formatInbox([], state.recentContext));
    return { items: [], lastSeenEventId: state.lastSeenEventId, recentContext: state.recentContext };
  }

  const lastSeenEventId = highestEventId(items);
  const recentContext = pickRecentContext(items) || state.recentContext;
  saveCursorState(statePath, { lastSeenEventId, recentContext });
  await ackInbox(config, lastSeenEventId);
  out(formatInbox(items, recentContext));

  return {
    items,
    lastSeenEventId,
    recentContext
  };
}

export async function runWhoCommand(
  config,
  {
    projectName = config.context?.projectName,
    listParticipants = listParticipantsDefault,
    listWorkStates = listWorkStatesDefault,
    out = console.log
  } = {}
) {
  const [participantResult, workStateResult] = await Promise.all([
    listParticipants(config, projectName ? { projectName } : {}),
    listWorkStates(config, projectName ? { projectName } : {})
  ]);

  const participants = participantResult.participants || [];
  const workStates = workStateResult.items || [];
  out(formatWho(participants, workStates, {
    selfParticipantId: config.participantId,
    projectName
  }));

  return { participants, workStates };
}

export async function runReplyCommand(
  config,
  args,
  {
    toolName,
    homeDir = os.homedir(),
    loadCursorState = loadCursorStateDefault,
    resolveParticipantAliases = resolveParticipantAliasesDefault,
    sendProgress = sendProgressDefault,
    out = console.log
  } = {}
) {
  const statePath = resolveParticipantStatePath(toolName, config.participantId, { homeDir });
  const state = loadCursorState(statePath);
  const recentContext = state.recentContext;
  const { targetAlias, summary } = parseReplyArgs(args);

  if (!summary) {
    throw new Error('reply_message_required');
  }
  if (!recentContext?.taskId || !recentContext?.threadId) {
    throw new Error('recent_reply_context_not_found');
  }

  let targetParticipantId = recentContext.fromParticipantId;
  let resolvedAlias = recentContext.fromAlias || recentContext.fromParticipantId;

  if (targetAlias) {
    const resolved = await resolveParticipantAliases(config, [targetAlias]);
    if (resolved.missingAliases?.length) {
      throw new Error(`alias_not_found:${targetAlias}`);
    }

    const participant = resolved.participants?.[0];
    if (!participant) {
      throw new Error(`alias_not_found:${targetAlias}`);
    }

    targetParticipantId = participant.participantId;
    resolvedAlias = participant.alias || targetAlias;
  }

  const result = await sendProgress(config, {
    intentId: `${config.participantId}-reply-${Date.now()}`,
    taskId: recentContext.taskId,
    threadId: recentContext.threadId,
    toParticipantId: targetParticipantId,
    summary
  });

  out(`Replied to ${resolvedAlias} task=${recentContext.taskId} thread=${recentContext.threadId}`);

  return {
    ...result,
    targetParticipantId,
    targetAlias: resolvedAlias,
    taskId: recentContext.taskId,
    threadId: recentContext.threadId
  };
}
