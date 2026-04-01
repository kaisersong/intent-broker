/**
 * WebSocket notification channel for real-time updates
 * Uses ws library for WebSocket server support
 */
import { WebSocketServer } from 'ws';

export function createWebSocketNotifier() {
  const connections = new Map(); // participantId -> Set<WebSocket>
  let wss = null;

  return {
    attachToServer(httpServer, { onConnect, onDisconnect } = {}) {
      wss = new WebSocketServer({ server: httpServer, path: '/ws' });

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
        connections.get(participantId).add(ws);
        onConnect?.({
          participantId,
          connectionCount: connections.get(participantId).size
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
