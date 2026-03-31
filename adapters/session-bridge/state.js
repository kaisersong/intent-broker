import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function loadCursorState(statePath) {
  try {
    const raw = readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastSeenEventId: Number(parsed?.lastSeenEventId || 0)
    };
  } catch {
    return { lastSeenEventId: 0 };
  }
}

export function saveCursorState(statePath, state) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        lastSeenEventId: Number(state?.lastSeenEventId || 0)
      },
      null,
      2
    )
  );
}
