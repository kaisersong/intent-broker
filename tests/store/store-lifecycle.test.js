import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRoomStore } from '../../src/room/store.js';
import { createBrokerService } from '../../src/broker/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';
const scalar=(db,sql)=>Object.values(db.prepare(sql).get())[0];
test('broker owns and closes both connections idempotently',()=>{
 const source="import assert from 'node:assert/strict';\nimport {DatabaseSync}from'node:sqlite';\nconst isOpen=db=>{try{db.prepare('SELECT 1').get();return true;}catch(error){if(error.code==='ERR_INVALID_STATE')return false;throw error;}};\nimport {createTempDbPath}from PLACEHOLDER_TEMP;\n const path=createTempDbPath(),connections=new Set(),original=DatabaseSync.prototype.prepare;\n let broker;\n try {\n  DatabaseSync.prototype.prepare=({prepare(...args){connections.add(this);return original.apply(this,args);}}).prepare;\n  const {createBrokerService}=await import(\"PLACEHOLDER_SERVICE\");\n  broker=createBrokerService({dbPath:path});\n assert.equal(connections.size,2);assert.ok([...connections].every(db=>isOpen(db)));\n broker.close();broker.close();assert.ok([...connections].every(db=>!isOpen(db)));\n }finally{DatabaseSync.prototype.prepare=original;}\n const db=new DatabaseSync(path);try{db.exec('BEGIN EXCLUSIVE; CREATE TABLE after_close (id); COMMIT');}finally{db.close();}\n".replace('PLACEHOLDER_TEMP',JSON.stringify(new URL('../fixtures/temp-dir.js',import.meta.url).href)).replace('PLACEHOLDER_SERVICE',new URL('../../src/broker/service.js',import.meta.url).href);
 const result=spawnSync(process.execPath,['--import',new URL('../fixtures/source-account-preload.mjs',import.meta.url).href,'--input-type=module','-e',source],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
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
 const source="import assert from 'node:assert/strict';\nimport {DatabaseSync}from'node:sqlite';\nconst isOpen=db=>{try{db.prepare('SELECT 1').get();return true;}catch(error){if(error.code==='ERR_INVALID_STATE')return false;throw error;}};\nimport {createTempDbPath}from PLACEHOLDER_TEMP;\n const path=createTempDbPath();\n const connections=new Set(),original=DatabaseSync.prototype.exec;\n let injected=false;\n try {\n  DatabaseSync.prototype.exec=({exec(sql){\n   connections.add(this);\n   if(sql.includes('CREATE TABLE IF NOT EXISTS rooms')){injected=true;throw new Error('room_init_probe');}\n   return original.call(this,sql);\n  }}).exec;\n  const {createBrokerService}=await import(\"PLACEHOLDER_SERVICE\");\n  assert.throws(()=>createBrokerService({dbPath:path}),/room_init_probe/);\n }finally{DatabaseSync.prototype.exec=original;}\n assert.equal(injected,true);assert.equal(connections.size,2);\n assert.ok([...connections].every(db=>!isOpen(db)));\n".replace('PLACEHOLDER_TEMP',JSON.stringify(new URL('../fixtures/temp-dir.js',import.meta.url).href)).replace('PLACEHOLDER_SERVICE',new URL('../../src/broker/service.js',import.meta.url).href);
 const result=spawnSync(process.execPath,['--import',new URL('../fixtures/source-account-preload.mjs',import.meta.url).href,'--input-type=module','-e',source],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});

