# Intent Broker

[English version](./README.md)

本地优先的多 Agent 协作 broker。它不是聊天服务器，也不是工作流平台，而是一层可靠的协作协议中间层：先持久化事件，再进行投递；让 Codex、Claude Code、OpenCode 这类 agent 与人类参与方围绕同一任务对象协作。

当前发布版本：`0.1.0`

## 设计思想

`Intent Broker` 的设计重点不是“让多个窗口能互相发消息”，而是把协作从临时复制粘贴提升为一套可恢复、可重放、可审计的协议。

核心思路有四个：

- 事件优先：所有意图先写入 SQLite 事件日志，再做 inbox 投递和状态聚合。
- 协议优先：用少量稳定的结构字段承载任务语义，用自然语言正文承载具体工作意图。
- 本地优先：第一版只解决单机协作，不依赖远程服务，不要求 agent 常驻连接。
- 可靠优先：`HTTP pull + ack cursor` 是主消费路径，连接断开不会丢关键任务上下文。

这意味着 broker 真正负责的是：任务、线程、审批、路由和重放；而不是代替各家 agent 做推理或执行工具。

## 应用场景

这个项目适合以下场景：

- 同一台机器上开多个 Codex / Claude Code / OpenCode 窗口，需要围绕同一任务协作。
- 人类参与者希望能插话、审批、接管或确认交付，而不是只看 agent 自己跑。
- 需要让 agent 在 hook、空闲点、任务结束时主动拉取待办，而不是常驻 websocket 连接。
- 需要保留任务时间线，支持重连后补拉、按 task/thread 重放、按事件追溯问题。
- 需要做更高层的 adapter、手机审批面板、局域网协作前，先把本地协议底座跑起来。

## 当前能力

当前原型已经支持：

- participant 注册
- 全局唯一 participant alias，冲突时自动加数字后缀
- 按项目查询 participant
- 记录并查询 participant 当前工作状态
- `request_task`、`report_progress`、`request_approval`、`respond_approval`
- 按 `participant`、`role`、`broadcast` 路由
- inbox pull 与 ack cursor
- `GET /tasks/:taskId`
- `GET /threads/:threadId`
- `GET /events/replay`
- `GET /work-state`
- SQLite 持久化事件存储
- WebSocket 实时通知通道
- 云之家 adapter 的真实入站 / 出站联调
- 面向真实 Codex 会话的非侵入 hook 接入
- 面向真实 Claude Code 会话的非侵入 hook 接入

## 技术选型

- Node 22
- 原生 ESM
- `node:http`
- `node:sqlite`
- `node:test`

这样做的目的很直接：今天就能跑起来，不引第三方运行时依赖，把协议和可靠性路径先验证掉。

## 快速开始

### 1. 安装环境

需要 Node 22 或更新版本。

### 2. 启动服务

```bash
npm start
```

默认监听：

- `http://127.0.0.1:4318`

可以通过环境变量覆盖：

```bash
PORT=4321
INTENT_BROKER_DB=./.tmp/intent-broker.db npm start
```

Windows PowerShell:

```powershell
$env:PORT='4321'
$env:INTENT_BROKER_DB='D:\projects\intent-broker\.tmp\intent-broker.db'
npm start
```

## 测试

```bash
npm test
```

自动化协作 smoke 验证：

```bash
npm run verify:collaboration
```

这条命令会临时启动一个本地 broker，走真实的 Codex 和 Claude Code bridge 入口，并把日志和分析结果写到 `.tmp/collaboration-smoke-*`。

当前测试覆盖：

- reducer 任务/审批状态推进
- SQLite store 的 append / inbox / ack / replay
- broker service 路由与审批聚合
- HTTP API 端到端流程
- Yunzhijia adapter 配置回归测试
- Yunzhijia adapter 入站 / 出站集成测试

说明：测试脚本使用了 `node --experimental-test-isolation=none --test`，因为当前沙箱环境下默认 `node --test` 会触发子进程 `EPERM`。

## API 概览

### Health

```http
GET /health
```

### Participants

```http
POST /participants/register
```

示例：

```json
{
  "participantId": "agent.a",
  "alias": "codex",
  "kind": "agent",
  "roles": ["coder"],
  "capabilities": ["frontend.react"],
  "context": {
    "projectName": "intent-broker"
  }
}
```

也可以查询 participant 列表，并按项目名过滤：

```http
GET /participants
GET /participants?projectName=intent-broker
```

按 alias 解析消息通道里的提及：

```http
GET /participants/resolve?aliases=codex,claude
```

修改 participant alias：

```http
POST /participants/:participantId/alias
```

示例：

```json
{
  "alias": "reviewer"
}
```

### Send Intent

```http
POST /intents
```

示例：

```json
{
  "intentId": "int-1",
  "kind": "request_task",
  "fromParticipantId": "human.song",
  "taskId": "task-1",
  "threadId": "thread-1",
  "to": {
    "mode": "participant",
    "participants": ["agent.a"]
  },
  "payload": {
    "body": {
      "summary": "请修复导出字体问题"
    }
  }
}
```

### Inbox Pull / Ack

```http
GET /inbox/:participantId?after=0&limit=50
POST /inbox/:participantId/ack
```

Ack body:

```json
{
  "eventId": 12
}
```

### Query Views

```http
GET /tasks/:taskId
GET /threads/:threadId
GET /events/replay?after=0&taskId=task-1
```

### Work State

保存或更新某个 participant 当前正在做的事：

```http
POST /participants/:participantId/work-state
```

示例：

```json
{
  "status": "implementing",
  "summary": "重构 broker work-state API",
  "taskId": "task-9",
  "threadId": "thread-9"
}
```

查询最新工作状态：

```http
GET /participants/:participantId/work-state
GET /work-state
GET /work-state?projectName=intent-broker
GET /work-state?participantId=codex.main
GET /work-state?status=blocked
```

### Approval Response

```http
POST /approvals/:approvalId/respond
```

示例：

```json
{
  "taskId": "task-1",
  "fromParticipantId": "human.song",
  "decision": "approved"
}
```

## 给智能体

如果你是 Claude Code、Codex、OpenCode、xiaok code 或其他代码智能体，`Intent Broker` 应该被当成协作协议层来使用，而不是聊天窗口。凡是涉及任务交接、进度同步、审批、人类插话、重启恢复，都应该优先通过 broker 来完成。

推荐这样使用：

### 1. 每次会话启动先注册自己

先注册一个 participant，再开始工作：

```http
POST /participants/register
```

示例：

```json
{
  "participantId": "codex.main",
  "kind": "agent",
  "roles": ["coder"],
  "capabilities": ["backend.node", "frontend.react"],
  "context": {
    "projectName": "intent-broker"
  }
}
```

推荐命名方式：

- `participantId`：稳定且能区分工具，例如 `claude-code.main`、`codex.review`、`opencode.worker-1`、`xiaok-code.backend`
- `alias`：给人和其他 agent 使用的短名，例如 `codex`、`claude`、`xiaok`；broker 会保证全局唯一，冲突时自动变成 `codex2`
- `roles`：粗粒度角色，例如 `coder`、`reviewer`、`approver`
- `capabilities`：细粒度能力，例如 `frontend.react`、`backend.node`、`docs.write`
- `context.projectName`：当前正在做的项目名，例如 `intent-broker`

为什么 `projectName` 重要：

- 可以直接问“谁在做 `intent-broker`？”
- 可以把任务优先发给已经在这个项目上的 agent
- 提交或交接前，可以先看这个项目上当前还有哪些协作者在线

如果你已经安装了 Codex 或 Claude Code 的 hook 桥接，那么会话注册会自动完成。当前 hook 也会在会话启动时自动上报一个初始 `idle` 工作状态，这样其他 agent 即使还没收到任务，也能先发现这个会话已经接入 broker。

现在 bridge 在注册时也会带上一个首选 alias 提示。最终 alias 由 broker 决定；如果撞名，broker 会自动追加数字后缀。

### 2. 优先用 inbox pull，不要假设必须常连

最可靠的消费路径是主动拉 inbox：

```http
GET /inbox/:participantId?after=0&limit=50
```

处理完当前事件后，用 ack 标记已消费：

```http
POST /inbox/:participantId/ack
```

这个设计是故意的。即使你的进程重启，只要重新连接并拉取 inbox，就不会丢失关键任务上下文。

几种标识要分开用：

- `taskId`：稳定的任务主键，协作时应该围绕它来讨论和查询
- `threadId`：稳定的对话 / 协商主键，回复时应该尽量沿用它
- `eventId`：只给 broker 内部做重放、增量拉取、ack 和排障游标

也就是说，agent 协作的主视角应该是 `taskId` 和 `threadId`，而不是裸 `eventId`。

### 3. 先查询项目现状，再决定接不接活

在接手同一个项目里的任务前，先问 broker 现在项目里发生了什么：

```http
GET /participants?projectName=intent-broker
GET /work-state?projectName=intent-broker
```

用这两个查询回答这些问题：

- 这个项目里现在有哪些 agent 在线
- 谁当前是 `idle`、`blocked`、`reviewing`、`implementing`
- 是否已经有人在处理同一个 task 或 thread

当前原型建议使用的 `work-state` 值：

- `idle`
- `planning`
- `implementing`
- `reviewing`
- `blocked`
- `waiting_approval`
- `ready_to_submit`

当你的工作焦点变化时，应该在发 progress 前后顺手更新自己的 work state。这是后续做自动协商和冲突规避的最小基础。

### 4. 用 alias 让人类更容易指挥 agent

人在消息通道里不应该再输入很长的 `participantId`，而应该直接用 alias：

- `@codex 修一下 broker 测试`
- `@claude @codex 一起排查这个回归`
- `@all 同步一下当前阻塞`

当前 v1 行为：

- alias 在整个 broker 范围内全局唯一
- 冲突时自动加数字后缀，例如 `codex2`
- alias 改名会生成 broker 广播事件，让已连接 client 感知到变化
- 云之家现在支持把 `@alias` 和 `@all` 精确解析成 broker 接收方
- 云之家也支持通过 `/alias @旧名 新别名` 直接改 participant alias

### 5. 发送 intent，而不是只发聊天文本

通过 `POST /intents` 发送有明确语义的协作事件，而不是临时消息。

典型模式：

- `request_task`：给其他 participant 或角色派任务
- `report_progress`：报告进度、阶段结果、阻塞
- `request_approval`：请求人类审批某个关键动作
- `respond_approval`：把人类审批结果写回任务流

进度更新示例：

```json
{
  "intentId": "progress-1",
  "kind": "report_progress",
  "fromParticipantId": "codex.main",
  "taskId": "task-1",
  "threadId": "thread-1",
  "to": {
    "mode": "participant",
    "participants": ["human.song"]
  },
  "payload": {
    "stage": "in_progress",
    "body": {
      "summary": "已经完成 adapter 握手，正在做验证"
    }
  }
}
```

## Codex 接入

当前最适合 Codex 的方式是“hook + skill”的非侵入接入，不改 Codex 原本启动方式，只是在本地安装两个 hook 和一个 skill：

- `SessionStart` hook：真实 Codex 会话启动或恢复时，静默向 broker 自动注册当前会话，记录当前 `projectName`，并上报一个初始 `idle` 工作状态。
- `UserPromptSubmit` hook：真实用户提交 prompt 前，会静默重注册当前会话，再检查是否有新到达的 broker 事件；只有确实存在待处理协作上下文时，才把它们注入当前 turn。
- `intent-broker` skill：给当前 Codex 会话一个明确的出站入口，用来发任务和发进度。

正常使用流程：

- 不要手动注册 Codex 会话
- 直接在目标项目目录里打开 Codex
- 让 `SessionStart` 在会话启动时自动完成静默注册
- 让 `UserPromptSubmit` 在 broker 重启后自动恢复注册，并且只在存在新协作消息时做 inbox 注入

### 安装 Codex 桥接

在仓库根目录执行：

```bash
npm run codex:install
```

如果你为了排障想保留原来的 hook 执行提示，可以改用：

```bash
node adapters/codex-plugin/bin/codex-broker.js install --verbose-hooks
```

这会写入或更新：

- `~/.codex/hooks.json`
- `~/.codex/skills/intent-broker`（符号链接）
- `~/.local/bin/intent-broker` 统一命令 shim
- `~/.intent-broker/codex/*.json` 本地 cursor 状态

现在 Codex 桥接在注册时会默认使用当前工作目录名作为 `projectName`。如果你想手动指定，可以设置 `PROJECT_NAME`。

说明：

- 这个安装过程会保留你已有的其他 Codex hooks，只替换旧的 `intent-broker` hook 项。
- 默认安装现在是静默的，不会在每次发消息时都打印 `Running ... hook: intent-broker ...`。
- 从本地 Codex 源码来看，生命周期 hooks 目前在 Windows 上还不支持，所以这条路径当前主要面向 macOS / Linux。
- 从当前真实 Codex 行为看，`SessionStart` 会在会话真正进入第一轮 turn 或 resume 流程时触发，而不是 TUI 刚画出来就立即触发。
- 现在 hook 输入里的 `session_id` 会优先于继承下来的 `CODEX_THREAD_ID`，所以即使你在一个 agent 环境里再拉起新的 Codex，也不会错误复用父会话的 participant id。
- 如果你把本仓库挪了位置，需要重新执行一次 `npm run codex:install`，刷新 hook 里的绝对路径。

### 在真实 Codex 会话里主动发消息

手动注册只保留给排障场景，例如你想确认当前会话推导出的 participantId：

```bash
intent-broker register
```

给另一个参与者发任务：

```bash
intent-broker send-task claude-real-1 real-task-1 real-thread-1 "请接手这个回归问题排查"
```

发送进度更新：

```bash
intent-broker send-progress real-task-1 real-thread-1 "还在排查 broker handoff 失败原因"
```

直接查看未读协作消息，不再手查 broker：

```bash
intent-broker inbox
```

查看同项目里谁在线、谁在做什么：

```bash
intent-broker who
```

直接沿用最近一次记住的 `taskId/threadId` 回复：

```bash
intent-broker reply "收到，开始处理"
```

如果要显式指定回复目标，可以用 alias 覆盖，但仍沿用最近的 `taskId/threadId`：

```bash
intent-broker reply @claude2 "请看一下最新补丁"
```

### 这套接入的意义

安装后，一个已经打开的真实 Codex 会话就能比较自然地参与多智能体通信：

- 保持原生启动方式
- 通过 hook 收到 broker 协作上下文，而不是再包一层 wrapper
- 通过统一的本地桥接命令主动发 task / progress

## Claude Code 接入

Claude Code 现在和 Codex 一样，也采用非侵入的 hook 桥接模式，只是安装位置放在项目级设置里：

- `SessionStart` hook：自动把 Claude Code 会话注册进 broker，并上报一个初始 `idle` 工作状态
- `UserPromptSubmit` hook：broker 重启后会静默重注册，并且只在确实有新到达 broker inbox 上下文时，才在 prompt 提交前注入

### 安装 Claude Code 桥接

在仓库根目录执行：

```bash
npm run claude-code:install
```

如果你为了排障想保留 hook 执行提示，可以改用：

```bash
node adapters/claude-code-plugin/bin/claude-code-broker.js install --verbose-hooks
```

这会写入或更新：

- `.claude/settings.json`
- `~/.local/bin/intent-broker` 统一命令 shim
- `~/.intent-broker/claude-code/*.json` 本地 cursor 状态

说明：

- 会保留你已有的其他 Claude Code hooks，只替换旧的 `intent-broker` hook 项
- 默认安装现在是静默的，不会在每次发消息时都打印 `Running ... hook: intent-broker ...`
- 现在 hook 输入里的 `session_id` 会优先于继承下来的 session 环境变量，避免嵌套拉起时多个客户端错误共用同一个 participant id
- 如果你把本仓库挪了位置，需要重新执行一次 `npm run claude-code:install`，刷新命令路径

### 在真实 Claude Code 会话里主动发消息

手动注册只保留给排障场景，例如你想确认当前会话推导出的 participantId：

```bash
intent-broker --tool claude-code register
```

给另一个参与者发任务：

```bash
intent-broker --tool claude-code send-task codex-real-1 real-task-1 real-thread-1 "请接手这个回归问题排查"
```

发送进度更新：

```bash
intent-broker --tool claude-code send-progress real-task-1 real-thread-1 "还在排查 broker handoff 失败原因"
```

直接查看未读协作消息：

```bash
intent-broker --tool claude-code inbox
```

查看同项目协作者和当前 work-state：

```bash
intent-broker --tool claude-code who
```

直接沿用最近一次记住的协作上下文回复：

```bash
intent-broker --tool claude-code reply "收到，开始处理"
```

如果要用 alias 强制改回复目标，也可以：

```bash
intent-broker --tool claude-code reply @codex2 "提交前先 rebase 一下"
```

### 6. 对关键动作使用审批流

当你准备做下面这些事时：

- 提交最终结果
- 发布或部署
- 执行破坏性操作
- 请求人类确认是否可以结束

优先发 `request_approval`，不要自己发一条随意格式的文本消息。这样审批状态才能被查询、被重放、被审计。

### 7. 重启后靠 replay 恢复，不要靠记忆

如果你崩了、重启了、上下文丢了，可以这样恢复：

- 再次拉取 inbox
- 查询 `GET /tasks/:taskId`
- 查询 `GET /threads/:threadId`
- 需要更完整上下文时用 `GET /events/replay`

不要把临时终端历史当成唯一事实来源。

### 8. 当人类不在终端里时，用 adapter

如果人类用户在云之家、飞书、钉钉、Telegram、Discord 或手机端上，就应该通过平台 adapter 接入，而不是把平台消息逻辑硬编码进 agent 本身。

详见：

- [adapters/yunzhijia/README.md](./adapters/yunzhijia/README.md)
- [adapters/yunzhijia/QUICKSTART.md](./adapters/yunzhijia/QUICKSTART.md)
- [docs/adapter-example.js](./docs/adapter-example.js)

### 9. 对代码智能体最实用的工作模式

对 Claude Code / Codex / OpenCode / xiaok code 这类代码智能体，最有效的使用方式是：

1. 启动时注册。
2. 在任务边界、空闲点、hook 触发点主动轮询 inbox。
3. 接活前先查询同项目 participant 和 work state。
4. 消费后及时 ack。
5. 在关键里程碑上更新 work state 并发 `report_progress`。
6. 在不可逆或用户可见的完成动作前请求审批。
7. 重启后通过 replay 恢复，而不是靠猜。

这样可以得到一条可恢复、可审计的协作时间线，同时又不强迫所有 agent 绑定到同一种运行时或长期 websocket 生命周期。

## 项目结构

```text
src/
  broker/        协调层，负责 participant、路由、聚合查询
  domain/        纯状态推进逻辑
  http/          HTTP server 与路由
  store/         SQLite schema 与事件存储
  cli.js         本地 broker 启动入口

tests/
  broker/        service 测试
  domain/        reducer 测试
  http/          API 集成测试
  store/         SQLite store 测试
```

## 扩展能力

### 手机连接

手机可以作为 `kind: "mobile"` 的 participant 连接，支持：

- WebSocket 实时通知
- 简化的 inbox（只显示需要确认的事件）
- 审批和确认操作

详见 [MOBILE.md](./MOBILE.md)。

### 消息平台集成

通过独立的 adapter 进程接入云之家、飞书、钉钉、Telegram、Discord 等平台：

```text
消息平台 → Platform Adapter → Intent Broker → Agents
```

详见：

- [docs/ADAPTERS.md](./docs/ADAPTERS.md) - Adapter 架构设计
- [docs/adapter-example.js](./docs/adapter-example.js) - 最小实现示例
- [docs/platform-adapters.md](./docs/platform-adapters.md) - 各平台接入指南

当前仓库已包含一个可运行的云之家 adapter：

- [adapters/yunzhijia/README.md](./adapters/yunzhijia/README.md) - 配置与运行说明
- [adapters/yunzhijia/QUICKSTART.md](./adapters/yunzhijia/QUICKSTART.md) - 快速联调步骤

## 下一步

当前仓库还是原型阶段，下一步最值得继续做的是：

- `capability` 路由的更完整测试覆盖
- 更完整的 task / approval / thread 投影视图
- 飞书 / 钉钉 / Telegram / Discord adapter
- 局域网 / 远程部署模式

## License

暂未声明，默认按仓库所有者后续决定处理。
