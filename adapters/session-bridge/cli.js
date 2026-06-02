#!/usr/bin/env node
import { deriveSessionBridgeConfig } from './config.js';
import {
  ackInbox,
  listParticipants,
  listWorkStates,
  pollInbox,
  registerParticipant,
  resolveParticipantAliases,
  sendAsk as sendAskIntent,
  sendReply as sendReplyIntent,
  updateWorkState,
  sendProgress as sendProgressIntent,
  sendTask as sendTaskIntent
} from './api.js';
import {
  runInboxCommand,
  runReplyCommand,
  runWhoCommand
} from './command-runner.js';
import { runCliMain } from './cli-errors.js';

function usage() {
  console.log(`Usage:
  intent-broker register [toolName]
  intent-broker poll [toolName] [after]
  intent-broker ack [toolName] <eventId>
  intent-broker inbox [toolName]
  intent-broker who [toolName] [--project <name>]
  intent-broker reply [toolName] [@alias] <summary>
  intent-broker task [toolName] <recipient> <taskId> <threadId> <summary>
  intent-broker ask [toolName] <recipient> <taskId> <threadId> <summary>
  intent-broker note [toolName] <recipient> <taskId> <threadId> <summary>
  intent-broker progress [toolName] <taskId> <threadId> <summary>
  intent-broker set-work-state [toolName] <status> [taskId] [threadId] [summary]`);
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

async function sendAsk(config, toParticipantId, taskId, threadId, summary) {
  console.log(
    JSON.stringify(
      await sendAskIntent(config, {
        intentId: `${config.participantId}-ask-${Date.now()}`,
        toParticipantId,
        taskId,
        threadId,
        summary,
        delivery: { semantic: 'actionable', source: 'explicit' }
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

async function sendNote(config, toParticipantId, taskId, threadId, summary) {
  console.log(
    JSON.stringify(
      await sendProgressIntent(config, {
        intentId: `${config.participantId}-note-${Date.now()}`,
        toParticipantId,
        taskId,
        threadId,
        summary,
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

async function setWorkState(config, status, taskId, threadId, summary) {
  console.log(
    JSON.stringify(
      await updateWorkState(config, {
        status,
        taskId: normalizeOptionalValue(taskId),
        threadId: normalizeOptionalValue(threadId),
        summary: summary || undefined
      }),
      null,
      2
    )
  );
}

async function main() {
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
    case 'inbox':
      await runInboxCommand(config, { toolName: toolNameArg });
      break;
    case 'who': {
      const projectIdx = args.indexOf('--project');
      const projectArg = projectIdx >= 0 ? args[projectIdx + 1] : undefined;
      await runWhoCommand(config, {
        ...(projectArg ? { projectName: projectArg } : {}),
        listParticipants,
        listWorkStates
      });
      break;
    }
    case 'reply':
      await runReplyCommand(config, args, {
        toolName: toolNameArg,
        resolveParticipantAliases,
        sendReply: sendReplyIntent
      });
      break;
    case 'task':
      await sendTask(config, args[0], args[1], args[2], args.slice(3).join(' '));
      break;
    case 'ask':
      await sendAsk(config, args[0], args[1], args[2], args.slice(3).join(' '));
      break;
    case 'note':
      await sendNote(config, args[0], args[1], args[2], args.slice(3).join(' '));
      break;
    case 'progress':
      await sendProgress(config, args[0], args[1], args.slice(2).join(' '));
      break;
    case 'send-task':
      await sendTask(config, args[0], args[1], args[2], args.slice(3).join(' '));
      break;
    case 'send-progress':
      await sendProgress(config, args[0], args[1], args.slice(2).join(' '));
      break;
    case 'set-work-state':
      await setWorkState(config, args[0], args[1], args[2], args.slice(3).join(' '));
      break;
    default:
      usage();
      process.exit(1);
  }
}

await runCliMain(main);
