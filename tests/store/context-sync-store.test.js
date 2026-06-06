import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventStore } from '../../src/store/event-store.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

function syncRecord(overrides = {}) {
  return {
    syncId: 'sync-songkai-1770000000000',
    userId: 'songkai',
    sourceNodeId: 'mb',
    status: 'prepared',
    payload: {
      userId: 'songkai',
      sourceNodeId: 'mb',
      context: {
        summary: 'working on relay roles',
        recentUserMessages: [],
        phase: 'implementing',
        branch: 'feature/relay-roles',
        gitHead: 'abc123',
        filesModified: ['src/broker/service.js'],
        keyDecisions: ['targeted delivery only'],
      },
      wipBranch: 'wip/sync-songkai-1770000000000',
      wipCommitSha: 'def456',
      wipRemote: 'origin',
      expiresAt: '2026-06-05T09:17:00.000Z',
    },
    wipBranch: 'wip/sync-songkai-1770000000000',
    wipCommitSha: 'def456',
    wipPushedAt: '2026-06-04T09:17:00.000Z',
    createdAt: '2026-06-04T09:17:00.000Z',
    expiresAt: '2026-06-05T09:17:00.000Z',
    ...overrides,
  };
}

test('context sync records can be saved, read, listed, and updated', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });

  store.saveContextSync(syncRecord());

  const saved = store.getContextSync('sync-songkai-1770000000000');
  assert.equal(saved.syncId, 'sync-songkai-1770000000000');
  assert.equal(saved.userId, 'songkai');
  assert.equal(saved.status, 'prepared');
  assert.equal(saved.payload.context.summary, 'working on relay roles');
  assert.equal(saved.wipBranch, 'wip/sync-songkai-1770000000000');
  assert.equal(saved.emitAttempts, 0);

  store.updateContextSync('sync-songkai-1770000000000', {
    status: 'emitted',
    emitAttempts: 1,
    lastEmitAt: '2026-06-04T09:18:00.000Z',
  });

  const emitted = store.getContextSync('sync-songkai-1770000000000');
  assert.equal(emitted.status, 'emitted');
  assert.equal(emitted.emitAttempts, 1);
  assert.equal(emitted.lastEmitAt, '2026-06-04T09:18:00.000Z');

  const listed = store.listContextSyncs({ userId: 'songkai', status: 'emitted' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].syncId, 'sync-songkai-1770000000000');
});

test('latest prepared context sync ignores expired records', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.saveContextSync(syncRecord({
    syncId: 'sync-songkai-old',
    sourceNodeId: 'old-mb',
    createdAt: '2026-06-04T09:01:00.000Z',
    expiresAt: '2026-06-04T09:00:00.000Z',
  }));
  store.saveContextSync(syncRecord({
    syncId: 'sync-songkai-new',
    payload: { newer: true },
    createdAt: '2026-06-04T09:16:00.000Z',
    expiresAt: '2026-06-04T09:30:00.000Z',
  }));

  const latest = store.getLatestPreparedContextSync({
    userId: 'songkai',
    now: new Date('2026-06-04T09:20:00.000Z'),
    maxAgeMs: 15 * 60 * 1000,
  });

  assert.equal(latest.syncId, 'sync-songkai-new');
  assert.deepEqual(latest.payload, { newer: true });
});

test('context sync ack transition records receiver metadata', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.saveContextSync(syncRecord({ status: 'emitted' }));

  store.markContextSyncAcked('sync-songkai-1770000000000', {
    receiverParticipantId: 'codex-b',
    ackedAt: '2026-06-04T09:19:00.000Z',
  });

  const acked = store.getContextSync('sync-songkai-1770000000000');
  assert.equal(acked.status, 'acked');
  assert.equal(acked.receiverParticipantId, 'codex-b');
  assert.equal(acked.ackedAt, '2026-06-04T09:19:00.000Z');
});

test('receiver dedupe lookup finds terminal context sync for same receiver and SHA', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.saveContextSync(syncRecord({
    status: 'acked',
    receiverParticipantId: 'receiver',
    wipCommitSha: 'def456',
    ackedAt: '2026-06-04T09:19:00.000Z',
  }));

  const duplicate = store.findReceiverContextSync({
    syncId: 'sync-songkai-1770000000000',
    receiverParticipantId: 'receiver',
    wipCommitSha: 'def456',
  });

  assert.equal(duplicate.status, 'acked');
  assert.equal(duplicate.receiverParticipantId, 'receiver');
});

test('cleanup candidates include terminal records with WIP refs', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.saveContextSync(syncRecord({
    status: 'acked',
    cleanupStatus: 'pending',
  }));
  store.saveContextSync(syncRecord({
    syncId: 'sync-inline',
    status: 'acked',
    wipBranch: null,
    latestRef: null,
    wipCommitSha: null,
    cleanupStatus: 'pending',
  }));

  const candidates = store.listContextSyncCleanupCandidates({ limit: 10 });

  assert.deepEqual(candidates.map((record) => record.syncId), ['sync-songkai-1770000000000']);
});

test('cleanup marker records status, attempt time, and error', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.saveContextSync(syncRecord({
    status: 'cleanup_pending',
    cleanupStatus: 'pending',
  }));

  store.markContextSyncCleanup('sync-songkai-1770000000000', {
    cleanupStatus: 'failed',
    cleanupAttemptedAt: '2026-06-04T09:21:00.000Z',
    cleanupError: 'remote rejected delete',
  });

  const saved = store.getContextSync('sync-songkai-1770000000000');
  assert.equal(saved.cleanupStatus, 'failed');
  assert.equal(saved.cleanupAttemptedAt, '2026-06-04T09:21:00.000Z');
  assert.equal(saved.cleanupError, 'remote rejected delete');
});
