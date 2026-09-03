/**
 * room_history_read_audits (design §6.2).
 *
 * Independent audit schema for agent history page reads — must NOT reuse
 * room_execution_audit (which requires room_message_id/logical_agent_id and
 * is meant for settled/expired execution outcomes, not bounded history
 * pagination). Records must not contain message body text. Retention is
 * 30 days, pruned lazily (startup + at most once per 24h on audit writes),
 * with no new background timer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { createRoomStore } from '../../src/room/store.js';

function setupStore() {
  const store = createRoomStore({ dbPath: createTempDbPath() });
  store.migrate();
  return store;
}

test('recordRoomHistoryReadAudit persists the frozen field set only, no message body', () => {
  const store = setupStore();
  store.recordRoomHistoryReadAudit({
    roomId: 'room-1',
    actorParticipantId: 'agent-alpha',
    fromSequence: 10,
    toSequence: 60,
    requestedLimit: 50,
    resultCount: 50,
    now: 1700000000000,
  });

  const audits = store.listRoomHistoryReadAudits('room-1');
  assert.equal(audits.length, 1);
  const audit = audits[0];
  assert.equal(audit.roomId, 'room-1');
  assert.equal(audit.actorParticipantId, 'agent-alpha');
  assert.equal(audit.fromSequence, 10);
  assert.equal(audit.toSequence, 60);
  assert.equal(audit.requestedLimit, 50);
  assert.equal(audit.resultCount, 50);
  assert.ok(audit.createdAt);
  assert.deepEqual(
    Object.keys(audit).sort(),
    ['actorParticipantId', 'createdAt', 'fromSequence', 'id', 'requestedLimit', 'resultCount', 'roomId', 'toSequence'].sort(),
  );
});

test('recordRoomHistoryReadAudit accepts null fromSequence/toSequence/requestedLimit for a full legacy read', () => {
  const store = setupStore();
  store.recordRoomHistoryReadAudit({
    roomId: 'room-1',
    actorParticipantId: 'agent-alpha',
    resultCount: 10,
    now: 1700000000000,
  });
  const audits = store.listRoomHistoryReadAudits('room-1');
  assert.equal(audits[0].fromSequence, null);
  assert.equal(audits[0].toSequence, null);
  assert.equal(audits[0].requestedLimit, null);
});

test('pruneStaleRoomHistoryReadAuditsIfDue deletes audits older than 30 days', () => {
  const store = setupStore();
  const THIRTY_ONE_DAYS_AGO = Date.now() - 31 * 24 * 60 * 60 * 1000;
  store.recordRoomHistoryReadAudit({
    roomId: 'room-1', actorParticipantId: 'agent-alpha', resultCount: 5, now: THIRTY_ONE_DAYS_AGO,
  });
  assert.equal(store.listRoomHistoryReadAudits('room-1').length, 1);

  const result = store.pruneStaleRoomHistoryReadAuditsIfDue(Date.now());
  assert.equal(result.skipped, false);
  assert.equal(result.pruned, 1);
  assert.equal(store.listRoomHistoryReadAudits('room-1').length, 0);
});

test('pruneStaleRoomHistoryReadAuditsIfDue is a no-op (skipped) if called again within 24 hours', () => {
  const store = setupStore();
  const now = Date.now();
  // recordRoomHistoryReadAudit itself triggers a lazy cleanup pass at `now`,
  // so the first explicit pruneStaleRoomHistoryReadAuditsIfDue(now) call below
  // is already within the same 24h window and must be skipped.
  store.recordRoomHistoryReadAudit({ roomId: 'room-1', actorParticipantId: 'agent-alpha', resultCount: 1, now });
  const immediateRecall = store.pruneStaleRoomHistoryReadAuditsIfDue(now);
  assert.equal(immediateRecall.skipped, true, 'a cleanup pass already ran as part of the write above');
  const stillWithinWindow = store.pruneStaleRoomHistoryReadAuditsIfDue(now + 60 * 60 * 1000);
  assert.equal(stillWithinWindow.skipped, true);
});

test('pruneStaleRoomHistoryReadAuditsIfDue runs again after the 24h interval has elapsed', () => {
  const store = setupStore();
  const now = Date.now();
  store.pruneStaleRoomHistoryReadAuditsIfDue(now);
  const later = store.pruneStaleRoomHistoryReadAuditsIfDue(now + 25 * 60 * 60 * 1000);
  assert.equal(later.skipped, false);
});

test('recordRoomHistoryReadAudit triggers a lazy cleanup pass after writing (design §6.2)', () => {
  const store = setupStore();
  const OLD_TIME = Date.now() - 40 * 24 * 60 * 60 * 1000;
  store.recordRoomHistoryReadAudit({ roomId: 'room-old', actorParticipantId: 'agent-x', resultCount: 1, now: OLD_TIME });

  store.recordRoomHistoryReadAudit({ roomId: 'room-1', actorParticipantId: 'agent-alpha', resultCount: 1, now: Date.now() });

  assert.equal(store.listRoomHistoryReadAudits('room-old').length, 0, 'the 40-day-old audit must be pruned by the lazy cleanup triggered on write');
  assert.equal(store.listRoomHistoryReadAudits('room-1').length, 1, 'the fresh write itself must survive');
});

test('audits are scoped per room and do not leak across rooms', () => {
  const store = setupStore();
  store.recordRoomHistoryReadAudit({ roomId: 'room-a', actorParticipantId: 'agent-1', resultCount: 3, now: Date.now() });
  store.recordRoomHistoryReadAudit({ roomId: 'room-b', actorParticipantId: 'agent-2', resultCount: 4, now: Date.now() });

  assert.equal(store.listRoomHistoryReadAudits('room-a').length, 1);
  assert.equal(store.listRoomHistoryReadAudits('room-b').length, 1);
  assert.equal(store.listRoomHistoryReadAudits('room-a')[0].actorParticipantId, 'agent-1');
});
