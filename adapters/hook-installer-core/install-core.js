import { buildHookCommand } from './command.js';

export const managedHookStatusMessages = {
  sessionStart: 'intent-broker session sync',
  userPromptSubmit: 'intent-broker inbox sync'
};

export function isManagedHookEntry(entry) {
  return Object.values(managedHookStatusMessages).includes(entry?.statusMessage);
}

export function pruneManagedHookGroups(groups = [], { statusMessage } = {}) {
  return groups
    .map((group) => ({
      ...group,
      hooks: (group.hooks || []).filter((entry) => entry?.statusMessage !== statusMessage)
    }))
    .filter((group) => group.hooks.length > 0);
}

export function mergeManagedHookGroups(groups = [], { matcher, command, statusMessage } = {}) {
  const merged = pruneManagedHookGroups(groups, { statusMessage });
  merged.push({
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: 'command',
        command,
        statusMessage
      }
    ]
  });
  return merged;
}

export { buildHookCommand };
