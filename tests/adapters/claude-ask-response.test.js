import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForAskResponse } from '../../adapters/claude-code-plugin/ask-response.js';
function answer(eventId, taskId, threadId) {
  return { eventId, kind: 'answer_clarification', taskId, threadId, payload: { body: { summary: 'answer-' + eventId } } };
}
test('wait ignores a matching task with a foreign thread and a matching thread with a foreign task', async () => {
  const expected = answer(4, 'ask-id', 'ask-id');
  const result = await waitForAskResponse({
    config: { brokerUrl: 'http://fixture.invalid' }, intentId: 'ask-id', afterEventId: 1, timeoutMs: 1000, pollMs: 0,
    requestJson: async () => ({ items: [answer(2, 'ask-id', 'foreign'), answer(3, 'foreign', 'ask-id'), expected] })
  });
  assert.equal(result, expected);
});
test('wait uses the exact explicit request task and thread instead of guessing intent ID', async () => {
  const expected = answer(2, 'task-explicit', 'thread-explicit');
  let calls = 0;
  const result = await waitForAskResponse({
    config: { brokerUrl: 'http://fixture.invalid' }, intentId: 'ask-id', taskId: 'task-explicit', threadId: 'thread-explicit',
    afterEventId: 1, timeoutMs: 1000, pollMs: 0,
    requestJson: async () => {
      if (calls++) throw Error('unexpected second replay');
      return { items: [expected] };
    }
  });
  assert.equal(result, expected);
});
test('future response kinds still require the exact original intent ID', async () => {
  const expected = { eventId: 3, kind: 'respond_ask', intentId: 'ask-id' };
  const result = await waitForAskResponse({
    config: { brokerUrl: 'http://fixture.invalid' }, intentId: 'ask-id', afterEventId: 1, timeoutMs: 1000, pollMs: 0,
    requestJson: async () => ({ items: [{ eventId: 2, kind: 'respond_ask', intentId: 'foreign' }, expected] })
  });
  assert.equal(result, expected);
});
