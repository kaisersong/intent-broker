import { createHmac, timingSafeEqual } from 'node:crypto';
import { sharedRoomSession } from '../room/shared-service.js';

// A trusted coordinator issues these short-lived assertions after checking
// current device authorization. This key belongs only to the coordinator and
// its loopback Broker. Device credentials are never forwarded to the Broker.
export function createSharedRoomAuthenticator(secret, now = Date.now) {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error('shared_room_authority_key_invalid');
  }
  const key = Buffer.from(secret, 'hex');
  return token => {
    if (typeof token !== 'string' || token.length > 4096) return null;
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) return null;
    const [, payload, signature] = match;
    const expected = createHmac('sha256', key).update('shared-room-session.v1.' + payload).digest('base64url');
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const time = now();
      if (!Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)
        || claims.issuedAt > time || claims.expiresAt <= time || claims.expiresAt - claims.issuedAt > 30_000) return null;
      return sharedRoomSession(claims);
    } catch {
      return null;
    }
  };
}
