import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildCommandShimContent,
  defaultCommandShimPath,
  ensureCommandShim
} from '../hook-installer-core/command-shim.js';
import { resolveToolStateRoot } from '../hook-installer-core/state-paths.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function defaultInstallPaths({ homeDir = os.homedir(), repoRoot } = {}) {
  return {
    pluginDir: path.join(homeDir, '.config', 'opencode', 'plugins'),
    stateRoot: resolveToolStateRoot('opencode', { homeDir }),
    commandShimPath: defaultCommandShimPath({ homeDir }),
    unifiedCliPath: path.join(repoRoot, 'bin', 'intent-broker.js'),
    configPath: path.join(homeDir, '.config', 'opencode', 'config.json')
  };
}

function readExistingConfig(configPath) {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(configPath, config) {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function buildOpenCodePluginContent(cliPath) {
  return `// Intent Broker plugin for OpenCode
// Bridges OpenCode events to Intent Broker
import { connect } from "net";

const BROKER_URL = process.env.BROKER_URL || "http://127.0.0.1:4318";
const SOCKET_PATH = process.env.INTENT_BROKER_SOCKET || "/Users/song/.intent-broker/broker.sock";

async function sendToBroker(intent) {
  try {
    const response = await fetch(\`\${BROKER_URL}/intents\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intent)
    });
    return response.json();
  } catch (err) {
    // Fallback to socket if HTTP fails
    return new Promise((resolve) => {
      const sock = connect({ path: SOCKET_PATH }, () => {
        sock.end(JSON.stringify(intent) + "\\n");
      });
      sock.on("close", () => resolve({ delivered: false }));
      sock.on("error", () => resolve({ delivered: false }));
    });
  }
}

async function registerParticipant(sessionID) {
  const participantId = \`opencode-session-\${sessionID.slice(0, 8)}\`;
  try {
    await fetch(\`\${BROKER_URL}/participants/register\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participantId,
        kind: "agent",
        roles: ["coder"],
        capabilities: ["broker.auto_dispatch"],
        alias: "opencode",
        context: { projectName: process.cwd().split("/").pop() },
        metadata: { source: "plugin", sessionID }
      })
    });
  } catch {}
  return participantId;
}

export default async function plugin(input, options = {}) {
  const sessionID = input.sessionID || process.env.OPENCODE_SESSION_ID || "unknown";
  const participantId = await registerParticipant(sessionID);

  return {
    "session.started": async (inp, out) => {
      await fetch(\`\${BROKER_URL}/participants/\${participantId}/work-state\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "idle", summary: null })
      });
    },
    "session.stopping": async (inp, out) => {
      await fetch(\`\${BROKER_URL}/participants/\${participantId}/work-state\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "offline" })
      });
    },
    "chat.prompt": async (inp, out) => {
      await fetch(\`\${BROKER_URL}/participants/\${participantId}/work-state\`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "implementing", summary: inp.messageID })
      });
    },
    "tool.execute.before": async (inp, out) => {
      // Similar to PreToolUse - check inbox, sync state
    },
    "tool.execute.after": async (inp, out) => {
      // Similar to PostToolUse - update work state
    },
    "permission.ask": async (inp, out) => {
      // Bridge permission requests to broker approval flow
    }
  };
}
`;
}

export function ensureOpenCodeInstall({ homeDir = os.homedir(), repoRoot } = {}) {
  const paths = defaultInstallPaths({ homeDir, repoRoot });
  const cliPath = path.join(repoRoot, 'adapters', 'opencode-plugin', 'bin', 'opencode-broker.js');
  const pluginContent = buildOpenCodePluginContent(cliPath);
  const pluginPath = path.join(paths.pluginDir, 'intent-broker.js');

  mkdirSync(paths.pluginDir, { recursive: true });
  mkdirSync(paths.stateRoot, { recursive: true });

  writeFileSync(pluginPath, pluginContent);

  // Update config.json to register the plugin
  const existingConfig = readExistingConfig(paths.configPath);
  const plugins = existingConfig.plugin || [];
  const pluginUrl = `file://${pluginPath}`;

  if (!plugins.includes(pluginUrl)) {
    plugins.push(pluginUrl);
    existingConfig.plugin = plugins;
    writeConfig(paths.configPath, existingConfig);
  }

  ensureCommandShim(paths.commandShimPath, buildCommandShimContent({ cliPath: paths.unifiedCliPath }));

  return {
    updated: ['plugin', 'config'],
    paths,
    pluginPath
  };
}