import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRoomStore} from '../../src/room/store.js';
import {createRoomService} from '../../src/room/service.js';
import {createServer} from '../../src/http/server.js';
const ctx=(userId='user.local')=>({sessionId:'desktop-main-user',requestSource:'user',actor:{kind:'user',userId},allowedLogicalAgentIds:[],issuedAt:new Date().toISOString()});
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'broker-room-source-')),dbPath=join(directory,'rooms.sqlite');
 const store=createRoomStore({dbPath});store.migrate();let closed=false;t.after(()=>{if(!closed)store.close();rmSync(directory,{recursive:true,force:true});});
 const service=createRoomService({store}),room=service.createRoom({title:'Source',memberAgentIds:[],clientRequestKey:'source-room'},ctx()).room;
 const message=service.sendRoomMessage({roomId:room.roomId,text:'Original source body',responsePolicy:'none',idempotencyKey:'source-message',contextScope:{kind:'room_only'}},ctx()).message;
 return {store,service,room,message,dbPath,close(){store.close();closed=true;}};
}
test('persistent broker realm survives real store reopen, is immutable and never lazily recreated',t=>{
 const f=fixture(t),realm=f.store.getSourceRealm();assert.match(realm,/^[a-f0-9-]{36}$/);
 assert.equal(f.store.migrate().schemaVersion,9);assert.equal(f.store.getSourceRealm(),realm);
 assert.throws(()=>f.store.db.prepare("UPDATE room_source_identity SET realm_id=? WHERE singleton=1").run('changed'),/source_identity_immutable/);
 assert.throws(()=>f.store.db.exec('DELETE FROM room_source_identity'),/source_identity_immutable/);
 assert.throws(()=>f.store.db.prepare('INSERT OR REPLACE INTO room_source_identity(singleton,realm_id) VALUES(1,?)').run(realm),/source_identity_immutable/);
 f.close();const reopened=createRoomStore({dbPath:f.dbPath});try{reopened.migrate();assert.equal(reopened.getSourceRealm(),realm);
  reopened.db.exec('DROP TRIGGER room_source_identity_delete; DELETE FROM room_source_identity');
  assert.throws(()=>reopened.getSourceRealm(),/source_identity_unavailable/);reopened.migrate();assert.throws(()=>reopened.getSourceRealm(),/source_identity_unavailable/);
 }finally{reopened.close();}
});
test('source reader reuses active user membership and exposes only exact bounded message metadata',t=>{
 const f=fixture(t),input={roomId:f.room.roomId,messageId:f.message.messageId};
 const before=f.store.db.prepare('SELECT total_changes() AS n').get().n;
 const value=f.service.readRoomConversionSource(input,ctx());assert.equal(value.ok,true,JSON.stringify(value));
 assert.deepEqual(Object.keys(value).sort(),['ok','protocol','realmId','actorUserId','roomId','roomRevision','membershipRevision','messageId','messageSequence','text','contextScope'].sort());
 assert.equal(value.protocol,'room_conversion_source_v1');assert.equal(value.realmId,f.store.getSourceRealm());assert.equal(value.text,'Original source body');assert.equal(value.messageId,f.message.messageId);assert.equal(value.messageSequence,1);
 assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,before);
 assert.equal(f.service.readRoomConversionSource(input,ctx('outsider')).code,'room_membership_required');
 assert.equal(f.service.readRoomConversionSource({...input,messageId:'missing'},ctx('outsider')).code,'room_membership_required');
 assert.equal(f.service.readRoomConversionSource({...input,messageId:'missing'},ctx()).code,'room_message_not_found');
 for(const other of [null,{...ctx(),requestSource:'system',actor:{kind:'system',service:'kswarm'},scopes:['room-read']},{...ctx(),requestSource:'agent',actor:{kind:'agent',logicalAgentId:'agent'},allowedLogicalAgentIds:['agent']}])assert.equal(f.service.readRoomConversionSource(input,other).ok,false);
 f.store.updateMember(f.room.roomId,{kind:'user',userId:'user.local'},{status:'removed',membershipRevision:2});assert.equal(f.service.readRoomConversionSource(input,ctx()).code,'room_membership_required');
 f.store.updateMember(f.room.roomId,{kind:'user',userId:'user.local'},{status:'active',membershipRevision:3});assert.equal(f.service.readRoomConversionSource(input,ctx()).membershipRevision,3);
 f.store.updateRoom(f.room.roomId,{status:'archived',revision:2});assert.equal(f.service.readRoomConversionSource(input,ctx()).code,'room_archived');
});
test('source rejects unknown scope, oversized text and corrupt stable identity without changing original rows',t=>{
 const f=fixture(t),input={roomId:f.room.roomId,messageId:f.message.messageId};
 for(const scope of [{kind:'unknown'},{kind:'project',projectId:''}]){
  f.store.db.prepare('UPDATE room_messages SET context_scope_json=? WHERE room_id=?').run(JSON.stringify(scope),f.room.roomId);
  assert.equal(f.service.readRoomConversionSource(input,ctx()).code,'room_scope_mismatch');
 }
 f.store.db.prepare('UPDATE room_messages SET context_scope_json=?,text=? WHERE room_id=?').run('{"kind":"room_only"}','x'.repeat(65537),f.room.roomId);
 assert.equal(f.service.readRoomConversionSource(input,ctx()).code,'room_input_invalid');
 f.store.db.prepare('UPDATE room_messages SET text=? WHERE room_id=?').run('Original source body',f.room.roomId);
 f.store.db.exec('DROP TRIGGER room_source_identity_delete; DELETE FROM room_source_identity');
 assert.equal(f.service.readRoomConversionSource(input,ctx()).code,'room_source_identity_unavailable');
});
test('actual HTTP exact source route refuses system credentials and never falls through to full history',async t=>{
 const f=fixture(t),server=createServer({broker:{},roomService:f.service,roomDesktopToken:'desktop-source-token',roomKSwarmToken:'system-source-token'});
 await server.listen(0,'127.0.0.1');t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port,path=`/rooms/${f.room.roomId}/messages/${f.message.messageId}/conversion-source`;
 async function request(token,method='GET',suffix=''){const response=await fetch(base+path+suffix,{method,headers:token?{'x-intent-broker-room-token':token}:{}});return {status:response.status,body:await response.json()};}
 assert.equal((await request()).status,401);assert.equal((await request('system-source-token')).status,403);
 const result=await request('desktop-source-token');assert.equal(result.status,200);assert.equal(result.body.protocol,'room_conversion_source_v1');assert.equal(result.body.text,'Original source body');assert.equal('messages' in result.body,false);
 assert.equal((await request('desktop-source-token','POST')).status,405);
 const invalid=await request('desktop-source-token','GET','/unknown');assert.equal(invalid.status,404);assert.equal('messages' in invalid.body,false);
});

test('one real WAL read snapshot remains coherent across a second connection membership change',t=>{
 const f=fixture(t);f.store.db.exec('PRAGMA journal_mode=WAL');const other=createRoomStore({dbPath:f.dbPath});t.after(()=>other.close());
 const original=f.store.getRoomRow;let changed=false;
 f.store.getRoomRow=id=>{const room=original(id);if(!changed){changed=true;other.db.prepare("UPDATE room_members SET status='removed',membership_revision=membership_revision+1 WHERE room_id=? AND subject_id='user.local'").run(id);}return room;};
 const input={roomId:f.room.roomId,messageId:f.message.messageId},read=f.service.readRoomConversionSource(input,ctx());
 assert.equal(read.ok,true,JSON.stringify(read));assert.equal(read.membershipRevision,1);
 assert.equal(f.service.readRoomConversionSource(input,ctx()).code,'room_membership_required');
});
test('actual pending disclosure control blocks fresh source reads while old active rows remain',t=>{
 const f=fixture(t),input={roomId:f.room.roomId,messageId:f.message.messageId};
 // Metadata lease fixture only, not an authenticated physical/disclosure proof.
 f.store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED','{}')").run('held-source-fixture',f.room.roomId);
 const pending=f.service.updateRoomMembers({roomId:f.room.roomId,expectedRoomRevision:1,addUserIds:['other-user']},ctx());
 assert.equal(pending.code,'disclosure_revocation_pending');assert.equal(f.store.getRoomRow(f.room.roomId).status,'active');
 assert.equal(f.store.getMember(f.room.roomId,ctx().actor).status,'active');
 const before=f.store.db.prepare('SELECT total_changes() AS n').get().n;
 assert.equal(f.service.readRoomConversionSource(input,ctx()).code,'disclosure_revocation_pending');
 assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,before);
});
test('v8 identity migration preserves v7 held disclosure facts and rolls back identity plus version on fault',t=>{
 const directory=mkdtempSync(join(tmpdir(),'broker-source-upgrade-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const dbPath=join(directory,'upgrade.sqlite'),template=createRoomStore({dbPath:join(directory,'template.sqlite')});
 const steps=template.getDefaultMigrations();template.close();
 const old=createRoomStore({dbPath,migrations:steps.filter(step=>step.version<=7)});old.migrate();
 const service=createRoomService({store:old}),room=service.createRoom({title:'Old',memberAgentIds:[],clientRequestKey:'old-source'},ctx()).room;
 old.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED','{}')").run('held-upgrade-fixture',room.roomId);
 const original=old.db.prepare('SELECT * FROM rooms').all();old.close();
 const upgraded=createRoomStore({dbPath});try{assert.equal(upgraded.migrate().schemaVersion,9);assert.deepEqual(upgraded.db.prepare('SELECT * FROM rooms').all(),original);
  assert.equal(upgraded.db.prepare("SELECT state FROM room_disclosure_leases WHERE attempt_id='held-upgrade-fixture'").get().state,'PREPARED');
  assert.throws(()=>upgraded.updateRoom(room.roomId,{status:'archived'}),/disclosure_lease_held/);
  const second=new DatabaseSync(dbPath);try{
   for(const sql of ["UPDATE room_source_identity SET realm_id='11111111-1111-4111-8111-111111111111'",'DELETE FROM room_source_identity',"INSERT OR REPLACE INTO room_source_identity VALUES(1,'11111111-1111-4111-8111-111111111111')","INSERT INTO room_source_identity VALUES(1,'11111111-1111-4111-8111-111111111111') ON CONFLICT(singleton) DO UPDATE SET realm_id=excluded.realm_id"])assert.throws(()=>second.exec(sql),/source_identity_immutable/);
  }finally{second.close();}
 }finally{upgraded.close();}
 const failedPath=join(directory,'failed.sqlite'),seed=createRoomStore({dbPath:failedPath,migrations:steps.filter(step=>step.version<=7)});seed.migrate();seed.close();
 const failed=createRoomStore({dbPath:failedPath,migrations:steps.map(step=>step.version===8?{...step,up(db){step.up(db);throw Error('injected_v8_post_identity_fault');}}:step)});
 try{assert.throws(()=>failed.migrate(),/injected_v8_post_identity_fault/);assert.equal(failed.getSchemaVersion(),7);assert.equal(failed.db.prepare("SELECT 1 FROM sqlite_master WHERE name='room_source_identity'").get(),undefined);}finally{failed.close();}
});
