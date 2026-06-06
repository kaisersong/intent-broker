import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerService } from '../../src/broker/service.js';
import { createEventStore } from '../../src/store/event-store.js';
import { createContextSyncService } from '../../src/sync/context-sync.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

const FIXED_NOW_MS = Date.now() + 60 * 60 * 1000;
const FIXED_PREPARED_AT = new Date(FIXED_NOW_MS - 60 * 1000).toISOString();
const FIXED_EXPIRES_AT = new Date(FIXED_NOW_MS + 15 * 60 * 1000).toISOString();
const DEFAULT_SYNC_ID = `sync-songkai-${FIXED_NOW_MS}`;

function fixedClock() {
  return new Date(FIXED_NOW_MS);
}

function baseService(overrides = {}) {
  const store = createEventStore({ dbPath: createTempDbPath() });
  return {
    store,
    service: createContextSyncService({
      store,
      participantId: 'sender',
      userId: 'songkai',
      sourceNodeId: 'mb',
      sourceBrokerId: 'broker-local',
      now: fixedClock,
      ...overrides,
    }),
  };
}

test('prepareCheckpoint stores redacted context and excludes recent user messages by default', async () => {
  const { store, service } = baseService({
    gitTransport: {
      collectGitContext: async () => ({
        branch: 'feature/context-sync',
        gitHead: 'abc123',
        filesModified: ['src/broker/service.js'],
        filesPending: ['scratch.md'],
      }),
    },
  });

  const checkpoint = await service.prepareCheckpoint({
    summary: 'working on context sync',
    phase: 'implementing',
    keyDecisions: ['targeted delivery only'],
    recentUserMessages: ['do not include by default'],
  });
  const saved = store.getContextSync(checkpoint.syncId);

  assert.equal(saved.status, 'prepared');
  assert.equal(saved.userId, 'songkai');
  assert.equal(saved.sourceNodeId, 'mb');
  assert.equal(saved.payload.context.summary, 'working on context sync');
  assert.deepEqual(saved.payload.context.recentUserMessages, []);
  assert.deepEqual(saved.payload.context.filesModified, ['src/broker/service.js']);
  assert.deepEqual(saved.payload.context.filesPending, ['scratch.md']);
});

test('explicitSync pushes WIP before emitting a targeted context sync request', async () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });

  const { store, service } = baseService({
    broker,
    gitTransport: {
      collectGitContext: async () => ({
        branch: 'feature/context-sync',
        gitHead: 'abc123',
        filesModified: ['src/broker/service.js'],
        filesPending: [],
      }),
      createAndPushWipCommit: async () => ({
        wipBranch: 'wip/sync-songkai-1770000000000',
        latestRef: 'wip/sync-songkai-latest',
        wipCommitSha: 'def456',
        wipRemote: 'origin',
        filesModified: ['src/broker/service.js'],
      }),
    },
  });

  const result = await service.explicitSync({
    targetParticipantIds: ['receiver'],
    summary: 'handoff context',
  });
  const stored = store.getContextSync(result.syncId);
  const inbox = broker.readInbox('receiver', { after: 0, kind: 'context_sync_request' }).items;

  assert.equal(stored.status, 'emitted');
  assert.equal(stored.emitAttempts, 1);
  assert.equal(stored.wipBranch, 'wip/sync-songkai-1770000000000');
  assert.equal(stored.wipCommitSha, 'def456');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].payload.syncId, result.syncId);
  assert.equal(inbox[0].payload.wipCommitSha, 'def456');
});

test('explicitSync emits inline-only context when WIP push fails', async () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });

  const { store, service } = baseService({
    broker,
    gitTransport: {
      collectGitContext: async () => ({
        branch: 'feature/context-sync',
        gitHead: 'abc123',
        filesModified: ['src/broker/service.js'],
        filesPending: [],
      }),
      createAndPushWipCommit: async () => {
        throw new Error('push failed');
      },
    },
  });

  const result = await service.explicitSync({
    targetParticipantIds: ['receiver'],
    summary: 'handoff context',
  });
  const stored = store.getContextSync(result.syncId);
  const inbox = broker.readInbox('receiver', { after: 0, kind: 'context_sync_request' }).items;

  assert.equal(stored.status, 'emitted');
  assert.equal(stored.wipBranch, null);
  assert.equal(stored.lastError, 'push failed');
  assert.equal(inbox[0].payload.wipBranch, null);
  assert.equal(inbox[0].payload.wipCommitSha, null);
});

test('emitLatestPreparedCheckpoint uses a fresh prepared checkpoint without running git', async () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });

  const { store, service } = baseService({
    broker,
    gitTransport: {
      collectGitContext: async () => {
        throw new Error('offline emit must not collect git context');
      },
      createAndPushWipCommit: async () => {
        throw new Error('offline emit must not push git state');
      },
    },
  });
  store.saveContextSync({
    syncId: DEFAULT_SYNC_ID,
    userId: 'songkai',
    sourceNodeId: 'mb',
    status: 'prepared',
    payload: {
      syncId: DEFAULT_SYNC_ID,
      userId: 'songkai',
      sourceNodeId: 'mb',
      sourceBrokerId: 'broker-local',
      context: {
        summary: 'prepared context',
        recentUserMessages: [],
      },
      wipBranch: null,
      latestRef: null,
      wipCommitSha: null,
      wipRemote: null,
      expiresAt: FIXED_EXPIRES_AT,
    },
    createdAt: FIXED_PREPARED_AT,
    preparedAt: FIXED_PREPARED_AT,
    expiresAt: FIXED_EXPIRES_AT,
  });

  const result = await service.emitLatestPreparedCheckpoint({
    targetParticipantIds: ['receiver'],
  });
  const inbox = broker.readInbox('receiver', { after: 0, kind: 'context_sync_request' }).items;

  assert.equal(result.status, 'emitted');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].payload.context.summary, 'prepared context');
});

function syncRequestEvent(overrides = {}) {
  return {
    eventId: 7,
    intentId: DEFAULT_SYNC_ID,
    kind: 'context_sync_request',
    fromParticipantId: 'sender',
    threadId: 'context-sync-songkai',
    payload: {
      syncId: DEFAULT_SYNC_ID,
      userId: 'songkai',
      sourceNodeId: 'mb',
      sourceBrokerId: 'broker-local',
      context: {
        summary: 'prepared context',
        branch: 'feature/context-sync',
        gitHead: 'abc123',
        filesModified: ['src/broker/service.js'],
        filesPending: ['scratch.md'],
        keyDecisions: ['targeted delivery only'],
        recentUserMessages: [],
      },
      wipBranch: 'wip/sync-songkai-1770000000000',
      latestRef: 'wip/sync-songkai-latest',
      wipCommitSha: 'def456',
      wipRemote: 'origin',
      expiresAt: FIXED_EXPIRES_AT,
      ...overrides.payload,
    },
    ...overrides,
  };
}

test('loadContextSyncRequest verifies WIP into an isolated branch and emits loaded ack', async () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });

  const { service } = baseService({
    broker,
    participantId: 'receiver',
    gitTransport: {
      collectGitContext: async () => {
        throw new Error('receiver load must not checkpoint');
      },
      fetchAndVerifyWipCommit: async () => ({
        wipVerified: true,
        wipCommitSha: 'def456',
        fetchedRef: 'wip/sync-songkai-1770000000000',
      }),
      createIsolatedBranch: async () => ({
        branchName: 'context-sync/sync-songkai-1770000000000',
        wipCommitSha: 'def456',
      }),
    },
  });

  const loaded = await service.loadContextSyncRequest(syncRequestEvent());
  const ack = broker.readInbox('sender', { after: 0, kind: 'context_sync_ack' }).items[0];

  assert.equal(loaded.status, 'loaded');
  assert.equal(loaded.loadedReadOnly, true);
  assert.equal(loaded.appliedToWorktree, false);
  assert.equal(loaded.isolation.branchName, 'context-sync/sync-songkai-1770000000000');
  assert.match(loaded.displayText, /只读加载/);
  assert.equal(ack.payload.status, 'loaded');
  assert.equal(ack.payload.wipVerified, true);
  assert.equal(ack.payload.loadedReadOnly, true);
  assert.equal(ack.payload.appliedToWorktree, false);
});

test('loadContextSyncRequest emits partial ack when WIP verification fails', async () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });

  const { service } = baseService({
    broker,
    participantId: 'receiver',
    gitTransport: {
      collectGitContext: async () => {
        throw new Error('receiver load must not checkpoint');
      },
      fetchAndVerifyWipCommit: async () => {
        throw new Error('wip_commit_sha_mismatch');
      },
    },
  });

  const loaded = await service.loadContextSyncRequest(syncRequestEvent());
  const ack = broker.readInbox('sender', { after: 0, kind: 'context_sync_ack' }).items[0];

  assert.equal(loaded.status, 'partial');
  assert.equal(loaded.wipVerified, false);
  assert.equal(loaded.failureReason, 'wip_commit_sha_mismatch');
  assert.equal(ack.payload.status, 'partial');
  assert.equal(ack.payload.failureReason, 'wip_commit_sha_mismatch');
});

test('loadContextSyncRequest deduplicates by syncId and WIP SHA', async () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });
  let fetchCount = 0;

  const { service } = baseService({
    broker,
    participantId: 'receiver',
    gitTransport: {
      collectGitContext: async () => {
        throw new Error('receiver load must not checkpoint');
      },
      fetchAndVerifyWipCommit: async () => {
        fetchCount += 1;
        return {
          wipVerified: true,
          wipCommitSha: 'def456',
          fetchedRef: 'wip/sync-songkai-1770000000000',
        };
      },
      createIsolatedBranch: async () => ({
        branchName: 'context-sync/sync-songkai-1770000000000',
        wipCommitSha: 'def456',
      }),
    },
  });

  await service.loadContextSyncRequest(syncRequestEvent());
  const duplicate = await service.loadContextSyncRequest(syncRequestEvent());
  const acks = broker.readInbox('sender', { after: 0, kind: 'context_sync_ack' }).items;

  assert.equal(duplicate.duplicate, true);
  assert.equal(fetchCount, 1);
  assert.equal(acks.length, 1);
});
