import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildCodexAutoContinuePrompt,
  buildCodexHookContext,
  buildCodexHookOutput,
  buildToolAutoContinuePrompt,
  buildToolHookContext,
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

test('buildToolHookContext supports custom session label', () => {
  const context = buildToolHookContext(
    [
      {
        eventId: 70,
        kind: 'request_task',
        fromParticipantId: 'codex.main',
        taskId: 'task-2',
        threadId: 'thread-2',
        payload: { body: { summary: 'Please pick up regression triage' } }
      }
    ],
    { participantId: 'claude-code-session-aabbccdd', sessionLabel: 'Claude Code session' }
  );

  assert.match(context, /Intent Broker update for claude-code-session-aabbccdd/);
  assert.match(context, /Please pick up regression triage/);
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
        payload: {
          delivery: { semantic: 'actionable', source: 'explicit' },
          body: { summary: 'Please pick up regression triage' }
        }
      }
    ],
    { participantId: 'codex.main' }
  );

  assert.match(context, /Intent Broker update for codex\.main/);
  assert.match(context, /Actionable items/);
  assert.match(context, /Please pick up regression triage/);
  assert.match(context, /Treat the actionable items as commands or blocking asks/);
});

test('buildToolHookContext separates actionable and informational events', () => {
  const context = buildToolHookContext(
    [
      {
        eventId: 70,
        kind: 'request_task',
        fromParticipantId: 'human.song',
        taskId: 'task-2',
        threadId: 'thread-2',
        payload: {
          delivery: { semantic: 'actionable', source: 'default' },
          body: { summary: 'Please land the hotfix today' }
        }
      },
      {
        eventId: 71,
        kind: 'report_progress',
        fromParticipantId: 'codex.peer',
        taskId: 'task-2',
        threadId: 'thread-2',
        payload: {
          delivery: { semantic: 'informational', source: 'default' },
          body: { summary: 'I am already touching the auth path' }
        }
      }
    ],
    { participantId: 'claude-code-session-aabbccdd', sessionLabel: 'Claude Code session' }
  );

  assert.match(context, /Actionable items/);
  assert.match(context, /Informational items/);
  assert.match(context, /Please land the hotfix today/);
  assert.match(context, /I am already touching the auth path/);
});

test('buildCodexAutoContinuePrompt turns broker context into a continuation prompt', () => {
  const prompt = buildCodexAutoContinuePrompt(
    [
      {
        eventId: 70,
        kind: 'request_task',
        fromParticipantId: 'human.song',
        taskId: 'task-2',
        threadId: 'thread-2',
        payload: {
          delivery: { semantic: 'actionable', source: 'default' },
          body: { summary: 'Please land the hotfix today' }
        }
      }
    ],
    { participantId: 'codex.main' }
  );

  assert.match(prompt, /Intent Broker auto-continue for codex\.main/);
  assert.match(prompt, /Continue immediately with the actionable items below/);
  assert.match(prompt, /Please land the hotfix today/);
});

test('buildToolAutoContinuePrompt returns null when there are no items', () => {
  assert.equal(buildToolAutoContinuePrompt([], { participantId: 'codex.main' }), null);
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
    assert.deepEqual(state, { lastSeenEventId: 0, recentContext: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cursor state can be saved and reloaded', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intent-broker-cursor-'));
  const statePath = path.join(dir, 'cursor.json');

  try {
    saveCursorState(statePath, {
      lastSeenEventId: 72,
      recentContext: {
        fromParticipantId: 'claude.session',
        fromAlias: 'claude2',
        taskId: 'task-9',
        threadId: 'thread-9'
      }
    });
    const state = loadCursorState(statePath);

    assert.deepEqual(state, {
      lastSeenEventId: 72,
      recentContext: {
        eventId: null,
        kind: null,
        fromParticipantId: 'claude.session',
        fromAlias: 'claude2',
        fromProjectName: null,
        taskId: 'task-9',
        threadId: 'thread-9',
        summary: null
      }
    });
    assert.match(readFileSync(statePath, 'utf8'), /72/);
    assert.match(readFileSync(statePath, 'utf8'), /claude2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
