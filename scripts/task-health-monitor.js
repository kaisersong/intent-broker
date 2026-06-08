#!/usr/bin/env node
import { execFile as execFileDefault } from 'node:child_process';

const BROKER_URL = process.env.BROKER_URL || 'http://127.0.0.1:4318';
const BROKER_API_KEY = process.env.BROKER_API_KEY || '';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3 * 60 * 1000;
const TASK_STALE_MS = Number(process.env.TASK_STALE_MS) || 10 * 60 * 1000;
const TASK_NO_PROGRESS_MS = Number(process.env.TASK_NO_PROGRESS_MS) || 15 * 60 * 1000;
const NOTIFY_DEDUP_MS = Number(process.env.NOTIFY_DEDUP_MS) || 30 * 60 * 1000;
const ONCE = process.argv.includes('--once');

let running = true;
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function sanitizeForAppleScript(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export { SAFE_ID_RE };

const notifiedTasks = new Map();

export function notify(title, msg, { execFile = execFileDefault } = {}) {
  if (process.platform !== 'darwin') {
    console.log(`[NOTIFY] ${title}: ${msg}`);
    return;
  }
  execFile('osascript', [
    '-e', `display notification "${sanitizeForAppleScript(msg)}" with title "${sanitizeForAppleScript(title)}" sound name "Submarine"`
  ], (err) => {
    if (err) console.error('[notify] osascript error:', err.message);
  });
}

const defaultHeaders = BROKER_API_KEY ? { Authorization: `Bearer ${BROKER_API_KEY}` } : {};

export async function fetchJSON(path, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${BROKER_URL}${path}`, { headers: defaultHeaders });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

async function getOpenTasks(opts) {
  const data = await fetchJSON('/tasks?status=open', opts);
  return data.tasks || data || [];
}

async function getParticipants(opts) {
  const data = await fetchJSON('/participants', opts);
  const list = data.participants || data || [];
  return new Map(list.map(p => [p.participantId, p]));
}

async function getTaskEvents(taskId, opts) {
  const data = await fetchJSON(`/events/replay?taskId=${encodeURIComponent(taskId)}&limit=200`, opts);
  return data.items || data.events || data || [];
}

export function parseTimestamp(ts) {
  if (!ts) return 0;
  const hasTz = ts.includes('Z') || ts.includes('+');
  const ms = new Date(hasTz ? ts : ts + 'Z').getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function shouldNotify(taskId, { now = Date.now } = {}) {
  const t = now();
  const lastNotified = notifiedTasks.get(taskId);
  if (lastNotified && (t - lastNotified) < NOTIFY_DEDUP_MS) return false;
  notifiedTasks.set(taskId, t);
  return true;
}

export async function check(opts = {}) {
  const { execFile: execFileOpt, fetchImpl } = opts;
  const tasks = await getOpenTasks({ fetchImpl });
  const participants = await getParticipants({ fetchImpl });
  const now = Date.now();
  let stuckCount = 0;

  const taskEvents = await Promise.all(
    tasks.map(async (task) => {
      try {
        return { task, events: await getTaskEvents(task.taskId, { fetchImpl }) };
      } catch (err) {
        console.error(`[warn] failed to fetch events for ${task.taskId}: ${err.message}`);
        return { task, events: [] };
      }
    })
  );

  for (const { task, events } of taskEvents) {
    const taskId = task.taskId;
    if (!events.length) continue;

    const requestEvent = events.find(e => e.kind === 'request_task');
    if (!requestEvent) continue;

    const firstEventTime = parseTimestamp(requestEvent.createdAt);
    if (!firstEventTime) continue;

    const age = now - firstEventTime;
    if (age < TASK_STALE_MS) continue;

    const hasAck = events.some(e => e.kind === 'accept_task');
    const hasProgress = events.some(e => e.kind === 'report_progress');
    const hasCompletion = events.some(e => ['complete_task', 'submit_work', 'task_failed'].includes(e.kind));

    if (hasCompletion) continue;

    const targetIds = (requestEvent.payload?.delivery?.targetParticipantIds) || [];
    const targetStatuses = targetIds.map(id => {
      const p = participants.get(id);
      const alias = (p?.alias && SAFE_ID_RE.test(p.alias)) ? p.alias : id;
      return { id, alias, online: !!p };
    });

    if (!hasAck && !hasProgress) {
      stuckCount++;
      if (!shouldNotify(taskId)) continue;

      const offlineTargets = targetStatuses.filter(t => !t.online);
      const onlineTargets = targetStatuses.filter(t => t.online);

      if (offlineTargets.length) {
        notify('Broker: Agent Offline',
          `Task ${taskId} (${Math.round(age/60000)}min) — target ${offlineTargets.map(t=>t.alias).join(',')} is OFFLINE`,
          { execFile: execFileOpt });
      } else if (onlineTargets.length && age > TASK_NO_PROGRESS_MS) {
        notify('Broker: No Response',
          `Task ${taskId} (${Math.round(age/60000)}min) — ${onlineTargets.map(t=>t.alias).join(',')} online but no response`,
          { execFile: execFileOpt });
      }
    }
  }

  for (const [id, ts] of notifiedTasks) {
    if (now - ts > NOTIFY_DEDUP_MS * 2) notifiedTasks.delete(id);
  }

  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] checked ${tasks.length} open tasks, ${stuckCount} stuck`);
}

async function main() {
  console.log(`[task-health-monitor] polling ${BROKER_URL} every ${POLL_INTERVAL_MS/1000}s`);
  while (running) {
    try {
      await check();
    } catch (err) {
      console.error(`[error] ${err.message}`);
    }
    if (ONCE || !running) break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log('[task-health-monitor] stopped');
}

main();
