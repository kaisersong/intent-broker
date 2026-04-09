import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeStatus(value) {
  return value === 'running' ? 'running' : 'idle';
}

export function createRuntimeState() {
  return {
    status: 'idle',
    sessionId: null,
    turnId: null,
    source: null,
    taskId: null,
    threadId: null,
    alias: null,
    terminalApp: null,
    projectPath: null,
    sessionHint: null,
    terminalTTY: null,
    terminalSessionID: null,
    updatedAt: null
  };
}

function normalizeRuntimeState(state) {
  return {
    status: normalizeStatus(state?.status),
    sessionId: normalizeOptionalString(state?.sessionId),
    turnId: normalizeOptionalString(state?.turnId),
    source: normalizeOptionalString(state?.source),
    taskId: normalizeOptionalString(state?.taskId),
    threadId: normalizeOptionalString(state?.threadId),
    alias: normalizeOptionalString(state?.alias),
    terminalApp: normalizeOptionalString(state?.terminalApp),
    projectPath: normalizeOptionalString(state?.projectPath),
    sessionHint: normalizeOptionalString(state?.sessionHint),
    terminalTTY: normalizeOptionalString(state?.terminalTTY),
    terminalSessionID: normalizeOptionalString(state?.terminalSessionID),
    updatedAt: normalizeOptionalString(state?.updatedAt)
  };
}

export function loadRuntimeState(statePath) {
  try {
    return normalizeRuntimeState(JSON.parse(readFileSync(statePath, 'utf8')));
  } catch {
    return createRuntimeState();
  }
}

export function saveRuntimeState(statePath, state) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify(normalizeRuntimeState({ ...loadRuntimeState(statePath), ...state }), null, 2)
  );
}
