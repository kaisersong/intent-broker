import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRoomStore} from '../../src/room/store.js';
import {createRoomService} from '../../src/room/service.js';
import {createTempDbPath} from '../fixtures/temp-dir.js';
const user={sessionId:'disclosure-user',requestSource:'user',actor:{kind:'user',userId:'user.local'},allowedLogicalAgentIds:[],issuedAt:new Date().toISOString()};
// These fixtures exercise the actual SQLite write interlock, not the future
// authenticated participant issuer. Direct fixture rows are not disclosure proof.
test('a held disclosure lease fences actual room archive and an older connection cannot bypass the write floor',()=>{
 const dbPath=createTempDbPath(),store=createRoomStore({dbPath});store.migrate();const service=createRoomService({store});
 try{const roomId=service.createRoom({title:'held source',memberAgentIds:['agent-a']},user).room.roomId;
 store.db.prepare("INSERT INTO room_disclosure_leases(attempt_id,room_id,state,payload_json) VALUES(?,?,'PREPARED',?)").run('fixture-attempt',roomId,'{}');
 assert.equal(service.archiveRoom({roomId},user).code,'disclosure_revocation_pending');assert.equal(store.getRoomRow(roomId).status,'active');
 const old=new DatabaseSync(dbPath);try{assert.throws(()=>old.prepare("UPDATE rooms SET status='archived' WHERE room_id=?").run(roomId),/disclosure/);}finally{old.close();}
 store.db.prepare("UPDATE room_disclosure_leases SET state='RELEASED' WHERE attempt_id=?").run('fixture-attempt');
 assert.equal(service.archiveRoom({roomId},user).ok,true);
 }finally{service.close();}
});
test('source-grant replacement is rejected in the original database while a held lease exists, without losing pending revoke intent',()=>{
 const store=createRoomStore({dbPath:createTempDbPath()});store.migrate();
 try{store.db.prepare('INSERT INTO room_workspace_records VALUES(?,?,?,?)').run('grant','g','room-1','{"revision":1}');
 store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run('attempt','room-1','{}');
 store.db.prepare('INSERT INTO room_disclosure_mutations(mutation_id,room_id,state,payload_json) VALUES(?,?,?,?)').run('revoke','room-1','PENDING','{}');
 assert.throws(()=>store.withTransaction(()=>store.db.prepare('UPDATE room_workspace_records SET value_json=? WHERE kind=? AND record_key=?').run('{"revision":2}','grant','g')),/disclosure/);
 assert.equal(store.db.prepare('SELECT state FROM room_disclosure_mutations WHERE mutation_id=?').get('revoke').state,'PENDING');
 assert.equal(JSON.parse(store.db.prepare('SELECT value_json FROM room_workspace_records WHERE record_key=?').get('g').value_json).revision,1);
 }finally{store.close();}
});
test('moving a protected grant to a different room cannot evade the original room lease',()=>{const store=createRoomStore({dbPath:createTempDbPath()});store.migrate();try{store.db.prepare('INSERT INTO room_workspace_records VALUES(?,?,?,?)').run('grant','moving','held-room','{}');store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run('moving-attempt','held-room','{}');assert.throws(()=>store.db.prepare("UPDATE room_workspace_records SET room_id='other-room' WHERE record_key='moving'").run(),/disclosure/);}finally{store.close();}});
test('held source permits only the unchanged claim heartbeat and still refuses a grant or execution authority change',()=>{const store=createRoomStore({dbPath:createTempDbPath()});store.migrate();try{const claim={claimId:'c',authorizationState:'valid',executionState:'running',lastHeartbeatAt:'old',updatedAt:'old',roomSequence:1};store.db.prepare('INSERT INTO room_workspace_records VALUES(?,?,?,?)').run('claim','c','r',JSON.stringify(claim));store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run('heartbeat-attempt','r','{}');store.db.prepare('UPDATE room_workspace_records SET value_json=? WHERE record_key=?').run(JSON.stringify({...claim,lastHeartbeatAt:'new',updatedAt:'new',roomSequence:2}),'c');assert.throws(()=>store.db.prepare('UPDATE room_workspace_records SET value_json=? WHERE record_key=?').run(JSON.stringify({...claim,authorizationState:'revoked'}),'c'),/disclosure/);}finally{store.close();}});
test('archive pending survives reopening and only the original user archive transaction applies it after held facts clear',()=>{
 const dbPath=createTempDbPath();let store=createRoomStore({dbPath});store.migrate();let service=createRoomService({store});
 const roomId=service.createRoom({title:'pending reopen',memberAgentIds:['a']},user).room.roomId;
 store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run('restart-attempt',roomId,'{}');
 const pending=service.archiveRoom({roomId},user);assert.equal(pending.code,'disclosure_revocation_pending');service.close();
 store=createRoomStore({dbPath});store.migrate();service=createRoomService({store});try{
 assert.equal(service.archiveRoom({roomId},user).mutationId,pending.mutationId);
 assert.equal(store.db.prepare('SELECT state FROM room_disclosure_mutations WHERE mutation_id=?').get(pending.mutationId).state,'PENDING');
 const agent={...user,requestSource:'agent',actor:{kind:'agent',logicalAgentId:'a'},allowedLogicalAgentIds:['a']};
 assert.equal(service.archiveRoom({roomId},agent).ok,false);
 // Only a fixture terminal row: this is not an authenticated egress release test.
 store.db.prepare("UPDATE room_disclosure_leases SET state='RELEASED' WHERE attempt_id='restart-attempt'").run();
 assert.equal(service.archiveRoom({roomId},user).ok,true);
 assert.equal(store.db.prepare('SELECT state FROM room_disclosure_mutations WHERE mutation_id=?').get(pending.mutationId).state,'APPLIED');
 assert.equal(store.getRoomRow(roomId).status,'archiving');
 }finally{service.close();}
});
test('the actual read-grant revoke records pending without changing the old grant, and later applies the same intent',()=>{
 const store=createRoomStore({dbPath:createTempDbPath()});store.migrate();const service=createRoomService({store});try{
 const roomId=service.createRoom({title:'revoke held grant',memberAgentIds:['a']},user).room.roomId;
 store.db.prepare('INSERT INTO room_workspace_records VALUES(?,?,?,?)').run('grant','read-grant',roomId,JSON.stringify({grantId:'read-grant',roomId,issuedSequence:1}));
 store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run('read-attempt',roomId,'{}');
 const input={roomId,grantId:'read-grant'};const pending=service.workspace.revokeReadGrant(input,user);
 assert.equal(pending.code,'disclosure_revocation_pending');
 assert.equal(JSON.parse(store.db.prepare("SELECT value_json FROM room_workspace_records WHERE kind='grant' AND record_key='read-grant'").get().value_json).revokedSequence,undefined);
 assert.equal(service.workspace.revokeReadGrant(input,user).mutationId,pending.mutationId);
 store.db.prepare("UPDATE room_disclosure_leases SET state='RELEASED' WHERE attempt_id='read-attempt'").run();
 const done=service.workspace.revokeReadGrant(input,user);assert.equal(done.ok,true);assert.equal(typeof done.grant.revokedSequence,'number');
 assert.equal(store.db.prepare('SELECT state FROM room_disclosure_mutations WHERE mutation_id=?').get(pending.mutationId).state,'APPLIED');
 }finally{service.close();}
});
test('archive disclosure internal siblings require user source and their exact transaction boundary',()=>{
 const store=createRoomStore({dbPath:createTempDbPath()});store.migrate();const service=createRoomService({store});try{
 const r=service.createRoom({title:'transaction boundary',memberAgentIds:['a']},user).room;
 const input={roomId:r.roomId,expectedRoomRevision:r.revision};
 const agent={...user,requestSource:'agent',actor:{kind:'agent',logicalAgentId:'a'},allowedLogicalAgentIds:['a']};
 assert.equal(service.workspace.prepareArchiveDisclosure(input,agent).ok,false);
 store.withTransaction(()=>{assert.throws(()=>service.workspace.prepareArchiveDisclosure(input,user),/disclosure_independent_transaction_required/);});
 assert.throws(()=>service.workspace.completeArchiveDisclosure({...input,mutationId:'missing'},user),/disclosure_commit_transaction_required/);
 assert.throws(()=>service.workspace.completeArchiveDisclosure({...input,mutationId:'missing'},agent),/room_actor_forbidden/);
 }finally{service.close();}
});
test('member removal and discussion cancellation persist exact pending operations at their original user entry points',()=>{
 const store=createRoomStore({dbPath:createTempDbPath()});store.migrate();const service=createRoomService({store});try{
 for(const kind of ['member','discussion']){
  const roomId=service.createRoom({title:kind,memberAgentIds:['a']},user).room.roomId;
  store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run(kind,roomId,'{}');
  const invoke=()=>kind==='member'?service.updateRoomMembers({roomId,removeAgentIds:['a']},user):service.cancelDiscussion({roomId,requestId:'stop'},user);
  const pending=invoke();assert.equal(pending.code,'disclosure_revocation_pending');
  assert.equal(invoke().mutationId,pending.mutationId);
  assert.equal(store.getMember(roomId,{kind:'agent',logicalAgentId:'a'}).status,'active');
  store.db.prepare("UPDATE room_disclosure_leases SET state='RELEASED' WHERE attempt_id=?").run(kind);
  assert.equal(invoke().ok,true);
  assert.equal(store.db.prepare('SELECT state FROM room_disclosure_mutations WHERE mutation_id=?').get(pending.mutationId).state,'APPLIED');
  if(kind==='member')assert.equal(store.getMember(roomId,{kind:'agent',logicalAgentId:'a'}).status,'pending_removal');
 }
 }finally{service.close();}
});
test('different pending mutations cannot overwrite or strand the first exact room revision intent',()=>{
 const store=createRoomStore({dbPath:createTempDbPath()});store.migrate();const service=createRoomService({store});try{
 const roomId=service.createRoom({title:'ordered mutations',memberAgentIds:['a']},user).room.roomId;
 store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run('ordered',roomId,'{}');
 const first=service.updateRoomMembers({roomId,removeAgentIds:['a']},user);assert.equal(first.code,'disclosure_revocation_pending');
 assert.equal(service.archiveRoom({roomId},user).code,'disclosure_mutation_conflict');
 assert.equal(service.cancelDiscussion({roomId,requestId:'another'},user).code,'disclosure_mutation_conflict');
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM room_disclosure_mutations WHERE room_id=? AND state='PENDING'").get(roomId).n,1);
 }finally{service.close();}
});
