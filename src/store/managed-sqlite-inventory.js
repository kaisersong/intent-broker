// Fixed protected SDK contract/leaf selection only. This module authenticates
// no namespace, owns no resource, and delegates arbitrary error/Promise graphs
// to the unchanged original inventory supplied by the original private row.
import { types } from 'node:util';
const keys = Reflect.ownKeys, descriptor = Object.getOwnPropertyDescriptor, own = Object.hasOwn;
const prototype = Object.getPrototypeOf, freeze = Object.freeze, isProxy = types.isProxy;
function unconfirmed() { return Error('broker_sqlite_sdk_unconfirmed'); }
function inspectFunctionSlots(fn, inventory, unknown) {
    for (const name of keys(fn)) {
        const field = descriptor(fn, name);
        if (!field || !own(field, 'value')) {
            unknown(fn);
            throw unconfirmed();
        }
        if (name === 'prototype' && field.value && typeof field.value === 'object' && !isProxy(field.value)) {
            if (prototype(field.value) !== Object.prototype) {
                unknown(field.value);
                throw unconfirmed();
            }
            for (const key of keys(field.value)) {
                const data = descriptor(field.value, key);
                if (!data || !own(data, 'value')) {
                    unknown(field.value);
                    throw unconfirmed();
                }
                if (key === 'constructor' && data.value === fn)
                    continue;
                inventory(data.value);
            }
        }
        else
            inventory(field.value);
    }
}
export function inspectManagedNative(value, kind, api, inventory, unknown) {
    if (!value || typeof value !== 'object' || isProxy(value) || prototype(value) !== api[kind === 'database' ? 'Database' : 'Statement'].prototype) {
        unknown(value);
        throw unconfirmed();
    }
    for (const name of keys(value)) {
        const field = descriptor(value, name);
        if (field && own(field, 'value'))
            inventory(field.value);
        else if (kind === 'database' && name === 'isTransaction' && field && field.get === api.transactionStateGetter && field.set === undefined && field.configurable === false) {
            inspectFunctionSlots(field.get, inventory, unknown);
        }
        else {
            unknown(value);
            throw unconfirmed();
        }
    }
}
export function inspectManagedCursor(value, inventory, unknown) {
    if (!value || typeof value !== 'object' || isProxy(value)) {
        unknown(value);
        throw unconfirmed();
    }
    for (const name of keys(value)) {
        const field = descriptor(value, name);
        if (!field || !own(field, 'value')) {
            unknown(value);
            throw unconfirmed();
        }
        if (typeof field.value === 'function') {
            if (isProxy(field.value)) {
                unknown(field.value);
                throw unconfirmed();
            }
            for (const key of keys(field.value)) {
                const data = descriptor(field.value, key);
                if (!data || !own(data, 'value')) {
                    unknown(field.value);
                    throw unconfirmed();
                }
                inventory(data.value);
            }
        }
        else
            inventory(field.value);
    }
}
function method(object, name) {
    if (!object || isProxy(object))
        throw unconfirmed();
    const field = descriptor(object, name);
    if (!field || !own(field, 'value') || typeof field.value !== 'function' || isProxy(field.value) || !Object.isFrozen(field.value))
        throw unconfirmed();
    return field.value;
}
export function readManagedApiContract(resource) {
    const api = resource.namespace;
    const data = {};
    for (const name of ['Database', 'Statement', 'transactionStateGetter', 'closeOwned'])
        data[name] = method(api, name);
    for (const name of ['databaseMethods', 'statementMethods']) {
        const field = descriptor(api, name);
        if (!field || !own(field, 'value') || !field.value || isProxy(field.value) || !Object.isFrozen(field.value))
            throw unconfirmed();
        data[name] = field.value;
    }
    for (const name of ['exec', 'prepare', 'function', 'close'])
        method(data.databaseMethods, name);
    for (const name of ['get', 'all', 'run', 'iterate', 'setReadBigInts'])
        method(data.statementMethods, name);
    return freeze(data);
}
