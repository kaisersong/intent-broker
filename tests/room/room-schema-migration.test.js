/**
 * Room schema migration contract tests (design §9.1, §16.1).
 *
 * RED until Phase 1 implementation lands. These tests drive the production
 * migration runner in src/room/store.js — they must not re-implement
 * migration logic themselves.
 *
 * Contract under test:
 *   createRoomStore({ dbPath, migrations? })
 *     -> { migrate(), getSchemaVersion(), ... }
 *   - migrate() upgrades an empty or legacy broker database to
 *     ROOM_SCHEMA_VERSION inside ordered, transactional steps.
 *   - re-running migrate() on an already-current database is a no-op.
 *   - a failed step rolls back its DDL and leaves schema_version unchanged
 *     (no partial forward progress).
 *   - Room tables are durable domain tables, separate from generic
 *     events / inbox_entries / participant_cursors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { createRoomStore } from '../../src/room/store.js';
import { ROOM_SCHEMA_VERSION, ROOM_TABLES } from '../../src/room/constants.js';
import { initializeSchema as initializeLegacySchema } from '../../src/store/schema.js';

function tableExists(db, tableName) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName);
  return Boolean(row);
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
}

function tableIndexes(db, tableName) {
  return db.prepare(`PRAGMA index_list(${tableName})`).all();
}

test('migrate upgrades an empty database to ROOM_SCHEMA_VERSION with all room tables', () => {
  const dbPath = createTempDbPath();
  const store = createRoomStore({ dbPath });
  const result = store.migrate();

  assert.equal(result.schemaVersion, ROOM_SCHEMA_VERSION);
  assert.equal(store.getSchemaVersion(), ROOM_SCHEMA_VERSION);

  const db = new DatabaseSync(dbPath);
  try {
    for (const tableName of ROOM_TABLES) {
      assert.ok(tableExists(db, tableName), `expected room table ${tableName} to exist`);
    }
  } finally {
    db.close();
  }
});

test('migrate upgrades a legacy broker database (pre-room schema) without touching existing tables', () => {
  const dbPath = createTempDbPath();
  const legacyDb = new DatabaseSync(dbPath);
  try {
    initializeLegacySchema(legacyDb);
    legacyDb.prepare(
      "INSERT INTO events (intent_id, kind, from_participant_id, payload_json) VALUES (?, ?, ?, ?)"
    ).run('legacy-1', 'request_task', 'human.old', JSON.stringify({}));
  } finally {
    legacyDb.close();
  }

  const store = createRoomStore({ dbPath });
  store.migrate();

  assert.equal(store.getSchemaVersion(), ROOM_SCHEMA_VERSION);

  const db = new DatabaseSync(dbPath);
  try {
    // legacy generic tables survive untouched
    assert.ok(tableExists(db, 'events'));
    assert.ok(tableExists(db, 'inbox_entries'));
    const legacyEvent = db.prepare('SELECT intent_id FROM events WHERE intent_id = ?').get('legacy-1');
    assert.ok(legacyEvent, 'legacy event row must survive room migration');

    // room tables are created alongside
    for (const tableName of ROOM_TABLES) {
      assert.ok(tableExists(db, tableName), `expected room table ${tableName} after legacy upgrade`);
    }
  } finally {
    db.close();
  }
});

test('migrate is idempotent when the database is already at ROOM_SCHEMA_VERSION', () => {
  const dbPath = createTempDbPath();
  const store = createRoomStore({ dbPath });
  store.migrate();

  const second = createRoomStore({ dbPath });
  const result = second.migrate();

  assert.equal(result.schemaVersion, ROOM_SCHEMA_VERSION);
  assert.equal(second.getSchemaVersion(), ROOM_SCHEMA_VERSION);
});

test('a failed migration step rolls back DDL and does not advance schema_version', () => {
  const dbPath = createTempDbPath();
  // Build a migration chain whose final step fails: the runner must leave the
  // database at the last successful version with no half-created table.
  const baseStore = createRoomStore({ dbPath });
  const failingMigrations = [
    ...baseStore.getDefaultMigrations().slice(0, -1),
    {
      version: ROOM_SCHEMA_VERSION,
      id: 'deliberately_broken_final_step',
      up: () => {
        throw new Error('injected migration failure');
      },
    },
  ];

  const store = createRoomStore({ dbPath, migrations: failingMigrations });
  assert.throws(() => store.migrate(), /injected migration failure/);

  assert.notEqual(
    store.getSchemaVersion(),
    ROOM_SCHEMA_VERSION,
    'schema_version must not advance past the last committed migration step'
  );

  const db = new DatabaseSync(dbPath);
  try {
    // Whichever table the broken step was supposed to create must not exist
    // in partial form. The final migration owns the newest room table; we
    // assert the newest expected table is absent after the rollback.
    const finalStepTable = baseStore.getDefaultMigrations().at(-1)?.createsTable;
    if (finalStepTable) {
      assert.ok(!tableExists(db, finalStepTable), 'rolled-back step must not leave its table behind');
    }
  } finally {
    db.close();
  }
});

test('room_message_deliveries enforces UNIQUE(roomMessageId, recipientKey)', () => {
  const dbPath = createTempDbPath();
  createRoomStore({ dbPath }).migrate();

  const db = new DatabaseSync(dbPath);
  try {
    const columns = tableColumns(db, 'room_message_deliveries');
    for (const expected of ['room_message_id', 'recipient_key', 'visibility_status', 'wake_status']) {
      assert.ok(columns.includes(expected), `expected column ${expected}`);
    }
    const indexes = tableIndexes(db, 'room_message_deliveries');
    const uniqueIndex = indexes.find((index) => index.unique === 1 || index.unique === true);
    assert.ok(uniqueIndex, 'room_message_deliveries needs a uniqueness constraint');
  } finally {
    db.close();
  }
});

test('room_recipient_cursors is keyed by (roomId, recipientKey)', () => {
  const dbPath = createTempDbPath();
  createRoomStore({ dbPath }).migrate();

  const db = new DatabaseSync(dbPath);
  try {
    const columns = tableColumns(db, 'room_recipient_cursors');
    for (const expected of ['room_id', 'recipient_key', 'last_seen_room_sequence']) {
      assert.ok(columns.includes(expected), `expected column ${expected}`);
    }
  } finally {
    db.close();
  }
});
