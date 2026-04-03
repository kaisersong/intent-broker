import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadReplyMirrorState,
  markPendingReplyMirror,
  maybeMirrorPendingReply
} from '../../adapters/session-bridge/reply-mirror.js';

function writeJsonl(filePath, entries) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}

test('maybeMirrorPendingReply mirrors Codex final answer back through broker', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-reply-mirror-'));
  const transcriptPath = path.join(
    homeDir,
    '.codex',
    'sessions',
    '2026',
    '04',
    '03',
    'rollout-2026-04-03T10-00-00-session-codex-1.jsonl'
  );
  const sent = [];

  try {
    writeJsonl(transcriptPath, [
      {
        timestamp: '2026-04-03T10:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '旧消息' }],
          phase: 'final_answer'
        }
      }
    ]);

    markPendingReplyMirror(
      'codex',
      'codex-session-codex-1',
      {
        sessionId: 'session-codex-1',
        transcriptLineCount: 1,
        recentContext: {
          fromParticipantId: 'human.yzj',
          fromAlias: 'song',
          taskId: 'task-1',
          threadId: 'thread-1'
        }
      },
      { homeDir }
    );

    writeJsonl(transcriptPath, [
      {
        timestamp: '2026-04-03T10:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '旧消息' }],
          phase: 'final_answer'
        }
      },
      {
        timestamp: '2026-04-03T10:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '处理中' }],
          phase: 'commentary'
        }
      },
      {
        timestamp: '2026-04-03T10:01:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: '我已经定位到问题，正在提交修复。'
        }
      }
    ]);

    const result = await maybeMirrorPendingReply(
      {
        brokerUrl: 'http://127.0.0.1:4318',
        participantId: 'codex-session-codex-1',
        context: { projectName: 'intent-broker' }
      },
      {
        toolName: 'codex',
        sessionId: 'session-codex-1',
        turnId: 'turn-1',
        homeDir,
        sendProgress: async (_config, payload) => {
          sent.push(payload);
          return { eventId: 101, recipients: ['human.yzj'] };
        }
      }
    );

    assert.equal(result.mirrored, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].toParticipantId, 'human.yzj');
    assert.equal(sent[0].taskId, 'task-1');
    assert.equal(sent[0].threadId, 'thread-1');
    assert.equal(sent[0].summary, '我已经定位到问题，正在提交修复。');

    const state = loadReplyMirrorState('codex', 'codex-session-codex-1', { homeDir });
    assert.equal(state.pending, null);
    assert.equal(state.lastMirrored.summary, '我已经定位到问题，正在提交修复。');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('maybeMirrorPendingReply mirrors Claude final answer text and ignores tool_use rows', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-reply-mirror-'));
  const transcriptPath = path.join(
    homeDir,
    '.claude',
    'projects',
    '-Users-song-projects',
    'claude-session-1.jsonl'
  );
  const sent = [];

  try {
    writeJsonl(transcriptPath, [
      {
        type: 'assistant',
        sessionId: 'claude-session-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '旧消息' }],
          stop_reason: 'end_turn'
        }
      }
    ]);

    markPendingReplyMirror(
      'claude-code',
      'claude-code-session-claude-session-1',
      {
        sessionId: 'claude-session-1',
        transcriptLineCount: 1,
        recentContext: {
          fromParticipantId: 'codex-peer',
          fromAlias: 'codex4',
          taskId: 'task-2',
          threadId: 'thread-2'
        }
      },
      { homeDir }
    );

    writeJsonl(transcriptPath, [
      {
        type: 'assistant',
        sessionId: 'claude-session-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '旧消息' }],
          stop_reason: 'end_turn'
        }
      },
      {
        type: 'assistant',
        sessionId: 'claude-session-1',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', id: 'tool-1', input: {} }],
          stop_reason: 'tool_use'
        }
      },
      {
        type: 'assistant',
        sessionId: 'claude-session-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '我在修 intent-broker 的自动回复链路。' }],
          stop_reason: 'end_turn'
        }
      }
    ]);

    const result = await maybeMirrorPendingReply(
      {
        brokerUrl: 'http://127.0.0.1:4318',
        participantId: 'claude-code-session-claude-session-1',
        context: { projectName: 'intent-broker' }
      },
      {
        toolName: 'claude-code',
        sessionId: 'claude-session-1',
        homeDir,
        sendProgress: async (_config, payload) => {
          sent.push(payload);
          return { eventId: 202, recipients: ['codex-peer'] };
        }
      }
    );

    assert.equal(result.mirrored, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].toParticipantId, 'codex-peer');
    assert.equal(sent[0].summary, '我在修 intent-broker 的自动回复链路。');

    const state = loadReplyMirrorState('claude-code', 'claude-code-session-claude-session-1', { homeDir });
    assert.equal(state.pending, null);
    assert.equal(state.lastMirrored.summary, '我在修 intent-broker 的自动回复链路。');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('maybeMirrorPendingReply degrades cleanly when transcript has no assistant answer yet', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-reply-mirror-'));
  const transcriptPath = path.join(
    homeDir,
    '.claude',
    'projects',
    '-Users-song-projects',
    'claude-session-2.jsonl'
  );

  try {
    writeJsonl(transcriptPath, [
      {
        type: 'assistant',
        sessionId: 'claude-session-2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '旧消息' }],
          stop_reason: 'end_turn'
        }
      }
    ]);

    markPendingReplyMirror(
      'claude-code',
      'claude-code-session-claude-session-2',
      {
        sessionId: 'claude-session-2',
        transcriptLineCount: 1,
        recentContext: {
          fromParticipantId: 'human.yzj',
          fromAlias: 'song',
          taskId: 'task-3',
          threadId: 'thread-3'
        }
      },
      { homeDir }
    );

    const result = await maybeMirrorPendingReply(
      {
        brokerUrl: 'http://127.0.0.1:4318',
        participantId: 'claude-code-session-claude-session-2',
        context: { projectName: 'intent-broker' }
      },
      {
        toolName: 'claude-code',
        sessionId: 'claude-session-2',
        homeDir,
        sendProgress: async () => {
          throw new Error('should_not_send');
        }
      }
    );

    assert.equal(result.mirrored, false);
    assert.equal(result.reason, 'assistant-output-not-found');

    const state = loadReplyMirrorState('claude-code', 'claude-code-session-claude-session-2', { homeDir });
    assert.equal(state.pending, null);
    assert.equal(state.lastFailure.reason, 'assistant-output-not-found');
    assert.match(readFileSync(transcriptPath, 'utf8'), /旧消息/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
