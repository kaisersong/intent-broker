#!/usr/bin/env node
/**
 * 云之家 Adapter
 * 通过 WebSocket 接收消息，通过 HTTP POST 发送消息
 */

import { WebSocket } from 'ws';

export const ADAPTER_ID = 'adapter.yunzhijia';

export function deriveWebSocketUrl(sendMsgUrl) {
  const url = new URL(sendMsgUrl);
  const token = url.searchParams.get('yzjtoken');
  if (!token) throw new Error('Missing yzjtoken in YZJ_SEND_URL');
  return `wss://${url.host}/xuntong/websocket?yzjtoken=${encodeURIComponent(token)}`;
}

export class YunzhijiaAdapter {
  constructor({
    brokerUrl = process.env.BROKER_URL || 'http://127.0.0.1:4318',
    sendUrl = process.env.YZJ_SEND_URL
  } = {}) {
    this.brokerUrl = brokerUrl;
    this.sendUrl = sendUrl;
    this.userMapping = new Map(); // yzjUserId -> participantId
    this.userWebSockets = new Map(); // participantId -> WebSocket
    this.brokerWs = null;
    this.yzjWs = null;
    this.stopped = false;
  }

  async start() {
    console.log('🚀 Starting Yunzhijia Adapter...');
    if (!this.sendUrl) throw new Error('YZJ_SEND_URL not configured');
    this.stopped = false;

    await this.registerToBroker();
    await this.connectBrokerWebSocket();
    await this.connectYunzhijiaWebSocket();

    console.log('✅ Yunzhijia Adapter ready');
  }

  async registerToBroker() {
    const res = await fetch(`${this.brokerUrl}/participants/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantId: ADAPTER_ID,
        kind: 'adapter',
        roles: ['message_gateway'],
        capabilities: ['yunzhijia.im']
      })
    });
    if (!res.ok) throw new Error('Failed to register to broker');
    console.log('✓ Registered to broker');
  }

  async connectBrokerWebSocket() {
    this.brokerWs = new WebSocket(`${this.brokerUrl.replace('http', 'ws')}/ws?participantId=${ADAPTER_ID}`);
    this.brokerWs.on('open', () => console.log('✓ Broker WebSocket connected'));
    this.brokerWs.on('message', (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === 'new_intent') this.handleBrokerEvent(event.event);
    });
    this.brokerWs.on('error', (err) => console.error('Broker WebSocket error:', err));
  }

  async connectYunzhijiaWebSocket() {
    const wsUrl = deriveWebSocketUrl(this.sendUrl);
    console.log(`Connecting to Yunzhijia: ${wsUrl}`);

    this.yzjWs = new WebSocket(wsUrl);

    this.yzjWs.on('open', () => {
      console.log('✓ Yunzhijia WebSocket connected');
    });

    this.yzjWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (this.isControlMessage(message)) return;
        this.handleYunzhijiaMessage(message);
      } catch (err) {
        console.error('Failed to parse Yunzhijia message:', err);
      }
    });

    this.yzjWs.on('error', (err) => {
      console.error('Yunzhijia WebSocket error:', err);
    });

    this.yzjWs.on('close', () => {
      if (this.stopped) return;
      console.log('Yunzhijia WebSocket closed, reconnecting...');
      setTimeout(() => {
        if (!this.stopped) this.connectYunzhijiaWebSocket();
      }, 5000);
    });
  }

  isControlMessage(message) {
    if (typeof message === 'string') {
      const normalized = message.trim().toLowerCase();
      return normalized === 'ping' || normalized === 'pong';
    }
    const type = message.type?.toLowerCase();
    const event = message.event?.toLowerCase();
    return ['ping', 'pong', 'ack', 'close'].includes(type) ||
           ['ping', 'pong', 'ack', 'close'].includes(event);
  }

  async handleYunzhijiaMessage(message) {
    console.log(`📨 Received from Yunzhijia:`, JSON.stringify(message).substring(0, 200));

    // 云之家消息可能嵌套在 msg 字段中
    const msg = message.msg || message;

    const yzjUserId = msg.openId || msg.operatorOpenid || msg.from_user;
    const text = msg.content || msg.text?.content;
    const robotId = msg.robotId;
    const msgId = msg.msgId;

    if (!yzjUserId || !text) {
      console.log('Skipping message: missing userId or text', { yzjUserId, text });
      return;
    }

    let participantId = this.userMapping.get(yzjUserId);
    if (!participantId) {
      participantId = `human.yzj_${yzjUserId}`;
      this.userMapping.set(yzjUserId, participantId);
      await this.registerUser(participantId);
      console.log(`✓ Registered new user: ${participantId}`);
    }

    const res = await fetch(`${this.brokerUrl}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intentId: `yzj-${msgId || Date.now()}`,
        kind: 'ask_clarification',
        fromParticipantId: participantId,
        taskId: 'task-1',
        threadId: 'thread-1',
        to: { mode: 'broadcast' },
        payload: {
          body: { summary: text },
          metadata: { robotId, msgId, yzjUserId }
        }
      })
    });

    if (res.ok) {
      console.log(`✓ Sent intent to broker`);
    } else {
      console.error(`❌ Failed to send intent: ${res.status}`);
    }
  }

  async registerUser(participantId) {
    await fetch(`${this.brokerUrl}/participants/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantId,
        kind: 'human',
        roles: ['approver']
      })
    });

    // 为该用户建立 WebSocket 连接以接收消息
    this.connectUserWebSocket(participantId);
  }

  connectUserWebSocket(participantId) {
    if (this.userWebSockets.has(participantId)) return;

    const ws = new WebSocket(`${this.brokerUrl.replace('http', 'ws')}/ws?participantId=${participantId}`);

    ws.on('open', () => {
      console.log(`✓ User WebSocket connected: ${participantId}`);
    });

    ws.on('message', (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === 'new_intent') {
        this.handleMessageToUser(participantId, event.event);
      }
    });

    ws.on('error', (err) => {
      console.error(`User WebSocket error (${participantId}):`, err);
    });

    ws.on('close', () => {
      console.log(`User WebSocket closed: ${participantId}, reconnecting...`);
      this.userWebSockets.delete(participantId);
      if (!this.stopped) {
        setTimeout(() => {
          if (!this.stopped) this.connectUserWebSocket(participantId);
        }, 5000);
      }
    });

    this.userWebSockets.set(participantId, ws);
  }

  async handleMessageToUser(participantId, event) {
    const normalizedEvent = this.unwrapBrokerEvent(event);
    const yzjUserId = this.findYunzhijiaUser(participantId);
    if (!yzjUserId) return;

    const message = this.formatMessage(normalizedEvent);
    const metadata = normalizedEvent.payload?.metadata || {};
    await this.sendToYunzhijia(yzjUserId, message, metadata.msgId);
  }

  async handleBrokerEvent(event) {
    const normalizedEvent = this.unwrapBrokerEvent(event);
    if (normalizedEvent.fromParticipantId?.startsWith('human.yzj_')) return;

    const targetParticipantId = normalizedEvent.fromParticipantId;
    if (!targetParticipantId) return;

    const yzjUserId = this.findYunzhijiaUser(targetParticipantId);
    if (!yzjUserId) return;

    const message = this.formatMessage(normalizedEvent);
    const metadata = normalizedEvent.payload?.metadata || {};
    await this.sendToYunzhijia(yzjUserId, message, metadata.msgId);
  }

  unwrapBrokerEvent(event) {
    let current = event;
    while (current?.event) {
      current = current.event;
    }
    return current;
  }

  formatMessage(event) {
    const summary = event.payload?.body?.summary;
    const templates = {
      request_approval: summary ? `【需要审批】${summary}` : '【需要审批】',
      ask_clarification: summary ? `【需要回答】${summary}` : '【需要回答】',
      report_progress: summary ? `【进度】${summary}` : '【进度】'
    };
    return templates[event.kind] || summary || event.kind;
  }

  findYunzhijiaUser(participantId) {
    for (const [yzjUserId, pid] of this.userMapping.entries()) {
      if (pid === participantId) return yzjUserId;
    }
    return null;
  }

  async sendToYunzhijia(yzjUserId, message, replyMsgId) {
    const payload = {
      msgtype: 2,
      content: message,
      notifyParams: [{
        type: 'openIds',
        values: [yzjUserId]
      }]
    };

    if (replyMsgId) {
      payload.param = {
        replyMsgId,
        replyTitle: '',
        isReference: true,
        replySummary: message.substring(0, 50)
      };
      payload.paramType = 3;
    }

    await fetch(this.sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log(`✓ Sent message to Yunzhijia user ${yzjUserId}`);
  }

  stop() {
    this.stopped = true;
    this.brokerWs?.close();
    this.yzjWs?.close();
    for (const ws of this.userWebSockets.values()) {
      ws.close();
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const adapter = new YunzhijiaAdapter();
  adapter.start().catch(console.error);
}
