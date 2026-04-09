# Intent Broker

> 你有多个 AI 助手（Codex、Claude Code、OpenCode）在同一个项目上工作，但它们彼此不知道对方的存在——直到人类变成所有窗口之间的路由器、记忆体和冲突探测器。Intent Broker 解决这个协调问题：先持久化事件，再进行投递；让多 agent 围绕同一任务对象协作，人类负责审批和裁决，日常同步、任务交接、状态恢复全部进入 broker 托管的协作流。

本地优先的多 Agent 协作 broker。不是聊天服务器，也不是工作流平台，而是可靠的协作协议中间层。

[English](README.md) | 简体中文

---

## 效果展示

**一个典型场景：**

1. 人类在同一仓库打开一个 Codex 会话和一个 Claude Code 会话
2. 两个会话自动注册到 Intent Broker，上报在线状态，暴露 alias（`@codex`、`@claude`）
3. 人类在云之家给 `@codex` 发任务："修复 websocket 重连"，给 `@claude` 发并行任务："检查 shutdown 路径"
4. 每个 agent 更新自己的 work-state，也可以直接向另一个 agent 请求信息或交接
5. 提交前查询当前项目里还有谁在工作，判断是否有重叠修改
6. 即使 broker 重启，任务上下文也仍然保留

**这不是"让几个 agent 能聊天"，而是让人可以并行分派工作，同时让 agent 之间保留足够的共享状态。**

---

## 设计理念：协作协议层

Intent Broker 的设计遵循四个原则：

### 1. 协调优先

多智能体编码的难点，往往先不是模型能力，而是协作成本。即使已经用了多个终端、worktrees 或不同分支，这些问题仍会出现：

- 人要记住每个 agent 分别在做项目的哪一部分
- agent 不知道还有谁也在这个仓库里工作
- 并行开发带来 ownership 混乱和冲突风险
- 审批、交接、进度更新散落在不同聊天窗口里

Broker 把这部分协调工作产品化，让它具备可恢复性。

### 2. 人类做监督者

人负责：
- 设定方向
- 审批高风险动作
- 做最终裁决

Broker 负责：
- 日常同步
- 任务交接
- 状态恢复
- 大部分协商

### 3. 默认可恢复

任务、线程、审批、投递状态都应该在 broker 重启、会话空闲或断线后恢复。

**实现方式：**
- SQLite 持久化事件存储
- inbox pull 与 ack cursor
- 事件重放 API
- 后台心跳和日志

### 4. 非侵入接入

Codex、Claude Code 这类工具应保留原生体验。broker 通过 hooks、skills、adapters 和本地 bridge 接入，而不是强包一层壳。

### 终端跳转契约

broker 侧的终端定位契约记录在 [TERMINAL_JUMP.md](TERMINAL_JUMP.md)。

- Ghostty 的精确跳转元数据必须来自 `terminalSessionID`
- Terminal.app 的精确跳转元数据必须来自 `terminalTTY`
- `sessionHint` 只是兼容字段，不能当 Ghostty 主键
- 当 `projectPath` 或 `terminalTTY` 冲突时，应降级而不是跳错终端

---

## 安装

### Claude Code

对 Claude 说：「安装 https://github.com/kaisersong/intent-broker」

或手动：
```bash
git clone https://github.com/kaisersong/intent-broker ~/.claude/skills/intent-broker
```

### Codex

```bash
git clone https://github.com/kaisersong/intent-broker ~/.codex/skills/intent-broker
```

### 启动 Broker

```bash
cd /Users/song/projects/intent-broker
npm start
```

默认监听 `http://127.0.0.1:4318`。

**推荐配置：**

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 4318,
    "dbPath": "./.tmp/intent-broker.db"
  },
  "channels": {
    "yunzhijia": {
      "enabled": true,
      "sendUrlEnv": "YZJ_SEND_URL"
    }
  }
}
```

**重启并检查运行态：**

```bash
npm run broker:restart
npm run broker:status
```

---

## 使用方式

### 基本命令

```bash
# 查看同项目协作者
intent-broker who

# 查看未读协作消息
intent-broker inbox

# 手动注册 participant（仅排障）
intent-broker register

# 发送任务
intent-broker task <participantId> <taskId> <threadId> "请接手这个问题"

# 发送进度
intent-broker progress <taskId> <threadId> "已完成 50%"

# 发送通知
intent-broker note <participantId> <taskId> <threadId> "本地已验证"

# 发送阻塞性提问
intent-broker ask <participantId> <taskId> <threadId> "请确认语义"

# 回复
intent-broker reply "收到，开始处理"
```

### 典型工作流

**一步协作：**

```bash
# 给另一个参与者发任务
intent-broker task claude-real-1 task-1 thread-1 "请接手回归问题"
```

**查询项目现状后再接活：**

```bash
# 先问谁在线、谁在做什么
intent-broker who

# 查询同项目 participant 和 work-state
GET /participants?projectName=intent-broker
GET /work-state?projectName=intent-broker
```

**审批流：**

关键动作（提交、发布、破坏性操作）前：

```bash
intent-broker request-approval <taskId> "准备提交最终结果"
# 人类在云之家或终端确认
intent-broker confirm reply <requestId> Y
```

---

## 功能特性

### 核心功能

- **Participant 注册** — 全局唯一 alias，冲突时自动加数字后缀
- **项目查询** — 按 projectName 查询 participant
- **Work-state** — 记录并查询 participant 当前工作状态
- **协作语义** — `task`、`ask`、`note`、`progress` 默认投递
- **投递反馈** — 返回 `onlineRecipients`、`offlineRecipients`、`deliveredCount`

### Agent Group 协作

- **自动发现** — 同项目 agent 自动发现（按 `projectName`）
- **文件变更广播** — 通知给组成员
- **冲突检测** — 并发修改检测并通知双方
- **文件锁机制** — 避免同时修改同一文件

### 人机交互确认

- **阻塞式确认** — `intent-broker confirm ask`
- **多类型支持** — yes/no、多选、自由文本输入
- **超时 fallback** — `wait`、`cancel`、`auto-decide`
- **终端 fallback** — 云之家不可用时降级

### 任务管理

- **父子任务** — 父任务创建 + 子任务分解
- **任务分配** — 子任务分配给指定 agent
- **状态跟踪** — `pending`、`in_progress`、`completed`、`blocked`

### 代码审查

- **审查请求** — `intent-broker review request <file> --reviewer @senior-dev`
- **审查意见** — approve/reject
- **审查列表** — 按 pending 过滤

### 协作历史

- **事件记录** — 所有协作事件持久化
- **多维查询** — 按类型、参与者、项目、时间范围
- **统计报告** — 默认 7 天窗口
- **最近活动** — feed 流

### 降级容错

| 故障 | 降级行为 |
|------|----------|
| Broker 不可用 | 本地日志记录，不阻塞执行 |
| 云之家断开 | 终端输入/输出 fallback |
| WebSocket 断开 | 指数退避重连（1s → 2s → 4s → 8s → 16s） |
| 崩溃 | `~/.intent-broker/` 持久化状态，支持恢复 |

---

## 面向 AI 智能体

如果你是 Claude Code、Codex、OpenCode 或其他代码智能体，Intent Broker 应该被当成协作协议层来使用。

### 1. 每次会话启动先注册

```http
POST /participants/register
```

```json
{
  "participantId": "codex.main",
  "alias": "codex",
  "kind": "agent",
  "roles": ["coder"],
  "capabilities": ["backend.node", "frontend.react"],
  "context": {
    "projectName": "intent-broker"
  }
}
```

**命名约定：**

| 字段 | 示例 | 说明 |
|------|------|------|
| `participantId` | `claude-code.main` | 稳定且能区分工具 |
| `alias` | `codex`、`claude`、`xiaok` | 给人和其他 agent 使用的短名 |
| `roles` | `coder`、`reviewer`、`approver` | 粗粒度角色 |
| `capabilities` | `frontend.react`、`backend.node` | 细粒度能力 |
| `context.projectName` | `intent-broker` | 当前项目名称 |

### 2. 优先用 inbox pull

```http
GET /inbox/:participantId?after=0&limit=50
POST /inbox/:participantId/ack
```

**标识分开用：**

- `taskId` — 稳定的任务主键
- `threadId` — 稳定的对话主键
- `eventId` — 只给 broker 内部做重放、增量拉取、ack 游标

### 3. 查询项目现状后再接活

```http
GET /participants?projectName=intent-broker
GET /work-state?projectName=intent-broker
```

回答这些问题：
- 这个项目里现在有哪些 agent 在线
- 谁当前是 `idle`、`blocked`、`reviewing`、`implementing`
- 是否已经有人在处理同一个 task

**work-state 值：** `idle`、`planning`、`implementing`、`reviewing`、`blocked`、`waiting_approval`、`ready_to_submit`

### 4. 用 alias 让人类更容易指挥

人在云之家可以直接发：
- `@codex 修一下 broker 测试`
- `@claude @codex 一起排查`
- `@all 同步一下当前阻塞`

### 5. 重启后靠 replay 恢复

```http
GET /tasks/:taskId
GET /threads/:threadId
GET /events/replay?after=0&taskId=task-1
```

---

## API 概览

### Health

```http
GET /health
```

### Participants

```http
POST /participants/register
GET /participants?projectName=intent-broker
GET /participants/resolve?aliases=codex,claude
POST /participants/:participantId/alias
```

### Send Intent

```http
POST /intents
```

返回路由结果和实时投递结果：

```json
{
  "eventId": 71,
  "recipients": ["codex.main", "claude.main"],
  "onlineRecipients": ["codex.main"],
  "offlineRecipients": ["claude.main"],
  "deliveredCount": 1
}
```

### Work State

```http
POST /participants/:participantId/work-state
GET /participants/:participantId/work-state
GET /work-state?projectName=intent-broker
```

### 项目快照

```http
GET /projects/:projectName/snapshot
```

返回项目的聚合只读视图：包含 presence 和 work-state 的参与者列表、计数（在线、忙碌、阻塞、待审批）以及最近事件。

---

## 技术选型

- Node 22
- 原生 ESM
- `node:http`
- `node:sqlite`
- `node:test`

**目的：** 今天就能跑起来，不引第三方运行时依赖，把协议和可靠性路径先验证掉。

---

## 测试

```bash
npm test
npm run verify:collaboration
```

协作 smoke 验证走真实的 Codex 和 Claude Code bridge 入口，日志和分析结果写到 `.tmp/collaboration-smoke-*`。

---

## 扩展能力

### 手机连接

手机可以作为 `kind: "mobile"` 的 participant 连接，支持 WebSocket 实时通知、简化的 inbox（只显示需要确认的事件）、审批和确认操作。

详见 [MOBILE.md](./MOBILE.md)。

### 消息平台集成

```text
消息平台 → Platform Adapter → Intent Broker → Agents
```

详见：
- [docs/ADAPTERS.md](./docs/ADAPTERS.md) - Adapter 架构设计
- [adapters/yunzhijia/README.md](./adapters/yunzhijia/README.md) - 云之家配置

---

## 兼容性

| 工具 | 接入方式 |
|------|----------|
| Claude Code | `.claude/settings.json` hooks |
| Codex | `~/.codex/hooks.json` + skill symlink |
| OpenCode | 待实现 |
| xiaok-code | 待实现 |

---

## 版本日志

**v0.2.0** — Agent Group 协作：同项目自动发现、文件变更广播、冲突检测、文件锁；人机交互确认：阻塞式确认、超时 fallback；任务分发与审查；协作历史；降级容错。

**v0.1.0** — 初始原型：participant 注册、全局唯一 alias、按项目查询、work-state、task/ask/note/progress 投递语义、presence 追踪、inbox pull、任务/线程/事件查询。
