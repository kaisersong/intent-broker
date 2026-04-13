import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mirrorCodexNativeApproval,
  parseCodexNativeApprovalCall,
  sendTerminalApprovalDecision
} from '../../adapters/session-bridge/codex-native-approval.js';

function codexFunctionCallLine(args, callId = 'call_abc123') {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      call_id: callId,
      arguments: JSON.stringify(args)
    }
  });
}

test('parseCodexNativeApprovalCall extracts real Codex escalated exec approvals', () => {
  const call = parseCodexNativeApprovalCall(codexFunctionCallLine({
    cmd: "printf 'ok\\n'",
    workdir: '/Users/song/projects/hexdeck',
    sandbox_permissions: 'require_escalated',
    justification: '需要用户确认'
  }));

  assert.deepEqual(call, {
    callId: 'call_abc123',
    command: "printf 'ok\\n'",
    workdir: '/Users/song/projects/hexdeck',
    justification: '需要用户确认'
  });
});

test('parseCodexNativeApprovalCall ignores non-escalated exec calls', () => {
  const call = parseCodexNativeApprovalCall(codexFunctionCallLine({
    cmd: "printf 'ok\\n'",
    workdir: '/Users/song/projects/hexdeck'
  }));

  assert.equal(call, null);
});

test('mirrorCodexNativeApproval posts a broker approval and applies the human response to Codex', async () => {
  const requests = [];
  const sentDecisions = [];

  const result = await mirrorCodexNativeApproval({
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d4489'
    },
    call: {
      callId: 'call_real_1',
      command: "printf 'real\\n'",
      workdir: '/Users/song/projects/hexdeck',
      justification: '真实 Codex 审批'
    },
    sessionId: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
    transcriptPath: '/Users/song/.codex/sessions/run.jsonl',
    terminalMetadata: {
      terminalApp: 'Ghostty',
      terminalSessionID: 'ghostty-terminal-1'
    },
    requestJson: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/intents')) {
        return { event: { eventId: 100 } };
      }
      if (url.includes('/events/replay?after=99&limit=100')) {
        return {
          items: [
            {
              eventId: 101,
              kind: 'respond_approval',
              payload: {
                approvalId: 'codex-native-call_real_1',
                decision: 'approved'
              }
            }
          ]
        };
      }
      return { items: [] };
    },
    sendApprovalDecision: async (terminalMetadata, decision) => {
      sentDecisions.push({ terminalMetadata, decision });
      return 'sent';
    },
    sleep: async () => {}
  });

  assert.equal(result.approvalId, 'codex-native-call_real_1');
  assert.equal(result.responseEventId, 101);
  assert.equal(result.keyResult, 'sent');

  const requestBody = JSON.parse(requests[0].options.body);
  assert.equal(requestBody.kind, 'request_approval');
  assert.equal(requestBody.fromParticipantId, 'codex-session-019d4489');
  assert.equal(requestBody.taskId, 'codex-native-approval-call_real_1');
  assert.equal(requestBody.payload.approvalId, 'codex-native-call_real_1');
  assert.equal(requestBody.payload.body.summary, '真实 Codex 审批');
  assert.equal(requestBody.payload.body.commandLine, "printf 'real\\n'");
  assert.equal(requestBody.payload.nativeCodexApproval.callId, 'call_real_1');
  assert.equal(requestBody.payload.nativeCodexApproval.transcriptPath, '/Users/song/.codex/sessions/run.jsonl');
  assert.equal(requestBody.payload.delivery.semantic, 'actionable');

  assert.deepEqual(sentDecisions, [
    {
      terminalMetadata: {
        terminalApp: 'Ghostty',
        terminalSessionID: 'ghostty-terminal-1'
      },
      decision: 'approved'
    }
  ]);
});

test('sendTerminalApprovalDecision sends the Codex approval key to Ghostty', async () => {
  const calls = [];

  const result = await sendTerminalApprovalDecision(
    {
      terminalApp: 'Ghostty',
      terminalSessionID: 'ghostty-terminal-1'
    },
    'approved',
    {
      execFile: async (command, args, options) => {
        calls.push({ command, args, options });
        return { stdout: 'sent\n' };
      }
    }
  );

  assert.equal(result, 'sent');
  assert.equal(calls[0].command, '/usr/bin/osascript');
  assert.deepEqual(calls[0].args.slice(0, 1), ['-e']);
  assert.match(calls[0].args[1], /tell application "Ghostty"/);
  assert.match(calls[0].args[1], /ghostty-terminal-1/);
  assert.match(calls[0].args[1], /input text "y\n" to targetTerminal/);
  assert.equal(calls[0].options.encoding, 'utf8');
});
