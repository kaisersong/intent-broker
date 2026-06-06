import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from './schema.js';

function mapEventRow(row) {
  return {
    eventId: row.event_id,
    intentId: row.intent_id,
    kind: row.kind,
    fromParticipantId: row.from_participant_id,
    taskId: row.task_id,
    threadId: row.thread_id,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at
  };
}

function mapContextSyncRow(row) {
  return {
    syncId: row.sync_id,
    userId: row.user_id,
    sourceNodeId: row.source_node_id,
    receiverParticipantId: row.receiver_participant_id,
    status: row.status,
    payload: JSON.parse(row.payload_json),
    wipBranch: row.wip_branch,
    latestRef: row.latest_ref,
    wipCommitSha: row.wip_commit_sha,
    wipPushedAt: row.wip_pushed_at,
    preparedAt: row.prepared_at,
    emittedAt: row.emitted_at,
    lastEmitAt: row.last_emit_at,
    emitAttempts: row.emit_attempts,
    nextRetryAt: row.next_retry_at,
    ackedAt: row.acked_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    cleanupStatus: row.cleanup_status,
    cleanupAttemptedAt: row.cleanup_attempted_at,
    cleanupError: row.cleanup_error
  };
}

const CONTEXT_SYNC_UPDATE_COLUMNS = {
  userId: 'user_id',
  sourceNodeId: 'source_node_id',
  receiverParticipantId: 'receiver_participant_id',
  status: 'status',
  payload: 'payload_json',
  wipBranch: 'wip_branch',
  latestRef: 'latest_ref',
  wipCommitSha: 'wip_commit_sha',
  wipPushedAt: 'wip_pushed_at',
  preparedAt: 'prepared_at',
  emittedAt: 'emitted_at',
  lastEmitAt: 'last_emit_at',
  emitAttempts: 'emit_attempts',
  nextRetryAt: 'next_retry_at',
  ackedAt: 'acked_at',
  lastError: 'last_error',
  createdAt: 'created_at',
  expiresAt: 'expires_at',
  cleanupStatus: 'cleanup_status',
  cleanupAttemptedAt: 'cleanup_attempted_at',
  cleanupError: 'cleanup_error'
};

function serializeContextSyncValue(key, value) {
  if (key === 'payload') {
    return JSON.stringify(value ?? {});
  }
  return value ?? null;
}

export function createEventStore({ dbPath }) {
  const db = new DatabaseSync(dbPath);
  initializeSchema(db);

  function getEventById(eventId) {
    const row = db.prepare(`
      SELECT event_id, intent_id, kind, from_participant_id, task_id, thread_id, payload_json, created_at
      FROM events
      WHERE event_id = ?
    `).get(eventId);
    return row ? mapEventRow(row) : null;
  }

  function getEventByIntentId(intentId) {
    const row = db.prepare(`
      SELECT event_id, intent_id, kind, from_participant_id, task_id, thread_id, payload_json, created_at
      FROM events
      WHERE intent_id = ?
    `).get(intentId);
    return row ? mapEventRow(row) : null;
  }

  return {
    appendIntent({ intentId, kind, fromParticipantId, taskId, threadId, payload, recipients }) {
      const insertEvent = db.prepare(`
        INSERT INTO events (intent_id, kind, from_participant_id, task_id, thread_id, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      let result;
      try {
        result = insertEvent.run(intentId, kind, fromParticipantId, taskId, threadId, JSON.stringify(payload));
      } catch (error) {
        if (String(error.message).includes('UNIQUE constraint failed: events.intent_id')) {
          const existingEvent = getEventByIntentId(intentId);
          return {
            ...existingEvent,
            duplicate: true
          };
        }
        throw error;
      }
      const eventId = Number(result.lastInsertRowid);

      for (const participantId of recipients) {
        db.prepare(`
          INSERT INTO inbox_entries (participant_id, event_id)
          VALUES (?, ?)
        `).run(participantId, eventId);
      }

      return getEventById(eventId);
    },
    readInbox(participantId, { after = 0, limit = 50 } = {}) {
      const items = db.prepare(`
        SELECT e.event_id, e.intent_id, e.kind, e.from_participant_id, e.task_id, e.thread_id, e.payload_json, e.created_at
        FROM inbox_entries ie
        JOIN events e ON e.event_id = ie.event_id
        WHERE ie.participant_id = ?
          AND ie.event_id > ?
          AND ie.discarded_at IS NULL
        ORDER BY ie.event_id ASC
        LIMIT ?
      `).all(participantId, after, limit).map(mapEventRow);
      return { items };
    },
    ackInbox(participantId, eventId) {
      db.prepare(`
        INSERT INTO participant_cursors (participant_id, cursor_event_id)
        VALUES (?, ?)
        ON CONFLICT(participant_id)
        DO UPDATE SET cursor_event_id = excluded.cursor_event_id, updated_at = CURRENT_TIMESTAMP
      `).run(participantId, eventId);
      db.prepare(`
        UPDATE inbox_entries
        SET delivery_status = 'acked', acked_at = CURRENT_TIMESTAMP
        WHERE participant_id = ? AND event_id <= ?
      `).run(participantId, eventId);
      return { participantId, eventId };
    },
    getCursor(participantId) {
      const row = db.prepare(`
        SELECT cursor_event_id
        FROM participant_cursors
        WHERE participant_id = ?
      `).get(participantId);
      return row ? row.cursor_event_id : 0;
    },
    listEvents({ after = 0, taskId = null, threadId = null, limit = 100 } = {}) {
      const conditions = ['event_id > ?'];
      const params = [after];

      if (taskId) {
        conditions.push('task_id = ?');
        params.push(taskId);
      }
      if (threadId) {
        conditions.push('thread_id = ?');
        params.push(threadId);
      }

      const sql = `
        SELECT event_id, intent_id, kind, from_participant_id, task_id, thread_id, payload_json, created_at
        FROM events
        WHERE ${conditions.join(' AND ')}
        ORDER BY event_id ASC
        ${Number.isFinite(limit) ? 'LIMIT ?' : ''}
      `;

      if (Number.isFinite(limit)) {
        params.push(limit);
      }

      return db.prepare(sql).all(...params).map(mapEventRow);
    },
    getParticipantRoles(participantId) {
      return db.prepare(`
        SELECT role
        FROM participant_roles
        WHERE participant_id = ?
        ORDER BY role ASC
      `).all(participantId).map((row) => row.role);
    },
    addParticipantRoles(participantId, roles) {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO participant_roles (participant_id, role)
        VALUES (?, ?)
      `);
      for (const role of roles) {
        insert.run(participantId, role);
      }
    },
    removeParticipantRoles(participantId, roles) {
      const remove = db.prepare(`
        DELETE FROM participant_roles
        WHERE participant_id = ? AND role = ?
      `);
      for (const role of roles) {
        remove.run(participantId, role);
      }
    },
    listAllParticipantRoles() {
      const rows = db.prepare(`
        SELECT participant_id, role
        FROM participant_roles
        ORDER BY participant_id ASC, role ASC
      `).all();
      const byParticipant = new Map();
      for (const row of rows) {
        if (!byParticipant.has(row.participant_id)) {
          byParticipant.set(row.participant_id, []);
        }
        byParticipant.get(row.participant_id).push(row.role);
      }
      return byParticipant;
    },
    saveContextSync(record) {
      db.prepare(`
        INSERT INTO context_syncs (
          sync_id,
          user_id,
          source_node_id,
          receiver_participant_id,
          status,
          payload_json,
          wip_branch,
          latest_ref,
          wip_commit_sha,
          wip_pushed_at,
          prepared_at,
          emitted_at,
          last_emit_at,
          emit_attempts,
          next_retry_at,
          acked_at,
          last_error,
          created_at,
          expires_at,
          cleanup_status,
          cleanup_attempted_at,
          cleanup_error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sync_id) DO UPDATE SET
          user_id = excluded.user_id,
          source_node_id = excluded.source_node_id,
          receiver_participant_id = excluded.receiver_participant_id,
          status = excluded.status,
          payload_json = excluded.payload_json,
          wip_branch = excluded.wip_branch,
          latest_ref = excluded.latest_ref,
          wip_commit_sha = excluded.wip_commit_sha,
          wip_pushed_at = excluded.wip_pushed_at,
          prepared_at = excluded.prepared_at,
          emitted_at = excluded.emitted_at,
          last_emit_at = excluded.last_emit_at,
          emit_attempts = excluded.emit_attempts,
          next_retry_at = excluded.next_retry_at,
          acked_at = excluded.acked_at,
          last_error = excluded.last_error,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at,
          cleanup_status = excluded.cleanup_status,
          cleanup_attempted_at = excluded.cleanup_attempted_at,
          cleanup_error = excluded.cleanup_error
      `).run(
        record.syncId,
        record.userId,
        record.sourceNodeId ?? null,
        record.receiverParticipantId ?? null,
        record.status ?? 'prepared',
        JSON.stringify(record.payload ?? {}),
        record.wipBranch ?? null,
        record.latestRef ?? null,
        record.wipCommitSha ?? null,
        record.wipPushedAt ?? null,
        record.preparedAt ?? null,
        record.emittedAt ?? null,
        record.lastEmitAt ?? null,
        record.emitAttempts ?? 0,
        record.nextRetryAt ?? null,
        record.ackedAt ?? null,
        record.lastError ?? null,
        record.createdAt ?? new Date().toISOString(),
        record.expiresAt,
        record.cleanupStatus ?? null,
        record.cleanupAttemptedAt ?? null,
        record.cleanupError ?? null
      );
      return this.getContextSync(record.syncId);
    },
    getContextSync(syncId) {
      const row = db.prepare(`
        SELECT *
        FROM context_syncs
        WHERE sync_id = ?
      `).get(syncId);
      return row ? mapContextSyncRow(row) : null;
    },
    updateContextSync(syncId, changes) {
      const entries = Object.entries(changes || {})
        .filter(([key]) => Object.hasOwn(CONTEXT_SYNC_UPDATE_COLUMNS, key));
      if (!entries.length) {
        return this.getContextSync(syncId);
      }

      const assignments = entries.map(([key]) => `${CONTEXT_SYNC_UPDATE_COLUMNS[key]} = ?`);
      const values = entries.map(([key, value]) => serializeContextSyncValue(key, value));
      db.prepare(`
        UPDATE context_syncs
        SET ${assignments.join(', ')}
        WHERE sync_id = ?
      `).run(...values, syncId);
      return this.getContextSync(syncId);
    },
    listContextSyncs({ userId = null, status = null, sourceNodeId = null, limit = 50 } = {}) {
      const conditions = [];
      const params = [];
      if (userId) {
        conditions.push('user_id = ?');
        params.push(userId);
      }
      if (status) {
        conditions.push('status = ?');
        params.push(status);
      }
      if (sourceNodeId) {
        conditions.push('source_node_id = ?');
        params.push(sourceNodeId);
      }

      const sql = `
        SELECT *
        FROM context_syncs
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        ${Number.isFinite(limit) ? 'LIMIT ?' : ''}
      `;
      if (Number.isFinite(limit)) {
        params.push(limit);
      }
      return db.prepare(sql).all(...params).map(mapContextSyncRow);
    },
    getLatestPreparedContextSync({ userId, now = new Date(), maxAgeMs = 15 * 60 * 1000 } = {}) {
      const nowDate = now instanceof Date ? now : new Date(now);
      const cutoff = new Date(nowDate.getTime() - maxAgeMs).toISOString();
      const row = db.prepare(`
        SELECT *
        FROM context_syncs
        WHERE user_id = ?
          AND status = 'prepared'
          AND expires_at > ?
          AND COALESCE(prepared_at, created_at) >= ?
        ORDER BY COALESCE(prepared_at, created_at) DESC
        LIMIT 1
      `).get(userId, nowDate.toISOString(), cutoff);
      return row ? mapContextSyncRow(row) : null;
    },
    markContextSyncAcked(syncId, { receiverParticipantId = null, ackedAt = new Date().toISOString() } = {}) {
      db.prepare(`
        UPDATE context_syncs
        SET status = 'acked',
            receiver_participant_id = ?,
            acked_at = ?
        WHERE sync_id = ?
      `).run(receiverParticipantId, ackedAt, syncId);
      return this.getContextSync(syncId);
    }
  };
}
