import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

export function mergeIntentBrokerHooks(existingConfig = {}, commands, { verbose = false } = {}) {
  const outer = clone(existingConfig);
  // agy hooks.json uses the Codex format:
  // { "hooks": { "PreToolUse": [{ "matcher": "...", "hooks": [{ "command": "..." }] }] } }
  const merged = outer.hooks || {};

  if (commands.preToolUseCommand) {
    merged.PreToolUse = mergeManagedHookGroups(merged.PreToolUse || [], {
      command: commands.preToolUseCommand,
      commandMatcher: buildManagedCommandMatcher('agy-broker.js', 'pre-tool-use')
    });
  }

  if (commands.postToolUseCommand) {
    merged.PostToolUse = mergeManagedHookGroups(merged.PostToolUse || [], {
      command: commands.postToolUseCommand,
      commandMatcher: buildManagedCommandMatcher('agy-broker.js', 'post-tool-use')
    });
  }

  if (commands.stopCommand) {
    merged.Stop = mergeManagedHookGroups(merged.Stop || [], {
      command: commands.stopCommand,
      commandMatcher: buildManagedCommandMatcher('agy-broker.js', 'stop')
    });
  }

  // Remove legacy top-level hook keys from before the format fix
  for (const key of ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'UserPromptSubmit']) {
    delete outer[key];
  }

  outer.hooks = merged;
  return outer;
}

export function defaultInstallPaths({ homeDir = os.homedir(), repoRoot } = {}) {
  return {
    hooksConfigPath: path.join(homeDir, '.gemini', 'antigravity-cli', 'hooks.json'),
    stateRoot: resolveToolStateRoot('agy', { homeDir }),
    commandShimPath: defaultCommandShimPath({ homeDir }),
    unifiedCliPath: path.join(repoRoot, 'bin', 'intent-broker.js')
  };
}

export function readHooksConfig(hooksConfigPath) {
  try {
    return JSON.parse(readFileSync(hooksConfigPath, 'utf8'));
  } catch {
    return {};
  }
}

export function writeHooksConfig(hooksConfigPath, config) {
  mkdirSync(path.dirname(hooksConfigPath), { recursive: true });
  writeFileSync(hooksConfigPath, JSON.stringify(config, null, 2) + '\n');
}

function readOptionalText(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function hasVisibleManagedHookEntries(config = {}) {
  return Object.values(config)
    .flatMap((group) => group?.hooks || (Array.isArray(group) ? group : []))
    .some((entry) => Object.values(managedHookStatusMessages).includes(entry?.statusMessage));
}

function buildAgyInstallArtifacts({ repoRoot, homeDir = os.homedir(), verbose } = {}) {
  const paths = defaultInstallPaths({ homeDir, repoRoot });
  const cliPath = path.join(repoRoot, 'adapters', 'agy-plugin', 'bin', 'agy-broker.js');
  const existingHooksConfig = readHooksConfig(paths.hooksConfigPath);
  const effectiveVerbose = verbose ?? hasVisibleManagedHookEntries(existingHooksConfig);
  const desiredHooksConfig = mergeIntentBrokerHooks(
    existingHooksConfig,
    {
      preToolUseCommand: buildHookCommand(cliPath, 'pre-tool-use'),
      postToolUseCommand: buildHookCommand(cliPath, 'post-tool-use'),
      stopCommand: buildHookCommand(cliPath, 'stop')
    },
    { verbose: effectiveVerbose }
  );

  return {
    paths,
    cliPath,
    effectiveVerbose,
    existingHooksConfig,
    desiredHooksConfig,
    existingCommandShimContent: readOptionalText(paths.commandShimPath),
    desiredCommandShimContent: buildCommandShimContent({ cliPath: paths.unifiedCliPath })
  };
}

export function inspectAgyInstall(options = {}) {
  const artifacts = buildAgyInstallArtifacts(options);
  const updated = [];

  if (JSON.stringify(artifacts.existingHooksConfig) !== JSON.stringify(artifacts.desiredHooksConfig)) {
    updated.push('hooks');
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

export function ensureAgyInstall(options = {}) {
  const inspection = inspectAgyInstall(options);

  for (const item of inspection.updated) {
    if (item === 'hooks') {
      writeHooksConfig(inspection.paths.hooksConfigPath, inspection.desiredHooksConfig);
      continue;
    }
    if (item === 'command-shim') {
      ensureCommandShim(inspection.paths.commandShimPath, inspection.desiredCommandShimContent);
      continue;
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
