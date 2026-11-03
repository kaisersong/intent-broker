import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, linkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRoomStore } from '../../src/room/store.js';
import { createEventStore } from '../../src/store/event-store.js';
import { transitionBrokerStorage, recoverBrokerStorage } from '../../src/store/sqlite-profile-migration.js';
import { isSupportedWalRuntime, openBrokerDatabase } from '../../src/store/sqlite-profile.js';

const supported = isSupportedWalRuntime(process.versions);
const wal = { skip: !supported && 'requires qualified Node 24.19.0 / SQLite 3.53.3' };
const scalar = (db, sql) => Object.values(db.prepare(sql).get())[0];
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'broker-storage-')), handles=[];
 t.after(()=>{for(const db of handles)if(db.isOpen)db.close();rmSync(root,{recursive:true,force:true});});
 const path=join(root,'broker.db'), db=new DatabaseSync(path);db.exec("CREATE TABLE proof(id INTEGER PRIMARY KEY, value TEXT);INSERT INTO proof VALUES(1,'committed')");db.close();
 return {root,path,own(db){handles.push(db);return db;}};
}
test('WAL policy rejects unqualified runtimes and options before changing a DB', t=>{
 assert.equal(isSupportedWalRuntime({node:'22.22.1',sqlite:'3.51.2'}),false);
 assert.equal(isSupportedWalRuntime({node:'24.19.0',sqlite:'3.53.3'}),true);
 const {path}=fixture(t), before=readFileSync(path);
 assert.throws(()=>openBrokerDatabase(path,{storageMode:'persist'}),/storage_mode/);
 if(!supported)assert.throws(()=>openBrokerDatabase(path,{storageMode:'wal-full-v1'}),/storage_runtime/);
 assert.deepEqual(readFileSync(path),before);
});
test('explicit migration protects a consistent backup and both real store connections use FULL',wal,async t=>{
 const {path,own}=fixture(t);
 const migrated=await transitionBrokerStorage({dbPath:path,targetMode:'wal-full-v1'});
 assert.equal(migrated.mode,'wal-full-v1');assert.match(migrated.backupSha256,/^[a-f0-9]{64}$/);
 const a=own(openBrokerDatabase(path,{storageMode:'wal-full-v1'}));
 const b=own(openBrokerDatabase(path,{storageMode:'wal-full-v1'}));
 for(const db of [a,b]){assert.equal(scalar(db,'PRAGMA journal_mode'),'wal');assert.equal(scalar(db,'PRAGMA synchronous'),2);}
 a.prepare("INSERT INTO proof VALUES(2,'new commit')").run();
 assert.equal(scalar(b,'SELECT count(*) FROM proof'),2);
 assert.throws(()=>openBrokerDatabase(path),/storage_mode/);
 assert.throws(()=>createRoomStore({dbPath:path,storageMode:'wal-full-v1',storageBudget:{databaseBytes:1048576}}),/storage_mode/);
 a.close();b.close();
 const room=createRoomStore({dbPath:path,storageMode:'wal-full-v1'}),events=createEventStore({dbPath:path,storageMode:'wal-full-v1'});
 try{room.migrate();room.recordRoomHistoryReadAudit({roomId:'room',actorParticipantId:'reader',resultCount:1,now:Date.now()});assert.equal(room.listRoomHistoryReadAudits('room').length,1);assert.equal(scalar(events.db ?? room.db,'PRAGMA synchronous'),2);}finally{events.close();room.close();}
 const backup=own(new DatabaseSync(migrated.backupPath,{readOnly:true}));
 assert.equal(scalar(backup,'SELECT count(*) FROM proof'),1);backup.close();
 const downgraded=await transitionBrokerStorage({dbPath:path,targetMode:'delete'});
 assert.equal(downgraded.mode,'delete');
 const legacy=own(openBrokerDatabase(path));assert.equal(scalar(legacy,'PRAGMA journal_mode'),'delete');assert.equal(scalar(legacy,'SELECT count(*) FROM proof'),2);assert.equal(scalar(legacy,'PRAGMA integrity_check'),'ok');
});
test('actual external writer blocks migration without changing the journal mode or discarding rows',wal,async t=>{
 const {path,own}=fixture(t), writer=own(new DatabaseSync(path));writer.exec("BEGIN IMMEDIATE;INSERT INTO proof VALUES(2,'uncommitted')");
 await assert.rejects(transitionBrokerStorage({dbPath:path,targetMode:'wal-full-v1'}),/locked|busy/i);
 writer.exec('ROLLBACK');assert.equal(scalar(writer,'PRAGMA journal_mode'),'delete');assert.equal(scalar(writer,'SELECT count(*) FROM proof'),1);
 assert.equal(existsSync(path+'.storage-lock'),false);
});
for(const phase of ['prepared','changed'])test('SIGKILL at '+phase+' is fail closed and explicit recovery preserves all committed data',wal,async t=>{
 const {path,own}=fixture(t), url=new URL('../../src/store/sqlite-profile-migration.js',import.meta.url).href;
 const source="import {transitionBrokerStorage} from "+JSON.stringify(url)+";await transitionBrokerStorage({dbPath:"+JSON.stringify(path)+",targetMode:'wal-full-v1',onPhase:async phase=>{if(phase==="+JSON.stringify(phase)+"){process.stdout.write('ready\\n');await new Promise(()=>{});}}});";
 const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
 const exit=once(child,'exit');let timer;
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 try{await Promise.race([once(child.stdout,'data'),exit.then(()=>{throw Error('migration_exited_early');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('migration_timeout')),10000);})]);child.kill('SIGKILL');await exit;}finally{clearTimeout(timer);}
 assert.throws(()=>openBrokerDatabase(path,{storageMode:'wal-full-v1'}),/storage_transition/);
 const recovered=await recoverBrokerStorage({dbPath:path});assert.equal(recovered.mode,phase==='prepared'?'delete':'wal-full-v1');
 const db=own(openBrokerDatabase(path,{storageMode:recovered.mode==='delete'?undefined:'wal-full-v1'}));
 assert.equal(scalar(db,'SELECT count(*) FROM proof'),1);assert.equal(scalar(db,'PRAGMA integrity_check'),'ok');
});
test('changed or aliased profile state is rejected instead of guessed',wal,async t=>{
 const {path,root}=fixture(t);await transitionBrokerStorage({dbPath:path,targetMode:'wal-full-v1'});
 const statePath=path+'.storage.json',text=readFileSync(statePath,'utf8'),state=JSON.parse(text);
 state.identity.ino='wrong';writeFileSync(statePath,JSON.stringify(state));assert.throws(()=>openBrokerDatabase(path,{storageMode:'wal-full-v1'}),/storage_identity/);
 writeFileSync(statePath,text);rmSync(statePath);const target=join(root,'aliased.json');writeFileSync(target,text);
 if(process.platform==='win32')linkSync(target,statePath);else symlinkSync(target,statePath);assert.throws(()=>openBrokerDatabase(path,{storageMode:'wal-full-v1'}),/storage_alias/);
});
test('a truncated managed database is rejected before SQLite can initialize it',wal,async t=>{
 const {path}=fixture(t);await transitionBrokerStorage({dbPath:path,targetMode:'wal-full-v1'});writeFileSync(path,'');assert.throws(()=>openBrokerDatabase(path,{storageMode:'wal-full-v1'}),/storage_header/);assert.equal(readFileSync(path).length,0);
});
test('explicit recovery abandons only an empty pre-receipt allocation',wal,async t=>{
 const {path}=fixture(t);
 const {mkdirSync}=await import('node:fs');mkdirSync(path+'.storage-lock');
 assert.throws(()=>openBrokerDatabase(path),/storage_transition/);
 assert.equal((await recoverBrokerStorage({dbPath:path})).mode,'delete');
 assert.equal(existsSync(path+'.storage-lock'),false);
});
test('a real WAL reader blocks downgrade and no hot WAL is discarded',wal,async t=>{
 const {path,own}=fixture(t);await transitionBrokerStorage({dbPath:path,targetMode:'wal-full-v1'});
 const reader=own(openBrokerDatabase(path,{storageMode:'wal-full-v1'}));
 reader.exec('BEGIN');reader.prepare('SELECT * FROM proof').all();
 await assert.rejects(transitionBrokerStorage({dbPath:path,targetMode:'delete'}),/busy|locked/i);
 reader.exec('ROLLBACK');reader.close();
 if(existsSync(path+'.storage-lock'))await recoverBrokerStorage({dbPath:path});
 const db=own(openBrokerDatabase(path,{storageMode:'wal-full-v1'}));
 assert.equal(scalar(db,'SELECT count(*) FROM proof'),1);assert.equal(scalar(db,'PRAGMA integrity_check'),'ok');
});
test('actual CLI selects only its explicit database and does not start broker or heartbeat',wal,async t=>{
 const {path,root,own}=fixture(t),{spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url');
 const heartbeat=join(root,'must-not-start.json'),result=spawnSync(process.execPath,[fileURLToPath(new URL('../../src/cli.js',import.meta.url)),'storage','migrate','--db',path,'--mode','wal-full-v1'],{encoding:'utf8',timeout:15000,env:{...process.env,INTENT_BROKER_DB:join(root,'not-selected.db'),INTENT_BROKER_HEARTBEAT_PATH:heartbeat,PORT:'invalid'}});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).mode,'wal-full-v1');
 assert.equal(existsSync(heartbeat),false);assert.equal(existsSync(join(root,'not-selected.db')),false);
 const db=own(openBrokerDatabase(path,{storageMode:'wal-full-v1'}));assert.equal(scalar(db,'SELECT count(*) FROM proof'),1);
});
test('an aliased transition directory is never followed by recovery',wal,async t=>{
 const {path,root}=fixture(t),{mkdirSync}=await import('node:fs'),outside=join(root,'outside');mkdirSync(outside);
 symlinkSync(outside,path+'.storage-lock',process.platform==='win32'?'junction':'dir');
 assert.throws(()=>openBrokerDatabase(path,{storageMode:'wal-full-v1'}),/storage_transition/);
 await assert.rejects(recoverBrokerStorage({dbPath:path}),/storage_alias/);
});
