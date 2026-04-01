/**
 * Mobile adapter for Intent Broker
 * Lightweight adapter for mobile devices to receive notifications and approve tasks
 */
import WebSocket from 'ws';

export class MobileAdapter {
  constructor({ brokerUrl, participantId, roles = ['approver', 'reviewer'] }) {
    this.brokerUrl = brokerUrl;
    this.participantId = participantId;
    this.roles = roles;
    this.ws = null;
    this.ackCursor = 0;
    this.notificationHandlers = new Map();
  }

  async connect() {
    // Register as human participant
    const registerResponse = await fetch(`${this.brokerUrl}/participants/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantId: this.participantId,
        kind: 'human',
        roles: this.roles,
        capabilities: []
      })
    });

    if (!registerResponse.ok) {
      throw new Error(`Failed to register: ${registerResponse.statusText}`);
    }

    console.log(`✓ Mobile registered as ${this.participantId}`);

    // Connect WebSocket for real-time notifications
    this.ws = new WebSocket(`${this.brokerUrl.replace('http', 'ws')}/ws?participantId=${this.participantId}`);

    this.ws.on('open', () => {
      console.log('✓ Mobile WebSocket connected');
    });

    this.ws.on('message', async (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'new_intent') {
        await this.handleNotification(message.event);
      }
    });

    this.ws.on('error', (error) => {
      console.error('Mobile WebSocket error:', error.message);
    });

    this.ws.on('close', () => {
      console.log('Mobile WebSocket closed');
    });

    // Update presence
    await this.updatePresence('online', { device: 'mobile' });
  }
