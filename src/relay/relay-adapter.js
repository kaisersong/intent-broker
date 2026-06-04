import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  RELAY_MESSAGE_TYPES,
  ALLOWED_CLIENT_TYPES,
  MAX_MESSAGE_SIZE,
  HEARTBEAT_INTERVAL_MS,
  CLOSE_CODES,
  createEventEnvelope,
  createPing,
  createBye,
  createSyncRequest,
  deriveRoomId,
} from './protocol.js';
import { loadCredentials, isTokenExpired } from './credential-store.js';

const RECONNECT_CONFIG = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  multiplier: 2,
  jitter: 0.3,
  resetAfterMs: 60000,
};

export function createRelayAdapter({ brokerService, relayConfig, brokerId, logger = console }) {
  let ws = null;
  let state = 'DISCONNECTED'; // DISCONNECTED | CONNECTING | CONNECTED | DRAINING
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let pollTimer = null;
  let lastRelaySeq = 0;
  let localCursor = 0;
  let stopped = false;
  let connectedAt = 0;
  const outboundBuffer = [];
  const MAX_BUFFER_SIZE = relayConfig.bufferMaxSize || 1000;
  const seenIntentIds = new Set();
  const SEEN_WINDOW_SIZE = 5000;
  const localNodeId = relayConfig.nodeId || null;
  const remoteNodes = new Map();

  function log(level, msg, data) {
    logger[level]?.(`[relay-adapter] ${msg}`, data || '');
  }

  function registerRemoteParticipant(payload, originBrokerId) {
    const remoteNodeId = remoteNodes.get(originBrokerId);
    if (!remoteNodeId) return;

    const participantId = payload.participantId;
    const remoteAlias = payload.alias;
    if (!participantId || !remoteAlias) return;

    if (payload.status === 'offline') {
      try {
        brokerService.updatePresence(participantId, 'offline', {
          fromRelay: true,
          originBrokerId,
          reason: 'remote-offline'
        });
      } catch (_) { /* participant may not be registered yet */ }
      return;
    }

    const prefixedAlias = `${remoteNodeId}:${remoteAlias}`;
    try {
      brokerService.registerParticipant({
        participantId,
        kind: payload.participantKind || 'agent',
        roles: payload.roles || [],
        capabilities: payload.capabilities || [],
        alias: prefixedAlias,
        context: payload.projectName ? { projectName: payload.projectName } : {},
        metadata: { fromRelay: true, originBrokerId, nodeId: remoteNodeId },
        inboxMode: 'relay'
      });
    } catch (err) {
      log('warn', `failed to register remote participant ${participantId}: ${err.message}`);
    }
  }

  function getReconnectDelay() {
    const base = Math.min(
      RECONNECT_CONFIG.initialDelayMs * Math.pow(RECONNECT_CONFIG.multiplier, reconnectAttempt),
      RECONNECT_CONFIG.maxDelayMs
    );
    const jitter = base * RECONNECT_CONFIG.jitter * (Math.random() * 2 - 1);
    return Math.round(base + jitter);
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = getReconnectDelay();
    reconnectAttempt++;
    log('info', `reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(createPing()));
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      pollAndForward();
    }, 2000);
    pollTimer.unref?.();
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollAndForward() {
    if (state !== 'CONNECTED' && outboundBuffer.length >= MAX_BUFFER_SIZE) return;

    const events = brokerService.replayEvents({ after: localCursor, limit: 50 });
    if (!events?.items?.length) return;

    for (const event of events.items) {
      if (event.payload?.fromRelay) {
        localCursor = event.eventId;
        continue;
      }

      const envelope = createEventEnvelope({
        intentId: event.intentId,
        kind: event.kind,
        fromParticipantId: event.fromParticipantId,
        taskId: event.taskId,
        threadId: event.threadId,
        payloadJson: event.payload,
        originBrokerId: brokerId,
        originEventId: event.eventId,
        nodeId: localNodeId,
      });

      if (state === 'CONNECTED' && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(envelope));
      } else {
        if (outboundBuffer.length < MAX_BUFFER_SIZE) {
          outboundBuffer.push(envelope);
        }
      }
      localCursor = event.eventId;
    }
  }

  function flushBuffer() {
    while (outboundBuffer.length > 0 && ws?.readyState === WebSocket.OPEN) {
      const msg = outboundBuffer.shift();
      ws.send(JSON.stringify(msg));
    }
  }

  function handleMessage(raw) {
    if (raw.length > MAX_MESSAGE_SIZE) {
      log('warn', 'received oversized message, ignoring');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      log('warn', 'received invalid JSON');
      return;
    }

    switch (msg.type) {
      case RELAY_MESSAGE_TYPES.HELLO:
        handleHello(msg);
        break;
      case RELAY_MESSAGE_TYPES.PONG:
        break;
      case RELAY_MESSAGE_TYPES.EVENT:
        handleRemoteEvent(msg);
        break;
      case RELAY_MESSAGE_TYPES.RATE_WARNING:
        log('warn', `rate limit warning: ${msg.remaining} remaining, reset in ${msg.resetMs}ms`);
        break;
      case RELAY_MESSAGE_TYPES.PEER_JOINED:
        log('info', `peer joined (${msg.peerCount} total)`);
        break;
      case RELAY_MESSAGE_TYPES.PEER_LEFT:
        log('info', `peer left (${msg.peerCount} total)`);
        if (msg.peerId) {
          for (const p of brokerService.listParticipants()) {
            if (p.metadata?.originBrokerId === msg.peerId) {
              try {
                brokerService.updatePresence(p.participantId, 'offline', {
                  fromRelay: true, originBrokerId: msg.peerId, reason: 'peer-left'
                });
              } catch (_) {}
            }
          }
          remoteNodes.delete(msg.peerId);
        }
        break;
      case RELAY_MESSAGE_TYPES.VERSION_NOTICE:
        log('info', `new broker version available: ${msg.latest}`);
        break;
      case RELAY_MESSAGE_TYPES.DRAINING:
        handleDraining(msg);
        break;
      case RELAY_MESSAGE_TYPES.SYNC_REQUEST:
        handleSyncRequest(msg);
        break;
      case RELAY_MESSAGE_TYPES.SYNC_RESPONSE:
        handleSyncResponse(msg);
        break;
      default:
        break;
    }
  }

  function handleHello(msg) {
    state = 'CONNECTED';
    connectedAt = Date.now();
    reconnectAttempt = 0;
    lastRelaySeq = msg.seq || 0;
    log('info', `connected to relay (peers: ${msg.connectedPeers}, version: ${msg.relayVersion})`);

    if (msg.latestBrokerVersion && msg.minBrokerVersion) {
      log('info', `latest broker: ${msg.latestBrokerVersion}, min: ${msg.minBrokerVersion}`);
    }

    startHeartbeat();
    flushBuffer();

    if (relayConfig.syncOnReconnect !== false) {
      ws.send(JSON.stringify(createSyncRequest(lastRelaySeq)));
    }
  }

  function handleRemoteEvent(msg) {
    const { payload } = msg;
    if (!payload?.intentId) return;

    if (payload.originBrokerId === brokerId) return;

    if (seenIntentIds.has(payload.intentId)) return;
    seenIntentIds.add(payload.intentId);
    if (seenIntentIds.size > SEEN_WINDOW_SIZE) {
      const iter = seenIntentIds.values();
      for (let i = 0; i < 1000; i++) iter.next();
      const arr = [...seenIntentIds];
      seenIntentIds.clear();
      for (const id of arr.slice(-SEEN_WINDOW_SIZE + 1000)) {
        seenIntentIds.add(id);
      }
    }

    if (payload.nodeId && payload.originBrokerId) {
      const previousNodeId = remoteNodes.get(payload.originBrokerId);
      if (previousNodeId && previousNodeId !== payload.nodeId) {
        for (const p of brokerService.listParticipants()) {
          if (p.metadata?.originBrokerId === payload.originBrokerId && p.metadata?.nodeId === previousNodeId) {
            try {
              brokerService.updatePresence(p.participantId, 'offline', {
                fromRelay: true, originBrokerId: payload.originBrokerId, reason: 'node-id-changed'
              });
            } catch (_) {}
          }
        }
        log('info', `remote broker ${payload.originBrokerId} changed nodeId: ${previousNodeId} → ${payload.nodeId}`);
      }
      remoteNodes.set(payload.originBrokerId, payload.nodeId);
    }

    brokerService.sendIntent({
      intentId: payload.intentId,
      kind: payload.kind,
      fromParticipantId: payload.fromParticipantId,
      taskId: payload.taskId,
      threadId: payload.threadId,
      to: { mode: 'broadcast' },
      payload: {
        ...payload.payloadJson,
        fromRelay: true,
        originBrokerId: payload.originBrokerId,
      },
    });

    if (payload.kind === 'participant_presence_updated' && payload.payloadJson) {
      registerRemoteParticipant(payload.payloadJson, payload.originBrokerId);
    }
  }

  function handleDraining(msg) {
    state = 'DRAINING';
    log('info', `relay draining, will reconnect in ${msg.reconnectAfterMs}ms`);
    stopHeartbeat();
  }

  function handleSyncRequest(msg) {
    const events = brokerService.replayEvents({ after: 0, limit: 100 });
    const response = [];
    for (const event of events?.items || []) {
      if (event.payload?.fromRelay) continue;
      response.push({
        intentId: event.intentId,
        kind: event.kind,
        fromParticipantId: event.fromParticipantId,
        taskId: event.taskId,
        threadId: event.threadId,
        payloadJson: event.payload,
        originBrokerId: brokerId,
        originEventId: event.eventId,
        nodeId: localNodeId,
      });
    }
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: RELAY_MESSAGE_TYPES.SYNC_RESPONSE,
        events: response.slice(-100),
        hasMore: false,
      }));
    }
  }

  function handleSyncResponse(msg) {
    if (!Array.isArray(msg.events)) return;
    for (const payload of msg.events) {
      handleRemoteEvent({ type: RELAY_MESSAGE_TYPES.EVENT, payload });
    }
    log('info', `sync received ${msg.events.length} events`);
  }

  async function connect() {
    if (stopped) return;
    state = 'CONNECTING';

    const credentials = await loadCredentials();
    if (!credentials?.jwt || isTokenExpired(credentials)) {
      log('warn', 'no valid credentials, run: intent-broker relay login');
      scheduleReconnect();
      return;
    }

    const roomId = await deriveRoomId(relayConfig.roomSecret);
    const url = relayConfig.url;

    try {
      ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${credentials.jwt}`,
          'X-Room-Id': roomId,
          'X-Broker-Id': brokerId,
          'X-Broker-Version': relayConfig.brokerVersion || '0.0.0',
          'X-Protocol-Version': String(PROTOCOL_VERSION),
          ...(localNodeId ? { 'X-Node-Id': localNodeId } : {}),
        },
      });
    } catch (err) {
      log('error', `WebSocket creation failed: ${err.message}`);
      state = 'DISCONNECTED';
      scheduleReconnect();
      return;
    }

    ws.on('upgrade', () => {});

    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 409) {
          log('error', `nodeId "${localNodeId}" is already in use in this room. Change relay.nodeId and restart.`);
          stopped = true;
          stopPolling();
          return;
        }
        log('warn', `relay rejected connection: HTTP ${res.statusCode} ${body}`);
        state = 'DISCONNECTED';
        scheduleReconnect();
      });
    });

    ws.on('open', () => {
      log('info', 'WebSocket connected, waiting for hello');
    });

    ws.on('message', (data) => {
      handleMessage(data.toString());
    });

    ws.on('close', (code, reason) => {
      state = 'DISCONNECTED';
      stopHeartbeat();
      log('info', `disconnected (code: ${code}, reason: ${reason?.toString() || ''})`);
      if (!stopped) {
        scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      log('error', `WebSocket error: ${err.message}`);
    });
  }

  return {
    async start() {
      if (stopped) return;
      if (!relayConfig?.url || !relayConfig?.roomSecret) {
        log('info', 'relay not configured, skipping');
        return;
      }
      if (relayConfig.roomSecret.length < 32) {
        log('error', 'roomSecret must be at least 32 characters');
        return;
      }
      if (localNodeId && !/^[a-z0-9]{2,4}$/.test(localNodeId)) {
        log('error', 'relay.nodeId must be 2-4 lowercase letters/digits');
        return;
      }
      if (!localNodeId) {
        log('warn', 'relay.nodeId not set, cross-node @node:alias addressing disabled');
      }

      const lastEvent = brokerService.replayEvents({ after: 0, limit: 1 });
      // Set cursor to latest to avoid replaying full history on first connect
      const allEvents = brokerService.replayEvents({ after: 0, limit: 999999 });
      if (allEvents?.items?.length) {
        localCursor = allEvents.items[allEvents.items.length - 1].eventId;
      }

      startPolling();
      await connect();
    },

    async stop() {
      stopped = true;
      stopPolling();
      stopHeartbeat();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(createBye()));
        }
        ws.close(CLOSE_CODES.NORMAL);
        ws = null;
      }
      state = 'DISCONNECTED';
    },

    getState() {
      return {
        state,
        reconnectAttempt,
        localCursor,
        lastRelaySeq,
        bufferSize: outboundBuffer.length,
        connectedAt: connectedAt || null,
      };
    },
  };
}
