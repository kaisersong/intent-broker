import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runPermissionRequestHook,
  runPreToolUseHook
} from '../../adapters/xiaok-code-plugin/hooks.js';

test('pre tool use hook mirrors a live xiaok approval request through broker when the tool input is explicitly approval-gated', async () => {
  const calls = [];
  const result = await runPreToolUseHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker',
      tool_name: 'shell',
      tool_input: {
        command: 'npm test',
        justification: 'user confirmation required before running this tool'
      },
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
  assert.deepEqual(calls[0].toolInput, {
    command: 'npm test',
    justification: 'user confirmation required before running this tool'
  });
  assert.equal(calls[0].toolUseId, 'toolu-xiaok-1');
  assert.equal(calls[0].config.participantId, 'xiaok-code-session-019d448e');
});

test('pre tool use hook skips ordinary internal commands without an explicit approval signal', async () => {
  const calls = [];
  const result = await runPreToolUseHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: 'C:\\Users\\song',
      tool_name: 'tool_search',
      tool_input: {
        command: 'intent_create',
        path: 'C:\\Users\\song'
      },
      tool_use_id: 'toolu-xiaok-ordinary'
    },
    {
      env: {},
      cwd: 'C:\\Users\\song',
      requestHookApproval: async (input) => {
        calls.push(input);
        return { approved: true, approvalId: 'approval-xiaok-ordinary' };
      }
    }
  );

  assert.deepEqual(result, { approved: true, skipped: true });
  assert.equal(calls.length, 0);
});

test('pre tool use hook still mirrors tools that carry an explicit approval signal', async () => {
  const calls = [];
  const result = await runPreToolUseHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker',
      tool_name: 'shell',
      tool_input: {
        command: 'npm publish',
        justification: 'publishing requires user confirmation'
      },
      tool_use_id: 'toolu-xiaok-explicit'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      requestHookApproval: async (input) => {
        calls.push(input);
        return { approved: true, approvalId: 'approval-xiaok-explicit' };
      }
    }
  );

  assert.equal(result.approved, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hookEventName, 'PreToolUse');
  assert.equal(calls[0].toolUseId, 'toolu-xiaok-explicit');
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
