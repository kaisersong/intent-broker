/**
 * TrustedActorContext verification (design §10.3).
 *
 * requestSource / actor / logicalAgentId are never payload fields. They are
 * constructed by authenticated transport sessions and handed to the room
 * service as an immutable context. This module verifies shape consistency
 * only — transport authentication itself happens before a context exists.
 */
import { ROOM_REQUEST_SOURCES, ROOM_SYSTEM_SERVICES } from './constants.js';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function verifyTrustedActorContext(ctx) {
  if (ctx === null || typeof ctx !== 'object' || Array.isArray(ctx)) {
    return { ok: false, code: 'room_authentication_required' };
  }
  if (!isNonEmptyString(ctx.sessionId)) {
    return { ok: false, code: 'room_authentication_required' };
  }
  if (!ROOM_REQUEST_SOURCES.includes(ctx.requestSource)) {
    return { ok: false, code: 'room_authentication_required' };
  }
  const actor = ctx.actor;
  if (actor === null || typeof actor !== 'object' || Array.isArray(actor)) {
    return { ok: false, code: 'room_authentication_required' };
  }
  if (!isNonEmptyString(ctx.issuedAt)) {
    return { ok: false, code: 'room_authentication_required' };
  }

  if (ctx.requestSource === 'user') {
    if (actor.kind !== 'user' || !isNonEmptyString(actor.userId)) {
      return { ok: false, code: 'room_authentication_required' };
    }
    return { ok: true };
  }

  if (ctx.requestSource === 'agent') {
    if (actor.kind !== 'agent' || !isNonEmptyString(actor.logicalAgentId)) {
      return { ok: false, code: 'room_actor_identity_mismatch' };
    }
    if (!Array.isArray(ctx.allowedLogicalAgentIds)) {
      return { ok: false, code: 'room_actor_identity_mismatch' };
    }
    if (!ctx.allowedLogicalAgentIds.includes(actor.logicalAgentId)) {
      return { ok: false, code: 'room_actor_identity_mismatch' };
    }
    return { ok: true };
  }

  // requestSource === 'system'
  if (actor.kind !== 'system' || !ROOM_SYSTEM_SERVICES.includes(actor.service)) {
    return { ok: false, code: 'room_authentication_required' };
  }
  return { ok: true };
}
