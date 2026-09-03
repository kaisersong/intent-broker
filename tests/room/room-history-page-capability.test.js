/**
 * listRoomMessagesPage — agent-only claim-token-bound 历史分页读取
 * （design §6.2 RoomHistoryReadCapability）。
 *
 * 现状核实（2026-09-02）：Desktop
 * collaboration-room-broker-client.ts:listRoomMessagesPage 此前只是转发到
 * 通用的 GET /rooms/:roomId/messages（走宽松的 desktop-main-user/
 * kswarm-system ctx 鉴权），完全没有实现设计文档要求的"claim token 派生
 * roomId 并与请求绑定 roomId 比较，再核对 exact delivery token、
 * wakeStatus='claimed'、active member/room 和 current discussion epoch"。
 * agent 侧读历史的权限边界与 desktop 全量 UI 读取完全没有区分。
 *
 * 本文件驱动新增 service.js:listRoomMessagesPage(claimToken, {roomId, ...})：
 * 只接受 claim token（不接受宽松 ctx），比 completeWake 更严格
 * （member/room 失效或 epoch 变化立即拒绝，不给 grace period，因为这是
 * active execution 期间的读取，不是settlement）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
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
    sessionId: `sess-agent-${logicalAgentId}`,
    requestSource: 'agent',
    actor: { kind: 'agent', logicalAgentId },
    allowedLogicalAgentIds: [logicalAgentId],
    issuedAt: new Date().toISOString(),
  };
}

function setup() {
  const store = createRoomStore({ dbPath: createTempDbPath() });
  store.migrate();
  const service = createRoomService({ store });
  return { store, service };
}

function createRoomAndClaim(service, logicalAgentId = 'agent-alpha') {
  const room = service.createRoom(
    { title: 'claim 分页测试', memberAgentIds: [logicalAgentId], clientRequestKey: `crk-${Math.random()}` },
    userCtx(),
  );
  assert.ok(room.ok, JSON.stringify(room));

  for (let i = 0; i < 5; i += 1) {
    const sent = service.sendRoomMessage(
      { roomId: room.room.roomId, text: `msg-${i}`, responsePolicy: 'none', idempotencyKey: `im-claim-${i}-${Math.random()}` },
      userCtx(),
    );
    assert.ok(sent.ok, JSON.stringify(sent));
  }

  const wakeMessage = service.sendRoomMessage(
    {
      roomId: room.room.roomId,
      text: `@${logicalAgentId} 请处理`,
      mentions: [{ kind: 'agent', logicalAgentId }],
      responsePolicy: 'mentioned',
      idempotencyKey: `im-wake-${Math.random()}`,
    },
    userCtx(),
  );
  assert.ok(wakeMessage.ok, JSON.stringify(wakeMessage));

  const claim = service.claimWake(
    { roomMessageId: wakeMessage.message.messageId, logicalAgentId, hostParticipantId: 'xiaok-desktop' },
    agentCtx(logicalAgentId),
  );
  assert.ok(claim.ok, JSON.stringify(claim));
  return { room: room.room, claim };
}

test('持有合法 claim token 的 agent 可以分页读取该 Room 的历史', () => {
  const { service } = setup();
  const { room, claim } = createRoomAndClaim(service);

  const result = service.listRoomMessagesPage({ claimToken: claim.claimToken, roomId: room.roomId, limit: 3 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.messages));
  assert.ok(result.messages.length <= 3);
});

test('claim token 派生的 roomId 与请求 roomId 不一致时拒绝（防止用一个 Room 的 token 读取另一个 Room）', () => {
  const { service } = setup();
  const { claim } = createRoomAndClaim(service, 'agent-alpha');

  const otherRoom = service.createRoom(
    { title: '另一个 Room', memberAgentIds: ['agent-alpha'], clientRequestKey: `crk-${Math.random()}` },
    userCtx(),
  );
  assert.ok(otherRoom.ok);

  const result = service.listRoomMessagesPage({ claimToken: claim.claimToken, roomId: otherRoom.room.roomId, limit: 3 });
  assert.equal(result.ok, false);
});

test('无效或不存在的 claim token 被拒绝', () => {
  const { service } = setup();
  const { room } = createRoomAndClaim(service);

  const result = service.listRoomMessagesPage({ claimToken: 'not-a-real-token', roomId: room.roomId, limit: 3 });
  assert.equal(result.ok, false);
});

test('claim 已经 settled（走过 completeWake）后 token 不能再用于读取历史', async () => {
  const { service } = setup();
  const { room, claim } = createRoomAndClaim(service);

  const complete = await service.completeWake({ claimToken: claim.claimToken, reply: { text: '已处理' } });
  assert.equal(complete.ok, true, JSON.stringify(complete));

  const result = service.listRoomMessagesPage({ claimToken: claim.claimToken, roomId: room.roomId, limit: 3 });
  assert.equal(result.ok, false, 'settled 之后 claim 不再是 claimed 状态，不能继续读取历史');
});

test('discussion epoch 变化后（room 有新讨论轮次）立即拒绝，不给 grace period（比 completeWake 更严格）', () => {
  const { service } = setup();
  const { room, claim } = createRoomAndClaim(service);

  // 模拟房间进入下一轮讨论（epoch advance）——复用 sendRoomMessage 已有的
  // advanceEpoch 输入选项，不直接操作 store 内部字段。
  const advance = service.sendRoomMessage(
    { roomId: room.roomId, text: '新一轮讨论开始', responsePolicy: 'none', idempotencyKey: `im-advance-${Math.random()}`, advanceEpoch: true },
    userCtx(),
  );
  assert.ok(advance.ok, JSON.stringify(advance));

  const result = service.listRoomMessagesPage({ claimToken: claim.claimToken, roomId: room.roomId, limit: 3 });
  assert.equal(result.ok, false, 'epoch 变化后必须立即拒绝，不是等到 lease 过期');
});

test('调用会写入 room_history_read_audits（与 listRoomMessages 共用同一 audit 机制）', () => {
  const { store, service } = setup();
  const { room, claim } = createRoomAndClaim(service);

  service.listRoomMessagesPage({ claimToken: claim.claimToken, roomId: room.roomId, limit: 2 });

  const audits = store.listRoomHistoryReadAudits(room.roomId);
  assert.equal(audits.length, 1);
  assert.match(audits[0].actorParticipantId, /^agent:/);
});
