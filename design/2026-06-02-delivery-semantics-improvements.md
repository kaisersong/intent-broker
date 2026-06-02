# Cross-Agent Delivery Semantics Improvements

状态: 已评审，按分层原则收敛实现
日期: 2026-06-02
关联分析: `mydocs/intent-broker/design/2026-06-02-cross-agent-collaboration-delivery-analysis.md`
评审: Codex 对抗性评审（结论"需修改后合并"），见 §6

## 1. 背景

跨 agent 协作（Codex / QoderCLI / Claude Code / xiaok-code）出现一类反复发生的故障模式:
**"消息送到了，但对方没理解，事情没做"**。根因分析定位到四个问题:

- **P0 别名解析**: `to.participants` 只能用精确 sessionId，别名 / 逻辑名无法寻址，导致发错或发丢。
- **P0 进度/回复语义混淆**: `report_progress` 等信息类事件和 `request_task` 等行动类事件同样写入 inbox，淹没了真正需要响应的项。
- **P1 会话连续性**: 同一逻辑参与者换 session 后，历史寻址失效。
- **P1 跨项目可见性**: `who` 无法查看其它项目的参与者。

## 2. 分层原则（本方案的核心决策）

经评审后确立 intent-broker 的职责边界:

> **broker 是协议/传输层，只负责"意图可靠到达"，不解释、不裁决意图如何被处理。**
> **任务编排（谁该做、是否打断、如何拆解、完成标准）属于上层 kswarm。**

由此推导出每条改动的归属:

| 能力 | 归属 | 处理方式 |
|------|------|----------|
| 可靠投递 + 持久化（断线/pull 补漏） | **协议层** | 保留并加固 |
| 寻址解析（sessionId / alias / logical） | **协议层** | 保留，修命名冲突 |
| `who --project` 可见性 | **协议层** | 保留，接入真实入口 |
| `kind` / `semantic` 元数据 | **协议层** | 仅透传存储，不做投递裁决 |
| inbox 按 actionable/informational 分流 | **编排层** | **回退**：全部可靠入 inbox，读取端过滤 |
| fanout 策略（选最佳 session vs 广播全部） | **编排层** | broker 只解析地址，不决定扇出 |
| reply_message 是否 actionable / 是否打断 | **编排层** | broker 不分类 |
| task 结构化语义（intent/done-when/reply-with） | **编排层** | 移出协议 CLI |

这条原则同时消解了 Codex 评审中最重的 P0/P1：分流丢消息（P0#1）、fanout 过度（P1#3）、reply 语义分裂（P1#5）、结构化 summary 未接真实入口（P2#6）——它们本质都是协议层越界做了编排层的事。

## 3. 协议层保留并加固的改动

### 3.1 寻址解析 + 命名冲突修复 (P0)

`resolveRecipients` 对 `mode === 'participant'` 解析顺序:精确 sessionId > 别名 > 逻辑名 > 原样保留。

修复 Codex P1#4 命名冲突:
- 支持显式命名空间 `session:<id>` / `logical:<id>` / `@alias`，消除"别名与逻辑名同名时 fanout 被吞"的歧义；
- 裸字符串保留兼容；当多类同时命中时在 response 暴露 `resolutionKind`，不静默决定。

### 3.2 可靠投递（回退分流）(P0)

- **全部 recipient 都写 `inbox_entries`**，保证断线/pull 消费方能补到（修复 Codex P0#1 丢消息）。
- `delivery.semantic` 降级为**纯元数据**：broker 存储并透传，不再据此决定是否入 inbox。
- 消费端读取时按需过滤：`readInbox` / `pollInbox` / CLI 支持 `kind` 或 `semantic` 过滤参数，默认行为由消费方/编排层决定。

### 3.3 逻辑参与者注册端到端 (P1)

修复 Codex P0#2（特性未接通）:
- `deriveSessionBridgeConfig` 生成 `logicalParticipantId`（codex / claude / qoder / xiaok）；
- 注册 API payload 携带该字段；
- broker `registerParticipant` / `pruneParticipant` 维护与清理 `logicalParticipants` 索引；
- 补端到端测试：同 logicalId 多 session 注册后寻址可解析。

**注意**：broker 解析逻辑名时只负责"展开为候选集合并暴露"，**不决定**发给全部还是选一个——扇出策略交给编排层（修复 Codex P1#3）。

### 3.4 who --project 接入真实入口 (P1)

修复 Codex P2#6：把 `--project` 解析从 `adapters/session-bridge/cli.js` 提升到真实入口 `bin/intent-broker.js`（或共享 command-runner），补 `tests/bin/` 覆盖。

## 4. 移出协议层 / 回退的改动

- **inbox 语义分流**：回退 §旧2.2，不再用 semantic 决定入 inbox。
- **reply_message 的 actionable 归类**：broker 不分类；`reply_message` 作为一个普通 kind 透传，是否打断由编排/消费端判断。
- **task 结构化 summary（`--intent/--done-when/--context-file/--reply-with`）**：从协议 CLI 移除，留待 kswarm 编排层定义。若短期保留，须同时写结构化字段而非仅 markdown（见 Codex P2#7），且接入真实入口。

## 5. 不做什么（边界）

- broker 不引入意图状态机 / 强 schema / 必填字段 / 投递裁决。
- broker 不决定"谁该响应"或"是否打断"。
- 寻址失败仍可见（保留原样 id + resolutionKind），不静默丢弃。

## 6. Codex 对抗性评审结论摘要

整体结论：**需修改后合并**。关键发现与本方案处置:

- **P0#1 分流丢消息**：events 表不存 recipients，不写 inbox 即无收件人视角持久依据，断线补漏也从 inbox 拉 → **本方案回退分流，全部可靠入 inbox**。
- **P0#2 logicalId 未端到端**：注册路径没生成/发送该字段 → **本方案补 config + 注册 API + 端到端测试**。
- **P1#3 fanout 过度**：展开全部活跃 session 易致重复执行 → **本方案：broker 不决定扇出，交编排层**。
- **P1#4 alias/logical 命名冲突**：别名吞掉逻辑 fanout，无歧义提示 → **本方案：显式命名空间 + resolutionKind**。
- **P1#5 reply 语义分裂**：actionable 与 hook/skill/auto-mirror 不一致 → **本方案：broker 不分类**。
- **P2#6 结构化 summary 未接真实入口**：只在 session-bridge cli 生效 → **本方案：移出协议层 / 若保留则接入真实入口**。
- **P2#7 markdown 非稳定协议**："降级无损"只对人类成立 → **结构化语义归编排层处理**。
