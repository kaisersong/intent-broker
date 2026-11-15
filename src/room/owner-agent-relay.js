/** Authenticated owner relay. A source execution admission never grants target tool authority. */
export function sendOwnerAgentRelayMessage({roomService,aimp,roomId,input,ctx}){
 const fail=code=>({ok:false,code});
 const allowed=['logicalAgentId','sourceRoomId','admission','text','idempotencyKey','expectedRoomRevision','originMessageId','recipientLogicalAgentId'];
 if(!ctx||ctx.requestSource!=='user'||ctx.actor?.kind!=='user'||Object.keys(input).some(key=>!allowed.includes(key))||typeof input.logicalAgentId!=='string'||typeof input.sourceRoomId!=='string'||!input.admission||typeof input.text!=='string'||!input.text.trim()||input.text.length>6000||typeof input.idempotencyKey!=='string'||!input.idempotencyKey||!Number.isSafeInteger(input.expectedRoomRevision))return fail('owner_agent_relay_invalid');
 const actor={...ctx,requestSource:'agent',actor:{kind:'agent',logicalAgentId:input.logicalAgentId},allowedLogicalAgentIds:[input.logicalAgentId]};
 const admission=aimp.checkExecution({...input.admission,roomId:input.sourceRoomId},actor);if(!admission.ok)return admission;
 const target=roomService.getRoomMembership({roomId},ctx);if(!target.ok)return target;
 if(input.recipientLogicalAgentId&&!target.members.some(member=>member.status==='active'&&member.subject?.logicalAgentId===input.recipientLogicalAgentId))return fail('room_actor_forbidden');
 return roomService.sendOwnerAgentRelay({roomId,sourceRoomId:input.sourceRoomId,logicalAgentId:input.logicalAgentId,kind:'text',contextScope:{kind:'room_only'},responsePolicy:'none',text:input.text,threadId:'owner-agent-relay',idempotencyKey:input.idempotencyKey,expectedRoomRevision:input.expectedRoomRevision,sourceRef:{kind:'assistant_relay',verifiedExecution:false,originRoomId:input.sourceRoomId,originTaskRef:input.admission.taskRef,originMessageId:input.originMessageId,relayId:input.idempotencyKey,recipientLogicalAgentId:input.recipientLogicalAgentId}},ctx);
}
