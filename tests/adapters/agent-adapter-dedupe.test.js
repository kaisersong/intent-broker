import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../../adapters/codex/adapter.js';
import { ClaudeCodeAdapter } from '../../adapters/claude-code/adapter.js';

function sampleEvent(intentId) {
  return {
    eventId: 1,
    intentId,
    kind: 'ask_clarification',
    fromParticipantId: 'human.yzj_test',
    taskId: 'task-1',
    threadId: 'thread-1',
    payload: {
      body: { summary: 'hello' },
      participantId: 'human.yzj_test'
    }
  };
}

test('Codex adapter ignores duplicate intentIds', () => {
  const adapter = new CodexAdapter({
    brokerUrl: 'http://127.0.0.1:4318',
    participantId: 'codex-test'
  });

  const first = adapter.normalizeEvent(sampleEvent('dup-1'));
  const second = adapter.normalizeEvent(sampleEvent('dup-1'));
  const third = adapter.normalizeEvent(sampleEvent('dup-2'));

  assert.ok(first);
  assert.equal(second, null);
  assert.ok(third);
  assert.equal(third.intentId, 'dup-2');
});

test('Claude Code adapter ignores duplicate intentIds', () => {
  const adapter = new ClaudeCodeAdapter({
    brokerUrl: 'http://127.0.0.1:4318',
    participantId: 'claude-test'
  });

  const first = adapter.normalizeEvent(sampleEvent('dup-1'));
  const second = adapter.normalizeEvent(sampleEvent('dup-1'));
  const third = adapter.normalizeEvent(sampleEvent('dup-2'));

  assert.ok(first);
  assert.equal(second, null);
  assert.ok(third);
  assert.equal(third.intentId, 'dup-2');
});
