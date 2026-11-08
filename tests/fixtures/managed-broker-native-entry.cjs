'use strict';
// This is a new component test entry, copied by the original fixed C helper.
// Consume genuine Native birth before configuration or business code imports.
const native = require('./runtime/protected_sqlite.node');
native.consumeOriginalBrokerSource();
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const sibling = __MANAGED_SIBLING_ROOT__;
const config = path.join(__dirname, 'config');
fs.mkdirSync(config, { recursive: true, mode: 0o700 });
process.env.XIAOK_CONFIG_DIR = config;
fs.cpSync(path.join(sibling, 'src'), path.join(__dirname, 'src'), { recursive: true });
fs.copyFileSync(path.join(sibling, 'runtime/xiaok-source-runtime.cjs'), path.join(__dirname, 'runtime/xiaok-source-runtime.cjs'));
fs.symlinkSync(path.join(sibling, 'node_modules'), path.join(__dirname, 'node_modules'), 'dir');
(async () => {
    await import(pathToFileURL(path.join(sibling, 'tests/fixtures/source-account-preload.mjs')));
    const { createEventStore } = await import(pathToFileURL(path.join(__dirname, 'src/store/event-store.js')));
    const { createRoomStore } = await import(pathToFileURL(path.join(__dirname, 'src/room/store.js')));
    const { readBrokerDatabaseFate, waitBrokerDatabaseCloseKnown } = await import(pathToFileURL(path.join(__dirname, 'src/store/database-lifecycle.js')));
    const fixed = require('./runtime/original-authority-sqlite.cjs');
    assert.ok(fixed.namespace);
    const nativeGetter = fixed.namespace.transactionStateGetter, getterPrototype = Object.getOwnPropertyDescriptor(nativeGetter, 'prototype');
    console.log(JSON.stringify({ kind: 'broker-native-getter-metadata', ownNames: Reflect.ownKeys(nativeGetter).map(String), prototypeConstructorSelf: !!getterPrototype && Object.getOwnPropertyDescriptor(getterPrototype.value, 'constructor')?.value === nativeGetter }));
    const dbPath = path.join(__dirname, 'logical-not-native.sqlite'), event = createEventStore({ dbPath }), room = createRoomStore({ dbPath, storageBudget: { databaseBytes: 1048576 } });
    room.migrate();
    assert.equal(room.getSchemaVersion(), 9);
    assert.equal(fs.existsSync(dbPath), false);
    assert.throws(() => new fixed.namespace.Database());
    const tables = room.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
    for (const name of ['events', 'intent_receipts', 'inbox_entries', 'participant_cursors', 'participant_roles', 'context_syncs', 'rooms', 'room_members', 'room_messages', 'room_workspace_records', 'room_admission_receipts', 'room_disclosure_leases'])
        assert.ok(tables.includes(name), name);
    const input = { intentId: 'native-one', kind: 'report_progress', fromParticipantId: 'a', payload: { body: { summary: 'native-original' } }, recipients: ['b'] };
    event.appendIntent(input);
    assert.equal(event.readInbox('b').items.length, 1);
    event.ackInbox('b', 1);
    assert.equal(event.getCursor('b'), 1);
    let original;
    try {
        room.withTransaction(() => { room.db.exec('CREATE TABLE rollback_component(value)'); room.db.prepare('INSERT INTO rollback_component VALUES(1)').run(); throw undefined; });
    }
    catch (raw) {
        original = { raw };
    }
    assert.ok(original);
    assert.equal(original.raw, undefined);
    assert.equal(room.db.prepare("SELECT name FROM sqlite_master WHERE name='rollback_component'").get(), undefined);
    room.withTransaction(() => { assert.throws(() => event.readInbox('b'), /busy/); });
    room.db.exec('BEGIN');
    assert.throws(() => event.listEvents(), /busy/);
    room.db.exec('ROLLBACK');
    assert.throws(() => event.appendIntent({ ...input, intentId: 'too-large', payload: { large: 'x'.repeat(2097152) } }), raw => { const first = raw instanceof AggregateError ? raw.errors[0] : raw; assert.match(first.message, /full/i); return true; });
    assert.equal(event.listEvents().length, 1);
    const oldDb = room.db, oldStatement = oldDb.prepare('SELECT 1 AS actual'), oldCursor = oldStatement.iterate();
    assert.equal(oldCursor.next().value.actual, 1);
    room.close();
    assert.equal(readBrokerDatabaseFate(room).physicalKnown, false);
    assert.equal(readBrokerDatabaseFate(room).closed, false);
    assert.throws(() => oldDb.exec('SELECT 1'), /retired/);
    assert.throws(() => oldStatement.get(), /retired/);
    assert.throws(() => oldCursor.next(), /retired/);
    assert.throws(() => room.getDefaultMigrations(), /retired/);
    oldCursor.return();
    event.appendIntent({ ...input, intentId: 'native-two' });
    assert.equal(event.listEvents().length, 2);
    event.close();
    await waitBrokerDatabaseCloseKnown(room);
    await waitBrokerDatabaseCloseKnown(event);
    assert.equal(readBrokerDatabaseFate(room).physicalKnown, true);
    assert.equal(readBrokerDatabaseFate(event).physicalKnown, true);
    assert.throws(() => fixed.bindNamespace());
    fixed.finish();
    console.log(JSON.stringify({ kind: 'broker-managed-native-business', pid: process.pid, node: process.versions.node, schema: 9, tableCount: tables.length, events: 2, sameOriginalNamespace: true, firstLeaseStayedPhysicalUnknown: true, oldHandlesDenied: true, cursorReturned: true, fullCap: true, closed: true, productionQualified: false }));
})().catch(raw => { globalThis.retainedManagedNativeError = raw; console.error(raw); process.exitCode = 1; });
