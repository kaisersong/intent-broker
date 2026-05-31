export const PROTOCOL_VERSION = 1;

export const RELAY_MESSAGE_TYPES = {
  // Client → Relay
  EVENT: 'relay:event',
  PING: 'relay:ping',
  BYE: 'relay:bye',
  SYNC_REQUEST: 'relay:sync_request',
  SYNC_RESPONSE: 'relay:sync_response',

  // Relay → Client
  HELLO: 'relay:hello',
  PONG: 'relay:pong',
  RATE_WARNING: 'relay:rate_warning',
  PEER_JOINED: 'relay:peer_joined',
  PEER_LEFT: 'relay:peer_left',
  VERSION_NOTICE: 'relay:version_notice',
  DRAINING: 'relay:draining',
};

export const ALLOWED_CLIENT_TYPES = new Set([
  RELAY_MESSAGE_TYPES.EVENT,
  RELAY_MESSAGE_TYPES.PING,
  RELAY_MESSAGE_TYPES.BYE,
  RELAY_MESSAGE_TYPES.SYNC_REQUEST,
  RELAY_MESSAGE_TYPES.SYNC_RESPONSE,
]);

export const MAX_MESSAGE_SIZE = 16 * 1024; // 16 KB (free tier)
export const MAX_MESSAGE_SIZE_PRO = 64 * 1024; // 64 KB (pro tier)
export const MIN_ROOM_SECRET_LENGTH = 32;
export const MAX_PEERS_PER_ROOM = 10;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000;

export const CLOSE_CODES = {
  NORMAL: 1000,
  SERVER_RESTART: 4000,
  AUTH_FAILED: 4001,
  RATE_LIMITED: 4029,
  PROTOCOL_ERROR: 4002,
  ROOM_FULL: 4003,
};

export function createEventEnvelope(payload, { protocolVersion = PROTOCOL_VERSION } = {}) {
  return {
    type: RELAY_MESSAGE_TYPES.EVENT,
    protocolVersion,
    messageId: crypto.randomUUID(),
    timestamp: Date.now(),
    payload,
  };
}

export function createPing() {
  return { type: RELAY_MESSAGE_TYPES.PING, ts: Date.now() };
}

export function createBye() {
  return { type: RELAY_MESSAGE_TYPES.BYE };
}

export function createSyncRequest(lastSeenSeq) {
  return { type: RELAY_MESSAGE_TYPES.SYNC_REQUEST, lastSeenSeq };
}

export function createSyncResponse(events, hasMore = false) {
  return { type: RELAY_MESSAGE_TYPES.SYNC_RESPONSE, events, hasMore };
}

export async function deriveRoomId(roomSecret) {
  const encoder = new TextEncoder();
  const data = encoder.encode(roomSecret);
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(data).digest('hex').slice(0, 32);
}
