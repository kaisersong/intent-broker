/**
 * WebSocket notification channel for real-time updates
 * Uses ws library for WebSocket server support
 */
import { WebSocketServer } from 'ws';

export function createWebSocketNotifier({ heartbeatIntervalMs = 30000 } = {}) {
  const connections = new Map(); // participantId -> Set<WebSocket>
  let wss = null;
  let heartbeatTimer = null;

  function startHeartbeat({ onHeartbeat } = {}) {
    if (heartbeatTimer || heartbeatIntervalMs <= 0) {
      return;
    }

    heartbeatTimer = setInterval(() => {
      for (const [participantId, sockets] of connections.entries()) {
        for (const ws of sockets) {
          if (ws.readyState !== 1) {
            continue;
          }

          if (ws.isAlive === false) {
            ws.terminate();
            continue;
          }

          ws.isAlive = false;
          ws.ping();
        }

        if (sockets.size > 0) {
          onHeartbeat?.({
            participantId,
            connectionCount: sockets.size
          });
        }
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  return {
    attachToServer(httpServer, { onConnect, onDisconnect, onHeartbeat } = {}) {
      wss = new WebSocketServer({ server: httpServer, path: '/ws' });
      startHeartbeat({ onHeartbeat });

      wss.on('connection', (ws, req) => {
        const url = new URL(req.url, 'ws://localhost');
        const participantId = url.searchParams.get('participantId');

        if (!participantId) {
          ws.close(1008, 'participantId required');
          return;
        }

        if (!connections.has(participantId)) {
          connections.set(participantId, new Set());
        }
        ws.isAlive = true;
        connections.get(participantId).add(ws);
        onConnect?.({
          participantId,
          connectionCount: connections.get(participantId).size
        });

        ws.on('pong', () => {
          ws.isAlive = true;
          onHeartbeat?.({
            participantId,
            connectionCount: connections.get(participantId)?.size ?? 0
          });
        });

        ws.on('close', () => {
          const sockets = connections.get(participantId);
          if (sockets) {
            sockets.delete(ws);
            if (sockets.size === 0) {
              connections.delete(participantId);
            }
          }
          onDisconnect?.({
            participantId,
            connectionCount: connections.get(participantId)?.size ?? 0
          });
        });

        ws.send(JSON.stringify({ type: 'connected', participantId }));
      });
    },

    notify(participantId, event) {
      const sockets = connections.get(participantId);
      if (!sockets) return 0;

      let sent = 0;
      for (const ws of sockets) {
        if (ws.readyState === 1) { // OPEN
          ws.send(JSON.stringify(event));
          sent++;
        }
      }
      return sent;
    },

    broadcast(event, excludeParticipantId = null) {
      let sent = 0;
      for (const [participantId, sockets] of connections.entries()) {
        if (participantId === excludeParticipantId) continue;
        for (const ws of sockets) {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify(event));
            sent++;
          }
        }
      }
      return sent;
    },

    getConnectionCount(participantId) {
      return connections.get(participantId)?.size ?? 0;
    },

    listConnections() {
      return Array.from(connections.keys());
    },

    close() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      for (const sockets of connections.values()) {
        for (const ws of sockets) {
          try {
            ws.terminate();
          } catch {
            // best effort during shutdown
          }
        }
      }
      connections.clear();

      if (wss) {
        wss.close();
      }
    }
  };
}
