#!/usr/bin/env node
import { deriveSessionBridgeConfig } from '../adapters/session-bridge/config.js';
import {
  ackInbox,
  listParticipants,
  listWorkStates,
  pollInbox,
  registerParticipant,
  resolveParticipantAliases,
  sendProgress,
  sendTask,
  updateWorkState
} from '../adapters/session-bridge/api.js';
import {
  runInboxCommand,
  runReplyCommand,
  runWhoCommand
} from '../adapters/session-bridge/command-runner.js';

function usage() {
  console.log(`Usage:
  intent-broker [--tool codex|claude-code|opencode|xiaok-code] register
  intent-broker [--tool ...] inbox
  intent-broker [--tool ...] who
  intent-broker [--tool ...] reply [@alias] <summary>
  intent-broker [--tool ...] poll [after]
  intent-broker [--tool ...] ack <eventId>
  intent-broker [--tool ...] send-task <toParticipantId> <taskId> <threadId> <summary>
  intent-broker [--tool ...] send-progress <taskId> <threadId> <summary>
  intent-broker [--tool ...] set-work-state <status> [taskId] [threadId] [summary]`);
}

function inferToolName(env = process.env) {
  if (env.CODEX_THREAD_ID) {
    return 'codex';
  }
  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID) {
    return 'claude-code';
  }
  if (env.OPENCODE_SESSION_ID) {
    return 'opencode';
  }
  if (env.XIAOK_CODE_SESSION_ID) {
    return 'xiaok-code';
  }
  return env.INTENT_BROKER_TOOL || 'codex';
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = [...argv];
  let toolName = null;

  if (args[0] === '--tool') {
    toolName = args[1];
    args.splice(0, 2);
  }

  return {
    toolName: toolName || inferToolName(env),
    command: args[0],
    args: args.slice(1)
  };
}

function normalizeOptionalValue(value) {
  if (!value || value === '-') {
    return undefined;
  }
  return value;
}

const parsed = parseArgs();
if (!parsed.command) {
  usage();
  process.exit(1);
}

const config = deriveSessionBridgeConfig({ toolName: parsed.toolName });

switch (parsed.command) {
  case 'register':
    console.log(JSON.stringify(await registerParticipant(config), null, 2));
    break;
  case 'inbox':
    await runInboxCommand(config, { toolName: parsed.toolName });
    break;
  case 'who':
    await runWhoCommand(config, { listParticipants, listWorkStates });
    break;
  case 'reply':
    await runReplyCommand(config, parsed.args, {
      toolName: parsed.toolName,
      resolveParticipantAliases,
      sendProgress
    });
    break;
  case 'poll':
    console.log(JSON.stringify(await pollInbox(config, { after: parsed.args[0] || '0', limit: 50 }), null, 2));
    break;
  case 'ack':
    console.log(JSON.stringify(await ackInbox(config, parsed.args[0]), null, 2));
    break;
  case 'send-task':
    console.log(JSON.stringify(await sendTask(config, {
      intentId: `${config.participantId}-task-${Date.now()}`,
      toParticipantId: parsed.args[0],
      taskId: parsed.args[1],
      threadId: parsed.args[2],
      summary: parsed.args.slice(3).join(' ')
    }), null, 2));
    break;
  case 'send-progress':
    console.log(JSON.stringify(await sendProgress(config, {
      intentId: `${config.participantId}-progress-${Date.now()}`,
      taskId: parsed.args[0],
      threadId: parsed.args[1],
      summary: parsed.args.slice(2).join(' ')
    }), null, 2));
    break;
  case 'set-work-state':
    console.log(JSON.stringify(await updateWorkState(config, {
      status: parsed.args[0],
      taskId: normalizeOptionalValue(parsed.args[1]),
      threadId: normalizeOptionalValue(parsed.args[2]),
      summary: parsed.args.slice(3).join(' ') || undefined
    }), null, 2));
    break;
  default:
    usage();
    process.exit(1);
}
