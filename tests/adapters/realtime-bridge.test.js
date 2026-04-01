import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  appendRealtimeEvent,
  createRealtimeQueueState,
  ensureRealtimeBridge,
  loadRealtimeQueueState,
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
