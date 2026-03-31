#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ackInbox,
  pollInbox,
  registerParticipant,
  sendProgress,
  sendTask
} from '../../session-bridge/api.js';
import {
  buildCodexHookContext,
  buildCodexHookOutput,
  highestEventId
} from '../../session-bridge/codex-hooks.js';
import { deriveSessionBridgeConfig } from '../../session-bridge/config.js';
import { loadCursorState, saveCursorState } from '../../session-bridge/state.js';
import {
  buildHookCommand,
  defaultInstallPaths,
  ensureSkillLink,
  mergeIntentBrokerHooks,
  readHooksConfig,
  writeHooksConfig
} from '../install.js';

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

function configFromHookInput(input) {
  return deriveSessionBridgeConfig({
    toolName: 'codex',
    env: {
      ...process.env,
      CODEX_THREAD_ID: process.env.CODEX_THREAD_ID || input.session_id || ''
    }
  });
}

function cursorPathForParticipant(participantId) {
  const homeDir = os.homedir();
  return path.join(homeDir, '.intent-broker', 'codex', `${participantId}.json`);
}

async function handleSessionStartHook() {
  const input = await readJsonStdin();
  const config = configFromHookInput(input);
  const statePath = cursorPathForParticipant(config.participantId);
  const state = loadCursorState(statePath);

  await registerParticipant(config);
  const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit: 20 });
  const items = inbox.items || [];
  const context = buildCodexHookContext(items, { participantId: config.participantId });

  if (!context) {
    return;
  }

  process.stdout.write(JSON.stringify(buildCodexHookOutput('SessionStart', context)));
}

async function handleUserPromptSubmitHook() {
  const input = await readJsonStdin();
  if (typeof input.prompt === 'string' && input.prompt.trimStart().startsWith('/')) {
    return;
  }

  const config = configFromHookInput(input);
  const statePath = cursorPathForParticipant(config.participantId);
  const state = loadCursorState(statePath);

  await registerParticipant(config);
  const inbox = await pollInbox(config, { after: state.lastSeenEventId, limit: 20 });
  const items = inbox.items || [];
  const context = buildCodexHookContext(items, { participantId: config.participantId });

  if (!context) {
    return;
  }

  const lastSeenEventId = highestEventId(items);
  saveCursorState(statePath, { lastSeenEventId });
  await ackInbox(config, lastSeenEventId);
  process.stdout.write(JSON.stringify(buildCodexHookOutput('UserPromptSubmit', context)));
}

async function install() {
  const paths = defaultInstallPaths({ repoRoot });
  const existingConfig = readHooksConfig(paths.hooksConfigPath);
  const mergedConfig = mergeIntentBrokerHooks(existingConfig, {
    sessionStartCommand: buildHookCommand(cliPath, 'session-start'),
    userPromptSubmitCommand: buildHookCommand(cliPath, 'user-prompt-submit')
  });

  writeHooksConfig(paths.hooksConfigPath, mergedConfig);
  ensureSkillLink(paths.skillSourcePath, paths.skillLinkPath);

  console.log(
    JSON.stringify(
      {
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
