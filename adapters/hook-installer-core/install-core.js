import { buildHookCommand } from './command.js';

export const managedHookStatusMessages = {
  sessionStart: 'intent-broker session sync',
  userPromptSubmit: 'intent-broker inbox sync'
};

export function isManagedHookEntry(entry, { statusMessage, commandMatcher } = {}) {
  if (!entry) {
    return false;
  }

  if (statusMessage && entry.statusMessage === statusMessage) {
    return true;
  }

  if (typeof commandMatcher === 'function' && commandMatcher(entry.command || '')) {
    return true;
  }

  return !statusMessage && Object.values(managedHookStatusMessages).includes(entry.statusMessage);
}

export function pruneManagedHookGroups(groups = [], options = {}) {
  return groups
    .map((group) => ({
      ...group,
      hooks: (group.hooks || []).filter((entry) => !isManagedHookEntry(entry, options))
    }))
    .filter((group) => group.hooks.length > 0);
}

export function mergeManagedHookGroups(groups = [], { matcher, command, statusMessage, commandMatcher } = {}) {
  const merged = pruneManagedHookGroups(groups, { statusMessage, commandMatcher });
  const hookEntry = {
    type: 'command',
    command
  };

  if (statusMessage) {
    hookEntry.statusMessage = statusMessage;
  }

  merged.push({
    ...(matcher ? { matcher } : {}),
    hooks: [hookEntry]
  });
  return merged;
}

export { buildHookCommand };
