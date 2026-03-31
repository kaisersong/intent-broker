# 云之家 Adapter

将云之家机器人接入 Intent Broker。

## 功能

- 通过 WebSocket 接收云之家消息（无需配置回调地址）
- 通过 HTTP POST 发送消息到云之家
- 自动转换消息格式
- 自动管理用户映射

## 安装

```bash
npm install
```

## 配置

复制 `.env.example` 为 `.env`，填入配置：

```bash
cp .env.example .env
```

只需要配置：
- `YZJ_SEND_URL` - 云之家机器人 Webhook URL

注意：
- `npm start` 会自动通过 `node --env-file=.env` 读取 `.env`
- `YZJ_SEND_URL` 必须保留双引号，因为 URL 中包含 `&`

## 获取云之家 Webhook URL

1. 登录云之家
2. 创建群机器人
3. 获取 Webhook URL，格式：
   ```
   https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=YOUR_TOKEN
   ```

## 启动

```bash
npm start
```

**无需在云之家侧配置任何回调地址！** Adapter 会自动通过 WebSocket 连接到云之家接收消息。

首次连接成功时，日志中会出现类似输出：

```text
✓ Broker WebSocket connected
✓ Yunzhijia WebSocket connected
📨 Received from Yunzhijia: {"success":true,"cmd":"auth"}
```

## 工作原理

### 接收消息（云之家 → Broker）

```
云之家 → WebSocket → Adapter → Broker → Agents
```

Adapter 通过 WebSocket 连接到 `wss://www.yunzhijia.com/xuntong/websocket?yzjtoken=TOKEN`，云之家会推送消息到这个连接。

### 发送消息（Broker → 云之家）

```
Agents → Broker → WebSocket → Adapter → HTTP POST → 云之家
```

Adapter 通过 HTTP POST 到云之家 Webhook URL 发送消息。

## 用户映射

首次发送消息时自动创建映射：
- 云之家 `operatorOpenid` → `human.yzj_{openid}`
- 自动注册为 broker participant

## 消息格式

Adapter 会自动转换消息格式：
- `request_approval` → 【需要审批】...
- `ask_clarification` → 【需要回答】...
- `report_progress` → 【进度】...

## 已验证状态

截至 2026-03-31，本地真实联调已验证：
- Yunzhijia WebSocket 能成功连接并收到平台 `auth` 帧
- 真实入站消息能转成 broker `ask_clarification` 事件
- 真实出站消息能通过机器人 webhook 发送成功
