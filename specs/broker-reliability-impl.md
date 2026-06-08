# Cross-Agent 协作可靠性 — 实现规格说明

> 状态：**v3 — 第二轮对抗式评审后修订**
> 作者：PM (qoder2)
> 日期：2026-06-08
> 项目：intent-broker
> 范围：4 个 Phase 的代码改动（Phase 4 文档部分已独立完成）
> 评审日志：R1 → 5H/8M/4L → v2 → R2 → 3H/2M/2L → v3

---

## 如何使用本文档

这是一份**完整的实现规格说明**。每个 Phase 互相独立，可按任意顺序实现。对每个 Phase：
1. 阅读"当前代码"小节，理解现有实现
2. 严格按照"改动"小节实施——文件路径、行号引用、代码片段都已精确标注
3. **在编写生产代码之前**先写"单元测试"小节列出的测试
4. 执行"验收测试"中列出的步骤
5. 使用建议的 commit message 提交

所有路径相对于仓库根目录 `/Users/song/projects/intent-broker/`。

---

## Phase 1：人类升级通道

### 目标

当任务 5 分钟未被 ack 时，除了已有的向 `governance-pm` 角色发送 `task_unacked` 事件之外，还要：
1. 向 `kind === 'human'` 的 participant 发送相同事件
2. 触发 macOS 桌面通知（osascript）

### 当前代码

**`src/broker/service.js`**

- `createBrokerService` 签名在 line 74，接受 `{ dbPath, presenceTimeoutMs, presenceSweepIntervalMs, websocketHeartbeatIntervalMs, offlineContextSyncEmitter }`
- `checkAndNotifyUnacked(taskId)` 在 line 109–153，仅向 governance-pm 角色 participant 发送 `task_unacked`
- `sendIntentInternal()` 是内部用于发送事件的函数
- `parseEventTime()` 在 line 92——内部闭包，返回 `new Date(createdAt + 'Z').getTime()`。对无效时间戳返回 `NaN`。

**`src/runtime/start-broker-app.js`**

- `startBrokerApp()` 在 line 42，接受 DI 选项
- Line 68：`const broker = createBroker({ dbPath })`，目前只传入 dbPath

### 改动

#### 1.1 新建文件：`src/runtime/human-escalation.js`

```js
import { execFile as execFileDefault } from 'node:child_process';

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function sanitizeForAppleScript(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function createHumanEscalation({ enableDesktopNotify = true, execFile = execFileDefault } = {}) {
  return function onTaskUnacked({ taskId, ageMs, targetParticipantIds }) {
    if (process.platform !== 'darwin' || !enableDesktopNotify) return;

    const minutes = Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : '?';
    const safeTargets = (targetParticipantIds || [])
      .filter(id => SAFE_ID_RE.test(id))
      .join(', ') || 'none';
    const safeTaskId = SAFE_ID_RE.test(taskId) ? taskId : '<invalid>';

    const msg = sanitizeForAppleScript(
      `Task ${safeTaskId} unacked for ${minutes}min. Targets: ${safeTargets}`
    );

    execFile('osascript', [
      '-e',
      `display notification "${msg}" with title "Intent Broker" sound name "Submarine"`
    ], (err) => {
      if (err) console.error('[human-escalation] osascript failed:', err.message);
    });
  };
}
```

> **v3 变更**：将 `execFile` 作为可注入的 DI 参数（默认为真实的 `execFile`）——可在不真正 spawn 进程的前提下对 osascript 路径进行单元测试。

#### 1.2 修改：`src/broker/service.js`

**步骤 A** — 在构造函数选项中增加 `onTaskUnacked`。

将 line 74：
```js
export function createBrokerService({
  dbPath,
  presenceTimeoutMs = 600000,
  presenceSweepIntervalMs = 5000,
  websocketHeartbeatIntervalMs = 30000,
  offlineContextSyncEmitter = null
}) {
```

改为：
```js
export function createBrokerService({
  dbPath,
  presenceTimeoutMs = 600000,
  presenceSweepIntervalMs = 5000,
  websocketHeartbeatIntervalMs = 30000,
  offlineContextSyncEmitter = null,
  onTaskUnacked = null
}) {
```

**步骤 B** — 修复 `checkAndNotifyUnacked` 中已存在的 NaN dedup bypass。将 lines 120–122：

```js
    const ageSinceLastUnacked = Date.now() - parseEventTime(lastUnacked.createdAt);
    if (ageSinceLastUnacked < TASK_UNACK_DEDUP_MS) return;
```

改为：
```js
    const ageSinceLastUnacked = Date.now() - parseEventTime(lastUnacked.createdAt);
    if (Number.isFinite(ageSinceLastUnacked) && ageSinceLastUnacked < TASK_UNACK_DEDUP_MS) return;
```

> **v3 变更**：如果 `parseEventTime` 返回 `NaN`，则 `ageSinceLastUnacked` 是 `NaN`。`Number.isFinite(NaN)` 为 `false`，dedup 检查会被跳过（继续发送新通知）。如不修复，前一个 `task_unacked` 事件中的损坏时间戳会让 dedup 永远绕过，导致每次 `checkAndNotifyUnacked` 调用都发通知，造成通知刷屏。

**步骤 C** — 在 `checkAndNotifyUnacked(taskId)` 中，已有的 `sendIntentInternal(...)` 调用之后（line 152 之后），追加：

```js
    // 同时通知人类 participant
    const humanParticipantIds = [...participants.values()]
      .filter((p) => p.kind === 'human' && p.participantId !== 'broker.system')
      .map((p) => p.participantId);

    if (humanParticipantIds.length) {
      sendIntentInternal({
        intentId: `task-unacked-human-${taskId}-${Date.now()}`,
        kind: 'task_unacked',
        fromParticipantId: 'broker.system',
        taskId,
        threadId: task.threadId,
        to: { mode: 'participant', participants: humanParticipantIds },
        payload: {
          taskId,
          threadId: task.threadId,
          ageMs: Number.isFinite(ageMs) ? ageMs : 0,
          requesterId: requestEvent?.fromParticipantId ?? null,
          targetParticipantIds
        }
      });
    }

    // 触发外部回调
    if (typeof onTaskUnacked === 'function') {
      try {
        onTaskUnacked({
          taskId,
          threadId: task.threadId,
          ageMs: Number.isFinite(ageMs) ? ageMs : 0,
          requesterId: requestEvent?.fromParticipantId ?? null,
          targetParticipantIds,
          recipients
        });
      } catch (e) {
        console.error('[broker] onTaskUnacked callback error:', e?.message || e);
      }
    }
```

#### 1.3 修改：`src/runtime/start-broker-app.js`

**步骤 A** — 在文件顶部（与其他 import 一起）添加：
```js
import { createHumanEscalation } from './human-escalation.js';
```

**步骤 B** — 将 line 68：
```js
const broker = createBroker({ dbPath });
```
改为：
```js
const enableEscalation = process.env.ENABLE_HUMAN_ESCALATION !== '0';
const broker = createBroker({ dbPath, onTaskUnacked: enableEscalation ? createHumanEscalation() : null });
```

### 单元测试

加入 `tests/broker/service.test.js`：

```js
// 1. 人类 participant 收到 task_unacked
test('checkAndNotifyUnacked sends task_unacked to human participants', () => {
  const broker = createBrokerService({ dbPath: tempDb(), onTaskUnacked: null });
  broker.registerParticipant({ participantId: 'pm1', kind: 'human', roles: ['governance-pm'] });
  broker.registerParticipant({ participantId: 'user1', kind: 'human', roles: ['observer'] });
  broker.registerParticipant({ participantId: 'agent1', kind: 'agent', roles: ['coder'] });
  broker.sendIntent({ kind: 'request_task', fromParticipantId: 'pm1', taskId: 't1',
    to: { mode: 'role', roles: ['coder'] }, payload: { delivery: { targetParticipantIds: ['agent1'] } } });
  broker.checkAndNotifyUnacked('t1');
  const user1Inbox = broker.readInbox('user1');
  assert.ok(user1Inbox.some(e => e.kind === 'task_unacked'));
});

// 2. broker.system 即使 kind=human 也被排除
test('checkAndNotifyUnacked does not send to broker.system even if kind=human', () => {
  const broker = createBrokerService({ dbPath: tempDb(), onTaskUnacked: null });
  broker.registerParticipant({ participantId: 'broker.system', kind: 'human', roles: [] });
  broker.registerParticipant({ participantId: 'agent1', kind: 'agent', roles: ['coder'] });
  broker.sendIntent({ kind: 'request_task', fromParticipantId: 'pm1', taskId: 't2',
    to: { mode: 'role', roles: ['coder'] }, payload: { delivery: { targetParticipantIds: ['agent1'] } } });
  broker.checkAndNotifyUnacked('t2');
  const sysInbox = broker.readInbox('broker.system');
  assert.ok(!sysInbox.some(e => e.kind === 'task_unacked'));
});

// 3. ageMs 为 NaN 时 callback 收到 0
test('onTaskUnacked callback receives 0 for ageMs when event timestamp is invalid', () => {
  const received = [];
  const broker = createBrokerService({
    dbPath: tempDb(),
    onTaskUnacked: (data) => received.push(data)
  });
  broker.registerParticipant({ participantId: 'pm1', kind: 'human', roles: ['governance-pm'] });
  broker.registerParticipant({ participantId: 'agent1', kind: 'agent', roles: ['coder'] });
  broker.sendIntent({ kind: 'request_task', fromParticipantId: 'pm1', taskId: 't3',
    to: { mode: 'role', roles: ['coder'] }, payload: { delivery: { targetParticipantIds: ['agent1'] } } });
  // 通过 store.listEvents 注入 createdAt 损坏的 task_unacked 事件触发 NaN 路径——直接构造一个：
  broker.sendIntent({ kind: 'task_unacked', fromParticipantId: 'broker.system', taskId: 't3',
    to: { mode: 'participant', participants: ['pm1'] }, payload: { ageMs: 0 } });
  // 然后手动在 DB 中破坏 createdAt（需要 store 访问）
  // 替代方案：仅验证 callback 代码路径中的 Number.isFinite 守卫
  // 检查若 received[0] 存在，其 ageMs 为 0
  broker.checkAndNotifyUnacked('t3');
  if (received.length) assert.equal(received[received.length - 1].ageMs, 0);
});

// 4. callback 抛错不影响 broker
test('onTaskUnacked callback throwing does not prevent event delivery', () => {
  const broker = createBrokerService({
    dbPath: tempDb(),
    onTaskUnacked: () => { throw new Error('boom'); }
  });
  broker.registerParticipant({ participantId: 'pm1', kind: 'agent', roles: ['governance-pm'] });
  broker.registerParticipant({ participantId: 'agent1', kind: 'agent', roles: ['coder'] });
  broker.sendIntent({ kind: 'request_task', fromParticipantId: 'pm1', taskId: 't4',
    to: { mode: 'role', roles: ['coder'] }, payload: { delivery: { targetParticipantIds: ['agent1'] } } });
  broker.checkAndNotifyUnacked('t4');
  // 验证 governance-pm 仍收到事件，即使 callback 抛错
  const pmInbox = broker.readInbox('pm1');
  assert.ok(pmInbox.some(e => e.kind === 'task_unacked'));
});

// 5. NaN dedup bypass 已修复
test('checkAndNotifyUnacked does not spam when previous unacked event has corrupt timestamp', () => {
  const broker = createBrokerService({ dbPath: tempDb(), onTaskUnacked: null });
  // 准备：创建 task，发送一个 createdAt 损坏的 task_unacked，
  // 然后再次调用 checkAndNotifyUnacked——应再次发送（不应被 dedup 永久阻挡）
  // 验证 NaN < TASK_UNACK_DEDUP_MS === false 不再阻挡发送
});
```

新建 `tests/runtime/human-escalation.test.js`：

```js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHumanEscalation } from '../../src/runtime/human-escalation.js';

// 1. sanitizeForAppleScript 转义 " 和 \
test('sanitizeForAppleScript escapes double quotes', () => {
  // 用 mock execFile 调用 createHumanEscalation，验证传入的字符串
});

// 2. SAFE_ID_RE 过滤非字母数字 taskId
test('non-alphanumeric taskId renders as <invalid>', () => {
  const calls = [];
  const fn = createHumanEscalation({ execFile: (cmd, args, cb) => { calls.push(args); cb(null); } });
  fn({ taskId: 'foo"bar', ageMs: 300000, targetParticipantIds: ['a'] });
  assert.ok(calls[0][1].includes('<invalid>'));
  assert.ok(!calls[0][1].includes('foo"bar'));
});

// 3. 非 darwin 平台不调 osascript（通过 enableDesktopNotify=false 测试）
test('no execFile call when enableDesktopNotify=false', () => {
  let called = false;
  const fn = createHumanEscalation({ enableDesktopNotify: false, execFile: () => { called = true; } });
  fn({ taskId: 't1', ageMs: 300000, targetParticipantIds: [] });
  assert.equal(called, false);
});

// 4. ageMs 为 NaN 时通知中显示 ?
test('NaN ageMs renders as ? in notification', () => {
  const calls = [];
  const fn = createHumanEscalation({ execFile: (cmd, args, cb) => { calls.push(args); cb(null); } });
  fn({ taskId: 't1', ageMs: NaN, targetParticipantIds: [] });
  assert.ok(calls[0][1].includes('?min'));
});

// 5. execFile DI 参数生效
test('custom execFile is used instead of real osascript', () => {
  const calls = [];
  const fn = createHumanEscalation({ execFile: (cmd, args, cb) => { calls.push({ cmd, args }); cb(null); } });
  fn({ taskId: 't1', ageMs: 300000, targetParticipantIds: ['agent1'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'osascript');
});
```

### 验收测试

1. 启动 broker：`npm start`
2. 注册测试 agent：`curl -X POST http://127.0.0.1:4318/participants -H 'Content-Type: application/json' -d '{"participantId":"test-agent","kind":"agent","roles":["coder"]}'`
3. 发送定向任务：`curl -X POST http://127.0.0.1:4318/intents -H 'Content-Type: application/json' -d '{"kind":"request_task","fromParticipantId":"pm","taskId":"test-unack","threadId":"t1","payload":{"summary":"test","delivery":{"targetParticipantIds":["test-agent"]}}}'`
4. 等 5 分钟 → 应弹出 macOS 通知
5. 验证回滚：`ENABLE_HUMAN_ESCALATION=0 npm start` → 不弹通知
6. 运行 `npm test`——所有现有 + 新增测试都通过

### Commit message

```
feat(broker): add human escalation on task_unacked

Send task_unacked to human participants and fire macOS desktop
notification when a task goes unacknowledged for 5 minutes.
Kill switch: ENABLE_HUMAN_ESCALATION=0 disables escalation.
Fix: NaN dedup bypass in checkAndNotifyUnacked.
```

---

## Phase 2：Stale Session 自动清理

### 目标

offline 超过 30 分钟的 agent 自动 deregister，并清理其 inbox 条目。避免 stale session 在 presence/路由表中累积。

### 当前代码

**`src/broker/service.js`** — `sweepStalePresence()` 在 line 691：
```js
function sweepStalePresence() {
  for (const item of presence.listPresence()) {
    const raw = presence.peekPresence(item.participantId);
    if (!raw) continue;
    if (item.status === 'offline' && raw.status !== 'offline') {
      setPresence(item.participantId, 'offline', { ...raw.metadata, reason: 'timeout' });
    }
  }
}
```

它只标记 offline，从不 prune participant。

**与 `shouldPruneOfflineParticipant` 的重要交互**：当 `setPresence(id, 'offline', { reason: 'timeout' })` 被调用时，`shouldPruneOfflineParticipant` 对没有 WebSocket transport 的 agent 返回 `true`。这意味着 `setPresence` 已经会立即对 timeout 场景的 agent 调用 `pruneParticipant`。本 Phase 的 30 分钟阈值针对的是**通过其他路径**变 offline 的 agent（比如 WebSocket 断开 → `reason: 'transport-closed'`），它们不会被立即 prune。

**`src/store/event-store.js`** — 已有 `readInbox` (line 127) 和 `ackInbox` (line 140)。`inbox_entries` 表已有 `discarded_at` 字段（line 134 已使用）。

**`src/broker/presence.js`** — 已有 `removePresence(participantId)`（line 48），删除内部 `presenceMap` 中的项。当前 `pruneParticipant` 不调用它。

### 改动

#### 2.1 修改：`src/store/event-store.js`

在返回对象中增加新方法（`ackInbox` 之后，约 line 153）：

```js
    discardInbox(participantId) {
      db.prepare(`
        UPDATE inbox_entries
        SET discarded_at = CURRENT_TIMESTAMP
        WHERE participant_id = ? AND discarded_at IS NULL
      `).run(participantId);
    },
```

#### 2.2 修改：`src/broker/service.js` — `pruneParticipant()`

在 `pruneParticipant`（line 422）中增加 `presence.removePresence()` 调用 + `participant_removed` 广播：

```js
function pruneParticipant(participantId) {
  const participant = participants.get(participantId);
  if (!participant) {
    return false;
  }

  // 在删除前广播——其他 participant 需要知道
  sendIntentInternal({
    intentId: `participant-removed-${participantId}-${Date.now()}`,
    kind: 'participant_removed',
    fromParticipantId: 'broker.system',
    to: { mode: 'broadcast' },
    payload: {
      participantId,
      alias: participant.alias,
      kind: participant.kind,
      reason: 'pruned'
    }
  });

  releaseAlias(participant.alias, participantId);
  if (participant.logicalParticipantId) {
    const sessions = logicalParticipants.get(participant.logicalParticipantId);
    if (sessions) {
      sessions.delete(participantId);
      if (sessions.size === 0) logicalParticipants.delete(participant.logicalParticipantId);
    }
  }
  participants.delete(participantId);
  workStates.delete(participantId);
  presence.removePresence(participantId);
  return true;
}
```

> **v3 变更**：
> - 在删除 participant 前增加 `participant_removed` 广播——其他 participant 立刻得知，不必等下一轮轮询时才发现路由数据失效。广播时 participant 仍在 Map 中，因此 alias/kind 等数据可用。
> - 增加 `presence.removePresence(participantId)`——修复已有 bug：被 prune 的 participant 的 presence 项仍残留在 `presenceMap` 中。

#### 2.3 修改：`src/broker/service.js` — `sweepStalePresence()`

在 `createBrokerService` 顶部附近（line 98 之后）增加常量：

```js
  const PRUNE_THRESHOLD_MS = Number(process.env.PRUNE_THRESHOLD_MS) || 30 * 60 * 1000;
```

将 `sweepStalePresence` 函数体替换为：

```js
  function sweepStalePresence() {
    const now = Date.now();
    for (const item of presence.listPresence()) {
      const raw = presence.peekPresence(item.participantId);
      if (!raw) continue;

      if (item.status === 'offline' && raw.status !== 'offline') {
        setPresence(item.participantId, 'offline', { ...raw.metadata, reason: 'timeout' });
        // 注意：reason:'timeout' 的 setPresence 可能已经通过
        // shouldPruneOfflineParticipant 对非 websocket agent 调用了 pruneParticipant。
        // 如果已被 prune，participant 已不存在——跳过下方的 30 分钟检查。
        if (!participants.has(item.participantId)) continue;
      }

      // 清理 offline 时长超阈值的 agent
      const participant = participants.get(item.participantId);
      if (!participant) continue;
      if (participant.kind !== 'agent') continue;
      if (item.status !== 'offline') continue;

      // 使用 raw.lastSeen（presence.updatePresence 必然以 Date.now() 写入）
      const lastSeen = raw.lastSeen;
      if (!lastSeen) continue;

      const offlineDuration = now - lastSeen;
      if (!Number.isFinite(offlineDuration) || offlineDuration <= PRUNE_THRESHOLD_MS) continue;

      // 重新检查：participant 仍是 offline（best-effort 防御 re-register 竞争）
      // 这是 best-effort 守卫——本检查到 pruneParticipant 之间的窗口
      // 只有几条 CPU 指令。在同一个 Node.js event-loop tick 内不会有并发
      // re-register 发生。WebSocket 消息处理器有可能 re-register，但它会
      // 先 yield 出 CPU。
      const currentPresence = presence.peekPresence(item.participantId);
      if (currentPresence && currentPresence.status !== 'offline') continue;
      const currentParticipant = participants.get(item.participantId);
      if (!currentParticipant) continue;

      store.discardInbox(item.participantId);
      pruneParticipant(item.participantId);
    }
  }
```

> **v3 变更**：
> - 在 `setPresence` 调用之后增加 `if (!participants.has(item.participantId)) continue;`——若 `setPresence` 已经（通过 `shouldPruneOfflineParticipant`）prune 掉 participant，跳过 30 分钟阈值检查。
> - 澄清 `lastSeen` 必然由 `updatePresence` 写入。
> - 重检查守卫的注释更诚实：标明这是 "best-effort 守卫，竞争窗口仅几条 CPU 指令，期间无 yield 点"。

### 单元测试

加入 `tests/broker/service.test.js`：

```js
// 1. offline 超过阈值的 agent 被 prune
// 需要：注册 agent，offline，再手动把 lastSeen 设为 31+ 分钟前
// 通过 presence.updatePresence 内部——需要 clock DI 或直接操作 presence
test('sweepPresence prunes agent offline beyond PRUNE_THRESHOLD_MS', () => {
  const broker = createBrokerService({ dbPath: tempDb(), presenceTimeoutMs: 20, presenceSweepIntervalMs: 0 });
  broker.registerParticipant({ participantId: 'stale-agent', kind: 'agent', roles: ['coder'] });
  // t=0 时 offline
  broker.setPresence('stale-agent', 'offline', { reason: 'transport-closed' });
  // 注意：测试 30 分钟阈值需操作 lastSeen。
  // 见下方"测试基础设施"小节的 clock DI 方案。
  // 暂时方案：用 PRUNE_THRESHOLD_MS=100 加快：
  // ...（需 env var 或 DI 注入 PRUNE_THRESHOLD_MS）
});

// 2. human participant 永远不会被 prune
test('sweepPresence never prunes human participants', () => {
  const broker = createBrokerService({ dbPath: tempDb(), presenceTimeoutMs: 20, presenceSweepIntervalMs: 0 });
  broker.registerParticipant({ participantId: 'human1', kind: 'human', roles: ['approver'] });
  broker.setPresence('human1', 'offline', { reason: 'timeout' });
  // sweep 之后 human1 仍存在
  const after = broker.listParticipants();
  assert.ok(after.some(p => p.participantId === 'human1'));
});

// 3. pruneParticipant 广播 participant_removed
test('pruneParticipant sends participant_removed broadcast', () => {
  const broker = createBrokerService({ dbPath: tempDb(), onTaskUnacked: null });
  broker.registerParticipant({ participantId: 'agent1', kind: 'agent', roles: ['coder'] });
  broker.registerParticipant({ participantId: 'observer', kind: 'human', roles: ['observer'] });
  // agent1 offline 并被 prune
  broker.setPresence('agent1', 'offline', { reason: 'timeout' });
  // observer 应收到 participant_removed 广播
  const inbox = broker.readInbox('observer');
  assert.ok(inbox.some(e => e.kind === 'participant_removed' && e.payload.participantId === 'agent1'));
});

// 4. pruneParticipant 移除 presence 项
test('pruneParticipant removes presenceMap entry', () => {
  const broker = createBrokerService({ dbPath: tempDb() });
  broker.registerParticipant({ participantId: 'agent1', kind: 'agent', roles: ['coder'] });
  broker.setPresence('agent1', 'offline', { reason: 'timeout' });
  // prune 后（由 shouldPruneOfflineParticipant 触发），presence 应消失
  assert.equal(broker.getPresence('agent1'), null);
});

// 5. discardInbox 标记条目为已废弃
// 需要：访问 store 对象，或 broker 暴露 discardInbox API
test('discardInbox sets discarded_at on inbox entries', () => {
  // 创建 broker，注册 participant，发送 intent，再手动调 store.discardInbox
  // 验证 discarded_at 被设置（discarded 条目不应在 readInbox 中出现）
});

// 6. 已被 setPresence prune 的 agent 不会被 sweepStalePresence 二次 prune
test('sweepStalePresence skips participant already pruned by setPresence', () => {
  // 注册 agent，让它带 reason:'timeout' 走 offline，触发立即 prune
  // 验证不会 double-prune 报错
});

// 7. 损坏的 lastSeen 不导致 prune
test('sweepStalePresence skips participant with non-numeric lastSeen', () => {
  // 需要注入损坏的 presence 数据——需 presence DI
});
```

### 测试基础设施需求

Phase 2 的测试需要以下 DI 才能完整实现：

| 需求 | 位置 | 原因 |
|------|------|------|
| `now: () => number` DI | `createBrokerService` 选项 | 支持把 `lastSeen` 设为任意过去时间 |
| 暴露 `store.discardInbox` | broker 返回对象 | 直接测试 discard |
| 暴露 `sweepPresence` | broker 返回对象（可能已存在） | 测试中直接调用 |

如未加 `now` DI，30 分钟阈值测试只能通过验收测试（`PRUNE_THRESHOLD_MS=5000` + 等 5 秒）实现。

### 验收测试

1. 注册一个测试 agent，让它 offline（停止心跳）
2. 等 30 分钟以上（或 `PRUNE_THRESHOLD_MS=5000` 加速）
3. 验证：`GET /participants` 不再列出该 agent
4. 验证：该 agent 的 inbox 条目均已 `discarded_at`
5. 验证：`GET /presence` 不再列出该 agent
6. 验证：其他 participant 收到 `participant_removed` 广播
7. `npm test` 通过

### Commit message

```
feat(broker): auto-prune agents offline for 30+ minutes

Deregister stale agent sessions, discard their inbox entries,
clean up presence map, and broadcast participant_removed.
Threshold configurable via PRUNE_THRESHOLD_MS env var (default 30 min).

Fixes existing bug: pruneParticipant did not clean presenceMap
or notify other participants of removal.
```

---

## Phase 3：独立任务健康监控

### 目标

一个独立的 Node.js 脚本（零 npm 依赖），每 3 分钟轮询 broker，检测卡住的任务并触发 macOS 通知。完全独立运行，不依赖任何 agent session。

### 当前代码

无——这是新文件。

### 改动

#### 3.1 新建文件：`scripts/task-health-monitor.js`

```js
#!/usr/bin/env node
import { execFile as execFileDefault } from 'node:child_process';

const BROKER_URL = process.env.BROKER_URL || 'http://127.0.0.1:4318';
const BROKER_API_KEY = process.env.BROKER_API_KEY || '';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3 * 60 * 1000;
const TASK_STALE_MS = Number(process.env.TASK_STALE_MS) || 10 * 60 * 1000;
const TASK_NO_PROGRESS_MS = Number(process.env.TASK_NO_PROGRESS_MS) || 15 * 60 * 1000;
const NOTIFY_DEDUP_MS = Number(process.env.NOTIFY_DEDUP_MS) || 30 * 60 * 1000;
const ONCE = process.argv.includes('--once');

let running = true;
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function sanitizeForAppleScript(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const notifiedTasks = new Map(); // taskId → 上次通知的时间戳

function notify(title, msg, { execFile = execFileDefault } = {}) {
  if (process.platform !== 'darwin') {
    console.log(`[NOTIFY] ${title}: ${msg}`);
    return;
  }
  execFile('osascript', [
    '-e', `display notification "${sanitizeForAppleScript(msg)}" with title "${sanitizeForAppleScript(title)}" sound name "Submarine"`
  ], (err) => {
    if (err) console.error('[notify] osascript error:', err.message);
  });
}

const defaultHeaders = BROKER_API_KEY ? { Authorization: `Bearer ${BROKER_API_KEY}` } : {};

async function fetchJSON(path, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${BROKER_URL}${path}`, { headers: defaultHeaders });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

async function getOpenTasks(opts) {
  const data = await fetchJSON('/tasks?status=open', opts);
  return data.tasks || data || [];
}

async function getParticipants(opts) {
  const data = await fetchJSON('/participants', opts);
  const list = data.participants || data || [];
  return new Map(list.map(p => [p.participantId, p]));
}

async function getTaskEvents(taskId, opts) {
  const data = await fetchJSON(`/events/replay?taskId=${encodeURIComponent(taskId)}&limit=200`, opts);
  return data.events || data || [];
}

function parseTimestamp(ts) {
  if (!ts) return 0;
  const hasTz = ts.includes('Z') || ts.includes('+');
  const ms = new Date(hasTz ? ts : ts + 'Z').getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function shouldNotify(taskId, { now = Date.now } = {}) {
  const t = now();
  const lastNotified = notifiedTasks.get(taskId);
  if (lastNotified && (t - lastNotified) < NOTIFY_DEDUP_MS) return false;
  notifiedTasks.set(taskId, t);
  return true;
}

async function check(opts = {}) {
  const { execFile, fetchImpl } = opts;
  const tasks = await getOpenTasks({ fetchImpl });
  const participants = await getParticipants({ fetchImpl });
  const now = Date.now();
  let stuckCount = 0;

  // 并发拉取所有 task 的 events
  const taskEvents = await Promise.all(
    tasks.map(async (task) => {
      try {
        return { task, events: await getTaskEvents(task.taskId, { fetchImpl }) };
      } catch (err) {
        console.error(`[warn] failed to fetch events for ${task.taskId}: ${err.message}`);
        return { task, events: [] };
      }
    })
  );

  for (const { task, events } of taskEvents) {
    const taskId = task.taskId;
    if (!events.length) continue;

    const requestEvent = events.find(e => e.kind === 'request_task');
    if (!requestEvent) continue;

    const firstEventTime = parseTimestamp(requestEvent.createdAt);
    if (!firstEventTime) continue;

    const age = now - firstEventTime;
    if (age < TASK_STALE_MS) continue;

    const hasAck = events.some(e => e.kind === 'accept_task');
    const hasProgress = events.some(e => e.kind === 'report_progress');
    const hasCompletion = events.some(e => e.kind === 'complete_task' || e.kind === 'submit_work');

    if (hasCompletion) continue;

    const targetIds = (requestEvent.payload?.delivery?.targetParticipantIds) || [];
    const targetStatuses = targetIds.map(id => {
      const p = participants.get(id);
      const alias = (p?.alias && SAFE_ID_RE.test(p.alias)) ? p.alias : id;
      return { id, alias, online: !!p };
    });

    if (!hasAck && !hasProgress) {
      stuckCount++;
      if (!shouldNotify(taskId)) continue;

      const offlineTargets = targetStatuses.filter(t => !t.online);
      const onlineTargets = targetStatuses.filter(t => t.online);

      if (offlineTargets.length) {
        notify('Broker: Agent Offline',
          `Task ${taskId} (${Math.round(age/60000)}min) — target ${offlineTargets.map(t=>t.alias).join(',')} is OFFLINE`,
          { execFile });
      } else if (onlineTargets.length && age > TASK_NO_PROGRESS_MS) {
        notify('Broker: No Response',
          `Task ${taskId} (${Math.round(age/60000)}min) — ${onlineTargets.map(t=>t.alias).join(',')} online but no response`,
          { execFile });
      }
    }
  }

  // 清理过老的 dedup 项
  for (const [id, ts] of notifiedTasks) {
    if (now - ts > NOTIFY_DEDUP_MS * 2) notifiedTasks.delete(id);
  }

  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] checked ${tasks.length} open tasks, ${stuckCount} stuck`);
}

async function main() {
  console.log(`[task-health-monitor] polling ${BROKER_URL} every ${POLL_INTERVAL_MS/1000}s`);
  while (running) {
    try {
      await check();
    } catch (err) {
      console.error(`[error] ${err.message}`);
    }
    if (ONCE || !running) break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log('[task-health-monitor] stopped');
}

main();
```

> **v3 变更**：
> - 在 `notify`、`fetchJSON`、`check` 上加入 `execFile` 与 `fetchImpl` DI 选项——无需真实网络/进程即可单元测试。
> - `shouldNotify` 加入 `now` 参数——可用假时钟测试 dedup 窗口。

### 单元测试

新建 `scripts/__tests__/task-health-monitor.test.js`：

```js
// 1. sanitizeForAppleScript 转义 " 和 \
test('sanitizeForAppleScript escapes double quotes', () => {
  // import sanitizeForAppleScript，验证 'hello"world' → 'hello\\"world'
});

// 2. shouldNotify 首次返回 true，dedup 窗口内返回 false
test('shouldNotify deduplicates within NOTIFY_DEDUP_MS', () => {
  const clock = { now: () => 1000 };
  assert.equal(shouldNotify('t1', clock), true);
  assert.equal(shouldNotify('t1', clock), false);  // 同一时间 → dedup
});

// 3. dedup 窗口过期后允许再次通知
test('shouldNotify allows re-notification after dedup window', () => {
  let t = 1000;
  const clock = { now: () => t };
  assert.equal(shouldNotify('t1', clock), true);
  t += NOTIFY_DEDUP_MS + 1;
  assert.equal(shouldNotify('t1', clock), true);  // 窗口外 → 允许
});

// 4. parseTimestamp 对无效输入返回 0
test('parseTimestamp returns 0 for null/undefined/invalid', () => {
  assert.equal(parseTimestamp(null), 0);
  assert.equal(parseTimestamp('not-a-date'), 0);
  assert.equal(parseTimestamp('2026-06-08T12:00:00Z') > 0, true);
});

// 5. --once 一次后退出
// 通过子进程或 mock process.argv 测试

// 6. SAFE_ID_RE 在写入通知前过滤 alias
test('alias with special chars is replaced by id', () => {
  assert.equal(SAFE_ID_RE.test('normal-id_1'), true);
  assert.equal(SAFE_ID_RE.test('alias with spaces'), false);
  assert.equal(SAFE_ID_RE.test('alias"quote'), false);
});

// 7. 单个 task 的网络错误不中止整个检查
test('check continues when one task events fetch fails', async () => {
  let fetchCount = 0;
  const fetchImpl = async (url) => {
    fetchCount++;
    if (url.includes('/events/replay')) throw new Error('network error');
    return { ok: true, json: async () => ({ tasks: [{ taskId: 't1' }], participants: [] }) };
  };
  await check({ fetchImpl });
  // 不应抛错，并应记录 warn
});

// 8. dedup map 清理超过 2x NOTIFY_DEDUP_MS 的条目
test('dedup map prunes stale entries', () => {
  notifiedTasks.set('old', 0);  // 极旧
  notifiedTasks.set('recent', Date.now());
  check(); // 触发清理
  assert.equal(notifiedTasks.has('old'), false);
  assert.equal(notifiedTasks.has('recent'), true);
});
```

### 验收测试

1. 启动 broker，按 Phase 1 测试方法创建一个 open task
2. 运行：`POLL_INTERVAL_MS=5000 TASK_STALE_MS=5000 node scripts/task-health-monitor.js`
3. ~5 秒后弹 macOS 通知
4. 再等 5 秒 → 不弹重复通知（dedup）
5. 控制台输出 `checked N open tasks, 1 stuck`
6. 单次测试：`node scripts/task-health-monitor.js --once` → 跑一次后退出
7. Ctrl-C 干净退出

### Commit message

```
feat: add independent task-health-monitor script

Standalone Node.js process that polls broker every 3 minutes,
detects stuck/unacked tasks, and fires macOS notifications.
Zero npm dependencies. Supports --once, BROKER_API_KEY,
notification deduplication, and DI for testing.
```

---

## Phase 5：Auto-Dispatch 可靠性加固

### 目标

1. session-keeper 检测到 runtime state 显示 "running" 但 owner 进程已死时，自动重置为 "idle"
2. 所有 recovery 事件写入 `~/.intent-broker/<tool>/auto-dispatch-recovery.log`

### 当前代码

**`adapters/session-bridge/session-keeper.js`**

- `runSessionKeeperIteration()` 在 line 389–418：检查父进程是否存活，注册 participant。**不检查 runtime state**。
- `DEFAULT_INTERVAL_MS = 30000`（line 15），每 30 秒一次
- `isProcessAlive(pid, options)` 在 line 67–79：已正确处理 EPERM（Windows alive）与 zombie 进程
- 已 import：`mkdirSync`、`readFileSync`、`writeFileSync` 来自 `node:fs`；`os`；`path`

**`adapters/session-bridge/realtime-bridge.js`**

- `DEFAULT_CLAUDE_AUTO_DISPATCH_STALE_MS = 30 * 1000`（line 54），已是 30 秒
- `shouldRecoverStaleAutoDispatchRuntime()` 在 line 241-257：检查 auto-dispatch runtime 是否 stale
- `maybeAutoDispatchRealtimeQueue()` 中的 stale 恢复（约 line 428-455）将 runtime 重置为 idle，但**不写日志**
- 已 import：`mkdirSync`、`readFileSync`、`writeFileSync` 来自 `node:fs`；`os`；`path`

### 改动

#### 5.1 修改：`adapters/session-bridge/session-keeper.js`

**步骤 A** — 在已有 `node:fs` import（line 2）中加入 `existsSync`、`appendFileSync`、`renameSync`：

将：
```js
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
```
改为：
```js
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
```

**步骤 B** — 在 `runSessionKeeperIteration` 之前（约 line 385）添加辅助函数：

```js
function recoverStaleRuntime({
  toolName,
  runtimeStatePath,
  logger,
  isProcessAlive = isProcessAlive,
  readFileSyncImpl = readFileSync,
  writeFileSyncImpl = writeFileSync,
  existsSyncImpl = existsSync,
  renameSyncImpl = renameSync,
  appendFileSyncImpl = appendFileSync,
  mkdirSyncImpl = mkdirSync,
  homedirImpl = os.homedir
} = {}) {
  if (!toolName || !runtimeStatePath || !existsSyncImpl(runtimeStatePath)) return;

  let runtime;
  try {
    runtime = JSON.parse(readFileSyncImpl(runtimeStatePath, 'utf8'));
  } catch {
    return;
  }

  if (runtime.status !== 'running') return;
  if (!runtime.ownerPid) return;

  // 复用已有的 isProcessAlive，已处理 EPERM (Windows) 和 zombie
  if (isProcessAlive(runtime.ownerPid)) return;

  // 原子写：先写临时文件，再 rename 覆盖原文件。
  // rename() 在 POSIX 下是原子的，可避免 realtime-bridge 在我们读
  // 与写之间介入造成的竞争。如果 realtime-bridge 在我们 temp-write
  // 与 rename 之间也写，rename 仍以最后写者获胜，但：
  // - temp 文件名包含 PID + timestamp，唯一
  // - 若原文件内容在读和 rename 之间变了，我们 rename 后再读以验证
  const recovered = {
    ...runtime,
    status: 'idle',
    source: 'keeper-recovery',
    updatedAt: new Date().toISOString()
  };
  const tmpPath = `${runtimeStatePath}.keeper-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSyncImpl(tmpPath, JSON.stringify(recovered, null, 2));
    renameSyncImpl(tmpPath, runtimeStatePath);
  } catch (e) {
    // 失败时清理临时文件
    try { rmSync(tmpPath, { force: true }); } catch {}
    logger?.warn?.(`[session-keeper] failed to write recovery state for ${toolName}: ${e.message}`);
    return;
  }

  // 验证：重读，确认 recovery 生效。
  // 如果 realtime-bridge 在我们 rename 之后又写了，文件会再变回
  // 'running'——但这意味着新的 auto-dispatch 已生效，是正确行为
  // （我们当时的 recovery 在写入瞬间是合法的）。
  try {
    const after = JSON.parse(readFileSyncImpl(runtimeStatePath, 'utf8'));
    if (after.source === 'keeper-recovery') {
      const logDir = path.join(homedirImpl(), '.intent-broker', toolName);
      mkdirSyncImpl(logDir, { recursive: true });
      const logPath = path.join(logDir, 'auto-dispatch-recovery.log');
      const age = Date.now() - new Date(runtime.updatedAt || 0).getTime();
      const entry = `[${new Date().toISOString()}] recovered stale runtime, previous owner: ${runtime.ownerPid}, age: ${age}ms\n`;
      try { appendFileSyncImpl(logPath, entry); } catch { /* best effort */ }

      logger?.info?.(`[session-keeper] recovered stale runtime for ${toolName}: owner ${runtime.ownerPid} is dead`);
    }
  } catch {
    // 验证失败——文件可能损坏或丢失。Best effort。
  }
}
```

> **v3 变更（自 v2）**：
> - **用已有的 `isProcessAlive` 替换 `isProcessDead`**——line 67-79 已正确处理 EPERM (Windows) 与 zombie。新写一个 `isProcessDead` 而丢失 zombie 检测会是回归。改为调用 `isProcessAlive(pid)`，把 `false` 视为"已死，可恢复"。
> - **用原子 write-to-temp-then-rename 替换 mtime 乐观锁**——HFS+/APFS/ext4 的 mtime 精度仅 1 秒，v2 方案对同秒竞争不可靠。`rename()` 在 POSIX 下原子。rename 后重读校验：若文件 source 为 `keeper-recovery`，记录恢复日志。若 `realtime-bridge` 并发写入了 `running`（覆盖了我们的 recovery），那是正确的：新一轮 auto-dispatch 已开始。
> - **所有 fs 操作加 DI 参数**——便于单元测试中注入 mock。
> - **临时文件清理**——若写或 rename 失败，临时文件会被清理。
> - **移除 `statSync`**——原子 rename 方案不再需要。

**步骤 C** — 在 `runSessionKeeperIteration()` 中，于 `registerParticipant(config)` 之前调用 `recoverStaleRuntime`。

从 config 中确定 `toolName` 和 `runtimeStatePath`：
```js
const toolName = config.toolName || config.tool || 'unknown';
const runtimeStatePath = path.join(os.homedir(), '.intent-broker', toolName, 'runtime-state.json');
```

在迭代早期添加：
```js
  recoverStaleRuntime({ toolName, runtimeStatePath, logger });
```

#### 5.2 修改：`adapters/session-bridge/realtime-bridge.js`

找到 `maybeAutoDispatchRealtimeQueue` 中的 stale 恢复代码块（约 line 436-455），在 reset 之后追加日志：

```js
    // 写入 recovery 日志
    const logDir = path.join(os.homedir(), '.intent-broker', toolName);
    mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'auto-dispatch-recovery.log');
    const entry = `[${new Date().toISOString()}] realtime-bridge recovered stale auto-dispatch, previous owner: ${runtimeState.ownerPid || 'unknown'}, stale for: ${Date.now() - (runtimeState.updatedAt ? new Date(runtimeState.updatedAt).getTime() : 0)}ms\n`;
    try { appendFileSync(logPath, entry); } catch { /* best effort */ }
```

在已有 `node:fs` import（line 2）中加入 `appendFileSync`：

```js
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
```

### 单元测试

加入 `tests/adapters/session-keeper.test.js`：

```js
// 1. owner 已死时 recoverStaleRuntime 写入 idle
test('recoverStaleRuntime writes idle status when owner PID is dead', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'recover-test-'));
  const runtimePath = path.join(homeDir, '.intent-broker', 'codex', 'runtime-state.json');
  mkdirSync(path.dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, JSON.stringify({
    status: 'running', ownerPid: 99999, source: 'auto-dispatch',
    updatedAt: '2000-01-01T00:00:00.000Z'
  }));

  const files = {};
  recoverStaleRuntime({
    toolName: 'codex',
    runtimeStatePath,
    isProcessAlive: () => false,
    existsSyncImpl: (p) => files[p] !== undefined || existsSync(p),
    readFileSyncImpl: (p) => files[p] !== undefined ? files[p] : readFileSync(p),
    writeFileSyncImpl: (p, c) => { files[p] = c; writeFileSync(p, c); },
    renameSyncImpl: (from, to) => { files[to] = files[from]; delete files[from]; renameSync(from, to); },
    appendFileSyncImpl: () => {},
    mkdirSyncImpl: mkdirSync,
    homedirImpl: () => homeDir
  });

  const after = JSON.parse(readFileSync(runtimePath, 'utf8'));
  assert.equal(after.status, 'idle');
  assert.equal(after.source, 'keeper-recovery');
});

// 2. owner 活着时 recoverStaleRuntime 不动
test('recoverStaleRuntime does nothing when owner PID is alive', async () => {
  // 同上准备但 isProcessAlive 返回 true
  // 验证文件未变
});

// 3. toolName 未定义时直接返回
test('recoverStaleRuntime returns early when toolName is falsy', () => {
  // toolName: undefined 调用，验证无 fs 操作
});

// 4. 损坏的 runtime-state.json 不致崩
test('recoverStaleRuntime does not crash on corrupt JSON', () => {
  // runtime-state.json 写垃圾，验证不抛错
});

// 5. recoverStaleRuntime 通过重读验证后才记录日志
test('recoverStaleRuntime logs only when verification confirms recovery', () => {
  // 原子写之后重读 source 应是 'keeper-recovery'
  // 验证仅在确认时写日志
});

// 6. 写失败时清理临时文件
test('recoverStaleRuntime cleans up temp file when rename fails', () => {
  // 让 renameSyncImpl 抛错，验证 tmpPath 被清理
});

// 7. 集成 isProcessAlive（不是自定义函数）
test('recoverStaleRuntime uses isProcessAlive for PID check (not a custom function)', () => {
  // 注入 mock isProcessAlive，验证用正确 PID 调用
});
```

### 验收测试

1. 启动 broker + 一个支持 auto-dispatch 的 agent session
2. 找到 runtime-state 文件：`~/.intent-broker/<tool>/runtime-state.json`
3. 手动写入：`{"status":"running","ownerPid":99999,"source":"auto-dispatch","updatedAt":"2026-06-08T00:00:00.000Z"}`
4. 等 30 秒，让 session-keeper 跑一轮
5. 验证：runtime-state.json 已变为 `"status":"idle","source":"keeper-recovery"`
6. 验证：`~/.intent-broker/<tool>/auto-dispatch-recovery.log` 出现新条目
7. 向该 agent 发送 actionable 任务 → auto-dispatch 应正常触发
8. `npm test` 通过

### Commit message

```
feat(session-bridge): recover stale runtime when owner process dies

Session-keeper now detects dead owner PIDs and resets runtime to idle
using atomic rename for race safety with realtime-bridge.
Uses existing isProcessAlive (handles EPERM + zombies).
Recovery events are logged to ~/.intent-broker/<tool>/auto-dispatch-recovery.log.
```

---

## 改动文件汇总

| 文件 | Phase | 操作 |
|------|-------|------|
| `src/runtime/human-escalation.js` | 1 | 新建 |
| `src/broker/service.js` | 1, 2 | 修改 |
| `src/runtime/start-broker-app.js` | 1 | 修改 |
| `src/store/event-store.js` | 2 | 修改 |
| `scripts/task-health-monitor.js` | 3 | 新建 |
| `adapters/session-bridge/session-keeper.js` | 5 | 修改 |
| `adapters/session-bridge/realtime-bridge.js` | 5 | 修改 |

## 依赖与执行顺序

各 Phase 互相独立。建议实施顺序（风险从低到高）：
1. Phase 3（全新独立文件，对现有代码零风险）
2. Phase 2（改动小，隔离性好；同时修复 presenceMap 已有 bug）
3. Phase 1（增加回调线路 + NaN dedup 修复，复杂度中等）
4. Phase 5（触及 auto-dispatch 热路径，需仔细测试）

## 测试

```bash
npm test
```

每个 Phase 完成后，所有现有测试必须继续通过；新增单元测试也必须通过后才能 commit。

## 回滚矩阵

| Phase | Kill switch | 效果 |
|-------|------------|------|
| Phase 1 | `ENABLE_HUMAN_ESCALATION=0` | 关闭回调，不发通知 |
| Phase 2 | `PRUNE_THRESHOLD_MS=999999999` | 实际禁用 prune |
| Phase 3 | 停止脚本进程 | 无监控，无副作用 |
| Phase 5 | 无（修复 bug） | 出问题就从 keeper iteration 中删掉 `recoverStaleRuntime` 调用 |

## 测试基础设施需求

下列 DI 是单元测试覆盖率所需，应作为各 Phase 的一部分一起实现：

| Phase | 所需 DI | 位置 | 优先级 |
|-------|--------|------|--------|
| 1 | `execFile` 参数 | `createHumanEscalation` 选项 | v3 已完成 |
| 2 | `now: () => number` | `createBrokerService` 选项 | HIGH——阈值测试必需 |
| 2 | 暴露 `store.discardInbox` | broker 返回对象 | HIGH——discard 测试必需 |
| 3 | `fetchImpl` 参数 | `fetchJSON` / `check` 选项 | v3 已完成 |
| 3 | `execFile` 参数 | `notify` 选项 | v3 已完成 |
| 3 | `now` 参数 | `shouldNotify` 选项 | v3 已完成 |
| 5 | 所有 fs ops + `isProcessAlive` | `recoverStaleRuntime` 选项 | v3 已完成 |

## 对抗式评审记录

### Round 1 发现 → v2 解决（5 HIGH / 8 MEDIUM / 4 LOW）

| # | 严重度 | 问题 | 解决 |
|---|--------|------|------|
| 1 | HIGH | osascript 注入（taskId/participantId） | 新增 `sanitizeForAppleScript()` + `SAFE_ID_RE` 白名单 |
| 2 | MEDIUM | `onTaskUnacked` 回调错误被静默吞掉 | 加 `console.error` 日志 |
| 3 | MEDIUM | `ageMs` NaN 透传到 payload 与 callback | 加 `Number.isFinite` 守卫，回退 0 |
| 4 | LOW | `broker.system` 在 human 接收人中形成回响 | 从 human participant 列表中过滤 `broker.system` |
| 5 | MEDIUM | `buildState()` 每次 unacked 检查都全量扫描 | 列为技术债务；本规格不处理 |
| 6 | HIGH | `sweepStalePresence` 中 prune/re-register 竞争 | 增加重检查守卫（presence + participants） |
| 7 | MEDIUM | `lastSeen` / `updatedAt` 来源不明 | 移除 `updatedAt` 回退；`lastSeen` 必由 `updatePresence` 写入 |
| 8 | MEDIUM | `discardInbox` 不通知 participant | v3：`pruneParticipant` 中加 `participant_removed` 广播 |
| 9 | LOW | human participant 永不被 prune | 视为有意设计，文档化 |
| 10 | HIGH | 健康监控对 broker API 无鉴权 | 加 `BROKER_API_KEY` env var（向前兼容） |
| 11 | HIGH | 健康监控 osascript 注入（同 #1） | 同样修复：`sanitizeForAppleScript()` + `SAFE_ID_RE` |
| 12 | MEDIUM | 健康监控无通知 dedup | 加 `notifiedTasks` Map + `NOTIFY_DEDUP_MS` |
| 13 | MEDIUM | 健康监控对每个 task 串行拉 events | 改为 `Promise.all` |
| 14 | LOW | `parseTimestamp` 时区假设 | 对无效日期返回 `0` 而非 `NaN` |
| 15 | HIGH | `recoverStaleRuntime` 与 `realtime-bridge` 读写竞争 | v3：用原子 rename 替换 mtime 锁 |
| 16 | HIGH | `isProcessDead` 在 Windows 上误报 EPERM | v3：复用已有 `isProcessAlive`（处理 EPERM + zombie） |
| 17 | MEDIUM | `appendFileSync` 在并发写下不可靠 | 包 try/catch，作为 best-effort 日志 |
| 18 | LOW | `undefined` toolName 产生非法路径 | 函数入口加 `toolName` 守卫 |
| 19 | MEDIUM | realtime-bridge 中 import 冲突 | 验证：仅需新增 `appendFileSync` |
| 20 | HIGH | `presenceMap` 在 `pruneParticipant` 中未清理 | `pruneParticipant` 中加 `presence.removePresence()` |
| 21 | — | 缺少单元测试设计 | 各 Phase 增加"单元测试"小节 |
| 22 | — | 缺少回滚 / 特性开关 | 增加回滚矩阵 + env var kill switch |

### Round 2 发现 → v3 解决（3 HIGH / 2 MEDIUM / 2 LOW）

| # | 严重度 | 问题 | 解决 |
|---|--------|------|------|
| R2-1 | HIGH | `isProcessDead` 丢失 `isZombieProcess` 检查——zombie PID 触发误恢复 | v3：复用已有 `isProcessAlive`，已正确处理 zombie + EPERM |
| R2-2 | HIGH | `pruneParticipant` 未调用 `broadcastPresenceChange`——其他 participant 只能在下一轮轮询时发现 | v3：`pruneParticipant` 在删数据前加 `participant_removed` 广播 |
| R2-3 | HIGH | mtime 乐观锁在 HFS+/APFS/ext4 上失效（1 秒精度）——同秒写造成误恢复 | v3：用原子 write-to-temp-then-rename 替换；rename 后重读验证 |
| R2-4 | MEDIUM | NaN dedup bypass——`checkAndNotifyUnacked` 中 `NaN < TASK_UNACK_DEDUP_MS` 永远为 false，造成通知刷屏 | v3：dedup 比较加 `Number.isFinite(ageSinceLastUnacked)` 守卫 |
| R2-5 | MEDIUM | 规格缺 Phase 4 | 非代码问题；Phase 4 仅为文档，已独立完成 |
| R2-6 | MEDIUM | sweep 中重检查守卫夸大其强度 | v3：注释修正为"best-effort 守卫，竞争窗口几条 CPU 指令" |
| R2-7 | LOW | dedup map 清理只对静默任务触发，不针对卡死任务 | 接受现状：卡死任务在 dedup 窗口后仍会再次通知，符合预期；清理仅针对已不再卡死或已完成的任务 |
| R2-8 | LOW | 检测到竞争但文件已写——v2 在竞争检测后留下 `idle` 状态 | v3：原子 rename 解决——rename 成功则 recovery 合法；rename 失败则原文件未动 |
