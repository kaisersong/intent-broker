import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTENT_KINDS,
} from '../../src/intent-types.js';
import {
  CONTEXT_SYNC_PAYLOAD_MAX_BYTES,
  validateBrokerIntent,
  validateIntentPayloadSize,
} from '../../src/domain/validators.js';

test('context sync request and ack are known intent kinds', () => {
  assert.equal(INTENT_KINDS.includes('context_sync_request'), true);
  assert.equal(INTENT_KINDS.includes('context_sync_ack'), true);
});

test('context sync payload validator enforces the 4KB cap', () => {
  const payload = {
    userId: 'songkai',
    context: {
      summary: 'handoff context',
    },
  };
  const accepted = validateIntentPayloadSize({
    kind: 'context_sync_request',
    payload,
  });
  assert.deepEqual(accepted, {
    ok: true,
    bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    maxBytes: CONTEXT_SYNC_PAYLOAD_MAX_BYTES,
  });

  const rejected = validateIntentPayloadSize({
    kind: 'context_sync_request',
    payload: {
      userId: 'songkai',
      context: {
        summary: 'x'.repeat(CONTEXT_SYNC_PAYLOAD_MAX_BYTES),
      },
    },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'payload_too_large');
  assert.equal(rejected.maxBytes, CONTEXT_SYNC_PAYLOAD_MAX_BYTES);
  assert.ok(rejected.bytes > CONTEXT_SYNC_PAYLOAD_MAX_BYTES);
});

test('payload size validator ignores non-context-sync intents', () => {
  const result = validateIntentPayloadSize({
    kind: 'request_task',
    payload: {
      body: {
        summary: 'x'.repeat(CONTEXT_SYNC_PAYLOAD_MAX_BYTES + 1),
      },
    },
  });

  assert.deepEqual(result, { ok: true, skipped: true });
});

test('broker intent validator rejects unknown non-opaque intent kinds', () => {
  const rejected = validateBrokerIntent({
    kind: 'made_up_kind',
    fromParticipantId: 'sender',
    to: { mode: 'participant', participants: ['receiver'] },
    payload: {},
  });

  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'intent_kind_unknown');

  const accepted = validateBrokerIntent({
    kind: 'made_up_kind',
    opaque: true,
    fromParticipantId: 'sender',
    to: { mode: 'participant', participants: ['receiver'] },
    payload: {},
  });

  assert.equal(accepted.ok, true);
});

test('context sync requests require targeted delivery and exact WIP SHA', () => {
  const base = {
    kind: 'context_sync_request',
    fromParticipantId: 'sender',
    to: { mode: 'participant', participants: ['receiver'] },
    payload: {
      syncId: 'sync-songkai-1770000000000',
      userId: 'songkai',
      sourceNodeId: 'mb',
      sourceBrokerId: 'broker-local',
      context: {
        summary: 'handoff context',
        recentUserMessages: [],
      },
      expiresAt: '2026-06-05T09:17:00.000Z',
    },
  };

  const valid = validateBrokerIntent(base, {
    now: new Date('2026-06-05T08:17:00.000Z'),
  });
  assert.equal(valid.ok, true);

  const broadcast = validateBrokerIntent({
    ...base,
    to: { mode: 'broadcast' },
  }, {
    now: new Date('2026-06-05T08:17:00.000Z'),
  });
  assert.equal(broadcast.ok, false);
  assert.equal(broadcast.error, 'context_sync_targeted_delivery_required');

  const missingSha = validateBrokerIntent({
    ...base,
    payload: {
      ...base.payload,
      wipBranch: 'wip/sync-songkai-1770000000000',
    },
  }, {
    now: new Date('2026-06-05T08:17:00.000Z'),
  });
  assert.equal(missingSha.ok, false);
  assert.equal(missingSha.error, 'context_sync_wip_commit_sha_required');
});

test('context sync requests cap recent user messages and reject unsafe refs', () => {
  const base = {
    kind: 'context_sync_request',
    fromParticipantId: 'sender',
    to: { mode: 'participant', participants: ['receiver'] },
    payload: {
      syncId: 'sync-songkai-1770000000000',
      userId: 'songkai',
      sourceNodeId: 'mb',
      sourceBrokerId: 'broker-local',
      context: {
        summary: 'handoff context',
        recentUserMessages: ['ok'],
      },
      expiresAt: '2026-06-05T09:17:00.000Z',
      wipBranch: 'wip/sync-songkai-1770000000000',
      latestRef: 'wip/sync-songkai-latest',
      wipRemote: 'origin',
      wipCommitSha: 'def456',
    },
  };

  const tooManyMessages = validateBrokerIntent({
    ...base,
    payload: {
      ...base.payload,
      context: {
        ...base.payload.context,
        recentUserMessages: ['1', '2', '3', '4', '5', '6'],
      },
    },
  }, {
    now: new Date('2026-06-05T08:17:00.000Z'),
  });
  assert.equal(tooManyMessages.ok, false);
  assert.equal(tooManyMessages.error, 'context_sync_recent_messages_too_many');

  const unsafeRef = validateBrokerIntent({
    ...base,
    payload: {
      ...base.payload,
      wipBranch: '../main',
    },
  }, {
    now: new Date('2026-06-05T08:17:00.000Z'),
  });
  assert.equal(unsafeRef.ok, false);
  assert.equal(unsafeRef.error, 'context_sync_ref_invalid');
});

test('context sync acks require load status and read-only flags', () => {
  const valid = validateBrokerIntent({
    kind: 'context_sync_ack',
    fromParticipantId: 'receiver',
    to: { mode: 'participant', participants: ['sender'] },
    payload: {
      syncId: 'sync-songkai-1770000000000',
      status: 'partial',
      wipVerified: false,
      loadedReadOnly: true,
      appliedToWorktree: false,
      failureReason: 'wip_fetch_failed',
    },
  });

  assert.equal(valid.ok, true);

  const invalid = validateBrokerIntent({
    kind: 'context_sync_ack',
    fromParticipantId: 'receiver',
    to: { mode: 'participant', participants: ['sender'] },
    payload: {
      syncId: 'sync-songkai-1770000000000',
      status: 'loaded',
      wipVerified: true,
      loadedReadOnly: false,
      appliedToWorktree: true,
    },
  });

  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'context_sync_ack_read_only_required');
});
