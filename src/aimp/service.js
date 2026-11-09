import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,randomUUID,createPublicKey} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,lstatSync,renameSync,unlinkSync} from 'node:fs';
import {verifyTrustedActorContext} from '../room/trusted-context.js';
import {canonical,sha256,eventProjection,signatureBytes,signProjection,verifyProjection} from './codec.js';

const address=actor=>actor.kind==='user'?'human://kteam.local/'+encodeURIComponent(actor.userId):actor.kind==='agent'?'agent://kteam.local/'+encodeURIComponent(actor.logicalAgentId):'agent://kteam.local/sequencer';
const nonce=prefix=>prefix+randomUUID().replaceAll('-','');
const failed=(code,extra={})=>({ok:false,code,disposition:'invalid',...extra});
const schemas={
 request:['description','deadline','expires','budget','acceptance','assignee','reviewer'],
 propose:['description','deadline','expires','budget','acceptance','assignee','reviewer'],
 accept:['terms_hash','caveats'],reject:['reason'],cancel:['reason'],stop:['reason'],
 deliver:['draft','caveats'],review:['decision','findings','trust_root'],
 escalate:['reason_code','evidence','mandatory'],resume:['resolved_causes','authorization'],
 delegate:['parent_task','lineage','deadline','expires','budget','inputs','acceptance','assignee','reviewer'],
 counter:['old_terms_hash','terms','terms_hash'],
};
const active=new Set(['proposed','pending_activation','committed','working','blocked','delivered','result_unknown','disputed']);

/** Broker-owned experimental AIMP subset; no profile-compatibility claim.
 * All model output is data. Only authenticated semantic commands can create
 * signed events. No L3 action is admitted by this service. */
export function createAimpService({dbPath,roomService,now=Date.now}={}){
 if(!roomService)throw Error('aimp_room_owner_required');
 const lock=new DatabaseSync(dbPath+'.aimp-owner.sqlite');
 try{lock.exec('BEGIN IMMEDIATE');}catch(error){lock.close();throw Error('aimp_owner_busy');}
 const db=new DatabaseSync(dbPath);
 db.exec(`CREATE TABLE IF NOT EXISTS aimp_meta(id INTEGER PRIMARY KEY,term INTEGER NOT NULL);
 INSERT OR IGNORE INTO aimp_meta VALUES(1,0);
 UPDATE aimp_meta SET term=term+1 WHERE id=1;
 CREATE TABLE IF NOT EXISTS aimp_sessions(room_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,value_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS aimp_tasks(task_ref TEXT PRIMARY KEY,room_id TEXT NOT NULL,thread_id TEXT NOT NULL,value_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS aimp_events(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,thread_id TEXT NOT NULL,task_ref TEXT,seq INTEGER NOT NULL,term INTEGER NOT NULL,chain_hash TEXT NOT NULL,value_json TEXT NOT NULL,UNIQUE(thread_id,seq));
 CREATE TABLE IF NOT EXISTS aimp_receipts(id TEXT PRIMARY KEY,command_hash TEXT NOT NULL,actor TEXT NOT NULL,room_id TEXT NOT NULL,value_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS aimp_effects(effect_id TEXT PRIMARY KEY,task_ref TEXT NOT NULL,logical_action TEXT NOT NULL,clause_version INTEGER NOT NULL,value_json TEXT NOT NULL,UNIQUE(task_ref,logical_action,clause_version));
 CREATE TABLE IF NOT EXISTS aimp_outbox(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,actor_json TEXT NOT NULL,event_json TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);`);
 const term=Number(db.prepare('SELECT term FROM aimp_meta WHERE id=1').get().term);
 const keyPath=dbPath+'.aimp-keys.json';
 let key;
 try{
  if(existsSync(keyPath)){
   const stat=lstatSync(keyPath);if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid?.())))throw Error('aimp_key_file_unsafe');
   key=JSON.parse(readFileSync(keyPath,'utf8'));
  }else{
   const pair=generateKeyPairSync('ed25519');key={privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}),publicKey:pair.publicKey.export({type:'spki',format:'pem'})};
   writeFileSync(keyPath,JSON.stringify(key),{flag:'wx',mode:0o600});
  }
 }catch(error){db.close();lock.close();throw error;}
 let closed=false;
 const readTask=taskRef=>{const row=db.prepare('SELECT value_json FROM aimp_tasks WHERE task_ref=?').get(taskRef);return row?JSON.parse(row.value_json):null;};
 const session=roomId=>{const row=db.prepare('SELECT value_json FROM aimp_sessions WHERE room_id=?').get(roomId);return row?JSON.parse(row.value_json):null;};
 function authorization(roomId,ctx,owner=false){
  if(!verifyTrustedActorContext(ctx).ok)return failed('aimp_authentication_required');
  const result=roomService.getRoomMembership({roomId},ctx);
  if(!result.ok)return result;
  if(result.room.status!=='active')return failed('aimp_room_inactive');
  if(owner&&(ctx.requestSource!=='user'||!result.members.some(m=>m.status==='active'&&m.role==='owner'&&m.subject.kind==='user'&&m.subject.userId===ctx.actor.userId)))return failed('aimp_actor_forbidden');
  return {...result,ok:true};
 }
 function tx(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
 function saveTask(task){db.prepare('INSERT INTO aimp_tasks VALUES(?,?,?,?) ON CONFLICT(task_ref) DO UPDATE SET value_json=excluded.value_json').run(task.taskRef,task.roomId,task.threadId,JSON.stringify(task));}
 function append(event,task,ctx){
  const previous=db.prepare('SELECT seq,chain_hash FROM aimp_events WHERE thread_id=? ORDER BY seq DESC LIMIT 1').get(event.thread_id);
  const domain=event.act.startsWith('sys.')?'system':'intent';
  const intent=eventProjection(event), intentHash=sha256(signatureBytes(domain,intent));
  event.sig=signProjection(domain,intent,key.privateKey);
  const sequencing={intent_hash:intentHash,sender_sig:event.sig,seq:(previous?.seq??0)+1,term,recorded_at:new Date(now()).toISOString(),prev_hash:previous?.chain_hash??'0'.repeat(64),verdict:'sequenced'};
  const chainHash=sha256(signatureBytes('record',sequencing));
  event.sequencing={...sequencing,sig:signProjection('record',sequencing,key.privateKey)};
  db.prepare('INSERT INTO aimp_events VALUES(?,?,?,?,?,?,?,?)').run(event.id,event.room_id,event.thread_id,event.task_ref??null,sequencing.seq,term,chainHash,JSON.stringify(event));
  if(task){task.revision=(task.revision??0)+1;task.headId=event.id;task.headHash=intentHash;task.updatedAt=new Date(now()).toISOString();saveTask(task);}
  db.prepare('INSERT INTO aimp_outbox(id,room_id,actor_json,event_json) VALUES(?,?,?,?)').run(event.id,event.room_id,JSON.stringify(ctx),JSON.stringify(event));
  return {ok:true,event,task,receipt:{...sequencing,chain_hash:chainHash,signature:event.sequencing.sig}};
 }
 function eventFor(input,ctx){return {aimp:'1.0',id:input.id,room_id:input.roomId,thread_id:input.threadId,
  ...(input.taskRef?{task_ref:input.taskRef}:{}),target_event:input.targetEvent??null,from:address(ctx.actor),to:input.to??[],mentions:[],audience:['agent://kteam.local/sequencer',`room:${input.roomId}@1`],
  exp:new Date(now()+300_000).toISOString(),key_id:'local-session-'+sha256(key.publicKey).slice(0,16),ts:new Date(now()).toISOString(),act:input.act,
  source_level:ctx.requestSource==='user'?'principal':'peer',classification:'internal',body:input.body,payload:input.payload,...(input.artifacts?{artifacts:input.artifacts}:{})};}
 function publish(){
  let count=0;
  for(const row of db.prepare('SELECT * FROM aimp_outbox WHERE delivered=0 ORDER BY rowid LIMIT 100').all()){
   const event=JSON.parse(row.event_json),ctx=JSON.parse(row.actor_json);
   // Protocol telemetry remains in its signed chain; it is not chat content.
   // The substantive answer is published once by chat(), with its work ref.
   if(!['stop','escalate','reject','cancel'].includes(event.act)){db.prepare('UPDATE aimp_outbox SET delivered=2 WHERE id=?').run(row.id);continue;}
   const result=roomService.sendRoomMessage({roomId:row.room_id,threadId:event.thread_id,kind:'text',text:event.body,
    responsePolicy:'none',contextScope:{kind:'room_only'},idempotencyKey:'aimp-event:'+row.id,
    sourceRef:{kind:'aimp_event',act:event.act,taskRef:event.task_ref??null,eventId:event.id,sequence:event.sequencing.seq}},ctx);
   if(result.ok||result.code==='room_message_duplicate'){db.prepare('UPDATE aimp_outbox SET delivered=1 WHERE id=?').run(row.id);count++;}
  }
  return {ok:true,published:count};
 }
 function configure(input,ctx){
  const auth=authorization(input.roomId,ctx,true);if(!auth.ok)return auth;
  if(typeof input.goal!=='string'||!input.goal.trim()||input.goal.length>8192||!Number.isSafeInteger(input.maxRuns)||input.maxRuns<1||input.maxRuns>20)return failed('aimp_session_invalid');
  if(!Array.isArray(input.allowedActions)||input.allowedActions.some(a=>!['discussion','workspace_read','workspace_write'].includes(a)))return failed('aimp_action_not_permitted');
  return tx(()=>{
   const previous=session(input.roomId);if((previous?.revision??0)!==input.expectedRevision)return failed('aimp_session_revision_conflict');
   const value={roomId:input.roomId,goal:input.goal,revision:(previous?.revision??0)+1,owner:address(ctx.actor),allowedActions:input.allowedActions,maxRuns:input.maxRuns,scopeEpoch:(previous?.scopeEpoch??0)+1,createdAt:new Date(now()).toISOString(),profileClaim:null,internalDirectAcceptance:true};
   db.prepare('INSERT INTO aimp_sessions VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json').run(input.roomId,value.revision,JSON.stringify(value));
   return {ok:true,session:value};
  });
 }
 function submit(input,ctx){
  const auth=authorization(input.roomId,ctx);if(!auth.ok)return auth;
  if(['from','actor','requestSource','source_level','sig','sequencing'].some(f=>Object.hasOwn(input,f)))return failed('aimp_identity_payload_forbidden');
  if(!/^msg_[a-f0-9]{32}$/.test(input.id??'')||typeof input.threadId!=='string'||!input.threadId||typeof input.body!=='string'||!input.body.trim()||input.body.length>32768)return failed('aimp_input_invalid');
  let commandHash;try{commandHash=sha256(canonical({input,actor:address(ctx.actor)}));}catch{return failed('aimp_input_invalid');}
  const prior=db.prepare('SELECT * FROM aimp_receipts WHERE id=?').get(input.id);
  if(prior)return prior.command_hash===commandHash&&prior.actor===address(ctx.actor)?{...JSON.parse(prior.value_json),reused:true}:failed('aimp_id_conflict');
  const contract=session(input.roomId);if(!contract)return failed('aimp_session_required');
  const schema=schemas[input.act],payload=input.payload;
  if(!schema)return failed('unsupported_kind',{disposition:'hard_failure',clarify:{reason:'unsupported_kind',kind:payload?.kind??null}});
  if(!payload||payload.kind!==`task.${input.act}@1`||payload.must_understand!==true||schema.some(f=>!Object.hasOwn(payload,f))||Object.keys(payload).some(f=>!['kind','must_understand',...schema].includes(f)))return failed('aimp_schema_invalid');
  if(input.act==='deliver'&&payload.draft!==false)return failed('aimp_l3_required');
  const result=tx(()=>{
   let task=input.taskRef?readTask(input.taskRef):null;
   const sender=address(ctx.actor);
   const event=eventFor(input,ctx);
   if(['request','propose','delegate'].includes(input.act)){
    if(task)return failed('aimp_task_exists');
    if(input.act==='delegate')return failed('aimp_delegate_requires_goal_owner');
    if(ctx.requestSource!=='user')return failed('aimp_actor_forbidden');
    if(!contract.allowedActions.includes('discussion'))return failed('aimp_action_not_permitted');
    if(!Number.isFinite(Date.parse(payload.expires))||Date.parse(payload.expires)<=now()||!Number.isFinite(Date.parse(payload.deadline))||Date.parse(payload.deadline)<=now())return failed('aimp_terms_expired');
    if(payload.budget!=='none'||!payload.acceptance||!Array.isArray(payload.acceptance.predicates))return failed('aimp_terms_invalid');
    const members=auth.members.filter(m=>m.status==='active'&&m.subject.kind==='agent').map(m=>address({kind:'agent',logicalAgentId:m.subject.logicalAgentId}));
    if(!members.includes(payload.assignee)||payload.reviewer!==contract.owner)return failed('aimp_assignee_required');
    const taskRef='task_'+sha256(input.id).slice(0,32);event.task_ref=taskRef;
    task={taskRef,roomId:input.roomId,threadId:input.threadId,state:'proposed',revision:0,epoch:0,scopeEpoch:contract.scopeEpoch,contractRevision:contract.revision,
     principal:contract.owner,assignee:payload.assignee,reviewer:payload.reviewer,terms:payload,termsHash:sha256(canonical(payload)),executionFrozen:false};
   }else{
    if(!task||task.roomId!==input.roomId||task.threadId!==input.threadId)return failed('aimp_task_scope_mismatch');
    if(!input.targetEvent||!db.prepare('SELECT 1 FROM aimp_events WHERE id=? AND task_ref=?').get(input.targetEvent.id,task.taskRef))return failed('aimp_target_required');
    const target=JSON.parse(db.prepare('SELECT value_json FROM aimp_events WHERE id=?').get(input.targetEvent.id).value_json);
    if(target.sequencing.intent_hash!==input.targetEvent.hash)return failed('aimp_target_mismatch');
    if(input.act==='accept'){
     if(sender!==task.assignee)return failed('aimp_assignee_required');
     if(task.state!=='proposed'||payload.terms_hash!==task.termsHash||!Array.isArray(payload.caveats)||payload.caveats.length)return failed('aimp_accept_conflict');
     task.state='committed';
    }else if(input.act==='stop'||input.act==='cancel'){
     if(sender!==task.principal)return failed('aimp_actor_forbidden');
     if(input.act==='stop'){if(active.has(task.state))task.state='halted';}else{if(!['committed','working','blocked','pending_activation'].includes(task.state))return failed('aimp_illegal_transition');task.state='cancelled';}
     task.executionFrozen=true;task.epoch++;task.scopeEpoch++;
    }else if(input.act==='reject'){
     if(sender!==task.assignee||task.state!=='proposed')return failed('aimp_illegal_transition');task.state='declined';
    }else if(input.act==='deliver'){
     if(sender!==task.assignee||task.state!=='working'||task.executionFrozen||task.leaseUntil<=now())return failed('aimp_execution_not_current');
     const admission=checkExecution({...input,roomId:task.roomId,taskRef:task.taskRef},ctx);if(!admission.ok)return admission;
     event.capability_token={ref:'local-execution:'+task.runId,execution_epoch:task.epoch,binding_revision:task.bindingRevision,host_fence:task.hostFence};
     if(!Array.isArray(input.artifacts)||!input.artifacts.length||input.artifacts.some(a=>!a.ref||!a.version||!/^[a-f0-9]{64}$/.test(a.sha256??'')||!a.media_type))return failed('aimp_artifacts_required');
     if(db.prepare('SELECT value_json FROM aimp_effects WHERE task_ref=?').all(task.taskRef).some(r=>['executing','unknown'].includes(JSON.parse(r.value_json).state)))return failed('aimp_effect_unresolved');
     task.state='delivered';task.epoch++;task.artifacts=input.artifacts;task.caveats=payload.caveats;
    }else if(input.act==='review'){
     if(sender!==task.reviewer||payload.trust_root!==task.reviewer||task.state!=='delivered')return failed('aimp_reviewer_required');
     if(!['pass','rework','dispute_hint'].includes(payload.decision)||!Array.isArray(payload.findings))return failed('aimp_review_invalid');
     // Human pass is a verdict, not an artifact-byte verifier; require independent host evidence.
     if(payload.decision==='pass'&&!task.artifactVerification?.verified)return failed('aimp_artifacts_unverified');
     task.state=payload.decision==='pass'?'accepted':payload.decision==='rework'?'committed':'disputed';task.epoch++;
    }else if(input.act==='escalate'){
     if(![task.principal,task.assignee].includes(sender)||!['committed','working','delivered','result_unknown','blocked'].includes(task.state))return failed('aimp_actor_forbidden');
     task.previousState??=task.state;task.blockReasons=[...new Set([...(task.blockReasons??[]),payload.reason_code])];task.state='blocked';task.epoch++;
    }else if(input.act==='resume'){
     if(sender!==task.principal||task.state!=='blocked'||!Array.isArray(payload.resolved_causes)||(task.blockReasons??[]).some(reason=>!payload.resolved_causes.includes(reason)))return failed('aimp_resume_forbidden');
     task.state=task.previousState==='working'?'committed':task.previousState;delete task.previousState;task.blockReasons=[];task.epoch++;
    }else return failed('aimp_event_not_enabled');
   }
   const receipt=append(event,task,ctx);
   db.prepare('INSERT INTO aimp_receipts VALUES(?,?,?,?,?)').run(input.id,commandHash,sender,input.roomId,JSON.stringify(receipt));
   return receipt;
  });
  if(result.ok)publish();return result;
 }
 function checkExecution(input,ctx){
  const task=readTask(input.taskRef);if(!task||task.roomId!==input.roomId)return failed('aimp_task_not_found');
  const auth=authorization(task.roomId,ctx);if(!auth.ok)return auth;
  const contract=session(task.roomId);
  if(task.state!=='working'||task.executionFrozen||task.assignee!==address(ctx.actor)||task.epoch!==input.epoch||task.bindingRevision!==input.bindingRevision||task.hostFence!==input.hostFence||task.leaseUntil<=now()||contract.scopeEpoch!==task.scopeEpoch)return failed('aimp_execution_not_current');
  return {ok:true,task};
 }
 function beginExecution(input,ctx){
  const task=readTask(input.taskRef);if(!task||task.roomId!==input.roomId)return failed('aimp_task_not_found');
  const auth=authorization(task.roomId,ctx);if(!auth.ok)return auth;
  return tx(()=>{
   const current=readTask(input.taskRef),contract=session(input.roomId);
   if(current.runId===input.requestId&&current.state==='working'){
    const check=checkExecution({...input,epoch:current.epoch},ctx);return check.ok?{...check,reused:true}:check;
   }
   if(current.state!=='committed'||current.executionFrozen||current.assignee!==address(ctx.actor)||current.revision!==input.expectedRevision||contract.scopeEpoch!==current.scopeEpoch)return failed('aimp_execution_not_current');
   if(!Number.isSafeInteger(input.bindingRevision)||input.bindingRevision<1||!Number.isSafeInteger(input.hostFence)||input.hostFence<1)return failed('aimp_binding_required');
   current.state='working';current.epoch++;current.leaseUntil=now()+60_000;current.bindingRevision=input.bindingRevision;current.hostFence=input.hostFence;current.runId=input.requestId;
   return append(eventFor({id:nonce('msg_'),roomId:current.roomId,threadId:current.threadId,taskRef:current.taskRef,act:'sys.epoch',body:'工作已认领，开始执行。',targetEvent:{id:current.headId,hash:current.headHash},payload:{kind:'sys.epoch@1',must_understand:true,execution_epoch:current.epoch,lease_until:new Date(current.leaseUntil).toISOString(),purpose:'fulfillment'}},{...ctx,requestSource:'system',actor:{kind:'system',service:'desktop'}}),current,ctx);
  });
 }
 function effect(input,ctx){
  const task=readTask(input.taskRef);if(!task)return failed('aimp_task_not_found');
  const auth=authorization(task.roomId,ctx);if(!auth.ok)return auth;
  const previous=db.prepare('SELECT value_json FROM aimp_effects WHERE effect_id=?').get(input.effectId);
  const prior=previous?JSON.parse(previous.value_json):null;
  if(prior&&prior.taskRef!==input.taskRef)return failed('aimp_effect_scope_mismatch');
  if(!['completed','failed','unknown'].includes(input.state)||!prior||!['executing','unknown'].includes(prior.state)){
   const current=checkExecution(input,ctx);if(!current.ok)return current;
  }else if(![task.principal,task.assignee].includes(address(ctx.actor)))return failed('aimp_actor_forbidden');
  return tx(()=>{
   if(input.state==='registered'){
    if(prior)return prior.logicalAction===input.logicalAction&&prior.externalIdempotencyKey===input.externalIdempotencyKey?{ok:true,reused:true,effect:prior}:failed('aimp_effect_conflict');
    if(typeof input.logicalAction!=='string'||!input.logicalAction||!input.externalIdempotencyKey||!Number.isSafeInteger(input.clauseVersion))return failed('aimp_effect_invalid');
    const duplicate=db.prepare('SELECT value_json FROM aimp_effects WHERE task_ref=? AND logical_action=? AND clause_version=?').get(task.taskRef,input.logicalAction,input.clauseVersion);
    if(duplicate)return failed('aimp_effect_logical_duplicate');
   }else if(!prior)return failed('aimp_effect_not_found');
   else{
    const allowed={registered:['executing','failed'],executing:['completed','failed','unknown'],unknown:['completed','failed'],completed:[],failed:[]};
    if(!allowed[prior.state]?.includes(input.state))return failed('aimp_effect_transition_invalid');
    if(['completed','failed'].includes(input.state)&&(!input.evidence||typeof input.evidence!=='object'))return failed('aimp_effect_evidence_required');
   }
   const value={...prior,...input,taskRef:task.taskRef,updatedAt:new Date(now()).toISOString()};
   db.prepare('INSERT INTO aimp_effects VALUES(?,?,?,?,?) ON CONFLICT(effect_id) DO UPDATE SET value_json=excluded.value_json').run(input.effectId,task.taskRef,value.logicalAction,value.clauseVersion,JSON.stringify(value));
   const latest=readTask(task.taskRef);
   append(eventFor({id:nonce('msg_'),roomId:task.roomId,threadId:task.threadId,taskRef:task.taskRef,act:input.state==='registered'?'effect.register':'effect.update',body:'工作动作状态：'+input.state,
    targetEvent:{id:latest.headId,hash:latest.headHash},payload:{kind:(input.state==='registered'?'effect.register':'effect.update')+'@1',must_understand:true,effect_id:input.effectId,logical_action:value.logicalAction,clause_version:value.clauseVersion,state:input.state,epoch:input.epoch??null,external_idempotency_key:value.externalIdempotencyKey,evidence:input.evidence??null}},ctx),latest,ctx);
   return {ok:true,effect:value};
  });
 }
 function sweep(){
  for(const row of db.prepare('SELECT value_json FROM aimp_tasks').all()){
   const task=JSON.parse(row.value_json);
   if(task.state==='working'&&task.leaseUntil<=now())tx(()=>{
    const effects=db.prepare('SELECT * FROM aimp_effects WHERE task_ref=?').all(task.taskRef);
    const pending=effects.filter(r=>JSON.parse(r.value_json).state==='executing');
    for(const row of pending){const value=JSON.parse(row.value_json);value.state='unknown';db.prepare('UPDATE aimp_effects SET value_json=? WHERE effect_id=?').run(JSON.stringify(value),row.effect_id);}
    task.state='result_unknown';task.epoch++;task.executionFrozen=true;
    const ctx={sessionId:'aimp-sequencer',requestSource:'system',actor:{kind:'system',service:'desktop'},issuedAt:new Date(now()).toISOString()};
    append(eventFor({id:nonce('msg_'),roomId:task.roomId,threadId:task.threadId,taskRef:task.taskRef,act:pending.length?'sys.effect_unknown':'sys.lease_expired',body:pending.length?'执行结果尚未核对，已暂停自动重试。':'执行租约到期，等待主机核验。',targetEvent:{id:task.headId,hash:task.headHash},payload:{kind:pending.length?'sys.effect_unknown@1':'sys.lease_expired@1',must_understand:true,execution_epoch:task.epoch,effect_ids:pending.map(r=>r.effect_id),reason:'lease_expired'}},ctx),task,ctx);
   });
  }
 }
 function getTask(taskRef,ctx){const task=readTask(taskRef);if(!task)return failed('aimp_task_not_found');const auth=authorization(task.roomId,ctx);return auth.ok?{ok:true,task}:auth;}
 function getEffects(taskRef,ctx){const result=getTask(taskRef,ctx);return result.ok?{ok:true,effects:db.prepare('SELECT value_json FROM aimp_effects WHERE task_ref=?').all(taskRef).map(r=>JSON.parse(r.value_json))}:result;}
 function listTasks(roomId,ctx){const auth=authorization(roomId,ctx);return auth.ok?{ok:true,tasks:db.prepare('SELECT value_json FROM aimp_tasks WHERE room_id=?').all(roomId).map(r=>JSON.parse(r.value_json))}:auth;}
 function verifyThread(threadId){let previous='0'.repeat(64),sequence=0;for(const row of db.prepare('SELECT * FROM aimp_events WHERE thread_id=? ORDER BY seq').all(threadId)){
  const event=JSON.parse(row.value_json),record={...event.sequencing};delete record.sig;
  const domain=event.act.startsWith('sys.')?'system':'intent';
  if(record.prev_hash!==previous||record.seq!==++sequence||record.intent_hash!==sha256(signatureBytes(domain,eventProjection(event)))||!verifyProjection(domain,eventProjection(event),event.sig,key.publicKey)||!verifyProjection('record',record,event.sequencing.sig,key.publicKey))return failed('aimp_chain_invalid');
  previous=sha256(signatureBytes('record',record));if(previous!==row.chain_hash)return failed('aimp_chain_invalid');
 }return {ok:true,head:previous,sequence};}
 return {configure,submit,beginExecution,checkExecution,effect,sweep,getTask,getEffects,listTasks,publish,verifyThread,
  chat(input,ctx){
   const allowed=checkExecution(input,ctx);if(!allowed.ok)return allowed;
   if(typeof input.text!=='string'||!input.text.trim()||input.text.length>32768)return failed('aimp_input_invalid');
   return roomService.sendRoomMessage({roomId:input.roomId,threadId:allowed.task.threadId,kind:'text',text:input.text,idempotencyKey:'aimp-reply:'+input.taskRef,
    responsePolicy:'none',contextScope:{kind:'room_only'},sourceRef:{kind:'aimp_reply',taskRef:input.taskRef,model:input.model??'unknown',usage:input.usage??null}},ctx);
  },
  verifyDelivery(input,ctx){
   const result=getTask(input.taskRef,ctx);if(!result.ok)return result;
   if(ctx.requestSource!=='user')return failed('aimp_actor_forbidden');
   const task=result.task;if(task.state!=='delivered')return failed('aimp_illegal_transition');
   const room=roomService.getCollaborationRoom({roomId:task.roomId},ctx);if(!room.ok)return room;
   for(const artifact of task.artifacts??[]){
    const message=room.messages.find(m=>`message://${task.roomId}/${m.messageId}`===artifact.ref);
    if(!message||message.sourceRef?.kind!=='aimp_reply'||message.sourceRef?.taskRef!==task.taskRef||message.threadId!==task.threadId||message.sender?.kind!=='agent'||address(message.sender)!==task.assignee||sha256(message.text??'')!==artifact.sha256)return failed('aimp_artifact_verification_failed');
   }
   return tx(()=>{const current=readTask(input.taskRef);if(current.revision!==task.revision)return failed('aimp_task_revision_conflict');
    current.artifactVerification={verified:true,kind:'broker-message-bytes',verifiedAt:new Date(now()).toISOString()};saveTask(current);return {ok:true,task:current};});
  },
  heartbeat(input,ctx){const result=checkExecution(input,ctx);if(!result.ok)return result;return tx(()=>{const task=readTask(input.taskRef);task.leaseUntil=now()+60_000;return append(eventFor({id:nonce('msg_'),roomId:task.roomId,threadId:task.threadId,taskRef:task.taskRef,act:'sys.lease_renewed',body:'执行主机续租。',targetEvent:{id:task.headId,hash:task.headHash},payload:{kind:'sys.lease_renewed@1',must_understand:true,execution_epoch:task.epoch,lease_until:new Date(task.leaseUntil).toISOString(),purpose:'fulfillment'}},{...ctx,requestSource:'system',actor:{kind:'system',service:'desktop'}}),task,ctx);});},
  getSession(roomId,ctx){const auth=authorization(roomId,ctx);return auth.ok?{ok:true,session:session(roomId)}:auth;},
  status(){return {ok:true,specification:'3.1',wire:'1.0',profileClaim:null,experimental:true,supportedEvents:Object.keys(schemas)};},
  close(){if(!closed){closed=true;db.close();lock.exec('ROLLBACK');lock.close();}}
 };
}
