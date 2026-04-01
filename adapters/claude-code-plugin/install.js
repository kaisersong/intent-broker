import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildHookCommand,
  managedHookStatusMessages,
  mergeManagedHookGroups
} from '../hook-installer-core/install-core.js';
import { resolveToolStateRoot } from '../hook-installer-core/state-paths.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export { buildHookCommand };

export function defaultInstallPaths({ cwd = process.cwd(), homeDir = os.homedir() } = {}) {
  return {
    settingsPath: path.join(cwd, '.claude', 'settings.json'),
    stateRoot: resolveToolStateRoot('claude-code', { homeDir })
  };
}

export function readClaudeSettings(settingsPath) {
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

export function writeClaudeSettings(settingsPath, settings) {
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

export function mergeIntentBrokerHooks(existingConfig = {}, commands) {
  const merged = clone(existingConfig);
  const hooks = { ...(merged.hooks || {}) };

  hooks.SessionStart = mergeManagedHookGroups(hooks.SessionStart || [], {
    matcher: 'startup|resume',
    command: commands.sessionStartCommand,
    statusMessage: managedHookStatusMessages.sessionStart
  });

  hooks.UserPromptSubmit = mergeManagedHookGroups(hooks.UserPromptSubmit || [], {
    command: commands.userPromptSubmitCommand,
    statusMessage: managedHookStatusMessages.userPromptSubmit
  });

  merged.hooks = hooks;
  return merged;
}
