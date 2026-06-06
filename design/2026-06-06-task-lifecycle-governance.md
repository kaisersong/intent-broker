# Task Lifecycle Governance — 协议层加固

**状态:** 评审中（self review B1/H2/H3 已修入）
**日期:** 2026-06-06
**背景:** 过去 24 小时多 agent 协作暴露的系统性故障，见 `xiaok-cli/docs/2026-06-06-esc-interrupt-handoff-process.md`

---

## 1. 根因诊断

三条根因，不是孤立 bug：

| 根因 | 表现 | 现状 |
|------|------|------|
| **协议混淆** | `report_progress`（通知）被当作 `request_task`（指令）使用，对方可以装看不见 | broker 不区分，全进 inbox |
| **生命周期无人监控** | `request_task` 投递后无 `accept_task` 回应，PM 无感知，只能 grep inbox | reducer 有状态机，但无查询端点、无超时告警 |
| **工具异构 + 状态分裂** | `~/.intent-broker/<toolName>/<pid>.json`，跨工具不可达，agent 搞不清自己注册成谁 | `state-paths.js` 按 toolName 分目录 |

---

## 2. 改动范围

按 ROI 排序，4 项。前 3 项为协议层（broker），第 4 项涉及 adapter 层 + governance skill。

```
P0-A  任务看板 + 未确认告警     ←  PM 一条命令看"谁卡住了"
P0-B  send-task 强制化          ←  消灭"通知当派单"的根因
P1-A  participantId 优先存储    ←  消灭跨工具不可达的根因
P1-B  governance push gate 加严 ←  PM 主动收到批准请求，不依赖 agent 自觉
```

**不在本方案范围内：** 任务编排（拆解、优先级、谁该做）仍属上层 kswarm，broker 只管投递和生命周期信号。

---

## 3. P0-A: 任务看板 + 未确认告警

### 3.1 新增 HTTP 端点

```
GET /tasks?status=open&assignee=codex&limit=50
```

返回 reducer 计算后的 task 列表：

```json
{
  "tasks": [
    {
      "taskId": "esc-interrupt-pr1a",
      "threadId": "esc-interrupt-implementation",
      "status": "open",
      "assignees": [],
      "latestEventKind": "request_task",
      "latestEventAt": "2026-06-06T10:30:00Z",
      "ageMs": 1800000,
      "requesterId": "xiaok-session-019e8a70"
    }
  ]
}
```

**实现方式：** `buildState()` 已有完整 task 状态机。新增 `listTasks({ status, assignee })` 方法，遍历 `buildState().tasks`，关联 `store.listEvents` 获取最新事件时间戳。

**性能约束：** `buildState()` 每次 `reduceEventStream` 全量事件。当前事件量数千级，PM 低频查询可接受。高频场景需加缓存（`appendIntent` 后 invalidate），暂不实现。

**文件变更：**
- `src/broker/service.js` — 新增 `listTasks()` 方法
- `src/http/server.js` — 新增 `GET /tasks` 路由

### 3.2 未确认告警 (watchdog)

**规则：** `request_task` 事件投递后 **5 分钟**，如果该 taskId 下没有 `accept_task`、`decline_task`、`report_progress`（stage=started）任一事件，broker 自动向拥有 `governance-pm` 角色的 participant 定向发送 `task_unacked` 事件。

**payload 结构：**

```json
{
  "kind": "task_unacked",
  "taskId": "esc-interrupt-pr1a",
  "threadId": "esc-interrupt-implementation",
  "ageMs": 300000,
  "requesterId": "xiaok-session-019e8a70",
  "targetParticipantId": "codex-session-019e9a90"
}
```

**运行时 watchdog：**
- 在 `service.js` 的 `sendIntentInternal` 中，当 `kind === 'request_task'` 且 `to.mode === 'participant'`（定向派单）时，注册一个 `setTimeout(5min)` 检查
- broadcast 的 `request_task` 不触发 watchdog（竞标场景，不属于定向派单）
- 检查逻辑：`buildState().tasks[taskId]` 的 status 是否仍为 `open`
- 如果是，查询 `participant_roles` 表找到所有 `role = 'governance-pm'` 的 participant，定向发送
- agent 下线（presence → offline）时不取消定时器——PM 需要知道任务卡住了，不管对方在不在线
- 定时器触发后自动清除，不重复告警

**启动时 reconcile（解决 broker 重启后定时器丢失）：**

broker 启动时执行 `reconcileWatchdogs()`：

```
1. buildState() 找到所有 status === 'open' 的 task
2. 对每个 open task 查 store.listEvents({ taskId }) 取最新事件时间戳
3. 计算 age = now - latestEventAt
4. 检查该 taskId 是否已有 task_unacked 事件且 age < 30min → 跳过（去重）
5. age > 5min 且无近期 unacked → 立即发送 task_unacked
6. age < 5min → 注册 setTimeout(remainingMs) 定时器
```

去重规则：同一个 taskId 在 30 分钟内最多发送一次 `task_unacked`，防止 broker 反复重启时重复告警。

**`task_unacked` 注册为合法 intent kind：**
- `src/intent-types.js` — `INTENT_KINDS` 数组新增 `'task_unacked'`
- `src/domain/reducer.js` — switch 中跳过（`default: break`），不改变 task 状态

### 3.3 CLI 支持

```bash
# 列出所有 open 任务
intent-broker tasks --status open

# 列出某 agent 的任务
intent-broker tasks --assignee codex-session-019e9a90
```

**文件变更：**
- `bin/intent-broker.js` — 新增 `tasks` case

---

## 4. P0-B: send-task 强制化

### 4.1 CLI 可发现性

当前 `send-task` 在 `--help` 输出中不可见。修复：

```
Commands:
  send-task <to> <taskId> <threadId> <summary>  派任务给指定 agent（规范派单方式）
  task     <to> <taskId> <threadId> <summary>   send-task 的别名
  ask      <to> <taskId> <threadId> <summary>   问对方问题
  note     <to> <taskId> <summary>              发通知（不需回复）
  progress <taskId> <threadId> <summary>        更新任务进度
  ...
```

**约束：** `send-task` / `task` 命令必须是 `--help` 输出的第一项。

### 4.2 broker 侧校验

`request_task` intent 的校验规则（在 `validators.js` 中）：

```
必须字段:
  - taskId（非空字符串）

拒绝条件:
  - 该 taskId 已存在 submit_result 事件 → 返回 409 task_already_completed
```

**注意：** 不拒绝 broadcast `request_task`。broadcast 模式用于 PM 发布任务让多个 coder 竞标，是合法用例。只有定向派单（`to.mode === 'participant'`）才触发 watchdog。

### 4.3 governance skill 规则

在 `kai-project-governance/references/` 新增 `handoff-protocol.md`，SKILL.md 路由引用：

> **跨 agent handoff 必须使用 `send-task`（生成 `request_task` 事件）。**
> `report_progress` 只能在已存在的 taskId 上追加状态。
> `reply` 只能回复已收到的消息（依赖 recentContext）。
> 首次派单场景一律用 `send-task`。

---

## 5. P1-A: participantId 优先的 state 存储

### 5.1 当前问题

```
~/.intent-broker/
  ├── xiaok-code/
  │   └── xiaok-session-019e8a70.json     ← xiaok adapter 能找到
  ├── claude-code/
  │   └── claude-session-01ed2d01.json    ← claude adapter 能找到
  └── codex/
      └── codex-session-019e9a90.json     ← codex adapter 能找到
```

xiaok 的 session 想给 codex4 发 reply，但 `reply` 命令读自己的 state 目录，找不到 codex4 的 recentContext。

### 5.2 目标结构

```
~/.intent-broker/
  └── sessions/
      ├── xiaok-session-019e8a70.json      ← 所有 adapter 互通
      ├── claude-session-01ed2d01.json
      └── codex-session-019e9a90.json
```

每个 state file 内容增加 `toolName` 字段（纯元数据，不影响路径）：

```json
{
  "participantId": "codex-session-019e9a90",
  "toolName": "codex",
  "lastSeenEventId": 51788,
  "recentContext": { ... }
}
```

### 5.3 迁移

`state-paths.js` 变更：

```js
// 旧
export function resolveToolStateRoot(toolName, { homeDir }) {
  return path.join(homeDir, '.intent-broker', toolName);
}

// 新
export function resolveParticipantStatePath(toolName, participantId, { homeDir }) {
  return path.join(homeDir, '.intent-broker', 'sessions', `${participantId}.json`);
}
```

**向后兼容：** 新路径读不到时 fallback 到旧路径，读完后写新路径（自动迁移）。一个 session 周期内完成迁移，零停机。

```js
export function resolveParticipantStatePath(toolName, participantId, { homeDir } = {}) {
  const newPath = path.join(homeDir, '.intent-broker', 'sessions', `${participantId}.json`);
  if (existsSync(newPath)) return newPath;

  const legacyPath = path.join(homeDir, '.intent-broker', toolName, `${participantId}.json`);
  if (existsSync(legacyPath)) return legacyPath;  // 下次写入时自动迁移到 newPath

  return newPath;  // 新 session，直接用新路径
}
```

**迁移是惰性的：** 只读不写的 session 不会触发迁移，旧目录 `~/.intent-broker/<toolName>/` 会残留文件。不影响正确性，后续可用一次性脚本清理。

**所有 `resolve*StatePath` 函数统一走 `resolveParticipantStatePath`**（`resolveRealtimeQueueStatePath`、`resolvePendingToolUseStatePath` 等同理）。

`resolveToolStateRoot` 保留但 deprecated，仅供迁移脚本使用。

### 5.4 `who-am-i` 可发现性

新增 CLI 命令：

```bash
intent-broker who-am-i
# 输出:
# participantId: codex-session-019e9a90
# alias: codex4
# toolName: codex
# statePath: ~/.intent-broker/sessions/codex-session-019e9a90.json
```

从 state file 或环境变量推导，不依赖网络请求。

---

## 6. P1-B: governance push gate 加严

### 6.1 当前问题

pre-push hook 在 PM 不在线时 fallback 到 lint check，不阻塞 push。导致 agent 可以"声称完成但不 push"或"push 了但 PM 不知道"。

### 6.2 新规则

```
if PM is online (presence === 'online'):
    必须发送 request_approval 并等待 respond_approval
    超时 5 分钟 → exit 1（push 被阻塞）
    PM 拒绝 → exit 1

if PM is offline:
    push 前定向发送 report_progress 给 governance-pm 角色
    包含 commit hash、branch、diff summary
    继续允许 push（不阻塞，但留痕）
    PM 上线后在 inbox 中收到
```

**不再有 lint fallback。** PM 在线 = 必须审批，PM 离线 = 定向留痕放行。

### 6.3 实现

修改 `kai-project-governance/scripts/pre-push-hook.sh`：
- `broker who` 查询 PM presence（按 `governance-pm` 角色查找）
- PM online → 调 `sendAsk`（kind=request_approval），轮询等待
- PM offline → 调 `sendProgress`（kind=report_progress），`to.mode=participant` 定向发给 PM participantId

---

## 7. 文件变更清单

| 文件 | 改动 | 优先级 |
|------|------|--------|
| `src/broker/service.js` | 新增 `listTasks()`；`sendIntentInternal` 加 watchdog 定时器；启动 `reconcileWatchdogs()` | P0-A |
| `src/http/server.js` | 新增 `GET /tasks` 路由 | P0-A |
| `src/intent-types.js` | `INTENT_KINDS` 新增 `'task_unacked'` | P0-A |
| `src/domain/reducer.js` | 不变（`task_unacked` 走 default） | P0-A |
| `bin/intent-broker.js` | `tasks` 命令；`--help` 输出重排 | P0-A/B |
| `src/domain/validators.js` | `request_task` 校验规则加严 | P0-B |
| `adapters/hook-installer-core/state-paths.js` | participantId-first 路径 + fallback | P1-A |
| `kai-project-governance/references/handoff-protocol.md` | 新增 | P0-B |
| `kai-project-governance/SKILL.md` | 引用 handoff-protocol | P0-B |
| `kai-project-governance/scripts/pre-push-hook.sh` | push gate 逻辑 | P1-B |

---

## 8. 向后兼容约束

1. **`task_unacked` 是新事件类型**：旧 adapter 不识别会走 `default: break`，无害
2. **`GET /tasks` 是新端点**：旧 adapter 不调用，无害
3. **state 路径迁移**：读时 fallback，写时自动迁移，零停机
4. **`request_task` 校验加严**：现有 `send-task` 调用已满足所有新校验规则，不影响
5. **broadcast `request_task` 不受影响**：校验不拒绝 broadcast，仅不触发 watchdog

---

## 9. 验收标准

- [ ] `GET /tasks?status=open` 返回所有 open task，含 ageMs
- [ ] `request_task` 定向投递后 5 分钟无 accept → PM 收到 `task_unacked`
- [ ] broker 重启后 `reconcileWatchdogs()` 补发超时告警
- [ ] 同一 taskId 30 分钟内不重复发送 `task_unacked`
- [ ] broadcast `request_task` 正常通过，不触发 watchdog
- [ ] `intent-broker tasks --status open` CLI 可用
- [ ] `send-task` 出现在 `--help` 第一项
- [ ] state file 写入 `~/.intent-broker/sessions/`，旧路径仍可读
- [ ] `intent-broker who-am-i` 返回 participantId + toolName + statePath
- [ ] pre-push hook：PM online 时必须 approval 才能 push
- [ ] pre-push hook：PM offline 时定向留痕（非 broadcast）
