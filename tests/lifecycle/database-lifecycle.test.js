import '../fixtures/source-account-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const inventoryPrerequisite={skip:existsSync(new URL('../../runtime/xiaok-source-runtime.cjs',import.meta.url))?false:'fixed source runtime artifact prerequisite absent; ordinary standalone is unqualified'};
// The repository runner explicitly shares one process across test modules.
// Run only these fault-injection cases in private child modules so replacing
// SDK methods cannot mutate an already captured sibling production receiver.
if(process.execArgv.includes('--experimental-test-isolation=none')){
 const names=["original EventStore exposes idempotent actual close and cannot write through the closed handle", "original service shutdown actually attempts both same-file connections exactly once", "Room initialization preserves thrown undefined while a failed close is independently retained", "second-connection startup failure still closes both already-born siblings preserving undefined", "EventStore rollback secondary error never replaces the actual commit first value", "close throw after the actual SDK cannot revive its path and still attempts the other service connection", "entered constructor with no returned handle fences the same path before a later real birth", "actual DB own-symbol held Promise delays known close without a second SDK close or source replay", "public Room close replacement cannot redirect the original service-owned negative consumer", "startup error own accessor tails are retained without executing them or rebirthing its path"];
 for(const name of names)test(name,name===names[7]||name===names[9]?inventoryPrerequisite:{},()=>{
  const exact='^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$';
  const child=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-name-pattern',exact,fileURLToPath(import.meta.url)],{encoding:'utf8'});
  console.log(JSON.stringify({kind:'broker-lifecycle-child-exit',pid:child.pid,status:child.status,signal:child.signal,births:[...child.stdout.matchAll(/\{\"kind\":\"broker-source-test-birth\"[^\n]+\}/g)].map(match=>JSON.parse(match[0]))}));
  assert.equal(child.error,undefined);assert.equal(child.signal,null);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
  assert.match(child.stdout,/^# pass 1$/m);assert.match(child.stdout,/^# fail 0$/m);assert.match(child.stdout,/^# cancelled 0$/m);
 });
}else{
const directory=mkdtempSync(join(tmpdir(),'broker-lifecycle-'));process.env.XIAOK_CONFIG_DIR=join(directory,'config');mkdirSync(process.env.XIAOK_CONFIG_DIR,{mode:0o700});
const originalClose=DatabaseSync.prototype.close,originalExec=DatabaseSync.prototype.exec;
const calls=new Map();let fault;
DatabaseSync.prototype.close={close(){calls.set(this,(calls.get(this)||0)+1);if(fault?.closeBefore)throw fault.closeBefore.raw;const raw=Reflect.apply(originalClose,this,[]);if(fault?.closeAfter)throw fault.closeAfter.raw;return raw;}}.close;
DatabaseSync.prototype.exec={exec(sql){if(fault?.exec&&fault.exec(this,sql))throw fault.raw;return Reflect.apply(originalExec,this,[sql]);}}.exec;
const {createEventStore}=await import('../../src/store/event-store.js');
const {createRoomStore}=await import('../../src/room/store.js');
const {createBrokerService}=await import('../../src/broker/service.js');
const path=tag=>join(directory,tag+'.sqlite');
test('original EventStore exposes idempotent actual close and cannot write through the closed handle',()=>{
 const store=createEventStore({dbPath:path('event')});assert.equal(typeof store.close,'function');store.close();store.close();assert.throws(()=>store.listEvents(),/closed|not open/i);
});
test('original service shutdown actually attempts both same-file connections exactly once',()=>{
 const before=new Set(calls.keys()),service=createBrokerService({dbPath:path('service'),presenceSweepIntervalMs:0});service.close();service.close();const closed=[...calls].filter(([db])=>!before.has(db));assert.equal(closed.length,2);assert.deepEqual(closed.map(([,n])=>n),[1,1]);
});
test('Room initialization preserves thrown undefined while a failed close is independently retained',()=>{
 const expected=new Error('close-before');fault={exec:(_db,sql)=>String(sql).startsWith('PRAGMA synchronous'),raw:undefined,closeBefore:{raw:expected}};
 let failure;try{createRoomStore({dbPath:path('room-fail'),storageBudget:{databaseBytes:1024*1024}});}catch(raw){failure={raw};}finally{fault=undefined;}
 assert.ok(failure);assert.ok(failure.raw instanceof AggregateError);assert.equal(failure.raw.errors[0],undefined);assert.equal(failure.raw.errors[1],expected);assert.equal(Object.hasOwn(failure.raw,'cause'),true);assert.equal(failure.raw.cause,undefined);
 // Only the fixture can close the raw actual handle after the injected SDK
 // throw. Product unknown custody is not promoted to a known resource.
 for(const [db]of calls)if(calls.get(db)===1)try{Reflect.apply(originalClose,db,[]);}catch{}
});
test('second-connection startup failure still closes both already-born siblings preserving undefined',()=>{
 const before=new Set(calls.keys());fault={exec:(_db,sql)=>String(sql).includes('CREATE TABLE IF NOT EXISTS room_schema_version'),raw:undefined};let seen;
 try{createBrokerService({dbPath:path('startup'),presenceSweepIntervalMs:0});}catch(raw){seen={raw};}finally{fault=undefined;}
 assert.ok(seen);assert.equal(seen.raw,undefined);const closed=[...calls].filter(([db])=>!before.has(db));assert.equal(closed.length,2);assert.deepEqual(closed.map(([,n])=>n),[1,1]);
});
test('EventStore rollback secondary error never replaces the actual commit first value',()=>{
 const store=createEventStore({dbPath:path('rollback')}),secondary=new Error('secondary rollback');let stage=0;
 fault={exec:(_db,sql)=>{if(sql==='COMMIT'){stage=1;return true;}if(stage&&sql==='ROLLBACK'){fault.raw=secondary;return true;}return false;},raw:undefined};let seen;
 try{store.appendIntent({intentId:'one',kind:'report_progress',fromParticipantId:'a',payload:{},recipients:[]});}catch(raw){seen={raw};}finally{fault=undefined;}
 assert.ok(seen);assert.ok(seen.raw instanceof AggregateError);assert.equal(seen.raw.errors[0],undefined);assert.equal(seen.raw.errors[1],secondary);assert.equal(Object.hasOwn(seen.raw,'cause'),true);assert.equal(seen.raw.cause,undefined);store.close();
});

test('close throw after the actual SDK cannot revive its path and still attempts the other service connection',()=>{
 const file=path('close-after'),before=new Set(calls.keys()),service=createBrokerService({dbPath:file,presenceSweepIntervalMs:0});fault={closeAfter:{raw:undefined}};let seen;
 try{service.close();}catch(raw){seen={raw};}finally{fault=undefined;}
 assert.ok(seen);assert.ok(seen.raw instanceof AggregateError);assert.deepEqual(seen.raw.errors,[undefined,undefined]);assert.equal(Object.hasOwn(seen.raw,'cause'),true);assert.equal(seen.raw.cause,undefined);
 const closed=[...calls].filter(([db])=>!before.has(db));assert.equal(closed.length,2);assert.deepEqual(closed.map(([,n])=>n),[1,1]);assert.throws(()=>service.close(),raw=>raw===seen.raw);assert.deepEqual(closed.map(([db])=>calls.get(db)),[1,1]);
 assert.throws(()=>createEventStore({dbPath:file}),/previous_unknown/);for(const [db]of closed)assert.throws(()=>Reflect.apply(originalExec,db,['SELECT 1']),/not open|closed/i);
});
test('entered constructor with no returned handle fences the same path before a later real birth',()=>{
 const file=join(directory,'not-yet-created','source.sqlite');assert.throws(()=>createEventStore({dbPath:file}));mkdirSync(join(directory,'not-yet-created'));assert.throws(()=>createEventStore({dbPath:file}),/previous_unknown/);
});
test('actual DB own-symbol held Promise delays known close without a second SDK close or source replay',inventoryPrerequisite,async()=>{
 const {readBrokerDatabaseFate,waitBrokerDatabaseCloseKnown}=await import('../../src/store/database-lifecycle.js');const file=path('held-tail'),store=createRoomStore({dbPath:file});let release;const tail=new Promise(yes=>{release=yes;});store.db[Symbol('actual-sdk-sidecar')]=tail;
 assert.throws(()=>store.close(),/sdk_unconfirmed/);assert.equal(readBrokerDatabaseFate(store).closed,false);assert.equal(calls.get(store.db),1);assert.throws(()=>createRoomStore({dbPath:file}),/previous_unknown/);
 release();await waitBrokerDatabaseCloseKnown(store);assert.equal(readBrokerDatabaseFate(store).physicalKnown,true);store.close();assert.equal(calls.get(store.db),1);
 const next=createRoomStore({dbPath:file});next.close();let hits=0;const fake=new Proxy({},{get(){hits++;throw 0;},ownKeys(){hits++;throw 0;}});assert.throws(()=>readBrokerDatabaseFate(fake),/owner_required/);assert.equal(hits,0);
});
test('public Room close replacement cannot redirect the original service-owned negative consumer',()=>{
 const before=new Set(calls.keys()),service=createBrokerService({dbPath:path('fixed-consumer'),presenceSweepIntervalMs:0});let hits=0;
 Object.defineProperty(service.room,'close',{get(){hits++;throw undefined;}});service.close();assert.equal(hits,0);const closed=[...calls].filter(([db])=>!before.has(db));assert.equal(closed.length,2);assert.deepEqual(closed.map(([,n])=>n),[1,1]);
});
test('startup error own accessor tails are retained without executing them or rebirthing its path',inventoryPrerequisite,()=>{
 const file=path('startup-tail'),error=new Error('original');let hits=0;Object.defineProperty(error,'message',{get(){hits++;return 'forbidden';}});fault={exec:(_db,sql)=>String(sql).includes('CREATE TABLE IF NOT EXISTS room_schema_version'),raw:error};let seen;
 try{createBrokerService({dbPath:file,presenceSweepIntervalMs:0});}catch(raw){seen={raw};}finally{fault=undefined;}
 assert.ok(seen);assert.equal(seen.raw instanceof AggregateError?seen.raw.errors[0]:seen.raw,error);assert.equal(hits,0);
 let next;try{assert.throws(()=>{next=createBrokerService({dbPath:file,presenceSweepIntervalMs:0});},/previous_unknown/);}finally{next?.close();}
});

}
