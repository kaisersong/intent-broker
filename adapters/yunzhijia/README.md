# 云之家 Adapter

将云之家机器人接入 Intent Broker。

## 功能

- 通过 WebSocket 接收云之家消息（无需配置回调地址）
- 通过 HTTP POST 发送消息到云之家
- 自动转换消息格式
- 自动管理用户映射
- 支持 `@alias`、`@a @b`、`@all` 精确路由
- 支持 `/alias @旧名 新别名` 直接改 agent 短名

## 安装

```bash
npm install
```

## 配置

推荐方式是由 broker 托管云之家通道，而不是单独启动 adapter 进程。

在仓库根目录的 `intent-broker.config.json` 里启用：

```json
{
  "channels": {
    "yunzhijia": {
      "enabled": true,
      "sendUrlEnv": "YZJ_SEND_URL"
    }
  }
}
```

然后设置：

- `YZJ_SEND_URL` - 云之家机器人 Webhook URL

注意：

- `YZJ_SEND_URL` 建议通过环境变量提供，不要把真实 token 直接提交进配置文件
- URL 中包含 `&` 时，要保留 shell 引号

## 获取云之家 Webhook URL

1. 登录云之家
2. 创建群机器人
3. 获取 Webhook URL，格式：
   ```
   https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=YOUR_TOKEN
   ```

## 启动

```bash
YZJ_SEND_URL='https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=YOUR_TOKEN' npm start
```

**无需在云之家侧配置任何回调地址！** broker 托管的 Yunzhijia channel 会自动通过 WebSocket 连接到云之家接收消息。

如果云之家里 `@broker list`、`@broker who` 之类的命令突然没有回应，先在仓库根目录检查：

```bash
npm run broker:status
```

然后看 broker 的运行时文件：

- `.tmp/broker.stdout.log`
- `.tmp/broker.stderr.log`
- `.tmp/broker.heartbeat.json`

`broker:restart` 现在只有在 `/health` 成功且心跳状态进入 `running` 后才会报告 ready，因此这三份文件基本就是托管模式下的第一排障入口。

如果你需要单独调试，也可以继续直接运行：

```bash
YZJ_SEND_URL='https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=YOUR_TOKEN' node adapters/yunzhijia/index.js
```

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
- `participant_alias_updated` → 【别名更新】...

## 消息通道命令

云之家里现在支持：

- `@codex 看一下这个问题`
- `@codex @claude 一起处理`
- `@all 同步一下进度`
- `/alias @codex reviewer`

## 已验证状态

截至 2026-03-31，本地真实联调已验证：
- Yunzhijia WebSocket 能成功连接并收到平台 `auth` 帧
- 真实入站消息能转成 broker `ask_clarification` 事件
- 真实出站消息能通过机器人 webhook 发送成功
