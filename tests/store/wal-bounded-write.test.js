import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import * as policy from '../../src/store/sqlite-profile.js';
import {transitionBrokerStorage} from '../../src/store/sqlite-profile-migration.js';
import {createRoomStore} from '../../src/room/store.js';
import {createRoomService} from '../../src/room/service.js';
const wal={skip:!policy.isSupportedWalRuntime()&&'requires qualified Node24/SQLite3.53'};
const scalar=(db,p)=>Object.values(db.prepare('PRAGMA '+p).get())[0];
function assertOutsideTransaction(db){if(typeof db.isTransaction==='boolean')assert.equal(db.isTransaction,false);db.exec('BEGIN');db.exec('ROLLBACK');}
async function fixture(t,{mode='wal-full-v1'}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'intent-broker-wal-lock-'))),path=join(root,'broker.db'),holders=[];
 let store=createRoomStore({dbPath:path});store.migrate();
 const ctx={sessionId:'synthetic',requestSource:'user',actor:{kind:'user',userId:'user.local'},issuedAt:new Date().toISOString(),hostPrincipal:'synthetic-install'};
 let service=createRoomService({store});
 const roomId=service.createRoom({title:'before',memberAgentIds:['a']},ctx).room.roomId;
 const host=service.workspace.registerHost({startupId:'synthetic-boot'},ctx).host;ctx.hostIncarnation=host.hostIncarnation;
 const source=service.sendRoomMessage({roomId,text:'synthetic',mentions:[{kind:'agent',logicalAgentId:'a'}],responsePolicy:'mentioned',idempotencyKey:'synthetic-source'},ctx).message;
 store.close();
 if(mode==='wal-full-v1')await transitionBrokerStorage({dbPath:path,targetMode:mode});
 store=createRoomStore({dbPath:path,...(mode==='wal-full-v1'?{storageMode:mode}:{})});store.migrate();service=createRoomService({store});
 t.after(async()=>{
  try{const settled=await Promise.allSettled(holders.map(h=>h.stop()));const failures=settled.filter(x=>x.status==='rejected').map(x=>x.reason);if(failures.length)throw new AggregateError(failures,'holder_cleanup_failed');}
  finally{if(store.db.isOpen){if(store.db.isTransaction)store.db.exec('ROLLBACK');store.close();}rmSync(root,{recursive:true,force:true});}
 });
 async function hold({mutation='none',release='manual'}={}){
  const attemptFile=join(root,'attempt'),child=fork(fileURLToPath(new URL('../fixtures/wal-lock-holder.js',import.meta.url)),[JSON.stringify({root,dbPath:path,roomId,roomMessageId:source.messageId,mutation,release,attemptFile})],{execPath:process.execPath,execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
  const exit=once(child,'exit'),closed=once(child,'close');child.on('error',()=>{});
  let committedResolve,commitSeen=false;
  const committed=new Promise(r=>{committedResolve=r;});
  child.on('message',m=>{if(m?.kind==='committed'){commitSeen=true;committedResolve(m);}});
  const holder={get committed(){let timer;return Promise.race([committed,closed.then(()=>{if(commitSeen)return {kind:'committed'};throw Error('holder_closed_without_commit');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('holder_commit_timeout')),5000);})]).finally(()=>clearTimeout(timer));},async stop(){
   if(child.exitCode===null&&child.signalCode===null){if(child.connected)child.send({kind:'stop'},()=>{});let timer;try{await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('holder_cleanup_timeout')),3000);})]);}catch(error){child.kill('SIGKILL');await exit;throw error;}finally{clearTimeout(timer);}}
   const [code,signal]=await exit;assert.equal(code,0);assert.equal(signal,null);
  }};
  holders.push(holder);
  let timer;try{const [m]=await Promise.race([once(child,'message'),exit.then(()=>{throw Error('holder_exited_early');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('holder_ready_timeout')),5000);})]);assert.equal(m.kind,'locked');}finally{clearTimeout(timer);}
  holder.markAttempt=()=>writeFileSync(attemptFile,'attempt',{flag:'wx',mode:0o600});
  return holder;
 }
 return {root,path,store,service,ctx,roomId,source,hold};
}
function duringBegin(db,mark,fn){
 const original=db.exec;let marked=false;
 db.exec=function(sql){if(!marked&&/^\s*BEGIN IMMEDIATE\s*;?\s*$/.test(sql)){marked=true;mark();}return Reflect.apply(original,this,[sql]);};
 try{return fn();}finally{db.exec=original;}
}
test('bounded WAL BEGIN sees a real child commit and restores NOWAIT before caller reads',wal,async t=>{
 const f=await fixture(t),h=await f.hold({mutation:'revision',release:'attempt-file'});
 duringBegin(f.store.db,()=>h.markAttempt(),()=>policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true}));
 assert.equal(f.store.db.isTransaction,true);assert.equal(scalar(f.store.db,'busy_timeout'),0);
 assert.equal(f.store.getRoomRow(f.roomId).revision,2);f.store.db.exec('COMMIT');await h.committed;
});
test('held WAL lock exhausts once without callback/write/transaction and restores timeout; default stays NOWAIT',wal,async t=>{
 const f=await fixture(t),h=await f.hold();let calls=0;
 assert.throws(()=>f.store.withTransaction(()=>{calls++;},{waitForWriter:true}),e=>e.errcode===5);
 assert.equal(calls,0);assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);
 assert.throws(()=>policy.beginBrokerWriteTransaction(f.store.db),e=>e.errcode===5);
 await h.stop();assert.equal(f.store.withTransaction(()=>{calls++;return 7;},{waitForWriter:true}),7);assert.equal(calls,1);
});
test('standalone WAL updateRoom reads after acquisition and keeps concurrent field changes',wal,async t=>{
 const f=await fixture(t),h=await f.hold({mutation:'revision',release:'attempt-file'});
 const updated=duringBegin(f.store.db,()=>h.markAttempt(),()=>f.store.updateRoom(f.roomId,{title:'after'}));
 assert.equal(updated.revision,2);assert.equal(updated.title,'after');assert.equal(f.store.db.isTransaction,false);await h.committed;
 assert.equal(f.store.getRoomRow(f.roomId).revision,2);
});
test('workspace claim rechecks actual membership revoked while waiting and publishes no wake or delivery change',wal,async t=>{
 const f=await fixture(t),agent={...f.ctx,requestSource:'agent',actor:{kind:'agent',logicalAgentId:'a'},allowedLogicalAgentIds:['a']};
 const input={roomId:f.roomId,roomMessageId:f.source.messageId,logicalAgentId:'a',discussionOnly:true};
 assert.equal(f.service.workspace.authorizeWake(input,agent).ok,true);
 const h=await f.hold({mutation:'revokeMember',release:'attempt-file'});
 const result=duringBegin(f.store.db,()=>h.markAttempt(),()=>f.service.workspace.claimWake(input,agent));
 assert.equal(result.ok,false);assert.equal(result.code,'room_membership_required');await h.committed;
 assert.equal(f.store.getDelivery(f.source.messageId,'agent:a').wakeStatus,'pending');
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM room_workspace_records WHERE kind='wake'").get().n,0);
 assert.equal(scalar(f.store.db,'busy_timeout'),0);
});
test('nested caller transaction, including deferred contention/body failure, is never ended by updateRoom',wal,async t=>{
 const f=await fixture(t),h=await f.hold();f.store.db.exec('BEGIN');
 assert.throws(()=>f.store.updateRoom(f.roomId,{title:'must fail'}),e=>(e.errcode&255)===5);
 assert.equal(f.store.db.isTransaction,true);f.store.db.exec('ROLLBACK');await h.stop();
 f.store.db.exec("CREATE TEMP TRIGGER fail_synthetic_update AFTER UPDATE ON rooms BEGIN SELECT RAISE(ABORT,'synthetic_body_failure');END");
 f.store.db.exec('BEGIN IMMEDIATE');
 assert.throws(()=>f.store.updateRoom(f.roomId,{title:'still before'}),/synthetic_body_failure/);
 assert.equal(f.store.db.isTransaction,true);assert.equal(f.store.getRoomRow(f.roomId).title,'before');f.store.db.exec('ROLLBACK');
 assert.throws(()=>f.store.updateRoom(f.roomId,{title:'standalone fail'}),/synthetic_body_failure/);
 assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);
});
test('opt-in rejects changed mode/custom timeout and nested primitive leaves caller transaction intact',wal,async t=>{
 const f=await fixture(t);f.store.db.exec('PRAGMA busy_timeout=17');
 assert.throws(()=>policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true}),/broker_storage_write_policy/);
 assert.equal(scalar(f.store.db,'busy_timeout'),17);f.store.db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
 assert.throws(()=>policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true}));
 assert.equal(f.store.db.isTransaction,true);f.store.db.exec('ROLLBACK; PRAGMA journal_mode=DELETE');
 assert.throws(()=>policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true}),/broker_storage_write_policy/);
 assert.equal(f.store.db.isTransaction,false);
});
test('DELETE opt-in retains original NOWAIT and existing transaction ownership',wal,async t=>{
 const f=await fixture(t,{mode:'delete'}),h=await f.hold();
 assert.throws(()=>policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true}),e=>e.errcode===5);
 assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);await h.stop();
 policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true});assert.equal(f.store.db.isTransaction,true);f.store.db.exec('ROLLBACK');
});
test('writer-wait primitive and true opt-in call sites stay confined to reviewed production modules',()=>{
 const root=fileURLToPath(new URL('../../src/',import.meta.url)),uses=[],optIns=[];
 function scan(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isDirectory())scan(p);else if(entry.name.endsWith('.js')){const s=readFileSync(p,'utf8'),relative=p.slice(root.length).replaceAll('\\','/');if(/\bbeginBrokerWriteTransaction\b/.test(s))uses.push(relative);if(/\bwaitForWriter\s*:\s*true\b/.test(s))optIns.push(relative);}}}
 scan(root);assert.deepEqual(uses.sort(),['room/store.js','store/sqlite-profile.js']);assert.deepEqual(optIns.sort(),['room/service.js','room/store.js','room/workspace-service.js']);
});

test('callback and COMMIT failures roll back owned writes and preserve the original error object',wal,async t=>{
 const f=await fixture(t),callbackError=Error('synthetic_callback'),commitError=Error('synthetic_commit');
 assert.throws(()=>f.store.withTransaction(()=>{f.store.updateRoom(f.roomId,{revision:50});throw callbackError;},{waitForWriter:true}),e=>e===callbackError);
 assert.equal(f.store.getRoomRow(f.roomId).revision,1);assert.equal(f.store.db.isTransaction,false);
 const original=f.store.db.exec;
 f.store.db.exec=function(sql){if(/^COMMIT\s*;?\s*$/.test(sql))throw commitError;return Reflect.apply(original,this,[sql]);};
 try{assert.throws(()=>f.store.withTransaction(()=>f.store.updateRoom(f.roomId,{revision:60}),{waitForWriter:true}),e=>e===commitError);}
 finally{f.store.db.exec=original;}
 assert.equal(f.store.getRoomRow(f.roomId).revision,1);assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);
});
test('acquired BEGIN followed by timeout-restore failure rolls back only the new transaction before callback',wal,async t=>{
 const f=await fixture(t),restoreError=Error('synthetic_restore'),original=f.store.db.exec;let injected=false,calls=0;
 f.store.db.exec=function(sql){const result=Reflect.apply(original,this,[sql]);if(!injected&&/^PRAGMA busy_timeout\s*=\s*0\s*;?\s*$/.test(sql)){injected=true;throw restoreError;}return result;};
 try{assert.throws(()=>f.store.withTransaction(()=>{calls++;},{waitForWriter:true}),e=>e===restoreError);}
 finally{f.store.db.exec=original;}
 assert.equal(injected,true);assert.equal(calls,0);assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);
});
test('failed BEGIN plus timeout-restore failure retains native BUSY first in cleanup aggregate',wal,async t=>{
 const f=await fixture(t),h=await f.hold(),restoreError=Error('synthetic_restore'),original=f.store.db.exec;let injected=false;
 f.store.db.exec=function(sql){const result=Reflect.apply(original,this,[sql]);if(!injected&&/^PRAGMA busy_timeout\s*=\s*0\s*;?\s*$/.test(sql)){injected=true;throw restoreError;}return result;};
 try{assert.throws(()=>policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true}),e=>e instanceof AggregateError&&e.errors[0].errcode===5&&e.errors[1]===restoreError);}
 finally{f.store.db.exec=original;}
 assert.equal(injected,true);assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);await h.stop();
});
test('closed managed connection is never reopened and preserves native invalid-state failure',wal,async t=>{
 const f=await fixture(t);f.store.close();const before=readFileSync(f.path);
 assert.throws(()=>policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true}),e=>e.code==='ERR_INVALID_STATE');
 assert.equal(f.store.db.isOpen,false);assert.deepEqual(readFileSync(f.path),before);
});
test('unrestored acquisition policy closes the handle and invalidates pre-existing native statements',wal,async t=>{
 const f=await fixture(t),restoreError=Error('synthetic_before_restore'),original=f.store.db.exec;
 const cached=f.store.prepareStatement('SELECT title FROM rooms WHERE room_id=?');assert.equal(cached.get(f.roomId).title,'before');let calls=0;
 f.store.db.exec=function(sql){if(/^PRAGMA busy_timeout\s*=\s*0\s*;?\s*$/.test(sql))throw restoreError;return Reflect.apply(original,this,[sql]);};
 try{assert.throws(()=>f.store.withTransaction(()=>{calls++;},{waitForWriter:true}),e=>e===restoreError);}
 finally{f.store.db.exec=original;}
 assert.equal(calls,0);assert.equal(f.store.db.isOpen,false);
 assert.throws(()=>cached.get(f.roomId),e=>e.code==='ERR_INVALID_STATE');
});
test('failed close quarantines cached store reads, default transactions, schema, scoped page and reconfiguration before SQL',wal,async t=>{
 const f=await fixture(t),restoreError=Error('synthetic_before_restore'),closeError=Error('synthetic_close'),originalExec=f.store.db.exec,originalClose=f.store.db.close;
 f.store.getRoomRow(f.roomId);const order=[];let sqlCalls=0;
 f.store.db.exec=function(sql){if(/^PRAGMA busy_timeout\s*=\s*0\s*;?\s*$/.test(sql))throw restoreError;if(/^ROLLBACK$/.test(sql))order.push('rollback');return Reflect.apply(originalExec,this,[sql]);};
 f.store.db.close=function(){order.push('close');throw closeError;};
 try{
  assert.throws(()=>policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true}),e=>e instanceof AggregateError&&e.errors[0]===restoreError&&e.errors.at(-1)===closeError);
  assert.deepEqual(order,['rollback','close']);assert.equal(f.store.db.isOpen,true);
  f.store.db.exec=function(sql){sqlCalls++;return Reflect.apply(originalExec,this,[sql]);};
  for(const invoke of [
   ()=>f.store.getRoomRow(f.roomId),()=>f.store.updateRoom(f.roomId,{title:'forbidden'}),
   ()=>f.store.withTransaction(()=>assert.fail('must not invoke')),()=>f.store.migrate(),
   ()=>f.store.getSchemaVersion(),()=>f.store.listScopedMessagesPage(f.roomId,{kind:'room_only'}),
   ()=>policy.configureWalConnection(f.store.db),
  ])assert.throws(invoke,/broker_storage_write_policy/);
  assert.equal(sqlCalls,0);
 }finally{f.store.db.exec=originalExec;f.store.db.close=originalClose;}
});
test('unknown timeout readback quarantines and closes, retaining the original reset cause',wal,async t=>{
 const f=await fixture(t),resetError=Error('synthetic_reset'),readbackError=Error('synthetic_readback'),originalExec=f.store.db.exec,originalPrepare=f.store.db.prepare;let failedReset=false;
 f.store.db.exec=function(sql){if(/^PRAGMA busy_timeout\s*=\s*0\s*;?\s*$/.test(sql)){failedReset=true;throw resetError;}return Reflect.apply(originalExec,this,[sql]);};
 f.store.db.prepare=function(sql){if(failedReset&&/^PRAGMA busy_timeout$/.test(sql))throw readbackError;return Reflect.apply(originalPrepare,this,[sql]);};
 try{assert.throws(()=>policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true}),e=>e===resetError||e instanceof AggregateError&&e.errors[0]===resetError);}
 finally{f.store.db.exec=originalExec;f.store.db.prepare=originalPrepare;}
 assert.equal(f.store.db.isOpen,false);
});
test('BEGIN BUSY plus unrestored policy quarantines without attempting rollback of a nonexistent transaction',wal,async t=>{
 const f=await fixture(t),h=await f.hold(),restoreError=Error('synthetic_reset'),original=f.store.db.exec;let rollbacks=0;
 f.store.db.exec=function(sql){if(/^PRAGMA busy_timeout\s*=\s*0\s*;?\s*$/.test(sql))throw restoreError;if(/^ROLLBACK$/.test(sql))rollbacks++;return Reflect.apply(original,this,[sql]);};
 try{assert.throws(()=>policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true}),e=>e instanceof AggregateError&&e.errors[0].errcode===5&&e.errors[1]===restoreError);}
 finally{f.store.db.exec=original;}
 assert.equal(rollbacks,0);assert.equal(f.store.db.isOpen,false);await h.stop();
});
test('restore, rollback and close errors keep cause order and quarantine until owner cleanup',wal,async t=>{
 const f=await fixture(t),resetError=Error('synthetic_reset'),rollbackError=Error('synthetic_rollback'),closeError=Error('synthetic_close'),originalExec=f.store.db.exec,originalClose=f.store.db.close;const order=[];
 f.store.db.exec=function(sql){if(/^PRAGMA busy_timeout\s*=\s*0\s*;?\s*$/.test(sql))throw resetError;if(/^ROLLBACK$/.test(sql)){order.push('rollback');throw rollbackError;}return Reflect.apply(originalExec,this,[sql]);};
 f.store.db.close=function(){order.push('close');throw closeError;};
 try{
  assert.throws(()=>policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true}),e=>e instanceof AggregateError&&e.errors[0]===resetError&&e.errors[1]===rollbackError&&e.errors[2]===closeError&&e.cause===resetError);
  assert.deepEqual(order,['rollback','close']);assert.throws(()=>f.store.getRoomRow(f.roomId),/broker_storage_write_policy/);
 }finally{f.store.db.exec=originalExec;f.store.db.close=originalClose;}
});
test('partial BEGIN success followed by a thrown wrapper error rolls back only that new transaction',wal,async t=>{
 const f=await fixture(t),beginError=Error('synthetic_after_begin'),original=f.store.db.exec;let injected=false,calls=0;
 f.store.db.exec=function(sql){const result=Reflect.apply(original,this,[sql]);if(!injected&&/^BEGIN IMMEDIATE$/.test(sql)){injected=true;throw beginError;}return result;};
 try{assert.throws(()=>f.store.withTransaction(()=>{calls++;},{waitForWriter:true}),e=>e===beginError);}
 finally{f.store.db.exec=original;}
 assert.equal(injected,true);assert.equal(calls,0);assert.equal(f.store.db.isTransaction,false);assert.equal(f.store.db.isOpen,true);assert.equal(scalar(f.store.db,'busy_timeout'),0);
});
test('rollback failure after verified timeout restoration also closes the orphaned owner transaction',wal,async t=>{
 const f=await fixture(t),resetError=Error('synthetic_after_restore'),rollbackError=Error('synthetic_rollback'),original=f.store.db.exec;let injected=false;
 f.store.db.exec=function(sql){
  if(/^ROLLBACK$/.test(sql))throw rollbackError;
  const result=Reflect.apply(original,this,[sql]);
  if(!injected&&/^PRAGMA busy_timeout\s*=\s*0\s*;?\s*$/.test(sql)){injected=true;throw resetError;}
  return result;
 };
 try{assert.throws(()=>policy.beginBrokerWriteTransaction(f.store.db,{waitForWriter:true}),e=>e instanceof AggregateError&&e.errors[0]===resetError&&e.errors[1]===rollbackError);}
 finally{f.store.db.exec=original;}
 assert.equal(injected,true);assert.equal(f.store.db.isOpen,false);
 assert.throws(()=>f.store.getRoomRow(f.roomId),/broker_storage_write_policy/);
});

function claimForCompletion(f,{workspace=false}={}){
 const actor={...f.ctx,requestSource:'agent',actor:{kind:'agent',logicalAgentId:'a'},allowedLogicalAgentIds:['a']};
 const input={roomId:f.roomId,roomMessageId:f.source.messageId,logicalAgentId:'a',discussionOnly:true};
 const claimed=workspace?f.service.workspace.claimWake(input,actor):f.service.claimWake(input,actor);
 assert.equal(claimed.ok,true,JSON.stringify(claimed));return claimed.claimToken;
}
function settlementCounts(f){
 return {messages:f.store.db.prepare('SELECT count(*) n FROM room_messages').get().n,audits:f.store.listAudit(f.roomId).length,deliveries:f.store.db.prepare('SELECT count(*) n FROM room_message_deliveries').get().n};
}
function watchSettlement(f){
 const original=f.store.db.exec,originalOwn=Object.getOwnPropertyDescriptor(f.store.db,'exec'),reads=[],begins=[];
 f.store.db.exec=function(sql){if(/^\s*BEGIN/i.test(sql))begins.push(sql);return Reflect.apply(original,this,[sql]);};
 for(const name of ['getRoomRow','getDelivery','getMember','getMessageById']){
  const fn=f.store[name];f.store[name]=function(...args){reads.push({name,transaction:f.store.db.isTransaction,timeout:scalar(f.store.db,'busy_timeout')});return Reflect.apply(fn,this,args);};
 }
 return {reads,begins,restore(){if(originalOwn)Object.defineProperty(f.store.db,'exec',originalOwn);else delete f.store.db.exec;}};
}
test('WAL complete owns ONE IMMEDIATE acquisition and rereads every authority with timeout0 after child release',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f),before=settlementCounts(f),h=await f.hold({release:'attempt-file'}),watch=watchSettlement(f);
 const promise=duringBegin(f.store.db,()=>h.markAttempt(),()=>f.service.completeWake({claimToken,reply:{text:'one durable reply'}}));
 // No await in the transaction: ownership must already have ended when API returns its promise.
 assert.equal(f.store.db.isTransaction,false);
 const result=await promise;watch.restore();await h.committed;
 assert.equal(result.ok,true);assert.equal(watch.begins.length,1);assert.match(watch.begins[0],/^BEGIN IMMEDIATE/);
 assert.ok(watch.reads.length>=4);assert.ok(watch.reads.every(r=>r.transaction&&r.timeout===0));
 assert.equal(settlementCounts(f).messages,before.messages+1);assert.equal(f.store.getDelivery(f.source.messageId,'agent:a').wakeStatus,'completed');
 const second=createRoomStore({dbPath:f.path,storageMode:'wal-full-v1'});
 try{const other=createRoomService({store:second});const duplicate=await other.completeWake({claimToken,reply:{text:'duplicate'}});assert.equal(duplicate.code,'room_delivery_conflict');assert.equal(settlementCounts(f).messages,before.messages+1);}finally{second.close();}
});
test('WAL complete rereads competing completed delivery committed while BEGIN waited',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f),before=settlementCounts(f),h=await f.hold({mutation:'settleDelivery',release:'attempt-file'});
 const result=await duringBegin(f.store.db,()=>h.markAttempt(),()=>f.service.completeWake({claimToken,reply:{text:'must not duplicate'}}));await h.committed;
 assert.equal(result.code,'room_delivery_conflict');assert.equal(result.wakeStatus,'completed');assert.deepEqual(settlementCounts(f),before);
 assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);
});
test('WAL stale epoch during acquisition commits exactly one durable failed-delivery audit',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f),before=settlementCounts(f),h=await f.hold({mutation:'advanceEpoch',release:'attempt-file'});
 const result=await duringBegin(f.store.db,()=>h.markAttempt(),()=>f.service.completeWake({claimToken,reply:{text:'stale'}}));await h.committed;
 assert.equal(result.settled,'stale_epoch');assert.equal(f.store.getDelivery(f.source.messageId,'agent:a').wakeStatus,'failed');
 assert.equal(settlementCounts(f).messages,before.messages);assert.equal(f.store.listAudit(f.roomId).filter(a=>a.outcome==='stale_epoch').length,1);
 const check=createRoomStore({dbPath:f.path,storageMode:'wal-full-v1'});try{assert.equal(check.listAudit(f.roomId).filter(a=>a.outcome==='stale_epoch').length,1);}finally{check.close();}
 assert.equal((await f.service.completeWake({claimToken,reply:{text:'again'}})).code,'room_delivery_conflict');assert.equal(f.store.listAudit(f.roomId).length,before.audits+1);
});
test('WAL archive during acquisition preserves expired legacy grace audit settlement',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f),before=settlementCounts(f),h=await f.hold({mutation:'archiveRoom',release:'attempt-file'});
 const result=await duringBegin(f.store.db,()=>h.markAttempt(),()=>f.service.completeWake({claimToken,reply:{text:'expired'},now:new Date(Date.now()+86400000)}));await h.committed;
 assert.equal(result.settled,'grace_expired');assert.equal(f.store.getDelivery(f.source.messageId,'agent:a').wakeStatus,'failed');assert.equal(settlementCounts(f).messages,before.messages);assert.equal(f.store.listAudit(f.roomId).filter(a=>a.outcome==='grace_expired').length,1);
});
test('WAL complete revalidates recorded workspace grant after member revocation without partial effects',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f,{workspace:true}),before=settlementCounts(f),h=await f.hold({mutation:'revokeMember',release:'attempt-file'});
 const result=await duringBegin(f.store.db,()=>h.markAttempt(),()=>f.service.completeWake({claimToken,reply:{text:'revoked'}}));await h.committed;
 assert.equal(result.code,'workspace_claim_revoked');assert.deepEqual(settlementCounts(f),before);assert.equal(f.store.getDelivery(f.source.messageId,'agent:a').wakeStatus,'claimed');assert.equal(f.store.getMember(f.roomId,{kind:'agent',logicalAgentId:'a'}).status,'removed');assert.equal(f.store.db.isTransaction,false);
});
test('WAL complete exhausted acquisition runs NO authority read or settlement and restores timeout even for invalid token',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f),before=settlementCounts(f),h=await f.hold(),watch=watchSettlement(f);
 await assert.rejects(f.service.completeWake({claimToken,reply:{text:'blocked'}}),e=>e.errcode===5);
 assert.equal(watch.reads.length,0);assert.equal(watch.begins.length,1);assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);
 await assert.rejects(f.service.completeWake({claimToken:'unknown|a|1|2000',reply:{text:'invalid'}}),e=>e.errcode===5);
 assert.equal(watch.reads.length,0);assert.equal(watch.begins.length,2);watch.restore();await h.stop();assert.deepEqual(settlementCounts(f),before);
});
test('WAL complete body failure rolls back message, recipients and wake once with original error and timeout0',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f),before=settlementCounts(f),error=Error('synthetic_recipient_failure'),original=f.store.insertDelivery;let calls=0;
 f.store.insertDelivery=()=>{calls++;throw error;};
 try{await assert.rejects(f.service.completeWake({claimToken,reply:{text:'rollback'}}),e=>e===error);}finally{f.store.insertDelivery=original;}
 assert.equal(calls,1);assert.deepEqual(settlementCounts(f),before);assert.equal(f.store.getDelivery(f.source.messageId,'agent:a').wakeStatus,'claimed');assert.equal(scalar(f.store.db,'busy_timeout'),0);assert.equal(f.store.db.isTransaction,false);
});
for(const mode of ['delete','wal-full-v1'])test('complete missing source refuses without writes in '+mode,mode==='delete'?{}:wal,async t=>{
 const f=await fixture(t,{mode}),claimToken=claimForCompletion(f),before=settlementCounts(f),original=f.store.getMessageById;
 // Inject a missing read result at the public store seam after real claim setup;
 // no fabricated authorization, settlement or persistence implementation.
 f.store.getMessageById=()=>null;
 try{assert.equal((await f.service.completeWake({claimToken,reply:{text:'missing'}})).code,'room_message_not_found');}finally{f.store.getMessageById=original;}
 assert.deepEqual(settlementCounts(f),before);assertOutsideTransaction(f.store.db);assert.equal(scalar(f.store.db,'busy_timeout'),0);
});
test('DELETE complete preserves early conflict reads without acquiring a blocked write lock',async t=>{
 const f=await fixture(t,{mode:'delete'}),h=await f.hold(),watch=watchSettlement(f);
 const result=await f.service.completeWake({claimToken:'unknown|a|1|2000',reply:{text:'invalid'}});
 watch.restore();assert.equal(result.code,'room_delivery_conflict');assert.equal(watch.begins.length,0);assert.ok(watch.reads.length>0);assert.ok(watch.reads.every(r=>!r.transaction));await h.stop();
});

function historyInput(f,claimToken){return {roomId:f.roomId,claimToken,limit:1};}
test('WAL claim page owns one IMMEDIATE snapshot and commits exactly one audit before independent cleanup',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f),h=await f.hold({release:'attempt-file'}),watch=watchSettlement(f),prune=f.store.pruneStaleRoomHistoryReadAuditsIfDue;let cleanups=0;
 f.store.pruneStaleRoomHistoryReadAuditsIfDue=now=>{cleanups++;assert.equal(f.store.db.isTransaction,false);const check=createRoomStore({dbPath:f.path,storageMode:'wal-full-v1'});try{assert.equal(check.listRoomHistoryReadAudits(f.roomId).length,1);}finally{check.close();}return prune(now);};
 const page=duringBegin(f.store.db,()=>h.markAttempt(),()=>f.service.listRoomMessagesPage(historyInput(f,claimToken)));watch.restore();await h.committed;
 assert.equal(page.ok,true);assert.equal(page.messages.length,1);assert.equal(page.messages[0].messageId,f.source.messageId);assert.equal(page.totalMessages,1);assert.equal(watch.begins.length,1);assert.match(watch.begins[0],/^BEGIN IMMEDIATE/);assert.ok(watch.reads.every(r=>r.transaction&&r.timeout===0));assert.equal(cleanups,1);
 const audits=f.store.listRoomHistoryReadAudits(f.roomId);assert.equal(audits.length,1);assert.equal(audits[0].actorParticipantId,'agent:a');assert.equal(audits[0].resultCount,1);assert.equal(audits[0].fromSequence,page.fromSequence);assert.equal(f.store.db.isTransaction,false);
});
for(const [mutation,expected,workspace] of [['revokeMember','room_membership_required',false],['advanceEpoch','room_delivery_conflict',false],['revokeMember','workspace_claim_revoked',true]])test('WAL claim page rereads '+mutation+' workspace='+workspace+' after acquired lock',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f,{workspace}),h=await f.hold({mutation,release:'attempt-file'});let cleanups=0;
 f.store.pruneStaleRoomHistoryReadAuditsIfDue=()=>{cleanups++;assert.fail('refused page must not maintain');};
 const result=duringBegin(f.store.db,()=>h.markAttempt(),()=>f.service.listRoomMessagesPage(historyInput(f,claimToken)));await h.committed;
 assert.equal(result.code,expected);assert.equal(f.store.listRoomHistoryReadAudits(f.roomId).length,0);assert.equal(cleanups,0);assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);
});
test('WAL ctx-bounded history rereads membership after write acquisition',wal,async t=>{
 const f=await fixture(t),actor={...f.ctx,requestSource:'agent',actor:{kind:'agent',logicalAgentId:'a'},allowedLogicalAgentIds:['a']},h=await f.hold({mutation:'revokeMember',release:'attempt-file'});
 const result=duringBegin(f.store.db,()=>h.markAttempt(),()=>f.service.listRoomMessages({roomId:f.roomId,limit:1},actor));await h.committed;
 assert.equal(result.code,'room_membership_required');assert.equal(f.store.listRoomHistoryReadAudits(f.roomId).length,0);assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);
});
test('WAL audited history exhaustion has no authority reads, no audit, no transaction and timeout0',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f),h=await f.hold(),watch=watchSettlement(f);
 assert.throws(()=>f.service.listRoomMessagesPage(historyInput(f,claimToken)),e=>e.errcode===5);assert.equal(watch.reads.length,0);assert.equal(watch.begins.length,1);assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);
 assert.throws(()=>f.service.listRoomMessages({roomId:f.roomId,limit:1},f.ctx),e=>e.errcode===5);assert.equal(watch.reads.length,0);assert.equal(watch.begins.length,2);watch.restore();await h.stop();assert.equal(f.store.listRoomHistoryReadAudits(f.roomId).length,0);
});
test('WAL audited history COMMIT error rolls back audit once and never enters cleanup',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f),error=Error('synthetic_page_commit'),exec=f.store.db.exec;let commits=0,cleanups=0;
 f.store.db.exec=function(sql){if(/^COMMIT\s*;?\s*$/.test(sql)){commits++;throw error;}return Reflect.apply(exec,this,[sql]);};
 f.store.pruneStaleRoomHistoryReadAuditsIfDue=()=>{cleanups++;assert.fail('failed commit must not clean');};
 try{assert.throws(()=>f.service.listRoomMessagesPage(historyInput(f,claimToken)),e=>e===error);}finally{f.store.db.exec=exec;}
 assert.equal(commits,1);assert.equal(cleanups,0);assert.equal(f.store.listRoomHistoryReadAudits(f.roomId).length,0);assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);
});
test('WAL audit INSERT failure prevents response and rolls back owned read transaction',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f);
 f.store.db.exec("CREATE TRIGGER reject_synthetic_audit BEFORE INSERT ON room_history_read_audits BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure');END");
 assert.throws(()=>f.service.listRoomMessagesPage(historyInput(f,claimToken)),/synthetic_audit_failure/);
 assert.equal(f.store.listRoomHistoryReadAudits(f.roomId).length,0);assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);
});
test('WAL successful page audit stays independently durable when cleanup marker rolls back its delete',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f),now=Date.now(),prune=f.store.pruneStaleRoomHistoryReadAuditsIfDue;let maintenance;
 f.store.recordRoomHistoryReadAudit({roomId:f.roomId,actorParticipantId:'agent:a',resultCount:1,now:now-40*86400000});
 f.store.db.exec("CREATE TRIGGER reject_synthetic_marker BEFORE UPDATE ON room_history_read_audit_meta BEGIN SELECT RAISE(ABORT,'synthetic_marker_failure');END");
 f.store.pruneStaleRoomHistoryReadAuditsIfDue=time=>{assert.equal(f.store.db.isTransaction,false);const check=createRoomStore({dbPath:f.path,storageMode:'wal-full-v1'});try{assert.equal(check.listRoomHistoryReadAudits(f.roomId).length,2);}finally{check.close();}return maintenance=prune(time);};
 assert.equal(f.service.listRoomMessagesPage(historyInput(f,claimToken)).ok,true);assert.match(maintenance.error,/synthetic_marker_failure/);assert.equal(f.store.listRoomHistoryReadAudits(f.roomId).length,2);assert.equal(f.store.db.isTransaction,false);
 f.store.db.exec('DROP TRIGGER reject_synthetic_marker');assert.equal(prune(now).pruned,1);assert.equal(f.store.listRoomHistoryReadAudits(f.roomId).length,1);
});
test('WAL committed page survives actual independent writer BUSY during post-commit maintenance',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f),now=Date.now(),prune=f.store.pruneStaleRoomHistoryReadAuditsIfDue,writer=createRoomStore({dbPath:f.path,storageMode:'wal-full-v1'});let maintenance;
 f.store.recordRoomHistoryReadAudit({roomId:f.roomId,actorParticipantId:'agent:a',resultCount:1,now:now-40*86400000});
 f.store.pruneStaleRoomHistoryReadAuditsIfDue=time=>{assert.equal(f.store.db.isTransaction,false);writer.db.exec('BEGIN IMMEDIATE');try{return maintenance=prune(time);}finally{writer.db.exec('ROLLBACK');}};
 try{assert.equal(f.service.listRoomMessagesPage(historyInput(f,claimToken)).ok,true);assert.match(maintenance.error,/locked/);assert.equal(writer.listRoomHistoryReadAudits(f.roomId).length,2);}finally{writer.close();}
 assert.equal(f.store.db.isTransaction,false);assert.equal(scalar(f.store.db,'busy_timeout'),0);
});
test('WAL unbounded full snapshot stays read-only while writer held and still rejects nonmembers',wal,async t=>{
 const f=await fixture(t),h=await f.hold(),watch=watchSettlement(f);
 assert.equal(f.service.listRoomMessages({roomId:f.roomId},f.ctx).ok,true);
 const outsider={...f.ctx,requestSource:'agent',actor:{kind:'agent',logicalAgentId:'b'},allowedLogicalAgentIds:['b']};assert.equal(f.service.listRoomMessages({roomId:f.roomId},outsider).code,'room_membership_required');
 watch.restore();assert.equal(watch.begins.length,0);assert.equal(f.store.listRoomHistoryReadAudits(f.roomId).length,0);await h.stop();
});
test('WAL service audited page refuses caller-owned deferred transaction without ending it',wal,async t=>{
 const f=await fixture(t),claimToken=claimForCompletion(f);f.store.db.exec('BEGIN');
 try{assert.throws(()=>f.service.listRoomMessagesPage(historyInput(f,claimToken)),/transaction/);assert.equal(f.store.db.isTransaction,true);assert.equal(f.store.listRoomHistoryReadAudits(f.roomId).length,0);}finally{if(f.store.db.isTransaction)f.store.db.exec('ROLLBACK');}
});
test('DELETE audited page keeps authority reads outside transaction and original standalone audit',async t=>{
 const f=await fixture(t,{mode:'delete'}),claimToken=claimForCompletion(f),watch=watchSettlement(f);
 const page=f.service.listRoomMessagesPage(historyInput(f,claimToken));watch.restore();assert.equal(page.ok,true);assert.ok(watch.reads.length>0);assert.ok(watch.reads.every(r=>!r.transaction));assert.deepEqual(watch.begins,['BEGIN']);assert.equal(f.store.listRoomHistoryReadAudits(f.roomId).length,1);
});

