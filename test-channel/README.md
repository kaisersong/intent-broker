# Intent Broker Test Channel

模拟云之家 channel 的测试工具，用于验证 Intent Broker 完整闭环。

## 功能

- 模拟用户发送消息到 broker
- 监听 agent 回复
- 支持场景测试和交互模式
- 显示完整的交互流程

## 安装

```bash
cd /Users/song/projects/intent-broker/test-channel
npm install
```

## 用法

### 场景测试（默认）

自动执行多个测试场景：

```bash
node test-channel.js
# 或
npm test
```

输出示例：
```
=== 场景测试 ===

【场景 1】广播消息 @all
📤 发送消息：@all 请回复 1+1=?
✅ 收到：2

【场景 2】定向消息 @codex
📤 发送消息：@codex 请计算 5*6=?
✅ 收到：30

【场景 3】多轮对话
📤 发送消息：@xiaok 你好
✅ 第一轮：你好，我在
📤 发送消息：继续上题，2+8=?
✅ 第二轮：10
```

### 交互模式

手动输入消息与 agent 交互：

```bash
node test-channel.js --interactive
# 或
npm run interactive
```

示例会话：
```
你：@codex 帮我写个快速排序
⏳ 等待回复...
✅ 收到回复：function quickSort(arr) {...}

你：@all 现在几点了？
⏳ 等待回复...
✅ 收到回复：现在是 2026-04-06 16:30
```

### 发送单条消息

```bash
node test-channel.js "Hello @all"
```

## 配置

环境变量：
- `BROKER_URL` - Broker 服务器地址 (默认：http://127.0.0.1:4318)

## 测试场景

### 场景 1: 广播消息
测试 @all 广播功能，验证所有在线 agent 都能收到消息。

### 场景 2: 定向消息
测试 @agent 定向发送，验证消息正确路由到指定 agent。

### 场景 3: 多轮对话
测试上下文理解，验证 agent 能理解多轮对话的上下文。

## 输出说明

| 图标 | 含义 |
|------|------|
| 🧪 | Test Channel 启动 |
| ✓ | 成功事件 |
| 📤 | 发送消息 |
| 📨 | 收到消息 |
| ✅ | 收到回复 |
| ⏰ | 超时未回复 |
| ⏳ | 等待中 |
| 📋 | 参与者列表 |

## 技术原理

1. **用户注册**: 通过 broker API 注册 `human.test-user-001` 参与者
2. **WebSocket 连接**: 连接到 broker WebSocket 接收消息推送
3. **发送消息**: 通过 broker REST API 发送 intent
4. **等待回复**: 监听 WebSocket 消息，匹配对应 threadId
5. **结果显示**: 格式化显示交互流程

## 调试

查看详细日志：

```bash
DEBUG=1 node test-channel.js --interactive
```

查看 broker 日志：

```bash
tail -f /Users/song/projects/intent-broker/.tmp/broker.stdout.log
```

## 与真实云之家的区别

| 特性 | Test Channel | 真实云之家 |
|------|-------------|-----------|
| 消息格式 | 直接 JSON | 嵌套在 msg 字段 |
| 用户 ID | test-user-001 | yzj 用户 ID |
| 认证 | 无 | yzjtoken 认证 |
| 网络 | 本地 | HTTPS |
| 消息类型 | 简化 | 完整云之家协议 |
