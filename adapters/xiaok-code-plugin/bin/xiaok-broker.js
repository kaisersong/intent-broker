#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  registerParticipant,
  sendAsk,
  sendProgress,
  sendTask,
  updateWorkState
} from '../../session-bridge/api.js';
import {
  runInboxCommand,
  runReplyCommand,
  runWhoCommand
} from '../../session-bridge/command-runner.js';
import { buildCodexHookOutput } from '../../session-bridge/codex-hooks.js';
import { runCliMain } from '../../session-bridge/cli-errors.js';
import { deriveSessionBridgeConfig } from '../../session-bridge/config.js';
import { loadRuntimeState } from '../../session-bridge/runtime-state.js';
import { runRealtimeBridgeProcess } from '../../session-bridge/realtime-bridge.js';
import { runSessionKeeperProcess } from '../../session-bridge/session-keeper.js';
import { appendAliasToTerminalTitle, scheduleAliasTitle } from '../../session-bridge/terminal-title.js';
import { resolveRuntimeStatePath } from '../../hook-installer-core/state-paths.js';
import { ensureXiaokInstall, defaultInstallPaths } from '../install.js';
import { runSessionStartHook, runStopHook, runUserPromptSubmitHook } from '../hooks.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..', '..');
const cliPath = path.resolve(repoRoot, 'adapters', 'xiaok-code-plugin', 'bin', 'xiaok-broker.js');

function usage() {
  console.log(`Usage:
  node adapters/xiaok-code-plugin/bin/xiaok-broker.js install
  node adapters/xiaok-code-plugin/bin/xiaok-broker.js register
  node adapters/xiaok-code-plugin/bin/xiaok-broker.js inbox
  node adapters/xiaok-code-plugin/bin/xiaok-broker.js who
  node adapters/xiaok-code-plugin/bin/xiaok-broker.js reply [@alias] <summary>
  node adapters/xiaok-code-plugin/bin/xiaok-broker.js progress <taskId> <threadId> <summary>
  node adapters/xiaok-code-plugin/bin/xiaok-broker.js keepalive
  node adapters/xiaok-code-plugin/bin/xiaok-broker.js realtime-bridge
  node adapters/xiaok-code-plugin/bin/xiaok-broker.js hook session-start
  node adapters/xiaok-code-plugin/bin/xiaok-broker.js hook user-prompt-submit
  node adapters/xiaok-code-plugin/bin/xiaok-broker.js hook stop`);
}

async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

async function handleSessionStartHook() {
  const input = await readJsonStdin();
  const result = await runSessionStartHook(input);
  const context = result?.context ?? result;
  const alias = result?.registration?.alias;

  appendAliasToTerminalTitle(alias, { cwd: input.cwd || process.cwd() });

  if (!context) return;
  process.stdout.write(JSON.stringify(buildCodexHookOutput('SessionStart', context)));
}

async function handleUserPromptSubmitHook() {
  const input = await readJsonStdin();
  const context = await runUserPromptSubmitHook(input);

  // Read alias from runtime state and schedule terminal title update
  const config = deriveSessionBridgeConfig({ toolName: 'xiaok-code' });
  const runtimeStatePath = resolveRuntimeStatePath('xiaok-code', config.participantId, { homeDir: os.homedir() });
  const runtimeState = loadRuntimeState(runtimeStatePath);
  scheduleAliasTitle(runtimeState.alias, { cwd: input.cwd || process.cwd() });

  if (!context) return;
  process.stdout.write(JSON.stringify(buildCodexHookOutput('UserPromptSubmit', context)));
}

async function handleStopHook() {
  const input = await readJsonStdin();
  const continuationPrompt = await runStopHook(input);
  if (!continuationPrompt) return;
  process.stdout.write(JSON.stringify({ decision: 'block', reason: continuationPrompt }));
}

async function install() {
  const result = ensureXiaokInstall({ repoRoot });
  const paths = defaultInstallPaths({ repoRoot });
  console.log(JSON.stringify({ pluginDir: paths.pluginDir, stateRoot: paths.stateRoot, cliPath, updated: result.updated }, null, 2));
}

function config() {
  return deriveSessionBridgeConfig({ toolName: 'xiaok-code' });
}

function normalizeOptionalValue(value) {
  if (!value || value === '-') return undefined;
  return value;
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (!command) { usage(); process.exit(1); }

  switch (command) {
    case 'install':
      await install();
      break;
    case 'register':
      console.log(JSON.stringify(await registerParticipant(config()), null, 2));
      break;
    case 'inbox':
      await runInboxCommand(config(), { toolName: 'xiaok-code' });
      break;
    case 'who':
      await runWhoCommand(config());
      break;
    case 'reply':
      await runReplyCommand(config(), args, { toolName: 'xiaok-code', sendProgress });
      break;
    case 'task':
    case 'send-task':
      console.log(JSON.stringify(await sendTask(config(), {
        intentId: `${config().participantId}-task-${Date.now()}`,
        toParticipantId: args[0], taskId: args[1], threadId: args[2], summary: args.slice(3).join(' ')
      }), null, 2));
      break;
    case 'ask':
      console.log(JSON.stringify(await sendAsk(config(), {
        intentId: `${config().participantId}-ask-${Date.now()}`,
        toParticipantId: args[0], taskId: args[1], threadId: args[2], summary: args.slice(3).join(' '),
        delivery: { semantic: 'actionable', source: 'explicit' }
      }), null, 2));
      break;
    case 'progress':
    case 'send-progress':
      console.log(JSON.stringify(await sendProgress(config(), {
        intentId: `${config().participantId}-progress-${Date.now()}`,
        taskId: args[0], threadId: args[1], summary: args.slice(2).join(' ')
      }), null, 2));
      break;
    case 'set-work-state':
      console.log(JSON.stringify(await updateWorkState(config(), {
        status: args[0],
        taskId: normalizeOptionalValue(args[1]),
        threadId: normalizeOptionalValue(args[2]),
        summary: args.slice(3).join(' ') || undefined
      }), null, 2));
      break;
    case 'keepalive':
      await runSessionKeeperProcess({ toolName: 'xiaok-code' });
      break;
    case 'realtime-bridge':
      await runRealtimeBridgeProcess({ toolName: 'xiaok-code' });
      break;
    case 'hook':
      if (args[0] === 'session-start') { await handleSessionStartHook(); break; }
      if (args[0] === 'user-prompt-submit') { await handleUserPromptSubmitHook(); break; }
      if (args[0] === 'stop') { await handleStopHook(); break; }
      usage(); process.exit(1);
    default:
      usage(); process.exit(1);
  }
}

await runCliMain(main);
