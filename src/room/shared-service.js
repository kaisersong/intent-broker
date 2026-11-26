import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ROOM_MAX_ACTIVE_AGENT_MEMBERS } from './constants.js';

export const SHARED_ROOM_PROTOCOL_VERSION = 1;
export const SHARED_ROOM_CAPABILITIES = Object.freeze([
  'shared-session-authority-v1',
  'shared-room-scope-v1',
  'exact-operation-receipt-v1',
  'room-history-snapshot-v1',
]);

const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const operations = new Set(['create', 'members', 'metadata', 'message']);
const fail = code => ({ ok: false, code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value);
const generation = value => Number.isSafeInteger(value) && value > 0;
const sequence = value => Number.isSafeInteger(value) && value >= 0;
const keysOnly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const descriptionValid = value => value === undefined || typeof value === 'string' && value.length <= 4096;
const titleValid = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 256;
const agentIdsValid = ids => Array.isArray(ids) && ids.length <= ROOM_MAX_ACTIVE_AGENT_MEMBERS
  && ids.every(id) && new Set(ids).size === ids.length;

function normalize(operation, input) {
  const revision = input?.expectedRoomRevision;
  if (operation !== 'create' && !generation(revision)) return null;
  switch (operation) {
    case 'create':
    case 'metadata': {
      const create = operation === 'create';
      const extra = create ? 'memberAgentIds' : 'expectedRoomRevision';
      if (!keysOnly(input, ['requestId', 'title', 'description', extra]) || !titleValid(input.title)
        || !descriptionValid(input.description) || create && !agentIdsValid(input.memberAgentIds)) return null;
      return { title: input.title.trim(), description: input.description ?? '',
        ...(create ? { memberAgentIds: [...input.memberAgentIds].sort() } : { expectedRoomRevision: revision }) };
    }
    case 'members': {
      if (!keysOnly(input, ['requestId', 'expectedRoomRevision', 'addAgentIds', 'removeAgentIds'])) return null;
      const { addAgentIds = [], removeAgentIds = [] } = input;
      if (!agentIdsValid(addAgentIds) || !agentIdsValid(removeAgentIds)
        || addAgentIds.some(agentId => removeAgentIds.includes(agentId))) return null;
      return { expectedRoomRevision: revision, addAgentIds: [...addAgentIds].sort(),
        removeAgentIds: [...removeAgentIds].sort() };
    }
    case 'message':
      if (!keysOnly(input, ['requestId', 'expectedRoomRevision', 'text']) || typeof input.text !== 'string'
        || !input.text.trim() || Buffer.byteLength(input.text) > 32 * 1024) return null;
      return { expectedRoomRevision: revision, text: input.text };
    default:
      return null;
  }
}

export function sharedRoomSession(authority) {
  if (!id(authority?.workspaceId) || !id(authority.principalId) || authority.principalId === 'user.local'
    || !id(authority.deviceId) || !generation(authority.deviceGeneration)
    || !generation(authority.recoveryGeneration)) return null;
  const { workspaceId, principalId, deviceId, deviceGeneration, recoveryGeneration } = authority;
  return { workspaceId, principalId, deviceId, deviceGeneration, recoveryGeneration,
    requestSource: 'user', actor: { kind: 'user', userId: principalId } };
}

export function createSharedRoomService({ store, now }) {
  const { db } = store;
  const ready = () => store.getSchemaVersion() >= 8;

  function authorize(roomId, session, owner = false) {
    const room = store.getRoomRow(roomId);
    if (!room || room.deletedAt || room.sharedWorkspaceId !== session.workspaceId) return fail('room_not_found');
    const member = store.getMember(roomId, session.actor);
    if (member?.status !== 'active') return fail('room_membership_required');
    if (owner && member.role !== 'owner') return fail('room_actor_forbidden');
    return { room, member };
  }

  function snapshot(room) {
    return { room, members: store.listMembers(room.roomId) };
  }

  function list(session) {
    return store.withTransaction(() => ({
      ok: true,
      rooms: store.listRoomSummaries(session.workspaceId).filter(room =>
        store.getMember(room.roomId, session.actor)?.status === 'active'),
    }), { readOnly: true });
  }

  function operationKey(session, roomId, operation, requestId) {
    return [session.workspaceId, session.principalId, roomId ?? session.workspaceId, operation, requestId];
  }

  const keyWhere = 'workspace_id=? AND principal_id=? AND operation_scope=? AND operation=? AND request_id=?';

  function priorOperation(key) {
    return db.prepare(`SELECT * FROM shared_room_operations WHERE ${keyWhere}`).get(...key);
  }

  function readReceipt(prior, session, requestDigest) {
    const access = authorize(prior.room_id, session);
    if (access.ok === false) return access;
    if (requestDigest && prior.request_digest !== requestDigest) return fail('shared_operation_conflict');
    if (!prior.receipt_json || prior.device_id !== session.deviceId
      || prior.device_generation !== session.deviceGeneration
      || prior.recovery_generation !== session.recoveryGeneration) {
      return fail('shared_operation_pending_verification');
    }
    return JSON.parse(prior.receipt_json);
  }

  function archiveReceipts() {
    db.prepare(`UPDATE shared_room_operations SET receipt_json=NULL
      WHERE receipt_json IS NOT NULL AND recorded_at <= ?`).run(now().getTime() - RECEIPT_RETENTION_MS);
  }

  function receipt(session, roomId, operation, requestId) {
    if (!operations.has(operation) || !id(requestId) || (operation === 'create') !== (roomId === null)) {
      return fail('room_input_invalid');
    }
    return store.withTransaction(() => {
      if (roomId !== null) {
        const access = authorize(roomId, session);
        if (access.ok === false) return access;
      }
      archiveReceipts();
      const prior = priorOperation(operationKey(session, roomId, operation, requestId));
      return prior ? readReceipt(prior, session) : fail('shared_operation_pending_verification');
    });
  }

  function newMember(roomId, subject, role, session, timestamp) {
    store.insertMember({ roomId, subject, role, status: 'active', addedBy: session.actor,
      membershipRevision: 1, addedAt: timestamp });
  }

  function create(roomId, input, session, timestamp) {
    store.insertRoom({ roomId, title: input.title, description: input.description, status: 'active',
      origin: 'user_created', createdBy: session.actor, sharedWorkspaceId: session.workspaceId,
      revision: 1, discussionEpoch: 0, createdAt: timestamp, updatedAt: timestamp });
    newMember(roomId, session.actor, 'owner', session, timestamp);
    for (const logicalAgentId of input.memberAgentIds) {
      newMember(roomId, { kind: 'agent', logicalAgentId }, 'member', session, timestamp);
    }
    return { ok: true, ...snapshot(store.getRoomRow(roomId)) };
  }

  function updateMembers(room, input, session, timestamp) {
    const { roomId } = room;
    const active = new Set(store.listMembers(roomId)
      .filter(member => member.status === 'active' && member.subject.kind === 'agent')
      .map(member => member.subject.logicalAgentId));
    for (const agentId of input.removeAgentIds) active.delete(agentId);
    for (const agentId of input.addAgentIds) active.add(agentId);
    if (active.size > ROOM_MAX_ACTIVE_AGENT_MEMBERS) return fail('room_member_limit_exceeded');

    for (const logicalAgentId of [...input.removeAgentIds, ...input.addAgentIds]) {
      const subject = { kind: 'agent', logicalAgentId };
      const current = store.getMember(roomId, subject);
      const status = active.has(logicalAgentId) ? 'active' : 'removed';
      if (!current && status === 'active') newMember(roomId, subject, 'member', session, timestamp);
      if (current && current.status !== status) {
        store.updateMember(roomId, subject, { status, membershipRevision: current.membershipRevision + 1,
          removedAt: status === 'removed' ? timestamp : null });
      }
    }
    const updated = store.updateRoom(roomId, { revision: room.revision + 1, updatedAt: timestamp });
    return { ok: true, ...snapshot(updated) };
  }

  function append(room, input, session, timestamp, key) {
    const message = {
      messageId: `rm-${randomUUID()}`, roomId: room.roomId, threadId: `thread-${room.roomId}`,
      sender: session.actor, kind: 'text', text: input.text, contextScope: { kind: 'room_only' },
      mentions: [], responsePolicy: 'none', idempotencyKey: `shared:${digest(key)}`,
      roomSequence: store.nextRoomSequence(room.roomId), discussionEpoch: room.discussionEpoch,
      createdAt: timestamp,
    };
    store.insertMessage(message);
    return { ok: true, message };
  }

  function write(session, roomId, operation, input) {
    if (!id(input?.requestId) || (operation === 'create') !== (roomId === null)) return fail('room_input_invalid');
    const normalized = normalize(operation, input);
    if (!normalized) return fail('room_input_invalid');

    const key = operationKey(session, roomId, operation, input.requestId);
    const requestDigest = digest(normalized);
    return store.withTransaction(() => {
      const access = roomId === null ? null : authorize(roomId, session);
      if (access?.ok === false) return access;
      archiveReceipts();
      const prior = priorOperation(key);
      if (prior) return readReceipt(prior, session, requestDigest);

      const room = access?.room;
      if (room && operation !== 'message' && access.member.role !== 'owner') return fail('room_actor_forbidden');
      if (room && room.status !== 'active') return fail('room_archived');
      if (room && room.revision !== normalized.expectedRoomRevision) return fail('room_revision_conflict');

      const time = now();
      const timestamp = time.toISOString();
      const targetRoomId = roomId ?? `shared-room-${randomUUID()}`;
      // The evidence and domain mutation use the same transaction. A crash can
      // never publish a Room mutation without its evidence and exact result.
      db.prepare(`INSERT INTO shared_room_operations
        (workspace_id,principal_id,operation_scope,operation,request_id,request_digest,room_id,
          device_id,device_generation,recovery_generation,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...key, requestDigest, targetRoomId, session.deviceId, session.deviceGeneration,
          session.recoveryGeneration, time.getTime());
      let result;
      switch (operation) {
        case 'create':
          result = create(targetRoomId, normalized, session, timestamp);
          break;
        case 'members':
          result = updateMembers(room, normalized, session, timestamp);
          break;
        case 'metadata': {
          const updated = store.updateRoom(roomId, { title: normalized.title, description: normalized.description,
            revision: room.revision + 1, updatedAt: timestamp });
          result = { ok: true, ...snapshot(updated) };
          break;
        }
        case 'message':
          result = append(room, normalized, session, timestamp, key);
          break;
      }
      const receiptJson = JSON.stringify(result);
      db.prepare(`UPDATE shared_room_operations SET receipt_json=? WHERE ${keyWhere}`)
        .run(receiptJson, ...key);
      return JSON.parse(receiptJson);
    });
  }

  function signCursor(payload) {
    const { secret } = db.prepare('SELECT secret FROM shared_room_cursor_key WHERE singleton=1').get();
    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  function decodeCursor(cursor, binding) {
    const parts = cursor.split('.');
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    const expected = signCursor(payload);
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, Buffer.from(expected))) return null;
    const [authorization, after, upper] = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return authorization === binding ? { after, upper } : null;
  }

  function history(session, roomId, input) {
    if (!keysOnly(input, ['afterSequence', 'limit', 'cursor'])) return fail('room_input_invalid');
    const { afterSequence, limit = 50, cursor } = input;
    if (!generation(limit) || limit > 100 || afterSequence !== undefined && !sequence(afterSequence)
      || cursor !== undefined && (afterSequence !== undefined || typeof cursor !== 'string' || cursor.length > 1024)) {
      return fail('room_input_invalid');
    }
    return store.withTransaction(() => {
      const access = authorize(roomId, session);
      if (access.ok === false) return access;
      const binding = digest([roomId, session.workspaceId, session.principalId, session.deviceId,
        session.deviceGeneration, session.recoveryGeneration, access.member.membershipRevision, access.room.revision]);
      const upper = db.prepare('SELECT last_sequence FROM room_sequences WHERE room_id=?').get(roomId)?.last_sequence ?? 0;
      const window = cursor === undefined ? { after: afterSequence ?? 0, upper } : decodeCursor(cursor, binding);
      if (!window || window.after > window.upper || window.upper > upper) return fail('shared_history_rebuild_required');

      const first = db.prepare('SELECT MIN(room_sequence) AS earliest FROM room_messages WHERE room_id=?').get(roomId);
      const earliestAvailableSequence = first.earliest;
      const messages = store.listMessages(roomId, { afterSequence: window.after,
        beforeSequence: window.upper + 1, limit: limit + 1 });
      let nextCursor = null;
      if (messages.length > limit) {
        messages.pop();
        const payload = Buffer.from(JSON.stringify([binding, messages.at(-1).roomSequence, window.upper]))
          .toString('base64url');
        nextCursor = `${payload}.${signCursor(payload)}`;
      }
      return { ok: true, ...snapshot(access.room), messages, earliestAvailableSequence,
        truncated: window.after + 1 < (earliestAvailableSequence ?? upper + 1),
        roomSequenceUpperBound: window.upper, nextCursor };
    }, { readOnly: true });
  }

  return { ready, list, receipt, write, history };
}
