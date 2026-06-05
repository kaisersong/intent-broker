import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerService } from '../../src/broker/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

test('broker rejects oversized context sync request payloads before storage', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });

  assert.throws(() => {
    broker.sendIntent({
      intentId: 'oversized-sync',
      kind: 'context_sync_request',
      fromParticipantId: 'sender',
      taskId: null,
      threadId: 'context-sync-songkai',
      to: { mode: 'participant', participants: ['receiver'] },
      payload: {
        userId: 'songkai',
        context: {
          summary: 'x'.repeat(5000),
        },
      },
    });
  }, /payload_too_large/);

  assert.equal(
    broker.readInbox('receiver', { after: 0, kind: 'context_sync_request' }).items.length,
    0
  );
});

test('broker invokes optional offline context sync emitter from presence updates', () => {
  const calls = [];
  const broker = createBrokerService({
    dbPath: createTempDbPath(),
    offlineContextSyncEmitter: (event) => {
      calls.push(event);
    },
  });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });

  broker.updatePresence('sender', 'offline', { reason: 'parent-exit' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].participantId, 'sender');
  assert.equal(calls[0].metadata.reason, 'parent-exit');
  assert.equal(typeof calls[0].sendIntent, 'function');
});

test('context sync delivery metadata records explicit target participants for relay routing', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });

  broker.sendIntent({
    intentId: 'sync-songkai-targeted',
    kind: 'context_sync_request',
    fromParticipantId: 'sender',
    taskId: null,
    threadId: 'context-sync-songkai',
    to: { mode: 'participant', participants: ['receiver'] },
    payload: {
      syncId: 'sync-songkai-targeted',
      userId: 'songkai',
      sourceNodeId: 'mb',
      sourceBrokerId: 'broker-local',
      context: {
        summary: 'handoff context',
        recentUserMessages: [],
      },
      wipBranch: null,
      latestRef: null,
      wipCommitSha: null,
      wipRemote: null,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    },
  });

  const event = broker.readInbox('receiver', { after: 0, kind: 'context_sync_request' }).items[0];

  assert.deepEqual(event.payload.delivery.targetParticipantIds, ['receiver']);
});

test('offline context sync emitter failure does not block presence updates', () => {
  const broker = createBrokerService({
    dbPath: createTempDbPath(),
    offlineContextSyncEmitter: () => {
      throw new Error('offline emit failed');
    },
  });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });

  const presence = broker.updatePresence('sender', 'offline', { reason: 'parent-exit' });

  assert.equal(presence.status, 'offline');
});
