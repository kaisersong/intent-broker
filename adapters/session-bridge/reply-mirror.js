import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveToolStateRoot } from '../hook-installer-core/state-paths.js';
import { sendProgress as sendProgressDefault } from './api.js';

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizePending(pending) {
  if (!pending || typeof pending !== 'object') {
    return null;
  }

  return {
    sessionId: normalizeOptionalString(pending.sessionId),
    turnId: normalizeOptionalString(pending.turnId),
    transcriptPath: normalizeOptionalString(pending.transcriptPath),
    transcriptLineCount: Number(pending.transcriptLineCount || 0),
    fromParticipantId: normalizeOptionalString(pending.fromParticipantId),
    fromAlias: normalizeOptionalString(pending.fromAlias),
    taskId: normalizeOptionalString(pending.taskId),
    threadId: normalizeOptionalString(pending.threadId),
    autoMirror: pending.autoMirror === true,
    metadata: pending.metadata && typeof pending.metadata === 'object'
      ? { ...pending.metadata }
      : null,
    createdAt: normalizeOptionalString(pending.createdAt)
  };
}

function normalizeMirrorRecord(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  return {
    sessionId: normalizeOptionalString(record.sessionId),
    turnId: normalizeOptionalString(record.turnId),
    toParticipantId: normalizeOptionalString(record.toParticipantId),
    taskId: normalizeOptionalString(record.taskId),
    threadId: normalizeOptionalString(record.threadId),
    summary: normalizeOptionalString(record.summary),
    mirroredAt: normalizeOptionalString(record.mirroredAt)
  };
}

function normalizeFailureRecord(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  return {
    reason: normalizeOptionalString(record.reason),
    sessionId: normalizeOptionalString(record.sessionId),
    turnId: normalizeOptionalString(record.turnId),
    transcriptPath: normalizeOptionalString(record.transcriptPath),
    attemptedAt: normalizeOptionalString(record.attemptedAt)
  };
}

export function createReplyMirrorState() {
  return {
    pending: null,
    lastMirrored: null,
    lastFailure: null
  };
}

export function resolveReplyMirrorStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return path.join(resolveToolStateRoot(toolName, { homeDir }), `${participantId}.mirror.json`);
}

function normalizeState(state) {
  return {
    pending: normalizePending(state?.pending),
    lastMirrored: normalizeMirrorRecord(state?.lastMirrored),
    lastFailure: normalizeFailureRecord(state?.lastFailure)
  };
}

export function loadReplyMirrorState(toolName, participantId, { homeDir = os.homedir() } = {}) {
  const statePath = resolveReplyMirrorStatePath(toolName, participantId, { homeDir });

  try {
    return normalizeState(JSON.parse(readFileSync(statePath, 'utf8')));
  } catch {
    return createReplyMirrorState();
  }
}

export function saveReplyMirrorState(toolName, participantId, state, { homeDir = os.homedir() } = {}) {
  const statePath = resolveReplyMirrorStatePath(toolName, participantId, { homeDir });
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(normalizeState(state), null, 2));
}

function findTranscriptRoot(toolName, homeDir) {
  if (toolName === 'codex') {
    return path.join(homeDir, '.codex', 'sessions');
  }
  if (toolName === 'claude-code') {
    return path.join(homeDir, '.claude', 'projects');
  }
  return null;
}

function matchesTranscriptFile(toolName, fileName, sessionId) {
  if (!fileName.endsWith('.jsonl')) {
    return false;
  }
  if (toolName === 'codex') {
    return fileName.endsWith(`-${sessionId}.jsonl`);
  }
  if (toolName === 'claude-code') {
    return fileName === `${sessionId}.jsonl`;
  }
  return false;
}

function findTranscriptPathRecursive(rootDir, toolName, sessionId) {
  const stack = [rootDir];

  while (stack.length) {
    const currentDir = stack.pop();
    let entries = [];

    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && matchesTranscriptFile(toolName, entry.name, sessionId)) {
        return entryPath;
      }
    }
  }

  return null;
}

export function resolveTranscriptPath(toolName, sessionId, { homeDir = os.homedir() } = {}) {
  if (!sessionId) {
    return null;
  }

  const rootDir = findTranscriptRoot(toolName, homeDir);
  if (!rootDir) {
    return null;
  }

  return findTranscriptPathRecursive(rootDir, toolName, sessionId);
}

function readJsonlEntries(transcriptPath) {
  if (!transcriptPath) {
    return [];
  }

  try {
    return readFileSync(transcriptPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line, index) => ({ lineNumber: index + 1, value: JSON.parse(line) }));
  } catch {
    return [];
  }
}

function extractCodexOutputText(entry) {
  const content = entry?.payload?.content;
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((item) => item?.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

function extractClaudeOutputText(entry) {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function extractCodexReplySummary(entries, { sinceLine = 0, turnId = null } = {}) {
  const recentEntries = entries.filter((entry) => entry.lineNumber > sinceLine);
  const completedTurn = [...recentEntries]
    .reverse()
    .find((entry) => {
      const payload = entry.value?.payload;
      if (entry.value?.type !== 'event_msg' || payload?.type !== 'task_complete') {
        return false;
      }
      return !turnId || payload?.turn_id === turnId;
    });

  if (typeof completedTurn?.value?.payload?.last_agent_message === 'string') {
    const summary = completedTurn.value.payload.last_agent_message.trim();
    if (summary) {
      return summary;
    }
  }

  const finalAnswer = [...recentEntries]
    .reverse()
    .find((entry) => (
      entry.value?.type === 'response_item'
      && entry.value?.payload?.type === 'message'
      && entry.value?.payload?.role === 'assistant'
      && entry.value?.payload?.phase === 'final_answer'
      && extractCodexOutputText(entry.value)
    ));

  if (finalAnswer) {
    return extractCodexOutputText(finalAnswer.value);
  }

  const assistantMessage = [...recentEntries]
    .reverse()
    .find((entry) => (
      entry.value?.type === 'response_item'
      && entry.value?.payload?.type === 'message'
      && entry.value?.payload?.role === 'assistant'
      && extractCodexOutputText(entry.value)
    ));

  return assistantMessage ? extractCodexOutputText(assistantMessage.value) : '';
}

export function extractClaudeReplySummary(entries, { sinceLine = 0 } = {}) {
  const recentEntries = entries.filter((entry) => entry.lineNumber > sinceLine);
  const endTurnMessage = [...recentEntries]
    .reverse()
    .find((entry) => (
      entry.value?.type === 'assistant'
      && entry.value?.message?.role === 'assistant'
      && entry.value?.message?.stop_reason === 'end_turn'
      && extractClaudeOutputText(entry.value)
    ));

  if (endTurnMessage) {
    return extractClaudeOutputText(endTurnMessage.value);
  }

  const assistantMessage = [...recentEntries]
    .reverse()
    .find((entry) => (
      entry.value?.type === 'assistant'
      && entry.value?.message?.role === 'assistant'
      && extractClaudeOutputText(entry.value)
    ));

  return assistantMessage ? extractClaudeOutputText(assistantMessage.value) : '';
}

function countTranscriptLines(transcriptPath) {
  return readJsonlEntries(transcriptPath).length;
}

function buildPendingRecord(toolName, payload, { homeDir }) {
  const transcriptPath = payload.transcriptPath
    || resolveTranscriptPath(toolName, payload.sessionId, { homeDir });
  const transcriptLineCount = Number.isInteger(payload.transcriptLineCount)
    ? payload.transcriptLineCount
    : countTranscriptLines(transcriptPath);
  const recentContext = payload.recentContext || {};

  return normalizePending({
    sessionId: payload.sessionId,
    turnId: payload.turnId,
    transcriptPath,
    transcriptLineCount,
    fromParticipantId: recentContext.fromParticipantId,
    fromAlias: recentContext.fromAlias,
    taskId: recentContext.taskId,
    threadId: recentContext.threadId,
    autoMirror: payload.autoMirror === true,
    metadata: recentContext.metadata,
    createdAt: payload.createdAt || new Date().toISOString()
  });
}

export function markPendingReplyMirror(toolName, participantId, payload, { homeDir = os.homedir() } = {}) {
  const pending = buildPendingRecord(toolName, payload, { homeDir });
  if (!pending?.fromParticipantId || !pending?.taskId || !pending?.threadId) {
    return null;
  }

  const state = loadReplyMirrorState(toolName, participantId, { homeDir });
  const nextState = {
    ...state,
    pending,
    lastFailure: null
  };
  saveReplyMirrorState(toolName, participantId, nextState, { homeDir });
  return pending;
}

export function clearPendingReplyMirror(toolName, participantId, { homeDir = os.homedir() } = {}) {
  const state = loadReplyMirrorState(toolName, participantId, { homeDir });
  if (!state.pending) {
    return state;
  }

  const nextState = {
    ...state,
    pending: null
  };
  saveReplyMirrorState(toolName, participantId, nextState, { homeDir });
  return nextState;
}

function buildFailureState(state, pending, reason, transcriptPath, turnId) {
  return {
    ...state,
    pending: null,
    lastFailure: normalizeFailureRecord({
      reason,
      sessionId: pending?.sessionId,
      turnId,
      transcriptPath,
      attemptedAt: new Date().toISOString()
    })
  };
}

export async function maybeMirrorPendingReply(
  config,
  {
    toolName,
    sessionId = null,
    turnId = null,
    homeDir = os.homedir(),
    sendProgress = sendProgressDefault
  } = {}
) {
  const state = loadReplyMirrorState(toolName, config.participantId, { homeDir });
  const pending = state.pending;

  if (!pending) {
    return { mirrored: false, reason: 'no-pending' };
  }
  if (!pending.autoMirror) {
    saveReplyMirrorState(
      toolName,
      config.participantId,
      {
        ...state,
        pending: null
      },
      { homeDir }
    );
    return { mirrored: false, reason: 'auto-mirror-disabled' };
  }
  if (pending.sessionId && sessionId && pending.sessionId !== sessionId) {
    return { mirrored: false, reason: 'session-mismatch' };
  }

  const transcriptPath = pending.transcriptPath
    || resolveTranscriptPath(toolName, pending.sessionId || sessionId, { homeDir });
  const entries = readJsonlEntries(transcriptPath);
  const summary = toolName === 'codex'
    ? extractCodexReplySummary(entries, { sinceLine: pending.transcriptLineCount, turnId })
    : extractClaudeReplySummary(entries, { sinceLine: pending.transcriptLineCount });

  if (!summary) {
    saveReplyMirrorState(
      toolName,
      config.participantId,
      buildFailureState(
        state,
        pending,
        transcriptPath ? 'assistant-output-not-found' : 'transcript-not-found',
        transcriptPath,
        turnId
      ),
      { homeDir }
    );
    return {
      mirrored: false,
      reason: transcriptPath ? 'assistant-output-not-found' : 'transcript-not-found'
    };
  }

  const result = await sendProgress(config, {
    intentId: `${config.participantId}-auto-reply-${Date.now()}`,
    taskId: pending.taskId,
    threadId: pending.threadId,
    toParticipantId: pending.fromParticipantId,
    summary,
    metadata: pending.metadata || undefined,
    delivery: {
      semantic: 'informational',
      source: 'auto-mirror'
    }
  });

  saveReplyMirrorState(
    toolName,
    config.participantId,
    {
      ...state,
      pending: null,
      lastFailure: null,
      lastMirrored: normalizeMirrorRecord({
        sessionId: pending.sessionId,
        turnId,
        toParticipantId: pending.fromParticipantId,
        taskId: pending.taskId,
        threadId: pending.threadId,
        summary,
        mirroredAt: new Date().toISOString()
      })
    },
    { homeDir }
  );

  return {
    mirrored: true,
    summary,
    transcriptPath,
    result
  };
}
