/**
 * CollaborationRoom service (design §6, §7, §8, §10).
 *
 * Every mutation receives a TrustedActorContext and default denies. This
 * service is the single materialization gate for Room state — the generic
 * intent surface, relay, session bridges and adapters never write here.
 *
 * Permission matrix (design §10.1):
 *   create Room:          user yes | agent no | system via createRoomAllowlist scopes
 *   archive Room:         owner user yes | agent no | system no (default)
 *   add/remove member:    owner user yes | agent no | system no (default)
 *   send text message:    active user/agent member yes | system no
 *   send project_event:   system kswarm publisher scope only
 *   start team_once:      user yes | agent no | system no
 */
import { randomUUID } from 'node:crypto';
import {
  ROOM_MAX_ACTIVE_AGENT_MEMBERS,
  ROOM_WAKE_CLAIM_GRACE_MS,
  ROOM_MEMBERSHIP_LEASE_TTL_MS,
} from './constants.js';
import { verifyTrustedActorContext } from './trusted-context.js';

function fail(code, extra = {}) {
  return { ok: false, code, ...extra };
}

function recipientKeyForActor(actor) {
  if (actor.kind === 'user') return `user:${actor.userId}`;
  if (actor.kind === 'agent') return `agent:${actor.logicalAgentId}`;
  return null;
}

function nowDate(now) {
  return now instanceof Date ? now : new Date(now ?? Date.now());
}

function isoNow(now) {
  return nowDate(now).toISOString();
}

function hasScope(ctx, scope) {
  return Array.isArray(ctx?.scopes) && ctx.scopes.includes(scope);
}

export function createRoomService({
  store,
  systemCreateRoomAllowlist = [],
  listProjectBlockers = async () => ({ blockers: [] }),
  wakeClaimGraceMs = ROOM_WAKE_CLAIM_GRACE_MS,
  now = () => new Date(),
} = {}) {
  function requireVerifiedCtx(ctx) {
    const verification = verifyTrustedActorContext(ctx);
    if (!verification.ok) return verification;
    return null;
  }

  function getRoom(roomId) {
    const room = store.getRoomRow(roomId);
    if (!room) return null;
    return room;
  }

  function requireRoom(roomId) {
    return getRoom(roomId) ?? fail('room_not_found');
  }

  function activeMembers(roomId) {
    return store.listMembers(roomId).filter((m) => m.status === 'active');
  }

  function requireActiveMember(roomId, ctx) {
    const member = store.getMember(roomId, ctx.actor);
    if (!member || member.status !== 'active') {
      return fail('room_membership_required');
    }
    return null;
  }

  function requireActiveOwner(roomId, ctx) {
    const member = store.getMember(roomId, ctx.actor);
    if (!member || member.status !== 'active') {
      return fail('room_membership_required');
    }
    if (member.role !== 'owner') {
      return fail('room_actor_forbidden');
    }
    return null;
  }

  function requireActiveRoom(room) {
    if (room.status !== 'active') {
      return fail('room_archived', { status: room.status });
    }
    return null;
  }

  function snapshotWithMembers(room) {
    return { room, members: store.listMembers(room.roomId) };
  }

  function contextCurrentUser() {
    return { sessionId: 'sess-user-1', requestSource: 'user', actor: { kind: 'user', userId: 'user.local' }, allowedLogicalAgentIds: [], issuedAt: isoNow(now()) };
  }
  void contextCurrentUser;

  // ---------------------------------------------------------------- create
  function createRoom(input = {}, ctx = null) {
    const ctxError = requireVerifiedCtx(ctx);
    if (ctxError) return ctxError;

    if (ctx.requestSource === 'agent') {
      return fail('room_actor_forbidden');
    }
    if (ctx.requestSource === 'system') {
      const allowed = systemCreateRoomAllowlist.some((scope) => hasScope(ctx, scope));
      if (!allowed) return fail('room_actor_forbidden');
    }

    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) return fail('room_input_invalid', { field: 'title' });

    const memberAgentIds = Array.isArray(input.memberAgentIds) ? input.memberAgentIds : null;
    if (!memberAgentIds) return fail('room_input_invalid', { field: 'memberAgentIds' });

    const uniqueAgents = new Set(memberAgentIds);
    if (uniqueAgents.size !== memberAgentIds.length) {
      return fail('room_member_duplicate');
    }
    if (uniqueAgents.size > ROOM_MAX_ACTIVE_AGENT_MEMBERS) {
      return fail('room_member_limit_exceeded', { limit: ROOM_MAX_ACTIVE_AGENT_MEMBERS });
    }

    const origin = ctx.requestSource === 'system'
      ? (input.origin ?? 'system_recovery')
      : 'user_created';
    const timestamp = isoNow(now());
    const room = {
      roomId: `room-${randomUUID()}`,
      title,
      description: input.description,
      status: 'active',
      origin,
      createdBy: ctx.actor,
      revision: 1,
      discussionEpoch: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const members = [
      ...(ctx.requestSource === 'user'
        ? [{
            roomId: room.roomId,
            subject: ctx.actor,
            role: 'owner',
            status: 'active',
            addedBy: ctx.actor,
            membershipRevision: 1,
            addedAt: timestamp,
          }]
        : []),
      ...[...uniqueAgents].map((logicalAgentId) => ({
        roomId: room.roomId,
        subject: { kind: 'agent', logicalAgentId },
        role: 'member',
        status: 'active',
        addedBy: ctx.actor,
        membershipRevision: 1,
        addedAt: timestamp,
      })),
    ];

    if (ctx.requestSource === 'system') {
      for (const userId of input.ownerUserIds ?? []) {
        members.push({
          roomId: room.roomId,
          subject: { kind: 'user', userId },
          role: 'owner',
          status: 'active',
          addedBy: ctx.actor,
          membershipRevision: 1,
          addedAt: timestamp,
        });
      }
    }

    store.withTransaction(() => {
      store.insertRoom(room);
      for (const member of members) store.insertMember(member);
    });

    return { ok: true, ...snapshotWithMembers(room) };
  }

  // ---------------------------------------------------------------- archive
  function archiveRoom({ roomId, expectedRoomRevision } = {}, ctx = null) {
    const ctxError = requireVerifiedCtx(ctx);
    if (ctxError) return ctxError;

    const room = requireRoom(roomId);
    if (room.ok === false) return room;

    const ownerError = requireActiveOwner(roomId, ctx);
    if (ownerError) return ownerError;
    if (ctx.requestSource !== 'user') return fail('room_actor_forbidden');

    if (room.status !== 'active') {
      // archiving/archived rooms stay in their terminal settlement state
      return { ok: true, room: store.getRoomRow(roomId), members: store.listMembers(roomId) };
    }

    if (typeof expectedRoomRevision === 'number' && expectedRoomRevision !== room.revision) {
      return fail('room_revision_conflict', { expectedRoomRevision, actualRoomRevision: room.revision });
    }

    store.withTransaction(() => {
      store.updateRoom(roomId, {
        status: 'archiving',
        discussionEpoch: room.discussionEpoch + 1,
        updatedAt: isoNow(now()),
      });
      // cancel every not-yet-claimed wake obligation in the same settlement
      const messages = store.listMessages(roomId);
      for (const message of messages) {
        for (const delivery of store.listDeliveries(message.messageId)) {
          if (delivery.wakeStatus === 'pending') {
            store.updateDelivery(message.messageId, delivery.recipientKey, { wakeStatus: 'cancelled' });
          }
        }
      }
    });

    return { ok: true, room: store.getRoomRow(roomId), members: store.listMembers(roomId) };
  }

  function settleArchiveGrace({ roomId, now: nowOverride } = {}) {
    const room = requireRoom(roomId);
    if (room.ok === false) return room;
    if (room.status !== 'archiving') return { ok: true, room };

    const effectiveNow = nowDate(nowOverride ?? now());
    const claimed = store.listClaimedDeliveries(roomId);
    const unsettled = claimed.filter((delivery) => {
      if (!delivery.claimLeaseUntil) return true;
      return new Date(delivery.claimLeaseUntil).getTime() > effectiveNow.getTime();
    });

    if (unsettled.length > 0) {
      return { ok: true, room: store.getRoomRow(roomId) };
    }

    for (const delivery of claimed) {
      store.updateDelivery(delivery.roomMessageId, delivery.recipientKey, { wakeStatus: 'failed' });
      store.insertAudit({
        roomId,
        roomMessageId: delivery.roomMessageId,
        logicalAgentId: delivery.logicalRecipientId ?? delivery.recipientKey.replace(/^agent:/, ''),
        outcome: 'grace_expired',
        detail: { reason: 'archive_grace_window_expired' },
        createdAt: isoNow(effectiveNow),
      });
    }

    store.updateRoom(roomId, { status: 'archived', archivedAt: isoNow(effectiveNow), updatedAt: isoNow(effectiveNow) });
    return { ok: true, room: store.getRoomRow(roomId) };
  }

  // ---------------------------------------------------------------- members
  function updateRoomMembers({ roomId, expectedRoomRevision, addAgentIds = [], removeAgentIds = [], addUserIds = [], removeUserIds = [], roleChanges = [] } = {}, ctx = null) {
    const ctxError = requireVerifiedCtx(ctx);
    if (ctxError) return ctxError;

    const room = requireRoom(roomId);
    if (room.ok === false) return room;

    const ownerError = requireActiveOwner(roomId, ctx);
    if (ownerError) return ownerError;
    if (ctx.requestSource !== 'user') return fail('room_actor_forbidden');

    const roomStateError = requireActiveRoom(room);
    if (roomStateError) return roomStateError;

    if (typeof expectedRoomRevision === 'number' && expectedRoomRevision !== room.revision) {
      return fail('room_revision_conflict', { expectedRoomRevision, actualRoomRevision: room.revision });
    }

    // agent members can never hold the owner role
    for (const change of roleChanges) {
      if (change.role === 'owner' && change.logicalAgentId) {
        return fail('room_actor_forbidden');
      }
    }

    // last active user owner protection (removal + demotion + self-removal)
    const activeUserMembers = activeMembers(roomId).filter((m) => m.subject.kind === 'user');
    const removingUsers = new Set(removeUserIds ?? []);
    const demotingUsers = new Set(
      (roleChanges ?? []).filter((c) => c.userId && c.role && c.role !== 'owner').map((c) => c.userId)
    );
    const remainingOwners = activeUserMembers.filter(
      (m) => m.role === 'owner' && !removingUsers.has(m.subject.userId) && !demotingUsers.has(m.subject.userId)
    );
    if (remainingOwners.length === 0 && activeUserMembers.some((m) => m.role === 'owner')) {
      return fail('room_last_owner_removal_forbidden');
    }

    // duplicate member check across the combined addition set
    const combinedAgents = [...(addAgentIds ?? [])];
    const uniqueCombined = new Set(combinedAgents);
    if (uniqueCombined.size !== combinedAgents.length) {
      return fail('room_member_duplicate');
    }
    const activeAgents = activeMembers(roomId).filter((m) => m.subject.kind === 'agent');
    const existingAgentIds = new Set(activeAgents.map((m) => m.subject.logicalAgentId));
    const removingAgents = new Set(removeAgentIds ?? []);
    const projectedAgentCount =
      existingAgentIds.size - [...removingAgents].filter((id) => existingAgentIds.has(id)).length
      + [...uniqueCombined].filter((id) => !existingAgentIds.has(id)).length;
    if (projectedAgentCount > ROOM_MAX_ACTIVE_AGENT_MEMBERS) {
      return fail('room_member_limit_exceeded', { limit: ROOM_MAX_ACTIVE_AGENT_MEMBERS });
    }

    const timestamp = isoNow(now());
    store.withTransaction(() => {
      for (const logicalAgentId of addAgentIds ?? []) {
        const subject = { kind: 'agent', logicalAgentId };
        const existing = store.getMember(roomId, subject);
        if (existing) {
          store.updateMember(roomId, subject, { status: 'active', membershipRevision: existing.membershipRevision + 1 });
        } else {
          store.insertMember({
            roomId,
            subject,
            role: 'member',
            status: 'active',
            addedBy: ctx.actor,
            membershipRevision: 1,
            addedAt: timestamp,
          });
        }
      }
      for (const logicalAgentId of removeAgentIds ?? []) {
        const subject = { kind: 'agent', logicalAgentId };
        const existing = store.getMember(roomId, subject);
        if (existing && existing.status === 'active') {
          store.updateMember(roomId, subject, { status: 'pending_removal', membershipRevision: existing.membershipRevision + 1 });
        }
      }
      for (const userId of addUserIds ?? []) {
        const subject = { kind: 'user', userId };
        const existing = store.getMember(roomId, subject);
        if (existing) {
          store.updateMember(roomId, subject, { status: 'active', membershipRevision: existing.membershipRevision + 1 });
        } else {
          store.insertMember({
            roomId,
            subject,
            role: 'member',
            status: 'active',
            addedBy: ctx.actor,
            membershipRevision: 1,
            addedAt: timestamp,
          });
        }
      }
      for (const change of roleChanges ?? []) {
        if (change.userId) {
          const subject = { kind: 'user', userId: change.userId };
          const existing = store.getMember(roomId, subject);
          if (existing) {
            store.updateMember(roomId, subject, { role: change.role, membershipRevision: existing.membershipRevision + 1 });
          }
        }
      }
      store.updateRoom(roomId, { revision: room.revision + 1, updatedAt: timestamp });
    });

    return { ok: true, room: store.getRoomRow(roomId), members: store.listMembers(roomId) };
  }

  async function finalizeMemberRemovals({ roomId } = {}) {
    const room = requireRoom(roomId);
    if (room.ok === false) return room;

    const timestamp = isoNow(now());
    const members = store.listMembers(roomId);
    const pending = members.filter((m) => m.status === 'pending_removal');

    for (const member of pending) {
      if (member.subject.kind !== 'agent') continue;
      const { blockers } = await listProjectBlockers({
        roomId,
        logicalAgentId: member.subject.logicalAgentId,
      });
      if (Array.isArray(blockers) && blockers.length > 0) {
        // broker restores the member: KSwarm still depends on it
        store.updateMember(roomId, member.subject, { status: 'active' });
      } else {
        store.updateMember(roomId, member.subject, { status: 'removed', removedAt: timestamp });
      }
    }

    return { ok: true, members: store.listMembers(roomId) };
  }

  function acquireMembershipLease({ roomId, logicalAgentId, operationId } = {}, _systemContext = null) {
    const ctxError = requireVerifiedCtx(_systemContext);
    if (ctxError) return ctxError;
    if (_systemContext.requestSource !== 'system'
      || _systemContext.actor.kind !== 'system'
      || _systemContext.actor.service !== 'kswarm'
      || !hasScope(_systemContext, 'room-membership-lease')) {
      return fail('room_actor_forbidden');
    }
    const room = requireRoom(roomId);
    if (room.ok === false) return room;

    const member = store.getMember(roomId, { kind: 'agent', logicalAgentId });
    if (!member || member.status !== 'active') {
      if (member?.status === 'pending_removal') {
        return fail('room_member_removal_pending');
      }
      return fail('room_membership_required');
    }

    const timestamp = nowDate(now());
    const lease = {
      token: `lease-${roomId}-${logicalAgentId}-${operationId}-${randomUUID()}`,
      roomId,
      logicalAgentId,
      operationId,
      roomRevision: room.revision,
      expiresAt: new Date(timestamp.getTime() + ROOM_MEMBERSHIP_LEASE_TTL_MS).toISOString(),
      createdAt: timestamp.toISOString(),
    };
    store.insertLease(lease);
    return { ok: true, lease };
  }

  // ---------------------------------------------------------------- messages
  function resolveReplyScope(room, input) {
    if (!input.replyToMessageId) {
      return { scope: input.contextScope ?? { kind: 'room_only' } };
    }
    const parent = store.getMessage(room.roomId, input.replyToMessageId);
    if (!parent) {
      return { error: fail('room_message_not_found', { replyToMessageId: input.replyToMessageId }) };
    }
    const declared = input.contextScope;
    if (declared && declared.kind === 'project') {
      const parentProject = parent.contextScope?.kind === 'project' ? parent.contextScope.projectId : null;
      if (parentProject !== declared.projectId) {
        return { error: fail('room_scope_mismatch', { declared, parent: parent.contextScope }) };
      }
    }
    return { scope: parent.contextScope ?? { kind: 'room_only' } };
  }

  function buildDeliveries(room, message, senderActor, hostParticipantId) {
    const members = activeMembers(room.roomId);
    const deliveries = [];
    const mentionedAgents = new Set(
      (message.mentions ?? [])
        .filter((m) => m.kind === 'agent')
        .map((m) => m.logicalAgentId)
    );
    const mentionAll = (message.mentions ?? []).some((m) => m.kind === 'all');

    for (const member of members) {
      const recipientKey = recipientKeyForActor(member.subject);
      if (!recipientKey) continue;
      const isAgent = member.subject.kind === 'agent';
      let wakeStatus = 'not_requested';
      if (isAgent) {
        if (message.responsePolicy === 'team_once') {
          wakeStatus = 'pending';
        } else if (message.responsePolicy === 'mentioned' && (mentionAll || mentionedAgents.has(member.subject.logicalAgentId))) {
          wakeStatus = 'pending';
        }
      }
      deliveries.push({
        roomMessageId: message.messageId,
        recipientKey,
        logicalRecipientId: isAgent ? member.subject.logicalAgentId : null,
        runtimeParticipantIdSnapshot: isAgent ? hostParticipantId ?? null : null,
        visibilityStatus: 'pending',
        wakeStatus,
      });
    }
    return deliveries;
  }

  function appendMessageAtomic(room, message, deliveries) {
    store.withTransaction(() => {
      store.insertMessage(message);
      for (const delivery of deliveries) {
        store.insertDelivery(delivery);
      }
    });
  }

  function sendRoomMessage(input = {}, ctx = null) {
    const ctxError = requireVerifiedCtx(ctx);
    if (ctxError) return ctxError;

    const room = requireRoom(input.roomId);
    if (room.ok === false) return room;

    const kind = input.kind ?? 'text';

    if (ctx.requestSource === 'system') {
      const publisherAllowed = ctx.actor.kind === 'system'
        && ctx.actor.service === 'kswarm'
        && hasScope(ctx, 'room-project-event-publisher')
        && kind === 'project_event';
      if (!publisherAllowed) return fail('room_actor_forbidden');
    } else {
      const memberError = requireActiveMember(room.roomId, ctx);
      if (memberError) return memberError;
      if (kind === 'project_event') {
        // users and agents cannot forge project events
        return fail('room_actor_forbidden');
      }
      if (ctx.requestSource === 'agent' && input.responsePolicy === 'team_once') {
        return fail('room_actor_forbidden');
      }
    }

    const idempotencyKey = input.idempotencyKey;
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      return fail('room_input_invalid', { field: 'idempotencyKey' });
    }

    // identity fields are transport-layer facts, never message payload
    // fields (design §10.3) — their presence is a spoofing attempt.
    if (input.requestSource !== undefined || input.actor !== undefined || input.logicalAgentId !== undefined) {
      return fail('room_actor_identity_mismatch');
    }

    const existing = store.getMessageByIdempotency(room.roomId, idempotencyKey);
    if (existing) {
      // backfill any obligation lost to a torn write (INSERT OR IGNORE)
      const backfill = buildDeliveries(room, existing, existing.sender, ctx.hostParticipantId);
      store.withTransaction(() => {
        for (const delivery of backfill) store.insertDelivery(delivery);
      });
      return fail('room_message_duplicate', { message: existing });
    }

    const roomStateError = requireActiveRoom(room);
    if (roomStateError) return roomStateError;

    const scopeResult = resolveReplyScope(room, input);
    if (scopeResult.error) return scopeResult.error;

    const effectiveNow = nowDate(now());
    const advanceEpoch = ctx.requestSource !== 'agent';
    const message = {
      messageId: `rm-${randomUUID()}`,
      roomId: room.roomId,
      threadId: input.threadId ?? `thread-${room.roomId}`,
      sender: ctx.actor,
      kind,
      text: input.text,
      replyToMessageId: input.replyToMessageId,
      contextScope: scopeResult.scope,
      mentions: Array.isArray(input.mentions) ? input.mentions : [],
      responsePolicy: input.responsePolicy ?? 'none',
      sourceRef: input.sourceRef,
      idempotencyKey,
      roomSequence: 0,
      discussionEpoch: room.discussionEpoch + (advanceEpoch ? 1 : 0),
      createdAt: effectiveNow.toISOString(),
    };

    if (message.responsePolicy === 'mentioned' && message.kind === 'text') {
      // mentions with no policy still default to none — callers must opt in
    }

    store.withTransaction(() => {
      if (advanceEpoch) {
        store.updateRoom(room.roomId, { discussionEpoch: message.discussionEpoch, updatedAt: message.createdAt });
      }
      message.roomSequence = store.nextRoomSequence(room.roomId);
      store.insertMessage(message);
      for (const delivery of buildDeliveries(room, message, ctx.actor, ctx.hostParticipantId)) {
        store.insertDelivery(delivery);
      }
    });

    return { ok: true, message };
  }

  /**
   * design §6.2：向后兼容扩展。afterSequence/beforeSequence/limit 是可选的
   * bounded query 参数；旧调用（仅 { roomId }）保持全量物化语义。
   */
  function listRoomMessages({ roomId, afterSequence, beforeSequence, limit } = {}, ctx = null) {
    const ctxError = requireVerifiedCtx(ctx);
    if (ctxError) return ctxError;

    const room = requireRoom(roomId);
    if (room.ok === false) return room;

    const memberError = requireActiveMember(roomId, ctx);
    if (memberError) return memberError;

    const hasBounds = afterSequence !== undefined || beforeSequence !== undefined || limit !== undefined;
    if (!hasBounds) {
      return { ok: true, messages: store.listMessages(roomId) };
    }

    const messages = store.listMessages(roomId, { afterSequence, beforeSequence, limit });
    const bounds = store.getRoomSequenceBounds(roomId);
    const fromSequence = messages.length > 0 ? messages[0].roomSequence : null;
    const toSequence = messages.length > 0 ? messages[messages.length - 1].roomSequence : null;
    // design §6.2："每次 agent history page read 由 intent-broker 写独立的
    // room_history_read_audits 记录"。此前 recordRoomHistoryReadAudit 只有
    // store 层单元测试覆盖，从未被这条真实分页读取路径调用——只在真正走
    // bounded query（分页语义）时写入，不为无参数的旧全量读取产生噪音记录。
    // actorParticipantId 复用与 sendRoomMessage 等既有 mutation 相同的
    // actor→participant 映射规则（user:<userId> / agent:<logicalAgentId>），
    // 不单独造一套身份编码。
    store.recordRoomHistoryReadAudit({
      roomId,
      actorParticipantId: recipientKeyForActor(ctx.actor),
      fromSequence,
      toSequence,
      requestedLimit: limit ?? null,
      resultCount: messages.length,
    });
    return {
      ok: true,
      messages,
      totalMessages: bounds.totalMessages,
      fromSequence,
      toSequence,
      hasMoreBefore: messages.length > 0 && bounds.minSequence !== null && messages[0].roomSequence > bounds.minSequence,
      hasMoreAfter: messages.length > 0 && bounds.maxSequence !== null && messages[messages.length - 1].roomSequence < bounds.maxSequence,
    };
  }

  function getCollaborationRoom({ roomId } = {}, ctx = null) {
    const ctxError = requireVerifiedCtx(ctx);
    if (ctxError) return ctxError;

    const room = requireRoom(roomId);
    if (room.ok === false) return room;

    const systemReader = ctx.requestSource === 'system'
      && ctx.actor.kind === 'system'
      && ctx.actor.service === 'kswarm'
      && hasScope(ctx, 'room-read');
    if (!systemReader) {
      const memberError = requireActiveMember(roomId, ctx);
      if (memberError) return memberError;
    }

    return { ok: true, room, members: store.listMembers(roomId), messages: store.listMessages(roomId) };
  }

  function listCollaborationRooms(_input = {}, ctx = null) {
    const ctxError = requireVerifiedCtx(ctx);
    if (ctxError) return ctxError;
    if (ctx.requestSource !== 'user') return fail('room_actor_forbidden');

    const rooms = store.listRoomRows().filter((room) => {
      const member = store.getMember(room.roomId, ctx.actor);
      return member && member.status === 'active';
    });
    return { ok: true, rooms };
  }

  // ---------------------------------------------------------------- cursors
  function markRoomSeen({ roomId, lastSeenRoomSequence } = {}, ctx = null) {
    const ctxError = requireVerifiedCtx(ctx);
    if (ctxError) return ctxError;

    if (ctx.requestSource !== 'user') {
      // agent consumption advances via wake acks, not the UI seen API
      return fail('room_actor_identity_mismatch');
    }

    const room = requireRoom(roomId);
    if (room.ok === false) return room;

    const memberError = requireActiveMember(roomId, ctx);
    if (memberError) return memberError;

    const recipientKey = recipientKeyForActor(ctx.actor);
    const cursor = store.advanceCursor(roomId, recipientKey, Number(lastSeenRoomSequence) || 0);
    return { ok: true, cursor };
  }

  function getRecipientCursor({ roomId, recipientKey } = {}) {
    return store.getCursor(roomId, recipientKey);
  }

  // ---------------------------------------------------------------- wake claims
  /**
   * design §6.2 RoomHistoryReadCapability：agent-only、claim-token-bound 的
   * 历史分页读取，比 listRoomMessages（宽松 ctx，desktop UI 全量/分页读取）
   * 更严格。不接受 ctx——只信任 claim token 自身编码的
   * roomMessageId|logicalAgentId|discussionEpoch|leaseUntil，并要求：
   *   - token 派生的 roomId 与请求 roomId 完全一致（防止跨 Room 使用同一
   *     token）；
   *   - delivery.claimToken 精确匹配、wakeStatus==='claimed'（尚未 settle）；
   *   - member/room 处于 active 状态，且 discussion epoch 与 token 编码时
   *     完全一致——不给 grace period（这是 active execution 期间的读取，
   *     不是 completeWake 的 settlement，room_delivery_conflict/
   *     room_archived 立即拒绝，不做"lease 未到期就放行"的宽松判断）。
   */
  function listRoomMessagesPage({ claimToken, roomId, afterSequence, beforeSequence, limit } = {}) {
    if (typeof claimToken !== 'string' || !claimToken.includes('|')) {
      return fail('room_input_invalid', { field: 'claimToken' });
    }
    const [tokenRoomMessageId, tokenLogicalAgentId, tokenEpochRaw] = claimToken.split('|');

    const delivery = store.getDelivery(tokenRoomMessageId, `agent:${tokenLogicalAgentId}`);
    if (!delivery || delivery.claimToken !== claimToken) {
      return fail('room_delivery_conflict');
    }
    if (delivery.wakeStatus !== 'claimed') {
      return fail('room_delivery_conflict', { wakeStatus: delivery.wakeStatus });
    }

    const sourceMessage = store.getMessageById(tokenRoomMessageId);
    if (!sourceMessage) return fail('room_message_not_found');

    // 防止用一个 Room 的 token 读取另一个 Room 的历史：token 派生的 roomId
    // 必须与请求 roomId 完全一致，不做任何"信任请求方声明"的捷径。
    if (sourceMessage.roomId !== roomId) {
      return fail('room_actor_forbidden');
    }

    const room = store.getRoomRow(sourceMessage.roomId);
    if (!room || room.status !== 'active') {
      return fail('room_archived');
    }

    const member = store.getMember(room.roomId, { kind: 'agent', logicalAgentId: tokenLogicalAgentId });
    if (!member || member.status !== 'active') {
      return fail('room_membership_required');
    }

    const tokenEpoch = Number.parseInt(tokenEpochRaw, 10);
    if (!Number.isFinite(tokenEpoch) || tokenEpoch !== room.discussionEpoch) {
      return fail('room_delivery_conflict', { reason: 'stale_epoch' });
    }

    const messages = store.listMessages(roomId, { afterSequence, beforeSequence, limit });
    const bounds = store.getRoomSequenceBounds(roomId);
    const fromSequence = messages.length > 0 ? messages[0].roomSequence : null;
    const toSequence = messages.length > 0 ? messages[messages.length - 1].roomSequence : null;

    store.recordRoomHistoryReadAudit({
      roomId,
      actorParticipantId: `agent:${tokenLogicalAgentId}`,
      fromSequence,
      toSequence,
      requestedLimit: limit ?? null,
      resultCount: messages.length,
    });

    return {
      ok: true,
      messages,
      totalMessages: bounds.totalMessages,
      fromSequence,
      toSequence,
      hasMoreBefore: messages.length > 0 && bounds.minSequence !== null && messages[0].roomSequence > bounds.minSequence,
      hasMoreAfter: messages.length > 0 && bounds.maxSequence !== null && messages[messages.length - 1].roomSequence < bounds.maxSequence,
    };
  }

  function claimWake({ roomMessageId, logicalAgentId, hostParticipantId } = {}, ctx = null) {
    const ctxError = requireVerifiedCtx(ctx);
    if (ctxError) return ctxError;

    if (ctx.requestSource !== 'agent' || ctx.actor.logicalAgentId !== logicalAgentId) {
      return fail('room_actor_identity_mismatch');
    }

    const delivery = store.getDelivery(roomMessageId, `agent:${logicalAgentId}`);
    if (!delivery) return fail('room_not_found', { roomMessageId });

    const message = store.getMessageById(roomMessageId);
    const room = store.getRoomRow(message.roomId);

    const member = store.getMember(room.roomId, { kind: 'agent', logicalAgentId });
    if (!member || member.status !== 'active') {
      return fail('room_membership_required');
    }
    if (room.status !== 'active') {
      return fail('room_archived');
    }
    if (delivery.wakeStatus !== 'pending') {
      return fail('room_delivery_conflict', { wakeStatus: delivery.wakeStatus });
    }

    const effectiveNow = nowDate(now());
    const leaseUntil = new Date(effectiveNow.getTime() + wakeClaimGraceMs).toISOString();
    const claimToken = `${roomMessageId}|${logicalAgentId}|${message?.discussionEpoch ?? room.discussionEpoch}|${leaseUntil}`;

    store.updateDelivery(roomMessageId, `agent:${logicalAgentId}`, {
      wakeStatus: 'claimed',
      claimLeaseUntil: leaseUntil,
      claimToken,
      runtimeParticipantIdSnapshot: hostParticipantId ?? delivery.runtimeParticipantIdSnapshot,
    });

    return { ok: true, claimToken, claimLeaseUntil: leaseUntil, roomId: room.roomId };
  }

  async function completeWake({ claimToken, reply, now: nowOverride } = {}) {
    if (typeof claimToken !== 'string' || !claimToken.includes('|')) {
      return fail('room_input_invalid', { field: 'claimToken' });
    }
    const [roomMessageId, logicalAgentId, epoch, leaseUntil] = claimToken.split('|');

    const delivery = store.getDelivery(roomMessageId, `agent:${logicalAgentId}`);
    if (!delivery || delivery.claimToken !== claimToken) {
      return fail('room_delivery_conflict');
    }
    if (delivery.wakeStatus !== 'claimed') {
      return fail('room_delivery_conflict', { wakeStatus: delivery.wakeStatus });
    }

    const sourceMessage = store.getMessageById(roomMessageId);
    const room = store.getRoomRow(sourceMessage.roomId);
    const effectiveNow = nowDate(nowOverride ?? now());
    const member = store.getMember(room.roomId, { kind: 'agent', logicalAgentId });
    const activeExecutionContext = room.status === 'active' && member?.status === 'active';
    const claimEpoch = Number.parseInt(epoch, 10);

    if (activeExecutionContext && Number.isFinite(claimEpoch) && claimEpoch !== room.discussionEpoch) {
      store.withTransaction(() => {
        store.updateDelivery(roomMessageId, delivery.recipientKey, { wakeStatus: 'failed' });
        store.insertAudit({
          roomId: sourceMessage.roomId,
          roomMessageId,
          logicalAgentId,
          outcome: 'stale_epoch',
          detail: {
            replyText: reply?.text ?? null,
            claimEpoch,
            currentEpoch: room.discussionEpoch,
            reason: 'discussion_epoch_advanced',
          },
          createdAt: effectiveNow.toISOString(),
        });
      });
      return fail('room_delivery_conflict', { settled: 'stale_epoch' });
    }

    if (!activeExecutionContext && new Date(leaseUntil).getTime() < effectiveNow.getTime()) {
      // The fixed lease is a settlement grace deadline after archive/removal,
      // not an execution timeout for an otherwise active room member.
      store.withTransaction(() => {
        store.updateDelivery(roomMessageId, delivery.recipientKey, { wakeStatus: 'failed' });
        store.insertAudit({
          roomId: sourceMessage.roomId,
          roomMessageId,
          logicalAgentId,
          outcome: 'grace_expired',
          detail: { replyText: reply?.text ?? null, reason: 'claim_lease_expired' },
          createdAt: effectiveNow.toISOString(),
        });
      });
      return fail('room_archived', { settled: 'grace_expired' });
    }

    const agentActor = { kind: 'agent', logicalAgentId };
    const timestamp = effectiveNow.toISOString();
    const replyMessage = {
      messageId: `rm-${randomUUID()}`,
      roomId: sourceMessage.roomId,
      threadId: `thread-${sourceMessage.roomId}`,
      sender: agentActor,
      kind: reply?.kind === 'pass' ? 'system' : 'text',
      text: reply?.kind === 'pass' ? undefined : reply?.text,
      contextScope: undefined,
      mentions: [],
      responsePolicy: 'none',
      idempotencyKey: `wake:${claimToken}`,
      roomSequence: 0,
      discussionEpoch: Number.isFinite(claimEpoch) ? claimEpoch : room.discussionEpoch,
      createdAt: timestamp,
    };

    store.withTransaction(() => {
      replyMessage.roomSequence = store.nextRoomSequence(sourceMessage.roomId);
      store.insertMessage(replyMessage);
      for (const member of activeMembers(sourceMessage.roomId)) {
        const recipientKey = recipientKeyForActor(member.subject);
        if (!recipientKey) continue;
        store.insertDelivery({
          roomMessageId: replyMessage.messageId,
          recipientKey,
          logicalRecipientId: member.subject.kind === 'agent' ? member.subject.logicalAgentId : null,
          visibilityStatus: 'pending',
          wakeStatus: 'not_requested',
        });
      }
      store.updateDelivery(roomMessageId, delivery.recipientKey, { wakeStatus: 'completed' });
    });

    return { ok: true, message: replyMessage };
  }

  function listPendingWakeObligations({ logicalAgentId } = {}) {
    const deliveries = store.listDeliveriesByRecipient({
      recipientKey: `agent:${logicalAgentId}`,
      wakeStatus: 'pending',
    });
    const obligations = deliveries
      .map((delivery) => {
        const message = store.getMessageById(delivery.roomMessageId);
        if (!message) return null;
        const room = store.getRoomRow(message.roomId);
        if (room && room.status !== 'active') return null;
        return { roomMessageId: delivery.roomMessageId, roomId: message.roomId, roomSequence: message.roomSequence };
      })
      .filter(Boolean);
    return { ok: true, obligations };
  }

  function listDeliveries({ roomMessageId } = {}) {
    return store.listDeliveries(roomMessageId);
  }

  function listExecutionAudit({ roomId } = {}) {
    return { ok: true, entries: store.listAudit(roomId) };
  }

  // ---------------------------------------------------------------- discussion
  function startTeamDiscussion({ roomId, topic, expectedRoomRevision } = {}, ctx = null) {
    const ctxError = requireVerifiedCtx(ctx);
    if (ctxError) return ctxError;
    if (ctx.requestSource !== 'user') return fail('room_actor_forbidden');

    const result = sendRoomMessage({
      roomId,
      text: topic ?? '团队讨论',
      responsePolicy: 'team_once',
      idempotencyKey: `discussion:${expectedRoomRevision ?? 'x'}:${randomUUID()}`,
    }, ctx);
    if (result.ok === false) return result;
    return { ok: true, discussion: { roomId, causationMessageId: result.message.messageId } };
  }

  function getDiscussionEpoch({ roomId } = {}) {
    const room = store.getRoomRow(roomId);
    return room?.discussionEpoch ?? 0;
  }

  async function sweepRuntimePresence() {
    // presence sweeps manage runtime transport addresses only; logical room
    // obligations are durable and intentionally untouched (design §6.3).
    return { ok: true };
  }

  function close() {
    store.close();
  }

  return {
    createRoom,
    archiveRoom,
    settleArchiveGrace,
    updateRoomMembers,
    finalizeMemberRemovals,
    acquireMembershipLease,
    sendRoomMessage,
    listRoomMessages,
    listRoomMessagesPage,
    getCollaborationRoom,
    listCollaborationRooms,
    markRoomSeen,
    getRecipientCursor,
    claimWake,
    completeWake,
    listPendingWakeObligations,
    listDeliveries,
    listExecutionAudit,
    startTeamDiscussion,
    getDiscussionEpoch,
    sweepRuntimePresence,
    close,
  };
}
