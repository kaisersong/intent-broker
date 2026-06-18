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
import { repairQoderManagedPluginHooks } from './plugin-compat.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export { buildHookCommand };

function buildManagedCommandMatcher(scriptName, hookMode) {
  return (command = '') => command.includes(scriptName) && command.includes(`hook ${hookMode}`);
}

export function mergeIntentBrokerHooks(existingConfig = {}, commands, { verbose = false } = {}) {
  const merged = clone(existingConfig);
  const hooks = { ...(merged.hooks || {}) };

  hooks.SessionStart = mergeManagedHookGroups(hooks.SessionStart || [], {
    command: commands.sessionStartCommand,
    statusMessage: verbose ? managedHookStatusMessages.sessionStart : undefined,
    commandMatcher: buildManagedCommandMatcher('qodercli-broker.js', 'session-start')
  });

  hooks.UserPromptSubmit = mergeManagedHookGroups(hooks.UserPromptSubmit || [], {
    command: commands.userPromptSubmitCommand,
    statusMessage: verbose ? managedHookStatusMessages.userPromptSubmit : undefined,
    commandMatcher: buildManagedCommandMatcher('qodercli-broker.js', 'user-prompt-submit')
  });

  hooks.PreToolUse = mergeManagedHookGroups(hooks.PreToolUse || [], {
    matcher: 'Bash',
    command: commands.preToolUseCommand,
    commandMatcher: buildManagedCommandMatcher('qodercli-broker.js', 'pre-tool-use')
  });

  hooks.Stop = mergeManagedHookGroups(hooks.Stop || [], {
    command: commands.stopCommand,
    statusMessage: verbose ? managedHookStatusMessages.stop : undefined,
    commandMatcher: buildManagedCommandMatcher('qodercli-broker.js', 'stop')
  });

  merged.hooks = hooks;
  return merged;
}

export function defaultInstallPaths({ homeDir = os.homedir(), repoRoot } = {}) {
  return {
    settingsPath: path.join(homeDir, '.qoder', 'settings.json'),
    stateRoot: resolveToolStateRoot('qodercli', { homeDir }),
    commandShimPath: defaultCommandShimPath({ homeDir }),
    unifiedCliPath: path.join(repoRoot, 'bin', 'intent-broker.js')
  };
}

export function readSettings(settingsPath) {
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

export function writeSettings(settingsPath, config) {
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n');
}

function buildQodercliInstallArtifacts({ repoRoot, homeDir = os.homedir(), verbose } = {}) {
  const paths = defaultInstallPaths({ homeDir, repoRoot });
  const cliPath = path.join(repoRoot, 'adapters', 'qodercli-plugin', 'bin', 'qodercli-broker.js');
  const existingSettings = readSettings(paths.settingsPath);
  const effectiveVerbose = verbose ?? false;
  const desiredSettings = mergeIntentBrokerHooks(
    existingSettings,
    {
      sessionStartCommand: buildHookCommand(cliPath, 'session-start'),
      userPromptSubmitCommand: buildHookCommand(cliPath, 'user-prompt-submit'),
      preToolUseCommand: buildHookCommand(cliPath, 'pre-tool-use'),
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
    existingCommandShimContent: (() => {
      try { return readFileSync(paths.commandShimPath, 'utf8'); } catch { return ''; }
    })(),
    desiredCommandShimContent: buildCommandShimContent({ cliPath: paths.unifiedCliPath })
  };
}

export function inspectQodercliInstall(options = {}) {
  const artifacts = buildQodercliInstallArtifacts(options);
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

export function ensureQodercliInstall(options = {}) {
  const inspection = inspectQodercliInstall(options);
  const repairResult = repairQoderManagedPluginHooks({
    homeDir: options.homeDir,
    platform: options.platform
  });

  for (const item of inspection.updated) {
    if (item === 'settings') {
      writeSettings(inspection.paths.settingsPath, inspection.desiredSettings);
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
    verboseHooks: inspection.effectiveVerbose,
    repairedPluginHooks: repairResult.repairedFiles
  };
}
