#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { ensureCommandShim, isPathDirAvailable } from '../../hook-installer-core/command-shim.js';
import { registerParticipant, sendProgress, updateWorkState } from '../../session-bridge/api.js';
import { runCliMain } from '../../session-bridge/cli-errors.js';
import { deriveSessionBridgeConfig } from '../../session-bridge/config.js';
import { runRealtimeBridgeProcess } from '../../session-bridge/realtime-bridge.js';
import { runSessionKeeperProcess } from '../../session-bridge/session-keeper.js';
import { resolveRuntimeStatePath } from '../../hook-installer-core/state-paths.js';
import { loadRuntimeState } from '../../session-bridge/runtime-state.js';
import { ensureOpenCodeInstall, defaultInstallPaths } from '../install.js';
import {
  runSessionStartedHook,
  runChatPromptHook,
  runToolExecuteBeforeHook,
  runToolExecuteAfterHook,
  runSessionStoppingHook
} from '../hooks.js';

const TOOL_NAME = 'opencode';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..', '..');
const cliPath = path.resolve(repoRoot, 'adapters', 'opencode-plugin', 'bin', 'opencode-broker.js');

function usage() {
  console.log(`Usage:
  node adapters/opencode-plugin/bin/opencode-broker.js install
  node adapters/opencode-plugin/bin/opencode-broker.js register
  node adapters/opencode-plugin/bin/opencode-broker.js keepalive
  node adapters/opencode-plugin/bin/opencode-broker.js realtime-bridge
  node adapters/opencode-plugin/bin/opencode-broker.js hook session-started
  node adapters/opencode-plugin/bin/opencode-broker.js hook chat-prompt
  node adapters/opencode-plugin/bin/opencode-broker.js hook tool-execute-before
  node adapters/opencode-plugin/bin/opencode-broker.js hook tool-execute-after
  node adapters/opencode-plugin/bin/opencode-broker.js hook session-stopping`);
}

async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function install() {
  const result = ensureOpenCodeInstall({ repoRoot });
  const paths = defaultInstallPaths({ repoRoot });

  console.log(
    JSON.stringify(
      {
        pluginPath: result.pluginPath,
        configPath: paths.configPath,
        commandShimPath: paths.commandShimPath,
        commandShimInPath: isPathDirAvailable(paths.commandShimPath),
        stateRoot: paths.stateRoot,
        cliPath,
        updated: result.updated
      },
      null,
      2
    )
  );
}

async function register() {
  const config = deriveSessionBridgeConfig({ toolName: TOOL_NAME });
  console.log(JSON.stringify(await registerParticipant(config), null, 2));
}

async function keepalive() {
  await runSessionKeeperProcess({ toolName: TOOL_NAME });
}

async function realtimeBridge() {
  await runRealtimeBridgeProcess({ toolName: TOOL_NAME });
}

async function handleSessionStartedHook() {
  const input = await readJsonStdin();
  await runSessionStartedHook(input);
}

async function handleChatPromptHook() {
  const input = await readJsonStdin();
  await runChatPromptHook(input);
}

async function handleToolExecuteBeforeHook() {
  const input = await readJsonStdin();
  await runToolExecuteBeforeHook(input);
}

async function handleToolExecuteAfterHook() {
  const input = await readJsonStdin();
  await runToolExecuteAfterHook(input);
}

async function handleSessionStoppingHook() {
  const input = await readJsonStdin();
  await runSessionStoppingHook(input);
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (!command) {
    usage();
    process.exit(1);
  }

  switch (command) {
    case 'install':
      await install();
      break;
    case 'register':
      await register();
      break;
    case 'keepalive':
      await keepalive();
      break;
    case 'realtime-bridge':
      await realtimeBridge();
      break;
    case 'hook':
      if (args[0] === 'session-started') {
        await handleSessionStartedHook();
        break;
      }
      if (args[0] === 'chat-prompt') {
        await handleChatPromptHook();
        break;
      }
      if (args[0] === 'tool-execute-before') {
        await handleToolExecuteBeforeHook();
        break;
      }
      if (args[0] === 'tool-execute-after') {
        await handleToolExecuteAfterHook();
        break;
      }
      if (args[0] === 'session-stopping') {
        await handleSessionStoppingHook();
        break;
      }
      usage();
      process.exit(1);
    default:
      usage();
      process.exit(1);
  }
}

await runCliMain(main);