/**
 * Presence tracking for participants
 * Tracks online status, last seen, and activity
 */

export function createPresenceTracker() {
  const presenceMap = new Map();
  const PRESENCE_TIMEOUT_MS = 60000; // 1 minute

  return {
    updatePresence(participantId, status = 'online', metadata = {}) {
      const now = Date.now();
      presenceMap.set(participantId, {
        participantId,
        status,
        lastSeen: now,
        metadata
      });
      return presenceMap.get(participantId);
    },

    getPresence(participantId) {
      const presence = presenceMap.get(participantId);
      if (!presence) return null;

      const now = Date.now();
      const isStale = now - presence.lastSeen > PRESENCE_TIMEOUT_MS;

      return {
        ...presence,
        status: isStale ? 'offline' : presence.status
      };
    },

    listPresence() {
      const now = Date.now();
      return Array.from(presenceMap.values()).map(presence => ({
        ...presence,
        status: now - presence.lastSeen > PRESENCE_TIMEOUT_MS ? 'offline' : presence.status
      }));
    },

    removePresence(participantId) {
      return presenceMap.delete(participantId);
    }
  };
}
