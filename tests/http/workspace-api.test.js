import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/http/server.js';
import { createBrokerService } from '../../src/broker/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

test('HTTP ticket and cancellation serialize both orders and concurrent races without fake release',async(t)=>{
  const broker=createBrokerService({dbPath:createTempDbPath()});
  const server=createServer({broker,roomService:broker.room,roomDesktopToken:'sequence-secret'});
  await server.listen(0,'127.0.0.1');t.after(async()=>{await server.close();broker.close();});
  const base=`http://127.0.0.1:${server.address().port}`;let incarnation;
  const call=async(path,body)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-intent-broker-room-token':'sequence-secret',...(incarnation?{'x-intent-broker-host-incarnation':String(incarnation)}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return r.json();};
  const roomId=(await call('/rooms',{title:'Sequence race',memberAgentIds:['a']})).room.roomId,root=`/rooms/${roomId}/workspace`;
  incarnation=(await call(root+'/register-host',{startupId:'sequence-boot'})).host.hostIncarnation;
  let config=(await call(root+'/begin-change',{expectedRevision:0,requestId:'bind',payloadDigest:'a'.repeat(64)})).config;
  config=(await call(root+'/commit-binding',{expectedRevision:config.revision,operationId:'bind',workspaceId:'sequence-ws',bindingId:'sequence-binding',payloadDigest:'a'.repeat(64)})).config;
  assert.equal((await call(root+'/activate-binding',{expectedRevision:config.revision,operationId:'bind'})).ok,true);
  const ticketSequences=new Set();let runNumber=0;
  for(const order of ['ticket-first','cancel-first',...Array(8).fill('concurrent')]){
    const runId=`run-${++runNumber}`;
    const admitted=await call(root+'/acquire',{logicalAgentId:'a',runId,executorInstanceId:runId,contextScope:{kind:'room_only'},capability:{contextVersion:1,resultVersion:1,releaseVersion:1,canSetCwd:true,canTrackChildren:true,canRelease:true}});
    assert.equal(admitted.ok,true,JSON.stringify(admitted));const c=admitted.claim;
    assert.equal((await call(root+'/ack',{...c,logicalAgentId:'a',cwdVerified:true,actualCwd:'/sequence-root'})).ok,true);
    const ticketBody={logicalAgentId:'a',claimId:c.claimId,submissionId:runId,payloadDigest:'b'.repeat(64)};
    const ticket=()=>call(root+'/agent-ticket',ticketBody),cancel=()=>call(root+'/cancel',{claimId:c.claimId});
    let issued,cancelled;
    if(order==='ticket-first'){issued=await ticket();cancelled=await cancel();}
    else if(order==='cancel-first'){cancelled=await cancel();issued=await ticket();}
    else [issued,cancelled]=await Promise.all([ticket(),cancel()]);
    assert.equal(cancelled.ok,true);assert.equal(cancelled.claim.executionState,'running');assert.equal(cancelled.claim.authorizationState,'cancel_requested');
    if(order==='ticket-first')assert.equal(issued.ok,true);
    if(order==='cancel-first')assert.equal(issued.ok,false);
    if(issued.ok){
      assert.ok(issued.ticket.commitSequence<cancelled.claim.roomSequence,'ticket must commit before cancellation, never wallclock ordering');
      assert.equal(ticketSequences.has(issued.ticket.commitSequence),false);ticketSequences.add(issued.ticket.commitSequence);
      const recovered=await call(root+'/recover-ticket',{claimId:c.claimId,submissionId:runId,payloadDigest:ticketBody.payloadDigest});
      assert.equal(recovered.ticket?.ticketId,issued.ticket.ticketId,'historical authority survives cancellation');
    }else assert.equal(issued.code,'workspace_claim_revoked');
    assert.equal((await ticket()).code,'workspace_claim_revoked','replay cannot reauthorize cancelled execution');
  }
});

test('workspace HTTP authenticates installation, ignores body actor/host and persists protocol fence',async(t)=>{
  const broker=createBrokerService({dbPath:createTempDbPath()});
  const server=createServer({broker,roomService:broker.room,roomDesktopToken:'desktop-only-secret',roomKSwarmToken:'kswarm-only-secret'});
  await server.listen(0,'127.0.0.1');t.after(async()=>{await server.close();broker.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,body,token='desktop-only-secret',incarnation)=>{
    const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-intent-broker-room-token':token,...(incarnation?{'x-intent-broker-host-incarnation':String(incarnation)}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};
  };
  const roomId=(await call('/rooms',{title:'HTTP workspace',memberAgentIds:['a']})).data.room.roomId;
  assert.equal((await call('/rooms/workspace-protocol',undefined,'wrong')).status,401);
  assert.equal((await call('/rooms/workspace-protocol')).data.protocols.room_workspace_v1.contextVersion,1);
  const root=`/rooms/${roomId}/workspace`;
  assert.equal((await call(root+'/register-host',{startupId:'boot1'},'wrong')).status,401);
  assert.equal((await call(root+'/register-host',{startupId:'boot1'},'kswarm-only-secret')).status,403);
  const host=(await call(root+'/register-host',{startupId:'boot1',hostId:'spoof',hostPrincipal:'spoof'})).data.host;
  assert.notEqual(host.hostId,'spoof');
  const begin={expectedRevision:0,requestId:'change1',payloadDigest:'a'.repeat(64),hostId:'spoof'};
  assert.equal((await call(root+'/begin-change',begin)).data.code,'workspace_host_fenced');
  const first=await call(root+'/begin-change',begin,'desktop-only-secret',host.hostIncarnation);
  assert.equal(first.data.ok,true,JSON.stringify(first));assert.equal(first.data.config.originHostId,host.hostId);
  const state=await call(root);assert.equal(state.data.permissions.canManage,true);assert.equal(state.data.requiredProtocol,'room_workspace_v1');
  const message=(await call(`/rooms/${roomId}/messages`,{text:'work',mentions:[{kind:'agent',logicalAgentId:'a'}],responsePolicy:'mentioned',idempotencyKey:'msg1'})).data.message;
  assert.equal((await call('/room-wakes/claim',{roomMessageId:message.messageId,logicalAgentId:'a'})).data.code,'workspace_protocol_required');
  assert.equal((await call(root+'/verify-mapping-ticket',{ticketId:'fake',projectId:'p',operationId:'x',payloadDigest:'a'.repeat(64)})).status,403);
  assert.equal((await call(root+'/verify-mapping-ticket',{ticketId:'fake',projectId:'p',operationId:'x',payloadDigest:'a'.repeat(64)},'kswarm-only-secret')).data.code,'workspace_ticket_mismatch');
  assert.equal((await call(`/rooms/${roomId}/discussion/cancel`,{requestId:'cancel-http'},'kswarm-only-secret')).status,403);
  const cancelled=await call(`/rooms/${roomId}/discussion/cancel`,{requestId:'cancel-http'});
  assert.equal(cancelled.data.ok,true,JSON.stringify(cancelled));
  assert.equal((await call(`/rooms/${roomId}/discussion/cancel`,{requestId:'cancel-http'})).data.room.discussionEpoch,cancelled.data.room.discussionEpoch);
});
