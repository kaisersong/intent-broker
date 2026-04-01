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

    if (await this.handleCommand(text, { yzjUserId, participantId, msgId })) {
      return;
    }

    const routing = await this.resolveRouting(text, yzjUserId, msgId);
    if (!routing) {
      return;
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
        to: routing.to,
        payload: {
          body: { summary: routing.summary },
          metadata: { robotId, msgId, yzjUserId }
        }
      })
    });
    const result = await res.json().catch(() => ({}));

    if (res.ok) {
      console.log(`✓ Sent intent to broker`);
      await this.sendOfflineDeliveryHint({
        yzjUserId,
        replyMsgId: msgId,
        delivery: result,
        routing
      });
    } else {
      console.error(`❌ Failed to send intent: ${res.status}`);
    }
  }

  parseAliasRenameCommand(text) {
    const match = String(text || '').trim().match(/^\/(?:alias|rename)\s+@?([^\s@]+)\s+([^\s@]+)$/i);
    if (!match) {
      return null;
    }

    return {
      currentAlias: match[1],
      nextAlias: match[2]
    };
  }

  parseBrokerCommand(text) {
    const match = String(text || '').trim().match(/^(?:@broker|\/broker)\s+list(?:\s+(.+))?$/i);
    if (!match) {
      return null;
    }

    return {
      action: 'list',
      projectName: match[1]?.trim() || null
    };
  }

  async handleCommand(text, { yzjUserId, msgId } = {}) {
    const brokerCommand = this.parseBrokerCommand(text);
    if (brokerCommand?.action === 'list') {
      const message = await this.renderBrokerList(brokerCommand.projectName);
      await this.sendToChannel(message, msgId);
      return true;
    }

    const aliasRename = this.parseAliasRenameCommand(text);
    if (!aliasRename) {
      return false;
    }

    const query = encodeURIComponent(aliasRename.currentAlias);
    const resolved = await fetch(`${this.brokerUrl}/participants/resolve?aliases=${query}`).then((res) => res.json());
    const participant = resolved.participants?.[0];

    if (!participant) {
      await this.sendToYunzhijia(yzjUserId, `未找到别名: @${aliasRename.currentAlias}`, msgId);
      return true;
    }

    const renamed = await fetch(`${this.brokerUrl}/participants/${participant.participantId}/alias`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: aliasRename.nextAlias })
    }).then((res) => res.json());

    await this.sendToYunzhijia(
      yzjUserId,
      `alias 已更新: @${aliasRename.currentAlias} -> @${renamed.participant.alias}`,
      msgId
    );
    return true;
  }

  parseMentions(text) {
    const aliases = [];
    let hasAll = false;

    const summary = String(text || '')
      .replace(/(^|\s)@([^\s@]+)/g, (_, prefix, mention) => {
        const alias = mention.trim();
        if (alias.toLowerCase() === 'all') {
          hasAll = true;
        } else if (!aliases.includes(alias)) {
          aliases.push(alias);
        }
        return prefix || ' ';
      })
      .replace(/\s+/g, ' ')
      .trim();

    return { aliases, hasAll, summary };
  }

  async resolveRouting(text, yzjUserId, replyMsgId) {
    const mentions = this.parseMentions(text);

    if (mentions.hasAll) {
      const participants = await fetch(`${this.brokerUrl}/participants`).then((res) => res.json());
      const recipients = participants.participants
        .filter((participant) => participant.kind === 'agent')
        .map((participant) => participant.participantId);
      const participantsById = Object.fromEntries(
        participants.participants.map((participant) => [participant.participantId, participant])
      );

      return {
        to: { mode: 'participant', participants: recipients },
        summary: mentions.summary || text,
        participantsById
      };
    }

    if (!mentions.aliases.length) {
      return {
        to: { mode: 'broadcast' },
        summary: text
      };
    }

    const query = encodeURIComponent(mentions.aliases.join(','));
    const resolved = await fetch(`${this.brokerUrl}/participants/resolve?aliases=${query}`).then((res) => res.json());

    if (resolved.missingAliases?.length) {
      await this.sendToYunzhijia(
        yzjUserId,
        `未找到别名: ${resolved.missingAliases.map((alias) => `@${alias}`).join(', ')}`,
        replyMsgId
      );
      return null;
    }

    return {
      to: {
        mode: 'participant',
        participants: resolved.participants.map((participant) => participant.participantId)
      },
      summary: mentions.summary || text,
      participantsById: Object.fromEntries(
        resolved.participants.map((participant) => [participant.participantId, participant])
      )
    };
  }

  async renderBrokerList(projectName = null) {
    const participantsSuffix = projectName ? `?projectName=${encodeURIComponent(projectName)}` : '';
    const workStateSuffix = projectName ? `?projectName=${encodeURIComponent(projectName)}` : '';
    const [{ participants }, { participants: presenceItems }, { items: workStates }] = await Promise.all([
      fetch(`${this.brokerUrl}/participants${participantsSuffix}`).then((res) => res.json()),
      fetch(`${this.brokerUrl}/presence`).then((res) => res.json()),
      fetch(`${this.brokerUrl}/work-state${workStateSuffix}`).then((res) => res.json())
    ]);

    const agentParticipants = participants.filter((participant) => participant.kind === 'agent');
    const presenceById = new Map(
      (presenceItems || []).map((item) => [item.participantId, item])
    );
    const workStateById = new Map(
      (workStates || []).map((item) => [item.participantId, item])
    );

    const online = [];
    const offline = [];

    for (const participant of agentParticipants) {
      const presence = presenceById.get(participant.participantId);
      const workState = workStateById.get(participant.participantId);
      const status = presence?.status === 'online' ? 'online' : 'offline';
      const line = this.formatBrokerListLine(participant, workState);
      if (status === 'online') {
        online.push(line);
      } else {
        offline.push(line);
      }
    }

    const lines = [
      projectName ? `协作列表（项目: ${projectName}）` : '协作列表',
      `在线 (${online.length})`,
      ...(online.length ? online : ['- 无']),
      `离线 (${offline.length})`,
      ...(offline.length ? offline : ['- 无'])
    ];

    return lines.join('\n');
  }

  formatBrokerListLine(participant, workState) {
    const alias = participant.alias ? `@${participant.alias}` : participant.participantId;
    const project = participant.context?.projectName || '-';
    const status = workState?.status || 'idle';
    const summary = workState?.summary ? ` | ${workState.summary}` : '';
    return `- ${alias} | ${project} | ${status}${summary}`;
  }

  async sendOfflineDeliveryHint({ yzjUserId, replyMsgId, delivery, routing }) {
    const offlineRecipients = delivery?.offlineRecipients || [];
    if (!offlineRecipients.length) {
      return;
    }

    const { participants: presenceItems = [] } = await fetch(`${this.brokerUrl}/presence`).then((res) => res.json());
    const presenceById = new Map(presenceItems.map((item) => [item.participantId, item]));

    const onlineButDeferred = [];
    const offline = [];

    for (const participantId of offlineRecipients) {
      const participant = routing?.participantsById?.[participantId];
      const label = participant?.alias ? `@${participant.alias}` : participantId;
      if (presenceById.get(participantId)?.status === 'online') {
        onlineButDeferred.push(label);
      } else {
        offline.push(label);
      }
    }

    const hints = [];
    if (onlineButDeferred.length) {
      hints.push(`消息已写入 broker inbox，${onlineButDeferred.join('、')} 会话在线，但当前不是实时收件模式，需要目标会话下一次本地交互时才会看到。`);
    }
    if (offline.length) {
      hints.push(`消息已写入 broker inbox，但 ${offline.join('、')} 当前不在线，恢复后才能看到。`);
    }

    for (const hint of hints) {
      await this.sendToYunzhijia(yzjUserId, hint, replyMsgId);
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

    if (normalizedEvent.kind === 'participant_presence_updated') {
      if (normalizedEvent.payload?.participantKind === 'agent') {
        await this.sendToChannel(this.formatMessage(normalizedEvent));
      }
      return;
    }

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
      report_progress: summary ? `【进度】${summary}` : '【进度】',
      participant_alias_updated: summary ? `【别名更新】${summary}` : '【别名更新】',
      participant_presence_updated: summary ? `【协作状态】${summary}` : '【协作状态】'
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

    this.attachReplyMetadata(payload, message, replyMsgId);
    await this.postYunzhijiaPayload(payload);
    console.log(`✓ Sent message to Yunzhijia user ${yzjUserId}`);
  }

  async sendToChannel(message, replyMsgId) {
    const payload = {
      msgtype: 2,
      content: message
    };

    this.attachReplyMetadata(payload, message, replyMsgId);
    await this.postYunzhijiaPayload(payload);
    console.log('✓ Sent message to Yunzhijia channel');
  }

  attachReplyMetadata(payload, message, replyMsgId) {
    if (!replyMsgId) {
      return;
    }

    payload.param = {
      replyMsgId,
      replyTitle: '',
      isReference: true,
      replySummary: message.substring(0, 50)
    };
    payload.paramType = 3;
  }

  async postYunzhijiaPayload(payload) {
    await fetch(this.sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  stop() {
    this.stopped = true;
    this.closeSocket(this.brokerWs);
    this.closeSocket(this.yzjWs);
    for (const ws of this.userWebSockets.values()) {
      this.closeSocket(ws);
    }
  }

  closeSocket(ws) {
    if (!ws) {
      return;
    }

    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
        return;
      }
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    } catch (error) {
      console.error('Failed to close WebSocket cleanly:', error);
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const adapter = new YunzhijiaAdapter();
  adapter.start().catch(console.error);
}
