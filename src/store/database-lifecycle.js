import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {types} from 'node:util';
import {readBrokerSourceRuntime} from './source-runtime.js';
const NativeDatabase=DatabaseSync,dbPrototype=DatabaseSync.prototype;
const nativeClose=Object.getOwnPropertyDescriptor(dbPrototype,'close').value;
const apply=Reflect.apply,keys=Reflect.ownKeys,descriptor=Object.getOwnPropertyDescriptor,own=Object.hasOwn;
const rows=new WeakMap(),owners=new WeakMap(),paths=new Map(),held=new Set();
const methods=new Set(['open','close','prepare','exec','function','createTagStore','location','aggregate','createSession','applyChangeset','enableLoadExtension','enableDefensive','loadExtension','serialize','deserialize','setAuthorizer','constructor',Symbol.dispose]);
const methodDescriptors=new Map([...methods].map(key=>[key,descriptor(dbPrototype,key)]));
function sameDescriptor(a,b){return !!a&&!!b&&a.value===b.value&&a.get===b.get&&a.set===b.set&&a.writable===b.writable&&a.enumerable===b.enumerable&&a.configurable===b.configurable;}
function fail(){throw Error('broker_sqlite_sdk_unconfirmed');}
function member(proof){const row=rows.get(proof);if(!row)throw Error('broker_sqlite_owner_required');return row;}
function inventory(row,value){row.raws.add(value);if(row.stock)row.stock.inventory(value);}
// Kind-specific selection of original SDK leaves; the one shared runtime owns
// all recursion through error/Promise/own-symbol outcome graphs. No getters run.
function inspectFunction(row,fn){
 if(typeof fn!=='function'||types.isProxy(fn)){row.unknown=true;inventory(row,fn);return;}
 for(const key of keys(fn)){const d=descriptor(fn,key);if(!d||!own(d,'value')){row.unknown=true;inventory(row,fn);continue;}
  if(fn===NativeDatabase&&key==='prototype'&&d.value===dbPrototype)continue;
  inventory(row,d.value);
 }
}
function inspectDatabase(row){
 const db=row.db;
 if(!db||types.isProxy(db)||Object.getPrototypeOf(db)!==dbPrototype){row.unknown=true;inventory(row,db);return;}
 inspectFunction(row,NativeDatabase);
 for(const key of keys(dbPrototype)){
  const d=descriptor(dbPrototype,key);
  if(!d||!own(d,'value')||!methods.has(key)||!sameDescriptor(d,methodDescriptors.get(key))){row.unknown=true;if(d&&own(d,'value'))inventory(row,d.value);else inventory(row,dbPrototype);continue;}
  inspectFunction(row,d.value);
 }
 for(const key of keys(db)){
  const d=descriptor(db,key);
  if(d&&own(d,'value'))inventory(row,d.value);
  else if(d&&['isOpen','isTransaction','limits'].includes(key)&&d.configurable===false&&d.enumerable===true&&typeof d.get==='function'&&d.set===undefined)inspectFunction(row,d.get);
  else{row.unknown=true;inventory(row,db);}
 }
}
function known(row){if(row.unknown)return false;try{row.stock?.assertPhysicalKnown();return true;}catch{return false;}}
function removeKnown(row){if(known(row)&&row.closeEntered&&!row.closeFailure){row.closed=true;held.delete(row);paths.get(row.pathKey)?.delete(row);return true;}return false;}
function open(dbPath){
 const pathKey=typeof dbPath==='string'&&dbPath&&dbPath!==':memory:'?resolve(dbPath):Symbol('ephemeral-broker-db');
 const prior=paths.get(pathKey);if(prior)for(const r of prior){if(r.closeEntered)removeKnown(r);if(!r.closed&&(r.unknown||r.constructing||r.closeEntered||!known(r)))throw Error('broker_sqlite_previous_unknown');}
 const row={pathKey,dbPath,constructing:true,entered:false,db:null,raws:new Set(),failures:[],unknown:false,closeEntered:false,closed:false,stock:null,runtime:null};
 const proof=Object.freeze(Object.create(null));row.proof=proof;rows.set(proof,row);held.add(row);if(!prior)paths.set(pathKey,new Set([row]));else prior.add(row);
 try{
  row.runtime=readBrokerSourceRuntime();row.stock=row.runtime?.createRoomTurnCustody()??null;row.runtime?.assertOrdinarySourceWriterRoute();
  row.entered=true;row.db=new NativeDatabase(dbPath);row.constructing=false;
  inspectDatabase(row);if(!known(row))fail();return proof;
 }catch(raw){row.failures.push({raw});inventory(row,raw);row.constructing=false;
  if(row.entered&&!row.db)row.unknown=true;
  if(row.db){try{closeBrokerDatabase(proof);}catch(cleanup){throw new AggregateError([raw,cleanup],'broker_sqlite_initialization_cleanup_failed',{cause:raw});}}
  else if(!row.entered){row.closed=true;held.delete(row);paths.get(pathKey).delete(row);}
  throw raw;
 }
}
export const openBrokerEventDatabase=dbPath=>open(dbPath);
export const openBrokerRoomDatabase=dbPath=>open(dbPath);
export function inspectBrokerDatabaseConstruction(proof){const row=member(proof);inspectDatabase(row);if(!known(row))fail();row.runtime?.assertOrdinarySourceWriterRoute();}
export function completeBrokerDatabaseInitialization(proof){
 inspectBrokerDatabaseConstruction(proof);const row=member(proof);
 if(row.runtime&&typeof row.dbPath==='string'&&row.dbPath&&row.dbPath!==':memory:')row.runtime.observeOrdinarySQLiteWriter(row.dbPath,'broker-room-sqlite-v1');
}
export function failBrokerDatabaseInitialization(proof,raw){
 const row=member(proof);row.failures.push({raw});inventory(row,raw);
 try{closeBrokerDatabase(proof);}catch(cleanup){throw new AggregateError([raw,cleanup],'broker_sqlite_initialization_cleanup_failed',{cause:raw});}throw raw;
}
export function closeBrokerDatabase(proof){
 const row=member(proof);if(row.closed)return;
 if(row.closeEntered){if(removeKnown(row))return;if(row.closeFailure)throw row.closeFailure.raw;fail();}
 row.closeEntered=true;
 // Cleanup bypasses positive route/current, but uses only this actual handle
 // and its module-captured original close. The SDK is never retried.
 inspectDatabase(row);
 try{const raw=apply(nativeClose,row.db,[]);row.closeRaw={raw};inventory(row,raw);if(raw!==undefined){row.unknown=true;fail();}}
 catch(raw){row.closeFailure={raw};row.failures.push({raw});row.unknown=true;inventory(row,raw);throw raw;}
 inspectDatabase(row);if(!removeKnown(row))fail();
}
export function getBrokerDatabase(proof){return member(proof).db;}
export function bindBrokerDatabaseOwner(proof,owner){owners.set(owner,member(proof));}
export function readBrokerDatabaseFate(owner){
 const row=owners.get(owner);if(!row)throw Error('broker_sqlite_owner_required');
 return Object.freeze({kind:'broker_sqlite_fate_v1',inventoryAvailable:!!row.stock,constructionEntered:row.entered,handleReturned:!!row.db,closeEntered:row.closeEntered,closed:row.closed,physicalKnown:!!row.stock&&row.closed&&known(row),unknown:row.unknown,failurePresent:row.failures.length>0});
}
export async function waitBrokerDatabaseCloseKnown(owner){
 const row=owners.get(owner);if(!row)throw Error('broker_sqlite_owner_required');
 if(!row.stock)throw Error('broker_source_runtime_unavailable');await row.stock.waitPhysicalKnown();if(!removeKnown(row))fail();
}

// Negative/error custody only. The exact born Store is checked before the raw
// error graph; this cannot mint a row, runtime, local guard or positive role.
export function retainBrokerDatabaseFailure(owner,raw){
 const row=owners.get(owner);if(!row)throw Error('broker_sqlite_owner_required');row.failures.push({raw});inventory(row,raw);
}
