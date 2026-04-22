import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeCodeHookOutput,
  buildClaudeCodePreToolUseOutput
} from '../../adapters/claude-code-plugin/format.js';
import {
  runPreToolUseHook,
  runPermissionRequestHook,
  runStopHook,
  runSessionStartHook,
  runUserPromptSubmitHook
} from '../../adapters/claude-code-plugin/hooks.js';

test('buildClaudeCodeHookOutput wraps additional context for SessionStart', () => {
  const output = buildClaudeCodeHookOutput('SessionStart', 'broker context');

  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'broker context'
    }
  });
});

test('buildClaudeCodePreToolUseOutput wraps a deny directive for AskUserQuestion suppression', () => {
  const output = buildClaudeCodePreToolUseOutput({
    permissionDecision: 'deny',
    permissionDecisionReason: 'AskUserQuestion has been mirrored to Intent Broker. Wait for the human response in HexDeck instead of opening the native terminal menu.',
    additionalContext: 'AskUserQuestion has been mirrored to Intent Broker. Wait for the human response in HexDeck instead of opening the native terminal menu.'
  });

  assert.deepEqual(output, {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'AskUserQuestion has been mirrored to Intent Broker. Wait for the human response in HexDeck instead of opening the native terminal menu.',
      additionalContext: 'AskUserQuestion has been mirrored to Intent Broker. Wait for the human response in HexDeck instead of opening the native terminal menu.'
    }
  });
});

test('permission request hook mirrors a live Claude Code approval request through broker', async () => {
  const calls = [];
  const toolInput = { command: 'npm test' };
  const result = await runPermissionRequestHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker',
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'toolu-cc-1'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      requestHookApproval: async (input) => {
        calls.push(input);
        return { approved: true, approvalId: 'approval-cc-1' };
      }
    }
  );

  assert.equal(result.approved, true);
  assert.deepEqual(result.updatedInput, toolInput);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentTool, 'claude-code');
  assert.equal(calls[0].hookEventName, 'PermissionRequest');
  assert.equal(calls[0].sessionId, '019d448e-1234-5678-9999-aaaaaaaaaaaa');
  assert.equal(calls[0].toolName, 'Bash');
  assert.deepEqual(calls[0].toolInput, toolInput);
  assert.equal(calls[0].toolUseId, 'toolu-cc-1');
  assert.equal(calls[0].config.participantId, 'claude-code-session-019d448e');
});

test('pre-tool-use hook mirrors AskUserQuestion as a structured clarification request', async () => {
  const saved = [];
  const asks = [];

  const result = await runPreToolUseHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects',
      tool_name: 'AskUserQuestion',
      tool_input: {
        header: '删除文件',
        question: '是否确认永久删除此文件？',
        options: [
          { value: 'yes', label: '确认删除', description: '执行 rm /tmp/example.txt' },
          { value: 'no', label: '取消', description: '保留文件，不执行任何操作' }
        ]
      },
      tool_use_id: 'toolu-cc-ask-1'
    },
    {
      env: {},
      cwd: '/Users/song/projects',
      savePendingToolUseContext: (toolName, participantId, value) => {
        saved.push({ toolName, participantId, value });
      },
      sendAsk: async (config, request) => {
        asks.push({ config, request });
      }
    }
  );

  assert.deepEqual(result, {
    permissionDecision: 'deny',
    permissionDecisionReason: 'AskUserQuestion has been mirrored to Intent Broker. Wait for the human response in HexDeck instead of opening the native terminal menu.',
    additionalContext: 'AskUserQuestion has been mirrored to Intent Broker. Wait for the human response in HexDeck instead of opening the native terminal menu.'
  });
  assert.equal(saved.length, 1);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].config.participantId, 'claude-code-session-019d448e');
  assert.deepEqual(asks[0].request, {
    intentId: 'claude-code-session-019d448e-ask-toolu-cc-ask-1',
    toParticipantId: 'human.local',
    taskId: 'claude-code-session-019d448e-ask-toolu-cc-ask-1',
    threadId: 'claude-code-session-019d448e-ask-toolu-cc-ask-1',
    participantId: 'claude-code-session-019d448e',
    summary: '删除文件',
    prompt: '是否确认永久删除此文件？',
    detailText: undefined,
    selectionMode: 'single-select',
    options: [
      { value: 'yes', label: '确认删除', description: '执行 rm /tmp/example.txt' },
      { value: 'no', label: '取消', description: '保留文件，不执行任何操作' }
    ],
    metadata: {
      agentTool: 'claude-code',
      hookEventName: 'PreToolUse',
      toolName: 'AskUserQuestion'
    },
    delivery: {
      semantic: 'actionable',
      source: 'claude-ask-user-question'
    }
  });
});

test('pre-tool-use hook mirrors the first supported AskUserQuestion entry from questions[] and suppresses the native tool', async () => {
  const asks = [];

  const result = await runPreToolUseHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/kai-export-ppt-lite',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          {
            question: '选择前端框架？',
            header: '框架',
            options: [
              { label: 'React', description: '组件化，生态丰富' },
              { label: 'Vue 3', description: '渐进式，中文社区好' },
            ],
            multiSelect: false
          },
          {
            question: '需要哪些附加功能？',
            header: '附加功能',
            options: [
              { label: '用户认证', description: '登录 / 注册 / JWT' },
              { label: '暗色模式', description: 'Dark mode 切换' },
            ],
            multiSelect: true
          }
        ]
      },
      tool_use_id: 'toolu-cc-ask-batch-1'
    },
    {
      env: {},
      cwd: '/Users/song/projects/kai-export-ppt-lite',
      sendAsk: async (config, request) => {
        asks.push({ config, request });
      }
    }
  );

  assert.deepEqual(result, {
    permissionDecision: 'deny',
    permissionDecisionReason: 'AskUserQuestion has been mirrored to Intent Broker. Wait for the human response in HexDeck instead of opening the native terminal menu.',
    additionalContext: 'AskUserQuestion has been mirrored to Intent Broker. Wait for the human response in HexDeck instead of opening the native terminal menu.'
  });
  assert.equal(asks.length, 1);
  assert.equal(asks[0].config.participantId, 'claude-code-session-019d448e');
  assert.deepEqual(asks[0].request, {
    intentId: 'claude-code-session-019d448e-ask-toolu-cc-ask-batch-1',
    toParticipantId: 'human.local',
    taskId: 'claude-code-session-019d448e-ask-toolu-cc-ask-batch-1',
    threadId: 'claude-code-session-019d448e-ask-toolu-cc-ask-batch-1',
    participantId: 'claude-code-session-019d448e',
    summary: '框架',
    prompt: '选择前端框架？',
    detailText: undefined,
    selectionMode: 'single-select',
    options: [
      { value: 'React', label: 'React', description: '组件化，生态丰富' },
      { value: 'Vue 3', label: 'Vue 3', description: '渐进式，中文社区好' }
    ],
    metadata: {
      agentTool: 'claude-code',
      hookEventName: 'PreToolUse',
      toolName: 'AskUserQuestion'
    },
    delivery: {
      semantic: 'actionable',
      source: 'claude-ask-user-question'
    }
  });
});

test('pre-tool-use hook persists tool context for a later permission request', async () => {
  const saved = [];
  const toolInput = { command: 'rm /tmp/example.txt' };

  const result = await runPreToolUseHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker',
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_use_id: 'toolu-cc-pret-1'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      savePendingToolUseContext: (toolName, participantId, value) => {
        saved.push({ toolName, participantId, value });
      }
    }
  );

  assert.equal(result, null);
  assert.deepEqual(saved, [
    {
      toolName: 'claude-code',
      participantId: 'claude-code-session-019d448e',
      value: {
        sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
        toolName: 'Bash',
        toolInput,
        toolUseId: 'toolu-cc-pret-1'
      }
    }
  ]);
});

test('permission request hook falls back to the correlated pre-tool-use context when the native payload is sparse', async () => {
  const calls = [];
  const correlatedInput = { command: 'rm /tmp/example.txt' };
  const result = await runPermissionRequestHook(
    {
      session_id: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
      cwd: '/Users/song/projects/intent-broker'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadPendingToolUseContext: () => ({
        sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
        toolName: 'Bash',
        toolInput: correlatedInput,
        toolUseId: 'toolu-cc-pret-2'
      }),
      requestHookApproval: async (input) => {
        calls.push(input);
        return { approved: true, approvalId: 'approval-cc-correlation' };
      }
    }
  );

  assert.equal(result.approved, true);
  assert.deepEqual(result.updatedInput, correlatedInput);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, 'Bash');
  assert.deepEqual(calls[0].toolInput, correlatedInput);
  assert.equal(calls[0].toolUseId, 'toolu-cc-pret-2');
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
  assert.equal(calls[0].input.config.participantId, 'claude-code-session-019d448e');
  assert.equal(calls[0].input.sessionId, '019d448e-1234-5678-9999-aaaaaaaaaaaa');
  assert.equal(calls[1].type, 'bridge');
  assert.equal(calls[1].input.config.participantId, 'claude-code-session-019d448e');
  assert.equal(calls[2].type, 'register');
  assert.equal(calls[2].config.participantId, 'claude-code-session-019d448e');
  assert.equal(calls[2].config.inboxMode, 'realtime');
  assert.deepEqual(calls[2].config.context, { projectName: 'intent-broker' });
  assert.equal(calls[3].type, 'work-state');
  assert.deepEqual(calls[3].state, { status: 'idle', summary: null });
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

test('session start hook prefers hook session id over inherited CLAUDE_CODE_SESSION_ID', async () => {
  const calls = [];

  await runSessionStartHook(
    {
      session_id: '019d9999-1234-5678-9999-aaaaaaaaaaaa'
    },
    {
      env: {
        CLAUDE_CODE_SESSION_ID: '019d1111-1234-5678-9999-bbbbbbbbbbbb'
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

  assert.deepEqual(calls, ['claude-code-session-019d9999']);
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

test('user prompt submit hook skips slash commands', async () => {
  const calls = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: '/status'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      pollInbox: async () => {
        calls.push('poll');
        return { items: [] };
      }
    }
  );

  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('user prompt submit hook is a no-op during claude auto-dispatch print resumes', async () => {
  const calls = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: 'auto reply'
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

test('stop hook mirrors pending broker reply through transcript reader', async () => {
  const calls = [];

  const result = await runStopHook(
    {
      session_id: 'claude-session-1'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      maybeMirrorPendingReply: async (config, options) => {
        calls.push({ participantId: config.participantId, sessionId: options.sessionId, toolName: options.toolName });
        return { mirrored: true };
      }
    }
  );

  assert.equal(result, null);
  assert.deepEqual(calls, [
    {
      participantId: 'claude-code-session-claude-s',
      sessionId: 'claude-session-1',
      toolName: 'claude-code'
    }
  ]);
});

test('stop hook falls back to a completed progress event when no pending reply mirror exists', async () => {
  const sent = [];
  const savedRuntime = [];
  const workStates = [];

  const result = await runStopHook(
    {
      session_id: 'claude-session-1'
    },
    {
      env: {},
      cwd: '/Users/song/projects/intent-broker',
      loadRuntimeState: () => ({
        status: 'running',
        sessionId: 'claude-session-1',
        taskId: 'task-claude-complete-1',
        threadId: 'thread-claude-complete-1'
      }),
      maybeMirrorPendingReply: async () => ({ mirrored: false, reason: 'no-pending' }),
      resolveCompletedTurnSummary: async () => ({ summary: 'Claude completed the task', transcriptPath: '/tmp/claude.jsonl' }),
      sendProgress: async (_config, payload) => {
        sent.push(payload);
        return { eventId: 902 };
      },
      saveRuntimeState: (statePath, state) => savedRuntime.push({ statePath, state }),
      updateWorkState: async (config, state) => {
        workStates.push({ participantId: config.participantId, state });
        return { ok: true };
      },
      clearPendingToolUseContext: () => {}
    }
  );

  assert.equal(result, null);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    intentId: sent[0].intentId,
    taskId: 'task-claude-complete-1',
    threadId: 'thread-claude-complete-1',
    stage: 'completed',
    summary: 'Claude completed the task',
    delivery: { semantic: 'informational', source: 'stop-fallback' }
  });
  assert.equal(savedRuntime[0].state.status, 'idle');
  assert.deepEqual(workStates, [
    {
      participantId: 'claude-code-session-claude-s',
      state: { status: 'idle', summary: null, taskId: null, threadId: null }
    }
  ]);
});

test('user prompt submit hook injects context, saves cursor, and acks inbox', async () => {
  const saved = [];
  const acked = [];
  const calls = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: 'check collaboration context'
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
            fromAlias: 'codex2',
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

  assert.match(result, /Intent Broker update for claude-code-session-019d4489/);
  assert.match(result, /from codex2/);
  assert.match(result, /task=real-task-1/);
  assert.match(result, /thread=real-thread-1/);
  assert.equal(saved[0].state.lastSeenEventId, 77);
  assert.equal(saved[0].state.recentContext.fromParticipantId, 'codex-peer');
  assert.equal(saved[0].state.recentContext.fromAlias, 'codex2');
  assert.equal(saved[0].state.recentContext.taskId, 'real-task-1');
  assert.equal(saved[0].state.recentContext.threadId, 'real-thread-1');
  assert.deepEqual(acked, [{ participantId: 'claude-code-session-019d4489', eventId: 77 }]);
  assert.deepEqual(calls, [
    { type: 'keeper', participantId: 'claude-code-session-019d4489', inboxMode: 'realtime' },
    { type: 'bridge', participantId: 'claude-code-session-019d4489', inboxMode: 'realtime' },
    { type: 'register', participantId: 'claude-code-session-019d4489', alias: 'claude', inboxMode: 'realtime' }
  ]);
});

test('user prompt submit hook prefers local realtime queue and does not poll when queued events exist', async () => {
  const savedCursor = [];
  const savedQueue = [];
  const acked = [];
  const calls = [];

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: 'continue'
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
              body: { summary: 'Check broker reconnect behavior' }
            }
          }
        ],
        informational: [
          {
            eventId: 78,
            kind: 'report_progress',
            fromParticipantId: 'codex-peer',
            fromAlias: 'codex2',
            taskId: 'task-queue-1',
            threadId: 'thread-queue-1',
            payload: {
              delivery: { semantic: 'informational', source: 'default' },
              body: { summary: 'I am already reviewing the websocket bridge' }
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
      pollInbox: async () => {
        calls.push({ type: 'poll' });
        return { items: [] };
      },
      ackInbox: async (config, eventId) => acked.push({ participantId: config.participantId, eventId })
    }
  );

  assert.match(result, /Actionable items/);
  assert.match(result, /Informational items/);
  assert.match(result, /Check broker reconnect behavior/);
  assert.match(result, /I am already reviewing the websocket bridge/);
  assert.deepEqual(calls, [{ type: 'register', participantId: 'claude-code-session-019d4489' }]);
  assert.deepEqual(acked, [{ participantId: 'claude-code-session-019d4489', eventId: 78 }]);
  assert.equal(savedCursor[0].state.lastSeenEventId, 78);
  assert.equal(savedCursor[0].state.recentContext.fromParticipantId, 'codex-peer');
  assert.deepEqual(savedQueue[0].state, {
    actionable: [],
    informational: [],
    lastEventId: 78
  });
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

test('session start hook is a no-op during claude auto-dispatch print resumes', async () => {
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
      prompt: 'check collaboration context'
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

test('user prompt submit hook surfaces alias rename broadcasts in injected context', async () => {
  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      prompt: 'check collaboration context'
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
              participantId: 'codex-peer',
              previousAlias: 'codex',
              alias: 'backend',
              body: { summary: 'codex-peer alias updated: codex -> backend' }
            }
          }
        ]
      }),
      ackInbox: async () => {}
    }
  );

  assert.match(result, /participant_alias_updated/);
  assert.match(result, /codex-peer alias updated: codex -> backend/);
});
