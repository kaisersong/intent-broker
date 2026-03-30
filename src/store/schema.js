export function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      from_participant_id TEXT NOT NULL,
      task_id TEXT,
      thread_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inbox_entries (
      inbox_entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      acked_at TEXT,
      discarded_at TEXT,
      UNIQUE(participant_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS participant_cursors (
      participant_id TEXT PRIMARY KEY,
      cursor_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
