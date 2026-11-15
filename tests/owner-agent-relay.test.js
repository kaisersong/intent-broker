import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {createRoomStore} from '../src/room/store.js';
import {createRoomService} from '../src/room/service.js';
import {createAimpService} from '../src/aimp/service.js';
import {sendOwnerAgentRelayMessage} from '../src/room/owner-agent-relay.js';
const user={sessionId:'bot-private-proof',requestSource:'user',actor:{kind:'user',userId:'user.local'},issuedAt:new Date().toISOString()};
const agent=id=>({...user,requestSource:'agent',actor:{kind:'agent',logicalAgentId:id},allowedLogicalAgentIds:[id]});
const id=()=>'msg_'+randomBytes(16).toString('hex');
test('owner relay requires live source admission and ownership of both rooms, preserves sender without changing members',()=>{
 const root=mkdtempSync(join(tmpdir(),'owner-relay-proof-')),dbPath=join(root,'room.sqlite'),store=createRoomStore({dbPath});store.migrate();const roomService=createRoomService({store}),aimp=createAimpService({dbPath,roomService});
 try{
  const source=roomService.createRoom({title:'master',memberAgentIds:['a']},user).room.roomId,target=roomService.createRoom({title:'team',memberAgentIds:['b']},user).room.roomId;
  aimp.configure({roomId:source,goal:'review',expectedRevision:0,maxRuns:6,allowedActions:['discussion']},user);
  let task=aimp.submit({id:id(),roomId:source,threadId:'source',act:'request',body:'review',payload:{kind:'task.request@1',must_understand:true,description:'review',deadline:new Date(Date.now()+3600000).toISOString(),expires:new Date(Date.now()+300000).toISOString(),budget:'none',acceptance:{predicates:['artifact_hash']},assignee:'agent://kteam.local/a',reviewer:'human://kteam.local/user.local'}},user).task;
  task=aimp.submit({id:id(),roomId:source,threadId:'source',taskRef:task.taskRef,act:'accept',body:'accept',targetEvent:{id:task.headId,hash:task.headHash},payload:{kind:'task.accept@1',must_understand:true,terms_hash:task.termsHash,caveats:[]}},agent('a')).task;
  task=aimp.beginExecution({roomId:source,taskRef:task.taskRef,requestId:'run',expectedRevision:task.revision,bindingRevision:1,hostFence:1},agent('a')).task;

  const input={logicalAgentId:'a',sourceRoomId:source,admission:{taskRef:task.taskRef,epoch:task.epoch,bindingRevision:1,hostFence:1},text:'Explicit relay content',idempotencyKey:'relay-one',expectedRoomRevision:roomService.getRoomMembership({roomId:target},user).room.revision,recipientLogicalAgentId:'b'};
  const send=(patch={},ctx=user,roomId=target)=>sendOwnerAgentRelayMessage({roomService,aimp,roomId,input:{...input,...patch},ctx});
  const members=roomService.getRoomMembership({roomId:target},user).members;
  assert.equal(send({},agent('a')).ok,false);assert.equal(send({requestSource:'user'}).ok,false);assert.equal(send({logicalAgentId:'b'}).ok,false);assert.equal(send({admission:{...input.admission,epoch:99}}).ok,false);assert.equal(send({recipientLogicalAgentId:'outsider'}).ok,false);
  const sent=send();assert.equal(sent.ok,true,JSON.stringify(sent));assert.equal(sent.message.sender.logicalAgentId,'a');assert.equal(sent.message.sourceRef.kind,'assistant_relay');assert.equal(sent.message.sourceRef.verifiedExecution,false);assert.equal(send().message.messageId,sent.message.messageId);assert.deepEqual(roomService.getRoomMembership({roomId:target},user).members,members);assert.equal(aimp.getSession(target,user).session,null);
  const foreignUser={...user,actor:{kind:'user',userId:'other-user'}},foreign=roomService.createRoom({title:'foreign',memberAgentIds:['b'],memberUserIds:['user.local']},foreignUser).room.roomId;
  assert.equal(send({idempotencyKey:'foreign',expectedRoomRevision:roomService.getRoomMembership({roomId:foreign},foreignUser).room.revision},user,foreign).ok,false);
  assert.equal(roomService.getCollaborationRoom({roomId:target},user).messages.length,1);
 }finally{aimp.close();roomService.close();rmSync(root,{recursive:true,force:true});}
});
