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
  const merged = clone(existingConfig);
  const hooks = { ...(merged.hooks || {}) };

  hooks.SessionStart = mergeManagedHookGroups(hooks.SessionStart || [], {
    matcher: 'startup|resume',
    command: commands.sessionStartCommand,
    statusMessage: verbose ? managedHookStatusMessages.sessionStart : undefined,
    commandMatcher: buildManagedCommandMatcher('codex-broker.js', 'session-start')
  });

  hooks.UserPromptSubmit = mergeManagedHookGroups(hooks.UserPromptSubmit || [], {
    command: commands.userPromptSubmitCommand,
    statusMessage: verbose ? managedHookStatusMessages.userPromptSubmit : undefined,
    commandMatcher: buildManagedCommandMatcher('codex-broker.js', 'user-prompt-submit')
  });

  hooks.PreToolUse = mergeManagedHookGroups(hooks.PreToolUse || [], {
    command: commands.preToolUseCommand,
    commandMatcher: buildManagedCommandMatcher('codex-broker.js', 'pre-tool-use')
  });

  hooks.Stop = mergeManagedHookGroups(hooks.Stop || [], {
    command: commands.stopCommand,
    statusMessage: verbose ? managedHookStatusMessages.stop : undefined,
    commandMatcher: buildManagedCommandMatcher('codex-broker.js', 'stop')
  });

  merged.hooks = hooks;
  return merged;
}

export function defaultInstallPaths({ homeDir = os.homedir(), repoRoot } = {}) {
  return {
    configPath: path.join(homeDir, '.codex', 'config.toml'),
    hooksConfigPath: path.join(homeDir, '.codex', 'hooks.json'),
    skillLinkPath: path.join(homeDir, '.codex', 'skills', 'intent-broker'),
    stateRoot: resolveToolStateRoot('codex', { homeDir }),
    skillSourcePath: path.join(repoRoot, 'adapters', 'codex-plugin', 'skills', 'intent-broker'),
    commandShimPath: defaultCommandShimPath({ homeDir }),
    unifiedCliPath: path.join(repoRoot, 'bin', 'intent-broker.js')
  };
}

export function enableCodexHooksFeature(configText = '') {
  if (/\bcodex_hooks\s*=\s*true\b/.test(configText)) {
    return configText;
  }

  if (/\[features\]/.test(configText)) {
    return configText.replace(/\[features\]\n/, '[features]\ncodex_hooks = true\n');
  }

  const suffix = configText.endsWith('\n') || configText.length === 0 ? '' : '\n';
  return `${configText}${suffix}[features]\ncodex_hooks = true\n`;
}

export function readCodexConfig(configPath) {
  try {
    return readFileSync(configPath, 'utf8');
  } catch {
    return '';
  }
}

export function writeCodexConfig(configPath, configText) {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, configText);
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
  return Object.values(config?.hooks || {})
    .flatMap((group) => group?.hooks || [])
    .some((entry) => Object.values(managedHookStatusMessages).includes(entry?.statusMessage));
}

function isSkillLinkCurrent(skillLinkPath, skillSourcePath) {
  try {
    return lstatSync(skillLinkPath).isSymbolicLink() && readlinkSync(skillLinkPath) === skillSourcePath;
  } catch {
    return false;
  }
}

function buildCodexInstallArtifacts({ repoRoot, homeDir = os.homedir(), verbose } = {}) {
  const paths = defaultInstallPaths({ homeDir, repoRoot });
  const cliPath = path.join(repoRoot, 'adapters', 'codex-plugin', 'bin', 'codex-broker.js');
  const configText = readCodexConfig(paths.configPath);
  const existingHooksConfig = readHooksConfig(paths.hooksConfigPath);
  const effectiveVerbose = verbose ?? hasVisibleManagedHookEntries(existingHooksConfig);
  const desiredHooksConfig = mergeIntentBrokerHooks(
    existingHooksConfig,
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
    desiredConfigText: enableCodexHooksFeature(configText),
    existingConfigText: configText,
    existingHooksConfig,
    desiredHooksConfig,
    existingCommandShimContent: readOptionalText(paths.commandShimPath),
    desiredCommandShimContent: buildCommandShimContent({ cliPath: paths.unifiedCliPath })
  };
}

export function inspectCodexInstall(options = {}) {
  const artifacts = buildCodexInstallArtifacts(options);
  const updated = [];

  if (artifacts.existingConfigText !== artifacts.desiredConfigText) {
    updated.push('config');
  }

  if (JSON.stringify(artifacts.existingHooksConfig) !== JSON.stringify(artifacts.desiredHooksConfig)) {
    updated.push('hooks');
  }

  if (artifacts.existingCommandShimContent !== artifacts.desiredCommandShimContent) {
    updated.push('command-shim');
  }

  if (!isSkillLinkCurrent(artifacts.paths.skillLinkPath, artifacts.paths.skillSourcePath)) {
    updated.push('skill-link');
  }

  return {
    ...artifacts,
    updated,
    upToDate: updated.length === 0
  };
}

export function ensureCodexInstall(options = {}) {
  const inspection = inspectCodexInstall(options);

  for (const item of inspection.updated) {
    if (item === 'config') {
      writeCodexConfig(inspection.paths.configPath, inspection.desiredConfigText);
      continue;
    }
    if (item === 'hooks') {
      writeHooksConfig(inspection.paths.hooksConfigPath, inspection.desiredHooksConfig);
      continue;
    }
    if (item === 'command-shim') {
      ensureCommandShim(inspection.paths.commandShimPath, inspection.desiredCommandShimContent);
      continue;
    }
    if (item === 'skill-link') {
      ensureSkillLink(inspection.paths.skillSourcePath, inspection.paths.skillLinkPath);
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

export function ensureSkillLink(skillSourcePath, skillLinkPath) {
  mkdirSync(path.dirname(skillLinkPath), { recursive: true });

  try {
    const stat = lstatSync(skillLinkPath);
    if (stat.isSymbolicLink()) {
      unlinkSync(skillLinkPath);
    } else {
      throw new Error(`${skillLinkPath} already exists and is not a symlink`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  symlinkSync(skillSourcePath, skillLinkPath, 'dir');
}
