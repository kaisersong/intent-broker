// Host-owned bot messaging. Source execution admission never becomes target execution authority.
export function sendBotPrivateMessage({roomService,aimp,roomId,input,ctx}) {
 const fail=code=>({ok:false,code});
 const allowed=['logicalAgentId','sourceRoomId','admission','text','threadId','idempotencyKey','expectedRoomRevision','recipientLogicalAgentId','originMessageId','exchangeId','purpose'];
 if(!ctx||ctx.requestSource!=='user'||ctx.actor?.kind!=='user'||Object.keys(input).some(k=>!allowed.includes(k))||typeof input.logicalAgentId!=='string'||typeof input.sourceRoomId!=='string'||!input.admission||typeof input.text!=='string'||!input.text.trim()||input.text.length>8192||!Number.isSafeInteger(input.expectedRoomRevision)||typeof input.idempotencyKey!=='string'||!input.idempotencyKey||!['question','consult','notice','approval'].includes(input.purpose))return fail('bot_private_input_invalid');
 const actor={...ctx,requestSource:'agent',actor:{kind:'agent',logicalAgentId:input.logicalAgentId},allowedLogicalAgentIds:[input.logicalAgentId]};
 const check=aimp.checkExecution({...input.admission,roomId:input.sourceRoomId},actor);if(!check.ok)return check;
 const source=roomService.getRoomMembership({roomId:input.sourceRoomId},ctx),target=roomService.getRoomMembership({roomId},ctx);
 if(!source.ok)return source;if(!target.ok)return target;
 const active=(snapshot,kind,id)=>snapshot.members?.some(m=>m.status==='active'&&m.subject?.kind===kind&&(kind==='user'?m.subject.userId:m.subject.logicalAgentId)===id);
 if(source.room?.status!=='active'||target.room?.status!=='active'||!active(source,'agent',input.logicalAgentId)||!active(source,'user',ctx.actor.userId)||!active(target,'user',ctx.actor.userId)||!active(target,'agent',input.logicalAgentId))return fail('bot_private_scope_denied');
 if(input.recipientLogicalAgentId&&(!active(source,'agent',input.recipientLogicalAgentId)||!active(target,'agent',input.recipientLogicalAgentId)||input.recipientLogicalAgentId===input.logicalAgentId))return fail('bot_private_scope_denied');
 const activeTarget=target.members.filter(m=>m.status==='active');
 const humans=activeTarget.filter(m=>m.subject?.kind==='user');
 if(humans.length!==1||humans[0].subject.userId!==ctx.actor.userId||humans[0].role!=='owner')return fail('bot_private_target_invalid');
 const agents=activeTarget.filter(m=>m.subject?.kind==='agent');
 if(activeTarget.length!==agents.length+1)return fail('bot_private_target_invalid');
 if(agents.length!==(input.recipientLogicalAgentId?2:1))return fail('bot_private_target_invalid');
 return roomService.sendRoomMessage({roomId,kind:'text',contextScope:{kind:'room_only'},responsePolicy:'none',text:input.text,threadId:input.threadId,idempotencyKey:input.idempotencyKey,expectedRoomRevision:input.expectedRoomRevision,sourceRef:{kind:'bot_private_message',verifiedExecution:false,originRoomId:input.sourceRoomId,originTaskRef:input.admission.taskRef,originMessageId:input.originMessageId,exchangeId:input.exchangeId,recipientLogicalAgentId:input.recipientLogicalAgentId,purpose:input.purpose}},actor);
}
