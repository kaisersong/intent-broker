import { INTENT_KINDS } from '../intent-types.js';

export const CONTEXT_SYNC_PAYLOAD_MAX_BYTES = 4 * 1024;
export const MAX_RECENT_USER_MESSAGES = 5;
export const MAX_RECENT_USER_MESSAGE_CHARS = 500;
export const MAX_CONTEXT_SYNC_TTL_MS = 24 * 60 * 60 * 1000;

const CONTEXT_SYNC_INTENT_KINDS = new Set([
  'context_sync_request',
  'context_sync_ack',
]);
const KNOWN_INTENT_KINDS = new Set(INTENT_KINDS);
const ACK_STATUSES = new Set(['loaded', 'partial', 'failed']);
const SAFE_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SAFE_REMOTE_PATTERN = /^[A-Za-z0-9._-]+$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{6,64}$/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function fail(error, extra = {}) {
  return { ok: false, error, ...extra };
}

function validateTargetedDelivery(intent) {
  if (intent.to?.mode !== 'participant' || !Array.isArray(intent.to.participants) || intent.to.participants.length === 0) {
    return fail('context_sync_targeted_delivery_required');
  }
  return { ok: true };
}

function isSafeRef(value) {
  if (!isNonEmptyString(value)) return false;
  if (!SAFE_REF_PATTERN.test(value)) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  return !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function isSafeRemote(value) {
  return isNonEmptyString(value) && SAFE_REMOTE_PATTERN.test(value);
}

export function validateIntentPayloadSize(intent = {}, { maxBytes = CONTEXT_SYNC_PAYLOAD_MAX_BYTES } = {}) {
  if (!CONTEXT_SYNC_INTENT_KINDS.has(intent.kind)) {
    return { ok: true, skipped: true };
  }

  const bytes = Buffer.byteLength(JSON.stringify(intent.payload ?? {}), 'utf8');
  if (bytes > maxBytes) {
    return {
      ok: false,
      error: 'payload_too_large',
      bytes,
      maxBytes,
    };
  }

  return {
    ok: true,
    bytes,
    maxBytes,
  };
}

function validateContextSyncRequest(intent, { now = new Date() } = {}) {
  const delivery = validateTargetedDelivery(intent);
  if (!delivery.ok) return delivery;

  const size = validateIntentPayloadSize(intent);
  if (!size.ok) return size;

  const payload = intent.payload;
  if (!isPlainObject(payload)) return fail('context_sync_payload_required');
  for (const field of ['syncId', 'userId', 'sourceNodeId', 'context', 'expiresAt']) {
    if (!payload[field]) return fail(`context_sync_${field}_required`);
  }
  if (!isPlainObject(payload.context)) return fail('context_sync_context_required');

  const recentUserMessages = payload.context.recentUserMessages ?? [];
  if (!Array.isArray(recentUserMessages)) return fail('context_sync_recent_messages_invalid');
  if (recentUserMessages.length > MAX_RECENT_USER_MESSAGES) {
    return fail('context_sync_recent_messages_too_many');
  }
  for (const message of recentUserMessages) {
    if (typeof message !== 'string') return fail('context_sync_recent_message_invalid');
    if (message.length > MAX_RECENT_USER_MESSAGE_CHARS) {
      return fail('context_sync_recent_message_too_long');
    }
  }

  for (const refField of ['wipBranch', 'latestRef']) {
    const value = payload[refField];
    if (value !== undefined && value !== null && !isSafeRef(value)) {
      return fail('context_sync_ref_invalid', { field: refField });
    }
  }
  if (payload.wipRemote !== undefined && payload.wipRemote !== null && !isSafeRemote(payload.wipRemote)) {
    return fail('context_sync_ref_invalid', { field: 'wipRemote' });
  }
  if (payload.wipBranch && !payload.wipCommitSha) {
    return fail('context_sync_wip_commit_sha_required');
  }
  if (payload.wipCommitSha && !GIT_SHA_PATTERN.test(String(payload.wipCommitSha))) {
    return fail('context_sync_wip_commit_sha_invalid');
  }

  const expiresAt = new Date(payload.expiresAt);
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(expiresAt.getTime())) return fail('context_sync_expires_at_invalid');
  if (expiresAt.getTime() <= nowDate.getTime()) return fail('context_sync_expires_at_expired');
  if (expiresAt.getTime() - nowDate.getTime() > MAX_CONTEXT_SYNC_TTL_MS) {
    return fail('context_sync_expires_at_too_far');
  }

  return { ok: true };
}

function validateContextSyncAck(intent) {
  const delivery = validateTargetedDelivery(intent);
  if (!delivery.ok) return delivery;

  const size = validateIntentPayloadSize(intent);
  if (!size.ok) return size;

  const payload = intent.payload;
  if (!isPlainObject(payload)) return fail('context_sync_payload_required');
  if (!isNonEmptyString(payload.syncId)) return fail('context_sync_syncId_required');
  if (!ACK_STATUSES.has(payload.status)) return fail('context_sync_ack_status_invalid');
  if (typeof payload.wipVerified !== 'boolean') return fail('context_sync_ack_wip_verified_required');
  if (payload.loadedReadOnly !== true || payload.appliedToWorktree !== false) {
    return fail('context_sync_ack_read_only_required');
  }
  if (payload.failureReason !== undefined && payload.failureReason !== null && typeof payload.failureReason !== 'string') {
    return fail('context_sync_ack_failure_reason_invalid');
  }
  return { ok: true };
}

export function validateBrokerIntent(intent = {}, options = {}) {
  if (!isPlainObject(intent)) return fail('intent_required');
  if (!KNOWN_INTENT_KINDS.has(intent.kind)) {
    return intent.opaque === true ? { ok: true } : fail('intent_kind_unknown', { kind: intent.kind });
  }
  if (intent.kind === 'context_sync_request') {
    return validateContextSyncRequest(intent, options);
  }
  if (intent.kind === 'context_sync_ack') {
    return validateContextSyncAck(intent, options);
  }
  return { ok: true };
}
