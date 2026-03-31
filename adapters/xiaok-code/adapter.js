/**
 * xiaok code adapter for Intent Broker
 * Connects xiaok code to the Intent Broker for multi-agent collaboration
 */
import WebSocket from 'ws';

export class XiaokCodeAdapter {
  constructor({ brokerUrl, participantId, roles = ['coder'], capabilities = [] }) {
    this.brokerUrl = brokerUrl;
    this.participantId = participantId;
    this.roles = roles;
    this.capabilities = capabilities;
    this.ws = null;
    this.ackCursor = 0;
    this.handlers = new Map();
  }

  async connect() {
    // Register participant
    const registerResponse = await fetch(`${this.brokerUrl}/participants/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantId: this.participantId,
        kind: 'agent',
        roles: this.roles,
        capabilities: this.capabilities
      })
    });

    if (!registerResponse.ok) {
      throw new Error(`Failed to register: ${registerResponse.statusText}`);
    }

    console.log(`✓ xiaok code registered as ${this.participantId}`);

    // Connect WebSocket for real-time notifications
    this.ws = new WebSocket(`${this.brokerUrl.replace('http', 'ws')}/ws?participantId=${this.participantId}`);

    this.ws.on('open', () => {
      console.log('✓ WebSocket connected');
    });

    this.ws.on('message', async (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'new_intent') {
        await this.handleIntent(message.event);
      }
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
    });

    this.ws.on('close', () => {
      console.log('WebSocket closed');
    });

    // Update presence
    await this.updatePresence('online', { version: 'xiaok-1.0' });

    // Start polling inbox as backup
    this.startInboxPolling();
  }

  async disconnect() {
    if (this.ws) {
      this.ws.close();
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    await this.updatePresence('offline');
  }

  async updatePresence(status, metadata = {}) {
    const response = await fetch(`${this.brokerUrl}/presence/${this.participantId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, metadata })
    });
    return response.json();
  }

  startInboxPolling(intervalMs = 5000) {
    this.pollInterval = setInterval(async () => {
      await this.pollInbox();
    }, intervalMs);
  }

  async pollInbox() {
    const response = await fetch(`${this.brokerUrl}/inbox/${this.participantId}?after=${this.ackCursor}&limit=50`);
    const data = await response.json();

    for (const item of data.items || []) {
      await this.handleIntent(item);
      await this.ackIntent(item.eventId);
    }
  }

  async ackIntent(eventId) {
    await fetch(`${this.brokerUrl}/inbox/${this.participantId}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId })
    });
    this.ackCursor = eventId;
  }

  async handleIntent(event) {
    console.log(`[xiaok] Received intent: ${event.kind} (${event.intentId})`);

    const handler = this.handlers.get(event.kind);
    if (handler) {
      try {
        await handler(event);
      } catch (error) {
        console.error(`[xiaok] Error handling ${event.kind}:`, error.message);
      }
    }
  }

  on(intentKind, handler) {
    this.handlers.set(intentKind, handler);
  }

  async sendIntent(intent) {
    const response = await fetch(`${this.brokerUrl}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent)
    });
    return response.json();
  }

  async reportProgress(taskId, threadId, stage, message) {
    return this.sendIntent({
      intentId: `progress-${Date.now()}`,
      kind: 'report_progress',
      fromParticipantId: this.participantId,
      taskId,
      threadId,
      to: { mode: 'broadcast' },
      payload: { stage, body: { message } }
    });
  }

  async requestApproval(taskId, threadId, approvalId, approvalScope, message) {
    return this.sendIntent({
      intentId: `approval-req-${Date.now()}`,
      kind: 'request_approval',
      fromParticipantId: this.participantId,
      taskId,
      threadId,
      to: { mode: 'role', roles: ['reviewer', 'approver'] },
      payload: { approvalId, approvalScope, body: { message } }
    });
  }

  async submitResult(taskId, threadId, submissionId, result) {
    return this.sendIntent({
      intentId: `submit-${Date.now()}`,
      kind: 'submit_result',
      fromParticipantId: this.participantId,
      taskId,
      threadId,
      to: { mode: 'broadcast' },
      payload: { submissionId, body: result }
    });
  }
}
