/**
 * Presence tracking for participants
 * Tracks online status, last seen, and activity
 */

export function createPresenceTracker({ timeoutMs = 60000 } = {}) {
  const presenceMap = new Map();

  function materializePresence(presence) {
    if (!presence) {
      return null;
    }

    const now = Date.now();
    const isStale = now - presence.lastSeen > timeoutMs;

    return {
      ...presence,
      status: isStale ? 'offline' : presence.status,
      isStale
    };
  }

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

    peekPresence(participantId) {
      return presenceMap.get(participantId) ?? null;
    },

    getPresence(participantId) {
      return materializePresence(presenceMap.get(participantId));
    },

    listPresence() {
      return Array.from(presenceMap.values()).map((presence) => materializePresence(presence));
    },

    removePresence(participantId) {
      return presenceMap.delete(participantId);
    }
  };
}
