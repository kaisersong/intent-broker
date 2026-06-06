import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function resolveWithFallback(suffix, toolName, participantId, { homeDir = os.homedir() } = {}) {
  const newName = `${participantId}.${suffix}`;
  const newPath = path.join(homeDir, '.intent-broker', 'sessions', newName);
  if (existsSync(newPath)) return newPath;

  const legacyPath = path.join(homeDir, '.intent-broker', toolName, newName);
  if (existsSync(legacyPath)) return legacyPath;

  return newPath;
}

export function resolveToolStateRoot(toolName, { homeDir = os.homedir() } = {}) {
  return path.join(homeDir, '.intent-broker', toolName);
}

export function resolveParticipantStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return resolveWithFallback('json', toolName, participantId, { homeDir });
}

export function resolveRealtimeQueueStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return resolveWithFallback('queue.json', toolName, participantId, { homeDir });
}

export function resolveRealtimeBridgeStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return resolveWithFallback('bridge.json', toolName, participantId, { homeDir });
}

export function resolveRuntimeStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return resolveWithFallback('runtime.json', toolName, participantId, { homeDir });
}

export function resolvePendingToolUseStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return resolveWithFallback('tool-use.json', toolName, participantId, { homeDir });
}
