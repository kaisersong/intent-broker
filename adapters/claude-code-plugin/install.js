import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildCommandShimContent,
  defaultCommandShimPath,
  ensureCommandShim
} from '../hook-installer-core/command-shim.js';
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

function buildManagedCommandMatcher(scriptName, hookMode) {
  return (command = '') => command.includes(scriptName) && command.includes(`hook ${hookMode}`);
}

export function defaultInstallPaths({ cwd = process.cwd(), repoRoot = cwd, homeDir = os.homedir() } = {}) {
  return {
    settingsPath: path.join(cwd, '.claude', 'settings.json'),
    stateRoot: resolveToolStateRoot('claude-code', { homeDir }),
    commandShimPath: defaultCommandShimPath({ homeDir }),
    unifiedCliPath: path.join(repoRoot, 'bin', 'intent-broker.js')
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

export function mergeIntentBrokerHooks(existingConfig = {}, commands, { verbose = false } = {}) {
  const merged = clone(existingConfig);
  const hooks = { ...(merged.hooks || {}) };

  hooks.SessionStart = mergeManagedHookGroups(hooks.SessionStart || [], {
    matcher: 'startup|resume',
    command: commands.sessionStartCommand,
    statusMessage: verbose ? managedHookStatusMessages.sessionStart : undefined,
    commandMatcher: buildManagedCommandMatcher('claude-code-broker.js', 'session-start')
  });

  hooks.UserPromptSubmit = mergeManagedHookGroups(hooks.UserPromptSubmit || [], {
    command: commands.userPromptSubmitCommand,
    statusMessage: verbose ? managedHookStatusMessages.userPromptSubmit : undefined,
    commandMatcher: buildManagedCommandMatcher('claude-code-broker.js', 'user-prompt-submit')
  });

  hooks.PermissionRequest = mergeManagedHookGroups(hooks.PermissionRequest || [], {
    command: commands.permissionRequestCommand,
    commandMatcher: buildManagedCommandMatcher('claude-code-broker.js', 'permission-request')
  });

  hooks.Stop = mergeManagedHookGroups(hooks.Stop || [], {
    command: commands.stopCommand,
    statusMessage: verbose ? managedHookStatusMessages.stop : undefined,
    commandMatcher: buildManagedCommandMatcher('claude-code-broker.js', 'stop')
  });

  merged.hooks = hooks;
  return merged;
}

function readOptionalText(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function hasVisibleManagedHookEntries(config = {}) {
  return Object.values(config?.hooks || {})
    .flatMap((group) => group?.hooks || [])
    .some((entry) => Object.values(managedHookStatusMessages).includes(entry?.statusMessage));
}

function buildClaudeCodeInstallArtifacts({ cwd = process.cwd(), repoRoot = cwd, homeDir = os.homedir(), verbose } = {}) {
  const paths = defaultInstallPaths({ cwd, repoRoot, homeDir });
  const cliPath = path.join(repoRoot, 'adapters', 'claude-code-plugin', 'bin', 'claude-code-broker.js');
  const existingSettings = readClaudeSettings(paths.settingsPath);
  const effectiveVerbose = verbose ?? hasVisibleManagedHookEntries(existingSettings);
  const desiredSettings = mergeIntentBrokerHooks(
    existingSettings,
    {
      sessionStartCommand: buildHookCommand(cliPath, 'session-start'),
      userPromptSubmitCommand: buildHookCommand(cliPath, 'user-prompt-submit'),
      permissionRequestCommand: buildHookCommand(cliPath, 'permission-request'),
      stopCommand: buildHookCommand(cliPath, 'stop')
    },
    { verbose: effectiveVerbose }
  );

  return {
    paths,
    cliPath,
    effectiveVerbose,
    existingSettings,
    desiredSettings,
    existingCommandShimContent: readOptionalText(paths.commandShimPath),
    desiredCommandShimContent: buildCommandShimContent({ cliPath: paths.unifiedCliPath })
  };
}

export function inspectClaudeCodeInstall(options = {}) {
  const artifacts = buildClaudeCodeInstallArtifacts(options);
  const updated = [];

  if (JSON.stringify(artifacts.existingSettings) !== JSON.stringify(artifacts.desiredSettings)) {
    updated.push('settings');
  }

  if (artifacts.existingCommandShimContent !== artifacts.desiredCommandShimContent) {
    updated.push('command-shim');
  }

  return {
    ...artifacts,
    updated,
    upToDate: updated.length === 0
  };
}

export function ensureClaudeCodeInstall(options = {}) {
  const inspection = inspectClaudeCodeInstall(options);

  for (const item of inspection.updated) {
    if (item === 'settings') {
      writeClaudeSettings(inspection.paths.settingsPath, inspection.desiredSettings);
      continue;
    }
    if (item === 'command-shim') {
      ensureCommandShim(inspection.paths.commandShimPath, inspection.desiredCommandShimContent);
    }
  }

  return {
    changed: inspection.updated.length > 0,
    updated: inspection.updated,
    paths: inspection.paths,
    cliPath: inspection.cliPath,
    verboseHooks: inspection.effectiveVerbose
  };
}
