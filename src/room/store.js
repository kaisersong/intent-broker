/**
 * CollaborationRoom durable store (design §6, §9.1, §16.1).
 *
 * Room tables are durable domain tables, separate from the generic
 * events / inbox_entries / participant_cursors surfaces:
 *
 *   rooms                    — room identity, status, revision, epoch
 *   room_members             — membership with reservation protocol states
 *   room_sequences           — per-room monotonic message sequence
 *   room_messages            — room transcript
 *   room_message_deliveries  — per logical recipient visibility + wake state
 *   room_recipient_cursors   — per logical recipient seen cursor
 *   room_membership_leases   — membership-use leases (30s TTL)
 *   room_execution_audit     — settled/expired execution outcomes
 *
 * Migrations are ordered and transactional: a failed step rolls back its
 * DDL and the recorded version together (no partial forward progress).
 */
import { DatabaseSync } from 'node:sqlite';
import { ROOM_SCHEMA_VERSION } from './constants.js';

function mapRoomRow(row) {
  if (!row) return null;
  return {
    roomId: row.room_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    origin: row.origin,
    createdBy: JSON.parse(row.created_by_json),
    revision: row.revision,
    discussionEpoch: row.discussion_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function memberSubject(row) {
  return row.subject_kind === 'user'
    ? { kind: 'user', userId: row.subject_id }
    : { kind: 'agent', logicalAgentId: row.subject_id };
}

function mapMemberRow(row) {
  if (!row) return null;
  return {
    roomId: row.room_id,
    subject: memberSubject(row),
    role: row.role,
    status: row.status,
    addedBy: JSON.parse(row.added_by_json),
    membershipRevision: row.membership_revision,
    addedAt: row.added_at,
    removedAt: row.removed_at ?? undefined,
  };
}

function mapMessageRow(row) {
  if (!row) return null;
  return {
    messageId: row.room_message_id,
    roomId: row.room_id,
    threadId: row.thread_id,
    sender: JSON.parse(row.sender_json),
    kind: row.kind,
    text: row.text ?? undefined,
    replyToMessageId: row.reply_to_message_id ?? undefined,
    contextScope: JSON.parse(row.context_scope_json),
    mentions: JSON.parse(row.mentions_json),
    responsePolicy: row.response_policy,
    sourceRef: row.source_ref_json ? JSON.parse(row.source_ref_json) : undefined,
    idempotencyKey: row.idempotency_key,
    roomSequence: row.room_sequence,
    discussionEpoch: row.discussion_epoch,
    createdAt: row.created_at,
  };
}

function mapDeliveryRow(row) {
  if (!row) return null;
  return {
    roomMessageId: row.room_message_id,
    recipientKey: row.recipient_key,
    logicalRecipientId: row.logical_recipient_id ?? undefined,
    runtimeParticipantIdSnapshot: row.runtime_participant_id_snapshot ?? undefined,
    visibilityStatus: row.visibility_status,
    wakeStatus: row.wake_status,
    claimLeaseUntil: row.claim_lease_until ?? undefined,
    claimToken: row.claim_token ?? undefined,
  };
}

export function getDefaultMigrations() {
  return [
    {
      version: 1,
      id: 'room_core_tables',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS rooms (
            room_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            origin TEXT NOT NULL DEFAULT 'user_created',
            created_by_json TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            discussion_epoch INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived_at TEXT
          );

          CREATE TABLE IF NOT EXISTS room_members (
            room_id TEXT NOT NULL,
            subject_kind TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            status TEXT NOT NULL DEFAULT 'active',
            added_by_json TEXT NOT NULL,
            membership_revision INTEGER NOT NULL DEFAULT 1,
            added_at TEXT NOT NULL,
            removed_at TEXT,
            PRIMARY KEY (room_id, subject_kind, subject_id)
          );

          CREATE TABLE IF NOT EXISTS room_sequences (
            room_id TEXT PRIMARY KEY,
            last_sequence INTEGER NOT NULL DEFAULT 0
          );

          CREATE TABLE IF NOT EXISTS room_messages (
            room_message_id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            sender_json TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'text',
            text TEXT,
            reply_to_message_id TEXT,
            context_scope_json TEXT NOT NULL,
            mentions_json TEXT NOT NULL DEFAULT '[]',
            response_policy TEXT NOT NULL DEFAULT 'none',
            source_ref_json TEXT,
            idempotency_key TEXT NOT NULL,
            room_sequence INTEGER NOT NULL,
            discussion_epoch INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            UNIQUE (room_id, idempotency_key)
          );

          CREATE TABLE IF NOT EXISTS room_message_deliveries (
            room_message_id TEXT NOT NULL,
            recipient_key TEXT NOT NULL,
            logical_recipient_id TEXT,
            runtime_participant_id_snapshot TEXT,
            visibility_status TEXT NOT NULL DEFAULT 'pending',
            wake_status TEXT NOT NULL DEFAULT 'not_requested',
            claim_lease_until TEXT,
            claim_token TEXT,
            UNIQUE (room_message_id, recipient_key)
          );

          CREATE TABLE IF NOT EXISTS room_recipient_cursors (
            room_id TEXT NOT NULL,
            recipient_key TEXT NOT NULL,
            last_seen_room_sequence INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (room_id, recipient_key)
          );

          CREATE TABLE IF NOT EXISTS room_membership_leases (
            token TEXT PRIMARY KEY,
            room_id TEXT NOT NULL,
            logical_agent_id TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            room_revision INTEGER NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_room_messages_room_seq
            ON room_messages(room_id, room_sequence);
          CREATE INDEX IF NOT EXISTS idx_room_deliveries_recipient
            ON room_message_deliveries(recipient_key, wake_status);
        `);
      },
    },
    {
      // 固化为字面值 2（历史真实版本号），不再动态引用 ROOM_SCHEMA_VERSION——
      // 之前写成 `version: ROOM_SCHEMA_VERSION` 是一个隐患：当常量被更新为
      // 指向更新的版本时，这一步会意外跟着"滑动"到新版本号，与后续新增的
      // 迁移步骤发生版本号冲突（两个不同的 up() 共享同一个 version，导致
      // migrate() 的 `step.version <= current` 累加判断把其中一步静默跳过）。
      version: 2,
      id: 'room_execution_audit',
      createsTable: 'room_execution_audit',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS room_execution_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT NOT NULL,
            room_message_id TEXT NOT NULL,
            logical_agent_id TEXT NOT NULL,
            outcome TEXT NOT NULL,
            detail_json TEXT,
            created_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_room_execution_audit_room
            ON room_execution_audit(room_id);
        `);
      },
    },
    {
      version: 3,
      id: 'room_history_read_audits',
      up(db) {
        // design §6.2：Room 历史读取审计使用独立 schema，不复用要求
        // room_message_id/logical_agent_id 的 room_execution_audit —— 分页
        // 读取场景没有单一 message/agent 上下文。字段严格限定为设计文档
        // 冻结清单，不记录消息正文。默认保留 30 天，清理由 broker 启动时
        // 一次性 + 按 last_cleanup_at 做最多每 24 小时一次的惰性清理执行
        // （不新增后台 timer），见 pruneStaleRoomHistoryReadAudits。
        db.exec(`
          CREATE TABLE IF NOT EXISTS room_history_read_audits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT NOT NULL,
            actor_participant_id TEXT NOT NULL,
            from_sequence INTEGER,
            to_sequence INTEGER,
            requested_limit INTEGER,
            result_count INTEGER NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_room_history_read_audits_room
            ON room_history_read_audits(room_id);
          CREATE INDEX IF NOT EXISTS idx_room_history_read_audits_created_at
            ON room_history_read_audits(created_at);

          CREATE TABLE IF NOT EXISTS room_history_read_audit_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
        `);
      },
    },
  ];
}

export function createRoomStore({ dbPath, migrations } = {}) {
  const db = new DatabaseSync(dbPath);
  const steps = migrations ?? getDefaultMigrations();

  function ensureVersionTable() {
    db.exec('CREATE TABLE IF NOT EXISTS room_schema_version (version INTEGER NOT NULL)');
  }

  function getSchemaVersion() {
    ensureVersionTable();
    const row = db.prepare('SELECT MAX(version) AS version FROM room_schema_version').get();
    return row?.version ?? 0;
  }

  function migrate() {
    ensureVersionTable();
    const current = getSchemaVersion();
    for (const step of steps) {
      if (step.version <= current) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        step.up(db);
        db.prepare('INSERT INTO room_schema_version (version) VALUES (?)').run(step.version);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return { schemaVersion: getSchemaVersion() };
  }

  function withTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // -- rooms ------------------------------------------------------------
  function insertRoom(room) {
    db.prepare(`
      INSERT INTO rooms (room_id, title, description, status, origin, created_by_json, revision, discussion_epoch, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      room.roomId,
      room.title,
      room.description ?? null,
      room.status ?? 'active',
      room.origin ?? 'user_created',
      JSON.stringify(room.createdBy),
      room.revision ?? 1,
      room.discussionEpoch ?? 0,
      room.createdAt,
      room.updatedAt,
      room.archivedAt ?? null
    );
  }

  function getRoomRow(roomId) {
    return mapRoomRow(db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId));
  }

  function updateRoom(roomId, patch) {
    const current = getRoomRow(roomId);
    if (!current) return null;
    const next = { ...current, ...patch };
    db.prepare(`
      UPDATE rooms SET title = ?, status = ?, revision = ?, discussion_epoch = ?, updated_at = ?, archived_at = ?
      WHERE room_id = ?
    `).run(
      next.title,
      next.status,
      next.revision,
      next.discussionEpoch,
      next.updatedAt,
      next.archivedAt ?? null,
      roomId
    );
    return getRoomRow(roomId);
  }

  function listRoomRows() {
    return db.prepare('SELECT * FROM rooms ORDER BY created_at').all().map(mapRoomRow);
  }

  // -- members ------------------------------------------------------------
  function insertMember(member) {
    const subject = member.subject;
    db.prepare(`
      INSERT INTO room_members (room_id, subject_kind, subject_id, role, status, added_by_json, membership_revision, added_at, removed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      member.roomId,
      subject.kind === 'user' ? 'user' : 'agent',
      subject.kind === 'user' ? subject.userId : subject.logicalAgentId,
      member.role ?? 'member',
      member.status ?? 'active',
      JSON.stringify(member.addedBy),
      member.membershipRevision ?? 1,
      member.addedAt,
      member.removedAt ?? null
    );
  }

  function listMembers(roomId) {
    return db.prepare('SELECT * FROM room_members WHERE room_id = ? ORDER BY added_at').all(roomId).map(mapMemberRow);
  }

  function getMember(roomId, subject) {
    const row = db.prepare(
      'SELECT * FROM room_members WHERE room_id = ? AND subject_kind = ? AND subject_id = ?'
    ).get(
      roomId,
      subject.kind === 'user' ? 'user' : 'agent',
      subject.kind === 'user' ? subject.userId : subject.logicalAgentId
    );
    return mapMemberRow(row);
  }

  function updateMember(roomId, subject, patch) {
    const current = getMember(roomId, subject);
    if (!current) return null;
    const next = { ...current, ...patch };
    db.prepare(`
      UPDATE room_members SET role = ?, status = ?, membership_revision = ?, removed_at = ?
      WHERE room_id = ? AND subject_kind = ? AND subject_id = ?
    `).run(
      next.role,
      next.status,
      next.membershipRevision,
      next.removedAt ?? null,
      roomId,
      subject.kind === 'user' ? 'user' : 'agent',
      subject.kind === 'user' ? subject.userId : subject.logicalAgentId
    );
    return getMember(roomId, subject);
  }

  // -- sequences ------------------------------------------------------------
  function nextRoomSequence(roomId) {
    db.prepare('INSERT OR IGNORE INTO room_sequences (room_id, last_sequence) VALUES (?, 0)').run(roomId);
    db.prepare('UPDATE room_sequences SET last_sequence = last_sequence + 1 WHERE room_id = ?').run(roomId);
    const row = db.prepare('SELECT last_sequence FROM room_sequences WHERE room_id = ?').get(roomId);
    return row.last_sequence;
  }

  // -- messages ------------------------------------------------------------
  function insertMessage(message) {
    db.prepare(`
      INSERT INTO room_messages (room_message_id, room_id, thread_id, sender_json, kind, text, reply_to_message_id, context_scope_json, mentions_json, response_policy, source_ref_json, idempotency_key, room_sequence, discussion_epoch, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.messageId,
      message.roomId,
      message.threadId,
      JSON.stringify(message.sender),
      message.kind ?? 'text',
      message.text ?? null,
      message.replyToMessageId ?? null,
      JSON.stringify(message.contextScope ?? { kind: 'room_only' }),
      JSON.stringify(message.mentions ?? []),
      message.responsePolicy ?? 'none',
      message.sourceRef ? JSON.stringify(message.sourceRef) : null,
      message.idempotencyKey,
      message.roomSequence,
      message.discussionEpoch ?? 0,
      message.createdAt
    );
  }

  function getMessageByIdempotency(roomId, idempotencyKey) {
    return mapMessageRow(
      db.prepare('SELECT * FROM room_messages WHERE room_id = ? AND idempotency_key = ?').get(roomId, idempotencyKey)
    );
  }

  function getMessage(roomId, messageId) {
    return mapMessageRow(
      db.prepare('SELECT * FROM room_messages WHERE room_id = ? AND room_message_id = ?').get(roomId, messageId)
    );
  }

  function getMessageById(messageId) {
    return mapMessageRow(
      db.prepare('SELECT * FROM room_messages WHERE room_message_id = ?').get(messageId)
    );
  }

  const DEFAULT_LIST_MESSAGES_LIMIT = 50;
  const MAX_LIST_MESSAGES_LIMIT = 200;

  /**
   * design §6.2：向后兼容扩展。无参数调用（仅 roomId）保持旧的全量物化语义，
   * 供现有 UI 继续使用。传入 afterSequence/beforeSequence/limit 时启用
   * bounded query，使用 room_sequence 索引，不再全量物化再 slice。
   *
   * limit 非整数/越界（<=0 或 >MAX_LIST_MESSAGES_LIMIT）直接拒绝调用方传入的
   * 值并回落到默认值，不静默放大——调用方若传入非法 limit，视为未指定。
   */
  function listMessages(roomId, { afterSequence, beforeSequence, limit } = {}) {
    const hasBounds = afterSequence !== undefined || beforeSequence !== undefined || limit !== undefined;
    if (!hasBounds) {
      return db.prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY room_sequence').all(roomId).map(mapMessageRow);
    }

    const effectiveLimit = normalizeListMessagesLimit(limit);
    const conditions = ['room_id = ?'];
    const params = [roomId];
    if (Number.isInteger(afterSequence)) {
      conditions.push('room_sequence > ?');
      params.push(afterSequence);
    }
    if (Number.isInteger(beforeSequence)) {
      conditions.push('room_sequence < ?');
      params.push(beforeSequence);
    }
    params.push(effectiveLimit);

    const rows = db.prepare(
      `SELECT * FROM room_messages WHERE ${conditions.join(' AND ')} ORDER BY room_sequence LIMIT ?`
    ).all(...params);
    return rows.map(mapMessageRow);
  }

  function normalizeListMessagesLimit(limit) {
    // design §6.2：非整数/非正数（<=0）视为"未指定"，回落默认值 50；
    // 超过最大值 200 时 clamp 到 200（不是回落默认值——调用方明确想要一大页，
    // 只是超过了硬上限，应该给到允许的最大值，而不是意外缩小到默认页大小）。
    if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_LIST_MESSAGES_LIMIT;
    if (limit > MAX_LIST_MESSAGES_LIMIT) return MAX_LIST_MESSAGES_LIMIT;
    return limit;
  }

  /**
   * design §6.2：返回该 room 完整 room_sequence 域的边界信息，供
   * RoomContextWindow 计算 totalMessages/fromSequence/toSequence/isComplete。
   * 不按 message kind 二次过滤（totalMessages 域覆盖所有 user/agent/system/
   * artifact message kind）。
   */
  function getRoomSequenceBounds(roomId) {
    const row = db.prepare(
      'SELECT COUNT(*) as total, MIN(room_sequence) as minSeq, MAX(room_sequence) as maxSeq FROM room_messages WHERE room_id = ?'
    ).get(roomId);
    return {
      totalMessages: row?.total || 0,
      minSequence: row?.minSeq ?? null,
      maxSequence: row?.maxSeq ?? null,
    };
  }

  const ROOM_HISTORY_READ_AUDIT_RETENTION_DAYS = 30;
  const ROOM_HISTORY_READ_AUDIT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

  /**
   * design §6.2：每次 agent history page read 写一条独立审计记录，不含消息
   * 正文，字段严格限定为设计文档冻结清单。
   */
  function recordRoomHistoryReadAudit({
    roomId,
    actorParticipantId,
    fromSequence = null,
    toSequence = null,
    requestedLimit = null,
    resultCount,
    now = Date.now(),
  }) {
    db.prepare(`
      INSERT INTO room_history_read_audits
        (room_id, actor_participant_id, from_sequence, to_sequence, requested_limit, result_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      roomId,
      actorParticipantId,
      fromSequence,
      toSequence,
      requestedLimit,
      resultCount,
      new Date(now).toISOString()
    );
    pruneStaleRoomHistoryReadAuditsIfDue(now);
  }

  /**
   * design §6.2：清理在 broker 启动时执行一次，并在写 audit 时按持久
   * last_cleanup_at 做最多每 24 小时一次的惰性清理，不新增后台 timer/
   * shutdown owner；清理失败只记录、不阻断读取（本函数吞掉异常，调用方
   * 永远不会因为清理失败而无法完成本次审计写入 —— 清理是在写入之后才
   * 触发的独立步骤）。
   */
  function pruneStaleRoomHistoryReadAuditsIfDue(now = Date.now()) {
    try {
      const lastCleanupRow = db.prepare(
        "SELECT value FROM room_history_read_audit_meta WHERE key = 'last_cleanup_at'"
      ).get();
      const lastCleanupAt = lastCleanupRow ? Number(lastCleanupRow.value) : 0;
      if (now - lastCleanupAt < ROOM_HISTORY_READ_AUDIT_CLEANUP_INTERVAL_MS) return { pruned: 0, skipped: true };

      const cutoffIso = new Date(now - ROOM_HISTORY_READ_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const result = db.prepare('DELETE FROM room_history_read_audits WHERE created_at < ?').run(cutoffIso);
      db.prepare(`
        INSERT INTO room_history_read_audit_meta (key, value) VALUES ('last_cleanup_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(now));
      return { pruned: result.changes ?? 0, skipped: false };
    } catch (err) {
      // 清理失败只记录、不阻断读取/写入路径。
      return { pruned: 0, skipped: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  function listRoomHistoryReadAudits(roomId) {
    return db.prepare('SELECT * FROM room_history_read_audits WHERE room_id = ? ORDER BY id').all(roomId).map(row => ({
      id: row.id,
      roomId: row.room_id,
      actorParticipantId: row.actor_participant_id,
      fromSequence: row.from_sequence,
      toSequence: row.to_sequence,
      requestedLimit: row.requested_limit,
      resultCount: row.result_count,
      createdAt: row.created_at,
    }));
  }

  // -- deliveries ------------------------------------------------------------
  function insertDelivery(delivery) {
    db.prepare(`
      INSERT OR IGNORE INTO room_message_deliveries (room_message_id, recipient_key, logical_recipient_id, runtime_participant_id_snapshot, visibility_status, wake_status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      delivery.roomMessageId,
      delivery.recipientKey,
      delivery.logicalRecipientId ?? null,
      delivery.runtimeParticipantIdSnapshot ?? null,
      delivery.visibilityStatus ?? 'pending',
      delivery.wakeStatus ?? 'not_requested'
    );
  }

  function updateDelivery(roomMessageId, recipientKey, patch) {
    const current = mapDeliveryRow(
      db.prepare('SELECT * FROM room_message_deliveries WHERE room_message_id = ? AND recipient_key = ?').get(roomMessageId, recipientKey)
    );
    if (!current) return null;
    const next = { ...current, ...patch };
    db.prepare(`
      UPDATE room_message_deliveries SET visibility_status = ?, wake_status = ?, claim_lease_until = ?, claim_token = ?, runtime_participant_id_snapshot = COALESCE(?, runtime_participant_id_snapshot)
      WHERE room_message_id = ? AND recipient_key = ?
    `).run(
      next.visibilityStatus,
      next.wakeStatus,
      next.claimLeaseUntil ?? null,
      next.claimToken ?? null,
      next.runtimeParticipantIdSnapshot ?? null,
      roomMessageId,
      recipientKey
    );
    return mapDeliveryRow(
      db.prepare('SELECT * FROM room_message_deliveries WHERE room_message_id = ? AND recipient_key = ?').get(roomMessageId, recipientKey)
    );
  }

  function getDelivery(roomMessageId, recipientKey) {
    return mapDeliveryRow(
      db.prepare('SELECT * FROM room_message_deliveries WHERE room_message_id = ? AND recipient_key = ?').get(roomMessageId, recipientKey)
    );
  }

  function listDeliveries(roomMessageId) {
    return db.prepare('SELECT * FROM room_message_deliveries WHERE room_message_id = ? ORDER BY recipient_key')
      .all(roomMessageId)
      .map(mapDeliveryRow);
  }

  function listDeliveriesByRecipient({ recipientKey, wakeStatus }) {
    return db.prepare('SELECT * FROM room_message_deliveries WHERE recipient_key = ? AND wake_status = ?')
      .all(recipientKey, wakeStatus)
      .map(mapDeliveryRow);
  }

  function listClaimedDeliveries(roomId) {
    return db.prepare(`
      SELECT d.* FROM room_message_deliveries d
      JOIN room_messages m ON m.room_message_id = d.room_message_id
      WHERE m.room_id = ? AND d.wake_status = 'claimed'
    `).all(roomId).map(mapDeliveryRow);
  }

  // -- cursors ------------------------------------------------------------
  function getCursor(roomId, recipientKey) {
    const row = db.prepare('SELECT last_seen_room_sequence FROM room_recipient_cursors WHERE room_id = ? AND recipient_key = ?')
      .get(roomId, recipientKey);
    return { roomId, recipientKey, lastSeenRoomSequence: row?.last_seen_room_sequence ?? 0 };
  }

  function advanceCursor(roomId, recipientKey, roomSequence) {
    const current = getCursor(roomId, recipientKey);
    const next = Math.max(current.lastSeenRoomSequence, roomSequence);
    db.prepare(`
      INSERT INTO room_recipient_cursors (room_id, recipient_key, last_seen_room_sequence)
      VALUES (?, ?, ?)
      ON CONFLICT(room_id, recipient_key) DO UPDATE SET last_seen_room_sequence = excluded.last_seen_room_sequence
    `).run(roomId, recipientKey, next);
    return getCursor(roomId, recipientKey);
  }

  // -- leases ------------------------------------------------------------
  function insertLease(lease) {
    db.prepare(`
      INSERT INTO room_membership_leases (token, room_id, logical_agent_id, operation_id, room_revision, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      lease.token,
      lease.roomId,
      lease.logicalAgentId,
      lease.operationId,
      lease.roomRevision,
      lease.expiresAt,
      lease.createdAt
    );
  }

  function getLease(token) {
    const row = db.prepare('SELECT * FROM room_membership_leases WHERE token = ?').get(token);
    if (!row) return null;
    return {
      token: row.token,
      roomId: row.room_id,
      logicalAgentId: row.logical_agent_id,
      operationId: row.operation_id,
      roomRevision: row.room_revision,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  // -- execution audit ------------------------------------------------------------
  function insertAudit(entry) {
    db.prepare(`
      INSERT INTO room_execution_audit (room_id, room_message_id, logical_agent_id, outcome, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entry.roomId,
      entry.roomMessageId,
      entry.logicalAgentId,
      entry.outcome,
      entry.detail ? JSON.stringify(entry.detail) : null,
      entry.createdAt
    );
  }

  function listAudit(roomId) {
    return db.prepare('SELECT * FROM room_execution_audit WHERE room_id = ? ORDER BY id').all(roomId).map((row) => ({
      roomId: row.room_id,
      roomMessageId: row.room_message_id,
      logicalAgentId: row.logical_agent_id,
      outcome: row.outcome,
      detail: row.detail_json ? JSON.parse(row.detail_json) : undefined,
      createdAt: row.created_at,
    }));
  }

  function close() {
    db.close();
  }

  return {
    db,
    migrate,
    getSchemaVersion,
    getDefaultMigrations: () => steps,
    withTransaction,
    insertRoom,
    getRoomRow,
    updateRoom,
    listRoomRows,
    insertMember,
    listMembers,
    getMember,
    updateMember,
    nextRoomSequence,
    insertMessage,
    getMessageByIdempotency,
    getMessage,
    getMessageById,
    listMessages,
    getRoomSequenceBounds,
    recordRoomHistoryReadAudit,
    pruneStaleRoomHistoryReadAuditsIfDue,
    listRoomHistoryReadAudits,
    insertDelivery,
    updateDelivery,
    getDelivery,
    listDeliveries,
    listDeliveriesByRecipient,
    listClaimedDeliveries,
    getCursor,
    advanceCursor,
    insertLease,
    getLease,
    insertAudit,
    listAudit,
    close,
  };
}
