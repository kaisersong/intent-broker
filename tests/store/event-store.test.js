import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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


const reliableIntent = (overrides = {}) => ({
  intentId: 'reliable', kind: 'report_progress', fromParticipantId: 'agent.a',
  taskId: 'task', threadId: 'thread', payload: { phase: 'started' },
  recipients: ['agent.a', 'agent.b'], ...overrides,
});

test('appendIntent rolls back the event and all recipients on a torn inbox write', () => {
  const dbPath = createTempDbPath();
  const store = createEventStore({ dbPath });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TRIGGER fail_second_recipient BEFORE INSERT ON inbox_entries
    WHEN NEW.participant_id = 'agent.b' BEGIN SELECT RAISE(ABORT, 'inbox write fault'); END;`);
  assert.throws(() => store.appendIntent(reliableIntent()), /inbox write fault/);
  assert.equal(store.listEvents().length, 0);
  assert.equal(store.readInbox('agent.a').items.length, 0);
  db.exec('DROP TRIGGER fail_second_recipient');
  const event = store.appendIntent(reliableIntent());
  assert.equal(store.readInbox('agent.b').items[0].eventId, event.eventId);
  db.close();
});

test('duplicate intent repairs a missing inbox only from the frozen recipient set', () => {
  const dbPath = createTempDbPath();
  const store = createEventStore({ dbPath });
  const original = store.appendIntent(reliableIntent());
  const db = new DatabaseSync(dbPath);
  db.prepare('DELETE FROM inbox_entries WHERE event_id = ? AND participant_id = ?').run(original.eventId, 'agent.b');
  const duplicate = store.appendIntent(reliableIntent({ recipients: ['agent.b', 'agent.a'] }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.readInbox('agent.b').items.length, 1);
  assert.throws(() => store.appendIntent(reliableIntent({ recipients: ['agent.a', 'agent.b', 'agent.c'] })), /intent_conflict/);
  assert.equal(store.readInbox('agent.c').items.length, 0);
  db.close();
});

test('duplicate intent rejects a changed source, scope or payload without altering recipients', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.appendIntent(reliableIntent());
  for (const change of [{ payload: { phase: 'done' } }, { threadId: 'other' }, { fromParticipantId: 'evil' }, { taskId: 'other' }]) {
    assert.throws(() => store.appendIntent(reliableIntent(change)), /intent_conflict/);
  }
  assert.equal(store.listEvents().length, 1);
});

test('inbox acknowledgement cannot roll back or acknowledge another recipient event', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.appendIntent(reliableIntent({ intentId: 'one' }));
  const latest = store.appendIntent(reliableIntent({ intentId: 'two' }));
  store.ackInbox('agent.a', latest.eventId);
  store.ackInbox('agent.a', 1);
  assert.equal(store.getCursor('agent.a'), latest.eventId);
  assert.throws(() => store.ackInbox('unrelated', latest.eventId), /inbox_event_not_owned/);
  assert.equal(store.getCursor('unrelated'), 0);
});

test('legacy partial inbox cannot be expanded from an unproven retry recipient set', () => {
  const dbPath = createTempDbPath();
  const store = createEventStore({ dbPath });
  const event = store.appendIntent(reliableIntent());
  const db = new DatabaseSync(dbPath);
  db.prepare('DELETE FROM intent_receipts WHERE event_id=?').run(event.eventId);
  db.prepare('DELETE FROM inbox_entries WHERE event_id=? AND participant_id=?').run(event.eventId, 'agent.b');
  assert.throws(() => store.appendIntent(reliableIntent()), /intent_recipients_unconfirmed/);
  assert.equal(store.readInbox('agent.b').items.length, 0);
  db.close();
});

test('intent payload key order and repeated recipient IDs do not change canonical identity', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  const first = store.appendIntent(reliableIntent({ payload: { x: 1, nested: { b: 2, a: 1 } }, recipients: ['agent.b', 'agent.a', 'agent.b'] }));
  const second = store.appendIntent(reliableIntent({ payload: { nested: { a: 1, b: 2 }, x: 1 } }));
  assert.equal(first.eventId, second.eventId);
  assert.equal(store.readInbox('agent.a').items.length, 1);
});
