# Intent Broker

> 你有多个 AI 助手（Codex、Claude Code、Qoder CLI、OpenCode）在同一个项目上工作，但它们彼此不知道对方的存在——直到人类变成所有窗口之间的路由器、记忆体和冲突探测器。Intent Broker 解决这个协调问题：先持久化事件，再进行投递；让多 agent 围绕同一任务对象协作，人类负责审批和裁决，日常同步、任务交接、状态恢复全部进入 broker 托管的协作流。

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

## Xiaok Desktop v1.4.21 集成说明

- Intent Broker 仍是 Xiaok Desktop v1.4.21、KSwarm 项目 handoff、定时 loop 派发和本地 agent runtime adapter 使用的 event-first 协作层。
- Broker 不判断任务是否完成，也不改写任务内容。它记录 request、delivery attempt、reply、approval、cancellation、run metadata 和 recovery signal；KSwarm 与 Xiaok Desktop 基于这些事实判断项目/任务状态和 artifact evidence。
- 投递失败必须保持显式失败。Broker delivery failure 不能被转换成成功任务结果，因为 Xiaok loop diagnostics 会扫描 completion record，查找缺失产物和异常交付结果。
- Runtime 恢复要分层诊断：先看 `127.0.0.1:4318` 的 broker health，再看 `127.0.0.1:4400` 的 KSwarm health，最后看 Desktop runtime/adapter 状态。Broker 健康只说明协作层可用，不代表 KSwarm sidecar 或定时任务执行器健康。
- Xiaok Desktop v1.4.21 会在 broker 投递的工作完成后，从 Desktop evidence record 和 task snapshot 读取 task-completion loop 结果。这只是增加用户可见结果入口，不改变 broker 的投递语义。
- Xiaok Desktop 的 AI 录音路径刻意保持在 Desktop 知识库栈本地闭环。麦克风采集、Whisper 模型下载/续传、实时转写预览、纪要总结和保存转写来源都不需要 broker 投递；只有保存后的知识被 agent、项目或定时 loop 使用时，Broker 事件才进入后续协作链路。
- 本次 Xiaok v1.4.21 README 基线不要求 broker 协议迁移；现有 inbox delivery、event replay、hook 安装和 Unix socket fallback 语义仍是当前集成合同。随包 broker 基线仍是 `0.3.8`。

## 当前集成基线

Intent Broker 是 xiaok Desktop 与 KSwarm 使用的协作协议层：

- xiaok agent 通过 broker hooks 注册在线状态、alias、项目上下文和 work-state。
- KSwarm 通过 broker 协议发送 `assign_po`、`request_task`、`review_submission`、`cancel_run` 和恢复类 intent。
- KSwarm 动态 workflow 节点 handoff 也走 broker 通道：桌面 runtime worker 接收 script-generated workflow agent node，并把结构化节点输出提交回 KSwarm。
- Runtime 恢复依赖 broker inbox 投递和持久化事件重放，因此 PO 制定计划或 worker 执行被中断后，可以恢复或重试，而不是消失在某个本地终端里。
- Broker 投递失败不等于任务完成。目标 agent 不可用时，broker 只记录投递失败，让 KSwarm 恢复或改派，不能合成一个成功的任务结果。
- Broker 提供本地 Unix socket fallback，用于 loopback HTTP 受限的环境；当直接 fetch `127.0.0.1` 被阻断时，Desktop 和 E2E runtime bridge 仍可工作。
- Codex hook 安装使用稳定的 `[features].hooks` 开关；旧的 `[features].codex_hooks` 配置会由 `npm run codex:install` 迁移。

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

对 Claude 说：「安装 https://github.com/nicepkg/intent-broker」

或手动：
```bash
git clone https://github.com/nicepkg/intent-broker ~/.claude/skills/intent-broker
```

### Codex

从源码 checkout 安装：

```bash
git clone https://github.com/nicepkg/intent-broker ~/projects/intent-broker
cd ~/projects/intent-broker
npm install
npm run codex:install
```

安装器会写入 `~/.codex/hooks.json`，创建或刷新受管的 `~/.codex/skills/intent-broker` symlink，安装 `intent-broker` 命令 shim，并用下面的新开关启用 Codex hooks：

```toml
[features]
hooks = true
```

如果旧配置里还有 `[features].codex_hooks`，重新运行 `npm run codex:install` 即可迁移到 `[features].hooks`。

### Qoder CLI

Broker 启动时自动安装 hooks 到 `~/.qoder/settings.json`，无需手动配置。

手动安装：
```bash
node adapters/qodercli-plugin/bin/qodercli-broker.js install
```

### agy (antigravity-cli)

Hooks 使用 Codex 格式（`{"hooks": {...}}`）。从源码安装：

```bash
cd ~/projects/intent-broker
node adapters/agy-plugin/bin/agy-broker.js install
```

写入 `~/.gemini/antigravity-cli/hooks.json`，包含 PreToolUse/PostToolUse/Stop hooks。

### OpenCode

基于 plugin 的集成。从源码安装：

```bash
cd ~/projects/intent-broker
node adapters/opencode-plugin/bin/opencode-broker.js install
```

写入 `~/.config/opencode/plugins/intent-broker.js` 并更新 `config.json` 注册它。

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

## 推荐的协作治理

多 agent 并行工作时，需要防止冲突覆盖和未授权操作。推荐安装 `kai-project-governance` 技能。

### 为什么需要

**典型问题：**
- 两个 agent 同时修改同一个文件，后提交的覆盖前提交的
- Agent A 在项目 X 工作，Agent B 误以为项目空闲，开始修改同一区域
- 发布、提交、破坏性操作未经确认就执行

**kai-project-governance 的三层防护：**

| 层级 | 名称 | 触发条件 | 行为 | 用户感知 |
|---|---|---|---|---|
| Tier 1 | LINT | 文件变更、git 操作 | 静默检测冲突，记录到 broker | 零感知（无冲突时） |
| Tier 2 | NOTIFY | agent 主动调用 | 向 channel 或 @all 发通知 | 需显式调用 |
| Tier 3 | GATE | 设了环境变量 | 强制阻断未授权操作 | 需配置启用 |

**默认只启用 Tier 1（LINT）** — 零配置、静默工作、不改变任何行为。

### 安装方式

**给 AI agent 的指令：**

检查当前 agent 类型，执行对应安装命令：

```bash
# Claude Code
if [ -d ~/.claude/skills ]; then
  ln -sf ~/projects/intent-broker/adapters/kai-project-governance ~/.claude/skills/kai-project-governance
fi

# Codex
if [ -d ~/.codex/skills ]; then
  ln -sf ~/projects/intent-broker/adapters/kai-project-governance ~/.codex/skills/kai-project-governance
fi

# xiaok-code
if [ -d ~/.xiaok/skills ]; then
  ln -sf ~/projects/intent-broker/adapters/kai-project-governance ~/.xiaok/skills/kai-project-governance
fi

# Qoder CLI
if [ -d ~/.qoder/skills ]; then
  ln -sf ~/projects/intent-broker/adapters/kai-project-governance ~/.qoder/skills/kai-project-governance
fi

# agy (antigravity-cli)
if [ -d ~/.gemini/antigravity-cli ]; then
  node ~/projects/intent-broker/adapters/agy-plugin/bin/agy-broker.js install
fi

# OpenCode
if [ -d ~/.config/opencode ]; then
  node ~/projects/intent-broker/adapters/opencode-plugin/bin/opencode-broker.js install
fi
```

**验证安装成功：**

```bash
# 检查 symlink 是否存在
ls -l ~/.claude/skills/kai-project-governance  # 应指向 intent-broker/adapters/kai-project-governance
```

### 禁用和卸载

如果不需要协作治理（比如单人项目），可以禁用或卸载：

**禁用 Tier 1 LINT：**
```bash
export KAI_PROJECT_GOVERNANCE_LINT=0
```

**完全卸载：**
```bash
rm ~/.claude/skills/kai-project-governance
rm ~/.codex/skills/kai-project-governance
rm ~/.xiaok/skills/kai-project-governance
rm ~/.qoder/skills/kai-project-governance
```

### 推荐安装场景

| 场景 | 推荐 | 原因 |
|---|---|---|
| 多 agent 并行开发 | ✅ 强烈推荐 | 冲突检测防止覆盖 |
| 单 agent 单项目 | ⚠️ 可选 | 无冲突风险，但 LINT 也是零感知 |
| 多项目切换 | ✅ 推荐 | 每个项目独立检测 |
| 有自己的 governance 方案 | ❌ 可卸载 | 避免重复机制 |

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

如果你是 Claude Code、Codex、Qoder CLI、OpenCode 或其他代码智能体，Intent Broker 应该被当成协作协议层来使用。

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

### 5. 角色（Role）声明

用户可能自然地说：
- "我是 PM" → 给当前 session 添加 `governance-pm` role
- "我是 broker 项目的 reviewer" → 给当前 session 在当前项目添加 `reviewer` role
- "我不再是 PM 了" → 移除 role

**AI agent 处理方式：**

```bash
# 添加 role
intent-broker role add governance-pm
# 或 HTTP API:
# POST /participants/:participantId/roles  {"roles": ["governance-pm"]}

# 移除 role
intent-broker role remove governance-pm
# 或 HTTP API:
# DELETE /participants/:participantId/roles  {"roles": ["governance-pm"]}

# 查询某个 role 的 participant
curl http://127.0.0.1:4318/participants?role=governance-pm
```

**标准 role 定义：**

| Role | 说明 |
|------|------|
| `coder` | 默认编码角色（注册时自带） |
| `governance-pm` | 项目治理 PM，负责审批和协调 |
| `reviewer` | 代码审查者 |
| `approver` | 发布/合并审批者 |

### 6. 重启后靠 replay 恢复

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
GET /participants?role=governance-pm
GET /participants/resolve?aliases=codex,claude
POST /participants/:participantId/alias
POST /participants/:participantId/roles  {"roles": ["governance-pm"]}
DELETE /participants/:participantId/roles  {"roles": ["governance-pm"]}
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

### 跨机器 Relay

不同机器上的 broker 可以通过云端 relay 同步事件，实现跨机器的 agent 协作，无需暴露本地端口。

```text
机器 A (Broker) ←→ WebSocket ←→ Relay (Cloudflare Worker) ←→ WebSocket ←→ 机器 B (Broker)
```

**快速开始：**

1. 获取 relay token — 在浏览器中打开 https://relay.kaihub.space/auth/login，用 GitHub 或 Google 登录，复制 JWT。

2. 在 `intent-broker.local.json` 中添加 relay 配置：

```json
{
  "relay": {
    "url": "wss://relay.kaihub.space/ws",
    "roomSecret": "<共享的房间密钥>",
    "jwt": "<你的JWT令牌>"
  }
}
```

3. 启动 broker — 它会自动连接 relay。

**工作原理：**

- 每台机器的 broker 向 relay 开启一条 WebSocket 连接
- 同一房间（由 `roomSecret` 派生）内的机器互相接收事件
- Relay 是无状态的 Cloudflare Worker + Durable Object — 不持久化事件，只做实时转发
- 所有事件仍在每台 broker 本地的 SQLite 中持久保存

**房间密钥：** 需要协作的机器必须共享相同的 `roomSecret`。可用 `openssl rand -hex 32` 生成。

**CLI 登录（备选）：**

```bash
node src/relay/relay-cli.js login --provider github
```

使用 OAuth Device Flow — 适用于无法打开浏览器的机器。

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
| Codex | `[features].hooks` + `~/.codex/hooks.json` + 受管 skill symlink |
| Qoder CLI | `~/.qoder/settings.json` hooks |
| xiaok-code | `~/.xiaok/plugins/intent-broker/` plugin |
| agy (antigravity-cli) | `~/.gemini/antigravity-cli/hooks.json`（Codex 格式） |
| OpenCode | `~/.config/opencode/plugins/intent-broker.js` plugin |

---

## 版本日志

**v0.3.8** — 任务生命周期治理与上下文同步：P0/P1 任务生命周期治理规则在所有 agent 之间强制执行一致的任务状态转换；本地上下文同步让 agent 可以交换工作区快照，具备部分重试和去重安全机制；事件时间戳现在解析为 UTC，修复了 broker 与 agent 时区不同时 `ageMs` 计算偏差的问题。

**v0.3.7** — KSwarm 投递合同加固：broker 任务投递失败不再生成合成任务完成结果，保留 Xiaok Desktop Swarm 项目的恢复和改派语义。

**v0.3.6** — Codex hook 安装器改用 `[features].hooks`，不再写入已废弃的 `[features].codex_hooks`；安装时会迁移旧配置，并可通过 `npm run codex:install` 刷新本地受管 hooks。

**v0.3.5** — Qoder CLI adapter：完整 hook 接入（SessionStart、UserPromptSubmit、PreToolUse、Stop），broker 启动时自动安装，`QODER_SESSION_ID` 环境变量检测。

**v0.3.4** — user-prompt-submit hook 中推送 `implementing` work-state，`who` 命令能正确显示工作中的 agent。

**v0.3.3** — 适配最新 HexDeck 打包/安装流程；相对 v0.3.2 无协议或 adapter 行为变更。

**v0.3.2** — Windows sidecar 和 Codex app-server 现以隐藏窗口启动，并使用跨进程启动锁；approval projection 扫描范围超出前 100 条事件，正确上报待确认数量；收紧 Codex resume 发现和 xiaok hook 覆盖范围。

**v0.3.1** — 压缩 broker informational 事件：过滤 markdown、50 字符摘要截断、总计最多 3 行。

**v0.3.0** — 全 3 个 adapter 接入 PreToolUse hook；Claude Code + xiaok AskUserQuestion 镜像；Codex 原生升级 + 破坏性命令检测；xiaok 人机确认/澄清往返；待处理 tool-use 上下文关联；hook 审批超时解决；压缩 informational broker 事件含截断；175 个测试。

**v0.2.3** — 优雅关机、启动时清理残留进程、session-keeper 自动恢复、realtime bridge 队列改进。

**v0.2.0** — Agent Group 协作：同项目自动发现、文件变更广播、冲突检测、文件锁；人机交互确认：阻塞式确认、超时 fallback；任务分发与审查；协作历史；降级容错。

**v0.1.0** — 初始原型：participant 注册、全局唯一 alias、按项目查询、work-state、task/ask/note/progress 投递语义、presence 追踪、inbox pull、任务/线程/事件查询。
