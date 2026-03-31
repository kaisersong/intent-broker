#!/usr/bin/env node
import { deriveSessionBridgeConfig } from './config.js';

function usage() {
  console.log(`Usage:
  node adapters/session-bridge/cli.js register [toolName]
  node adapters/session-bridge/cli.js poll [toolName] [after]
  node adapters/session-bridge/cli.js ack [toolName] <eventId>
  node adapters/session-bridge/cli.js send-task [toolName] <toParticipantId> <taskId> <threadId> <summary>
  node adapters/session-bridge/cli.js send-progress [toolName] <taskId> <threadId> <summary>`);
}

async function register(config) {
  const response = await fetch(`${config.brokerUrl}/participants/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      participantId: config.participantId,
      kind: 'agent',
      roles: config.roles,
      capabilities: config.capabilities
    })
  });
  console.log(JSON.stringify(await response.json(), null, 2));
}

async function poll(config, after = '0') {
  const response = await fetch(`${config.brokerUrl}/inbox/${config.participantId}?after=${after}&limit=50`);
  console.log(JSON.stringify(await response.json(), null, 2));
}

async function ack(config, eventId) {
  const response = await fetch(`${config.brokerUrl}/inbox/${config.participantId}/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: Number(eventId) })
  });
  console.log(JSON.stringify(await response.json(), null, 2));
}

async function sendTask(config, toParticipantId, taskId, threadId, summary) {
  const response = await fetch(`${config.brokerUrl}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intentId: `${config.participantId}-task-${Date.now()}`,
      kind: 'request_task',
      fromParticipantId: config.participantId,
      taskId,
      threadId,
      to: { mode: 'participant', participants: [toParticipantId] },
      payload: { body: { summary } }
    })
  });
  console.log(JSON.stringify(await response.json(), null, 2));
}

async function sendProgress(config, taskId, threadId, summary) {
  const response = await fetch(`${config.brokerUrl}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intentId: `${config.participantId}-progress-${Date.now()}`,
      kind: 'report_progress',
      fromParticipantId: config.participantId,
      taskId,
      threadId,
      to: { mode: 'broadcast' },
      payload: { stage: 'in_progress', body: { summary } }
    })
  });
  console.log(JSON.stringify(await response.json(), null, 2));
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
