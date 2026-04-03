# Intent Broker

[English version](./README.md)

本地优先的多 Agent 协作 broker。它不是聊天服务器，也不是工作流平台，而是一层可靠的协作协议中间层：先持久化事件，再进行投递；让 Codex、Claude Code、OpenCode 这类 agent 与人类参与方围绕同一任务对象协作。

当前发布版本：`0.1.2`

`Intent Broker` 是一个服务于“一个人 + 多个开发智能体”的协作协调层。

它的价值不是“让几个 agent 能互相发消息”，而是降低并行开发时的协调成本：谁在做什么、下一个任务该给谁、谁可能冲突、谁需要审批、broker 或 client 重启后协作如何继续。

如果没有这一层，最终人类就会变成所有 Codex / Claude Code / OpenCode 窗口之间的路由器、记忆体和冲突探测器。`Intent Broker` 要做的，就是把这部分协调工作产品化，并且让它具备可恢复性。

## 为什么要做它

多智能体编码的难点，往往先不是模型能力，而是协作成本。

即使已经用了多个终端、worktrees 或不同分支，下面这些问题还是会立刻出现：

- 人要记住当前每个 agent 分别在做项目的哪一部分
- agent 自己并不知道还有谁也在这个仓库里工作
- 并行开发会带来 ownership 混乱和冲突风险
- 审批、交接、进度更新容易散落在不同聊天窗口里
- 一旦 broker、client 或消息通道重启，协作上下文就很容易丢

`Intent Broker` 的目标，就是先把这一层问题解决掉。人类应该负责设定方向、审批高风险动作和做最终裁决；而日常同步、任务交接、状态恢复以及大部分协商，应该尽量进入 broker 托管的协作流里。

## 设计思想

设计目标很直接：让多开发智能体协作足够可靠，让人能同时跑多个 coding agent，而不必自己变成全职调度器。

当前设计遵循四个原则：

- 协调优先：模型能力当然重要，但这个产品眼下真正要解决的是同项目多 agent 的协调成本。
- 人类做监督者：人负责给目标、批高风险动作、做最终裁决，而不是人工在 agent 之间转发每一条消息。
- 默认可恢复：任务、线程、审批、投递状态都应该在 broker 重启、会话空闲或断线后恢复。
- 非侵入接入：Codex、Claude Code 这类工具应保留原生体验，broker 通过 hooks、skills、adapters 和本地 bridge 接入，而不是强包一层壳把工具接管掉。

落到实现上，broker 负责共享协作状态，例如 presence、work-state、routing、delivery、replay 和 task/thread 历史；而每个 agent 仍然保留自己的推理循环和工具执行能力。

## 应用场景

这个项目适合以下场景：

- 同一台机器上开多个 Codex / Claude Code / OpenCode 窗口，需要围绕同一任务协作。
- 人类参与者希望能插话、审批、接管或确认交付，而不是只看 agent 自己跑。
- 需要让 agent 在 hook、空闲点、任务结束时主动拉取待办，而不是常驻 websocket 连接。
- 需要保留任务时间线，支持重连后补拉、按 task/thread 重放、按事件追溯问题。
- 需要做更高层的 adapter、手机审批面板、局域网协作前，先把本地协议底座跑起来。

## 一个典型场景

一个很实际的使用方式，就是“人类 + 多个开发智能体”一起协作同一个项目：

1. 人类在同一个仓库里打开一个 Codex 会话和一个 Claude Code 会话。
2. 两个会话都会自动注册到 `Intent Broker`，带上相同的 `projectName`，上报在线状态，并暴露简短 alias，例如 `@codex` 和 `@claude`。
3. 人类在云之家里给 `@codex` 发任务，比如“负责 websocket 重连修复”，再给 `@claude` 发并行任务，比如“检查 shutdown 路径并提前看冲突”。
4. 每个 agent 会更新自己的 work-state、持续同步 progress，也可以直接向另一个 agent 请求信息或交接，而不需要所有消息都靠人肉转发。对于 broker 注入且需要回复的可执行消息，agent 可以直接在本地 TUI 正常回答，由 bridge 自动把回答镜像回 broker。
5. 在准备提交前，某个 agent 可以先查询当前项目里还有谁正在工作，判断是否有重叠修改，再通过同一条 task/thread 时间线协商交接或冲突处理。
6. 即使 broker 重启，或者某个 agent 暂时空闲，任务上下文也仍然保留；Codex 在空闲时可以自动续起可执行任务，Claude Code 也仍然可以在下一次 prompt submit 或显式 inbox pull 时从 broker 状态恢复，不会把协作过程丢掉。

重点不是“让几个 agent 能聊天”，而是让人可以并行分派工作，同时让 agent 之间保留足够的共享状态，去协商任务归属、进度同步、审批以及冲突处理，减少人类来回转述和手工协调。

## 当前能力

当前原型已经支持：

- participant 注册
- 全局唯一 participant alias，冲突时自动加数字后缀
- 按项目查询 participant
- 记录并查询 participant 当前工作状态
- `task`、`ask`、`note`、`progress` 协作的默认投递语义
- 按发送方和 intent 类型区分 `actionable` / `informational` 的默认投递语义
- 基于 websocket 的在线 / 离线 presence 追踪
- 新 client 上线 / 离线时的 presence 广播
- `request_task`、`report_progress`、`request_approval`、`respond_approval`
- 按 `participant`、`role`、`broadcast` 路由
- inbox pull 与 ack cursor
- 返回 `onlineRecipients`、`offlineRecipients`、`deliveredCount` 的实时投递反馈
- `GET /tasks/:taskId`
- `GET /threads/:threadId`
- `GET /events/replay`
- `GET /work-state`
- SQLite 持久化事件存储
- WebSocket 实时通知通道
- 云之家 adapter 的真实入站 / 出站联调
- 面向真实 Codex 会话的非侵入 hook 接入
- Codex 对 `actionable` 队列的空闲自动起工，以及通过 `Stop` hook 的回合结束续跑
- 面向真实 Claude Code 会话的非侵入 hook 接入
- 来自真实 Codex / Claude Code transcript 的 `actionable` 自动回复镜像；拿不到 transcript 时自动降级回显式 `intent-broker reply`
- 带静默重连能力的 session 级 realtime bridge 本地队列

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

现在 `npm start` 会默认读取 [intent-broker.config.json](./intent-broker.config.json)，并启动配置里声明的 broker 托管通道。对当前原型来说，这意味着云之家可以直接由 broker 托管，不需要用户再额外手动起一个 adapter 进程。

broker 启动时还会按当前仓库内容自检本机 Codex / Claude Code bridge 是否是最新安装状态。如果 hooks、命令 shim 或 Codex skill 链接已经过期，broker 会在真正开始服务前自动补齐；如果同步失败，只记 warning 日志，不阻塞 broker 启动。

默认监听：

- `http://127.0.0.1:4318`

推荐的托管通道配置：

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

然后这样启动：

```bash
YZJ_SEND_URL='https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=YOUR_TOKEN' npm start
```

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
- broker 配置加载与托管通道启动
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

现在 broker 在接受 intent 后，还会返回路由结果和实时投递结果：

```json
{
  "eventId": 71,
  "recipients": ["codex.main", "claude.main"],
  "onlineRecipients": ["codex.main"],
  "offlineRecipients": ["claude.main"],
  "deliveredCount": 1
}
```

含义如下：

- `recipients`：broker 语义路由后的目标
- `onlineRecipients`：当前有活跃 websocket，已经实时收到事件的目标
- `offlineRecipients`：只写入了 durable inbox，还需要之后自己 pull 的目标
- `deliveredCount`：本次真正实时送达的目标数

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

### Presence

```http
GET /presence
GET /presence/:participantId
POST /presence/:participantId
```

如果已注册 participant 连接或断开 broker websocket，presence 也会自动更新，并产生 `participant_presence_updated` 事件，让其他 agent 或消息通道能知道谁刚刚上线、谁已经离开。

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

现在 `SessionStart` 还会静默拉起两个后台辅助进程：

- presence keeper：broker 重启后自动补注册，父会话退出后自动下线
- realtime bridge：通过 websocket 收件，并把事件追加到 `~/.intent-broker/<tool>/` 下的本地队列

当前各工具的 bridge 行为：

- 人类消息通道 -> agent：默认按可执行命令处理
- agent 发 `task` / `ask`：默认是 `actionable`；agent 发 `note` / `progress` / reply：默认是 `informational`
- Codex 在空闲时可以自动派发 `actionable` 队列，并在当前 turn 结束后通过 `Stop` hook 自动续跑
- 对 broker 注入的 `actionable` 工作，现在优先是“本地正常回答，由 bridge 自动回传”，而不是“本地答完后再人工补一条 reply”
- 如果 transcript 抓取失败，就不猜测，继续保留显式 `intent-broker reply ...` 作为降级路径
- Claude Code 保持相同的队列语义，但仍然是在下一次 prompt submit 或显式 inbox pull 时消费

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

当前默认语义规则：

- 人类消息通道 -> agent：actionable
- agent 发 `task` / `ask`：actionable
- agent 发 `note` / `progress` / reply：informational

如果有特殊场景，仍然可以通过 `payload.delivery` 显式覆盖。

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
- 如果被 `@` 的目标当前离线，云之家会明确告诉人类“消息已写入 broker inbox，但没有实时送达”
- 云之家支持 `@broker list` 和 `@broker list <projectName>`，直接在 channel 里查看在线/离线 agent
- agent 的上线 / 离线也会主动广播到云之家 channel

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

如果你关心的是“对方现在有没有马上看到”，不要只看 `recipients`，还要看 broker 返回的 `onlineRecipients` 和 `offlineRecipients`。路由成功只代表事件已持久化，不代表对方此刻在线。

### 6. 让人类直接在 channel 里看协作现状

在云之家里，人不应该为了确认该 `@谁`，还要再去查 broker 接口。

可以直接发：

- `@broker list`
- `@broker list intent-broker`

adapter 会在 channel 中回一条协作列表，按 `在线` / `离线` 分组，并带上 agent 的 alias、项目名和最近 work-state 摘要。

## Codex 接入

当前最适合 Codex 的方式是“hook + skill”的非侵入接入，不改 Codex 原本启动方式，只是在本地安装三个 hook 和一个 skill：

- `SessionStart` hook：真实 Codex 会话启动或恢复时，静默向 broker 自动注册当前会话，记录当前 `projectName`，上报一个初始 `idle` 工作状态，并拉起一个轻量后台 keeper，在 TUI 打开期间持续保活 presence。
- `SessionStart` hook：同时拉起 realtime bridge 守护进程，通过 websocket 收件并立即写入本地队列状态。
- `UserPromptSubmit` hook：真实用户提交 prompt 前，会静默重注册当前会话，再检查是否有新到达的 broker 事件；只有确实存在待处理协作上下文时，才把它们注入当前 turn。
- `Stop` hook：当前 Codex turn 结束时，如果期间新到了可执行 broker 任务，就把这批队列转成自动续跑 prompt，在不打断当前工作的前提下衔接下一轮。
- `intent-broker` skill：给当前 Codex 会话一个明确的出站入口，用来发任务和发进度。

正常使用流程：

- 不要手动注册 Codex 会话
- 直接在目标项目目录里打开 Codex
- 让 `SessionStart` 在会话启动时自动完成静默注册
- 让后台 keeper 在会话空闲时也维持在线状态，并在 broker 重启后自动补注册
- 让 realtime bridge 在 Codex 空闲时自动派发 `actionable` 队列
- 让 `UserPromptSubmit` 在下一次真实 prompt 提交时优先注入本地队列里的协作上下文
- 让 `Stop` 在当前 turn 结束后把新到达的可执行队列自动续上，既不丢任务，也不打断当前回合

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
- `~/.intent-broker/codex/*.json` 本地 cursor 状态、realtime 队列状态、runtime 状态和辅助进程元数据

现在 Codex 桥接在注册时会默认使用当前工作目录名作为 `projectName`。如果你想手动指定，可以设置 `PROJECT_NAME`。

说明：

- 这个安装过程会保留你已有的其他 Codex hooks，只替换旧的 `intent-broker` hook 项。
- 默认安装现在是静默的，不会在每次发消息时都打印 `Running ... hook: intent-broker ...`。
- 从本地 Codex 源码来看，生命周期 hooks 目前在 Windows 上还不支持，所以这条路径当前主要面向 macOS / Linux。
- 从当前真实 Codex 行为看，`SessionStart` 会在会话真正进入第一轮 turn 或 resume 流程时触发，而不是 TUI 刚画出来就立即触发。
- 现在 hook 输入里的 `session_id` 会优先于继承下来的 `CODEX_THREAD_ID`，所以即使你在一个 agent 环境里再拉起新的 Codex，也不会错误复用父会话的 participant id。
- 后台 keeper 会在 Codex 父进程仍存活时持续保活 presence，在父进程退出后把 participant 标记为离线。
- realtime bridge 会在 broker 重启后静默重连，并持续把 websocket 事件写入本地队列状态。
- 在下一次 prompt submit 时，Codex 会先 drain 本地 realtime 队列，再回退到 broker poll，因此 websocket 到达的事件会优先注入。
- hook 注入的协作上下文会区分 `actionable` 和 `informational`。人类消息，以及 agent 的 `task` / `ask` 默认是 `actionable`；`note` / `progress` 默认是 `informational`。
- 如果 Codex 当前空闲，而本地队列里来了 `actionable` 事件，realtime bridge 会自动执行 `codex exec --json --full-auto resume ...`，无需人工再补一个 prompt。
- 如果 Codex 当前忙碌，`Stop` hook 会在当前 turn 完成后，把待处理的 `actionable` 队列转成自动续跑 prompt。
- 如果某条 broker 注入的 `actionable` 消息是在 Codex TUI 里直接回答的，bridge 现在会在 `Stop` 时尽量把这条最终回答自动镜像回 broker，让人类或其他 agent 直接收到。
- 只有 `informational` 的队列仍然会留到下一次 prompt submit，或你显式执行本地 inbox pull 时再消费。
- 如果该 turn 抓不到 transcript，Codex 会降级回显式 `intent-broker reply ...`，不会盲发一条可能错误的回复。
- 如果你把本仓库挪了位置，需要重新执行一次 `npm run codex:install`，刷新 hook 里的绝对路径。

### 在真实 Codex 会话里主动发消息

手动注册只保留给排障场景，例如你想确认当前会话推导出的 participantId：

```bash
intent-broker register
```

给另一个参与者发任务：

```bash
intent-broker task claude-real-1 real-task-1 real-thread-1 "请接手这个回归问题排查"
```

发送一条信息型进度更新：

```bash
intent-broker progress real-task-1 real-thread-1 "还在排查 broker handoff 失败原因"
```

发送定向通知或阻塞性提问：

```bash
intent-broker note claude-real-1 real-task-1 real-thread-1 "本地队列已经持久化好了"
intent-broker ask claude-real-1 real-task-1 real-thread-1 "请确认重试语义是否符合预期"
```

直接查看未读协作消息，不再手查 broker：

```bash
intent-broker inbox
```

查看同项目里谁在线、谁在做什么：

```bash
intent-broker who
```

直接沿用最近一次记住的 `taskId/threadId` 回复。
当 transcript 自动镜像拿不到当前 turn 最终回答时，这是显式降级路径：

```bash
intent-broker reply "收到，开始处理"
```

如果要显式指定回复目标，可以用 alias 覆盖，但仍沿用最近的 `taskId/threadId`：

```bash
intent-broker reply @claude2 "请看一下最新补丁"
```

如果你想直接发带语义的协作命令，不需要自己写 HTTP：

```bash
intent-broker task claude2 real-task-1 real-thread-1 "接手失败的 smoke test"
intent-broker ask claude2 real-task-1 real-thread-1 "这个冲突要怎么决策"
intent-broker note claude2 real-task-1 real-thread-1 "我已经 rebase 并提交了队列修复"
intent-broker progress real-task-1 real-thread-1 "还在排查重连边界"
```

### 这套接入的意义

安装后，一个已经打开的真实 Codex 会话就能比较自然地参与多智能体通信：

- 保持原生启动方式
- 通过 hook 收到 broker 协作上下文，而不是再包一层 wrapper
- 通过统一的本地桥接命令主动发 task / progress

## Claude Code 接入

Claude Code 现在和 Codex 一样，也采用非侵入的 hook 桥接模式，只是安装位置放在项目级设置里：

- `SessionStart` hook：自动把 Claude Code 会话注册进 broker，上报一个初始 `idle` 工作状态，并拉起同样的轻量后台 keeper，让空闲期和 broker 重启期间的 presence 也能恢复
- `SessionStart` hook：同时拉起 realtime bridge 守护进程，让 websocket 事件立即落到本地队列状态
- `UserPromptSubmit` hook：broker 重启后会静默重注册，并且只在确实有新到达 broker inbox 上下文时，才在 prompt 提交前注入
- `Stop` hook：Claude Code 当前 turn 结束后，会尝试把最近一次 broker 注入的 `actionable` 最终回答自动镜像回 broker，而不要求你再手动补一条 reply

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
- `~/.intent-broker/claude-code/*.json` 本地 cursor 状态、realtime 队列状态与辅助进程元数据

说明：

- 会保留你已有的其他 Claude Code hooks，只替换旧的 `intent-broker` hook 项
- 默认安装现在是静默的，不会在每次发消息时都打印 `Running ... hook: intent-broker ...`
- 现在 hook 输入里的 `session_id` 会优先于继承下来的 session 环境变量，避免嵌套拉起时多个客户端错误共用同一个 participant id
- 后台 keeper 会在 Claude Code 父会话仍存活时维持在线状态，退出后再自动标记离线
- realtime bridge 会在 broker 重启后静默重连，并持续把 websocket 事件写入本地队列状态
- broker 注入的 `actionable` 现在会优先在 `Stop` 时做 transcript 自动回复镜像；如果 transcript 抓取失败，就继续走显式 `intent-broker --tool claude-code reply ...` 降级路径
- Claude Code 仍然是在下一次 prompt submit，或你显式执行本地 inbox pull 时，才消费已排队的 broker 上下文，而不是空闲时静默自动执行
- 如果你把本仓库挪了位置，需要重新执行一次 `npm run claude-code:install`，刷新命令路径

### 在真实 Claude Code 会话里主动发消息

手动注册只保留给排障场景，例如你想确认当前会话推导出的 participantId：

```bash
intent-broker --tool claude-code register
```

给另一个参与者发任务：

```bash
intent-broker --tool claude-code task codex-real-1 real-task-1 real-thread-1 "请接手这个回归问题排查"
```

发送一条信息型进度更新：

```bash
intent-broker --tool claude-code progress real-task-1 real-thread-1 "还在排查 broker handoff 失败原因"
```

发送定向通知或阻塞性提问：

```bash
intent-broker --tool claude-code note codex-real-1 real-task-1 real-thread-1 "重连路径本地已验证通过"
intent-broker --tool claude-code ask codex-real-1 real-task-1 real-thread-1 "请帮我确认交接语义"
```

直接查看未读协作消息：

```bash
intent-broker --tool claude-code inbox
```

查看同项目协作者和当前 work-state：

```bash
intent-broker --tool claude-code who
```

直接沿用最近一次记住的协作上下文回复。
当自动 transcript 镜像不可用时，这就是显式降级路径：

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

默认用户路径现在是通过 `intent-broker.config.json` 让 broker 托管通道。独立 adapter 进程仍然保留，作为调试或未来多进程部署的高级模式：

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
