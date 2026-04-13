import { execFile as execFileCallback } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import { requestJson as requestJsonDefault } from './api.js';

const execFileDefault = promisify(execFileCallback);
const DEFAULT_POLL_MS = 250;
const DEFAULT_RESPONSE_TIMEOUT_MS = 120000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeIdentifier(value) {
  return String(value || Date.now()).replace(/[^A-Za-z0-9_-]/g, '-');
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function parseCodexNativeApprovalCall(line, { projectPath = process.cwd() } = {}) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }

  const payload = entry?.payload;
  if (entry?.type !== 'response_item' || payload?.type !== 'function_call' || payload?.name !== 'exec_command') {
    return null;
  }

  let args;
  try {
    args = JSON.parse(payload.arguments || '{}');
  } catch {
    return null;
  }

  if (args?.sandbox_permissions !== 'require_escalated') {
    return null;
  }

  return {
    callId: payload.call_id,
    command: args.cmd || '',
    workdir: args.workdir || projectPath,
    justification: args.justification || 'Codex command approval requested'
  };
}

function buildApprovalRequest({ config, call, sessionId, transcriptPath }) {
  const safeCallId = safeIdentifier(call.callId);
  const approvalId = `codex-native-${safeCallId}`;
  const taskId = `codex-native-approval-${safeCallId}`;
  const threadId = `codex-native-approval-${sessionId || config.participantId}`;

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
          summary: call.justification,
          detailText: 'Mirrored from the live Codex terminal approval prompt. Approving this card sends the approval key back to that Codex prompt.',
          commandTitle: 'Codex',
          commandLine: call.command,
          commandPreview: call.workdir
        },
        actions: [
          { label: '允许', decisionMode: 'yes' },
          { label: '拒绝', decisionMode: 'no' }
        ],
        nativeCodexApproval: {
          callId: call.callId,
          transcriptPath,
          terminalSessionId: normalizeOptionalString(config.metadata?.terminalSessionID)
        },
        delivery: {
          semantic: 'actionable',
          source: 'codex-native-approval'
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

export async function sendTerminalApprovalDecision(
  terminalMetadata,
  decision,
  {
    execFile = execFileDefault
  } = {}
) {
  const terminalApp = String(terminalMetadata?.terminalApp || '');
  const terminalSessionID = normalizeOptionalString(terminalMetadata?.terminalSessionID);
  if (!terminalApp.toLowerCase().includes('ghostty')) {
    throw new Error(`unsupported terminal for Codex native approval: ${terminalApp || 'unknown'}`);
  }
  if (!terminalSessionID) {
    throw new Error('missing Ghostty terminalSessionID for Codex native approval');
  }

  const terminalId = escapeAppleScript(terminalSessionID);
  const text = decision === 'denied' ? '' : 'y\n';
  const approveCommand = decision === 'denied'
    ? 'send key "escape" to targetTerminal'
    : `input text "${escapeAppleScript(text)}" to targetTerminal`;
  const script = `
tell application "Ghostty"
    set targetWindow to missing value
    set targetTab to missing value
    set targetTerminal to missing value
    repeat with aWindow in windows
        repeat with aTab in tabs of aWindow
            repeat with aTerminal in terminals of aTab
                if (id of aTerminal as text) is "${terminalId}" then
                    set targetWindow to aWindow
                    set targetTab to aTab
                    set targetTerminal to aTerminal
                    exit repeat
                end if
            end repeat
            if targetTerminal is not missing value then exit repeat
        end repeat
        if targetTerminal is not missing value then exit repeat
    end repeat
    if targetTerminal is missing value then return "missing-terminal"
    activate
    activate window targetWindow
    delay 0.05
    select tab targetTab
    delay 0.05
    focus targetTerminal
    delay 0.05
    ${approveCommand}
    return "sent"
end tell
`;

  const { stdout } = await execFile('/usr/bin/osascript', ['-e', script], { encoding: 'utf8' });
  return String(stdout || '').trim();
}

export async function mirrorCodexNativeApproval({
  config,
  call,
  sessionId,
  transcriptPath,
  terminalMetadata = config?.metadata || {},
  requestJson = requestJsonDefault,
  sendApprovalDecision = sendTerminalApprovalDecision,
  sleep: sleepImpl = sleep
}) {
  const approval = buildApprovalRequest({ config, call, sessionId, transcriptPath });
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
  const decision = response.payload?.decision === 'denied' ? 'denied' : 'approved';
  const keyResult = await sendApprovalDecision(terminalMetadata, decision);

  return {
    approvalId: approval.approvalId,
    taskId: approval.taskId,
    threadId: approval.threadId,
    requestEventId: eventId,
    responseEventId: response.eventId,
    decision,
    keyResult
  };
}

async function readTranscriptTail(transcriptPath, offset) {
  const currentSize = (await stat(transcriptPath)).size;
  if (currentSize <= offset) {
    return { offset, tail: '' };
  }

  const buffer = await readFile(transcriptPath);
  return {
    offset: currentSize,
    tail: buffer.subarray(offset).toString('utf8')
  };
}

export function startCodexNativeApprovalWatcher({
  config,
  sessionId,
  transcriptPath,
  cwd = process.cwd(),
  terminalMetadata = config?.metadata || {},
  requestJson = requestJsonDefault,
  sendApprovalDecision = sendTerminalApprovalDecision,
  sleep: sleepImpl = sleep,
  pollMs = DEFAULT_POLL_MS,
  onError = () => {}
} = {}) {
  let stopped = false;
  const seen = new Set();

  const done = (async () => {
    if (!config || !sessionId || !transcriptPath || !terminalMetadata?.terminalSessionID) {
      return;
    }

    let offset;
    try {
      offset = (await stat(transcriptPath)).size;
    } catch (error) {
      onError(error);
      return;
    }
    let carry = '';

    while (!stopped) {
      try {
        const next = await readTranscriptTail(transcriptPath, offset);
        offset = next.offset;

        if (next.tail) {
          const combined = `${carry}${next.tail}`;
          const lines = combined.split('\n');
          carry = combined.endsWith('\n') ? '' : lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) {
              continue;
            }

            const call = parseCodexNativeApprovalCall(line, { projectPath: cwd });
            if (!call || seen.has(call.callId)) {
              continue;
            }

            seen.add(call.callId);
            await mirrorCodexNativeApproval({
              config,
              call,
              sessionId,
              transcriptPath,
              terminalMetadata,
              requestJson,
              sendApprovalDecision,
              sleep: sleepImpl
            });
          }
        }
      } catch (error) {
        onError(error);
      }

      await sleepImpl(pollMs);
    }
  })();

  return {
    stop() {
      stopped = true;
    },
    done
  };
}
