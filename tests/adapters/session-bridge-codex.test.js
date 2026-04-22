import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildCodexAutoContinuePrompt,
  buildCodexHookContext,
  buildXiaokAutoContinuePrompt,
  buildXiaokHookContext,
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

test('buildToolHookContext tells the agent to reply through broker for actionable asks', () => {
  const context = buildToolHookContext(
    [
      {
        eventId: 72,
        kind: 'ask_clarification',
        fromParticipantId: 'human.song',
        taskId: 'task-3',
        threadId: 'thread-3',
        payload: {
          delivery: { semantic: 'actionable', source: 'default' },
          body: { summary: '你在做什么，回复我' }
        }
      }
    ],
    { participantId: 'codex.main' }
  );

  assert.match(context, /intent-broker reply/);
  assert.match(context, /instead of only answering locally/i);
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
  assert.match(context, /info event/);
  assert.match(context, /Please land the hotfix today/);
  assert.match(context, /I am already touching the auth path/);
});

test('buildToolHookContext coalesces noisy presence updates in informational items', () => {
  const context = buildToolHookContext(
    [
      {
        eventId: 80,
        kind: 'participant_presence_updated',
        fromParticipantId: 'broker.system',
        payload: {
          participantId: 'claude-peer',
          body: { summary: '@claude3 已上线，项目 intent-broker' }
        }
      },
      {
        eventId: 81,
        kind: 'participant_presence_updated',
        fromParticipantId: 'broker.system',
        payload: {
          participantId: 'claude-peer',
          body: { summary: '@claude3 已离线，项目 intent-broker' }
        }
      },
      {
        eventId: 82,
        kind: 'participant_presence_updated',
        fromParticipantId: 'broker.system',
        payload: {
          participantId: 'codex-peer',
          body: { summary: '@codex4 已上线，项目 intent-broker' }
        }
      },
      {
        eventId: 83,
        kind: 'participant_presence_updated',
        fromParticipantId: 'broker.system',
        payload: {
          participantId: 'codex-peer',
          body: { summary: '@codex4 已离线，项目 intent-broker' }
        }
      },
      {
        eventId: 84,
        kind: 'participant_presence_updated',
        fromParticipantId: 'broker.system',
        payload: {
          participantId: 'claude-another',
          body: { summary: '@claude5 已上线，项目 intent-broker' }
        }
      }
    ],
    { participantId: 'codex.main' }
  );

  assert.match(context, /presence update/);
  assert.match(context, /@claude3 已离线/);
  assert.match(context, /@codex4 已离线/);
  assert.match(context, /@claude5 已上线/);
  assert.doesNotMatch(context, /@claude3 已上线/);
  assert.doesNotMatch(context, /@codex4 已上线/);
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

test('buildCodexAutoContinuePrompt relies on transcript mirroring instead of explicit broker reply commands', () => {
  const prompt = buildCodexAutoContinuePrompt(
    [
      {
        eventId: 71,
        kind: 'ask_clarification',
        fromParticipantId: 'human.song',
        taskId: 'task-3',
        threadId: 'thread-3',
        payload: {
          delivery: { semantic: 'actionable', source: 'default' },
          body: { summary: '你在做什么，回复我' }
        }
      }
    ],
    { participantId: 'codex.main' }
  );

  assert.match(prompt, /final response/i);
  assert.match(prompt, /auto-mirror|transcript/i);
  assert.match(prompt, /manual broker cli reply|out-of-band status update/i);
  assert.doesNotMatch(prompt, /intent-broker reply/);
  assert.doesNotMatch(prompt, /send that response back through the broker in this turn/i);
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

test('buildXiaokHookContext teaches xiaok to use broker CLI roundtrips for real asks and approvals', () => {
  const context = buildXiaokHookContext(
    [
      {
        eventId: 91,
        kind: 'request_task',
        fromParticipantId: 'human.song',
        taskId: 'task-rt',
        threadId: 'thread-rt',
        payload: {
          delivery: { semantic: 'actionable', source: 'default' },
          body: { summary: 'Need a real user decision before continuing' }
        }
      }
    ],
    { participantId: 'xiaok.main', alias: 'xiaok' }
  );

  assert.match(context, /xiaok-broker ask-and-wait/);
  assert.match(context, /xiaok-broker approval-and-wait/);
  assert.match(context, /instead of claiming that broker tools are unavailable/i);
});

test('buildXiaokAutoContinuePrompt keeps completion mirroring while routing decisions through xiaok-broker commands', () => {
  const prompt = buildXiaokAutoContinuePrompt(
    [
      {
        eventId: 92,
        kind: 'ask_clarification',
        fromParticipantId: 'human.song',
        taskId: 'task-rt',
        threadId: 'thread-rt',
        payload: {
          delivery: { semantic: 'actionable', source: 'default' },
          body: { summary: 'Do you want to continue?' }
        }
      }
    ],
    { participantId: 'xiaok.main' }
  );

  assert.match(prompt, /output only the reply summary/i);
  assert.match(prompt, /stop hook will auto-mirror/i);
  assert.match(prompt, /xiaok-broker ask-and-wait/);
  assert.match(prompt, /xiaok-broker approval-and-wait/);
});
