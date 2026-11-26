import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoomStore } from '../src/room/store.js';
import { createRoomService } from '../src/room/service.js';
import { createAimpService } from '../src/aimp/service.js';
import {sha256} from '../src/aimp/codec.js';

const user = {sessionId:'test',requestSource:'user',actor:{kind:'user',userId:'user.local'},issuedAt:new Date().toISOString()};
const agent = id => ({...user,requestSource:'agent',actor:{kind:'agent',logicalAgentId:id},allowedLogicalAgentIds:[id]});
test('AIMP owner rejects spoofing, fences claims, verifies delivery, keeps unknown effects and idempotency across restart', () => {
 const dir=mkdtempSync(join(tmpdir(),'aimp-owner-')), dbPath=join(dir,'broker.sqlite');
 const store=createRoomStore({dbPath});store.migrate();const room=createRoomService({store});
 const roomId=room.createRoom({title:'team',memberAgentIds:['a','b']},user).room.roomId;
 let now=Date.parse('2026-11-09T00:00:00Z');
 let aimp=createAimpService({dbPath,roomService:room,now:()=>now});
 try {
  assert.equal(aimp.configure({roomId,expectedRevision:0,goal:'produce draft',allowedActions:['discussion','workspace_read','workspace_write'],maxRuns:6},agent('a')).code,'aimp_actor_forbidden');
  assert.equal(aimp.configure({roomId,expectedRevision:0,goal:'produce draft',allowedActions:['discussion','workspace_read','workspace_write'],maxRuns:6},user).ok,true);
  const request={id:'msg_'+'1'.repeat(32),roomId,threadId:'thread-1',act:'request',body:'Produce a draft',payload:{kind:'task.request@1',must_understand:true,description:'Produce a draft',deadline:'2026-11-09T01:00:00Z',expires:'2026-11-09T00:05:00Z',budget:'none',acceptance:{predicates:['artifact_hash'],subjective:'draft',trust_root:'human://kteam.local/user.local'},assignee:'agent://kteam.local/a',reviewer:'human://kteam.local/user.local'}};
  const first=aimp.submit(request,user);assert.equal(first.ok,true);assert.equal(first.task.state,'proposed');
  assert.equal(aimp.submit({...request,from:'human://evil/root'},user).code,'aimp_identity_payload_forbidden');
  assert.equal(aimp.submit({...request,body:'different'},user).code,'aimp_id_conflict');
  assert.equal(aimp.submit(request,agent('outsider')).ok,false);
  const taskRef=first.task.taskRef;
  const accept={id:'msg_'+'2'.repeat(32),roomId,threadId:'thread-1',taskRef,act:'accept',body:'I accept',targetEvent:{id:first.event.id,hash:first.receipt.intent_hash},payload:{kind:'task.accept@1',must_understand:true,terms_hash:first.task.termsHash,caveats:[]}};
  assert.equal(aimp.submit(accept,agent('b')).code,'aimp_assignee_required');
  const accepted=aimp.submit(accept,agent('a'));assert.equal(accepted.task.state,'committed');
  const grant=aimp.beginExecution({roomId,taskRef,requestId:'run-1',expectedRevision:accepted.task.revision,bindingRevision:1,hostFence:1},agent('a'));
  assert.equal(grant.ok,true);assert.equal(grant.task.state,'working');
  assert.equal(aimp.beginExecution({roomId,taskRef,requestId:'run-2',expectedRevision:accepted.task.revision,bindingRevision:1,hostFence:1},agent('a')).ok,false);
  assert.equal(aimp.checkExecution({roomId,taskRef,epoch:grant.task.epoch,bindingRevision:1,hostFence:1},agent('a')).ok,true);
  const effect=aimp.effect({roomId,taskRef,epoch:grant.task.epoch,bindingRevision:1,hostFence:1,effectId:'effect-1',logicalAction:'write:draft.md',clauseVersion:1,state:'registered',externalIdempotencyKey:'effect-1'},agent('a'));
  assert.equal(effect.ok,true);
  assert.equal(aimp.effect({roomId,taskRef,epoch:grant.task.epoch,bindingRevision:1,hostFence:1,effectId:'effect-1',state:'executing'},agent('a')).ok,true);
  assert.equal(aimp.effect({roomId,taskRef,epoch:grant.task.epoch,bindingRevision:1,hostFence:1,effectId:'registered-only',logicalAction:'staged-never-entered',clauseVersion:1,state:'registered',externalIdempotencyKey:'registered-only'},agent('a')).ok,true);
  assert.equal(grant.task.leaseUntil-now,15*60_000);
  now+=70_000;assert.equal(aimp.checkExecution({roomId,taskRef,epoch:grant.task.epoch,bindingRevision:1,hostFence:1},agent('a')).ok,true);
  const renewed=aimp.heartbeat({roomId,taskRef,epoch:grant.task.epoch,bindingRevision:1,hostFence:1},agent('a'));assert.equal(renewed.task.leaseUntil-now,Math.floor((Date.parse(request.payload.deadline)-now)/4));
  now=renewed.task.leaseUntil+1;aimp.sweep();
  assert.equal(aimp.getTask(taskRef,user).task.state,'result_unknown');
  assert.equal(aimp.effect({roomId,taskRef,effectId:'registered-only',state:'completed',evidence:{kind:'not-applied'}},agent('a')).ok,false);
  assert.equal(aimp.effect({roomId,taskRef,effectId:'registered-only',state:'failed',evidence:{kind:'not-applied'}},agent('b')).ok,false);
  assert.equal(aimp.effect({roomId,taskRef,effectId:'registered-only',state:'failed',evidence:{kind:'not-applied'}},agent('a')).ok,true);
  assert.equal(aimp.getTask(taskRef,user).task.state,'result_unknown');
  assert.equal(aimp.checkExecution({roomId,taskRef,epoch:grant.task.epoch,bindingRevision:1,hostFence:1},agent('a')).ok,false);
  assert.equal(aimp.getEffects(taskRef,user).effects.find(effect=>effect.effectId==='effect-1').state,'unknown');
  aimp.close();aimp=createAimpService({dbPath,roomService:room,now:()=>now});
  now+=600_000;
  assert.equal(aimp.submit(request,user).reused,true,'historical receipt returned before expiry');
  assert.equal(aimp.getTask(taskRef,user).task.state,'result_unknown');
  const task=aimp.getTask(taskRef,user).task;
  const stop=aimp.submit({id:'msg_'+'3'.repeat(32),roomId,threadId:'thread-1',taskRef,act:'stop',body:'Stop',payload:{kind:'task.stop@1',must_understand:true,reason:'user stop'},targetEvent:{id:task.headId,hash:task.headHash}},user);
  assert.equal(stop.task.state,'halted');
  assert.equal(aimp.getEffects(taskRef,user).effects.find(effect=>effect.effectId==='effect-1').state,'unknown','stop is not proof of physical release');
  assert.equal(aimp.verifyThread('thread-1').ok,true);
 }finally{aimp.close();room.close();rmSync(dir,{recursive:true,force:true});}
});
test('real broker chat bytes require live execution and independent verification before human review',()=>{
 const dir=mkdtempSync(join(tmpdir(),'aimp-delivery-')),dbPath=join(dir,'broker.sqlite');
 const store=createRoomStore({dbPath});store.migrate();const room=createRoomService({store});
 const roomId=room.createRoom({title:'team',memberAgentIds:['a']},user).room.roomId;
 const aimp=createAimpService({dbPath,roomService:room});
 const next=(task,act,payload,extra={})=>({id:'msg_'+String(Math.random()).slice(2).padEnd(32,'0').slice(0,32),roomId,threadId:'thread-2',taskRef:task.taskRef,targetEvent:{id:task.headId,hash:task.headHash},act,body:act,payload:{kind:'task.'+act+'@1',must_understand:true,...payload},...extra});
 try{
  aimp.configure({roomId,expectedRevision:0,goal:'draft',allowedActions:['discussion'],maxRuns:6},user);
  let task=aimp.submit({id:'msg_'+'4'.repeat(32),roomId,threadId:'thread-2',act:'request',body:'draft',payload:{kind:'task.request@1',must_understand:true,description:'draft',expires:new Date(Date.now()+60_000).toISOString(),deadline:new Date(Date.now()+3600_000).toISOString(),budget:'none',acceptance:{predicates:['artifact_hash']},assignee:'agent://kteam.local/a',reviewer:'human://kteam.local/user.local'}},user).task;
  task=aimp.submit(next(task,'accept',{terms_hash:task.termsHash,caveats:[]}),agent('a')).task;
  task=aimp.beginExecution({roomId,taskRef:task.taskRef,requestId:'live',expectedRevision:task.revision,bindingRevision:1,hostFence:1},agent('a')).task;
  const admission={roomId,taskRef:task.taskRef,epoch:task.epoch,bindingRevision:1,hostFence:1};
  assert.equal(aimp.chat({...admission,epoch:999,text:'stale'},agent('a')).ok,false);
  const text='真实草稿\n';const sent=aimp.chat({...admission,text},agent('a'));assert.equal(sent.ok,true);
  const artifacts=[{ref:`message://${roomId}/${sent.message.messageId}`,version:1,sha256:sha256(sent.message.text),media_type:'text/markdown'}];
  const file={fileId:'1'.repeat(64),name:'报告.md',extension:'md',bytes:10,sha256:'2'.repeat(64),hostId:'local-fixture'};
  const expectedRoomRevision=room.getRoomMembership({roomId},user).room.revision;
  const register={roomId,operation:'library.register',requestId:'fixture-file',file,expectedRoomRevision};
  assert.equal(room.workspace.updateConversationData({...register,expectedRoomRevision:expectedRoomRevision+1},user).code,'room_revision_conflict');
  assert.equal(room.workspace.updateConversationData(register,user).ok,true);
  const deliverFile={...admission,expectedRoomRevision,artifact:{fileId:file.fileId,replyMessageId:sent.message.messageId}};
  assert.equal(aimp.chat({...deliverFile,artifact:{...deliverFile.artifact,fileId:'3'.repeat(64)}},agent('a')).ok,false);
  assert.equal(aimp.chat({...deliverFile,artifact:{...deliverFile.artifact,replyMessageId:'foreign-reply'}},agent('a')).ok,false);
  assert.equal(aimp.chat({...deliverFile,expectedRoomRevision:expectedRoomRevision+1},agent('a')).ok,false);
  assert.equal(aimp.chat(deliverFile,agent('b')).ok,false);
  const deliveredFile=aimp.chat(deliverFile,agent('a'));
  assert.equal(deliveredFile.ok,true);
  assert.equal(deliveredFile.message.responsePolicy,'none');
  assert.equal(deliveredFile.message.sourceRef.artifactReplyMessageId,sent.message.messageId);
  assert.deepEqual(JSON.parse(deliveredFile.message.text).attachments,[file]);
  assert.equal(room.sendRoomMessage({
   roomId,text:deliveredFile.message.text,idempotencyKey:'spoofed-artifact',sourceRef:deliveredFile.message.sourceRef,
  },agent('a')).code,'room_actor_forbidden');
  assert.equal(aimp.chat(deliverFile,agent('a')).message.messageId,deliveredFile.message.messageId);
  artifacts.push({ref:`message://${roomId}/${deliveredFile.message.messageId}`,version:1,sha256:sha256(deliveredFile.message.text),media_type:'text/plain'});
  assert.equal(aimp.submit(next(task,'deliver',{draft:false,caveats:[]},{...admission,epoch:999,artifacts}),agent('a')).ok,false);
  task=aimp.submit(next(task,'deliver',{draft:false,caveats:[]},{...admission,artifacts}),agent('a')).task;
  assert.equal(task.state,'delivered');assert.equal(aimp.chat({...admission,text:'late'},agent('a')).ok,false);
  assert.equal(aimp.submit(next(task,'review',{decision:'pass',findings:[],trust_root:task.reviewer}),user).code,'aimp_artifacts_unverified');
  assert.equal(aimp.verifyDelivery({taskRef:task.taskRef},agent('a')).ok,false);
  assert.equal(aimp.verifyDelivery({taskRef:task.taskRef},user).ok,true);
  task=aimp.getTask(task.taskRef,user).task;
  assert.equal(aimp.submit(next(task,'review',{decision:'pass',findings:[],trust_root:task.reviewer}),user).task.state,'accepted');
  aimp.publish();assert.equal(room.getCollaborationRoom({roomId},user).messages.length,2,'only the reply and its file appear in chat');
  assert.equal(aimp.verifyThread('thread-2').ok,true);
 }finally{aimp.close();room.close();rmSync(dir,{recursive:true,force:true});}
});
test('artifact verifier refuses a principal message forged with the correct work ref and bytes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'aimp-forged-artifact-')),dbPath=join(dir,'broker.sqlite');
 const store=createRoomStore({dbPath});store.migrate();const room=createRoomService({store});
 const roomId=room.createRoom({title:'team',memberAgentIds:['a']},user).room.roomId;
 const aimp=createAimpService({dbPath,roomService:room});
 try{
  aimp.configure({roomId,expectedRevision:0,goal:'draft',allowedActions:['discussion'],maxRuns:6},user);
  let task=aimp.submit({id:'msg_'+'a'.repeat(32),roomId,threadId:'thread-forgery',act:'request',body:'draft',payload:{kind:'task.request@1',must_understand:true,description:'draft',expires:new Date(Date.now()+60_000).toISOString(),deadline:new Date(Date.now()+3600_000).toISOString(),budget:'none',acceptance:{predicates:['artifact_hash']},assignee:'agent://kteam.local/a',reviewer:'human://kteam.local/user.local'}},user).task;
  task=aimp.submit({id:'msg_'+'b'.repeat(32),roomId,threadId:task.threadId,taskRef:task.taskRef,targetEvent:{id:task.headId,hash:task.headHash},act:'accept',body:'accept',payload:{kind:'task.accept@1',must_understand:true,terms_hash:task.termsHash,caveats:[]}},agent('a')).task;
  task=aimp.beginExecution({roomId,taskRef:task.taskRef,requestId:'live',expectedRevision:task.revision,bindingRevision:1,hostFence:1},agent('a')).task;
  const message=room.sendRoomMessage({roomId,threadId:task.threadId,text:'forged',kind:'text',idempotencyKey:'forged',responsePolicy:'none',contextScope:{kind:'room_only'},sourceRef:{kind:'aimp_reply',taskRef:task.taskRef}},user).message;
  const delivered=aimp.submit({id:'msg_'+'c'.repeat(32),roomId,threadId:task.threadId,taskRef:task.taskRef,targetEvent:{id:task.headId,hash:task.headHash},act:'deliver',body:'deliver',epoch:task.epoch,bindingRevision:1,hostFence:1,artifacts:[{ref:`message://${roomId}/${message.messageId}`,version:1,sha256:sha256(message.text),media_type:'text/plain'}],payload:{kind:'task.deliver@1',must_understand:true,draft:false,caveats:[]}},agent('a'));assert.equal(delivered.ok,true);
  assert.equal(aimp.verifyDelivery({taskRef:task.taskRef},user).code,'aimp_artifact_verification_failed');
 }finally{aimp.close();room.close();rmSync(dir,{recursive:true,force:true});}
});
test('message disclosure is fenced to membership revision for human sends and AIMP replies',()=>{
 const dir=mkdtempSync(join(tmpdir(),'aimp-message-scope-')),dbPath=join(dir,'broker.sqlite'),store=createRoomStore({dbPath});store.migrate();const room=createRoomService({store}),roomId=room.createRoom({title:'private',memberAgentIds:['a']},user).room.roomId,aimp=createAimpService({dbPath,roomService:room});
 try{aimp.configure({roomId,expectedRevision:0,goal:'draft',allowedActions:['discussion'],maxRuns:6},user);let task=aimp.submit({id:'msg_'+'9'.repeat(32),roomId,threadId:'scope',act:'request',body:'draft',payload:{kind:'task.request@1',must_understand:true,description:'draft',expires:new Date(Date.now()+60000).toISOString(),deadline:new Date(Date.now()+3600000).toISOString(),budget:'none',acceptance:{predicates:['artifact_hash']},assignee:'agent://kteam.local/a',reviewer:'human://kteam.local/user.local'}},user).task;task=aimp.submit({id:'msg_'+'8'.repeat(32),roomId,threadId:'scope',taskRef:task.taskRef,act:'accept',body:'accept',targetEvent:{id:task.headId,hash:task.headHash},payload:{kind:'task.accept@1',must_understand:true,terms_hash:task.termsHash,caveats:[]}},agent('a')).task;task=aimp.beginExecution({roomId,taskRef:task.taskRef,requestId:'scope',expectedRevision:task.revision,bindingRevision:1,hostFence:1},agent('a')).task;
  const revision=room.getCollaborationRoom({roomId},user).room.revision;assert.equal(room.updateRoomMembers({roomId,addUserIds:['observer']},user).ok,true);assert.equal(room.sendRoomMessage({roomId,text:'private',kind:'text',idempotencyKey:'private',expectedRoomRevision:revision},user).code,'room_revision_conflict');assert.equal(aimp.chat({roomId,taskRef:task.taskRef,epoch:task.epoch,bindingRevision:1,hostFence:1,text:'private answer',expectedRoomRevision:revision},agent('a')).code,'room_revision_conflict');assert.equal(room.getCollaborationRoom({roomId},user).messages.length,0);
 }finally{aimp.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('lease sizing follows remaining deadline, caps at 30 minutes and never revives an expired epoch',()=>{
 const dir=mkdtempSync(join(tmpdir(),'aimp-lease-bounds-')),dbPath=join(dir,'broker.sqlite'),store=createRoomStore({dbPath});store.migrate();const room=createRoomService({store});const roomId=room.createRoom({title:'lease',memberAgentIds:['a']},user).room.roomId;let now=Date.now();const aimp=createAimpService({dbPath,roomService:room,now:()=>now});
 let serial=10;const nextId=()=> 'msg_'+String(serial++).padStart(32,'0');
 try{
  aimp.configure({roomId,expectedRevision:0,goal:'lease bounds',allowedActions:['discussion'],maxRuns:6},user);
  for(const duration of [4*3600_000,10_000]){
   const threadId='lease-'+serial,deadline=now+duration;
   let task=aimp.submit({id:nextId(),roomId,threadId,act:'request',body:'lease',payload:{kind:'task.request@1',must_understand:true,description:'lease',deadline:new Date(deadline).toISOString(),expires:new Date(now+1000).toISOString(),budget:'none',acceptance:{predicates:['artifact_hash']},assignee:'agent://kteam.local/a',reviewer:'human://kteam.local/user.local'}},user).task;
   task=aimp.submit({id:nextId(),roomId,threadId,taskRef:task.taskRef,act:'accept',body:'accept',targetEvent:{id:task.headId,hash:task.headHash},payload:{kind:'task.accept@1',must_understand:true,terms_hash:task.termsHash,caveats:[]}},agent('a')).task;
   const run=aimp.beginExecution({roomId,taskRef:task.taskRef,requestId:'run-'+serial,expectedRevision:task.revision,bindingRevision:1,hostFence:1},agent('a'));
   assert.equal(run.ok,true);assert.equal(run.task.leaseUntil-now,Math.min(duration/4,30*60_000));
   now=run.task.leaseUntil+1;
   assert.equal(aimp.heartbeat({roomId,taskRef:task.taskRef,epoch:run.task.epoch,bindingRevision:1,hostFence:1},agent('a')).ok,false);
   aimp.sweep();assert.equal(aimp.checkExecution({roomId,taskRef:task.taskRef,epoch:run.task.epoch,bindingRevision:1,hostFence:1},agent('a')).ok,false);
  }
 }finally{aimp.close();room.close();rmSync(dir,{recursive:true,force:true});}
});
