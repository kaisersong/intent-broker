#!/usr/bin/env node
import { deriveSessionBridgeConfig } from './config.js';
import {
  ackInbox,
  pollInbox,
  registerParticipant,
  sendProgress as sendProgressIntent,
  sendTask as sendTaskIntent
} from './api.js';

function usage() {
  console.log(`Usage:
  node adapters/session-bridge/cli.js register [toolName]
  node adapters/session-bridge/cli.js poll [toolName] [after]
  node adapters/session-bridge/cli.js ack [toolName] <eventId>
  node adapters/session-bridge/cli.js send-task [toolName] <toParticipantId> <taskId> <threadId> <summary>
  node adapters/session-bridge/cli.js send-progress [toolName] <taskId> <threadId> <summary>`);
}

async function register(config) {
  console.log(JSON.stringify(await registerParticipant(config), null, 2));
}

async function poll(config, after = '0') {
  console.log(JSON.stringify(await pollInbox(config, { after, limit: 50 }), null, 2));
}

async function ack(config, eventId) {
  console.log(JSON.stringify(await ackInbox(config, eventId), null, 2));
}

async function sendTask(config, toParticipantId, taskId, threadId, summary) {
  console.log(
    JSON.stringify(
      await sendTaskIntent(config, {
        intentId: `${config.participantId}-task-${Date.now()}`,
        toParticipantId,
        taskId,
        threadId,
        summary
      }),
      null,
      2
    )
  );
}

async function sendProgress(config, taskId, threadId, summary) {
  console.log(
    JSON.stringify(
      await sendProgressIntent(config, {
        intentId: `${config.participantId}-progress-${Date.now()}`,
        taskId,
        threadId,
        summary
      }),
      null,
      2
    )
  );
}

const [, , command, toolNameArg = 'codex', ...args] = process.argv;
if (!command) {
  usage();
  process.exit(1);
}

const config = deriveSessionBridgeConfig({ toolName: toolNameArg });

switch (command) {
  case 'register':
    await register(config);
    break;
  case 'poll':
    await poll(config, args[0] || '0');
    break;
  case 'ack':
    await ack(config, args[0]);
    break;
  case 'send-task':
    await sendTask(config, args[0], args[1], args[2], args.slice(3).join(' '));
    break;
  case 'send-progress':
    await sendProgress(config, args[0], args[1], args.slice(2).join(' '));
    break;
  default:
    usage();
    process.exit(1);
}
