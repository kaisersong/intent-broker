import { requestJson as requestJsonDefault } from './api.js';

const DEFAULT_POLL_MS = 250;
const DEFAULT_RESPONSE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeIdentifier(value) {
  return String(value || Date.now()).replace(/[^A-Za-z0-9_-]/g, '-');
}

function titleForAgentTool(agentTool) {
  switch (agentTool) {
    case 'claude-code':
      return 'Claude Code';
    case 'xiaok-code':
      return 'xiaok';
    case 'codex':
      return 'Codex';
    default:
      return agentTool || 'Agent';
  }
}

function deliverySourceForAgentTool(agentTool) {
  switch (agentTool) {
    case 'claude-code':
      return 'claude-code-hook-approval';
    case 'xiaok-code':
      return 'xiaok-code-hook-approval';
    case 'codex':
      return 'codex-hook-approval';
    default:
      return 'agent-hook-approval';
  }
}

function stringValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return '';
}

function toolInputPreview(toolInput = {}) {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return stringValue(toolInput);
  }

  const keyPriority = ['command', 'cmd', 'file_path', 'path', 'target_file', 'query', 'pattern', 'prompt', 'description', 'url'];
  for (const key of keyPriority) {
    const value = stringValue(toolInput[key]);
    if (value) {
      return value;
    }
  }

  return stringValue(toolInput);
}

function buildApprovalRequest({
  config,
  agentTool,
  hookEventName,
  sessionId,
  cwd,
  toolName,
  toolInput,
  toolUseId
}) {
  const safeToolUseId = safeIdentifier(toolUseId || `${hookEventName}-${Date.now()}`);
  const approvalId = `${agentTool}-hook-${hookEventName}-${safeToolUseId}`;
  const taskId = `${agentTool}-hook-approval-${safeToolUseId}`;
  const threadId = `${agentTool}-hook-approval-${sessionId || config.participantId}`;
  const agentTitle = titleForAgentTool(agentTool);
  const preview = toolInputPreview(toolInput);

  return {
    approvalId,
    taskId,
    threadId,
    body: {
      intentId: `intent-${approvalId}-${Date.now()}`,
      kind: 'request_approval',
      fromParticipantId: config.participantId,
      taskId,
      threadId,
      to: { mode: 'participant', participants: ['human.local'] },
      payload: {
        participantId: config.participantId,
        approvalId,
        approvalScope: 'run_command',
        body: {
          summary: `${agentTitle} needs approval to run ${toolName || 'a tool'}.`,
          detailText: `Mirrored from the live ${agentTitle} ${hookEventName} hook. Approving this card lets the hook continue.`,
          commandTitle: agentTitle,
          commandLine: preview || toolName || 'Tool request',
          commandPreview: cwd
        },
        actions: [
          { label: '允许一次', decisionMode: 'yes' },
          { label: '拒绝', decisionMode: 'no' }
        ],
        nativeHookApproval: {
          agentTool,
          hookEventName,
          sessionId: normalizeOptionalString(sessionId),
          toolName: normalizeOptionalString(toolName),
          toolUseId: normalizeOptionalString(toolUseId)
        },
        delivery: {
          semantic: 'actionable',
          source: deliverySourceForAgentTool(agentTool)
        }
      }
    }
  };
}

async function waitForApprovalResponse({
  config,
  approvalId,
  afterEventId,
  requestJson = requestJsonDefault,
  sleep: sleepImpl = sleep,
  timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS
}) {
  let after = Math.max(0, Number(afterEventId || 0) - 1);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const replay = await requestJson(`${config.brokerUrl}/events/replay?after=${after}&limit=100`);
    for (const event of replay.items || []) {
      after = Math.max(after, Number(event.eventId || event.id || 0));
      if (
        (event.kind || event.type) === 'respond_approval'
        && event.payload?.approvalId === approvalId
      ) {
        return event;
      }
    }
    await sleepImpl(pollMs);
  }

  throw new Error(`timeout waiting for ${approvalId}`);
}

export async function requestHookApproval({
  config,
  agentTool,
  hookEventName,
  sessionId,
  cwd,
  toolName,
  toolInput,
  toolUseId,
  requestJson = requestJsonDefault,
  sleep: sleepImpl = sleep
}) {
  const approval = buildApprovalRequest({
    config,
    agentTool,
    hookEventName,
    sessionId,
    cwd,
    toolName,
    toolInput,
    toolUseId
  });
  const sent = await requestJson(`${config.brokerUrl}/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(approval.body)
  });
  const eventId = sent.event?.eventId ?? sent.eventId ?? 0;
  const response = await waitForApprovalResponse({
    config,
    approvalId: approval.approvalId,
    afterEventId: eventId,
    requestJson,
    sleep: sleepImpl
  });

  return {
    approved: response.payload?.decision !== 'denied',
    approvalId: approval.approvalId,
    requestEventId: eventId,
    responseEventId: response.eventId
  };
}

export async function requestHookApprovalFailOpen(input) {
  try {
    return await requestHookApproval(input);
  } catch (error) {
    return {
      approved: true,
      skipped: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function buildCodexPreToolUseOutput(result) {
  if (result?.approved !== false) {
    return null;
  }
  return {
    decision: 'block',
    reason: result.message || 'Permission denied via HexDeck.'
  };
}

export function buildClaudePermissionRequestOutput(result = {}) {
  if (result.approved === false) {
    return {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: result.message || 'Permission denied via HexDeck.',
          interrupt: false
        }
      }
    };
  }

  const decision = {
    behavior: 'allow'
  };
  if (result.updatedInput) {
    decision.updatedInput = result.updatedInput;
  }

  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision
    }
  };
}

export function buildXiaokPermissionHookOutput(result) {
  if (result?.approved !== false) {
    return null;
  }
  return {
    ok: false,
    preventContinuation: true,
    decision: 'deny',
    message: result.message || 'Permission denied via HexDeck.'
  };
}
