#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCommandShimContent,
  ensureCommandShim,
  isPathDirAvailable
} from '../../hook-installer-core/command-shim.js';
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
import { runRealtimeBridgeProcess } from '../../session-bridge/realtime-bridge.js';
import { runSessionKeeperProcess } from '../../session-bridge/session-keeper.js';
import { appendAliasToTerminalTitle } from '../../session-bridge/terminal-title.js';
import {
  buildHookCommand,
  defaultInstallPaths,
  ensureCodexInstall,
  ensureSkillLink,
  enableCodexHooksFeature,
  mergeIntentBrokerHooks,
  readCodexConfig,
  readHooksConfig,
  writeCodexConfig,
  writeHooksConfig
} from '../install.js';
import { runSessionStartHook, runStopHook, runUserPromptSubmitHook } from '../hooks.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..', '..');
const cliPath = path.resolve(repoRoot, 'adapters', 'codex-plugin', 'bin', 'codex-broker.js');

function usage() {
  console.log(`Usage:
  node adapters/codex-plugin/bin/codex-broker.js install [--verbose-hooks]
  node adapters/codex-plugin/bin/codex-broker.js register
  node adapters/codex-plugin/bin/codex-broker.js inbox
  node adapters/codex-plugin/bin/codex-broker.js who
  node adapters/codex-plugin/bin/codex-broker.js reply [@alias] <summary>
  node adapters/codex-plugin/bin/codex-broker.js task <toParticipantId> <taskId> <threadId> <summary>
  node adapters/codex-plugin/bin/codex-broker.js ask <toParticipantId> <taskId> <threadId> <summary>
  node adapters/codex-plugin/bin/codex-broker.js note <toParticipantId> <taskId> <threadId> <summary>
  node adapters/codex-plugin/bin/codex-broker.js progress <taskId> <threadId> <summary>
  node adapters/codex-plugin/bin/codex-broker.js send-task <toParticipantId> <taskId> <threadId> <summary>
  node adapters/codex-plugin/bin/codex-broker.js send-progress <taskId> <threadId> <summary>
  node adapters/codex-plugin/bin/codex-broker.js set-work-state <status> [taskId] [threadId] [summary]
  node adapters/codex-plugin/bin/codex-broker.js keepalive
  node adapters/codex-plugin/bin/codex-broker.js realtime-bridge
  node adapters/codex-plugin/bin/codex-broker.js hook session-start
  node adapters/codex-plugin/bin/codex-broker.js hook user-prompt-submit
  node adapters/codex-plugin/bin/codex-broker.js hook stop`);
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

  if (!context) {
    return;
  }
  process.stdout.write(JSON.stringify(buildCodexHookOutput('SessionStart', context)));
}

async function handleUserPromptSubmitHook() {
  const input = await readJsonStdin();
  const context = await runUserPromptSubmitHook(input);

  if (!context) {
    return;
  }
  process.stdout.write(JSON.stringify(buildCodexHookOutput('UserPromptSubmit', context)));
}

async function handleStopHook() {
  const input = await readJsonStdin();
  const continuationPrompt = await runStopHook(input);

  if (!continuationPrompt) {
    return;
  }

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: continuationPrompt
  }));
}

function parseInstallOptions(args = []) {
  return {
    verbose: args.includes('--verbose-hooks')
  };
}

async function install(args = []) {
  const options = parseInstallOptions(args);
  const result = ensureCodexInstall({ repoRoot, verbose: options.verbose });
  const paths = defaultInstallPaths({ repoRoot });
  ensureSkillLink(paths.skillSourcePath, paths.skillLinkPath);
  ensureCommandShim(paths.commandShimPath, buildCommandShimContent({ cliPath: paths.unifiedCliPath }));

  console.log(
    JSON.stringify(
      {
        configPath: paths.configPath,
        hooksConfigPath: paths.hooksConfigPath,
        skillLinkPath: paths.skillLinkPath,
        commandShimPath: paths.commandShimPath,
        commandShimInPath: isPathDirAvailable(paths.commandShimPath),
        stateRoot: paths.stateRoot,
        cliPath,
        verboseHooks: options.verbose,
        updated: result.updated
      },
      null,
      2
    )
  );
}

async function register() {
  const config = deriveSessionBridgeConfig({ toolName: 'codex' });
  console.log(JSON.stringify(await registerParticipant(config), null, 2));
}

async function inbox() {
  const config = deriveSessionBridgeConfig({ toolName: 'codex' });
  await runInboxCommand(config, { toolName: 'codex' });
}

async function who() {
  const config = deriveSessionBridgeConfig({ toolName: 'codex' });
  await runWhoCommand(config);
}

async function reply(args) {
  const config = deriveSessionBridgeConfig({ toolName: 'codex' });
  await runReplyCommand(config, args, { toolName: 'codex', sendProgress });
}

async function cliSendTask(args) {
  const config = deriveSessionBridgeConfig({ toolName: 'codex' });
  console.log(
    JSON.stringify(
      await sendTask(config, {
        intentId: `${config.participantId}-task-${Date.now()}`,
        toParticipantId: args[0],
        taskId: args[1],
        threadId: args[2],
        summary: args.slice(3).join(' ')
      }),
      null,
      2
    )
  );
}

async function cliAsk(args) {
  const config = deriveSessionBridgeConfig({ toolName: 'codex' });
  console.log(
    JSON.stringify(
      await sendAsk(config, {
        intentId: `${config.participantId}-ask-${Date.now()}`,
        toParticipantId: args[0],
        taskId: args[1],
        threadId: args[2],
        summary: args.slice(3).join(' '),
        delivery: { semantic: 'actionable', source: 'explicit' }
      }),
      null,
      2
    )
  );
}

async function cliSendProgress(args) {
  const config = deriveSessionBridgeConfig({ toolName: 'codex' });
  console.log(
    JSON.stringify(
      await sendProgress(config, {
        intentId: `${config.participantId}-progress-${Date.now()}`,
        taskId: args[0],
        threadId: args[1],
        summary: args.slice(2).join(' ')
      }),
      null,
      2
    )
  );
}

async function cliNote(args) {
  const config = deriveSessionBridgeConfig({ toolName: 'codex' });
  console.log(
    JSON.stringify(
      await sendProgress(config, {
        intentId: `${config.participantId}-note-${Date.now()}`,
        toParticipantId: args[0],
        taskId: args[1],
        threadId: args[2],
        summary: args.slice(3).join(' '),
        delivery: { semantic: 'informational', source: 'explicit' }
      }),
      null,
      2
    )
  );
}

function normalizeOptionalValue(value) {
  if (!value || value === '-') {
    return undefined;
  }

  return value;
}

async function cliSetWorkState(args) {
  const config = deriveSessionBridgeConfig({ toolName: 'codex' });
  console.log(
    JSON.stringify(
      await updateWorkState(config, {
        status: args[0],
        taskId: normalizeOptionalValue(args[1]),
        threadId: normalizeOptionalValue(args[2]),
        summary: args.slice(3).join(' ') || undefined
      }),
      null,
      2
    )
  );
}

async function keepalive() {
  await runSessionKeeperProcess({ toolName: 'codex' });
}

async function realtimeBridge() {
  await runRealtimeBridgeProcess({ toolName: 'codex' });
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (!command) {
    usage();
    process.exit(1);
  }

  switch (command) {
    case 'install':
      await install(args);
      break;
    case 'register':
      await register();
      break;
    case 'inbox':
      await inbox();
      break;
    case 'who':
      await who();
      break;
    case 'reply':
      await reply(args);
      break;
    case 'task':
      await cliSendTask(args);
      break;
    case 'ask':
      await cliAsk(args);
      break;
    case 'note':
      await cliNote(args);
      break;
    case 'progress':
      await cliSendProgress(args);
      break;
    case 'send-task':
      await cliSendTask(args);
      break;
    case 'send-progress':
      await cliSendProgress(args);
      break;
    case 'set-work-state':
      await cliSetWorkState(args);
      break;
    case 'keepalive':
      await keepalive();
      break;
    case 'realtime-bridge':
      await realtimeBridge();
      break;
    case 'hook':
      if (args[0] === 'session-start') {
        await handleSessionStartHook();
        break;
      }
      if (args[0] === 'user-prompt-submit') {
        await handleUserPromptSubmitHook();
        break;
      }
      if (args[0] === 'stop') {
        await handleStopHook();
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
