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

    CREATE TABLE IF NOT EXISTS participant_roles (
      participant_id TEXT NOT NULL,
      role TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (participant_id, role)
    );

    CREATE TABLE IF NOT EXISTS context_syncs (
      sync_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source_node_id TEXT,
      receiver_participant_id TEXT,
      status TEXT NOT NULL DEFAULT 'prepared',
      payload_json TEXT NOT NULL,
      wip_branch TEXT,
      latest_ref TEXT,
      wip_commit_sha TEXT,
      wip_pushed_at TEXT,
      prepared_at TEXT,
      emitted_at TEXT,
      last_emit_at TEXT,
      emit_attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      acked_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      cleanup_status TEXT,
      cleanup_attempted_at TEXT,
      cleanup_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_context_syncs_user_status
      ON context_syncs(user_id, status);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_context_syncs_one_active_per_source
      ON context_syncs(user_id, source_node_id)
      WHERE status IN ('prepared', 'emitted', 'cleanup_pending');
  `);

  const contextSyncColumns = new Set(
    db.prepare('PRAGMA table_info(context_syncs)').all().map((row) => row.name)
  );
  const optionalColumns = [
    ['receiver_participant_id', 'TEXT'],
    ['latest_ref', 'TEXT'],
    ['prepared_at', 'TEXT'],
    ['emitted_at', 'TEXT'],
    ['next_retry_at', 'TEXT'],
    ['last_error', 'TEXT'],
    ['cleanup_error', 'TEXT'],
  ];

  for (const [name, definition] of optionalColumns) {
    if (!contextSyncColumns.has(name)) {
      db.exec(`ALTER TABLE context_syncs ADD COLUMN ${name} ${definition}`);
    }
  }
}
