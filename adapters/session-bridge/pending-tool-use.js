import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolvePendingToolUseStatePath } from '../hook-installer-core/state-paths.js';

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeToolInput(toolInput) {
  if (toolInput === undefined) {
    return null;
  }
  return toolInput ?? null;
}

function normalizePendingToolUse(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  return {
    sessionId: normalizeOptionalString(record.sessionId),
    toolName: normalizeOptionalString(record.toolName),
    toolInput: normalizeToolInput(record.toolInput),
    toolUseId: normalizeOptionalString(record.toolUseId),
    savedAt: normalizeOptionalString(record.savedAt)
  };
}

export function loadPendingToolUseContext(toolName, participantId, { homeDir = os.homedir() } = {}) {
  const statePath = resolvePendingToolUseStatePath(toolName, participantId, { homeDir });

  try {
    return normalizePendingToolUse(JSON.parse(readFileSync(statePath, 'utf8')));
  } catch {
    return null;
  }
}

export function savePendingToolUseContext(toolName, participantId, record, { homeDir = os.homedir() } = {}) {
  const statePath = resolvePendingToolUseStatePath(toolName, participantId, { homeDir });
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify(
      normalizePendingToolUse({
        ...record,
        savedAt: record?.savedAt || new Date().toISOString()
      }),
      null,
      2
    )
  );
}

export function clearPendingToolUseContext(toolName, participantId, { homeDir = os.homedir() } = {}) {
  savePendingToolUseContext(toolName, participantId, null, { homeDir });
}
