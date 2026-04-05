#!/usr/bin/env node
import { deriveSessionBridgeConfig } from '../adapters/session-bridge/config.js';
import {
  ackInbox,
  listParticipants,
  listWorkStates,
  pollInbox,
  registerParticipant,
  resolveParticipantAliases,
  sendAsk,
  sendProgress,
  sendTask,
  updateWorkState
} from '../adapters/session-bridge/api.js';
import {
  runInboxCommand,
  runReplyCommand,
  runWhoCommand
} from '../adapters/session-bridge/command-runner.js';
import { runCliMain } from '../adapters/session-bridge/cli-errors.js';

function usage() {
  console.log(`Usage:
  intent-broker [--tool codex|claude-code|opencode|xiaok-code] register
  intent-broker [--tool ...] inbox
  intent-broker [--tool ...] who
  intent-broker [--tool ...] reply [@alias] <summary>
  intent-broker [--tool ...] poll [after]
  intent-broker [--tool ...] ack <eventId>
  intent-broker [--tool ...] task <toParticipantId> <taskId> <threadId> <summary>
  intent-broker [--tool ...] ask <toParticipantId> <taskId> <threadId> <summary>
  intent-broker [--tool ...] note <toParticipantId> <taskId> <threadId> <summary>
  intent-broker [--tool ...] progress <taskId> <threadId> <summary>
  intent-broker [--tool ...] send-task <toParticipantId> <taskId> <threadId> <summary>
  intent-broker [--tool ...] send-progress <taskId> <threadId> <summary>
  intent-broker [--tool ...] set-work-state <status> [taskId] [threadId] [summary]
  intent-broker away
  intent-broker back`);
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

async function runTaskCommand(config, args) {
  return sendTask(config, {
    intentId: `${config.participantId}-task-${Date.now()}`,
    toParticipantId: args[0],
    taskId: args[1],
    threadId: args[2],
    summary: args.slice(3).join(' ')
  });
}

async function runAskCommand(config, args) {
  return sendAsk(config, {
    intentId: `${config.participantId}-ask-${Date.now()}`,
    toParticipantId: args[0],
    taskId: args[1],
    threadId: args[2],
    summary: args.slice(3).join(' '),
    delivery: { semantic: 'actionable', source: 'explicit' }
  });
}

async function runNoteCommand(config, args) {
  return sendProgress(config, {
    intentId: `${config.participantId}-note-${Date.now()}`,
    toParticipantId: args[0],
    taskId: args[1],
    threadId: args[2],
    summary: args.slice(3).join(' '),
    delivery: { semantic: 'informational', source: 'explicit' }
  });
}

async function runProgressCommand(config, args) {
  return sendProgress(config, {
    intentId: `${config.participantId}-progress-${Date.now()}`,
    taskId: args[0],
    threadId: args[1],
    summary: args.slice(2).join(' '),
    delivery: { semantic: 'informational', source: 'explicit' }
  });
}

async function main() {
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
    case 'task':
      console.log(JSON.stringify(await runTaskCommand(config, parsed.args), null, 2));
      break;
    case 'ask':
      console.log(JSON.stringify(await runAskCommand(config, parsed.args), null, 2));
      break;
    case 'note':
      console.log(JSON.stringify(await runNoteCommand(config, parsed.args), null, 2));
      break;
    case 'progress':
      console.log(JSON.stringify(await runProgressCommand(config, parsed.args), null, 2));
      break;
    case 'send-task':
      console.log(JSON.stringify(await runTaskCommand(config, parsed.args), null, 2));
      break;
    case 'send-progress':
      console.log(JSON.stringify(await runProgressCommand(config, parsed.args), null, 2));
      break;
    case 'set-work-state':
      console.log(JSON.stringify(await updateWorkState(config, {
        status: parsed.args[0],
        taskId: normalizeOptionalValue(parsed.args[1]),
        threadId: normalizeOptionalValue(parsed.args[2]),
        summary: parsed.args.slice(3).join(' ') || undefined
      }), null, 2));
      break;
    case 'away': {
      const res = await fetch(`${config.brokerUrl}/away`, { method: 'POST' });
      const json = await res.json();
      console.log(json.away ? '离开模式已开启。所有需要回复的消息将转发到 channel。' : '操作失败');
      break;
    }
    case 'back': {
      const res = await fetch(`${config.brokerUrl}/away`, { method: 'DELETE' });
      const json = await res.json();
      console.log(!json.away ? '已恢复正常模式。' : '操作失败');
      break;
    }
    default:
      usage();
      process.exit(1);
  }
}

await runCliMain(main);
