import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveToolStateRoot } from '../hook-installer-core/state-paths.js';

export function defaultInstallPaths({ homeDir = os.homedir(), repoRoot } = {}) {
  return {
    pluginDir: path.join(homeDir, '.xiaok', 'plugins', 'intent-broker'),
    stateRoot: resolveToolStateRoot('xiaok-code', { homeDir }),
    cliPath: path.join(repoRoot, 'adapters', 'xiaok-code-plugin', 'bin', 'xiaok-broker.js')
  };
}

function buildPluginManifest(cliPath) {
  return {
    name: 'intent-broker',
    version: '1.0.0',
    skills: [],
    agents: [],
    hooks: [
      {
        command: `node ${cliPath} hook session-start`,
        events: ['SessionStart'],
        matcher: 'startup|resume',
        async: false,
        statusMessage: 'Intent Broker: syncing inbox...'
      },
      {
        command: `node ${cliPath} hook user-prompt-submit`,
        events: ['UserPromptSubmit'],
        async: false,
        statusMessage: 'Intent Broker: checking broker...'
      },
      {
        command: `node ${cliPath} hook pre-tool-use`,
        events: ['PreToolUse'],
        matcher: '*',
        async: false
      },
      {
        command: `node ${cliPath} hook permission-request`,
        events: ['PermissionRequest'],
        async: false,
        statusMessage: 'Intent Broker: waiting for approval...'
      },
      {
        command: `node ${cliPath} hook stop`,
        events: ['Stop'],
        async: false,
        statusMessage: 'Intent Broker: reporting progress...'
      }
    ],
    commands: [],
    mcpServers: []
  };
}

function readExistingManifest(pluginDir) {
  try {
    return JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function ensureXiaokInstall({ homeDir = os.homedir(), repoRoot } = {}) {
  const paths = defaultInstallPaths({ homeDir, repoRoot });
  const desiredManifest = buildPluginManifest(paths.cliPath);
  const existing = readExistingManifest(paths.pluginDir);
  const desiredJson = JSON.stringify(desiredManifest, null, 2) + '\n';
  const existingJson = existing ? JSON.stringify(existing, null, 2) + '\n' : null;

  const updated = [];

  if (desiredJson !== existingJson) {
    mkdirSync(paths.pluginDir, { recursive: true });
    writeFileSync(path.join(paths.pluginDir, 'plugin.json'), desiredJson);
    updated.push('plugin.json');
  }

  mkdirSync(paths.stateRoot, { recursive: true });

  return { updated, paths };
}
