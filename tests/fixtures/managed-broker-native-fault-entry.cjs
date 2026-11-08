'use strict';
const native = require('./runtime/protected_sqlite.node');
native.consumeOriginalBrokerSource();
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const sibling = __MANAGED_SIBLING_ROOT__, scenario = __MANAGED_NATIVE_FAULT_CASE__;
const config = path.join(__dirname, 'config');
fs.mkdirSync(config, { recursive: true, mode: 0o700 });
process.env.XIAOK_CONFIG_DIR = config;
fs.cpSync(path.join(sibling, 'src'), path.join(__dirname, 'src'), { recursive: true });
fs.copyFileSync(path.join(sibling, 'runtime/xiaok-source-runtime.cjs'), path.join(__dirname, 'runtime/xiaok-source-runtime.cjs'));
(async () => {
    await import(pathToFileURL(path.join(sibling, 'tests/fixtures/source-account-preload.mjs')));
    const { createEventStore } = await import(pathToFileURL(path.join(__dirname, 'src/store/event-store.js'))), { createRoomStore } = await import(pathToFileURL(path.join(__dirname, 'src/room/store.js')));
    const { readBrokerDatabaseFate, waitBrokerDatabaseCloseKnown } = await import(pathToFileURL(path.join(__dirname, 'src/store/database-lifecycle.js')));
    const dbPath = path.join(__dirname, 'logical.sqlite');
    if (scenario === 'constructor') {
        globalThis.__brokerNativeFaultRaw = undefined;
        globalThis.__brokerNativeConstructorFault = true;
        let failure;
        try {
            createEventStore({ dbPath });
        }
        catch (raw) {
            failure = { raw };
        }
        assert.ok(failure);
        assert.equal(failure.raw, undefined);
        assert.deepEqual(native.readManagedNativeTapFacts(), { ioOpens: 1, constructorFaults: 1, closeFaults: 0 });
        assert.throws(() => createEventStore({ dbPath }));
        assert.equal(native.readManagedNativeTapFacts().ioOpens, 1);
    }
    else {
        const event = createEventStore({ dbPath }), room = createRoomStore({ dbPath });
        room.migrate();
        room.close();
        let release, getters = 0, held;
        const original = scenario === 'close-undefined' ? undefined : new Error('original-native-close');
        if (scenario === 'close-held' || scenario === 'getter-held') {
            held = new Promise(yes => { release = yes; });
            Object.defineProperty(original, Symbol('unknown'), { get() { getters++; throw 0; } });
            Object.defineProperty(original, Symbol('known-held'), { value: held });
        }
        if (scenario === 'getter-held') {
            const fixed = require('./runtime/original-authority-sqlite.cjs');
            const target = fixed.namespace.transactionStateGetter.prototype;
            Object.defineProperty(target, Symbol('unknown'), { get() { getters++; throw 0; } });
            Object.defineProperty(target, Symbol('known-held'), { value: held });
        }
        globalThis.__brokerNativeFaultRaw = original;
        globalThis.__brokerNativeCloseFault = scenario !== 'getter-held';
        let failure;
        try {
            event.close();
        }
        catch (raw) {
            failure = { raw };
        }
        assert.ok(failure);
        if (scenario !== 'getter-held')
            assert.equal(failure.raw, original);
        assert.deepEqual(native.readManagedNativeTapFacts(), { ioOpens: 1, constructorFaults: 0, closeFaults: scenario === 'getter-held' ? 0 : 1 });
        assert.equal(readBrokerDatabaseFate(event).physicalKnown, false);
        assert.equal(readBrokerDatabaseFate(room).physicalKnown, false);
        if (held) {
            let settled = false;
            const waited = waitBrokerDatabaseCloseKnown(event).then(() => { settled = true; return null; }, raw => { settled = true; return raw; });
            await new Promise(yes => setImmediate(yes));
            assert.equal(settled, false);
            assert.equal(getters, 0);
            release();
            assert.ok(await waited);
            assert.equal(getters, 0);
            assert.equal(readBrokerDatabaseFate(event).physicalKnown, false);
        }
        let repeated;
        try {
            event.close();
        }
        catch (raw) {
            repeated = { raw };
        }
        if (scenario !== 'getter-held') {
            assert.ok(repeated);
            assert.equal(repeated.raw, original);
        }
        assert.equal(native.readManagedNativeTapFacts().closeFaults, scenario === 'getter-held' ? 0 : 1);
    }
    console.log(JSON.stringify({ kind: 'broker-managed-native-fault', scenario, pid: process.pid, node: process.versions.node, tap: native.readManagedNativeTapFacts(), originalFirstValueRetained: scenario !== 'getter-held', metadataUnknownRetained: scenario === 'getter-held', productionQualified: false }));
})().catch(raw => { globalThis.retainedManagedNativeError = raw; console.error(raw); process.exitCode = 1; });
