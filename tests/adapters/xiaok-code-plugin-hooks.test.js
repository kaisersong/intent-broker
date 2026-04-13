import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runPermissionRequestHook,
  runPreToolUseHook
} from '../../adapters/xiaok-code-plugin/hooks.js';

test('pre tool use hook mirrors a live xiaok approval request through broker', async () => {
  const calls = [];
  const result = await runPreToolUseHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker',
      tool_name: 'shell',
      tool_input: { command: 'npm test' },
      tool_use_id: 'toolu-xiaok-1'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      requestHookApproval: async (input) => {
        calls.push(input);
        return { approved: true, approvalId: 'approval-xiaok-1' };
      }
    }
  );

  assert.equal(result.approved, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentTool, 'xiaok-code');
  assert.equal(calls[0].hookEventName, 'PreToolUse');
  assert.equal(calls[0].sessionId, '019d448e-1234-5678-9999-aaaaaaaaaaaa');
  assert.equal(calls[0].toolName, 'shell');
  assert.deepEqual(calls[0].toolInput, { command: 'npm test' });
  assert.equal(calls[0].toolUseId, 'toolu-xiaok-1');
  assert.equal(calls[0].config.participantId, 'xiaok-code-session-019d448e');
});

test('permission request hook mirrors a live xiaok approval request through broker', async () => {
  const calls = [];
  const result = await runPermissionRequestHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker',
      tool_name: 'shell',
      tool_input: { command: 'npm test' },
      tool_use_id: 'toolu-xiaok-2'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      requestHookApproval: async (input) => {
        calls.push(input);
        return { approved: false, message: 'denied' };
      }
    }
  );

  assert.equal(result.approved, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentTool, 'xiaok-code');
  assert.equal(calls[0].hookEventName, 'PermissionRequest');
  assert.equal(calls[0].toolUseId, 'toolu-xiaok-2');
});
