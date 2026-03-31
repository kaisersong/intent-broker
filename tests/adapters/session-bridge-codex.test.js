import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildCodexHookContext,
  buildCodexHookOutput,
  highestEventId,
  summarizeInboxItems
} from '../../adapters/session-bridge/codex-hooks.js';
import {
  loadCursorState,
  saveCursorState
} from '../../adapters/session-bridge/state.js';

test('summarizeInboxItems renders broker requests and progress succinctly', () => {
  const summary = summarizeInboxItems([
    {
      eventId: 61,
      kind: 'request_task',
      fromParticipantId: 'claude-real-1',
      taskId: 'task-1',
      threadId: 'thread-1',
      payload: { body: { summary: 'Review the export failure' } }
    },
    {
      eventId: 62,
      kind: 'report_progress',
      fromParticipantId: 'yunzhijia.user',
      taskId: 'task-1',
      threadId: 'thread-1',
      payload: { stage: 'in_progress', body: { summary: 'Need status update ASAP' } }
    }
  ]);

  assert.match(summary, /2 new broker event/);
  assert.match(summary, /request_task from claude-real-1/);
  assert.match(summary, /Review the export failure/);
  assert.match(summary, /report_progress from yunzhijia\.user/);
  assert.match(summary, /Need status update ASAP/);
});

test('buildCodexHookContext returns null when inbox is empty', () => {
  assert.equal(buildCodexHookContext([], { participantId: 'codex.main' }), null);
});

test('buildCodexHookContext produces actionable context for Codex', () => {
  const context = buildCodexHookContext(
    [
      {
        eventId: 70,
        kind: 'request_task',
        fromParticipantId: 'claude-real-1',
        taskId: 'task-2',
        threadId: 'thread-2',
        payload: { body: { summary: 'Please pick up regression triage' } }
      }
    ],
    { participantId: 'codex.main' }
  );

  assert.match(context, /Intent Broker update for codex\.main/);
  assert.match(context, /Please pick up regression triage/);
  assert.match(context, /If relevant, respond in this turn/);
});

test('buildCodexHookOutput wraps additional context for SessionStart', () => {
  const output = buildCodexHookOutput('SessionStart', 'broker context');

  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'broker context'
    }
  });
});

test('highestEventId returns zero for empty arrays', () => {
  assert.equal(highestEventId([]), 0);
});

test('highestEventId returns the largest event id in the batch', () => {
  assert.equal(highestEventId([{ eventId: 1 }, { eventId: 9 }, { eventId: 3 }]), 9);
});

test('cursor state defaults to zero when file does not exist', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intent-broker-cursor-'));

  try {
    const state = loadCursorState(path.join(dir, 'missing.json'));
    assert.deepEqual(state, { lastSeenEventId: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cursor state can be saved and reloaded', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intent-broker-cursor-'));
  const statePath = path.join(dir, 'cursor.json');

  try {
    saveCursorState(statePath, { lastSeenEventId: 72 });
    const state = loadCursorState(statePath);

    assert.deepEqual(state, { lastSeenEventId: 72 });
    assert.match(readFileSync(statePath, 'utf8'), /72/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
