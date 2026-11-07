import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRoomStore} from '../../src/room/store.js';
import {createRoomService} from '../../src/room/service.js';

test('original Room service exposes independent no-Room admission control semantics',t=>{
 const root=mkdtempSync(join(tmpdir(),'broker-admission-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=createRoomStore({dbPath:join(root,'broker.sqlite')});store.migrate();t.after(()=>store.close());
 const service=createRoomService({store});
 for(const method of ['establishAdmissionBaseline','applyAdmissionFence','readAdmissionControlReceipt'])assert.equal(typeof service[method],'function',method);
});

const scope={profileId:'profile-test',workspaceId:'workspace-test'},authority={authorityId:'authority-test',authorityEpoch:1};
const ctx={requestSource:'scheduler',actor:{kind:'system',service:'desktop'},hostPrincipal:'authenticated-local-installation'};
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'broker-admission-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'broker.sqlite');let store=createRoomStore({dbPath:path});store.migrate();let service=createRoomService({store});
 t.after(()=>store.close());
 return {get store(){return store;},get service(){return service;},reopen(){store.close();store=createRoomStore({dbPath:path});store.migrate();service=createRoomService({store});}};
}
const baseline=()=>({schemaVersion:1,scope,authority,operationId:'baseline-operation',visibility:{kind:'no_visibility'}});
import {admissionDigest,canonicalAdmissionJSON} from '../../src/room/admission-control.js';
import {createServer} from '../../src/http/server.js';
import {createHmac,createHash} from 'node:crypto';
function fence(realmId,overrides={}){
 const policy=overrides.policy??{mode:'observe'},axis=overrides.axis??'mode',sourceHeadId=overrides.sourceHeadId??'mode:global';
 return {schemaVersion:1,scope,authority,realmId,range:{sourceBindingId:null,mandateId:null,workId:null},axis,controlKey:admissionDigest({sourceHeadId,axis}),sourceHeadId,commandHash:admissionDigest({originalACommand:'metadata-only-original-hash',epoch:overrides.epoch??1,policy}),epoch:1,operationId:'mode-operation',canonicalPolicyHash:admissionDigest(policy),policy,...overrides};
}
test('no-Room baseline persists on original connection; cold reader keeps exact realm and authority',async t=>{
 const f=await fixture(t),b=f.service.establishAdmissionBaseline(baseline(),ctx);assert.equal(b.ok,true);assert.equal(b.current,true);assert.equal(b.domain.ownerKind,'active_pointer');assert.deepEqual({...b.visibility},{kind:'no_visibility'});
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM rooms').get().n,0);
 const input=fence(b.receipt.realmId),a=f.service.applyAdmissionFence(input,ctx);assert.equal(a.ok,true);assert.equal(a.receipt.storageRevision,2);
 f.reopen();const read=f.service.readAdmissionControlReceipt({schemaVersion:1,scope,authority,realmId:b.receipt.realmId,operationId:input.operationId},ctx);
 assert.equal(canonicalAdmissionJSON(read),canonicalAdmissionJSON(a));assert.equal(canonicalAdmissionJSON(f.service.establishAdmissionBaseline(baseline(),ctx)),canonicalAdmissionJSON(b));
 assert.equal(f.service.establishAdmissionBaseline({...baseline(),authority:{...authority,authorityEpoch:2}},ctx).code,'admission_authority_conflict');
 assert.equal(f.service.readAdmissionControlReceipt({schemaVersion:1,scope,authority,realmId:'11111111-1111-4111-8111-111111111111',operationId:input.operationId},ctx).code,'admission_authority_conflict');
});
test('service default denies agent/forged actor; proxy and accessor input invoke zero getters',async t=>{
 const f=await fixture(t);
 for(const c of [null,{...ctx,requestSource:'agent'},{...ctx,actor:{kind:'system',service:'kswarm'}},{requestSource:'user',actor:{kind:'user',userId:'user.local'}}])assert.equal(f.service.establishAdmissionBaseline(baseline(),c).ok,false);
 let getters=0;const foreign=new Proxy({}, {get(){getters++;throw Error('forbidden');},getPrototypeOf(){getters++;throw Error('forbidden');}});
 assert.equal(f.service.establishAdmissionBaseline(foreign,ctx).ok,false);
 const accessor=baseline();Object.defineProperty(accessor,'scope',{get(){getters++;return scope;}});assert.equal(f.service.establishAdmissionBaseline(accessor,ctx).ok,false);assert.equal(getters,0);
 assert.equal(f.service.establishAdmissionBaseline({...baseline(),requestSource:'scheduler'},ctx).ok,false);
 assert.equal(f.service.establishAdmissionBaseline({...baseline(),visibility:{kind:'room_visibility',roomId:'room'}},ctx).ok,false);
});
test('prefix/leaf heads are independent; replay is full bytes and history never confirms a newer epoch',async t=>{
 const f=await fixture(t),b=f.service.establishAdmissionBaseline(baseline(),ctx),r=b.receipt.realmId,first=fence(r);
 assert.equal(f.service.applyAdmissionFence(first,ctx).ok,true);
 const conflict=fence(r,{operationId:'conflict',policy:{mode:'off'}});assert.equal(f.service.applyAdmissionFence(conflict,ctx).code,'admission_epoch_conflict');
 assert.equal(f.service.applyAdmissionFence({...first,commandHash:'a'.repeat(64)},ctx).code,'admission_operation_conflict');
 const second=fence(r,{operationId:'new-mode',epoch:2,policy:{mode:'off'}});assert.equal(f.service.applyAdmissionFence(second,ctx).ok,true);
 const historical=f.service.applyAdmissionFence(first,ctx);assert.equal(historical.ok,true);assert.equal(historical.current,false);assert.equal(historical.receipt.storageRevision,2);
 assert.equal(f.service.applyAdmissionFence({...first,operationId:'late-operation'},ctx).code,'admission_epoch_conflict');
 assert.equal(f.service.applyAdmissionFence(fence(r,{sourceHeadId:'mode:workspace',operationId:'workspace-mode'}),ctx).ok,true);
 assert.equal(f.service.applyAdmissionFence(fence(r,{axis:'authorization',sourceHeadId:'privacy:workspace',operationId:'privacy',policy:{allowed:false,reasonCode:'VISIBILITY_NARROWING'}}),ctx).ok,true);
 assert.equal(f.service.applyAdmissionFence(fence(r,{axis:'egress',sourceHeadId:'egress:mandate',operationId:'egress',policy:{enabled:false,policyRef:null}}),ctx).ok,true);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM room_admission_heads').get().n,4);
 assert.equal(f.service.applyAdmissionFence({...first,operationId:'bad',canonicalPolicyHash:'0'.repeat(64)},ctx).code,'admission_policy_hash_conflict');
});
test('immutable receipt rejects update/delete/replace; cold parser rejects exact-storage class and NUL suffix corruption',async t=>{
 const f=await fixture(t),b=f.service.establishAdmissionBaseline(baseline(),ctx),r=b.receipt.realmId,input=fence(r);f.service.applyAdmissionFence(input,ctx);
 for(const sql of ['UPDATE room_admission_receipts SET body_hash=body_hash','DELETE FROM room_admission_receipts',"INSERT OR REPLACE INTO room_admission_receipts SELECT * FROM room_admission_receipts WHERE receipt_kind='fence'"])assert.throws(()=>f.store.db.exec(sql),/admission_receipt_immutable/);
 f.store.db.exec('DROP TRIGGER room_admission_receipts_update');
 const query={schemaVersion:1,scope,authority,realmId:r,operationId:input.operationId},row=f.store.db.prepare("SELECT * FROM room_admission_receipts WHERE receipt_kind='fence'").get();
 assert.throws(()=>f.store.db.prepare('UPDATE room_admission_receipts SET data_json=? WHERE operation_id=?').run(Buffer.from(row.data_json),input.operationId),/CHECK constraint/);
 f.store.db.prepare('UPDATE room_admission_receipts SET data_json=?,logical_bytes=? WHERE operation_id=?').run(row.data_json+'\0suffix',Buffer.byteLength(row.data_json+'\0suffix'),input.operationId);
 assert.equal(f.service.readAdmissionControlReceipt(query,ctx).code,'admission_storage_conflict');
 f.store.db.prepare('UPDATE room_admission_receipts SET data_json=?,logical_bytes=? WHERE operation_id=?').run(row.data_json,row.logical_bytes,input.operationId);
 const data=JSON.parse(row.data_json);data.request.range.workId='illegal-without-mandate';const json=canonicalAdmissionJSON(data);
 f.store.db.prepare('UPDATE room_admission_receipts SET data_json=?,body_hash=?,logical_bytes=? WHERE operation_id=?').run(json,admissionDigest(data),Buffer.byteLength(json),input.operationId);
 assert.equal(f.service.readAdmissionControlReceipt(query,ctx).ok,false);
});
test('failed receipt commit rolls back head and storage revision on the same Room transaction',async t=>{
 const f=await fixture(t),b=f.service.establishAdmissionBaseline(baseline(),ctx),input=fence(b.receipt.realmId);
 f.store.db.exec("CREATE TRIGGER injected_receipt_fault BEFORE INSERT ON room_admission_receipts WHEN NEW.receipt_kind='fence' BEGIN SELECT RAISE(ABORT,'injected_commit_fault');END");
 assert.throws(()=>f.service.applyAdmissionFence(input,ctx),/injected_commit_fault/);
 assert.equal(f.store.db.prepare('SELECT storage_revision FROM room_admission_baselines').get().storage_revision,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM room_admission_heads').get().n,0);
 f.store.db.exec('DROP TRIGGER injected_receipt_fault');assert.equal(f.service.applyAdmissionFence(input,ctx).receipt.storageRevision,2);
});
test('actual HTTP Desktop transport authenticates full signed protocol/request; old and system credentials fail',async t=>{
 const f=await fixture(t),token='private-test-desktop-credential',server=createServer({broker:{},roomService:f.service,roomDesktopToken:token,roomKSwarmToken:'other-system-credential'});
 await server.listen(0,'127.0.0.1');t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 const input=baseline(),challenge='2'.repeat(64),envelope={protocol:'broker_dsh_control_v1',challenge,requestDigest:admissionDigest(input),input};
 async function call(credential,body=envelope,action='baseline'){const response=await fetch(base+'/rooms/admission-control/'+action,{method:'POST',headers:{'content-type':'application/json',...(credential?{'x-intent-broker-room-token':credential}:{})},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
 assert.equal((await call()).status,401);assert.equal((await call('old-desktop-credential')).status,401);assert.equal((await call('other-system-credential')).status,403);
 const reply=await call(token);assert.equal(reply.status,200);assert.equal(reply.body.body.ok,true);
 const signed={protocol:reply.body.protocol,challenge:reply.body.challenge,requestDigest:reply.body.requestDigest,body:reply.body.body};
 assert.equal(reply.body.authentication,createHmac('sha256',token).update('xiaok.broker-dsh-reply.v1\0').update(canonicalAdmissionJSON(signed)).digest('hex'));
 assert.equal(reply.body.requestDigest,envelope.requestDigest);assert.equal(reply.body.challenge,challenge);
 assert.equal((await call(token,{...envelope,requestDigest:'0'.repeat(64)})).status,400);
 const expectedPrincipal=createHash('sha256').update('room-host-installation\n').update(token).digest('hex');assert.equal(f.store.db.prepare('SELECT principal_id FROM room_admission_baselines').get().principal_id,expectedPrincipal);
 const before=f.store.db.prepare('SELECT count(*) AS n FROM room_admission_receipts').get().n;
 assert.equal((await call(token,{...envelope,input:{...input,requestSource:'user'}})).status,400);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM room_admission_receipts').get().n,before);
});

test('schema8 upgrade retains original Room identity; older ordinary writer cannot manufacture a control receipt',async t=>{
 const root=mkdtempSync(join(tmpdir(),'broker-admission-v8-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=join(root,'broker.sqlite'),template=createRoomStore({dbPath:':memory:'}),steps=template.getDefaultMigrations();template.close();
 const legacy=createRoomStore({dbPath:path,migrations:steps.filter(s=>s.version<=8)});assert.equal(legacy.migrate().schemaVersion,8);
 const actor={requestSource:'user',sessionId:'user',actor:{kind:'user',userId:'user.local'},issuedAt:new Date().toISOString()};
 const room=createRoomService({store:legacy}).createRoom({title:'ordinary retained',memberAgentIds:[],clientRequestKey:'before-upgrade'},actor).room;
 const realm=legacy.getSourceRealm();legacy.close();
 const current=createRoomStore({dbPath:path});t.after(()=>current.close());assert.equal(current.migrate().schemaVersion,9);assert.equal(current.getSourceRealm(),realm);assert.equal(current.getRoomRow(room.roomId).title,'ordinary retained');
 const control=createRoomService({store:current}),b=control.establishAdmissionBaseline(baseline(),ctx);assert.equal(b.ok,true);
 const old=createRoomStore({dbPath:path,migrations:steps.filter(s=>s.version<=8)});try{
  assert.equal(old.migrate().schemaVersion,9);assert.equal(old.getSourceRealm(),realm);
  const result=createRoomService({store:old}).createRoom({title:'ordinary after upgrade',memberAgentIds:[],clientRequestKey:'after-upgrade'},actor);assert.equal(result.ok,true);
  assert.equal(current.db.prepare('SELECT count(*) AS n FROM room_admission_receipts').get().n,1);
  assert.throws(()=>old.db.prepare("UPDATE room_admission_receipts SET data_json='{}'").run(),/admission_receipt_immutable/);
 }finally{old.close();}
});
test('cold baseline cannot be reconstructed from missing receipt or self-consistent wrong primary-key body',async t=>{
 const f=await fixture(t),b=f.service.establishAdmissionBaseline(baseline(),ctx),r=b.receipt.realmId,input=fence(r);f.service.applyAdmissionFence(input,ctx);
 f.store.db.exec('DROP TRIGGER room_admission_receipts_update');
 const row=f.store.db.prepare("SELECT * FROM room_admission_receipts WHERE receipt_kind='fence'").get(),data=JSON.parse(row.data_json);
 data.operationId='different-operation';data.request.operationId='different-operation';data.durableGuard=admissionDigest({realmId:r,scopeKey:row.scope_key,request:data.request,storageRevision:data.storageRevision});
 const json=canonicalAdmissionJSON(data);f.store.db.prepare('UPDATE room_admission_receipts SET data_json=?,body_hash=?,logical_bytes=? WHERE operation_id=?').run(json,admissionDigest(data),Buffer.byteLength(json),input.operationId);
 const query={schemaVersion:1,scope,authority,realmId:r,operationId:input.operationId};assert.equal(f.service.readAdmissionControlReceipt(query,ctx).code,'admission_storage_conflict');
 f.store.db.exec("DROP TRIGGER room_admission_receipts_delete; DELETE FROM room_admission_receipts WHERE receipt_kind='baseline'");
 assert.equal(f.service.applyAdmissionFence(fence(r,{operationId:'new',epoch:2}),ctx).code,'admission_storage_conflict');
});

test('an actual commit followed by wrapper failure retains the original error and reconciles exact operation truth',async t=>{
 const f=await fixture(t),b=f.service.establishAdmissionBaseline(baseline(),ctx),input=fence(b.receipt.realmId),transaction=f.store.withTransaction;
 const first=Error('after-real-commit');let once=true;
 f.store.withTransaction=fn=>{const result=transaction(fn);if(once){once=false;throw first;}return result;};
 assert.throws(()=>f.service.applyAdmissionFence(input,ctx),raw=>raw===first);
 const read=f.service.readAdmissionControlReceipt({schemaVersion:1,scope,authority,realmId:input.realmId,operationId:input.operationId},ctx);assert.equal(read.ok,true);assert.equal(read.current,true);assert.equal(read.receipt.storageRevision,2);
 const replay=f.service.applyAdmissionFence(input,ctx);assert.equal(canonicalAdmissionJSON(replay),canonicalAdmissionJSON(read));assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM room_admission_receipts').get().n,2);
});
