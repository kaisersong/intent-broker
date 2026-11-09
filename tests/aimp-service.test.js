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
  now+=70_000;aimp.sweep();
  assert.equal(aimp.getTask(taskRef,user).task.state,'result_unknown');
  assert.equal(aimp.checkExecution({roomId,taskRef,epoch:grant.task.epoch,bindingRevision:1,hostFence:1},agent('a')).ok,false);
  assert.equal(aimp.getEffects(taskRef,user).effects[0].state,'unknown');
  aimp.close();aimp=createAimpService({dbPath,roomService:room,now:()=>now});
  now+=600_000;
  assert.equal(aimp.submit(request,user).reused,true,'historical receipt returned before expiry');
  assert.equal(aimp.getTask(taskRef,user).task.state,'result_unknown');
  const task=aimp.getTask(taskRef,user).task;
  const stop=aimp.submit({id:'msg_'+'3'.repeat(32),roomId,threadId:'thread-1',taskRef,act:'stop',body:'Stop',payload:{kind:'task.stop@1',must_understand:true,reason:'user stop'},targetEvent:{id:task.headId,hash:task.headHash}},user);
  assert.equal(stop.task.state,'halted');
  assert.equal(aimp.getEffects(taskRef,user).effects[0].state,'unknown','stop is not proof of physical release');
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
  assert.equal(aimp.submit(next(task,'deliver',{draft:false,caveats:[]},{...admission,epoch:999,artifacts}),agent('a')).ok,false);
  task=aimp.submit(next(task,'deliver',{draft:false,caveats:[]},{...admission,artifacts}),agent('a')).task;
  assert.equal(task.state,'delivered');assert.equal(aimp.chat({...admission,text:'late'},agent('a')).ok,false);
  assert.equal(aimp.submit(next(task,'review',{decision:'pass',findings:[],trust_root:task.reviewer}),user).code,'aimp_artifacts_unverified');
  assert.equal(aimp.verifyDelivery({taskRef:task.taskRef},agent('a')).ok,false);
  assert.equal(aimp.verifyDelivery({taskRef:task.taskRef},user).ok,true);
  task=aimp.getTask(task.taskRef,user).task;
  assert.equal(aimp.submit(next(task,'review',{decision:'pass',findings:[],trust_root:task.reviewer}),user).task.state,'accepted');
  aimp.publish();assert.equal(room.getCollaborationRoom({roomId},user).messages.length,1,'protocol telemetry is not duplicate chat');
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
