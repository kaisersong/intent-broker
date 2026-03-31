import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventStore } from '../../src/store/event-store.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

test('appendIntent writes event and inbox entries for broadcast recipients', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  const event = store.appendIntent({
    intentId: 'int-1',
    kind: 'request_task',
    fromParticipantId: 'human.song',
    taskId: 'task-1',
    threadId: 'thread-1',
    payload: { body: { summary: 'fix it' } },
    recipients: ['agent.a', 'agent.b']
  });

  assert.equal(event.eventId, 1);
  assert.equal(store.readInbox('agent.a', { after: 0 }).items.length, 1);
  assert.equal(store.readInbox('agent.b', { after: 0 }).items.length, 1);
});

test('ackInbox advances cursor and hides older events from future pulls', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.appendIntent({
    intentId: 'int-1',
    kind: 'request_task',
    fromParticipantId: 'human.song',
    taskId: 'task-1',
    threadId: 'thread-1',
    payload: {},
    recipients: ['agent.a']
  });

  store.ackInbox('agent.a', 1);

  assert.equal(store.readInbox('agent.a', { after: 1 }).items.length, 0);
  assert.equal(store.getCursor('agent.a'), 1);
});

test('listEvents returns persisted events for replay', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.appendIntent({
    intentId: 'int-1',
    kind: 'request_task',
    fromParticipantId: 'human.song',
    taskId: 'task-1',
    threadId: 'thread-1',
    payload: { body: { summary: 'fix it' } },
    recipients: ['agent.a']
  });

  const events = store.listEvents();

  assert.equal(events.length, 1);
  assert.equal(events[0].intentId, 'int-1');
  assert.deepEqual(events[0].payload.body, { summary: 'fix it' });
});

test('appendIntent is idempotent for duplicate intentId', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });

  const first = store.appendIntent({
    intentId: 'int-duplicate',
    kind: 'ask_clarification',
    fromParticipantId: 'human.song',
    taskId: 'task-dup',
    threadId: 'thread-dup',
    payload: { body: { summary: 'first delivery' } },
    recipients: ['agent.a']
  });

  const second = store.appendIntent({
    intentId: 'int-duplicate',
    kind: 'ask_clarification',
    fromParticipantId: 'human.song',
    taskId: 'task-dup',
    threadId: 'thread-dup',
    payload: { body: { summary: 'first delivery' } },
    recipients: ['agent.a']
  });

  assert.equal(first.eventId, second.eventId);
  assert.equal(second.duplicate, true);

  const events = store.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].intentId, 'int-duplicate');
});
