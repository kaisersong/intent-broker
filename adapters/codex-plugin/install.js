import { lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSION_START_STATUS = 'intent-broker session sync';
const USER_PROMPT_STATUS = 'intent-broker inbox sync';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isOurHookEntry(entry) {
  return entry?.statusMessage === SESSION_START_STATUS || entry?.statusMessage === USER_PROMPT_STATUS;
}

function pruneGroups(groups = []) {
  return groups
    .map((group) => ({
      ...group,
      hooks: (group.hooks || []).filter((entry) => !isOurHookEntry(entry))
    }))
    .filter((group) => group.hooks.length > 0);
}

export function buildHookCommand(cliPath, mode) {
  return `node "${cliPath}" hook ${mode}`;
}

export function mergeIntentBrokerHooks(existingConfig = {}, commands) {
  const merged = clone(existingConfig);
  const hooks = { ...(merged.hooks || {}) };

  hooks.SessionStart = pruneGroups(hooks.SessionStart);
  hooks.UserPromptSubmit = pruneGroups(hooks.UserPromptSubmit);

  hooks.SessionStart.push({
    matcher: 'startup|resume',
    hooks: [
      {
        type: 'command',
        command: commands.sessionStartCommand,
        statusMessage: SESSION_START_STATUS
      }
    ]
  });

  hooks.UserPromptSubmit.push({
    hooks: [
      {
        type: 'command',
        command: commands.userPromptSubmitCommand,
        statusMessage: USER_PROMPT_STATUS
      }
    ]
  });

  merged.hooks = hooks;
  return merged;
}

export function defaultInstallPaths({ homeDir = os.homedir(), repoRoot } = {}) {
  return {
    hooksConfigPath: path.join(homeDir, '.codex', 'hooks.json'),
    skillLinkPath: path.join(homeDir, '.codex', 'skills', 'intent-broker'),
    stateRoot: path.join(homeDir, '.intent-broker', 'codex'),
    skillSourcePath: path.join(repoRoot, 'adapters', 'codex-plugin', 'skills', 'intent-broker')
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
