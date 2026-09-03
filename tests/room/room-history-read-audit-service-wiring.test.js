/**
 * listRoomMessages 必须真实写入 room_history_read_audits（design §6.2）。
 *
 * 现状核实（2026-09-02）：store.js:recordRoomHistoryReadAudit 此前只有
 * store 层单元测试覆盖（room-history-read-audits.test.js），从未被
 * service.js:listRoomMessages 调用——真实生产的分页读取路径完全没有写入
 * audit，即使表结构、清理逻辑、字段冻结都已经实现。这正是"测试只验证到
 * 存储层单元，从未证明 service 层真的接了线"的典型缺口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { createRoomStore } from '../../src/room/store.js';
import { createRoomService } from '../../src/room/service.js';

function userCtx(overrides = {}) {
  return {
    sessionId: 'sess-user-1',
    requestSource: 'user',
    actor: { kind: 'user', userId: 'user.local' },
    allowedLogicalAgentIds: [],
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

function agentCtx(logicalAgentId, overrides = {}) {
  return {
    sessionId: `sess-agent-${logicalAgentId}`,
    requestSource: 'agent',
    actor: { kind: 'agent', logicalAgentId },
    allowedLogicalAgentIds: [logicalAgentId],
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createService() {
  const store = createRoomStore({ dbPath: createTempDbPath() });
  store.migrate();
  return { store, service: createRoomService({ store }) };
}

function createRoom(service, memberAgentIds = ['agent-alpha']) {
  const result = service.createRoom(
    { title: '审计接线测试 Room', memberAgentIds, clientRequestKey: `crk-${Math.random()}` },
    userCtx()
  );
  assert.ok(result.ok, JSON.stringify(result));
  return result.room;
}

function sendMessages(service, room, count) {
  for (let i = 0; i < count; i += 1) {
    const result = service.sendRoomMessage(
      { roomId: room.roomId, text: `message-${i}`, responsePolicy: 'none', idempotencyKey: `im-audit-${i}-${Math.random()}` },
      userCtx(),
    );
    assert.ok(result.ok, JSON.stringify(result));
  }
}

test('agent 通过 listRoomMessages 做分页读取时，真实写入 room_history_read_audits 记录', () => {
  const { store, service } = createService();
  const room = createRoom(service, ['agent-alpha']);
  sendMessages(service, room, 5);

  const result = service.listRoomMessages(
    { roomId: room.roomId, limit: 3 },
    agentCtx('agent-alpha'),
  );
  assert.ok(result.ok, JSON.stringify(result));

  const audits = store.listRoomHistoryReadAudits(room.roomId);
  assert.equal(audits.length, 1, 'agent 的分页读取必须产生恰好一条 audit 记录');
  assert.equal(audits[0].actorParticipantId, 'agent:agent-alpha');
  assert.equal(audits[0].requestedLimit, 3);
  assert.equal(audits[0].resultCount, result.messages.length);
});

test('无分页参数的旧全量读取不写入 audit（保持旧行为，不为现有 desktop UI 全量快照读取产生噪音记录）', () => {
  const { store, service } = createService();
  const room = createRoom(service, ['agent-alpha']);
  sendMessages(service, room, 3);

  const result = service.listRoomMessages({ roomId: room.roomId }, userCtx());
  assert.ok(result.ok, JSON.stringify(result));

  const audits = store.listRoomHistoryReadAudits(room.roomId);
  assert.equal(audits.length, 0);
});

test('audit 记录不包含消息正文（只有 sequence/limit/count 元数据）', () => {
  const { store, service } = createService();
  const room = createRoom(service, ['agent-alpha']);
  sendMessages(service, room, 3);

  service.listRoomMessages({ roomId: room.roomId, limit: 2 }, agentCtx('agent-alpha'));

  const audits = store.listRoomHistoryReadAudits(room.roomId);
  assert.equal(audits.length, 1);
  const serialized = JSON.stringify(audits[0]);
  assert.ok(!serialized.includes('message-0'), 'audit 记录不应包含任何消息正文内容');
});
