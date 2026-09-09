import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomStore } from '../../src/room/store.js';
import { createRoomService } from '../../src/room/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';
test('restart recovers only own exact historical wake without restoring execution authority', async()=>{
  const dbPath=createTempDbPath();let store=createRoomStore({dbPath});store.migrate();let service=createRoomService({store});
  const user={sessionId:'u',requestSource:'user',actor:{kind:'user',userId:'user.local'},allowedLogicalAgentIds:[],issuedAt:new Date().toISOString(),hostPrincipal:'install'};
  const old={...user,hostIncarnation:service.workspace.registerHost({startupId:'old'},user).host.hostIncarnation};
  const roomId=service.createRoom({title:'recovery',memberAgentIds:['a']},old).room.roomId;
  const claim=(key,ctx)=>{const source=service.sendRoomMessage({roomId,text:'PRIVATE',contextScope:{kind:'project',projectId:'p'},responsePolicy:'mentioned',mentions:[{kind:'agent',logicalAgentId:'a'}],idempotencyKey:key},ctx).message;return service.workspace.claimWake({roomId,roomMessageId:source.messageId,logicalAgentId:'a',discussionOnly:true},{...ctx,requestSource:'agent',actor:{kind:'agent',logicalAgentId:'a'},allowedLogicalAgentIds:['a']});};
  const first=claim('first',old);assert.equal(first.ok,true);service.close();
  store=createRoomStore({dbPath});store.migrate();service=createRoomService({store});
  try{
    const current={...user,hostIncarnation:service.workspace.registerHost({startupId:'new'},user).host.hostIncarnation};
    const input={roomId,claimToken:first.claimToken};
    const recovered=service.workspace.recoverWake(input,current);assert.equal(recovered.ok,true);
    assert.deepEqual(Object.keys(recovered.wake).sort(),['contextScope','logicalAgentId','roomId','roomMessageId','wakeStatus']);
    assert.equal(recovered.wake.wakeStatus,'claimed');assert.equal(JSON.stringify(recovered).includes('PRIVATE'),false);
    const alien={...user,hostPrincipal:'alien'};alien.hostIncarnation=service.workspace.registerHost({startupId:'alien'},alien).host.hostIncarnation;
    for(const [request,ctx] of [[input,old],[input,alien],[{...input,roomId:'other'},current],[{...input,claimToken:first.claimToken+'bad'},current],[input,{...current,requestSource:'agent',actor:{kind:'agent',logicalAgentId:'a'},allowedLogicalAgentIds:['a']}]])for(const method of ['recoverWake','abandonWake'])assert.equal(service.workspace[method](request,ctx).ok,false);
    assert.equal(service.workspace.abandonWake(input,current).wakeStatus,'failed');
    assert.equal(service.workspace.recoverWake(input,current).wake.wakeStatus,'failed');
    const next=claim('next',current);assert.equal(next.ok,true);
    assert.equal(service.workspace.abandonWake({roomId,claimToken:next.claimToken},old).ok,false);
    assert.equal((await service.completeWake({claimToken:next.claimToken,reply:{kind:'text',text:'actual reply'}})).ok,true);
    assert.equal(service.workspace.abandonWake({roomId,claimToken:next.claimToken},current).wakeStatus,'completed');
    assert.equal(store.listMessages(roomId).filter(m=>m.text==='actual reply').length,1);
  }finally{service.close();}
});
