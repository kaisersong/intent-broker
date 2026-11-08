// Control for the original Broker row only; owns no DB and grants no role.
import { types } from 'node:util';
const apply = Reflect.apply, isProxy = types.isProxy;
function unconfirmed() { return Error('broker_sqlite_sdk_unconfirmed'); }
// Private transaction control never goes through the retired public DB facade.
export function runManagedTransaction(row, mode, callback, operations) {
    const { assertActive, rawTransactionState, remember, markUnknown, rememberValue, endCall } = operations;
    const manager = row.manager;
    assertActive(row);
    if (!['event', 'write', 'read'].includes(mode) || typeof callback !== 'function' || isProxy(callback))
        throw Error('broker_managed_transaction_arguments');
    const reuse = mode === 'read' && manager.txOwner === row;
    const prior = manager.runningLease;
    manager.runningLease = row;
    manager.inFlight++;
    row.inFlight++;
    let result, first, began = false;
    function control(sql) {
        try {
            const raw = apply(manager.api.databaseMethods.exec, manager.db, [sql]);
            rememberValue(row, raw);
            if (raw !== undefined)
                throw unconfirmed();
        }
        catch (raw) {
            markUnknown(row, raw);
            throw raw;
        }
    }
    try {
        if (!reuse) {
            control(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
            began = true;
            manager.txOwner = row;
        }
        result = callback();
        if (row.retired)
            throw row.retiredError;
        if (!reuse) {
            control('COMMIT');
            manager.txOwner = null;
        }
    }
    catch (raw) {
        first = { raw };
        remember(row, raw);
        let rollback;
        try {
            if (!reuse && rawTransactionState(row) !== false)
                control('ROLLBACK');
        }
        catch (cleanup) {
            rollback = { raw: cleanup };
            remember(row, cleanup);
        }
        if (!reuse)
            manager.txOwner = null;
        if (rollback)
            first = { raw: new AggregateError([raw, rollback.raw], mode === 'event' ? 'event_transaction_rollback_failed' : 'room_transaction_rollback_failed', { cause: raw }) };
    }
    manager.runningLease = prior;
    try {
        endCall(row);
    }
    catch (raw) {
        if (first)
            remember(row, raw);
        else
            first = { raw };
    }
    if (first)
        throw first.raw;
    return result;
}
