export const DEFAULT_FLUSH_BATCH_SIZE = 10;
export const DEFAULT_SYNC_RESPONSE_EVENT_LIMIT = 25;
export const DEFAULT_SYNC_RESPONSE_MAX_BYTES = 12 * 1024;

export function createRelayBackpressure({ now = () => Date.now() } = {}) {
  let pausedUntil = 0;

  return {
    recordRateWarning({ resetMs = 0 } = {}) {
      const reset = Number(resetMs);
      if (Number.isFinite(reset) && reset > 0) {
        pausedUntil = Math.max(pausedUntil, now() + reset);
      }
      return pausedUntil;
    },
    isPaused() {
      return now() < pausedUntil;
    },
    remainingMs() {
      return Math.max(0, pausedUntil - now());
    },
  };
}

export function selectFlushBatch(buffer, { maxBatchSize = DEFAULT_FLUSH_BATCH_SIZE } = {}) {
  const batchSize = Math.max(1, Number(maxBatchSize) || DEFAULT_FLUSH_BATCH_SIZE);
  return buffer.splice(0, batchSize);
}

export function selectSyncResponseEvents(
  events,
  {
    maxEvents = DEFAULT_SYNC_RESPONSE_EVENT_LIMIT,
    maxBytes = DEFAULT_SYNC_RESPONSE_MAX_BYTES,
  } = {}
) {
  let selected = events.slice(-maxEvents);
  while (selected.length > 0) {
    const bytes = Buffer.byteLength(JSON.stringify({
      type: 'relay:sync_response',
      events: selected,
      hasMore: events.length > selected.length,
    }), 'utf8');
    if (bytes <= maxBytes) {
      return selected;
    }
    selected = selected.slice(1);
  }
  return selected;
}
