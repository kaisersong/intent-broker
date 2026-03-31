# Intent Broker

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
- `request_task`、`report_progress`、`request_approval`、`respond_approval`
- 按 `participant`、`role`、`broadcast` 路由
- inbox pull 与 ack cursor
- `GET /tasks/:taskId`
- `GET /threads/:threadId`
- `GET /events/replay`
- SQLite 持久化事件存储
- WebSocket 实时通知通道
- 云之家 adapter 的真实入站 / 出站联调

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
  "kind": "agent",
  "roles": ["coder"],
  "capabilities": ["frontend.react"]
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

详见 [MOBILE.md](./MOBILE.md)

### 消息平台集成

通过独立的 adapter 进程接入云之家、飞书、钉钉、Telegram、Discord 等平台：

```
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
