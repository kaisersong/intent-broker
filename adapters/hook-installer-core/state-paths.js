import os from 'node:os';
import path from 'node:path';

export function resolveToolStateRoot(toolName, { homeDir = os.homedir() } = {}) {
  return path.join(homeDir, '.intent-broker', toolName);
}

export function resolveParticipantStatePath(toolName, participantId, { homeDir = os.homedir() } = {}) {
  return path.join(resolveToolStateRoot(toolName, { homeDir }), `${participantId}.json`);
}
