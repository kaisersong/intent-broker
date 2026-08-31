/**
 * Room message delivery semantics (design §6.3, §7.1, §16.1).
 *
 * RED until Phase 1 implementation lands.
 *
 * Invariants under test:
 *   - message + delivery obligations are written atomically; a replayed
 *     idempotency key backfills missing obligations instead of skipping.
 *   - every logical agent member gets its own delivery row even when several
 *     logical agents share one runtime participant (xiaok-desktop host).
 *   - visibility ("seen") and wake ("execute") are separate states with
 *     separate acks; user seen cursors never touch agent wake, and agent
 *     acks never touch the owner's unread state.
 *   - responsePolicy none/mentioned map to distinct wake obligations.
 *   - reply contextScope is inherited from the parent message by the broker,
 *     ignoring caller-supplied scope; cross-room or scope-inconsistent
 *     replies are rejected.
 *   - roomSequence is monotonically increasing per room.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { createRoomStore } from '../../src/room/store.js';
import { createRoomService } from '../../src/room/service.js';

function userCtx() {
  return {
    sessionId: 'sess-user-1',
    requestSource: 'user',
    actor: { kind: 'user', userId: 'user.local' },
    allowedLogicalAgentIds: [],
    issuedAt: new Date().toISOString(),
  };
}

function agentCtx(logicalAgentId) {
  return {
    sessionId: 'sess-agent-1',
    requestSource: 'agent',
    actor: { kind: 'agent', logicalAgentId },
    hostParticipantId: 'xiaok-desktop',
    allowedLogicalAgentIds: [logicalAgentId],
    issuedAt: new Date().toISOString(),
  };
}

function createService(overrides = {}) {
  const dbPath = createTempDbPath();
  const store = createRoomStore({ dbPath });
  store.migrate();
  const service = createRoomService({ store, ...overrides });
  return { service, dbPath, store };
}

async function createRoom(service, memberAgentIds) {
  const result = service.createRoom(
    { title: 'Room', memberAgentIds, clientRequestKey: `crk-${Math.random()}` },
    userCtx()
  );
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

function sendMessage(service, room, input) {
  const result = service.sendRoomMessage(
    {
      roomId: room.roomId,
      text: input.text ?? 'text',
      responsePolicy: input.responsePolicy ?? 'none',
      idempotencyKey: input.idempotencyKey ?? `im-${Math.random()}`,
      ...input,
    },
    input.ctx ?? userCtx()
  );
  assert.ok(result.ok, JSON.stringify(result));
  return result;
}

test('responsePolicy none delivers visibility to all active members but wakes nobody', async () => {
  const { service } = createService();
  const created = await createRoom(service, ['agent-alpha', 'agent-beta']);

  const sent = sendMessage(service, created.room, {
    text: 'just fyi',
    responsePolicy: 'none',
    idempotencyKey: 'im-none-1',
  });

  const deliveries = service.listDeliveries({ roomMessageId: sent.message.messageId });
  const keys = deliveries.map((d) => d.recipientKey).sort();
  assert.deepEqual(keys, ['agent:agent-alpha', 'agent:agent-beta', 'user:user.local']);

  for (const delivery of deliveries) {
    assert.equal(delivery.wakeStatus, 'not_requested');
  }
});

test('responsePolicy mentioned wakes only the explicitly mentioned agents', async () => {
  const { service } = createService();
  const created = await createRoom(service, ['agent-alpha', 'agent-beta']);

  const sent = sendMessage(service, created.room, {
    text: '@agent-alpha please look',
    mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
    responsePolicy: 'mentioned',
    idempotencyKey: 'im-mention-1',
  });

  const deliveries = service.listDeliveries({ roomMessageId: sent.message.messageId });
  const byKey = Object.fromEntries(deliveries.map((d) => [d.recipientKey, d]));
  assert.equal(byKey['agent:agent-alpha'].wakeStatus, 'pending');
  assert.equal(byKey['agent:agent-beta'].wakeStatus, 'not_requested');
  assert.equal(byKey['user:user.local'].wakeStatus, 'not_requested');
});

test('mention of @all maps to every executable member', async () => {
  const { service } = createService();
  const created = await createRoom(service, ['agent-alpha', 'agent-beta']);

  const sent = sendMessage(service, created.room, {
    text: '@all status?',
    mentions: [{ kind: 'all' }],
    responsePolicy: 'mentioned',
    idempotencyKey: 'im-all-1',
  });

  const deliveries = service.listDeliveries({ roomMessageId: sent.message.messageId });
  for (const delivery of deliveries.filter((d) => d.recipientKey.startsWith('agent:'))) {
    assert.equal(delivery.wakeStatus, 'pending');
  }
});

test('agents cannot upgrade their own message to team_once', async () => {
  const { service } = createService();
  const created = await createRoom(service, ['agent-alpha']);

  const attempt = service.sendRoomMessage(
    {
      roomId: created.room.roomId,
      text: 'everyone discuss',
      responsePolicy: 'team_once',
      idempotencyKey: 'im-agent-team-1',
    },
    agentCtx('agent-alpha')
  );
  assert.equal(attempt.ok, false);
  assert.equal(attempt.code, 'room_actor_forbidden');
});

test('duplicate idempotencyKey returns the original message without duplicating it', async () => {
  const { service } = createService();
  const created = await createRoom(service, ['agent-alpha']);

  const first = sendMessage(service, created.room, { idempotencyKey: 'im-dup-1', text: 'once' });
  const second = service.sendRoomMessage(
    {
      roomId: created.room.roomId,
      text: 'once again',
      responsePolicy: 'none',
      idempotencyKey: 'im-dup-1',
    },
    userCtx()
  );

  assert.equal(second.ok, false);
  assert.equal(second.code, 'room_message_duplicate');

  const messages = service.listRoomMessages({ roomId: created.room.roomId }, userCtx());
  const withText = messages.messages.filter((m) => m.text === 'once again');
  assert.equal(withText.length, 0);
  assert.equal(first.message.messageId, messages.messages.at(-1).messageId);
});

test('a replayed idempotency key backfills obligations lost to an injected partial failure', async () => {
  const { service, dbPath } = createService();
  const created = await createRoom(service, ['agent-alpha', 'agent-beta']);

  const sent = sendMessage(service, created.room, {
    idempotencyKey: 'im-backfill-1',
    mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
    responsePolicy: 'mentioned',
  });

  // fault injection: simulate a torn write by deleting one obligation row
  const db = new DatabaseSync(dbPath);
  db.prepare('DELETE FROM room_message_deliveries WHERE room_message_id = ? AND recipient_key = ?')
    .run(sent.message.messageId, 'agent:agent-beta');
  db.close();

  // the replay with the same key must repair the obligation set (INSERT OR IGNORE semantics)
  const replay = service.sendRoomMessage(
    {
      roomId: created.room.roomId,
      text: 'replayed',
      responsePolicy: 'mentioned',
      idempotencyKey: 'im-backfill-1',
    },
    userCtx()
  );

  const deliveries = service.listDeliveries({ roomMessageId: sent.message.messageId });
  const keys = deliveries.map((d) => d.recipientKey).sort();
  assert.deepEqual(keys, ['agent:agent-alpha', 'agent:agent-beta', 'user:user.local']);

  // replay either reports the duplicate or the backfilled success, but the
  // message itself is never duplicated
  const messages = service.listRoomMessages({ roomId: created.room.roomId }, userCtx());
  assert.equal(messages.messages.filter((m) => m.idempotencyKey === 'im-backfill-1').length, 1);
  assert.ok(replay.ok || replay.code === 'room_message_duplicate');
});

test('logical agents sharing one runtime participant keep separate deliveries, acks and cursors', async () => {
  const { service } = createService();
  // both logical agents are hosted under the same xiaok-desktop participant
  const created = await createRoom(service, ['logical-po', 'logical-worker']);

  const sent = sendMessage(service, created.room, {
    mentions: [{ kind: 'all' }],
    responsePolicy: 'mentioned',
    idempotencyKey: 'im-shared-1',
  });

  const deliveries = service.listDeliveries({ roomMessageId: sent.message.messageId });
  const agentDeliveries = deliveries.filter((d) => d.recipientKey.startsWith('agent:'));
  assert.equal(agentDeliveries.length, 2);
  assert.deepEqual(
    agentDeliveries.map((d) => d.recipientKey).sort(),
    ['agent:logical-po', 'agent:logical-worker']
  );

  // the PO agent acks its wake; the worker obligation must be untouched
  const poWake = service.claimWake(
    { roomMessageId: sent.message.messageId, logicalAgentId: 'logical-po', hostParticipantId: 'xiaok-desktop' },
    agentCtx('logical-po')
  );
  assert.ok(poWake.ok, JSON.stringify(poWake));

  await service.completeWake({
    claimToken: poWake.claimToken,
    reply: { kind: 'text', text: 'po done' },
  });

  const after = service.listDeliveries({ roomMessageId: sent.message.messageId });
  const po = after.find((d) => d.recipientKey === 'agent:logical-po');
  const worker = after.find((d) => d.recipientKey === 'agent:logical-worker');
  assert.equal(po.wakeStatus, 'completed');
  assert.equal(worker.wakeStatus, 'pending');
});

test('active room accepts a claimed reply after the claim lease time when the discussion epoch is unchanged', async () => {
  const { service } = createService({
    now: () => new Date('2026-08-30T00:00:00Z'),
    wakeClaimGraceMs: 60_000,
  });
  const created = await createRoom(service, ['agent-alpha']);
  const sent = sendMessage(service, created.room, {
    text: '@agent-alpha perform a long bounded analysis',
    mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
    responsePolicy: 'mentioned',
    idempotencyKey: 'im-active-long-1',
  });
  const claim = service.claimWake(
    { roomMessageId: sent.message.messageId, logicalAgentId: 'agent-alpha', hostParticipantId: 'xiaok-desktop' },
    agentCtx('agent-alpha')
  );
  assert.ok(claim.ok, JSON.stringify(claim));

  const completed = await service.completeWake({
    claimToken: claim.claimToken,
    reply: { kind: 'text', text: 'long analysis completed' },
    now: new Date('2026-08-30T00:02:00Z'),
  });

  assert.ok(completed.ok, JSON.stringify(completed));
  const messages = service.listRoomMessages({ roomId: created.room.roomId }, userCtx());
  assert.equal(messages.messages.filter((message) => message.text === 'long analysis completed').length, 1);
  const delivery = service.listDeliveries({ roomMessageId: sent.message.messageId })
    .find((entry) => entry.recipientKey === 'agent:agent-alpha');
  assert.equal(delivery.wakeStatus, 'completed');
  assert.equal(service.listExecutionAudit({ roomId: created.room.roomId }).entries.length, 0);
});

test('active room rejects a claimed reply from a stale discussion epoch and records it once', async () => {
  const { service } = createService({
    now: () => new Date('2026-08-30T00:00:00Z'),
    wakeClaimGraceMs: 60_000,
  });
  const created = await createRoom(service, ['agent-alpha']);
  const sent = sendMessage(service, created.room, {
    text: '@agent-alpha analyze turn one',
    mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
    responsePolicy: 'mentioned',
    idempotencyKey: 'im-stale-epoch-1',
  });
  const claim = service.claimWake(
    { roomMessageId: sent.message.messageId, logicalAgentId: 'agent-alpha', hostParticipantId: 'xiaok-desktop' },
    agentCtx('agent-alpha')
  );
  assert.ok(claim.ok, JSON.stringify(claim));

  sendMessage(service, created.room, {
    text: 'turn two supersedes the old run',
    responsePolicy: 'none',
    idempotencyKey: 'im-stale-epoch-2',
  });

  const stale = await service.completeWake({
    claimToken: claim.claimToken,
    reply: { kind: 'text', text: 'stale turn one output' },
    now: new Date('2026-08-30T00:00:30Z'),
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'room_delivery_conflict');
  assert.equal(stale.settled, 'stale_epoch');

  const messages = service.listRoomMessages({ roomId: created.room.roomId }, userCtx());
  assert.equal(messages.messages.filter((message) => message.text === 'stale turn one output').length, 0);
  const audit = service.listExecutionAudit({ roomId: created.room.roomId }).entries;
  assert.equal(audit.filter((entry) => entry.outcome === 'stale_epoch').length, 1);

  const duplicate = await service.completeWake({
    claimToken: claim.claimToken,
    reply: { kind: 'text', text: 'stale turn one output again' },
    now: new Date('2026-08-30T00:00:40Z'),
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'room_delivery_conflict');
  assert.equal(service.listExecutionAudit({ roomId: created.room.roomId }).entries.length, 1);
});

test('user seen cursor does not affect agent wake cursors and vice versa', async () => {
  const { service } = createService();
  const created = await createRoom(service, ['agent-alpha']);

  const first = sendMessage(service, created.room, { idempotencyKey: 'im-cursor-1' });
  const second = sendMessage(service, created.room, {
    idempotencyKey: 'im-cursor-2',
    mentions: [{ kind: 'agent', logicalAgentId: 'agent-alpha' }],
    responsePolicy: 'mentioned',
  });

  // owner marks the room seen through the first message only
  const seen = service.markRoomSeen(
    { roomId: created.room.roomId, lastSeenRoomSequence: first.message.roomSequence },
    userCtx()
  );
  assert.ok(seen.ok, JSON.stringify(seen));

  const userCursor = service.getRecipientCursor({ roomId: created.room.roomId, recipientKey: 'user:user.local' });
  const agentCursor = service.getRecipientCursor({ roomId: created.room.roomId, recipientKey: 'agent:agent-alpha' });
  assert.equal(userCursor.lastSeenRoomSequence, first.message.roomSequence);
  assert.equal(agentCursor.lastSeenRoomSequence, 0, 'agent cursor must not move on user seen');

  // the agent wake for the second message is still pending
  const deliveries = service.listDeliveries({ roomMessageId: second.message.messageId });
  assert.equal(deliveries.find((d) => d.recipientKey === 'agent:agent-alpha').wakeStatus, 'pending');

  // agent acking its wake does not move the owner unread cursor
  const wake = service.claimWake(
    { roomMessageId: second.message.messageId, logicalAgentId: 'agent-alpha', hostParticipantId: 'xiaok-desktop' },
    agentCtx('agent-alpha')
  );
  assert.ok(wake.ok);
  await service.completeWake({ claimToken: wake.claimToken, reply: { kind: 'text', text: 'done' } });

  const userCursorAfter = service.getRecipientCursor({ roomId: created.room.roomId, recipientKey: 'user:user.local' });
  assert.equal(userCursorAfter.lastSeenRoomSequence, first.message.roomSequence);
});

test('recipient cursors can only be advanced by the matching trusted recipient', async () => {
  const { service } = createService();
  const created = await createRoom(service, ['agent-alpha']);

  const sent = sendMessage(service, created.room, { idempotencyKey: 'im-cursor-guard-1' });

  // an agent ctx cannot advance the user cursor
  const attempt = service.markRoomSeen(
    { roomId: created.room.roomId, lastSeenRoomSequence: sent.message.roomSequence },
    agentCtx('agent-alpha')
  );
  assert.equal(attempt.ok, false);
  assert.equal(attempt.code, 'room_actor_identity_mismatch');

  const cursor = service.getRecipientCursor({ roomId: created.room.roomId, recipientKey: 'user:user.local' });
  assert.equal(cursor.lastSeenRoomSequence, 0);
});

test('reply contextScope is inherited from the parent message, ignoring caller scope', async () => {
  const { service } = createService();
  const created = await createRoom(service, ['agent-alpha']);

  const parent = sendMessage(service, created.room, {
    idempotencyKey: 'im-parent-1',
    contextScope: { kind: 'project', projectId: 'proj-1' },
  });

  const reply = service.sendRoomMessage(
    {
      roomId: created.room.roomId,
      replyToMessageId: parent.message.messageId,
      text: 'reply with forged scope',
      contextScope: { kind: 'room_only' }, // caller-supplied scope must be ignored
      responsePolicy: 'none',
      idempotencyKey: 'im-reply-1',
    },
    userCtx()
  );
  assert.ok(reply.ok, JSON.stringify(reply));
  assert.deepEqual(reply.message.contextScope, { kind: 'project', projectId: 'proj-1' });
});

test('replies to a parent in another room or with inconsistent scope are rejected', async () => {
  const { service } = createService();
  const roomA = (await createRoom(service, ['agent-alpha'])).room;
  const roomB = (await createRoom(service, ['agent-beta'])).room;

  const parentInA = sendMessage(service, roomA, { idempotencyKey: 'im-cross-1' });

  const crossRoom = service.sendRoomMessage(
    {
      roomId: roomB.roomId,
      replyToMessageId: parentInA.message.messageId,
      text: 'cross room reply',
      responsePolicy: 'none',
      idempotencyKey: 'im-cross-2',
    },
    userCtx()
  );
  assert.equal(crossRoom.ok, false);

  // scope-inconsistent reply inside the same room: parent is room_only,
  // caller claims a different project scope
  const roomOnlyParent = sendMessage(service, roomB, { idempotencyKey: 'im-cross-3' });
  const inconsistent = service.sendRoomMessage(
    {
      roomId: roomB.roomId,
      replyToMessageId: roomOnlyParent.message.messageId,
      text: 'scope inconsistent reply',
      contextScope: { kind: 'project', projectId: 'proj-9' },
      responsePolicy: 'none',
      idempotencyKey: 'im-cross-4',
    },
    userCtx()
  );
  assert.equal(inconsistent.ok, false);
});

test('roomSequence increases strictly with each persisted message', async () => {
  const { service } = createService();
  const created = await createRoom(service, ['agent-alpha']);

  const sequences = [];
  for (let i = 0; i < 4; i += 1) {
    const sent = sendMessage(service, created.room, { idempotencyKey: `im-seq-${i}` });
    sequences.push(sent.message.roomSequence);
  }

  for (let i = 1; i < sequences.length; i += 1) {
    assert.ok(sequences[i] > sequences[i - 1], `sequence must strictly increase: ${sequences}`);
  }
});
