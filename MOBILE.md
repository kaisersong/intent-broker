# 手机连接指南

## 概述

手机可以作为特殊的 participant 连接到 Intent Broker，用于：
- 接收实时通知（任务请求、审批请求、澄清问题）
- 进行审批和确认操作
- 查看任务状态

## 连接方式

### 1. 注册为手机 participant

```http
POST /participants/register
Content-Type: application/json

{
  "participantId": "mobile.user123",
  "kind": "mobile",
  "roles": ["approver", "observer"]
}
```

### 2. 建立 WebSocket 连接

```javascript
const ws = new WebSocket('ws://127.0.0.1:4318/ws?participantId=mobile.user123');

ws.onmessage = (event) => {
  const notification = JSON.parse(event.data);

  if (notification.type === 'mobile_notification') {
    // 显示推送通知
    showNotification(notification.title, {
      body: notification.body,
      data: notification.data
    });
  }
};
```

### 3. 拉取待办事项

手机专用的 inbox 端点只返回需要人类确认的事件：

```http
GET /mobile/inbox/mobile.user123?after=0&limit=20
```

返回的事件类型：
- `request_approval` - 需要审批
- `ask_clarification` - 需要回答问题
- `request_task` - 新任务分配

### 4. 响应审批

```http
POST /approvals/{approvalId}/respond
Content-Type: application/json

{
  "taskId": "task-1",
  "fromParticipantId": "mobile.user123",
  "decision": "approved"
}
```

`decision` 可选值：`approved` | `rejected` | `needs_revision`

## 通知格式

手机端收到的 WebSocket 通知格式：

```json
{
  "type": "mobile_notification",
  "eventId": 123,
  "timestamp": "2026-03-31T05:34:01.285Z",
  "title": "需要审批",
  "body": "请审批导出字体修复方案",
  "action": "approve",
  "data": {
    "approvalId": "approval-1",
    "taskId": "task-1"
  }
}
```

## 示例：React Native 集成

```javascript
import { useEffect, useState } from 'react';

function useBrokerConnection(participantId) {
  const [ws, setWs] = useState(null);
  const [notifications, setNotifications] = useState([]);

  useEffect(() => {
    const socket = new WebSocket(
      `ws://127.0.0.1:4318/ws?participantId=${participantId}`
    );

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'mobile_notification') {
        setNotifications(prev => [...prev, data]);
      }
    };

    setWs(socket);
    return () => socket.close();
  }, [participantId]);

  const approve = async (approvalId, taskId) => {
    await fetch(`http://127.0.0.1:4318/approvals/${approvalId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId,
        fromParticipantId: participantId,
        decision: 'approved'
      })
    });
  };

  return { notifications, approve };
}
```

## 与 OpenClaw 对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| WebSocket + HTTP | 轻量、已实现、灵活 | 需要保持连接 |
| OpenClaw Channel | 统一协议、跨平台 | 额外依赖、复杂度高 |

当前推荐使用 WebSocket 方案，后续如需跨设备同步可考虑 OpenClaw。
