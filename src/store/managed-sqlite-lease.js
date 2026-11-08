// Per-lease projection of one privately owned protected connection. These
// wrappers never assert Native identity and never expose the underlying handle.
import { types } from 'node:util';
const keys = Reflect.ownKeys, descriptor = Object.getOwnPropertyDescriptor, own = Object.hasOwn;
const create = Object.create, define = Object.defineProperty, freeze = Object.freeze, isProxy = types.isProxy;
const apply = Reflect.apply;
function put(target, key, value) { define(target, key, { value, enumerable: true }); }
function method(value, key) {
    if (!value || isProxy(value))
        throw Error('broker_managed_cursor_unconfirmed');
    const field = descriptor(value, key);
    if (!field || !own(field, 'value') || typeof field.value !== 'function' || isProxy(field.value))
        throw Error('broker_managed_cursor_unconfirmed');
    return field.value;
}
export function createManagedLeaseFacade(row, operations) {
    const db = create(null), api = row.manager.api;
    function statement(actual) {
        const view = create(null);
        for (const name of ['get', 'all', 'run', 'setReadBigInts']) {
            const original = api.statementMethods[name];
            put(view, name, (...args) => operations.invoke(row, original, actual, args, name === 'setReadBigInts' ? 'void' : 'data'));
        }
        put(view, 'iterate', (...args) => {
            const actualCursor = operations.invoke(row, api.statementMethods.iterate, actual, args, 'cursor');
            let next, end;
            try {
                next = method(actualCursor, 'next');
                end = method(actualCursor, 'return');
            }
            catch (raw) {
                operations.unknown(row, raw);
                throw raw;
            }
            const cursor = { actual: actualCursor, end, done: false, entered: false };
            operations.addCursor(row, cursor);
            const projected = create(null);
            put(projected, 'next', () => {
                operations.assert(row);
                if (cursor.done || cursor.requested)
                    return { done: true, value: undefined };
                const value = operations.invoke(row, next, actualCursor, [], 'data');
                const done = descriptor(value, 'done');
                if (done && own(done, 'value') && done.value === true)
                    cursor.done = true;
                return value;
            });
            put(projected, 'return', () => operations.returnCursor(row, cursor));
            put(projected, 'throw', raw => {
                operations.returnCursor(row, cursor);
                operations.retain(row, raw);
                throw raw;
            });
            put(projected, Symbol.iterator, () => projected);
            return freeze(projected);
        });
        return freeze(view);
    }
    put(db, 'exec', sql => operations.invoke(row, api.databaseMethods.exec, row.manager.db, [sql], 'void'));
    put(db, 'prepare', sql => statement(operations.invoke(row, api.databaseMethods.prepare, row.manager.db, [sql], 'statement')));
    put(db, 'function', (...args) => operations.invoke(row, api.databaseMethods.function, row.manager.db, args, 'void'));
    put(db, 'close', () => operations.close(row));
    define(db, 'isTransaction', { enumerable: true, get: () => operations.transactionState(row) });
    return freeze(db);
}
