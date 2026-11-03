import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, fstatSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { assertWalRuntime, configureWalConnection, fileIdentity, headerMode, profilePath, readProfileJson, sameIdentity, WAL_STORAGE_MODE } from './sqlite-profile.js';

const scalar=(db,sql)=>Object.values(db.prepare(sql).get())[0];
const quoted=name=>'"'+name.replaceAll('"','""')+'"';
function syncDirectory(path) {
  // Node cannot FlushFileBuffers on a directory on Windows. No hardware-power
  // guarantee is claimed there; missing/invalid receipts fail closed on open.
  if(process.platform==='win32')return;
  const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}
function ownedDirectory(path,{create=false}={}) {
  if(create&&!existsSync(path)){mkdirSync(path,{mode:0o700});syncDirectory(dirname(path));}
  const s=lstatSync(path);
  if(!s.isDirectory()||s.isSymbolicLink())throw new Error('broker_storage_alias');
}
function writeJson(path,data) {
  const bytes=Buffer.from(JSON.stringify(data)),exists=existsSync(path);
  const identity=exists?fileIdentity(path):null;
  const fd=openSync(path,exists?'r+':'wx',0o600);
  try {const info=fstatSync(fd,{bigint:true});if(!info.isFile()||info.nlink!==1n||(identity&&!sameIdentity(identity,{dev:String(info.dev),ino:String(info.ino)}))||!sameIdentity(fileIdentity(path),{dev:String(info.dev),ino:String(info.ino)}))throw new Error('broker_storage_identity');let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at,at);if(n<=0)throw new Error('broker_storage_write');at+=n;}ftruncateSync(fd,bytes.length);fsyncSync(fd);}
  finally{closeSync(fd);}
  syncDirectory(dirname(path));
}
function hashFile(path) {
  const identity=fileIdentity(path);const fd=openSync(path,'r'),buffer=Buffer.allocUnsafe(1048576),hash=createHash('sha256');
  try{const opened=fstatSync(fd,{bigint:true});if(!sameIdentity(identity,{dev:String(opened.dev),ino:String(opened.ino)}))throw new Error('broker_storage_identity');let n;while((n=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));return hash.digest('hex');}
  finally{closeSync(fd);}
}
function syncFile(path){const fd=openSync(path,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}}
export function brokerStorageDigest(db) {
  const hash=createHash('sha256'),schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  hash.update(JSON.stringify(schema));hash.update(String(scalar(db,'PRAGMA user_version')));
  for(const table of schema.filter(row=>row.type==='table')) {
    const columns=db.prepare('PRAGMA table_info('+quoted(table.name)+')').all().map(row=>quoted(row.name));
    const statement=db.prepare('SELECT * FROM '+quoted(table.name)+(columns.length?' ORDER BY '+columns.join(','):''));
    statement.setReadBigInts(true);
    for(const row of statement.iterate()) {
      hash.update(JSON.stringify(row,(_,value)=>typeof value==='bigint'?{$integer:String(value)}:value instanceof Uint8Array?{$blob:Buffer.from(value).toString('base64')}:value));hash.update('\0');
    }
  }
  return hash.digest('hex');
}
function acquireSqlite(path) {
  const db=new DatabaseSync(path);
  try {
    db.exec('PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
    if(db.isTransaction)throw new Error('broker_storage_transaction');
    // EXCLUSIVE holds its file locks after COMMIT; backup must run OUTSIDE a
    // write transaction. Closing is the only release during this owner scope.
    return db;
  }catch(error){db.close();throw error;}
}
function finish(path,lock,receipt,mode) {
  if(!sameIdentity(receipt.identity,fileIdentity(path)))throw new Error('broker_storage_identity');
  const state={schema:'broker-storage-state/v1',phase:'committed',identity:receipt.identity,mode,transitionId:receipt.transitionId,backupSha256:receipt.backupSha256??null};
  writeJson(path+'.storage.json',state);
  writeJson(join(lock,'receipt.json'),{...receipt,phase:'committed',mode});
  return state;
}
function release(lock,transitionId) {
  const receipt=readProfileJson(join(lock,'receipt.json'));
  if(receipt.transitionId!==transitionId)throw new Error('broker_storage_owner');
  unlinkSync(join(lock,'receipt.json'));rmdirSync(lock);syncDirectory(dirname(lock));
}
export async function transitionBrokerStorage({dbPath,targetMode,onPhase=async()=>{}}) {
  assertWalRuntime();
  if(!['delete',WAL_STORAGE_MODE].includes(targetMode))throw new Error('broker_storage_mode');
  const path=profilePath(dbPath),identity=fileIdentity(path),lock=path+'.storage-lock',transitionId=randomUUID();
  const previousMode=headerMode(path);
  if(existsSync(path+'.storage.json')) {
    const state=readProfileJson(path+'.storage.json');
    if(state.schema!=='broker-storage-state/v1'||state.phase!=='committed'||!sameIdentity(identity,state.identity)||state.mode!==previousMode)throw new Error('broker_storage_identity');
  }
  if(existsSync(lock))throw new Error('broker_storage_transition_pending');
  let lockCreated=false;
  let receipt={schema:'broker-storage-transition/v1',transitionId,identity,previousMode,targetMode,phase:'allocated'},db,prepared=false;
  try {
    mkdirSync(lock,{mode:0o700});lockCreated=true;
    writeJson(join(lock,'receipt.json'),receipt);syncDirectory(dirname(lock));
    db=acquireSqlite(path);
    if(!sameIdentity(identity,fileIdentity(path)))throw new Error('broker_storage_identity');
    if(scalar(db,'PRAGMA integrity_check')!=='ok')throw new Error('broker_storage_integrity');
    const contentDigest=brokerStorageDigest(db),backupRoot=path+'.storage-backups';
    ownedDirectory(backupRoot,{create:true});const backupDir=join(backupRoot,transitionId);ownedDirectory(backupDir,{create:true});
    const backupPath=join(backupDir,'database.sqlite');
    await backup(db,backupPath);syncFile(backupPath);syncDirectory(backupDir);
    const backupDb=new DatabaseSync(backupPath,{readOnly:true});
    try{if(scalar(backupDb,'PRAGMA integrity_check')!=='ok'||brokerStorageDigest(backupDb)!==contentDigest)throw new Error('broker_storage_backup');}finally{backupDb.close();}
    receipt={...receipt,phase:'prepared',contentDigest,backupSha256:hashFile(backupPath)};
    writeJson(join(lock,'receipt.json'),receipt);prepared=true;await onPhase('prepared');
    if(targetMode==='delete'&&scalar(db,'PRAGMA journal_mode')==='wal') {
      if(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy!==0)throw new Error('broker_storage_checkpoint_busy');
    }
    if(scalar(db,'PRAGMA journal_mode='+(targetMode==='delete'?'DELETE':'WAL'))!==(targetMode==='delete'?'delete':'wal'))throw new Error('broker_storage_mode');
    if(targetMode===WAL_STORAGE_MODE)configureWalConnection(db);
    if(brokerStorageDigest(db)!==contentDigest||scalar(db,'PRAGMA integrity_check')!=='ok')throw new Error('broker_storage_integrity');
    await onPhase('changed');
    const state=finish(path,lock,receipt,targetMode);await onPhase('committed');
    db.close();db=null;
    if(headerMode(path)!==targetMode)throw new Error('broker_storage_mode');
    release(lock,transitionId);
    return {...state,backupPath,backupSha256:receipt.backupSha256};
  } catch(error) {
    if(db){db.close();db=null;}
    // Prior to prepared no mode-changing statement has executed. A caught
    // preflight/backup failure can release its own lock; crashes retain it.
    if(lockCreated&&!prepared){
      if(existsSync(join(lock,'receipt.json')))release(lock,transitionId);
      else if(readdirSync(lock).length===0){rmdirSync(lock);syncDirectory(dirname(lock));}
    }
    throw error;
  } finally {db?.close();}
}
export async function recoverBrokerStorage({dbPath}) {
  assertWalRuntime();
  const path=profilePath(dbPath),lock=path+'.storage-lock';ownedDirectory(lock);
  if(!existsSync(join(lock,'receipt.json'))) {
    if(readdirSync(lock).length!==0)throw new Error('broker_storage_recovery');
    const db=acquireSqlite(path);
    try {
      const mode=scalar(db,'PRAGMA journal_mode')==='wal'?WAL_STORAGE_MODE:'delete';
      const identity=fileIdentity(path),state=existsSync(path+'.storage.json')?readProfileJson(path+'.storage.json'):null;
      if((mode===WAL_STORAGE_MODE&&!state)||(state&&(state.schema!=='broker-storage-state/v1'||state.phase!=='committed'||state.mode!==mode||!sameIdentity(state.identity,identity))))throw new Error('broker_storage_recovery');
      if(scalar(db,'PRAGMA integrity_check')!=='ok')throw new Error('broker_storage_integrity');
      // No receipt means the protocol has not reached any mode-changing SQL.
      // Only an explicit recovery may abandon this empty allocation.
      rmdirSync(lock);syncDirectory(dirname(lock));return {schema:'broker-storage-state/v1',phase:'committed',identity,mode};
    }finally{db.close();}
  }
  const receipt=readProfileJson(join(lock,'receipt.json'));
  if(receipt.schema!=='broker-storage-transition/v1'||!/^[a-f0-9-]{36}$/.test(receipt.transitionId)||!sameIdentity(receipt.identity,fileIdentity(path))||!['delete',WAL_STORAGE_MODE].includes(receipt.previousMode)||!['delete',WAL_STORAGE_MODE].includes(receipt.targetMode))throw new Error('broker_storage_identity');
  const db=acquireSqlite(path);
  try {
    const actual=scalar(db,'PRAGMA journal_mode')==='wal'?WAL_STORAGE_MODE:'delete';
    if(![receipt.previousMode,receipt.targetMode].includes(actual))throw new Error('broker_storage_mode');
    if(receipt.phase==='allocated') {
      if(actual!==receipt.previousMode)throw new Error('broker_storage_recovery');
    } else {
      if(!['prepared','committed'].includes(receipt.phase))throw new Error('broker_storage_recovery');
      const root=path+'.storage-backups';ownedDirectory(root);const dir=join(root,receipt.transitionId);ownedDirectory(dir);
      const backupPath=join(dir,'database.sqlite');
      if(hashFile(backupPath)!==receipt.backupSha256||brokerStorageDigest(db)!==receipt.contentDigest)throw new Error('broker_storage_recovery');
    }
    if(scalar(db,'PRAGMA integrity_check')!=='ok')throw new Error('broker_storage_integrity');
    if(actual===WAL_STORAGE_MODE){configureWalConnection(db);if(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy!==0)throw new Error('broker_storage_checkpoint_busy');}
    const state=finish(path,lock,receipt,actual);db.close();release(lock,receipt.transitionId);return state;
  } finally {if(db.isOpen)db.close();}
}
