/**
 * Conflict Detection Service
 *
 * 检测多 agent 同时修改同一文件
 *
 * 功能:
 * 1. 文件锁 - agent 修改文件前加锁
 * 2. 冲突检测 - 检测并发修改
 * 3. 冲突通知 - 通知相关 agent
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_ROOT = path.join(os.homedir(), '.intent-broker', 'conflict-detector');
const LOCKS_FILE = path.join(STATE_ROOT, 'file-locks.json');
const CONFLICTS_FILE = path.join(STATE_ROOT, 'conflicts.json');
const HISTORY_FILE = path.join(STATE_ROOT, 'conflict-history.json');

const LOCK_TIMEOUT_MS = 300000; // 5 分钟锁超时

function ensureStateDir() {
  mkdirSync(STATE_ROOT, { recursive: true });
}

function loadLocks() {
  try {
    return JSON.parse(readFileSync(LOCKS_FILE, 'utf8'));
  } catch {
    return { locks: [] };
  }
}

function saveLocks(locks) {
  ensureStateDir();
  writeFileSync(LOCKS_FILE, JSON.stringify(locks, null, 2));
}

function loadConflicts() {
  try {
    return JSON.parse(readFileSync(CONFLICTS_FILE, 'utf8'));
  } catch {
    return { conflicts: [] };
  }
}

function saveConflicts(conflicts) {
  ensureStateDir();
  writeFileSync(CONFLICTS_FILE, JSON.stringify(conflicts, null, 2));
}

function loadHistory() {
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { history: [] };
  }
}

function saveHistory(history) {
  ensureStateDir();
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function generateId() {
  return `lock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 获取文件锁
 */
export async function acquireFileLock({
  file,
  participantId,
  projectName,
  reason = '',
  brokerUrl = 'http://127.0.0.1:4318'
}) {
  const locks = loadLocks();
  const now = Date.now();

  // 清理过期锁
  locks.locks = locks.locks.filter(lock => lock.expiresAt > now);

  // 检查是否已有锁
  const existingLock = locks.locks.find(lock => lock.file === file && lock.expiresAt > now);

  if (existingLock) {
    if (existingLock.participantId === participantId) {
      // 自己的锁，续期
      existingLock.expiresAt = now + LOCK_TIMEOUT_MS;
      saveLocks(locks);
      return {
        success: true,
        acquired: true,
        lockId: existingLock.lockId,
        message: '锁已续期'
      };
    }

    // 别人的锁，检测冲突
    const conflict = {
      conflictId: generateId(),
      file,
      projectName,
      locks: [
        { participantId: existingLock.participantId, acquiredAt: existingLock.acquiredAt },
        { participantId, acquiredAt: now }
      ],
      createdAt: now,
      status: 'active'
    };

    const conflicts = loadConflicts();
    conflicts.conflicts.push(conflict);
    saveConflicts(conflicts);

    // 通知双方
    try {
      await fetch(`${brokerUrl}/intents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intentId: `conflict-${conflict.conflictId}`,
          kind: 'conflict_detected',
          fromParticipantId: 'conflict-detector',
          taskId: null,
          threadId: null,
          to: { mode: 'participant', participants: [existingLock.participantId, participantId] },
          payload: {
            body: {
              summary: `[冲突检测] ${file} 被多个 agent 同时修改`
            },
            metadata: {
              conflictId: conflict.conflictId,
              file,
              holders: conflict.locks
            },
            delivery: {
              semantic: 'actionable',
              source: 'conflict-detector'
            }
          }
        })
      });
    } catch (e) {
      console.error(`[Conflict] Failed to notify:`, e.message);
    }

    // 记录历史
    const history = loadHistory();
    history.history.push({ ...conflict, type: 'concurrent_lock' });
    saveHistory(history);

    return {
      success: false,
      acquired: false,
      conflict: true,
      heldBy: existingLock.participantId,
      conflictId: conflict.conflictId
    };
  }

  // 无锁，获取新锁
  const lockId = generateId();
  locks.locks.push({
    lockId,
    file,
    participantId,
    projectName,
    reason,
    acquiredAt: now,
    expiresAt: now + LOCK_TIMEOUT_MS
  });
  saveLocks(locks);

  return {
    success: true,
    acquired: true,
    lockId
  };
}

/**
 * 释放文件锁
 */
export function releaseFileLock({ lockId, participantId }) {
  const locks = loadLocks();
  const lockIndex = locks.locks.findIndex(
    lock => lock.lockId === lockId && lock.participantId === participantId
  );

  if (lockIndex === -1) {
    return { success: false, error: 'Lock not found or not owner' };
  }

  const lock = locks.locks[lockIndex];
  locks.locks.splice(lockIndex, 1);
  saveLocks(locks);

  // 记录历史
  const history = loadHistory();
  history.history.push({
    type: 'lock_released',
    lockId,
    file: lock.file,
    participantId,
    releasedAt: Date.now()
  });
  saveHistory(history);

  return { success: true, released: true };
}

/**
 * 检查文件是否有锁
 */
export function checkFileLock(file) {
  const locks = loadLocks();
  const now = Date.now();
  const activeLock = locks.locks.find(lock => lock.file === file && lock.expiresAt > now);

  if (activeLock) {
    return {
      locked: true,
      lockId: activeLock.lockId,
      participantId: activeLock.participantId,
      acquiredAt: activeLock.acquiredAt,
      expiresAt: activeLock.expiresAt
    };
  }

  return { locked: false };
}

/**
 * 通知组成员文件修改
 */
export async function notifyFileModified({
  file,
  participantId,
  projectName,
  changes = '',
  brokerUrl = 'http://127.0.0.1:4318'
}) {
  // 先获取锁（检测冲突）
  const lockResult = await acquireFileLock({
    file,
    participantId,
    projectName,
    reason: changes,
    brokerUrl
  });

  if (lockResult.conflict) {
    return {
      conflict: true,
      conflictId: lockResult.conflictId,
      heldBy: lockResult.heldBy
    };
  }

  // 通知组成员
  try {
    const res = await fetch(`${brokerUrl}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intentId: `file-modified-${file}-${Date.now()}`,
        kind: 'group_notification',
        fromParticipantId: participantId,
        taskId: null,
        threadId: null,
        to: { mode: 'broadcast' },
        payload: {
          body: {
            summary: `[文件修改] ${participantId} 修改了 ${file}`
          },
          metadata: {
            type: 'file_modified',
            file,
            changes,
            projectName,
            lockId: lockResult.lockId
          },
          delivery: {
            semantic: 'informational',
            source: 'conflict-detector'
          }
        }
      })
    });

    return {
      notified: res.ok,
      lockAcquired: true,
      lockId: lockResult.lockId
    };
  } catch (e) {
    return {
      notified: false,
      lockAcquired: true,
      lockId: lockResult.lockId,
      error: e.message
    };
  }
}

/**
 * 获取活跃冲突列表
 */
export function getActiveConflicts() {
  const conflicts = loadConflicts();
  return conflicts.conflicts.filter(c => c.status === 'active');
}

/**
 * 解决冲突
 */
export function resolveConflict({ conflictId, resolution, resolvedBy }) {
  const conflicts = loadConflicts();
  const conflict = conflicts.conflicts.find(c => c.conflictId === conflictId);

  if (!conflict) {
    return { success: false, error: 'Conflict not found' };
  }

  conflict.status = 'resolved';
  conflict.resolvedBy = resolvedBy;
  conflict.resolution = resolution;
  conflict.resolvedAt = Date.now();
  saveConflicts(conflicts);

  // 记录历史
  const history = loadHistory();
  history.history.push({
    type: 'conflict_resolved',
    conflictId,
    resolution,
    resolvedBy,
    resolvedAt: Date.now()
  });
  saveHistory(history);

  return { success: true, resolved: true };
}
