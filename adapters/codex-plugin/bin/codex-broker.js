#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  registerParticipant,
  sendProgress,
  sendTask
} from '../../session-bridge/api.js';
import { buildCodexHookOutput } from '../../session-bridge/codex-hooks.js';
import { deriveSessionBridgeConfig } from '../../session-bridge/config.js';
import {
  buildHookCommand,
  defaultInstallPaths,
  ensureSkillLink,
  enableCodexHooksFeature,
  mergeIntentBrokerHooks,
  readCodexConfig,
  readHooksConfig,
  writeCodexConfig,
  writeHooksConfig
} from '../install.js';
import { runSessionStartHook, runUserPromptSubmitHook } from '../hooks.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..', '..');
const cliPath = path.resolve(repoRoot, 'adapters', 'codex-plugin', 'bin', 'codex-broker.js');

function usage() {
  console.log(`Usage:
  node adapters/codex-plugin/bin/codex-broker.js install
  node adapters/codex-plugin/bin/codex-broker.js register
  node adapters/codex-plugin/bin/codex-broker.js send-task <toParticipantId> <taskId> <threadId> <summary>
  node adapters/codex-plugin/bin/codex-broker.js send-progress <taskId> <threadId> <summary>
  node adapters/codex-plugin/bin/codex-broker.js hook session-start
  node adapters/codex-plugin/bin/codex-broker.js hook user-prompt-submit`);
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
  const context = await runSessionStartHook(input);

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

async function install() {
  const paths = defaultInstallPaths({ repoRoot });
  const configText = readCodexConfig(paths.configPath);
  const existingConfig = readHooksConfig(paths.hooksConfigPath);
  const mergedConfig = mergeIntentBrokerHooks(existingConfig, {
    sessionStartCommand: buildHookCommand(cliPath, 'session-start'),
    userPromptSubmitCommand: buildHookCommand(cliPath, 'user-prompt-submit')
  });

  writeCodexConfig(paths.configPath, enableCodexHooksFeature(configText));
  writeHooksConfig(paths.hooksConfigPath, mergedConfig);
  ensureSkillLink(paths.skillSourcePath, paths.skillLinkPath);

  console.log(
    JSON.stringify(
      {
        configPath: paths.configPath,
        hooksConfigPath: paths.hooksConfigPath,
        skillLinkPath: paths.skillLinkPath,
        stateRoot: paths.stateRoot,
        cliPath
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
  case 'send-task':
    await cliSendTask(args);
    break;
  case 'send-progress':
    await cliSendProgress(args);
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
    usage();
    process.exit(1);
  default:
    usage();
    process.exit(1);
}
