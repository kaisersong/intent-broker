import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRoomStore } from '../../src/room/store.js';
import { createBrokerService } from '../../src/broker/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';
const scalar=(db,sql)=>Object.values(db.prepare(sql).get())[0];
test('broker owns and closes both connections idempotently',()=>{
 const path=createTempDbPath(),connections=new Set(),original=DatabaseSync.prototype.prepare;
 let broker;
 try {
  DatabaseSync.prototype.prepare=function(...args){connections.add(this);return original.apply(this,args);};
  broker=createBrokerService({dbPath:path});
 }finally{DatabaseSync.prototype.prepare=original;}
 assert.equal(connections.size,2);assert.ok([...connections].every(db=>db.isOpen));
 broker.close();broker.close();assert.ok([...connections].every(db=>!db.isOpen));
 const db=new DatabaseSync(path);try{db.exec('BEGIN EXCLUSIVE; CREATE TABLE after_close (id); COMMIT');}finally{db.close();}
});

test('killed writer preserves committed audit and rolls back incomplete write',async t=>{
 const path=createTempDbPath(),moduleUrl=new URL('../../src/room/store.js',import.meta.url).href;
 const source=`import {createRoomStore} from ${JSON.stringify(moduleUrl)};
 const s=createRoomStore({dbPath:${JSON.stringify(path)}});s.migrate();
 s.recordRoomHistoryReadAudit({roomId:'crash',actorParticipantId:'reader',resultCount:1,now:Date.now()});
 s.db.exec('CREATE TABLE crash_probe (value); BEGIN IMMEDIATE; INSERT INTO crash_probe VALUES (42)');
 process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--experimental-sqlite','--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 let stderr='';child.stderr.on('data',b=>stderr+=b);const exited=once(child,'exit');
 await Promise.race([once(child.stdout,'data'),exited.then(()=>{throw new Error(stderr||'writer exited early');}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('writer readiness timeout')),10000);timer.unref();})]);
 child.kill('SIGKILL');await exited;
 const restored=createRoomStore({dbPath:path});t.after(()=>restored.close());
 assert.equal(restored.listRoomHistoryReadAudits('crash').length,1);
 assert.equal(scalar(restored.db,'SELECT count(*) FROM crash_probe'),0);
 assert.equal(scalar(restored.db,'PRAGMA integrity_check'),'ok');
});


test('room initialization failure closes both broker-owned connections',()=>{
 const connections=new Set(),original=DatabaseSync.prototype.exec;
 let injected=false;
 try {
  DatabaseSync.prototype.exec=function(sql){
   connections.add(this);
   if(sql.includes('CREATE TABLE IF NOT EXISTS rooms')){injected=true;throw new Error('room_init_probe');}
   return original.call(this,sql);
  };
  assert.throws(()=>createBrokerService({dbPath:createTempDbPath()}),/room_init_probe/);
 }finally{DatabaseSync.prototype.exec=original;}
 assert.equal(injected,true);assert.equal(connections.size,2);
 assert.ok([...connections].every(db=>!db.isOpen));
});
