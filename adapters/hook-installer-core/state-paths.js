import os from 'node:os';
import path from 'node:path';

export function resolveToolStateRoot(toolName, { homeDir = os.homedir() } = {}) {
  return path.join(homeDir, '.intent-broker', toolName);
}

export function resolveParticipantStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return path.join(resolveToolStateRoot(toolName, { homeDir }), `${participantId}.json`);
}

export function resolveRealtimeQueueStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return path.join(resolveToolStateRoot(toolName, { homeDir }), `${participantId}.queue.json`);
}

export function resolveRealtimeBridgeStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return path.join(resolveToolStateRoot(toolName, { homeDir }), `${participantId}.bridge.json`);
}

export function resolveRuntimeStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return path.join(resolveToolStateRoot(toolName, { homeDir }), `${participantId}.runtime.json`);
}

export function resolvePendingToolUseStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return path.join(resolveToolStateRoot(toolName, { homeDir }), `${participantId}.tool-use.json`);
}
