import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  appendRealtimeEvent,
  createRealtimeQueueState,
  drainRealtimeQueue,
  ensureRealtimeBridge,
  loadRealtimeQueueState,
  maybeAutoDispatchRealtimeQueue,
  runRealtimeBridgeProcess,
  saveRealtimeQueueState
} from '../../adapters/session-bridge/realtime-bridge.js';

test('appendRealtimeEvent classifies actionable and informational events into separate queues', () => {
  const initial = createRealtimeQueueState();

  const withInformational = appendRealtimeEvent(initial, {
    eventId: 61,
    intentId: 'note-1',
    kind: 'report_progress',
    payload: {
      delivery: { semantic: 'informational', source: 'default' },
      body: { summary: 'FYI' }
    }
  });
  const withActionable = appendRealtimeEvent(withInformational, {
    eventId: 62,
    intentId: 'ask-1',
    kind: 'ask_clarification',
    payload: {
      delivery: { semantic: 'actionable', source: 'explicit' },
      body: { summary: 'Need input' }
    }
  });
  const deduped = appendRealtimeEvent(withActionable, {
    eventId: 62,
    intentId: 'ask-1',
    kind: 'ask_clarification',
    payload: {
      delivery: { semantic: 'actionable', source: 'explicit' },
      body: { summary: 'Need input' }
    }
  });

  assert.deepEqual(deduped.informational.map((item) => item.intentId), ['note-1']);
  assert.deepEqual(deduped.actionable.map((item) => item.intentId), ['ask-1']);
  assert.equal(deduped.lastEventId, 62);
});

test('loadRealtimeQueueState reads saved queue state from disk', () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-realtime-'));
  const statePath = path.join(homeDir, 'queue.json');

  saveRealtimeQueueState(statePath, {
    actionable: [{ eventId: 10, intentId: 'ask-1', payload: { delivery: { semantic: 'actionable' } } }],
    informational: [{ eventId: 9, intentId: 'note-1', payload: { delivery: { semantic: 'informational' } } }],
    lastEventId: 10
  });

  assert.deepEqual(loadRealtimeQueueState(statePath), {
    actionable: [{ eventId: 10, intentId: 'ask-1', payload: { delivery: { semantic: 'actionable' } } }],
    informational: [{ eventId: 9, intentId: 'note-1', payload: { delivery: { semantic: 'informational' } } }],
    lastEventId: 10
  });
});

test('drainRealtimeQueue returns items in event order and clears local buckets', () => {
  const drained = drainRealtimeQueue({
    actionable: [{ eventId: 10, intentId: 'ask-1', payload: { delivery: { semantic: 'actionable' } } }],
    informational: [{ eventId: 9, intentId: 'note-1', payload: { delivery: { semantic: 'informational' } } }],
    lastEventId: 10
  });

  assert.deepEqual(drained.items.map((item) => item.intentId), ['note-1', 'ask-1']);
  assert.deepEqual(drained.state, {
    actionable: [],
    informational: [],
    lastEventId: 10
  });
});

test('maybeAutoDispatchRealtimeQueue resumes an idle codex session for actionable work', async () => {
  const spawnCalls = [];
  const acked = [];
  const markedPending = [];
  const savedCursor = [];
  const savedRuntime = [];
  const savedQueue = [];
  const workStates = [];

  const result = await maybeAutoDispatchRealtimeQueue({
    toolName: 'codex',
    config: { participantId: 'codex-session-019d448e' },
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    cwd: '/Users/song/projects/intent-broker',
    env: {},
    queueStatePath: '/tmp/queue.json',
    cursorStatePath: '/tmp/cursor.json',
    runtimeStatePath: '/tmp/runtime.json',
    loadRuntimeState: () => ({ status: 'idle', sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa' }),
    loadCursorState: () => ({ lastSeenEventId: 10, recentContext: null }),
    markPendingReplyMirror: (toolName, participantId, payload) => {
      markedPending.push({ toolName, participantId, payload });
    },
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { pid: 5151, unref() {} };
    },
    ackInbox: async (config, eventId) => acked.push({ participantId: config.participantId, eventId }),
    saveCursorState: (statePath, state) => savedCursor.push({ statePath, state }),
    saveRuntimeState: (statePath, state) => savedRuntime.push({ statePath, state }),
    updateWorkState: async (config, state) => {
      workStates.push({ participantId: config.participantId, state });
      return { ok: true };
    },
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
      informational: [],
      lastEventId: 77
    }),
    saveRealtimeQueueState: (statePath, state) => savedQueue.push({ statePath, state })
  });

  assert.equal(result.dispatched, true);
  assert.equal(spawnCalls[0].command, 'codex');
  assert.deepEqual(
    spawnCalls[0].args.slice(0, 6),
    ['exec', '--json', '--full-auto', '--skip-git-repo-check', 'resume', '019d448e-1234-5678-9999-aaaaaaaaaaaa']
  );
  assert.match(spawnCalls[0].args[6], /Intent Broker auto-continue/);
  assert.equal(spawnCalls[0].options.env.INTENT_BROKER_SKIP_INBOX_SYNC, '1');
  assert.deepEqual(acked, [{ participantId: 'codex-session-019d448e', eventId: 77 }]);
  assert.deepEqual(markedPending, [
    {
      toolName: 'codex',
      participantId: 'codex-session-019d448e',
      payload: {
        sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
        autoMirror: true,
        recentContext: {
          eventId: 77,
          kind: 'request_task',
          fromParticipantId: 'human.song',
          fromAlias: 'song',
          fromProjectName: null,
          metadata: null,
          taskId: 'task-queue-1',
          threadId: 'thread-queue-1',
          summary: '修复 broker 在线状态显示'
        }
      }
    }
  ]);
  assert.equal(savedCursor[0].state.lastSeenEventId, 77);
  assert.equal(savedRuntime[0].state.status, 'running');
  assert.equal(savedRuntime[0].state.source, 'auto-dispatch');
  assert.deepEqual(savedQueue[0].state, {
    actionable: [],
    informational: [],
    lastEventId: 77
  });
  assert.deepEqual(workStates, [
    {
      participantId: 'codex-session-019d448e',
      state: {
        status: 'implementing',
        summary: '修复 broker 在线状态显示',
        taskId: 'task-queue-1',
        threadId: 'thread-queue-1'
      }
    }
  ]);
});

test('maybeAutoDispatchRealtimeQueue resumes an idle claude code session for actionable work and sends the reply back through broker', async () => {
  const execCalls = [];
  const acked = [];
  const savedCursor = [];
  const savedRuntime = [];
  const savedQueue = [];
  const workStates = [];
  const replies = [];

  const result = await maybeAutoDispatchRealtimeQueue({
    toolName: 'claude-code',
    config: { participantId: 'claude-code-session-019d448e' },
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    cwd: '/Users/song/projects/intent-broker',
    env: {},
    queueStatePath: '/tmp/queue.json',
    cursorStatePath: '/tmp/cursor.json',
    runtimeStatePath: '/tmp/runtime.json',
    loadRuntimeState: () => ({ status: 'idle', sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa' }),
    loadCursorState: () => ({ lastSeenEventId: 10, recentContext: null }),
    execFileImpl: async (command, args, options) => {
      execCalls.push({ command, args, options });
      return {
        stdout: '我正在处理 broker reconnect 问题，稍后给你完整结果。\n',
        stderr: ''
      };
    },
    ackInbox: async (config, eventId) => acked.push({ participantId: config.participantId, eventId }),
    saveCursorState: (statePath, state) => savedCursor.push({ statePath, state }),
    saveRuntimeState: (statePath, state) => savedRuntime.push({ statePath, state }),
    updateWorkState: async (config, state) => {
      workStates.push({ participantId: config.participantId, state });
      return { ok: true };
    },
    sendProgress: async (config, request) => {
      replies.push({ participantId: config.participantId, request });
      return { ok: true };
    },
    loadRealtimeQueueState: () => ({
      actionable: [
        {
          eventId: 88,
          kind: 'ask_clarification',
          fromParticipantId: 'human.song',
          fromAlias: 'song',
          taskId: 'task-queue-2',
          threadId: 'thread-queue-2',
          payload: {
            delivery: { semantic: 'actionable', source: 'default' },
            metadata: {
              msgId: 'msg-yzj-88',
              yzjUserId: 'user_local'
            },
            body: { summary: '你在做什么，回复我' }
          }
        }
      ],
      informational: [],
      lastEventId: 88
    }),
    saveRealtimeQueueState: (statePath, state) => savedQueue.push({ statePath, state })
  });

  assert.equal(result.dispatched, true);
  assert.equal(execCalls[0].command, 'claude');
  assert.deepEqual(execCalls[0].args.slice(0, 3), ['--resume', '019d448e-1234-5678-9999-aaaaaaaaaaaa', '--print']);
  assert.match(execCalls[0].args[3], /Intent Broker auto-continue/);
  assert.match(execCalls[0].args[3], /output only the reply summary/i);
  assert.equal(execCalls[0].options.env.INTENT_BROKER_SKIP_INBOX_SYNC, '1');
  assert.deepEqual(acked, [{ participantId: 'claude-code-session-019d448e', eventId: 88 }]);
  assert.equal(savedCursor[0].state.lastSeenEventId, 88);
  assert.equal(savedRuntime[0].state.status, 'running');
  assert.equal(savedRuntime.at(-1).state.status, 'idle');
  assert.deepEqual(savedQueue[0].state, {
    actionable: [],
    informational: [],
    lastEventId: 88
  });
  assert.deepEqual(workStates, [
    {
      participantId: 'claude-code-session-019d448e',
      state: {
        status: 'implementing',
        summary: '你在做什么，回复我',
        taskId: 'task-queue-2',
        threadId: 'thread-queue-2'
      }
    },
    {
      participantId: 'claude-code-session-019d448e',
      state: {
        status: 'idle',
        summary: null,
        taskId: null,
        threadId: null
      }
    }
  ]);
  assert.deepEqual(replies, [
    {
      participantId: 'claude-code-session-019d448e',
      request: {
        intentId: 'claude-code-session-019d448e-auto-reply-88',
        taskId: 'task-queue-2',
        threadId: 'thread-queue-2',
        toParticipantId: 'human.song',
        summary: '我正在处理 broker reconnect 问题，稍后给你完整结果。',
        metadata: {
          msgId: 'msg-yzj-88',
          yzjUserId: 'user_local'
        }
      }
    }
  ]);
});

test('ensureRealtimeBridge removes sibling bridges that share the same observed parent pid', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-realtime-'));
  const kills = [];

  const previous = await ensureRealtimeBridge({
    toolName: 'claude-code',
    cliPath: '/repo/adapters/claude-code-plugin/bin/claude-code-broker.js',
    sessionId: '45ba7f3d-eae1-4e6d-af25-7113e006bd26',
    cwd: '/Users/song/projects/intent-broker',
    homeDir,
    parentPid: 5206,
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'claude-code-session-45ba7f3d',
      alias: 'claude6',
      inboxMode: 'realtime',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'xiaok-cli' }
    },
    spawnImpl: () => ({
      pid: 5151,
      unref() {}
    })
  });

  const replacement = await ensureRealtimeBridge({
    toolName: 'claude-code',
    cliPath: '/repo/adapters/claude-code-plugin/bin/claude-code-broker.js',
    sessionId: 'e0f24251-271d-4d49-9f0c-c7768c91a7dd',
    cwd: '/Users/song/projects/intent-broker',
    homeDir,
    parentPid: 5206,
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'claude-code-session-e0f24251',
      alias: 'claude4',
      inboxMode: 'realtime',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'xiaok-cli' }
    },
    isProcessAlive: () => true,
    killImpl: (pid) => {
      kills.push(pid);
    },
    spawnImpl: () => ({
      pid: 6161,
      unref() {}
    })
  });

  assert.equal(replacement.started, true);
  assert.deepEqual(kills, [5151]);
  assert.equal(existsSync(previous.statePath), false);
  assert.equal(JSON.parse(readFileSync(replacement.statePath, 'utf8')).pid, 6161);
});

test('maybeAutoDispatchRealtimeQueue recovers a stale claude code auto-dispatch runtime before resuming queued work', async () => {
  const execCalls = [];
  const savedRuntime = [];
  const workStates = [];

  const result = await maybeAutoDispatchRealtimeQueue({
    toolName: 'claude-code',
    config: { participantId: 'claude-code-session-stale-1' },
    sessionId: 'stale-session-1234',
    cwd: '/Users/song/projects/intent-broker',
    env: {
      INTENT_BROKER_CLAUDE_AUTO_DISPATCH_STALE_MS: '1000'
    },
    queueStatePath: '/tmp/queue.json',
    cursorStatePath: '/tmp/cursor.json',
    runtimeStatePath: '/tmp/runtime.json',
    loadRuntimeState: () => ({
      status: 'running',
      sessionId: 'stale-session-1234',
      turnId: null,
      source: 'auto-dispatch',
      taskId: 'old-task',
      threadId: 'old-thread',
      updatedAt: '2000-01-01T00:00:00.000Z'
    }),
    loadCursorState: () => ({ lastSeenEventId: 10, recentContext: null }),
    execFileImpl: async (command, args, options) => {
      execCalls.push({ command, args, options });
      return {
        stdout: 'CLAUDE_STALE_RUNTIME_RECOVERED\n',
        stderr: ''
      };
    },
    ackInbox: async () => ({ ok: true }),
    saveCursorState: () => {},
    saveRuntimeState: (statePath, state) => savedRuntime.push({ statePath, state }),
    updateWorkState: async (config, state) => {
      workStates.push({ participantId: config.participantId, state });
      return { ok: true };
    },
    sendProgress: async () => ({ ok: true }),
    loadRealtimeQueueState: () => ({
      actionable: [
        {
          eventId: 91,
          kind: 'ask_clarification',
          fromParticipantId: 'human.song',
          fromAlias: 'song',
          taskId: 'task-stale-1',
          threadId: 'thread-stale-1',
          payload: {
            delivery: { semantic: 'actionable', source: 'default' },
            body: { summary: '请恢复后回复我' }
          }
        }
      ],
      informational: [],
      lastEventId: 91
    }),
    saveRealtimeQueueState: () => {}
  });

  assert.equal(result.dispatched, true);
  assert.equal(execCalls.length, 1);
  assert.equal(savedRuntime[0].state.status, 'idle');
  assert.equal(savedRuntime[0].state.source, 'auto-dispatch-recovered');
  assert.equal(savedRuntime[1].state.status, 'running');
  assert.equal(savedRuntime.at(-1).state.status, 'idle');
  assert.deepEqual(workStates, [
    {
      participantId: 'claude-code-session-stale-1',
      state: {
        status: 'idle',
        summary: null,
        taskId: null,
        threadId: null
      }
    },
    {
      participantId: 'claude-code-session-stale-1',
      state: {
        status: 'implementing',
        summary: '请恢复后回复我',
        taskId: 'task-stale-1',
        threadId: 'thread-stale-1'
      }
    },
    {
      participantId: 'claude-code-session-stale-1',
      state: {
        status: 'idle',
        summary: null,
        taskId: null,
        threadId: null
      }
    }
  ]);
});

test('maybeAutoDispatchRealtimeQueue requeues claude code work when auto-dispatch execution fails', async () => {
  const savedQueue = [];
  const savedRuntime = [];
  const workStates = [];

  const result = await maybeAutoDispatchRealtimeQueue({
    toolName: 'claude-code',
    config: { participantId: 'claude-code-session-fail-1' },
    sessionId: 'failing-session-1234',
    cwd: '/Users/song/projects/intent-broker',
    env: {},
    queueStatePath: '/tmp/queue.json',
    cursorStatePath: '/tmp/cursor.json',
    runtimeStatePath: '/tmp/runtime.json',
    loadRuntimeState: () => ({ status: 'idle', sessionId: 'failing-session-1234' }),
    loadCursorState: () => ({ lastSeenEventId: 10, recentContext: null }),
    execFileImpl: async () => {
      throw new Error('claude_print_failed');
    },
    ackInbox: async () => ({ ok: true }),
    saveCursorState: () => {},
    saveRuntimeState: (statePath, state) => savedRuntime.push({ statePath, state }),
    updateWorkState: async (config, state) => {
      workStates.push({ participantId: config.participantId, state });
      return { ok: true };
    },
    loadRealtimeQueueState: () => ({
      actionable: [
        {
          eventId: 92,
          kind: 'ask_clarification',
          fromParticipantId: 'human.song',
          fromAlias: 'song',
          taskId: 'task-fail-1',
          threadId: 'thread-fail-1',
          payload: {
            delivery: { semantic: 'actionable', source: 'default' },
            body: { summary: '这次会失败' }
          }
        }
      ],
      informational: [],
      lastEventId: 92
    }),
    saveRealtimeQueueState: (statePath, state) => savedQueue.push({ statePath, state })
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-failed');
  assert.match(result.error, /claude_print_failed/);
  assert.deepEqual(savedQueue[0].state, {
    actionable: [],
    informational: [],
    lastEventId: 92
  });
  assert.deepEqual(savedQueue.at(-1).state, {
    actionable: [
      {
        eventId: 92,
        kind: 'ask_clarification',
        fromParticipantId: 'human.song',
        fromAlias: 'song',
        taskId: 'task-fail-1',
        threadId: 'thread-fail-1',
        payload: {
          delivery: { semantic: 'actionable', source: 'default' },
          body: { summary: '这次会失败' }
        }
      }
    ],
    informational: [],
    lastEventId: 92
  });
  assert.equal(savedRuntime[0].state.status, 'running');
  assert.equal(savedRuntime.at(-1).state.status, 'idle');
  assert.deepEqual(workStates, [
    {
      participantId: 'claude-code-session-fail-1',
      state: {
        status: 'implementing',
        summary: '这次会失败',
        taskId: 'task-fail-1',
        threadId: 'thread-fail-1'
      }
    },
    {
      participantId: 'claude-code-session-fail-1',
      state: {
        status: 'idle',
        summary: null,
        taskId: null,
        threadId: null
      }
    }
  ]);
});

test('ensureRealtimeBridge spawns a detached background bridge and records its pid', async () => {
  const spawnCalls = [];
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-realtime-'));

  const result = await ensureRealtimeBridge({
    toolName: 'codex',
    cliPath: '/repo/adapters/codex-plugin/bin/codex-broker.js',
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    cwd: '/Users/song/projects/intent-broker',
    homeDir,
    parentPid: 4242,
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d448e',
      alias: 'codex',
      inboxMode: 'realtime',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'intent-broker' }
    },
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return {
        pid: 6262,
        unref() {}
      };
    }
  });

  assert.equal(result.started, true);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args.slice(-1), ['realtime-bridge']);
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(spawnCalls[0].options.env.INTENT_BROKER_REALTIME_PARENT_PID, '4242');
  assert.equal(spawnCalls[0].options.env.INTENT_BROKER_INBOX_MODE, 'realtime');
  assert.equal(JSON.parse(readFileSync(result.statePath, 'utf8')).pid, 6262);
});

test('ensureRealtimeBridge replaces a live bridge when the persisted inbox mode is stale', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-realtime-'));
  const kills = [];

  await ensureRealtimeBridge({
    toolName: 'codex',
    cliPath: '/repo/adapters/codex-plugin/bin/codex-broker.js',
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    cwd: '/Users/song/projects/intent-broker',
    homeDir,
    parentPid: 4242,
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d448e',
      alias: 'codex',
      inboxMode: 'pull',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'intent-broker' }
    },
    spawnImpl: () => ({
      pid: 6262,
      unref() {}
    })
  });

  const replaced = await ensureRealtimeBridge({
    toolName: 'codex',
    cliPath: '/repo/adapters/codex-plugin/bin/codex-broker.js',
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    cwd: '/Users/song/projects/intent-broker',
    homeDir,
    parentPid: 4242,
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d448e',
      alias: 'codex',
      inboxMode: 'realtime',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'intent-broker' }
    },
    isProcessAlive: () => true,
    killImpl: (pid) => {
      kills.push(pid);
    },
    spawnImpl: () => ({
      pid: 7272,
      unref() {}
    })
  });

  assert.equal(replaced.started, true);
  assert.deepEqual(kills, [6262]);
  assert.equal(JSON.parse(readFileSync(replaced.statePath, 'utf8')).pid, 7272);
});

test('ensureRealtimeBridge replaces a live bridge when the same session resumes under a new parent pid', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-realtime-'));
  const kills = [];

  await ensureRealtimeBridge({
    toolName: 'codex',
    cliPath: '/repo/adapters/codex-plugin/bin/codex-broker.js',
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    cwd: '/Users/song/projects/intent-broker',
    homeDir,
    parentPid: 4242,
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d448e',
      alias: 'codex',
      inboxMode: 'realtime',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'intent-broker' }
    },
    spawnImpl: () => ({
      pid: 6262,
      unref() {}
    })
  });

  const replaced = await ensureRealtimeBridge({
    toolName: 'codex',
    cliPath: '/repo/adapters/codex-plugin/bin/codex-broker.js',
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    cwd: '/Users/song/projects/intent-broker',
    homeDir,
    parentPid: 9898,
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d448e',
      alias: 'codex',
      inboxMode: 'realtime',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'intent-broker' }
    },
    isProcessAlive: () => true,
    killImpl: (pid) => {
      kills.push(pid);
    },
    spawnImpl: () => ({
      pid: 7272,
      unref() {}
    })
  });

  assert.equal(replaced.started, true);
  assert.deepEqual(kills, [6262]);
  assert.equal(JSON.parse(readFileSync(replaced.statePath, 'utf8')).pid, 7272);
});

test('ensureRealtimeBridge replaces a live bridge when persisted state predates brokerUrl tracking', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-realtime-'));
  const kills = [];

  const initial = await ensureRealtimeBridge({
    toolName: 'codex',
    cliPath: '/repo/adapters/codex-plugin/bin/codex-broker.js',
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    cwd: '/Users/song/projects/intent-broker',
    homeDir,
    parentPid: 4242,
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d448e',
      alias: 'codex',
      inboxMode: 'realtime',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'intent-broker' }
    },
    spawnImpl: () => ({
      pid: 6262,
      unref() {}
    })
  });

  const persisted = JSON.parse(readFileSync(initial.statePath, 'utf8'));
  delete persisted.brokerUrl;
  writeFileSync(initial.statePath, JSON.stringify(persisted, null, 2));

  const replaced = await ensureRealtimeBridge({
    toolName: 'codex',
    cliPath: '/repo/adapters/codex-plugin/bin/codex-broker.js',
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    cwd: '/Users/song/projects/intent-broker',
    homeDir,
    parentPid: 4242,
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d448e',
      alias: 'codex',
      inboxMode: 'realtime',
      roles: ['coder'],
      capabilities: [],
      context: { projectName: 'intent-broker' }
    },
    isProcessAlive: () => true,
    killImpl: (pid) => {
      kills.push(pid);
    },
    spawnImpl: () => ({
      pid: 7272,
      unref() {}
    })
  });

  assert.equal(replaced.started, true);
  assert.deepEqual(kills, [6262]);
  assert.deepEqual(JSON.parse(readFileSync(replaced.statePath, 'utf8')), {
    pid: 7272,
    sessionId: '019d448e-1234-5678-9999-aaaaaaaaaaaa',
    inboxMode: 'realtime',
    brokerUrl: 'http://127.0.0.1:4318',
    parentPid: 4242,
    queueStatePath: JSON.parse(readFileSync(replaced.statePath, 'utf8')).queueStatePath,
    startedAt: JSON.parse(readFileSync(replaced.statePath, 'utf8')).startedAt
  });
});

test('runRealtimeBridgeProcess starts the Codex native approval watcher when transcript and terminal metadata are available', async () => {
  const watcherCalls = [];
  let stopped = false;

  await runRealtimeBridgeProcess({
    toolName: 'codex',
    cwd: '/Users/song/projects/hexdeck',
    env: {
      PARTICIPANT_ID: 'codex-session-019d4489',
      ALIAS: 'codex',
      PROJECT_NAME: 'hexdeck',
      BROKER_URL: 'http://127.0.0.1:4318',
      INTENT_BROKER_REALTIME_SESSION_ID: '019d4489-1234-5678-9999-bbbbbbbbbbbb'
    },
    parentPid: 4242,
    statePath: null,
    queueStatePath: '/tmp/codex-native-approval-queue.json',
    loadRuntimeState: () => ({
      status: 'idle',
      sessionId: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
      terminalApp: 'Ghostty',
      terminalSessionID: 'ghostty-terminal-1'
    }),
    loadRealtimeQueueState: () => ({ actionable: [], informational: [], lastEventId: 0 }),
    saveRealtimeQueueState: () => {},
    registerParticipant: async () => ({ ok: true }),
    ackInbox: async () => ({ ok: true }),
    spawnImpl: () => ({ pid: 5151, unref() {} }),
    isProcessAlive: () => false,
    resolveTranscriptPath: () => '/Users/song/.codex/sessions/run.jsonl',
    startCodexNativeApprovalWatcher: (input) => {
      watcherCalls.push(input);
      return {
        stop() {
          stopped = true;
        },
        done: Promise.resolve()
      };
    },
    sleepImpl: async () => {}
  });

  assert.equal(watcherCalls.length, 1);
  assert.equal(watcherCalls[0].sessionId, '019d4489-1234-5678-9999-bbbbbbbbbbbb');
  assert.equal(watcherCalls[0].transcriptPath, '/Users/song/.codex/sessions/run.jsonl');
  assert.equal(watcherCalls[0].config.participantId, 'codex-session-019d4489');
  assert.equal(watcherCalls[0].terminalMetadata.terminalSessionID, 'ghostty-terminal-1');
  assert.equal(stopped, true);
});
