# Intent Broker Adapters

本目录包含了 Intent Broker 的所有 agent adapter 实现。

## 可用的 Adapters

### 1. Claude Code Adapter
- **路径**: `claude-code/`
- **能力**: 前端开发、后端开发、测试
- **默认角色**: coder, reviewer
- **默认能力**: frontend.react, backend.node, testing

### 2. Codex Adapter
- **路径**: `codex/`
- **能力**: 代码审查、重构、架构设计、安全审计
- **默认角色**: coder, reviewer, architect
- **默认能力**: code-review, refactoring, architecture, security-audit

### 3. OpenCode Adapter
- **路径**: `opencode/`
- **能力**: Vue 前端、Python 后端、pytest 测试
- **默认角色**: coder, tester
- **默认能力**: frontend.vue, backend.python, testing.pytest

### 4. xiaok code Adapter
- **路径**: `xiaok-code/`
- **能力**: React 前端、UI 设计、中文本地化
- **默认角色**: coder, designer
- **默认能力**: frontend.react, ui-design, chinese-localization

## 快速开始

### 启动单个 Adapter

```bash
# 启动 Claude Code adapter
node adapters/claude-code/example.js

# 启动 Codex adapter
node adapters/codex/example.js

# 启动 OpenCode adapter
node adapters/opencode/example.js

# 启动 xiaok code adapter
node adapters/xiaok-code/example.js
```

### 启动所有 Adapters（多 Agent 协作演示）

```bash
node adapters/demo.js
```

这将同时启动所有四个 adapter，演示多 agent 协作场景。

## 发送任务示例

### 发送给特定 Adapter

```bash
curl -X POST http://127.0.0.1:4318/intents \
  -H "Content-Type: application/json" \
  -d '{
    "intentId": "task-1",
    "kind": "request_task",
    "fromParticipantId": "human.song",
    "taskId": "task-1",
    "threadId": "thread-1",
    "to": {"mode": "participant", "participants": ["claude-code-1"]},
    "payload": {"body": {"summary": "实现用户认证功能"}}
  }'
```

### 按角色路由

```bash
curl -X POST http://127.0.0.1:4318/intents \
  -H "Content-Type: application/json" \
  -d '{
    "intentId": "task-2",
    "kind": "request_task",
    "fromParticipantId": "human.song",
    "taskId": "task-2",
    "threadId": "thread-2",
    "to": {"mode": "role", "roles": ["reviewer"]},
    "payload": {"body": {"summary": "代码审查"}}
  }'
```

### 按能力路由

```bash
curl -X POST http://127.0.0.1:4318/intents \
  -H "Content-Type: application/json" \
  -d '{
    "intentId": "task-3",
    "kind": "request_task",
    "fromParticipantId": "human.song",
    "taskId": "task-3",
    "threadId": "thread-3",
    "to": {"mode": "capability", "capabilities": ["frontend.react"]},
    "payload": {"body": {"summary": "修复 React 组件 bug"}}
  }'
```

### 广播给所有 Agents

```bash
curl -X POST http://127.0.0.1:4318/intents \
  -H "Content-Type: application/json" \
  -d '{
    "intentId": "task-4",
    "kind": "request_task",
    "fromParticipantId": "human.song",
    "taskId": "task-4",
    "threadId": "thread-4",
    "to": {"mode": "broadcast"},
    "payload": {"body": {"summary": "紧急任务：修复生产环境 bug"}}
  }'
```

## Adapter 架构

每个 adapter 都实现了相同的接口：

```javascript
class Adapter {
  constructor({ brokerUrl, participantId, roles, capabilities })
  async connect()
  async disconnect()
  async updatePresence(status, metadata)
  on(intentKind, handler)
  async sendIntent(intent)
  async reportProgress(taskId, threadId, stage, message)
  async requestApproval(taskId, threadId, approvalId, approvalScope, message)
  async submitResult(taskId, threadId, submissionId, result)
}
```

## 自定义 Adapter

要创建自己的 adapter，可以参考现有的实现：

```javascript
import { YourToolAdapter } from './adapter.js';

const adapter = new YourToolAdapter({
  brokerUrl: 'http://127.0.0.1:4318',
  participantId: 'your-tool-1',
  roles: ['coder'],
  capabilities: ['your-capability']
});

// 处理任务请求
adapter.on('request_task', async (event) => {
  // 1. 接受任务
  await adapter.sendIntent({
    intentId: `accept-${Date.now()}`,
    kind: 'accept_task',
    fromParticipantId: adapter.participantId,
    taskId: event.taskId,
    threadId: event.threadId,
    to: { mode: 'broadcast' },
    payload: { assignmentMode: 'solo' }
  });

  // 2. 报告进度
  await adapter.reportProgress(
    event.taskId,
    event.threadId,
    'in_progress',
    'Working on it...'
  );

  // 3. 执行任务
  // ... your implementation ...

  // 4. 请求审批
  const approvalId = `approval-${Date.now()}`;
  await adapter.requestApproval(
    event.taskId,
    event.threadId,
    approvalId,
    'submit_result',
    'Ready to submit?'
  );
});

// 处理审批响应
adapter.on('respond_approval', async (event) => {
  if (event.payload.decision === 'approved') {
    await adapter.submitResult(
      event.taskId,
      event.threadId,
      `submission-${Date.now()}`,
      { status: 'completed' }
    );
  }
});

await adapter.connect();
```

## 协作流程

典型的多 agent 协作流程：

1. **Human** 发送任务 → Intent Broker
2. **Broker** 根据路由规则分发任务
3. **Agent** 接收任务并接受
4. **Agent** 报告进度
5. **Agent** 请求审批
6. **Human** 批准审批
7. **Agent** 接收审批响应
8. **Agent** 提交结果
9. **Broker** 广播结果给所有参与者

## 监控和调试

### 查看在线状态

```bash
curl http://127.0.0.1:4318/presence
```

### 查看任务状态

```bash
curl http://127.0.0.1:4318/tasks/task-1
```

### 查看任务线程

```bash
curl http://127.0.0.1:4318/threads/thread-1
```

### 重放事件

```bash
curl "http://127.0.0.1:4318/events/replay?after=0&taskId=task-1"
```

## 注意事项

1. 确保 Intent Broker 服务已启动：`npm start`
2. 每个 adapter 需要唯一的 `participantId`
3. WebSocket 连接失败时会自动降级到 HTTP inbox 轮询
4. Presence 状态会在 60 秒无活动后自动标记为 offline
5. 所有事件都会持久化到 SQLite 数据库

## 下一步

- 为你的工具创建自定义 adapter
- 实现更复杂的任务分配策略
- 添加任务优先级和队列管理
- 实现 agent 之间的直接通信
- 添加任务超时和重试机制
