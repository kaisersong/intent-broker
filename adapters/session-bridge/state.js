import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function normalizeRecentContext(recentContext) {
  if (!recentContext || typeof recentContext !== 'object') {
    return null;
  }

  return {
    eventId: Number(recentContext.eventId || 0) || null,
    kind: recentContext.kind ?? null,
    fromParticipantId: recentContext.fromParticipantId ?? null,
    fromAlias: recentContext.fromAlias ?? null,
    fromProjectName: recentContext.fromProjectName ?? null,
    taskId: recentContext.taskId ?? null,
    threadId: recentContext.threadId ?? null,
    summary: recentContext.summary ?? null
  };
}

export function loadCursorState(statePath) {
  try {
    const raw = readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastSeenEventId: Number(parsed?.lastSeenEventId || 0),
      recentContext: normalizeRecentContext(parsed?.recentContext)
    };
  } catch {
    return { lastSeenEventId: 0, recentContext: null };
  }
}

export function saveCursorState(statePath, state) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        lastSeenEventId: Number(state?.lastSeenEventId || 0),
        recentContext: normalizeRecentContext(state?.recentContext)
      },
      null,
      2
    )
  );
}
