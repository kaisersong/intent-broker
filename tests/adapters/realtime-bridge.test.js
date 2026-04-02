import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  appendRealtimeEvent,
  createRealtimeQueueState,
  drainRealtimeQueue,
  ensureRealtimeBridge,
  loadRealtimeQueueState,
  maybeAutoDispatchRealtimeQueue,
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
  assert.deepEqual(spawnCalls[0].args.slice(0, 5), ['exec', '--json', '--full-auto', 'resume', '019d448e-1234-5678-9999-aaaaaaaaaaaa']);
  assert.match(spawnCalls[0].args[5], /Intent Broker auto-continue/);
  assert.equal(spawnCalls[0].options.env.INTENT_BROKER_SKIP_INBOX_SYNC, '1');
  assert.deepEqual(acked, [{ participantId: 'codex-session-019d448e', eventId: 77 }]);
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
  assert.equal(JSON.parse(readFileSync(result.statePath, 'utf8')).pid, 6262);
});
