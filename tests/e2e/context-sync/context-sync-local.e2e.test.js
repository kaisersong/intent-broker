import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerService } from '../../../src/broker/service.js';
import { createEventStore } from '../../../src/store/event-store.js';
import { createContextSyncService } from '../../../src/sync/context-sync.js';
import { applyVerifiedWipCommit } from '../../../src/sync/git-transport.js';
import { createTempDbPath } from '../../fixtures/temp-dir.js';
import { createContextSyncE2EHarness } from './harness.js';

function registerPair(broker) {
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });
}

function createServicePair({ harness, broker = createBrokerService({ dbPath: createTempDbPath() }) }) {
  registerPair(broker);
  const senderStore = createEventStore({ dbPath: createTempDbPath() });
  const receiverStore = createEventStore({ dbPath: createTempDbPath() });
  const sender = createContextSyncService({
    store: senderStore,
    broker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
  });
  const receiver = createContextSyncService({
    store: receiverStore,
    broker,
    participantId: 'receiver',
    userId: 'songkai',
    sourceNodeId: 'machine-b',
    sourceBrokerId: 'broker-b',
    cwd: harness.machineB,
  });
  return { broker, senderStore, receiverStore, sender, receiver };
}

test('local e2e: inline-only context loads and acks without WIP', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  const { broker, sender, receiver } = createServicePair({ harness });

  const emitted = await sender.explicitSync({
    targetParticipantIds: ['receiver'],
    summary: 'inline handoff',
  });
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  const loaded = await receiver.loadContextSyncRequest(request);
  const ack = broker.readInbox('sender', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_ack');

  assert.equal(emitted.status, 'emitted');
  assert.equal(request.payload.wipCommitSha, null);
  assert.equal(loaded.status, 'loaded');
  assert.equal(loaded.wipVerified, false);
  assert.equal(ack.payload.status, 'loaded');
});

test('local e2e: tracked dirty WIP is pushed, fetched by exact SHA, and isolated', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  const { broker, sender, receiver } = createServicePair({ harness });

  const emitted = await sender.explicitSync({
    targetParticipantIds: ['receiver'],
    summary: 'tracked handoff',
  });
  const refs = await harness.listRemoteWipRefs();
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  const loaded = await receiver.loadContextSyncRequest(request);

  assert.equal(emitted.status, 'emitted');
  assert.match(request.payload.wipBranch, /^wip\/sync-songkai-/);
  assert.equal(typeof request.payload.wipCommitSha, 'string');
  assert.equal(request.payload.wipCommitSha.length, 40);
  assert.equal(refs.some((ref) => ref.ref === `refs/heads/${request.payload.wipBranch}`), true);
  assert.equal(loaded.status, 'loaded');
  assert.equal(loaded.wipVerified, true);
  assert.match(loaded.isolation.branchName, /^context-sync\/sync-songkai-/);
});

test('local e2e: untracked-only work is metadata only and does not create WIP', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.writeMachineFile(harness.machineA, 'scratch.md', 'untracked note\n');
  const { broker, sender, receiver } = createServicePair({ harness });

  const emitted = await sender.explicitSync({
    targetParticipantIds: ['receiver'],
    summary: 'untracked metadata handoff',
  });
  const refs = await harness.listRemoteWipRefs();
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  const loaded = await receiver.loadContextSyncRequest(request);

  assert.equal(emitted.status, 'emitted');
  assert.deepEqual(request.payload.context.filesPending, ['scratch.md']);
  assert.equal(request.payload.wipCommitSha, null);
  assert.equal(refs.length, 0);
  assert.match(loaded.displayText, /未跟踪文件仅作为元数据/);
});

test('local e2e: mixed tracked and untracked work syncs tracked content only', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  await harness.writeMachineFile(harness.machineA, 'scratch.md', 'untracked note\n');
  const { broker, sender, receiver } = createServicePair({ harness });

  await sender.explicitSync({
    targetParticipantIds: ['receiver'],
    summary: 'mixed handoff',
  });
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  const loaded = await receiver.loadContextSyncRequest(request);

  assert.deepEqual(request.payload.context.filesModified, ['README.md']);
  assert.deepEqual(request.payload.context.filesPending, ['scratch.md']);
  assert.equal(typeof request.payload.wipCommitSha, 'string');
  assert.match(loaded.displayText, /未跟踪文件仅作为元数据/);
});

test('local e2e: duplicate delivery after receiver service restart is idempotent', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  registerPair(broker);
  const senderStore = createEventStore({ dbPath: createTempDbPath() });
  const receiverDbPath = createTempDbPath();
  const sender = createContextSyncService({
    store: senderStore,
    broker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
  });

  await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'restart duplicate' });
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  const firstReceiverStore = createEventStore({ dbPath: receiverDbPath });
  const firstReceiver = createContextSyncService({
    store: firstReceiverStore,
    broker,
    participantId: 'receiver',
    userId: 'songkai',
    sourceNodeId: 'machine-b',
    sourceBrokerId: 'broker-b',
    cwd: harness.machineB,
  });
  const first = await firstReceiver.loadContextSyncRequest(request);
  const secondReceiverStore = createEventStore({ dbPath: receiverDbPath });
  const secondReceiver = createContextSyncService({
    store: secondReceiverStore,
    broker,
    participantId: 'receiver',
    userId: 'songkai',
    sourceNodeId: 'machine-b',
    sourceBrokerId: 'broker-b',
    cwd: harness.machineB,
  });
  const second = await secondReceiver.loadContextSyncRequest(request);
  const acks = broker.readInbox('sender', { after: 0 }).items
    .filter((item) => item.kind === 'context_sync_ack');

  assert.equal(first.status, 'loaded');
  assert.equal(second.duplicate, true);
  assert.equal(acks.length, 1);
});

test('local e2e: apply rejects when receiver HEAD differs from sender base', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  await harness.makeDivergentHead();
  const { broker, sender, receiver } = createServicePair({ harness });

  await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'divergent handoff' });
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  await receiver.loadContextSyncRequest(request);

  await assert.rejects(
    () => applyVerifiedWipCommit({
      cwd: harness.machineB,
      wipCommitSha: request.payload.wipCommitSha,
      filesModified: request.payload.context.filesModified,
      expectedBaseHead: request.payload.context.gitHead,
      governanceCheck: async () => ({ ok: true }),
    }),
    /sender_receiver_head_diverged/
  );
});
