/**
 * Reserved Room materialization namespace (design §9, §10.3).
 *
 * The generic intent surface (POST /intents, WS inbound, relay, session
 * bridge, KSwarm generic sender) must never materialize Room state. Any
 * intent whose kind matches ^room(_|$) or that carries a destination token
 * starting with `room:` is reserved and must be rejected with
 * ROOM_INTENT_REJECTION_CODE — even when `opaque: true` is set.
 *
 * payload.roomId / payload.primaryRoomId are audit-only fields and are
 * deliberately NOT matcher conditions.
 */

export const ROOM_INTENT_REJECTION_CODE = 'room_intent_must_use_room_service';

const ROOM_KIND_PATTERN = /^room(_|$)/;

function destinationTokens(intent) {
  const to = intent?.to;
  if (!to || !Array.isArray(to.participants)) return [];
  return to.participants;
}

export function isReservedRoomIntent(intent = {}) {
  if (typeof intent?.kind === 'string' && ROOM_KIND_PATTERN.test(intent.kind)) {
    return true;
  }
  return destinationTokens(intent).some(
    (token) => typeof token === 'string' && token.startsWith('room:')
  );
}
