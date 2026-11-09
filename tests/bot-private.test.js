import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {createRoomStore} from '../src/room/store.js';
import {createRoomService} from '../src/room/service.js';
import {createAimpService} from '../src/aimp/service.js';
import {sendBotPrivateMessage} from '../src/room/bot-private.js';
const user={sessionId:'bot-private-proof',requestSource:'user',actor:{kind:'user',userId:'user.local'},issuedAt:new Date().toISOString()};
const agent=id=>({...user,requestSource:'agent',actor:{kind:'agent',logicalAgentId:id},allowedLogicalAgentIds:[id]});
const id=()=>'msg_'+randomBytes(16).toString('hex');
test('private Bot messages require source execution, exact private recipients and preserve provenance without execution authority',()=>{
 const root=mkdtempSync(join(tmpdir(),'bot-private-proof-')),dbPath=join(root,'room.sqlite'),store=createRoomStore({dbPath});store.migrate();const roomService=createRoomService({store}),aimp=createAimpService({dbPath,roomService});
 try{
  const source=roomService.createRoom({title:'source',memberAgentIds:['a','b']},user).room.roomId,target=roomService.createRoom({title:'private',memberAgentIds:['a']},user).room.roomId;
  aimp.configure({roomId:source,goal:'review',expectedRevision:0,maxRuns:6,allowedActions:['discussion']},user);
  let task=aimp.submit({id:id(),roomId:source,threadId:'source',act:'request',body:'review',payload:{kind:'task.request@1',must_understand:true,description:'review',deadline:new Date(Date.now()+3600000).toISOString(),expires:new Date(Date.now()+300000).toISOString(),budget:'none',acceptance:{predicates:['artifact_hash']},assignee:'agent://kteam.local/a',reviewer:'human://kteam.local/user.local'}},user).task;
  task=aimp.submit({id:id(),roomId:source,threadId:'source',taskRef:task.taskRef,act:'accept',body:'accept',targetEvent:{id:task.headId,hash:task.headHash},payload:{kind:'task.accept@1',must_understand:true,terms_hash:task.termsHash,caveats:[]}},agent('a')).task;
  task=aimp.beginExecution({roomId:source,taskRef:task.taskRef,requestId:'run',expectedRevision:task.revision,bindingRevision:1,hostFence:1},agent('a')).task;
  const input={logicalAgentId:'a',sourceRoomId:source,admission:{taskRef:task.taskRef,epoch:task.epoch,bindingRevision:1,hostFence:1},text:'Choose review scope',idempotencyKey:'question-one',expectedRoomRevision:roomService.getRoomMembership({roomId:target},user).room.revision,purpose:'question'};
  const send=patch=>sendBotPrivateMessage({roomService,aimp,roomId:target,input:{...input,...patch},ctx:user});
  assert.equal(send({actor:{kind:'agent',logicalAgentId:'a'}}).ok,false);
  assert.equal(send({logicalAgentId:'b'}).ok,false);
  const sent=send({});assert.equal(sent.ok,true,JSON.stringify(sent));assert.equal(sent.message.sender.logicalAgentId,'a');assert.equal(sent.message.sourceRef.originRoomId,source);assert.equal(sent.message.sourceRef.verifiedExecution,false);assert.equal(aimp.getSession(target,user).session,null);
  roomService.updateRoomMembers({roomId:target,addUserIds:['observer']},user);
  assert.equal(send({idempotencyKey:'not-private',expectedRoomRevision:roomService.getRoomMembership({roomId:target},user).room.revision}).code,'bot_private_target_invalid');
  assert.equal(roomService.getCollaborationRoom({roomId:target},user).messages.length,1);
 }finally{aimp.close();roomService.close();rmSync(root,{recursive:true,force:true});}
});
