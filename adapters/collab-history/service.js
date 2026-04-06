/**
 * Collaboration History Service
 *
 * 记录协作历史，提供统计分析
 *
 * 功能:
 * 1. 事件记录 - 记录所有协作事件
 * 2. 查询历史 - 按条件查询
 * 3. 统计分析 - 生成统计报告
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_ROOT = path.join(os.homedir(), '.intent-broker', 'collab-history');
const HISTORY_FILE = path.join(STATE_ROOT, 'history.json');

const EVENT_TYPES = {
  FILE_MODIFIED: 'file_modified',
  CONFLICT_DETECTED: 'conflict_detected',
  TASK_CREATED: 'task_created',
  TASK_ASSIGNED: 'task_assigned',
  TASK_COMPLETED: 'task_completed',
  REVIEW_REQUESTED: 'review_requested',
  REVIEW_COMPLETED: 'review_completed',
  CONFIRM_SENT: 'confirm_sent',
  CONFIRM_RECEIVED: 'confirm_received',
  GROUP_NOTIFY: 'group_notify'
};

function ensureStateDir() {
  mkdirSync(STATE_ROOT, { recursive: true });
}

function loadHistory() {
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { events: [] };
  }
}

function saveHistory(history) {
  ensureStateDir();
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

/**
 * 记录事件
 */
export function recordEvent({
  type,
  participantId,
  projectName,
  metadata = {},
  summary = ''
}) {
  const history = loadHistory();

  const event = {
    eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    participantId,
    projectName,
    metadata,
    summary,
    timestamp: Date.now()
  };

  history.events.push(event);

  // 保留最近 1000 条
  if (history.events.length > 1000) {
    history.events = history.events.slice(-1000);
  }

  saveHistory(history);
  return event;
}

/**
 * 查询历史事件
 */
export function queryHistory({
  type,
  participantId,
  projectName,
  since,
  until,
  limit = 50
} = {}) {
  let events = loadHistory().events;

  if (type) {
    events = events.filter(e => e.type === type);
  }

  if (participantId) {
    events = events.filter(e => e.participantId === participantId);
  }

  if (projectName) {
    events = events.filter(e => e.projectName === projectName);
  }

  if (since) {
    events = events.filter(e => e.timestamp >= since);
  }

  if (until) {
    events = events.filter(e => e.timestamp <= until);
  }

  return events.slice(-limit);
}

/**
 * 生成统计报告
 */
export function generateStats({ projectName, days = 7 } = {}) {
  const history = loadHistory();
  const now = Date.now();
  const cutoff = now - (days * 24 * 60 * 60 * 1000);

  let events = history.events.filter(e => e.timestamp >= cutoff);

  if (projectName) {
    events = events.filter(e => e.projectName === projectName);
  }

  const stats = {
    period: `${days} days`,
    projectName,
    totalEvents: events.length,
    byType: {},
    byParticipant: {},
    conflicts: {
      detected: events.filter(e => e.type === EVENT_TYPES.CONFLICT_DETECTED).length,
      resolved: events.filter(e => e.type === 'conflict_resolved').length
    },
    tasks: {
      created: events.filter(e => e.type === EVENT_TYPES.TASK_CREATED).length,
      completed: events.filter(e => e.type === EVENT_TYPES.TASK_COMPLETED).length
    },
    reviews: {
      requested: events.filter(e => e.type === EVENT_TYPES.REVIEW_REQUESTED).length,
      completed: events.filter(e => e.type === EVENT_TYPES.REVIEW_COMPLETED).length
    }
  };

  // 按类型统计
  for (const event of events) {
    stats.byType[event.type] = (stats.byType[event.type] || 0) + 1;
  }

  // 按参与者统计
  for (const event of events) {
    const key = event.participantId;
    stats.byParticipant[key] = (stats.byParticipant[key] || 0) + 1;
  }

  return stats;
}

/**
 * 获取最近活动
 */
export function getRecentActivity({ limit = 10 } = {}) {
  const history = loadHistory();
  return history.events
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map(e => ({
      eventId: e.eventId,
      type: e.type,
      summary: e.summary,
      participantId: e.participantId,
      timestamp: e.timestamp
    }));
}
