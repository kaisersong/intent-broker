import { execFile as execFileDefault } from 'node:child_process';

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function sanitizeForAppleScript(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function createHumanEscalation({ enableDesktopNotify = true, execFile = execFileDefault } = {}) {
  return function onTaskUnacked({ taskId, ageMs, targetParticipantIds }) {
    if (process.platform !== 'darwin' || !enableDesktopNotify) return;

    const minutes = Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : '?';
    const safeTargets = (targetParticipantIds || [])
      .filter(id => SAFE_ID_RE.test(id))
      .join(', ') || 'none';
    const safeTaskId = SAFE_ID_RE.test(taskId) ? taskId : '<invalid>';

    const msg = sanitizeForAppleScript(
      `Task ${safeTaskId} unacked for ${minutes}min. Targets: ${safeTargets}`
    );

    execFile('osascript', [
      '-e',
      `display notification "${msg}" with title "Intent Broker" sound name "Submarine"`
    ], (err) => {
      if (err) console.error('[human-escalation] osascript failed:', err.message);
    });
  };
}
