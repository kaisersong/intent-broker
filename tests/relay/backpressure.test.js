import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRelayBackpressure,
  selectFlushBatch,
  selectSyncResponseEvents,
} from '../../src/relay/backpressure.js';

test('relay backpressure pauses work until rate_warning resetMs expires', () => {
  let now = 1000;
  const backpressure = createRelayBackpressure({ now: () => now });

  backpressure.recordRateWarning({ resetMs: 2500 });

  assert.equal(backpressure.isPaused(), true);
  assert.equal(backpressure.remainingMs(), 2500);

  now = 3600;
  assert.equal(backpressure.isPaused(), false);
  assert.equal(backpressure.remainingMs(), 0);
});

test('selectFlushBatch trickles buffered outbound events instead of draining all at once', () => {
  const buffer = ['a', 'b', 'c', 'd'];

  const batch = selectFlushBatch(buffer, { maxBatchSize: 2 });

  assert.deepEqual(batch, ['a', 'b']);
  assert.deepEqual(buffer, ['c', 'd']);
});

test('selectSyncResponseEvents caps sync responses by event count and serialized size', () => {
  const events = Array.from({ length: 10 }, (_, index) => ({
    intentId: `intent-${index}`,
    payloadJson: {
      body: { summary: 'x'.repeat(200) },
    },
  }));

  const selected = selectSyncResponseEvents(events, {
    maxEvents: 5,
    maxBytes: 700,
  });
  const bytes = Buffer.byteLength(JSON.stringify({
    type: 'relay:sync_response',
    events: selected,
    hasMore: events.length > selected.length,
  }), 'utf8');

  assert.ok(selected.length <= 5);
  assert.ok(bytes <= 700);
  assert.deepEqual(
    selected.map((event) => event.intentId),
    ['intent-8', 'intent-9']
  );
});
