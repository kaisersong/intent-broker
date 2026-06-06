import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerService } from '../../../src/broker/service.js';
import { createEventStore } from '../../../src/store/event-store.js';
import { createContextSyncService } from '../../../src/sync/context-sync.js';
import { createTempDbPath } from '../../fixtures/temp-dir.js';
import { createContextSyncE2EHarness } from './harness.js';

function registerPair(broker) {
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });
}

function createSender({ harness, broker }) {
  return createContextSyncService({
    store: createEventStore({ dbPath: createTempDbPath() }),
    broker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
  });
}

function createReceiver({ harness, broker }) {
  return createContextSyncService({
    store: createEventStore({ dbPath: createTempDbPath() }),
    broker,
    participantId: 'receiver',
    userId: 'songkai',
    sourceNodeId: 'machine-b',
    sourceBrokerId: 'broker-b',
    cwd: harness.machineB,
  });
}

test('failure e2e: latest ref push failure still emits timestamped WIP and records cleanup pending', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.rejectLatestRefPushes();
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  registerPair(broker);
  const senderStore = createEventStore({ dbPath: createTempDbPath() });
  const sender = createContextSyncService({
    store: senderStore,
    broker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
  });

  const result = await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'partial push' });
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  const refs = await harness.listRemoteWipRefs();
  const stored = senderStore.getContextSync(result.syncId);

  assert.equal(result.status, 'emitted');
  assert.match(request.payload.wipBranch, /^wip\/sync-songkai-/);
  assert.equal(request.payload.latestRef, 'wip/sync-songkai-latest');
  assert.equal(refs.some((ref) => ref.ref === `refs/heads/${request.payload.wipBranch}`), true);
  assert.equal(refs.some((ref) => ref.ref === 'refs/heads/wip/sync-songkai-latest'), false);
  assert.equal(stored.cleanupStatus, 'pending');
  assert.match(stored.lastError, /pre-receive hook declined|latest rejected|hook declined/);
});

test('failure e2e: pushed WIP plus broker emit failure stores retryable partial state', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  const senderStore = createEventStore({ dbPath: createTempDbPath() });
  const failingBroker = {
    sendIntent: async () => {
      throw new Error('broker offline');
    },
  };
  const sender = createContextSyncService({
    store: senderStore,
    broker: failingBroker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
  });

  const result = await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'emit failure' });
  const refs = await harness.listRemoteWipRefs();
  const stored = senderStore.getContextSync(result.syncId);

  assert.equal(result.status, 'partial');
  assert.equal(stored.lastError, 'broker offline');
  assert.equal(stored.emitAttempts, 1);
  assert.equal(stored.cleanupStatus, 'pending');
  assert.equal(refs.length >= 1, true);
});

test('failure e2e: cleanup deletes only exact-SHA matching refs', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  registerPair(broker);
  const senderStore = createEventStore({ dbPath: createTempDbPath() });
  const sender = createContextSyncService({
    store: senderStore,
    broker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
  });

  const emitted = await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'cleanup' });
  await harness.appendMachineFile(harness.machineA, 'README.md', 'newer dirty change\n');
  await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'moves latest' });
  const cleaned = await sender.cleanupContextSync(emitted.syncId);
  const refs = await harness.listRemoteWipRefs();

  assert.equal(cleaned.cleanupStatus, 'cleaned');
  assert.equal(refs.some((ref) => ref.ref === `refs/heads/${emitted.wipBranch}`), false);
  assert.equal(refs.some((ref) => ref.ref === 'refs/heads/wip/sync-songkai-latest'), true);
});

test('failure e2e: expired prepared checkpoint is not emitted', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  registerPair(broker);
  const store = createEventStore({ dbPath: createTempDbPath() });
  const service = createContextSyncService({
    store,
    broker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
    now: () => new Date('2026-06-06T10:00:00.000Z'),
  });
  store.saveContextSync({
    syncId: 'sync-songkai-expired',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    status: 'prepared',
    payload: {
      syncId: 'sync-songkai-expired',
      userId: 'songkai',
      sourceNodeId: 'machine-a',
      context: { summary: 'expired', recentUserMessages: [] },
      expiresAt: '2026-06-06T09:00:00.000Z',
    },
    createdAt: '2026-06-06T08:00:00.000Z',
    preparedAt: '2026-06-06T08:00:00.000Z',
    expiresAt: '2026-06-06T09:00:00.000Z',
  });

  const result = await service.emitLatestPreparedCheckpoint({ targetParticipantIds: ['receiver'] });
  const inbox = broker.readInbox('receiver', { after: 0 }).items;

  assert.equal(result, null);
  assert.equal(inbox.length, 0);
});

test('failure e2e: receiver records SHA mismatch as partial', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  registerPair(broker);
  const sender = createSender({ harness, broker });
  const receiver = createReceiver({ harness, broker });

  await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'sha mismatch' });
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  request.payload.wipCommitSha = '0000000000000000000000000000000000000000';
  const loaded = await receiver.loadContextSyncRequest(request);

  assert.equal(loaded.status, 'partial');
  assert.equal(loaded.failureReason, 'wip_commit_sha_mismatch');
});
