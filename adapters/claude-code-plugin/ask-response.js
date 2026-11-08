import { requestJson as requestJsonDefault } from '../session-bridge/api.js';

export const DEFAULT_POLL_MS = 500;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 120000; // 2 minutes

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForAskResponse({
  config,
  intentId,
  afterEventId = 0,
  requestJson = requestJsonDefault,
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS
}) {
  const deadline = Date.now() + timeoutMs;
  let after = Math.max(0, Number(afterEventId) - 1);
  // The intentId for ask_clarification is also the taskId
  const askTaskId = intentId;

  while (Date.now() < deadline) {
    const replay = await requestJson(`${config.brokerUrl}/events/replay?after=${after}&limit=100`);
    for (const event of replay.items || []) {
      after = Math.max(after, Number(event.eventId || event.id || 0));
      const kind = event.kind || event.type || '';

      // HexDeck uses answer_clarification for question responses
      // Match by taskId (which equals intentId for ask_clarification events)
      if (kind === 'answer_clarification') {
        const eventTaskId = event.taskId || '';
        const eventThreadId = event.threadId || '';

        // taskId and threadId of answer should match the ask's intentId (which is also taskId)
        if (eventTaskId === askTaskId || eventThreadId === askTaskId) {
          return event;
        }
      }

      // Also support respond_ask for future compatibility
      if ((kind === 'respond_ask' || kind === 'respond_clarification')) {
        const eventIntentId = event.intentId || '';
        if (eventIntentId === intentId) {
          return event;
        }
      }
    }
    await sleep(pollMs);
  }

  throw new Error(`timeout waiting for ask response ${intentId}`);
}

export function extractUserSelectionFromResponse(event) {
  const payload = event.payload || {};
  const body = payload.body || {};

  let selectedValue = null;
  let selectedValues = null;

  // answer_clarification from HexDeck puts the selected option value in body.summary
  if (typeof body.summary === 'string' && body.summary.trim()) {
    selectedValue = body.summary.trim();
  }

  // Also check other possible fields
  if (typeof body.value === 'string') {
    selectedValue = body.value;
  }
  if (Array.isArray(body.values)) {
    selectedValues = body.values;
  }
  if (typeof payload.selection === 'string') {
    selectedValue = payload.selection;
  }
  if (typeof body.option === 'string') {
    selectedValue = body.option;
  }
  if (Array.isArray(body.selectedOptions)) {
    selectedValues = body.selectedOptions;
  }

  return { selectedValue, selectedValues, summary: body.summary || payload.summary || null };
}

