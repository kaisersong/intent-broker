import { resolve } from 'node:path';
import { types } from 'node:util';
import { readBrokerProtectedSQLiteResource } from './protected-sqlite-resource.js';
import { readBrokerSourceRuntime } from './source-runtime.js';
import { createManagedLeaseFacade } from './managed-sqlite-lease.js';
import { inspectManagedNative, inspectManagedCursor, readManagedApiContract } from './managed-sqlite-inventory.js';
import { runManagedTransaction } from './managed-sqlite-transaction.js';
const apply = Reflect.apply, descriptor = Object.getOwnPropertyDescriptor, own = Object.hasOwn;
const keys = Reflect.ownKeys, prototype = Object.getPrototypeOf, freeze = Object.freeze, define = Object.defineProperty;
const isProxy = types.isProxy, NativePromise = Promise, allSettled = Promise.allSettled;
const proofs = new WeakMap(), owners = new WeakMap(), held = new Set();
const get = WeakMap.prototype.get, set = WeakMap.prototype.set;
const unknownMarker = freeze(define(Object.create(null), 'unknown', { get() { } }));
let birth;
function append(values, value) { define(values, String(values.length), { value, writable: true, enumerable: true, configurable: true }); }
function unconfirmed() { return Error('broker_sqlite_sdk_unconfirmed'); }
function original(proof) { return apply(get, proofs, [proof]); }
function requireRow(proof) {
    const row = original(proof);
    if (!row)
        throw Error('broker_sqlite_owner_required');
    return row;
}
function remember(row, raw) {
    append(row.errors, { raw });
    append(row.manager.raws, raw);
    try {
        row.stock?.inventory(raw);
    }
    catch (secondary) {
        append(row.errors, { raw: secondary });
        row.unknown = true;
        row.manager.unknown = true;
    }
}
function markUnknown(row, raw) { row.unknown = true; row.manager.unknown = true; remember(row, raw); row.stock?.inventory(unknownMarker); }
function managerUnknown(manager, raw) {
    manager.unknown = true;
    manager.failure ??= { raw };
    append(manager.raws, raw);
    try {
        manager.stock?.inventory(raw);
        manager.stock?.inventory(unknownMarker);
    }
    catch (secondary) {
        append(manager.raws, secondary);
    }
}
function stockKnown(stock) {
    if (!stock)
        return false;
    try {
        stock.assertPhysicalKnown();
        return true;
    }
    catch {
        return false;
    }
}
function inspectNative(row, value, kind) {
    inspectManagedNative(value, kind, row.manager.api, v => rememberValue(row, v), raw => markUnknown(row, raw));
}
function inspectCursor(row, value) {
    append(row.manager.raws, value);
    inspectManagedCursor(value, v => rememberValue(row, v), raw => markUnknown(row, raw));
}
function rememberValue(row, value) {
    append(row.manager.raws, value);
    try {
        row.stock.inventory(value);
    }
    catch (raw) {
        markUnknown(row, raw);
        throw raw;
    }
}
function allRetired(manager) {
    for (let i = 0; i < manager.leases.length; i++)
        if (!manager.leases[i].retired)
            return false;
    return true;
}
function physicallyKnown(manager) {
    if (!manager.closeAttempted || !manager.physicalAck || manager.unknown || manager.inFlight || !stockKnown(manager.stock))
        return false;
    for (let i = 0; i < manager.leases.length; i++) {
        const row = manager.leases[i];
        if (!row.retired || row.unknown || !stockKnown(row.stock))
            return false;
        for (let j = 0; j < row.cursors.length; j++)
            if (!row.cursors[j].done)
                return false;
    }
    return true;
}
function assertActive(row) {
    const manager = row.manager;
    if (row.retired)
        throw row.retiredError;
    if (manager.phase !== 'open' || manager.unknown)
        throw manager.failure ? manager.failure.raw : unconfirmed();
    if (manager.runningLease && manager.runningLease !== row || manager.txOwner && manager.txOwner !== row)
        throw Error('broker_managed_connection_busy');
    if (!stockKnown(row.stock) || !stockKnown(manager.stock))
        throw unconfirmed();
}
function rawTransactionState(row) {
    const manager = row.manager;
    let value;
    try {
        value = apply(manager.api.transactionStateGetter, manager.db, []);
        rememberValue(row, value);
    }
    catch (raw) {
        markUnknown(row, raw);
        throw raw;
    }
    if (typeof value !== 'boolean') {
        markUnknown(row, value);
        throw unconfirmed();
    }
    return value;
}
function observeTransaction(row) {
    if (rawTransactionState(row))
        row.manager.txOwner ??= row;
    else if (row.manager.txOwner === row)
        row.manager.txOwner = null;
}
function finishPhysical(manager) {
    if (manager.closeAttempted || manager.inFlight || !allRetired(manager))
        return;
    manager.closeAttempted = true;
    manager.phase = 'closing';
    let first;
    const originalRow = manager.leases[0];
    const inspectOwned = () => {
        if (!originalRow || !manager.db)
            return;
        manager.inFlight++;
        try {
            inspectNative(originalRow, manager.db, 'database');
        }
        catch (raw) {
            first ??= { raw };
            remember(originalRow, raw);
        }
        finally {
            manager.inFlight--;
        }
    };
    inspectOwned();
    const attempt = (work, ack) => {
        manager.inFlight++;
        try {
            const raw = work();
            append(manager.raws, raw);
            manager.stock?.inventory(raw);
            if (raw !== undefined) {
                managerUnknown(manager, raw);
                throw unconfirmed();
            }
            ack();
        }
        catch (raw) {
            first ??= { raw };
            managerUnknown(manager, raw);
        }
        finally {
            manager.inFlight--;
        }
    };
    if (manager.db)
        attempt(() => apply(manager.api.databaseMethods.close, manager.db, []), () => { manager.dbClosed = true; });
    else if (!manager.constructorEntered)
        manager.dbClosed = true;
    else
        managerUnknown(manager, unconfirmed());
    if (manager.api)
        attempt(() => apply(manager.api.closeOwned, manager.resource.namespace, []), () => { manager.namespaceClosed = true; });
    if (manager.resource)
        attempt(() => apply(manager.resource.finish, manager.resource, []), () => { manager.sourceClosed = true; });
    inspectOwned();
    manager.physicalAck = manager.dbClosed && manager.namespaceClosed && manager.sourceClosed;
    manager.phase = 'closed';
    manager.finishBarrier();
    if (physicallyKnown(manager))
        held.delete(manager);
    if (first) {
        manager.closeFailure ??= first;
        throw first.raw;
    }
    if (!physicallyKnown(manager))
        throw unconfirmed();
}
function settleRetired(manager) {
    if (manager.inFlight || manager.settling)
        return;
    manager.settling = true;
    let first;
    try {
        for (let i = 0; i < manager.leases.length; i++) {
            const row = manager.leases[i];
            if (!row.retired)
                continue;
            try {
                flushCursors(row);
            }
            catch (raw) {
                first ??= { raw };
            }
            if (manager.txOwner === row) {
                manager.inFlight++;
                row.inFlight++;
                try {
                    if (rawTransactionState(row)) {
                        const raw = apply(manager.api.databaseMethods.exec, manager.db, ['ROLLBACK']);
                        rememberValue(row, raw);
                        if (raw !== undefined)
                            throw unconfirmed();
                    }
                    manager.txOwner = null;
                }
                catch (raw) {
                    first ??= { raw };
                    markUnknown(row, raw);
                }
                finally {
                    row.inFlight--;
                    manager.inFlight--;
                }
            }
        }
        try {
            finishPhysical(manager);
        }
        catch (raw) {
            first ??= { raw };
        }
    }
    finally {
        manager.settling = false;
    }
    if (first)
        throw first.raw;
}
function endCall(row) {
    const manager = row.manager;
    row.inFlight--;
    manager.inFlight--;
    settleRetired(manager);
}
function invoke(row, fn, receiver, args, kind) {
    assertActive(row);
    const manager = row.manager, prior = manager.runningLease;
    manager.runningLease = row;
    row.inFlight++;
    manager.inFlight++;
    let result, first;
    try {
        result = apply(fn, receiver, args);
        if (kind === 'database' || kind === 'statement')
            inspectNative(row, result, kind);
        else if (kind === 'cursor')
            inspectCursor(row, result);
        else
            rememberValue(row, result);
        if (kind === 'state' && typeof result !== 'boolean') {
            markUnknown(row, result);
            throw unconfirmed();
        }
        if (kind === 'void' && result !== undefined) {
            markUnknown(row, result);
            throw unconfirmed();
        }
    }
    catch (raw) {
        first = { raw };
        remember(row, raw);
    }
    try {
        if (manager.db) {
            if (kind === 'state') {
                if (result)
                    manager.txOwner ??= row;
                else if (manager.txOwner === row)
                    manager.txOwner = null;
            }
            else
                observeTransaction(row);
        }
    }
    catch (raw) {
        first ??= { raw };
        remember(row, raw);
    }
    if (!first && row.retired) {
        first = { raw: row.retiredError };
        remember(row, row.retiredError);
    }
    manager.runningLease = prior;
    try {
        endCall(row);
    }
    catch (raw) {
        if (!first)
            first = { raw };
        else
            remember(row, raw);
    }
    if (first)
        throw first.raw;
    return result;
}
function returnCursor(row, cursor, fn = cursor.end, args = []) {
    if (cursor.done)
        return { done: true, value: undefined };
    cursor.requested = true;
    if (row.inFlight)
        return { done: true, value: undefined };
    if (cursor.entered) {
        markUnknown(row, unconfirmed());
        throw unconfirmed();
    }
    cursor.entered = true;
    const manager = row.manager;
    manager.inFlight++;
    row.inFlight++;
    let result, first;
    try {
        result = apply(fn, cursor.actual, args);
        rememberValue(row, result);
        if (result !== undefined && (!result || typeof result !== 'object' || isProxy(result) || descriptor(result, 'done')?.value !== true)) {
            markUnknown(row, result);
            throw unconfirmed();
        }
        cursor.done = true;
    }
    catch (raw) {
        first = { raw };
        row.closeFailure ??= first;
        markUnknown(row, raw);
    }
    row.inFlight--;
    manager.inFlight--;
    try {
        settleRetired(manager);
    }
    catch (raw) {
        first ??= { raw };
    }
    if (first)
        throw first.raw;
    return result ?? { done: true, value: undefined };
}
function flushCursors(row) {
    let first;
    for (let i = 0; i < row.cursors.length; i++)
        if (!row.cursors[i].done)
            try {
                returnCursor(row, row.cursors[i]);
            }
            catch (raw) {
                first ??= { raw };
            }
    if (first)
        throw first.raw;
}
function closeRow(row) {
    const manager = row.manager;
    if (!row.retired) {
        row.retired = true;
        row.closeEntered = true;
    }
    settleRetired(manager);
    if (row.closeFailure)
        throw row.closeFailure.raw;
    if (manager.closeFailure)
        throw manager.closeFailure.raw;
}
function getManager() {
    if (birth) {
        if (birth.failure)
            throw birth.failure.raw;
        return birth.ordinary ? null : birth;
    }
    const manager = { leases: [], raws: [], inFlight: 1, phase: 'initializing', unknown: false, runningLease: null, txOwner: null };
    birth = manager;
    held.add(manager);
    manager.barrier = new NativePromise(yes => { manager.finishBarrier = yes; });
    try {
        manager.resource = readBrokerProtectedSQLiteResource();
        if (!manager.resource || manager.resource.namespace === null) {
            manager.ordinary = true;
            held.delete(manager);
            return null;
        }
        manager.runtime = readBrokerSourceRuntime();
        if (!manager.runtime)
            throw Error('broker_source_runtime_unavailable');
        manager.stock = manager.runtime.createRoomTurnCustody();
        manager.api = readManagedApiContract(manager.resource);
        const raw = apply(manager.resource.bindNamespace, manager.resource, []);
        manager.stock.inventory(raw);
        if (raw !== undefined)
            throw unconfirmed();
        manager.phase = 'open';
        return manager;
    }
    catch (raw) {
        managerUnknown(manager, raw);
        manager.inFlight--;
        try {
            finishPhysical(manager);
        }
        catch (cleanup) {
            append(manager.raws, cleanup);
        }
        throw raw;
    }
    finally {
        if (manager.inFlight)
            manager.inFlight--;
    }
}
export function openManagedBrokerDatabase(dbPath, purpose) {
    const manager = getManager();
    if (!manager)
        return null;
    if (manager.phase !== 'open' || manager.unknown)
        throw manager.failure ? manager.failure.raw : unconfirmed();
    if (purpose !== 'event' && purpose !== 'room')
        throw Error('broker_managed_purpose');
    const pathKey = typeof dbPath === 'string' && dbPath && dbPath !== ':memory:' ? resolve(dbPath) : dbPath;
    if (manager.pathSet && manager.pathKey !== pathKey)
        throw Error('broker_managed_database_path');
    for (let i = 0; i < manager.leases.length; i++)
        if (manager.leases[i].purpose === purpose)
            throw Error('broker_managed_lease_already_born');
    manager.pathSet = true;
    manager.pathKey = pathKey;
    const row = { manager, purpose, dbPath, stock: manager.runtime.createRoomTurnCustody(), errors: [], cursors: [], inFlight: 0, unknown: false, retired: false, closeEntered: false, retiredError: Error('broker_managed_lease_retired') };
    const proof = freeze(Object.create(null));
    row.proof = proof;
    apply(set, proofs, [proof, row]);
    append(manager.leases, row);
    try {
        if (!manager.constructorEntered) {
            manager.constructorEntered = true;
            manager.inFlight++;
            row.inFlight++;
            try {
                manager.db = new manager.api.Database();
                inspectNative(row, manager.db, 'database');
            }
            catch (raw) {
                markUnknown(row, raw);
                throw raw;
            }
            finally {
                row.inFlight--;
                manager.inFlight--;
            }
        }
        assertActive(row);
        row.facade = createManagedLeaseFacade(row, { invoke, assert: assertActive, retain: remember, close: closeRow, unknown: markUnknown, addCursor: (r, c) => append(r.cursors, c), returnCursor, transactionState: r => invoke(r, r.manager.api.transactionStateGetter, r.manager.db, [], 'state') });
        return proof;
    }
    catch (raw) {
        remember(row, raw);
        try {
            closeRow(row);
        }
        catch (cleanup) {
            remember(row, cleanup);
        }
        throw raw;
    }
}
export function isManagedBrokerDatabase(proof) { return !!original(proof); }
export function getManagedBrokerDatabase(proof) { return requireRow(proof).facade; }
export function inspectManagedBrokerDatabase(proof) { const row = requireRow(proof); assertActive(row); inspectNative(row, row.manager.db, 'database'); }
export function completeManagedBrokerDatabase(proof) { inspectManagedBrokerDatabase(proof); }
export function failManagedBrokerDatabase(proof, raw) {
    const row = requireRow(proof);
    remember(row, raw);
    try {
        closeRow(row);
    }
    catch (cleanup) {
        throw new AggregateError([raw, cleanup], 'broker_sqlite_initialization_cleanup_failed', { cause: raw });
    }
    throw raw;
}
export function closeManagedBrokerDatabase(proof) { return closeRow(requireRow(proof)); }
function invokeOwner(row, fn, receiver, args) {
    assertActive(row);
    const manager = row.manager, prior = manager.runningLease;
    manager.runningLease = row;
    manager.inFlight++;
    row.inFlight++;
    let value, first;
    try {
        value = apply(fn, receiver, args);
        if (row.retired)
            throw row.retiredError;
    }
    catch (raw) {
        first = { raw };
        remember(row, raw);
    }
    manager.runningLease = prior;
    try {
        endCall(row);
    }
    catch (raw) {
        if (!first)
            first = { raw };
        else
            remember(row, raw);
    }
    if (first)
        throw first.raw;
    return value;
}
export function bindManagedBrokerDatabaseOwner(proof, owner) {
    const row = requireRow(proof);
    for (const name of keys(owner)) {
        const field = descriptor(owner, name);
        if (name === 'close' || !field || !own(field, 'value') || typeof field.value !== 'function')
            continue;
        const original = field.value;
        define(owner, name, { ...field, value: function (...args) { return invokeOwner(row, original, this, args); } });
    }
    apply(set, owners, [owner, row]);
}
export function hasManagedBrokerDatabaseOwner(owner) { return !!apply(get, owners, [owner]); }
export function retainManagedBrokerDatabaseFailure(owner, raw) {
    const row = apply(get, owners, [owner]);
    if (!row)
        throw Error('broker_sqlite_owner_required');
    remember(row, raw);
}
export function readManagedBrokerDatabaseFate(owner) {
    const row = apply(get, owners, [owner]);
    if (!row)
        throw Error('broker_sqlite_owner_required');
    const manager = row.manager, closed = row.retired && physicallyKnown(manager);
    return freeze({ kind: 'broker_sqlite_fate_v1', inventoryAvailable: !!row.stock, constructionEntered: !!manager.constructorEntered, handleReturned: !!manager.db, closeEntered: row.closeEntered, closed, physicalKnown: closed, unknown: row.unknown || manager.unknown, failurePresent: row.errors.length > 0 || !!manager.failure });
}
export async function waitManagedBrokerDatabaseCloseKnown(owner) {
    const row = apply(get, owners, [owner]);
    if (!row)
        throw Error('broker_sqlite_owner_required');
    const manager = row.manager;
    await manager.barrier;
    const work = [];
    if (manager.stock)
        append(work, manager.stock.waitPhysicalKnown());
    for (let i = 0; i < manager.leases.length; i++)
        append(work, manager.leases[i].stock.waitPhysicalKnown());
    const outcomes = await apply(allSettled, NativePromise, [work]);
    let failed = false;
    for (let i = 0; i < outcomes.length; i++)
        if (outcomes[i].status === 'rejected')
            failed = true;
    if (failed || !row.retired || !physicallyKnown(manager))
        throw unconfirmed();
    held.delete(manager);
}
// Only this original private proof can select the transaction's actual row.
export function runManagedBrokerDatabaseTransaction(proof, mode, callback) {
    return runManagedTransaction(requireRow(proof), mode, callback, { assertActive, rawTransactionState, remember, markUnknown, rememberValue, endCall });
}
