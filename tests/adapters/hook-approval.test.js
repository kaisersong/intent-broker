import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudePermissionRequestOutput,
  buildCodexPreToolUseOutput,
  buildXiaokPermissionHookOutput,
  requestHookApproval
} from '../../adapters/session-bridge/hook-approval.js';

test('requestHookApproval mirrors a Codex PreToolUse approval through broker', async () => {
  const requests = [];

  const result = await requestHookApproval({
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d4489',
      context: { projectName: 'hexdeck' }
    },
    agentTool: 'codex',
    hookEventName: 'PreToolUse',
    sessionId: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
    cwd: '/Users/song/projects/hexdeck',
    toolName: 'exec_command',
    toolInput: {
      command: "printf 'hook-real\\n'"
    },
    toolUseId: 'toolu-codex-1',
    requestJson: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/intents')) {
        return { event: { eventId: 200 } };
      }
      if (url.includes('/events/replay?after=199&limit=100')) {
        return {
          items: [
            {
              eventId: 201,
              kind: 'respond_approval',
              payload: {
                approvalId: 'codex-hook-PreToolUse-toolu-codex-1',
                decision: 'approved'
              }
            }
          ]
        };
      }
      return { items: [] };
    },
    sleep: async () => {}
  });

  assert.deepEqual(result, {
    approved: true,
    approvalId: 'codex-hook-PreToolUse-toolu-codex-1',
    requestEventId: 200,
    responseEventId: 201
  });

  const requestBody = JSON.parse(requests[0].options.body);
  assert.equal(requestBody.kind, 'request_approval');
  assert.equal(requestBody.fromParticipantId, 'codex-session-019d4489');
  assert.equal(requestBody.payload.approvalId, 'codex-hook-PreToolUse-toolu-codex-1');
  assert.equal(requestBody.payload.approvalScope, 'run_command');
  assert.equal(requestBody.payload.body.commandTitle, 'Codex');
  assert.equal(requestBody.payload.body.commandLine, "printf 'hook-real\\n'");
  assert.equal(requestBody.payload.body.commandPreview, '/Users/song/projects/hexdeck');
  assert.equal(requestBody.payload.nativeHookApproval.hookEventName, 'PreToolUse');
  assert.equal(requestBody.payload.nativeHookApproval.toolUseId, 'toolu-codex-1');
  assert.equal(requestBody.payload.delivery.semantic, 'actionable');
  assert.equal(requestBody.payload.delivery.source, 'codex-hook-approval');
});

test('requestHookApproval returns denied when broker response denies the approval', async () => {
  const result = await requestHookApproval({
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'claude-code-session-019d4489'
    },
    agentTool: 'claude-code',
    hookEventName: 'PermissionRequest',
    sessionId: 'claude-session-1',
    cwd: '/tmp/worktree',
    toolName: 'Bash',
    toolInput: { command: 'ls -la' },
    toolUseId: 'toolu-claude-1',
    requestJson: async (url) => {
      if (url.endsWith('/intents')) {
        return { event: { eventId: 300 } };
      }
      return {
        items: [
          {
            eventId: 301,
            kind: 'respond_approval',
            payload: {
              approvalId: 'claude-code-hook-PermissionRequest-toolu-claude-1',
              decision: 'denied'
            }
          }
        ]
      };
    },
    sleep: async () => {}
  });

  assert.equal(result.approved, false);
  assert.equal(result.approvalId, 'claude-code-hook-PermissionRequest-toolu-claude-1');
});

test('hook output helpers encode Codex, Claude Code, and xiaok decisions', () => {
  assert.equal(buildCodexPreToolUseOutput({ approved: true }), null);
  assert.deepEqual(buildCodexPreToolUseOutput({ approved: false, message: 'No' }), {
    decision: 'block',
    reason: 'No'
  });

  assert.deepEqual(
    buildClaudePermissionRequestOutput({
      approved: true,
      updatedInput: { command: 'ls -la' }
    }),
    {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: { command: 'ls -la' }
        }
      }
    }
  );

  assert.deepEqual(buildClaudePermissionRequestOutput({ approved: false, message: 'No' }), {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message: 'No',
        interrupt: false
      }
    }
  });

  assert.equal(buildXiaokPermissionHookOutput({ approved: true }), null);
  assert.deepEqual(buildXiaokPermissionHookOutput({ approved: false, message: 'No' }), {
    ok: false,
    preventContinuation: true,
    decision: 'deny',
    message: 'No'
  });
});
