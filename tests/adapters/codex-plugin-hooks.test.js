import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runPreToolUseHook,
  runStopHook,
  runSessionStartHook,
  runUserPromptSubmitHook
} from '../../adapters/codex-plugin/hooks.js';

test('pre tool use hook mirrors a live Codex approval request through broker', async () => {
  const calls = [];
  const result = await runPreToolUseHook(
    {
      thread_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker',
      tool_name: 'exec_command',
      tool_input: { command: 'rm /tmp/example.txt' },
      tool_use_id: 'toolu-1'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      requestHookApproval: async (input) => {
        calls.push(input);
        return { approved: true, approvalId: 'approval-1' };
      }
    }
  );

  assert.equal(result.approved, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentTool, 'codex');
  assert.equal(calls[0].hookEventName, 'PreToolUse');
  assert.equal(calls[0].sessionId, '019d448e-1234-5678-9999-aaaaaaaaaaaa');
  assert.equal(calls[0].toolName, 'exec_command');
  assert.deepEqual(calls[0].toolInput, { command: 'rm /tmp/example.txt' });
  assert.equal(calls[0].toolUseId, 'toolu-1');
  assert.equal(calls[0].config.participantId, 'codex-session-019d448e');
});

test('pre tool use hook skips approval mirroring for read-only exec commands', async () => {
  const calls = [];
  const result = await runPreToolUseHook(
    {
      thread_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker',
      tool_name: 'exec_command',
      tool_input: { cmd: 'rg "approval" src tests' },
      tool_use_id: 'toolu-read-only'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      requestHookApproval: async (input) => {
        calls.push(input);
        return { approved: true, approvalId: 'approval-read-only' };
      }
    }
  );

  assert.deepEqual(result, { approved: true, skipped: true });
  assert.equal(calls.length, 0);
});

test('pre tool use hook skips approval mirroring for routine test commands', async () => {
  const calls = [];
  const result = await runPreToolUseHook(
    {
      thread_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker',
      tool_name: 'exec_command',
      tool_input: { command: 'npm test -- tests/adapters/codex-plugin-hooks.test.js' },
      tool_use_id: 'toolu-test-run'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      requestHookApproval: async (input) => {
        calls.push(input);
        return { approved: true, approvalId: 'approval-test-run' };
      }
    }
  );

  assert.deepEqual(result, { approved: true, skipped: true });
  assert.equal(calls.length, 0);
});

test('pre tool use hook still mirrors approval for destructive exec commands', async () => {
  const calls = [];
  const result = await runPreToolUseHook(
    {
      thread_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker',
      tool_name: 'exec_command',
      tool_input: { cmd: 'rm /tmp/example.txt' },
      tool_use_id: 'toolu-destructive'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      requestHookApproval: async (input) => {
        calls.push(input);
        return { approved: true, approvalId: 'approval-destructive' };
      }
    }
  );

  assert.equal(result.approved, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolUseId, 'toolu-destructive');
  assert.deepEqual(calls[0].toolInput, { cmd: 'rm /tmp/example.txt' });
});

test('pre tool use hook skips approval mirroring for routine Bash commands', async () => {
  const calls = [];
  const result = await runPreToolUseHook(
    {
      thread_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker',
      tool_name: 'Bash',
      tool_input: { command: 'sed -n \'1,40p\' README.md' },
      tool_use_id: 'toolu-bash-read-only'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      requestHookApproval: async (input) => {
        calls.push(input);
        return { approved: true, approvalId: 'approval-bash-read-only' };
      }
    }
  );

  assert.deepEqual(result, { approved: true, skipped: true });
  assert.equal(calls.length, 0);
});

test('pre tool use hook mirrors approval for Bash commands that explicitly require approval', async () => {
  const calls = [];
  const result = await runPreToolUseHook(
    {
      thread_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker',
      tool_name: 'Bash',
      tool_input: {
        command: 'python3 scripts/export.py',
        sandbox_permissions: 'require_escalated',
        justification: 'Export needs access outside the sandbox'
      },
      tool_use_id: 'toolu-bash-escalated'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      requestHookApproval: async (input) => {
        calls.push(input);
        return { approved: true, approvalId: 'approval-bash-escalated' };
      }
    }
  );

  assert.equal(result.approved, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, 'Bash');
  assert.equal(calls[0].toolUseId, 'toolu-bash-escalated');
  assert.deepEqual(calls[0].toolInput, {
    command: 'python3 scripts/export.py',
    sandbox_permissions: 'require_escalated',
    justification: 'Export needs access outside the sandbox'
  });
});

test('session start hook always registers and returns no output when inbox is empty', async () => {
  const calls = [];
  const result = await runSessionStartHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      saveRuntimeState: () => {},
      ensureSessionKeeper: async (input) => {
        calls.push({ type: 'keeper', input });
      },
      ensureRealtimeBridge: async (input) => {
        calls.push({ type: 'bridge', input });
      },
      registerParticipant: async (config) => {
        calls.push({ type: 'register', config });
        return { ok: true };
      },
      updateWorkState: async (config, state) => {
        calls.push({ type: 'work-state', config, state });
        return { ok: true };
      },
      pollInbox: async (config, options) => {
        calls.push({ type: 'poll', config, options });
        return { items: [] };
      }
    }
  );

  assert.equal(result.context, null);
  assert.equal(result.registration.ok, true);
  assert.equal(calls[0].type, 'keeper');
  assert.equal(calls[0].input.config.participantId, 'codex-session-019d448e');
  assert.equal(calls[0].input.sessionId, '019d448e-1234-5678-9999-aaaaaaaaaaaa');
  assert.equal(calls[1].type, 'bridge');
  assert.equal(calls[1].input.config.participantId, 'codex-session-019d448e');
  assert.equal(calls[2].type, 'register');
  assert.equal(calls[2].config.participantId, 'codex-session-019d448e');
  assert.equal(calls[2].config.inboxMode, 'realtime');
  assert.deepEqual(calls[2].config.context, { projectName: 'intent-broker' });
  assert.equal(calls[3].type, 'work-state');
  assert.deepEqual(calls[3].state, { status: 'idle', summary: null });
  assert.equal(calls[4].type, 'poll');
});

test('session start hook still launches keeper when broker is unavailable', async () => {
  const calls = [];

  const result = await runSessionStartHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      ensureSessionKeeper: async (input) => {
        calls.push({ type: 'keeper', input });
      },
      ensureRealtimeBridge: async (input) => {
        calls.push({ type: 'bridge', input });
      },
      registerParticipant: async () => {
        calls.push({ type: 'register' });
        throw new Error('fetch failed');
      }
    }
  );

  assert.equal(result, null);
  assert.deepEqual(calls.map((item) => item.type), ['keeper', 'bridge', 'register']);
});

test('session start hook prefers hook session id over inherited CODEX_THREAD_ID', async () => {
  const calls = [];

  await runSessionStartHook(
    {
      session_id: '019d9999-1234-5678-9999-aaaaaaaaaaaa'
    },
    {
      env: {
        CODEX_THREAD_ID: '019d1111-1234-5678-9999-bbbbbbbbbbbb'
      },
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      registerParticipant: async (config) => {
        calls.push(config.participantId);
        return { ok: true };
      },
      updateWorkState: async () => ({ ok: true }),
      pollInbox: async () => ({ items: [] })
    }
  );

  assert.deepEqual(calls, ['codex-session-019d9999']);
});

test('session start hook prefers transcript session cwd over hook cwd for project name', async () => {
  const calls = [];

  await runSessionStartHook(
    {
      session_id: '019d7777-1234-5678-9999-aaaaaaaaaaaa'
    },
    {
      env: {},
      cwd: '/Users/song/projects',
      homeDir: '/Users/song',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      resolveSessionCwdFromTranscript: () => '/Users/song/projects/intent-broker',
      registerParticipant: async (config) => {
        calls.push(config.context);
        return { ok: true };
      },
      updateWorkState: async () => ({ ok: true }),
      pollInbox: async () => ({ items: [] })
    }
  );

  assert.deepEqual(calls, [{ projectName: 'intent-broker' }]);
});

test('user prompt submit hook skips slash commands without registering', async () => {
  const calls = [];
  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: '/status'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      registerParticipant: async () => {
        calls.push('register');
      },
      pollInbox: async () => {
        calls.push('poll');
        return { items: [] };
      }
    }
  );

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('user prompt submit hook injects context, saves cursor, and acks inbox without registering', async () => {
  const saved = [];
  const acked = [];
  const calls = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: '检查一下当前协作上下文'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      loadRealtimeQueueState: () => ({ actionable: [], informational: [], lastEventId: 0 }),
      saveRealtimeQueueState: () => {},
      saveRuntimeState: () => {},
      saveCursorState: (statePath, state) => saved.push({ statePath, state }),
      markPendingReplyMirror: () => {},
      ensureSessionKeeper: async (input) => {
        calls.push({ type: 'keeper', participantId: input.config.participantId, inboxMode: input.config.inboxMode });
      },
      ensureRealtimeBridge: async (input) => {
        calls.push({ type: 'bridge', participantId: input.config.participantId, inboxMode: input.config.inboxMode });
      },
      registerParticipant: async (config) => {
        calls.push({
          type: 'register',
          participantId: config.participantId,
          alias: config.alias,
          inboxMode: config.inboxMode
        });
        return { ok: true };
      },
      pollInbox: async () => ({
        items: [
          {
            eventId: 77,
            kind: 'request_task',
            fromParticipantId: 'codex-peer',
            fromAlias: 'claude2',
            fromProjectName: 'intent-broker',
            taskId: 'real-task-1',
            threadId: 'real-thread-1',
            payload: { body: { summary: 'Please pick this up' } }
          }
        ]
      }),
      ackInbox: async (config, eventId) => acked.push({ participantId: config.participantId, eventId })
    }
  );

  assert.match(result, /Intent Broker update for codex-session-019d4489/);
  assert.match(result, /from claude2/);
  assert.match(result, /task=real-task-1/);
  assert.match(result, /thread=real-thread-1/);
  assert.equal(saved[0].state.lastSeenEventId, 77);
  assert.equal(saved[0].state.recentContext.fromParticipantId, 'codex-peer');
  assert.equal(saved[0].state.recentContext.fromAlias, 'claude2');
  assert.equal(saved[0].state.recentContext.taskId, 'real-task-1');
  assert.equal(saved[0].state.recentContext.threadId, 'real-thread-1');
  assert.deepEqual(acked, [{ participantId: 'codex-session-019d4489', eventId: 77 }]);
  assert.deepEqual(calls, [
    { type: 'keeper', participantId: 'codex-session-019d4489', inboxMode: 'realtime' },
    { type: 'bridge', participantId: 'codex-session-019d4489', inboxMode: 'realtime' },
    { type: 'register', participantId: 'codex-session-019d4489', alias: 'codex', inboxMode: 'realtime' }
  ]);
});

test('user prompt submit hook prefers local realtime queue and does not poll when queued events exist', async () => {
  const savedCursor = [];
  const savedQueue = [];
  const acked = [];
  const calls = [];
  const workStates = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: '继续处理'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      homeDir: '/tmp/intent-broker-hooks',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      saveCursorState: (statePath, state) => savedCursor.push({ statePath, state }),
      loadRealtimeQueueState: () => ({
        actionable: [
          {
            eventId: 77,
            kind: 'request_task',
            fromParticipantId: 'human.song',
            fromAlias: 'song',
            taskId: 'task-queue-1',
            threadId: 'thread-queue-1',
            payload: {
              delivery: { semantic: 'actionable', source: 'default' },
              body: { summary: '修复 broker 在线状态显示' }
            }
          }
        ],
        informational: [
          {
            eventId: 78,
            kind: 'report_progress',
            fromParticipantId: 'claude-peer',
            fromAlias: 'claude2',
            taskId: 'task-queue-1',
            threadId: 'thread-queue-1',
            payload: {
              delivery: { semantic: 'informational', source: 'default' },
              body: { summary: '我正在看 alias rename 广播' }
            }
          }
        ],
        lastEventId: 78
      }),
      saveRealtimeQueueState: (statePath, state) => savedQueue.push({ statePath, state }),
      registerParticipant: async (config) => {
        calls.push({ type: 'register', participantId: config.participantId });
        return { ok: true };
      },
      updateWorkState: async (config, state) => {
        workStates.push({ participantId: config.participantId, state });
        return { ok: true };
      },
      pollInbox: async () => {
        calls.push({ type: 'poll' });
        return { items: [] };
      },
      ackInbox: async (config, eventId) => acked.push({ participantId: config.participantId, eventId })
    }
  );

  assert.match(result, /Actionable items/);
  assert.match(result, /info event/);
  assert.match(result, /修复 broker 在线状态显示/);
  assert.match(result, /我正在看 alias rename 广播/);
  assert.deepEqual(calls, [{ type: 'register', participantId: 'codex-session-019d4489' }]);
  assert.deepEqual(acked, [{ participantId: 'codex-session-019d4489', eventId: 78 }]);
  assert.equal(savedCursor[0].state.lastSeenEventId, 78);
  assert.equal(savedCursor[0].state.recentContext.fromParticipantId, 'claude-peer');
  assert.deepEqual(savedQueue[0].state, {
    actionable: [],
    informational: [],
    lastEventId: 78
  });
  assert.deepEqual(workStates, [
    {
      participantId: 'codex-session-019d4489',
      state: {
        status: 'implementing',
        summary: '修复 broker 在线状态显示',
        taskId: 'task-queue-1',
        threadId: 'thread-queue-1'
      }
    }
  ]);
});

test('user prompt submit hook marks runtime state as running', async () => {
  const savedRuntime = [];
  const workStates = [];

  await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      turn_id: 'turn-1',
      prompt: '继续处理'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({
        lastSeenEventId: 0,
        recentContext: {
          taskId: 'task-12',
          threadId: 'thread-12',
          summary: '继续处理 work-state 同步'
        }
      }),
      loadRealtimeQueueState: () => ({ actionable: [], informational: [], lastEventId: 0 }),
      saveRuntimeState: (statePath, state) => savedRuntime.push({ statePath, state }),
      updateWorkState: async (config, state) => {
        workStates.push({ participantId: config.participantId, state });
        return { ok: true };
      },
      registerParticipant: async () => ({ ok: true }),
      pollInbox: async () => ({ items: [] })
    }
  );

  assert.equal(savedRuntime[0].state.status, 'running');
  assert.equal(savedRuntime[0].state.turnId, 'turn-1');
  assert.equal(savedRuntime[0].state.source, 'user-prompt-submit');
  assert.deepEqual(workStates, [
    {
      participantId: 'codex-session-019d4489',
      state: {
        status: 'implementing',
        summary: '继续处理 work-state 同步',
        taskId: 'task-12',
        threadId: 'thread-12'
      }
    }
  ]);
});

test('user prompt submit hook is a no-op during codex auto-dispatch resumes', async () => {
  const calls = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      turn_id: 'turn-1',
      prompt: '自动续跑'
    },
    {
      env: { INTENT_BROKER_SKIP_INBOX_SYNC: '1' },
      cwd: '/Users/song/projects/intent-broker',
      ensureSessionKeeper: async () => {
        calls.push('keeper');
      },
      ensureRealtimeBridge: async () => {
        calls.push('bridge');
      },
      registerParticipant: async () => {
        calls.push('register');
      },
      pollInbox: async () => {
        calls.push('poll');
        return { items: [] };
      }
    }
  );

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('stop hook drains actionable queue into an auto-continue prompt and keeps runtime running', async () => {
  const savedCursor = [];
  const savedQueue = [];
  const savedRuntime = [];
  const acked = [];
  const workStates = [];

  const result = await runStopHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      turn_id: 'turn-2'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 10, recentContext: null }),
      loadRuntimeState: () => ({ status: 'running', sessionId: '019d4489-1234-5678-9999-bbbbbbbbbbbb' }),
      loadRealtimeQueueState: () => ({
        actionable: [
          {
            eventId: 77,
            kind: 'request_task',
            fromParticipantId: 'human.song',
            fromAlias: 'song',
            taskId: 'task-queue-1',
            threadId: 'thread-queue-1',
            payload: {
              delivery: { semantic: 'actionable', source: 'default' },
              body: { summary: '修复 broker 在线状态显示' }
            }
          }
        ],
        informational: [
          {
            eventId: 78,
            kind: 'report_progress',
            fromParticipantId: 'claude-peer',
            fromAlias: 'claude2',
            taskId: 'task-queue-1',
            threadId: 'thread-queue-1',
            payload: {
              delivery: { semantic: 'informational', source: 'default' },
              body: { summary: '我正在看 alias rename 广播' }
            }
          }
        ],
        lastEventId: 78
      }),
      saveCursorState: (statePath, state) => savedCursor.push({ statePath, state }),
      saveRealtimeQueueState: (statePath, state) => savedQueue.push({ statePath, state }),
      saveRuntimeState: (statePath, state) => savedRuntime.push({ statePath, state }),
      markPendingReplyMirror: () => {},
      updateWorkState: async (config, state) => {
        workStates.push({ participantId: config.participantId, state });
        return { ok: true };
      },
      ackInbox: async (config, eventId) => acked.push({ participantId: config.participantId, eventId })
    }
  );

  assert.match(result, /Intent Broker auto-continue for codex-session-019d4489/);
  assert.match(result, /修复 broker 在线状态显示/);
  assert.deepEqual(acked, [{ participantId: 'codex-session-019d4489', eventId: 78 }]);
  assert.equal(savedCursor[0].state.lastSeenEventId, 78);
  assert.equal(savedCursor[0].state.recentContext.fromParticipantId, 'claude-peer');
  assert.deepEqual(savedQueue[0].state, {
    actionable: [],
    informational: [],
    lastEventId: 78
  });
  assert.equal(savedRuntime[0].state.status, 'running');
  assert.equal(savedRuntime[0].state.source, 'stop-hook');
  assert.deepEqual(workStates, [
    {
      participantId: 'codex-session-019d4489',
      state: {
        status: 'implementing',
        summary: '修复 broker 在线状态显示',
        taskId: 'task-queue-1',
        threadId: 'thread-queue-1'
      }
    }
  ]);
});

test('stop hook mirrors the current completion before draining a new actionable queue', async () => {
  const sent = [];
  const savedCursor = [];
  const savedQueue = [];
  const savedRuntime = [];
  const acked = [];
  const workStates = [];

  const result = await runStopHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      turn_id: 'turn-current'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 10, recentContext: null }),
      loadRuntimeState: () => ({
        status: 'running',
        sessionId: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
        taskId: 'task-current',
        threadId: 'thread-current'
      }),
      loadRealtimeQueueState: () => ({
        actionable: [
          {
            eventId: 77,
            kind: 'request_approval',
            fromParticipantId: 'claude-peer',
            fromAlias: 'claude',
            taskId: 'task-next',
            threadId: 'thread-next',
            payload: {
              delivery: { semantic: 'actionable', source: 'default' },
              approvalId: 'approval-next',
              body: { summary: 'Need approval for the next task' }
            }
          }
        ],
        informational: [],
        lastEventId: 77
      }),
      maybeMirrorPendingReply: async (_config, options) => {
        sent.push({
          kind: 'mirrored',
          toolName: options.toolName,
          sessionId: options.sessionId,
          turnId: options.turnId
        });
        return { mirrored: true };
      },
      saveCursorState: (statePath, state) => savedCursor.push({ statePath, state }),
      saveRealtimeQueueState: (statePath, state) => savedQueue.push({ statePath, state }),
      saveRuntimeState: (statePath, state) => savedRuntime.push({ statePath, state }),
      markPendingReplyMirror: () => {},
      updateWorkState: async (config, state) => {
        workStates.push({ participantId: config.participantId, state });
        return { ok: true };
      },
      ackInbox: async (config, eventId) => acked.push({ participantId: config.participantId, eventId })
    }
  );

  assert.match(result, /Intent Broker auto-continue for codex-session-019d4489/);
  assert.deepEqual(sent, [
    {
      kind: 'mirrored',
      toolName: 'codex',
      sessionId: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      turnId: 'turn-current'
    }
  ]);
  assert.deepEqual(acked, [{ participantId: 'codex-session-019d4489', eventId: 77 }]);
  assert.equal(savedCursor[0].state.lastSeenEventId, 77);
  assert.deepEqual(savedQueue[0].state, {
    actionable: [],
    informational: [],
    lastEventId: 77
  });
  assert.equal(savedRuntime[0].state.status, 'running');
  assert.deepEqual(workStates, [
    {
      participantId: 'codex-session-019d4489',
      state: {
        status: 'implementing',
        summary: 'Need approval for the next task',
        taskId: 'task-next',
        threadId: 'thread-next'
      }
    }
  ]);
});

test('stop hook sends fallback completion before draining a new actionable queue when mirror is missing', async () => {
  const sent = [];
  const savedRuntime = [];
  const workStates = [];

  const result = await runStopHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      turn_id: 'turn-fallback'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 10, recentContext: null }),
      loadRuntimeState: () => ({
        status: 'running',
        sessionId: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
        taskId: 'task-current',
        threadId: 'thread-current'
      }),
      loadRealtimeQueueState: () => ({
        actionable: [
          {
            eventId: 88,
            kind: 'request_task',
            fromParticipantId: 'human.song',
            fromAlias: 'song',
            taskId: 'task-next',
            threadId: 'thread-next',
            payload: {
              delivery: { semantic: 'actionable', source: 'default' },
              body: { summary: 'Handle the next task' }
            }
          }
        ],
        informational: [],
        lastEventId: 88
      }),
      maybeMirrorPendingReply: async () => ({ mirrored: false, reason: 'no-pending' }),
      resolveCompletedTurnSummary: async () => ({ summary: 'Codex finished the current task', transcriptPath: '/tmp/codex.jsonl' }),
      sendProgress: async (_config, payload) => {
        sent.push(payload);
        return { eventId: 902 };
      },
      saveCursorState: () => {},
      saveRealtimeQueueState: () => {},
      saveRuntimeState: (statePath, state) => savedRuntime.push({ statePath, state }),
      markPendingReplyMirror: () => {},
      updateWorkState: async (config, state) => {
        workStates.push({ participantId: config.participantId, state });
        return { ok: true };
      },
      ackInbox: async () => {}
    }
  );

  assert.match(result, /Intent Broker auto-continue for codex-session-019d4489/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    intentId: sent[0].intentId,
    taskId: 'task-current',
    threadId: 'thread-current',
    stage: 'completed',
    summary: 'Codex finished the current task',
    delivery: { semantic: 'informational', source: 'stop-fallback' }
  });
  assert.equal(savedRuntime[0].state.status, 'running');
  assert.deepEqual(workStates, [
    {
      participantId: 'codex-session-019d4489',
      state: {
        status: 'implementing',
        summary: 'Handle the next task',
        taskId: 'task-next',
        threadId: 'thread-next'
      }
    }
  ]);
});

test('stop hook marks runtime idle when there is no actionable queue', async () => {
  const savedRuntime = [];
  const workStates = [];

  const result = await runStopHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      turn_id: 'turn-2'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({
        lastSeenEventId: 10,
        recentContext: {
          taskId: 'task-33',
          threadId: 'thread-33',
          summary: '上一轮实现 alias 路由'
        }
      }),
      loadRuntimeState: () => ({ status: 'running', sessionId: '019d4489-1234-5678-9999-bbbbbbbbbbbb' }),
      loadRealtimeQueueState: () => ({ actionable: [], informational: [{ eventId: 12 }], lastEventId: 12 }),
      saveRuntimeState: (statePath, state) => savedRuntime.push({ statePath, state }),
      updateWorkState: async (config, state) => {
        workStates.push({ participantId: config.participantId, state });
        return { ok: true };
      }
    }
  );

  assert.equal(result, null);
  assert.equal(savedRuntime[0].state.status, 'idle');
  assert.equal(savedRuntime[0].state.source, 'stop-hook');
  assert.deepEqual(workStates, [
    {
      participantId: 'codex-session-019d4489',
      state: {
        status: 'idle',
        summary: null,
        taskId: null,
        threadId: null
      }
    }
  ]);
});

test('stop hook falls back to a completed progress event when no pending reply mirror exists', async () => {
  const sent = [];
  const savedRuntime = [];
  const workStates = [];

  const result = await runStopHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      turn_id: 'turn-9'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 10, recentContext: null }),
      loadRuntimeState: () => ({
        status: 'running',
        sessionId: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
        taskId: 'task-complete-1',
        threadId: 'thread-complete-1'
      }),
      loadRealtimeQueueState: () => ({ actionable: [], informational: [], lastEventId: 0 }),
      maybeMirrorPendingReply: async () => ({ mirrored: false, reason: 'no-pending' }),
      resolveCompletedTurnSummary: async () => ({ summary: 'Codex completed the task', transcriptPath: '/tmp/codex.jsonl' }),
      sendProgress: async (_config, payload) => {
        sent.push(payload);
        return { eventId: 901 };
      },
      saveRuntimeState: (statePath, state) => savedRuntime.push({ statePath, state }),
      updateWorkState: async (config, state) => {
        workStates.push({ participantId: config.participantId, state });
        return { ok: true };
      }
    }
  );

  assert.equal(result, null);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    intentId: sent[0].intentId,
    taskId: 'task-complete-1',
    threadId: 'thread-complete-1',
    stage: 'completed',
    summary: 'Codex completed the task',
    delivery: { semantic: 'informational', source: 'stop-fallback' }
  });
  assert.equal(savedRuntime[0].state.status, 'idle');
  assert.deepEqual(workStates, [
    {
      participantId: 'codex-session-019d4489',
      state: { status: 'idle', summary: null, taskId: null, threadId: null }
    }
  ]);
});

test('user prompt submit hook can poll inbox without prior register call in the same hook', async () => {
  const calls = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: '检查一下当前协作上下文'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      loadRealtimeQueueState: () => ({ actionable: [], informational: [], lastEventId: 0 }),
      saveRealtimeQueueState: () => {},
      saveRuntimeState: () => {},
      saveCursorState: () => {},
      markPendingReplyMirror: () => {},
      registerParticipant: async (config) => {
        calls.push({ type: 'register', participantId: config.participantId });
      },
      updateWorkState: async () => {},
      pollInbox: async (config) => {
        calls.push({ type: 'poll', participantId: config.participantId });
        return {
          items: [
            {
              eventId: 1,
              kind: 'report_progress',
              fromParticipantId: 'codex-peer',
              taskId: 'task',
              threadId: 'thread',
              payload: { body: { summary: 'progress' } }
            }
          ]
        };
      },
      ackInbox: async () => {}
    }
  );

  assert.match(result, /codex-session-019d4489/);
  assert.deepEqual(calls, [
    { type: 'register', participantId: 'codex-session-019d4489' },
    { type: 'poll', participantId: 'codex-session-019d4489' }
  ]);
});

test('user prompt submit hook surfaces alias rename broadcasts in injected context', async () => {
  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: '检查一下当前协作上下文'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      loadRealtimeQueueState: () => ({ actionable: [], informational: [], lastEventId: 0 }),
      saveRealtimeQueueState: () => {},
      saveRuntimeState: () => {},
      saveCursorState: () => {},
      registerParticipant: async () => ({ ok: true }),
      updateWorkState: async () => ({ ok: true }),
      pollInbox: async () => ({
        items: [
          {
            eventId: 88,
            kind: 'participant_alias_updated',
            fromParticipantId: 'broker.system',
            taskId: null,
            threadId: null,
            payload: {
              participantId: 'claude-peer',
              previousAlias: 'claude',
              alias: 'reviewer',
              body: { summary: 'claude-peer alias updated: claude -> reviewer' }
            }
          }
        ]
      }),
      ackInbox: async () => {}
    }
  );

  assert.match(result, /claude-peer alias updated: claude -> reviewer/);
});

test('session start hook degrades gracefully when broker is unavailable', async () => {
  const result = await runSessionStartHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      registerParticipant: async () => {
        throw new Error('fetch failed');
      }
    }
  );

  assert.equal(result, null);
});

test('session start hook is a no-op during codex auto-dispatch resumes', async () => {
  const calls = [];

  const result = await runSessionStartHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb'
    },
    {
      env: { INTENT_BROKER_SKIP_INBOX_SYNC: '1' },
      cwd: '/Users/song/projects/intent-broker',
      ensureSessionKeeper: async () => {
        calls.push('keeper');
      },
      ensureRealtimeBridge: async () => {
        calls.push('bridge');
      },
      registerParticipant: async () => {
        calls.push('register');
      },
      pollInbox: async () => {
        calls.push('poll');
        return { items: [] };
      }
    }
  );

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('user prompt submit hook degrades gracefully when broker is unavailable', async () => {
  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: '检查一下当前协作上下文'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadCursorState: () => ({ lastSeenEventId: 0 }),
      loadRealtimeQueueState: () => ({ actionable: [], informational: [], lastEventId: 0 }),
      saveRealtimeQueueState: () => {},
      pollInbox: async () => {
        throw new Error('fetch failed');
      }
    }
  );

  assert.equal(result, null);
});
