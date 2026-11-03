import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const WAL_STORAGE_MODE = 'wal-full-v1';
export const BROKER_WAL_WRITE_WAIT_MS = 100;
const configuredWalConnections = new WeakSet();
const quarantinedConnections = new WeakSet();
export function assertBrokerDatabaseUsable(db) {
  if(quarantinedConnections.has(db))throw new Error('broker_storage_write_policy');
}
export function isSupportedWalRuntime(versions=process.versions) {
  // Extend only after the new binary passes the same cross-platform gates.
  return versions.node === '24.19.0' && versions.sqlite === '3.53.3';
}
let verifiedSqliteRuntime=false;
export function assertWalRuntime() {
  if (!isSupportedWalRuntime()) throw new Error('broker_storage_runtime');
  // This caches only an immutable executable capability, never rows/authority.
  if(verifiedSqliteRuntime)return;
  const db=new DatabaseSync(':memory:');
  try { if(db.prepare('SELECT sqlite_version() version').get().version!=='3.53.3')throw new Error('broker_storage_runtime'); }
  finally { db.close(); }
  verifiedSqliteRuntime=true;
}
export function profilePath(dbPath) {
  if(typeof dbPath!=='string'||dbPath===':memory:')throw new Error('broker_storage_path');
  const absolute=resolve(dbPath);
  return join(realpathSync(dirname(absolute)),basename(absolute));
}
export function fileIdentity(path) {
  const s=lstatSync(path,{bigint:true});
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n)throw new Error('broker_storage_alias');
  return {dev:String(s.dev),ino:String(s.ino)};
}
export function sameIdentity(a,b) { return a?.dev===b?.dev&&a?.ino===b?.ino; }
export function readProfileJson(path) {
  const identity=fileIdentity(path),fd=openSync(path,'r');
  try {
    const info=fstatSync(fd,{bigint:true});
    if(!sameIdentity(identity,{dev:String(info.dev),ino:String(info.ino)})||info.size>65536n)throw new Error('broker_storage_identity');
    return JSON.parse(readFileSync(fd,'utf8'));
  } finally {closeSync(fd);}
}
export function headerMode(path,{allowEmpty=false}={}) {
  if(!existsSync(path))return 'delete';
  const identity=fileIdentity(path),fd=openSync(path,'r'),header=Buffer.alloc(20);
  try {
    const info=fstatSync(fd,{bigint:true});
    if(!sameIdentity(identity,{dev:String(info.dev),ino:String(info.ino)}))throw new Error('broker_storage_identity');
    const length=readSync(fd,header,0,20,0);
    if(length===0){if(allowEmpty)return 'delete';throw new Error('broker_storage_header');}
    if(length!==20||header.subarray(0,16).toString('binary')!=='SQLite format 3\0')throw new Error('broker_storage_header');
    if(header[18]===2&&header[19]===2)return WAL_STORAGE_MODE;
    if(header[18]===1&&header[19]===1)return 'delete';
    throw new Error('broker_storage_header');
  } finally {closeSync(fd);}
}
export function configureWalConnection(db) {
  assertBrokerDatabaseUsable(db);
  assertWalRuntime();
  if(Object.values(db.prepare('PRAGMA journal_mode').get())[0]!=='wal')throw new Error('broker_storage_mode');
  db.exec('PRAGMA synchronous=FULL; PRAGMA journal_size_limit=4194304; PRAGMA wal_autocheckpoint=1000');
  for(const [pragma,expected] of [['synchronous',2],['journal_size_limit',4194304],['wal_autocheckpoint',1000]]) {
    if(Object.values(db.prepare('PRAGMA '+pragma).get())[0]!==expected)throw new Error('broker_storage_configuration');
  }
  configuredWalConnections.add(db);
}
export function beginBrokerWriteTransaction(db,{waitForWriter=false}={}) {
  assertBrokerDatabaseUsable(db);
  if(typeof waitForWriter!=='boolean')throw new Error('broker_storage_write_policy');
  // Preserve the original default and nested-BEGIN behavior. Never take
  // cleanup ownership of a transaction that existed before this call.
  if(!waitForWriter || db.isTransaction) {
    db.exec('BEGIN IMMEDIATE');
    return;
  }
  const scalar=pragma=>Object.values(db.prepare('PRAGMA '+pragma).get())[0];
  if(!configuredWalConnections.has(db)) {
    if(scalar('journal_mode')==='wal')throw new Error('broker_storage_write_policy');
    db.exec('BEGIN IMMEDIATE');
    return;
  }
  if(scalar('journal_mode')!=='wal'||scalar('busy_timeout')!==0)throw new Error('broker_storage_write_policy');
  const errors=[];
  try {
    db.exec('PRAGMA busy_timeout='+BROKER_WAL_WRITE_WAIT_MS);
    if(scalar('busy_timeout')!==BROKER_WAL_WRITE_WAIT_MS)throw new Error('broker_storage_write_policy');
    db.exec('BEGIN IMMEDIATE');
  } catch(error) { errors.push(error); }
  // No callback, statement or COMMIT inherits the acquisition wait policy.
  let restored=false;
  try {
    db.exec('PRAGMA busy_timeout=0');
    if(scalar('busy_timeout')!==0)throw new Error('broker_storage_write_policy');
    restored=true;
  } catch(error) {
    errors.push(error);
    // An after-apply error need not discard a healthy handle, but an unknown
    // or nonzero policy must never reach a later default NOWAIT operation.
    try { restored=scalar('busy_timeout')===0; }
    catch(readbackError) { errors.push(readbackError); }
  }
  if(!errors.length)return;
  let discard=!restored;
  if(discard) {
    quarantinedConnections.add(db);
    configuredWalConnections.delete(db);
  }
  // The connection was outside a transaction on entry and this synchronous
  // owner is the only code that could have started one in the meantime.
  try { if(db.isTransaction)db.exec('ROLLBACK'); }
  catch(error) { errors.push(error);discard=true; }
  if(discard) {
    quarantinedConnections.add(db);
    configuredWalConnections.delete(db);
    try { if(db.isOpen)db.close(); }
    catch(error) { errors.push(error); }
  }
  if(errors.length===1)throw errors[0];
  throw new AggregateError(errors,'broker_storage_write_cleanup_failed',{cause:errors[0]});
}
export function openBrokerDatabase(dbPath,{storageMode,protectedStorage=false}={}) {
  if(storageMode!==undefined&&storageMode!==WAL_STORAGE_MODE)throw new Error('broker_storage_mode');
  if(storageMode===WAL_STORAGE_MODE) {
    assertWalRuntime();
    if(protectedStorage)throw new Error('broker_storage_mode');
  }
  if(dbPath===':memory:') {
    if(storageMode!==undefined)throw new Error('broker_storage_mode');
    return new DatabaseSync(dbPath);
  }
  const path=profilePath(dbPath),lock=path+'.storage-lock',statePath=path+'.storage.json';
  if(existsSync(lock))throw new Error('broker_storage_transition_pending');
  const mode=headerMode(path,{allowEmpty:storageMode===undefined&&!existsSync(statePath)}),identity=existsSync(path)?fileIdentity(path):null;
  const state=existsSync(statePath)?readProfileJson(statePath):null;
  if(state && (state.schema!=='broker-storage-state/v1'||state.phase!=='committed'||!sameIdentity(identity,state.identity)))throw new Error('broker_storage_identity');
  if(state&&state.mode!==mode)throw new Error('broker_storage_mode');
  if(mode===WAL_STORAGE_MODE) {
    if(storageMode!==mode||!state)throw new Error('broker_storage_mode');
    assertWalRuntime();
  } else if(storageMode!==undefined)throw new Error('broker_storage_mode');
  const db=new DatabaseSync(path);
  try {
    const openedIdentity=fileIdentity(path);
    if(identity&&!sameIdentity(identity,openedIdentity))throw new Error('broker_storage_identity');
    if(headerMode(path,{allowEmpty:mode==='delete'&&!state})!==mode)throw new Error('broker_storage_mode');
    if(mode===WAL_STORAGE_MODE)configureWalConnection(db);
    return db;
  } catch(error) {db.close();throw error;}
}
