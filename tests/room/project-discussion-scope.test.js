import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomStore } from '../../src/room/store.js';
import { createRoomService } from '../../src/room/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';
const user = {sessionId:'u',requestSource:'user',actor:{kind:'user',userId:'user.local'},allowedLogicalAgentIds:[],issuedAt:new Date().toISOString()};
const agent = {sessionId:'a',requestSource:'agent',actor:{kind:'agent',logicalAgentId:'a'},allowedLogicalAgentIds:['a'],issuedAt:new Date().toISOString()};
test('abandon only owns exact historical host wake and closes revoked execution without reply',async()=>{
  const store=createRoomStore({dbPath:createTempDbPath()});store.migrate();const service=createRoomService({store});
  try {
    const ctx={...user,hostPrincipal:'owner-install'};
    const roomId=service.createRoom({title:'cleanup',memberAgentIds:['a']},ctx).room.roomId;
    ctx.hostIncarnation=service.workspace.registerHost({startupId:'boot'},ctx).host.hostIncarnation;
    const source=service.sendRoomMessage({roomId,text:'work',responsePolicy:'mentioned',mentions:[{kind:'agent',logicalAgentId:'a'}],idempotencyKey:'cleanup'},ctx).message;
    const wake=service.workspace.claimWake({roomId,roomMessageId:source.messageId,logicalAgentId:'a',discussionOnly:true},{...ctx,...agent});
    assert.equal(wake.ok,true);
    const input={roomId,claimToken:wake.claimToken,reason:'execution_failed'};
    const alien={...ctx,hostPrincipal:'alien'};alien.hostIncarnation=service.workspace.registerHost({startupId:'alien'},alien).host.hostIncarnation;
    for(const [value,actor] of [[input,alien],[{...input,roomId:'wrong'},ctx],[{...input,claimToken:wake.claimToken+'wrong'},ctx],[input,{...ctx,...agent}]]) assert.equal(service.workspace.abandonWake(value,actor).ok,false);
    service.archiveRoom({roomId},ctx);
    assert.equal((await service.completeWake({claimToken:wake.claimToken,reply:{kind:'text',text:'MUST_NOT_PUBLISH'}})).ok,false);
    assert.equal(service.workspace.abandonWake(input,ctx).ok,true);
    assert.equal(service.workspace.abandonWake(input,ctx).ok,true);
    assert.equal(store.getDelivery(source.messageId,'agent:a').wakeStatus,'failed');
    assert.equal(store.listMessages(roomId).some(m=>m.text==='MUST_NOT_PUBLISH'),false);
  }finally{service.close();}
});
for(const project of [false,true]) test(`history and completion bind source scope, project=${project}`,async()=>{
  const store=createRoomStore({dbPath:createTempDbPath()});store.migrate();const service=createRoomService({store});
  try {
    const roomId=service.createRoom({title:'scope',memberAgentIds:['a']},user).room.roomId;
    const scopes=project?[{kind:'room_only'},{kind:'project',projectId:'p2'},{kind:'project',projectId:'p1'}]:[{kind:'project',projectId:'p1'},{kind:'project',projectId:'p2'},{kind:'room_only'}];
    const messages=scopes.map((contextScope,i)=>service.sendRoomMessage({roomId,text:`secret-${i}`,contextScope,responsePolicy:'mentioned',mentions:[{kind:'agent',logicalAgentId:'a'}],idempotencyKey:`m${i}`},user).message);
    const source=messages.at(-1);const scope=scopes.at(-1);
    const wake=service.claimWake({roomMessageId:source.messageId,logicalAgentId:'a'},agent);assert.equal(wake.ok,true);
    const page=service.listRoomMessagesPage({roomId,claimToken:wake.claimToken,limit:1,contextScope:scopes[0]});
    assert.equal(page.ok,true);assert.deepEqual(page.messages.map(m=>m.messageId),[source.messageId]);assert.equal(page.totalMessages,1);assert.equal(page.hasMoreAfter,false);assert.equal(page.hasMoreBefore,false);
    const done=await service.completeWake({claimToken:wake.claimToken,reply:{kind:'text',text:'scoped reply',contextScope:scopes[0]}});assert.equal(done.ok,true);
    const reply=store.listMessages(roomId).find(m=>m.text==='scoped reply');assert.deepEqual(reply.contextScope,scope);
  } finally {service.close();}
});
test('workspace project discussion wake has no filesystem claim and ignores caller scope assertions',async()=>{
  const store=createRoomStore({dbPath:createTempDbPath()});store.migrate();const service=createRoomService({store});
  try {
    const ctx={...user,hostPrincipal:'same-install'};
    const roomId=service.createRoom({title:'workspace discussion',memberAgentIds:['a']},ctx).room.roomId;
    ctx.hostIncarnation=service.workspace.registerHost({startupId:'boot'},ctx).host.hostIncarnation;
    const agentContext={...ctx,...agent};
    const source=service.sendRoomMessage({roomId,text:'project only',contextScope:{kind:'project',projectId:'p1'},responsePolicy:'mentioned',mentions:[{kind:'agent',logicalAgentId:'a'}],idempotencyKey:'project-discuss'},ctx).message;
    const wake=service.workspace.claimWake({roomId,roomMessageId:source.messageId,logicalAgentId:'a',discussionOnly:true,contextScope:{kind:'project',projectId:'p2'},projectAuthorization:{verified:true}},agentContext);
    assert.equal(wake.ok,true,JSON.stringify(wake));
    assert.equal(service.workspace.getState({roomId},ctx).claims.length,0);
    const done=await service.completeWake({claimToken:wake.claimToken,reply:{kind:'text',text:'scoped'}});assert.equal(done.ok,true);
    assert.equal(service.workspace.abandonWake({roomId,claimToken:wake.claimToken},ctx).wakeStatus,'completed');
    assert.equal(store.getDelivery(source.messageId,'agent:a').wakeStatus,'completed');
    service.workspace.registerHost({startupId:'new-boot'},ctx);
    assert.equal(service.workspace.abandonWake({roomId,claimToken:wake.claimToken},ctx).ok,false);
    assert.deepEqual(store.listMessages(roomId).at(-1).contextScope,{kind:'project',projectId:'p1'});
  }finally{service.close();}
});
