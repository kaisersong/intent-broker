# Self Review — Task Lifecycle Governance Design

**评审者:** @claude2 (claude-code-session-01ed2d01)
**视角:** 盲点猎手 — 跨切面问题、微妙时序、隐含假设
**日期:** 2026-06-06

---

## BLOCKER

### B1. watchdog 定时器在 broker 重启后丢失

**位置:** §3.2 未确认告警

**问题:** `setTimeout(5min)` 是纯内存状态。broker 进程重启（部署、crash、机器重启）后所有定时器丢失，正在等待 ack 的 `request_task` 永远不会触发 `task_unacked`。

**严重性:** BLOCKER — 这是生产环境最常见的场景，不是边界 case。

**建议修复:** broker 启动时加 `reconcileWatchdogs()` 扫描：
1. `buildState()` 找到所有 `status === 'open'` 的 task
2. 对每个 open task 计算 age（当前时间 - 最新事件时间）
3. age > 5min → 立即发送 `task_unacked`
4. age < 5min → 注册 `setTimeout(remainingMs)` 定时器

---

## HIGH

### H1. buildState() 全量 reduce 性能问题

**位置:** §3.1 GET /tasks

**问题:** `buildState()` 每次调用 `reduceEventStream(store.listEvents())`，遍历全部事件。当前事件量已数千条，`GET /tasks` 每次 HTTP 请求都全量 reduce，高频查询下会成为瓶颈。

**建议修复:** 缓存 `buildState()` 结果：
- broker 启动时 build 一次，缓存到内存
- `appendIntent` 后 invalidate 缓存（标记 dirty，下次访问时 rebuild）
- 或在 event-store 层用 SQL 直接查 task 状态（但需维护 task 状态表，复杂度高）

短期方案：每次 `GET /tasks` 调用时 build，因为 PM 不会高频查询。design doc 应标注此性能约束和优化路径。

### H2. broadcast request_task 硬拒绝会破坏竞标场景

**位置:** §4.2 broker 侧校验

**问题:** 方案写"拒绝 broadcast request_task"。但实际存在 PM broadcast 一个 task 让多个 coder 竞标的用例（谁先 accept 谁做）。硬拒绝会破坏这个模式。

**建议修复:** broadcast 的 `request_task` 应该允许，但：
- 不触发 watchdog（broadcast task 不属于定向派单）
- 不要求 `to.participants.length >= 1`（broadcast 本来就没有）

### H3. push gate 离线模式的 report_progress 应定向发 PM

**位置:** §6.2 push gate

**问题:** 方案写 PM 离线时用 `report_progress` 留痕。但 `sendProgress` 当前是 broadcast 事件，发到所有人的 inbox。PM 离线期间沉淀的消息在 PM 上线后可能被大量无关事件淹没。

**建议修复:** 离线留痕也应定向发给 `governance-pm` 角色的 participant，而非 broadcast。需要 `sendProgress` 支持 `to.mode === 'participant'`。

---

## MEDIUM

### M1. 迁移是惰性的，旧目录长期残留

**位置:** §5.3 迁移

**问题:** fallback 读取旧路径，写入时才迁移到新路径。如果一个 session 只读不写（只 poll inbox），对应文件永远不会迁移。旧目录 `~/.intent-broker/<toolName>/` 会长期残留文件。

**影响:** 不影响正确性（新路径读不到会 fallback），但旧目录持续存在可能造成混淆。

**建议:** 在 design doc 中注明迁移是惰性的，不保证时间线。可在 v2 提供一次性清理脚本。

### M2. task_unacked 重复告警无防护

**位置:** §3.2 未确认告警

**问题:** 方案写"定时器触发后自动清除，不重复告警"。但如果 broker 重启后 `reconcileWatchdogs()` 再次扫描到同一个 open task，会再次发送 `task_unacked`。没有去重机制。

**建议:** 在 event-store 中记录已发送的 `task_unacked` 事件，reconcile 时检查该 taskId 是否已有 `task_unacked` 事件（且 age < 30min），避免短时间重复告警。

### M3. send-task --help 重排可能影响现有用户肌肉记忆

**位置:** §4.1 CLI 可发现性

**问题:** 现有用户习惯了当前 --help 输出顺序。重排可能导致短暂困惑。

**建议:** 影响极小，不改。仅标注为已知差异。
