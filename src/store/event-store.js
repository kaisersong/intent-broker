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

      params.push(limit);

      const sql = `
        SELECT event_id, intent_id, kind, from_participant_id, task_id, thread_id, payload_json, created_at
        FROM events
        WHERE ${conditions.join(' AND ')}
        ORDER BY event_id ASC
        LIMIT ?
      `;

      return db.prepare(sql).all(...params).map(mapEventRow);
    }
  };
}
