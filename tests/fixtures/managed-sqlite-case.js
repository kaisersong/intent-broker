// Scheduling-only fixed-resource fixture. This is never Native identity evidence.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const repo = resolve(import.meta.dirname, '../..');
const fixed = `'use strict';
const {DatabaseSync}=require('node:sqlite');
const actuals=new WeakMap(),statements=new WeakMap();
const state=globalThis.__managedFixture={constructors:0,databaseCloses:0,namespaceCloses:0,finishes:0,binds:0,databases:[],faults:{}};
function effect(name,work){const fault=state.faults[name];if(fault&&fault.phase==='before')throw fault.raw;const raw=work();if(fault&&fault.phase==='after')throw fault.raw;return raw;}
// This scheduling mock reads the real old Node connection through a fixed
// empty BEGIN/ROLLBACK probe only when its SDK lacks isTransaction. The real
// protected Native getter is C sqlite3_get_autocommit, not this test helper.
const transactionState={transactionState(){const value=actuals.get(this);if(typeof value.db.isTransaction==='boolean')return value.db.isTransaction;try{value.db.exec('BEGIN');}catch(raw){if(raw.errcode===1&&raw.message.includes('within a transaction'))return true;throw raw;}value.db.exec('ROLLBACK');return false;}}.transactionState;
class Database {
 constructor(...args){if(args.length||state.constructors)throw Error('fixture-single-database');state.constructors++;const value={db:new DatabaseSync('./managed.sqlite'),transaction:false,closed:false};actuals.set(this,value);state.databases.push(value);if(Object.hasOwn(state.faults,'constructor'))throw state.faults.constructor.raw;Object.defineProperty(this,'isTransaction',{get:transactionState,enumerable:false});}
 exec(sql){const value=actuals.get(this);return effect('exec',()=>{const raw=value.db.exec(sql);if(/^BEGIN(?: IMMEDIATE)?$/.test(sql))value.transaction=true;if(sql==='COMMIT'||sql==='ROLLBACK')value.transaction=false;return raw;});}
 prepare(sql){const result=Object.create(Statement.prototype);statements.set(result,actuals.get(this).db.prepare(sql));return result;}
 function(...args){return actuals.get(this).db.function(...args);}
 close(){state.databaseCloses++;return effect('close',()=>{const value=actuals.get(this);const raw=value.db.close();value.closed=true;return raw;});}
}
class Statement {
 get(...args){return statements.get(this).get(...args);}
 all(...args){return statements.get(this).all(...args);}
 run(...args){return effect('run',()=>statements.get(this).run(...args));}
 iterate(...args){const actual=statements.get(this).iterate(...args);const cursor={next:()=>actual.next(),return:()=>actual.return(),[Symbol.iterator](){return cursor;}};return Object.freeze(cursor);}
 setReadBigInts(...args){statements.get(this).setReadBigInts(...args);}
}
const databaseMethods=Object.freeze(Object.fromEntries(['exec','prepare','function','close'].map(name=>[name,Database.prototype[name]])));
const statementMethods=Object.freeze(Object.fromEntries(['get','all','run','iterate','setReadBigInts'].map(name=>[name,Statement.prototype[name]])));
function closeOwned(){state.namespaceCloses++;return effect('namespaceClose',()=>{for(const value of state.databases)if(!value.closed){value.db.close();value.closed=true;}});}
for(const fn of [Database,Statement,transactionState,closeOwned,...Object.values(databaseMethods),...Object.values(statementMethods)])Object.freeze(fn);
Object.freeze(Database.prototype);Object.freeze(Statement.prototype);
const namespace=Object.freeze({Database,Statement,databaseMethods,statementMethods,transactionStateGetter:transactionState,closeOwned});
const bindNamespace=Object.freeze(function(){if(arguments.length)throw Error('fixture-no-arguments');state.binds++;});
const finish=Object.freeze(function(){if(arguments.length)throw Error('fixture-no-arguments');state.finishes++;return effect('finish',()=>{});});
module.exports=Object.freeze({namespace,bindNamespace,finish});
`;
export function runManagedCase(body, { moduleSource = fixed } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'broker-managed-case-'));
    try {
        cpSync(join(repo, 'src'), join(root, 'src'), { recursive: true });
        mkdirSync(join(root, 'runtime'));
        mkdirSync(join(root, 'config'), { mode: 0o700 });
        writeFileSync(join(root, 'package.json'), '{"type":"module"}');
        cpSync(join(repo, 'runtime/xiaok-source-runtime.cjs'), join(root, 'runtime/xiaok-source-runtime.cjs'));
        writeFileSync(join(root, 'runtime/original-authority-sqlite.cjs'), moduleSource);
        const code = `import assert from 'node:assert/strict';import {existsSync} from 'node:fs';const {createEventStore}=await import('./src/store/event-store.js');const {createRoomStore}=await import('./src/room/store.js');const {readBrokerDatabaseFate,waitBrokerDatabaseCloseKnown}=await import('./src/store/database-lifecycle.js');const path='./logical.sqlite';${body};console.log(JSON.stringify({kind:'managed-broker-scheduling',nativeAuthentication:false,pid:process.pid}));`;
        const child = spawnSync(process.execPath, ['--import', join(repo, 'tests/fixtures/source-account-preload.mjs'), '--input-type=module', '-e', code], { cwd: root, env: { ...process.env, XIAOK_CONFIG_DIR: join(root, 'config') }, encoding: 'utf8', timeout: 10000 });
        console.log(JSON.stringify({ kind: 'managed-broker-scheduling-child', pid: child.pid, status: child.status, signal: child.signal, root, nativeAuthentication: false }));
        assert.equal(child.error, undefined);
        assert.equal(child.signal, null);
        assert.equal(child.status, 0, child.stdout + '\n' + child.stderr);
    }
    finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
}
