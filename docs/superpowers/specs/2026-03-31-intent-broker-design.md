# Intent Broker Design

日期：2026-03-31

## 1. 背景与目标

`Intent Broker` 是一个本地优先的协作协议 broker，用来协调多种 agent 客户端与人类参与者之间的任务协作。它不替代 Codex、Claude Code、OpenCode 这类 agent 的推理能力，也不替代它们各自的运行时；它只负责承载协作协议、路由意图、维护任务状态、保存可重放事件，并提供可靠的本地消息收发面。

第一版的目标是解决以下问题：

- 多个本地 agent 窗口之间缺少统一、可靠、可审计的协作通道。
- 现有“直接聊天”方式缺少任务语义，无法稳定表达认领、澄清、进度、交付和审批。
- 仅依赖 WebSocket 连接做实时通讯，一旦断线就容易丢失关键任务上下文。
- 不同 agent 对固定接口的适配成本高，但它们对“带结构骨架的自然语言意图”理解能力较强。

`v1` 的成功标准是：

- 本地单机可运行。
- 支持 `agent + human` 两类参与方。
- 核心流程覆盖 `任务协作 + 审批`。
- 协议采用“结构骨架 + 自然语言正文”的混合模式。
- 可靠性以“先落事件，再投递”为基础。
- 主消费模型是 `HTTP pull`，不要求 agent 常驻长连接。

## 2. 非目标

`v1` 明确不做以下内容：

- 局域网或远程多机器协作。
- 多租户、组织级权限系统。
- 云端身份认证或 OAuth 集成。
- 插件市场、远程节点发现、服务注册中心。
- 任意自定义状态机或工作流 DSL。
- 直接执行 shell、git、test、browser 等工具调用。
- 替各家 agent 建模其内部 conversation/session 协议。

这些能力都可以在后续版本建立在 `v1` 的事件模型与意图协议之上扩展。

## 3. 设计原则

系统设计遵循以下原则：

- 本地优先：先解决单机多个 agent/human 协作问题。
- 协议优先：先稳定定义任务语义和状态推进，再考虑更多客户端。
- 可靠优先：关键意图不能依赖在线连接是否存活。
- 事件优先：所有事实先写入事件日志，再生成查询视图。
- 幂等优先：允许至少一次投递，客户端通过 `intent_id` / `event_id` 去重。
- 简化接入：客户端可以在 hook、空闲点、任务完成后主动 pull，不强制常驻。
- 语义克制：broker 只理解少量高价值意图，不演化成通用聊天服务器。

## 4. 核心概念

### 4.1 Participant

`Participant` 表示协议参与方，分为两类：

- `agent`
- `human`

每个参与方都具有稳定 `participant_id`，以及以下基础属性：

- `display_name`
- `kind`
- `roles`
- `capabilities`
- `presence`
- `last_seen_at`

`roles` 用于粗粒度职责寻址，例如 `coder`、`reviewer`、`approver`。`capabilities` 用于细粒度能力寻址，例如 `frontend.react`、`git.write`、`ppt.export`。

### 4.2 Intent

`Intent` 表示一次协作动作。它不是纯文本消息，而是：

- 少量稳定的结构化字段
- 一段面向大模型和人类都易理解的自然语言正文

broker 原生理解 `kind` 和少数字段语义，但不需要理解正文里的技术细节。

### 4.3 Task

`Task` 表示长生命周期的工作对象。一个任务会经过认领、执行、澄清、审批、提交和完成等阶段。任务状态不是客户端直接写入，而是 broker 根据一系列 intent 事件推导出来。

### 4.4 Thread

`Thread` 表示围绕单个任务展开的上下文流。澄清、进度、交付、审批请求都可以挂在同一线程上，避免协作上下文分裂成多个互不关联的消息链。

### 4.5 Approval

`Approval` 表示一个需要指定参与方批准或拒绝的决策点。审批节点独立于任务状态存在，但会影响任务是否处于 `blocked`、`submitted` 或 `completed`。

## 5. 协议边界

`Intent Broker` 的职责限定为：

- 接收和校验客户端发来的 intent。
- 将 intent 写入 append-only 事件日志。
- 根据寻址规则将事件投递到一个或多个 inbox。
- 维护 task、thread、approval 的聚合视图。
- 提供拉取、确认、查询、重放接口。
- 应用少量本地策略，例如审批必需条件或易失事件 TTL。

`Intent Broker` 不负责：

- 模型推理与 prompt 组织。
- 具体工具执行。
- 自动生成任务计划。
- 理解各家 agent 内部的原生 message schema。
- 将任务直接映射成 IDE/终端操作。

## 6. 寻址模型

`v1` 支持四种寻址方式：

- `participant`：点对点指定目标参与方。
- `role`：发给具有某个角色的参与方。
- `capability`：发给具备某项能力的参与方。
- `broadcast`：向一个筛选范围内的多个参与方广播。

广播模式允许多个候选者响应同一任务。broker 负责记录候选响应，并根据任务的认领模式推进状态。

## 7. 任务认领模型

`v1` 同时支持三类行为：

- 显式接单：通过 `accept_task` 认领任务。
- 先响应后确认：多个候选人先响应，再由发起方选定。
- 协作接单：允许多个参与方共同承担同一任务。

因此 `Task` 需要有一个 `assignment_mode`：

- `single`
- `collaborative`

默认模式为 `single`。广播任务默认允许产生多个候选者，但最终只会确认一个执行方；只有显式声明为 `collaborative` 时，才允许多个执行方同时进入正式承担状态。

## 8. Intent 结构

`v1` 的 intent 统一采用如下结构：

```json
{
  "intent_id": "int_01H...",
  "kind": "request_task",
  "from": {
    "participant_id": "human.song"
  },
  "to": {
    "mode": "broadcast",
    "participants": [],
    "roles": ["coder"],
    "capabilities": ["frontend.react"]
  },
  "thread_id": "thr_01H...",
  "task_id": "task_01H...",
  "priority": "normal",
  "requires_approval": false,
  "body": {
    "title": "修复导出 PPT 字体问题",
    "summary": "请排查字体回退到 Calibri 的根因，并给出修复",
    "details": "原始 HTML 使用微软雅黑，导出的 PPT 变成了 Calibri。",
    "constraints": [
      "不要改 themes 格式",
      "先定位根因再改"
    ],
    "deliverables": [
      "根因说明",
      "修复代码",
      "验证结果"
    ]
  },
  "metadata": {
    "tags": ["bugfix", "ppt-export"],
    "ttl_seconds": 86400
  }
}
```

字段说明如下：

- `intent_id`：全局唯一 ID，用于幂等去重。
- `kind`：意图种类，broker 用它决定状态推进和路由行为。
- `from`：发送方。
- `to`：目标寻址规则。
- `thread_id`：所属线程。
- `task_id`：所属任务。
- `priority`：优先级。
- `requires_approval`：此动作是否会触发审批节点。
- `body`：自然语言主体，对 LLM 和人都可读。
- `metadata`：标签、TTL、来源客户端等附加控制信息。

## 9. 最小意图集合

`v1` 的 broker 原生支持以下十类意图：

1. `request_task`
2. `accept_task`
3. `decline_task`
4. `ask_clarification`
5. `answer_clarification`
6. `report_progress`
7. `submit_result`
8. `request_approval`
9. `respond_approval`
10. `cancel_task`

这套意图集覆盖了任务发起、认领、澄清、执行、交付和审批的闭环。`v1` 不把 `presence`、`typing`、`tool_call` 之类易膨胀的语义放进核心协议。

## 10. 任务状态机

`Task` 的聚合状态限定为：

- `open`
- `candidate`
- `assigned`
- `in_progress`
- `blocked`
- `submitted`
- `completed`
- `cancelled`
- `failed`

### 10.1 状态推进规则

- `request_task` 创建任务，并将其置为 `open`。
- 若收到一个或多个 `accept_task`，任务进入 `candidate`；若无需候选筛选，也可以直接进入 `assigned`。
- 执行方首次发出开始性质的 `report_progress` 后，任务进入 `in_progress`。
- 当存在阻塞性的 `ask_clarification` 或 `request_approval` 时，任务进入 `blocked`。
- 收到 `submit_result` 后，任务进入 `submitted`。
- 发起方确认结果，或结果所需审批通过后，任务进入 `completed`。
- 收到 `cancel_task` 后，任务进入 `cancelled`。
- 执行方明确声明无法继续且发起方不要求重试时，任务进入 `failed`。

### 10.2 状态约束

- `completed` 不直接回退到 `in_progress`。若需要返工，应创建 follow-up task。
- `cancelled` 与 `failed` 是终止态。
- `submitted` 不等于 `completed`。如任务定义需要人工确认，提交结果后仍停留在 `submitted`。

## 11. 审批状态机

`Approval` 是独立聚合对象，状态限定为：

- `pending`
- `approved`
- `rejected`
- `expired`
- `cancelled`

规则如下：

- `request_approval` 创建一个新的 approval 并置为 `pending`。
- `respond_approval` 将其推进为 `approved` 或 `rejected`。
- broker 可依据 TTL 将长期无响应的审批置为 `expired`。
- 当审批失效或任务取消时，审批可被置为 `cancelled`。

审批和任务解耦：

- 一个任务可以关联多个审批节点。
- 审批被拒绝时，任务不一定失败，可以退回 `assigned` 或保持 `blocked`。
- 审批通过只表示决策通过，不代表任务自动完成；是否进入 `completed` 取决于任务当前阶段。

## 12. 可靠性模型

可靠性是 `v1` 的核心约束。系统采用以下模型：

- SQLite 事件日志作为事实源。
- WebSocket 仅作为可选实时推送通道，不承担可靠存储职责。
- HTTP pull 是主消费模型。
- 每个 participant 拥有独立 inbox 和消费 cursor。
- 采用至少一次投递语义。
- 客户端必须通过 `intent_id` / `event_id` 做幂等处理。
- 所有关键动作都要求显式 `ack`。
- 支持按 cursor、task、thread 的事件重放。

### 12.1 连接与交付分离

系统不把“客户端在线”与“事件已交付”混为一谈：

- 在线只影响是否能收到实时推送。
- 未消费事件仍保存在 inbox 中，直到被确认或被策略处理。
- 断线不会改变任务状态。

### 12.2 事件分类

事件按保留策略分为两类：

- 关键事件：`request_task`、`accept_task`、`submit_result`、`request_approval`、`respond_approval`、`cancel_task`
- 易失事件：某些 `report_progress` 或 `presence` 类事件

规则如下：

- 关键事件默认不可自动丢弃。
- 易失事件可设置 TTL，或被更新状态覆盖。
- 即使发生丢弃，也必须生成可审计的 discard 记录。

### 12.3 重连与重放

客户端应保存自己最后成功 `ack` 的 cursor。重连后可以：

- 从 `after=cursor` 拉取缺失 inbox 项。
- 按 `task_id` 拉取某任务完整历史。
- 按 `thread_id` 拉取某线程上下文。
- 按时间范围重放审计事件。

## 13. 冲突与幂等策略

为降低实现复杂度，`v1` 采用以下冲突处理原则：

- 多个参与方同时 `accept_task`：
  - `assignment_mode=single` 时进入 `candidate`，等待确认。
  - `assignment_mode=collaborative` 时允许多个执行方成立。
- 多个参与方同时 `submit_result`：
  - 不互相覆盖，全部挂到同一 task 的 submissions 集合中。
- 重复上报 `report_progress`：
  - 历史保留，当前视图仅显示最新一条。
- 重复发送相同 `intent_id`：
  - broker 视为幂等重试，不重复推进状态。

## 14. 系统架构

`v1` 选择的技术路线是：

- 本地单进程 broker
- SQLite 事件存储
- HTTP pull 为主的客户端消费模型
- 可选 WebSocket 推送增强

整体组件分为六个部分：

### 14.1 broker-server

提供本地 HTTP API，并可选提供 WebSocket 新事件通知。负责接收客户端请求，调用存储、路由和投影层。

### 14.2 event-store

基于 SQLite 的 append-only 事件存储。所有 intent 相关事实先写入这里，再由其他层读取。

### 14.3 projection-engine

从事件流派生出当前查询视图，例如 `TaskView`、`ApprovalView`、`InboxItem`、`ThreadTimeline`。

### 14.4 router

根据 `to.mode` 和参与方能力信息，把事件映射到目标 inbox。负责点对点、角色、能力和广播路由。

### 14.5 policy-layer

负责局部策略决策，例如：

- 哪些动作需要审批。
- 哪些事件是易失的。
- 默认认领模式是什么。
- 某类角色是否允许响应某种任务。

### 14.6 client-adapters

为 Codex、Claude Code、OpenCode 等环境提供薄适配层，将各家运行时事件转换为统一 intent 协议。适配器不负责任务状态真相，只负责收发协议。

## 15. 数据模型

`v1` 至少需要以下持久化实体：

- `participants`
- `threads`
- `tasks`
- `approvals`
- `events`
- `inbox_entries`
- `participant_cursors`
- `task_submissions`

### 15.1 events

`events` 是系统事实源，核心字段包含：

- `event_id`
- `intent_id`
- `kind`
- `from_participant_id`
- `task_id`
- `thread_id`
- `payload_json`
- `created_at`

### 15.2 inbox_entries

`inbox_entries` 记录投递关系而不是事实本身，核心字段包含：

- `inbox_entry_id`
- `event_id`
- `participant_id`
- `delivery_status`
- `acked_at`
- `discarded_at`

### 15.3 participant_cursors

记录每个参与方确认消费到的位置，支持断点续传。

## 16. API 面

`v1` 的 HTTP API 收敛为以下接口：

- `POST /participants/register`
- `POST /participants/presence`
- `POST /intents`
- `GET /inbox/{participant_id}?after={cursor}&limit={n}`
- `POST /inbox/{participant_id}/ack`
- `GET /tasks/{task_id}`
- `GET /threads/{thread_id}`
- `POST /approvals/{approval_id}/respond`
- `GET /events/replay`

### 16.1 API 返回对象

系统至少提供四种稳定返回对象：

- `Event`
- `InboxItem`
- `TaskView`
- `ApprovalView`

查询接口返回投影对象，重放接口返回原始事件对象。

## 17. 客户端接入模式

`v1` 的客户端接入假设如下：

- agent 不需要常驻监听 broker。
- agent 可以在 hook、任务完成点、审批前后、空闲轮询点主动 pull。
- agent 需要保存自身 `participant_id` 与最近一次 `cursor`。
- 客户端若支持 WebSocket，可把它作为低延迟提醒，但不能把它当作唯一消息源。

这使得 `Intent Broker` 能自然适配：

- Codex 类可调用本地 HTTP 的工具环境
- Claude Code / OpenCode 类带 hook 或脚本回调的环境
- 后续移动端或桌面端的人类参与者界面

## 18. 安全与权限边界

`v1` 仅做本地单机使用，因此安全模型保持克制：

- 默认绑定 localhost。
- 不暴露公网接口。
- 权限主要通过本地策略层和 participant 声明约束。
- 审批用于防止关键动作在协作层被静默推进。

`v1` 不引入复杂认证系统，但要求所有写操作都带 `participant_id`，并记录审计事件。

## 19. 测试策略

`v1` 的验证需要覆盖以下层次：

### 19.1 协议单元测试

验证 intent 解析、字段校验、幂等去重、状态推进规则。

### 19.2 路由测试

验证点对点、角色、能力、广播四类寻址行为，以及 `single` / `collaborative` 两类认领模式。

### 19.3 可靠性测试

验证以下场景：

- 先写事件再投递。
- 未 ack 事件在重连后可补拉。
- 重复 ack 不产生异常。
- 相同 `intent_id` 重试不会重复推进状态。
- 易失事件 TTL 生效但有 discard 审计记录。

### 19.4 集成测试

验证一条完整的任务流：

1. human 发起广播任务
2. 多个 agent 认领
3. 发起方选定执行者
4. agent 发起澄清
5. human 作答
6. agent 汇报进度
7. agent 请求审批
8. human 批准
9. agent 提交结果
10. 任务完成

## 20. 演进路径

`v1` 完成后，后续版本可以在不破坏协议核心的前提下扩展：

- 局域网和远程部署模式
- 更强的身份认证
- 文件邮箱兼容层
- WebSocket first 的实时协作客户端
- 更细粒度的 policy 插件
- 面向手机或桌面的审批/通知 UI

这些扩展都应建立在 `events + projections + stable intents` 的基础上，而不是推翻 `v1` 协议。

## 21. 结论

`Intent Broker` 的 `v1` 不是一个聊天系统，也不是一个工作流巨兽，而是一个本地优先、可靠优先、协议优先的协作中间层。它通过少量稳定意图、事件日志、HTTP pull 和审批机制，把多 agent 与人类协作这件事从“靠复制粘贴和临时约定”提升为“可重放、可审计、可恢复”的本地基础设施。
