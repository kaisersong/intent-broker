# 云之家 Adapter 快速开始

## 工作原理

```
云之家群聊 ←→ 云之家机器人 ←→ Adapter ←→ Intent Broker ←→ Agents
```

- **接收消息**：Adapter 主动连接云之家 WebSocket
- **发送消息**：Adapter POST 到云之家机器人 webhook URL

## 配置步骤

### 1. 创建云之家机器人

1. 在云之家群聊中添加机器人
2. 获取机器人 Webhook URL（发送消息用）：
   ```
   https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=YOUR_TOKEN
   ```

### 2. 配置 Adapter

```bash
cd adapters/yunzhijia
npm install
cp .env.example .env
```

编辑 `.env`：
```bash
BROKER_URL=http://127.0.0.1:4318
YZJ_SEND_URL="https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=YOUR_TOKEN"
```

不需要为云之家配置任何回调地址，也不需要暴露本地端口。

## 启动

### 启动 Intent Broker

```bash
cd /Users/song/projects/intent-broker
npm start
```

### 启动云之家 Adapter

```bash
cd adapters/yunzhijia
npm start
```

## 测试

### 测试接收消息

在云之家群聊中 @机器人 发送消息，应该能看到：
- Adapter 收到消息并打印日志
- 消息转发到 Intent Broker
- Broker 广播给其他 participants
- 首次连接时 Yunzhijia 会先发送 `{"success":true,"cmd":"auth"}`，这是正常现象

### 测试发送消息

从 Intent Broker 发送消息：
```bash
curl -X POST http://127.0.0.1:4318/intents \
  -H "Content-Type: application/json" \
  -d '{
    "intentId": "test-1",
    "kind": "report_progress",
    "fromParticipantId": "agent.test",
    "taskId": "task-1",
    "to": {
      "mode": "participant",
      "participants": ["human.yzj_USER_OPENID"]
    },
    "payload": {
      "body": { "summary": "测试消息" }
    }
  }'
```

应该能在云之家群聊中收到机器人发送的消息。

## 消息流程

### 云之家 → Broker

1. 用户在群聊中 @机器人 发送消息
2. Adapter 通过 `wss://www.yunzhijia.com/xuntong/websocket?yzjtoken=TOKEN` 收到消息
3. Adapter 解析消息，提取 `openId` / `operatorOpenid` 和文本内容
4. Adapter 创建或查找 `human.yzj_{openid}` participant
5. Adapter 发送 intent 到 Broker
6. Broker 路由到相关 agents

### Broker → 云之家

1. Agent 发送 intent 到 Broker
2. Broker 通过 WebSocket 通知 Adapter
3. Adapter 查找云之家用户 ID
4. Adapter POST 到云之家 webhook URL
5. 云之家机器人在群聊中发送消息

## 故障排查

### Adapter 无法启动

- 检查 `YZJ_SEND_URL` 是否配置
- 检查 `.env` 中的 `YZJ_SEND_URL` 是否保留双引号
- 直接运行 `npm start`，不要手动 `source .env`

### 收不到云之家消息

- 检查 adapter 日志中是否出现 `✓ Yunzhijia WebSocket connected`
- 检查是否能看到 `{"success":true,"cmd":"auth"}` 登录帧
- 查看 Adapter 日志

### 发不出消息到云之家

- 检查 `YZJ_SEND_URL` 是否正确
- 检查 token 是否有效
- 检查用户映射是否正确（必须先收到该用户的消息）
