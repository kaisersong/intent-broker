import { createHash, randomUUID } from 'node:crypto';
import { verifyTrustedActorContext } from './trusted-context.js';

export const WORKSPACE_PROTOCOL = 'room_workspace_v1';
export function canonicalWorkspaceJSON(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalWorkspaceJSON).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalWorkspaceJSON(value[k])).join(',') + '}';
  }
  throw new Error('workspace_input_invalid');
}
export function workspaceDigest(kind, value) {
  return createHash('sha256').update(`xiaok.room-workspace.v1/${kind}\n${canonicalWorkspaceJSON(value)}`).digest('hex');
}
function reject(code) { throw Object.assign(new Error(code), { workspaceCode: code }); }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function scope(value) {
  if (value?.kind === 'room_only' && Object.keys(value).length === 1) return value;
  if (value?.kind === 'project' && nonempty(value.projectId) && Object.keys(value).length === 2) return value;
  reject('room_scope_mismatch');
}
function digest(value) { if (!/^[a-f0-9]{64}$/.test(value ?? '')) reject('workspace_input_invalid'); return value; }
function relativePath(value) {
  if(typeof value!=='string'||value.includes('\0')||value.includes('\\')||value.startsWith('/')||/^[a-z]:/i.test(value)||value.split('/').some(p=>p==='..'||p==='.')||value.includes('//'))reject('workspace_path_invalid');
  return value;
}

/** All records share the Room database and sequence allocator. Transport owns
 * authentication; this service never reads actor/host authority from payloads. */
export function createRoomWorkspaceService({ store, now = () => new Date() }) {
  const get = (kind, key) => {
    const row = store.db.prepare('SELECT value_json FROM room_workspace_records WHERE kind=? AND record_key=?').get(kind, key);
    return row ? JSON.parse(row.value_json) : null;
  };
  const put = (kind, key, roomId, value) => store.db.prepare('INSERT INTO room_workspace_records(kind,record_key,room_id,value_json) VALUES(?,?,?,?) ON CONFLICT(kind,record_key) DO UPDATE SET value_json=excluded.value_json').run(kind,key,roomId,JSON.stringify(value));
  const list = (kind, roomId) => store.db.prepare('SELECT value_json FROM room_workspace_records WHERE kind=? AND room_id=?').all(kind,roomId).map(r=>JSON.parse(r.value_json));
  const time = () => now().toISOString();
  const member = (roomId, ctx, owner = false) => {
    const m = store.getMember(roomId,ctx.actor);
    if (!m || m.status !== 'active') reject('room_membership_required');
    if (owner && (ctx.requestSource !== 'user' || m.role !== 'owner')) reject('room_actor_forbidden');
    return m;
  };
  const room = (roomId, active = true) => {
    const r=store.getRoomRow(roomId); if(!r || r.deletedAt) reject('room_not_found');
    if(active && r.status!=='active') reject('room_archived'); return r;
  };
  const host = ctx => {
    if (!nonempty(ctx.hostPrincipal)) reject('workspace_host_authentication_required');
    const h=get('host',ctx.hostPrincipal);
    if(!h || h.hostIncarnation !== ctx.hostIncarnation) reject('workspace_host_fenced'); return h;
  };
  const config = roomId => get('config',roomId);
  const sameHost = (c,ctx) => { const h=host(ctx); if(c.originHostId && c.originHostId!==h.hostId) reject('workspace_origin_unavailable'); return h; };
  const sequence = roomId => store.nextRoomSequence(roomId);
  const saveConfig = (c,ctx,action) => {
    c.revision++; c.roomSequence=sequence(c.roomId); put('config',c.roomId,c.roomId,c);
    put('audit',`${c.roomId}:${c.roomSequence}`,c.roomId,{roomSequence:c.roomSequence,action,actor:ctx.actor,at:time(),operationId:c.operationId??null});
    return c;
  };
  const cas = (c,input) => { if(input.expectedRevision !== (c?.revision??0)) reject('room_revision_conflict'); };
  const activeConfig = roomId => { const c=config(roomId); if(!c || c.phase!=='active') reject('workspace_not_active'); return c; };
  const hasRootGrant=(c,ctx,m)=>Boolean(c&&list('grant',c.roomId).some(g=>!g.revokedSequence&&g.scope.kind==='room_only'&&g.subjectKind===ctx.actor.kind&&g.subjectId===(ctx.actor.userId??ctx.actor.logicalAgentId)&&g.membershipRevision===m.membershipRevision&&g.bindingId===c.activeBindingId&&g.generation===c.generation&&g.allowedPathsOrVersions.some(p=>p.kind==='path'&&p.relativePath===''&&p.recursive===true)));
  const action = (fn,{independent=false}={}) => (input={},ctx=null) => {
    if(independent&&store.db.isTransaction)reject('disclosure_independent_transaction_required');
    const verified=verifyTrustedActorContext(ctx); if(!verified.ok)return verified;
    try { return store.withTransaction(()=>{
      if(typeof input?.roomId==='string' && store.getRoomRow(input.roomId)?.deletedAt)reject('room_not_found');
      return {ok:true,...fn(input,ctx)};
    }); }
    catch(error) { if(error.workspaceCode)return {ok:false,code:error.workspaceCode}; throw error; }
  };
  const guardedMutation=fn=>action((input,ctx)=>{
    if(typeof input.roomId==='string'&&store.db.prepare("SELECT 1 FROM room_disclosure_mutations WHERE (room_id=? OR room_id='') AND state='PENDING' LIMIT 1").get(input.roomId))reject('disclosure_mutation_pending');
    return fn(input,ctx);
  });
  const ownClaim = (input,ctx,{valid=true,running=false}={}) => {
    const c=get('claim',input.claimId); if(!c || c.roomId!==input.roomId)reject('workspace_claim_not_found');
    room(c.roomId, false);
    const h=host(ctx);
    if(c.hostPrincipal!==ctx.hostPrincipal || c.hostIncarnation!==h.hostIncarnation)reject('workspace_host_fenced');
    if(ctx.requestSource==='agent' && ctx.actor.logicalAgentId!==c.logicalAgentId) reject('room_actor_identity_mismatch');
    if(ctx.requestSource!=='agent' && ctx.requestSource!=='user')reject('room_actor_forbidden');
    member(c.roomId,ctx);
    if(valid) {
      room(c.roomId); const m=store.getMember(c.roomId,{kind:'agent',logicalAgentId:c.logicalAgentId});
      if(!m || m.status!=='active' || m.membershipRevision!==c.membershipRevision || c.authorizationState!=='valid')reject('workspace_claim_revoked');
    }
    if(running && c.executionState!=='running')reject('workspace_claim_not_running');
    return c;
  };
  const writeClaim = (c,actionName) => { c.roomSequence=sequence(c.roomId);c.updatedAt=time();put('claim',c.claimId,c.roomId,c); return {claim:c}; };
  const noClaims = (roomId,projectId) => {
    if(list('claim',roomId).some(c=>c.executionState!=='released' && (!projectId || c.contextScope.projectId===projectId)))reject('workspace_drain_pending');
    if(store.listClaimedDeliveries(roomId).length)reject('workspace_legacy_execution_pending');
  };
  const checkEcho=(c,input)=>{
    for(const key of ['protocolVersion','runId','executorInstanceId','workspaceId','originHostId','hostIncarnation','bindingId','generation','instructionsRevision']){
      if(input[key]!==c[key])reject('workspace_ack_mismatch');
    }
    if(c.contextScope.kind==='project'&&input.mappingRevision!==c.mappingRevision)reject('workspace_ack_mismatch');
  };
  const checkBinding=(c,input)=> {if(c.activeBindingId!==input.bindingId || c.generation!==input.generation)reject('workspace_binding_mismatch');};
  const requireKSwarm=ctx=>{if(ctx.requestSource!=='system'||ctx.actor.service!=='kswarm')reject('room_actor_forbidden');};

  const disclosureFields=(value,keys)=>{if(!value||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>!Object.getOwnPropertyDescriptor(value,key)||!('value' in Object.getOwnPropertyDescriptor(value,key))))reject('disclosure_input_invalid');};
  const disclosureDestination=value=>{
    if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!=='model,protocol,url'||!nonempty(value.model)||value.model.length>256||value.protocol!=='generic-openai'||typeof value.url!=='string'||value.url.length>2048)reject('disclosure_destination_invalid');
    let parsed;try{parsed=new URL(value.url);}catch{reject('disclosure_destination_invalid');}
    if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash)reject('disclosure_destination_invalid');
    return {url:value.url,model:value.model,protocol:value.protocol};
  };
  const disclosureId=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/.test(value))reject('disclosure_identity_invalid');return value;};
  const disclosureLease=attemptId=>{const row=store.db.prepare('SELECT payload_json,state FROM room_disclosure_leases WHERE attempt_id=?').get(attemptId);return row?{...JSON.parse(row.payload_json),state:row.state}:null;};
  // Used only after the original source mutation has authenticated its caller
  // and validated its complete input, within that same SQLite transaction.
  const deferSourceMutation=(kind,roomId,payload,ctx)=>{
    if(!store.db.isTransaction||ctx.requestSource!=='user')reject('room_actor_forbidden');
    const facts={kind,roomId,payloadDigest:workspaceDigest('disclosure-source-mutation',payload),actor:ctx.actor,requestSource:'user'};
    const mutationId=workspaceDigest('disclosure-authority-mutation',facts);
    if(store.db.prepare("SELECT 1 FROM room_disclosure_mutations WHERE (room_id=? OR room_id='') AND state='PENDING' AND mutation_id<>? LIMIT 1").get(roomId,mutationId))reject('disclosure_mutation_conflict');
    const prior=store.db.prepare('SELECT state,payload_json FROM room_disclosure_mutations WHERE mutation_id=?').get(mutationId);
    if(prior&&(prior.state!=='PENDING'||prior.payload_json!==JSON.stringify(facts)))reject('disclosure_mutation_conflict');
    const held=Boolean(store.db.prepare("SELECT 1 FROM room_disclosure_leases WHERE room_id=? AND state='PREPARED' LIMIT 1").get(roomId));
    if(held&&!prior){
      if(store.db.prepare('SELECT count(*) AS n FROM room_disclosure_mutations').get().n>=256)reject('disclosure_quota');
      store.db.prepare("INSERT INTO room_disclosure_mutations VALUES(?,?,'PENDING',?)").run(mutationId,roomId,JSON.stringify(facts));
    }
    return {blocked:held,mutationId:held||prior?mutationId:null};
  };
  const finishSourceMutation=mutation=>{if(mutation.mutationId)store.db.prepare("UPDATE room_disclosure_mutations SET state='APPLIED' WHERE mutation_id=? AND state='PENDING'").run(mutation.mutationId);};
  const api = {
    // Internal host API only until authenticated participant/egress transport is
    // installed. These durable held facts are not an OS fence or signed receipt.
    prepareRoomDisclosureMutation: action((input,ctx)=>{
      if(ctx.requestSource!=='user')reject('room_actor_forbidden');
      disclosureFields(input,['roomId','expectedRoomRevision','kind','payload']);
      if(!['member-change','discussion-cancel'].includes(input.kind))reject('disclosure_input_invalid');
      const r=room(input.roomId);member(input.roomId,ctx,true);
      if(r.revision!==input.expectedRoomRevision)reject('room_revision_conflict');
      const payloadDigest=workspaceDigest('disclosure-mutation-input',input.payload);
      const facts={kind:input.kind,roomId:input.roomId,roomRevision:r.revision,payloadDigest,actor:ctx.actor,requestSource:'user'};
      const mutationId=workspaceDigest('disclosure-authority-mutation',facts);
      if(store.db.prepare("SELECT 1 FROM room_disclosure_mutations WHERE (room_id=? OR room_id='') AND state='PENDING' AND mutation_id<>? LIMIT 1").get(input.roomId,mutationId))reject('disclosure_mutation_conflict');
      const pending=store.db.prepare("SELECT mutation_id FROM room_disclosure_mutations WHERE (room_id=? OR room_id='') AND state='PENDING'").all(input.roomId);
      if(pending.some(row=>row.mutation_id!==mutationId))reject('disclosure_mutation_conflict');
      const held=Boolean(store.db.prepare("SELECT 1 FROM room_disclosure_leases WHERE room_id=? AND state='PREPARED' LIMIT 1").get(input.roomId));
      if(!held&&!pending.length&&!list('disclosure-grant',input.roomId).length)return {blocked:false,mutationId:null};
      const prior=store.db.prepare('SELECT state,payload_json FROM room_disclosure_mutations WHERE mutation_id=?').get(mutationId);
      if(prior&&(prior.state!=='PENDING'||prior.payload_json!==JSON.stringify(facts)))reject('disclosure_mutation_conflict');
      if(!prior){if(store.db.prepare('SELECT count(*) AS n FROM room_disclosure_mutations').get().n>=256)reject('disclosure_quota');
        store.db.prepare("INSERT INTO room_disclosure_mutations VALUES(?,?,'PENDING',?)").run(mutationId,input.roomId,JSON.stringify(facts));}
      return {blocked:held,mutationId};
    },{independent:true}),
    completeRoomDisclosureMutation(input,ctx){
      const verified=verifyTrustedActorContext(ctx);if(!verified.ok)reject(verified.code);
      if(ctx.requestSource!=='user')reject('room_actor_forbidden');
      if(!store.db.isTransaction)reject('disclosure_commit_transaction_required');
      const row=store.db.prepare('SELECT state,payload_json FROM room_disclosure_mutations WHERE mutation_id=?').get(input.mutationId),facts=row&&JSON.parse(row.payload_json);
      if(!facts||row.state!=='PENDING'||facts.kind!==input.kind||!['member-change','discussion-cancel'].includes(facts.kind)||facts.roomId!==input.roomId||facts.roomRevision!==input.expectedRoomRevision||facts.payloadDigest!==workspaceDigest('disclosure-mutation-input',input.payload)||canonicalWorkspaceJSON(facts.actor)!==canonicalWorkspaceJSON(ctx.actor)||room(input.roomId,false).revision!==facts.roomRevision+1)reject('disclosure_mutation_conflict');
      if(store.db.prepare("SELECT 1 FROM room_disclosure_leases WHERE room_id=? AND state='PREPARED' LIMIT 1").get(input.roomId))reject('disclosure_lease_held');
      store.db.prepare("UPDATE room_disclosure_mutations SET state='APPLIED' WHERE mutation_id=? AND state='PENDING'").run(input.mutationId);
    },
    prepareArchiveDisclosure: action((input,ctx)=>{
      if(ctx.requestSource!=='user')reject('room_actor_forbidden');
      disclosureFields(input,['roomId','expectedRoomRevision']);
      const r=room(input.roomId); member(input.roomId,ctx,true);
      if(r.revision!==input.expectedRoomRevision)reject('room_revision_conflict');
      const held=Boolean(store.db.prepare("SELECT 1 FROM room_disclosure_leases WHERE room_id=? AND state='PREPARED' LIMIT 1").get(input.roomId));
      const enrolled=list('disclosure-grant',input.roomId).length>0;
      const pending=store.db.prepare("SELECT 1 FROM room_disclosure_mutations WHERE (room_id=? OR room_id='') AND state='PENDING' LIMIT 1").get(input.roomId);
      if(!held&&!enrolled&&!pending)return {blocked:false,mutationId:null};
      const facts={kind:'archive',roomId:input.roomId,roomRevision:r.revision,actor:ctx.actor,requestSource:'user'};
      const mutationId=workspaceDigest('disclosure-authority-mutation',facts);
      if(store.db.prepare("SELECT 1 FROM room_disclosure_mutations WHERE (room_id=? OR room_id='') AND state='PENDING' AND mutation_id<>? LIMIT 1").get(input.roomId,mutationId))reject('disclosure_mutation_conflict');
      const prior=store.db.prepare('SELECT payload_json,state FROM room_disclosure_mutations WHERE mutation_id=?').get(mutationId);
      if(prior&&(prior.payload_json!==JSON.stringify(facts)||prior.state!=='PENDING'))reject('disclosure_mutation_conflict');
      if(!prior){
        if(store.db.prepare('SELECT count(*) AS n FROM room_disclosure_mutations').get().n>=256)reject('disclosure_quota');
        store.db.prepare("INSERT INTO room_disclosure_mutations(mutation_id,room_id,state,payload_json) VALUES(?,?,'PENDING',?)").run(mutationId,input.roomId,JSON.stringify(facts));
      }
      return {blocked:held,mutationId};
    },{independent:true}),
    // Called by the original archive transaction, after its authorization check.
    // It never releases held disclosures and cannot assert a network fence.
    completeArchiveDisclosure(input,ctx){
      const verified=verifyTrustedActorContext(ctx);if(!verified.ok)reject(verified.code);
      if(ctx.requestSource!=='user')reject('room_actor_forbidden');
      if(!store.db.isTransaction)reject('disclosure_commit_transaction_required');
      member(input.roomId,ctx,true);
      const row=store.db.prepare('SELECT state,payload_json FROM room_disclosure_mutations WHERE mutation_id=?').get(input.mutationId);
      const facts=row&&JSON.parse(row.payload_json),r=room(input.roomId,false);
      if(!facts||row.state!=='PENDING'||facts.kind!=='archive'||facts.roomId!==input.roomId||facts.roomRevision!==input.expectedRoomRevision||canonicalWorkspaceJSON(facts.actor)!==canonicalWorkspaceJSON(ctx.actor)||r.status!=='archiving')reject('disclosure_mutation_conflict');
      if(store.db.prepare("SELECT 1 FROM room_disclosure_leases WHERE room_id=? AND state='PREPARED' LIMIT 1").get(input.roomId))reject('disclosure_lease_held');
      store.db.prepare("UPDATE room_disclosure_mutations SET state='APPLIED' WHERE mutation_id=? AND state='PENDING'").run(input.mutationId);
    },
    approveDisclosureGrant: guardedMutation((input,ctx)=>{
      disclosureFields(input,['roomId','requestId','logicalAgentId','destination','expiresAt']);
      room(input.roomId);member(input.roomId,ctx,true);const c=activeConfig(input.roomId),h=sameHost(c,ctx);
      disclosureId(input.requestId);disclosureId(input.logicalAgentId);const m=store.getMember(input.roomId,{kind:'agent',logicalAgentId:input.logicalAgentId});if(m?.status!=='active')reject('room_membership_required');
      const destination=disclosureDestination(input.destination);if(!Number.isSafeInteger(input.expiresAt)||input.expiresAt<=now().getTime())reject('disclosure_expiry_invalid');
      const requestHash=workspaceDigest('disclosure-grant',{logicalAgentId:input.logicalAgentId,destination,expiresAt:input.expiresAt,bindingId:c.activeBindingId,generation:c.generation,membershipRevision:m.membershipRevision,hostIncarnation:h.hostIncarnation});
      const key=`${input.roomId}:${input.requestId}`,prior=get('disclosure-grant-request',key);if(prior){if(prior.requestHash!==requestHash)reject('workspace_idempotency_conflict');return {grant:get('disclosure-grant',prior.grantId)};}
      let authority=get('disclosure-authority','singleton');if(!authority){if(store.db.prepare('SELECT 1 FROM room_disclosure_leases LIMIT 1').get())reject('disclosure_authority_unknown');authority={authorityId:`broker-${randomUUID()}`,protocol:'disclosure-lease/v1'};put('disclosure-authority','singleton','',authority);}
      if(store.db.prepare("SELECT count(*) AS n FROM room_workspace_records WHERE kind='disclosure-grant'").get().n>=256)reject('disclosure_quota');
      const grant={grantId:`disclosure-grant-${randomUUID()}`,authorityId:authority.authorityId,roomId:input.roomId,logicalAgentId:input.logicalAgentId,membershipRevision:m.membershipRevision,bindingId:c.activeBindingId,generation:c.generation,hostPrincipal:ctx.hostPrincipal,hostIncarnation:h.hostIncarnation,destination,expiresAt:input.expiresAt};
      put('disclosure-grant',grant.grantId,input.roomId,grant);put('disclosure-grant-request',key,input.roomId,{requestHash,grantId:grant.grantId});return {grant};
    }),
    prepareDisclosure: action((input,ctx)=>{
      disclosureFields(input,['roomId','claimId','grantId','attemptId','invocationId','bodySha256','destination','egressId','egressGeneration','sourceMessageIds','includeInstructions']);
      if(ctx.requestSource!=='agent')reject('room_actor_forbidden');const claim=ownClaim(input,ctx,{running:true});if(claim.contextScope.kind!=='room_only')reject('disclosure_project_participant_required');
      const grant=get('disclosure-grant',input.grantId);if(!grant||grant.roomId!==claim.roomId||grant.logicalAgentId!==claim.logicalAgentId||grant.membershipRevision!==claim.membershipRevision||grant.bindingId!==claim.bindingId||grant.generation!==claim.generation||grant.hostPrincipal!==ctx.hostPrincipal||grant.hostIncarnation!==claim.hostIncarnation||grant.expiresAt<=now().getTime())reject('disclosure_grant_required');
      const destination=disclosureDestination(input.destination);if(canonicalWorkspaceJSON(destination)!==canonicalWorkspaceJSON(grant.destination))reject('disclosure_destination_mismatch');
      const attemptId=disclosureId(input.attemptId),invocationId=disclosureId(input.invocationId),egressId=disclosureId(input.egressId);digest(input.bodySha256);if(!Number.isSafeInteger(input.egressGeneration)||input.egressGeneration<1||typeof input.includeInstructions!=='boolean'||!Array.isArray(input.sourceMessageIds)||input.sourceMessageIds.length>64||new Set(input.sourceMessageIds).size!==input.sourceMessageIds.length)reject('disclosure_input_invalid');
      const requestHash=workspaceDigest('disclosure-request',{attemptId,invocationId,egressId,egressGeneration:input.egressGeneration,bodySha256:input.bodySha256,destination,grantId:grant.grantId,claimId:claim.claimId,sourceMessageIds:input.sourceMessageIds,includeInstructions:input.includeInstructions});
      const previous=disclosureLease(attemptId);if(previous){if(previous.requestHash!==requestHash||previous.hostPrincipal!==ctx.hostPrincipal||previous.logicalAgentId!==ctx.actor.logicalAgentId)reject('workspace_idempotency_conflict');return {lease:previous};}
      if(store.db.prepare("SELECT 1 FROM room_disclosure_leases WHERE json_extract(payload_json,'$.invocationId')=? LIMIT 1").get(invocationId))reject('disclosure_invocation_already_prepared');
      if(store.db.prepare("SELECT 1 FROM room_disclosure_mutations WHERE (room_id=? OR room_id='') AND state='PENDING' LIMIT 1").get(input.roomId))reject('disclosure_mutation_pending');
      if(store.db.prepare('SELECT count(*) AS n FROM room_disclosure_leases').get().n>=256)reject('disclosure_quota');
      const sources=input.sourceMessageIds.map(id=>{disclosureId(id);const message=store.getMessageById(id);if(!message||message.roomId!==claim.roomId||message.contextScope.kind!=='room_only')reject('disclosure_source_forbidden');return {messageId:id,roomSequence:message.roomSequence,sourceSha256:workspaceDigest('disclosure-source',message)};});
      const instructions=input.includeInstructions?get('instructions',`${claim.roomId}:${claim.instructionsRevision}`):null;if(input.includeInstructions&&(!instructions||instructions.snapshotDigest!==claim.instructionsDigest))reject('disclosure_source_forbidden');
      const lease={protocol:'disclosure-lease/v1',authorityId:grant.authorityId,attemptId,invocationId,bodySha256:input.bodySha256,destination,egressId,egressGeneration:input.egressGeneration,requestHash,roomId:claim.roomId,hostPrincipal:ctx.hostPrincipal,hostIncarnation:claim.hostIncarnation,logicalAgentId:claim.logicalAgentId,expiresAt:grant.expiresAt,grantId:grant.grantId,claim:{claimId:claim.claimId,bindingId:claim.bindingId,generation:claim.generation,membershipRevision:claim.membershipRevision},sources,instructions:instructions?{revision:instructions.revision,snapshotDigest:instructions.snapshotDigest}:null};
      const payload=JSON.stringify(lease);if(Buffer.byteLength(payload)>32768)reject('disclosure_quota');store.db.prepare("INSERT INTO room_disclosure_leases(attempt_id,room_id,state,payload_json) VALUES(?,?,'PREPARED',?)").run(attemptId,claim.roomId,payload);return {lease:{...lease,state:'PREPARED'}};
    }),
    queryDisclosure: action((input,ctx)=>{disclosureFields(input,['roomId','attemptId']);if(ctx.requestSource!=='agent')reject('room_actor_forbidden');const lease=disclosureLease(disclosureId(input.attemptId)),h=host(ctx);if(!lease||lease.roomId!==input.roomId||lease.hostPrincipal!==ctx.hostPrincipal||lease.hostIncarnation!==h.hostIncarnation||lease.logicalAgentId!==ctx.actor.logicalAgentId)reject('disclosure_lease_forbidden');return {lease};}),
    registerHost: action((input,ctx)=>{
      if(ctx.requestSource!=='user'||!nonempty(ctx.hostPrincipal)||!nonempty(input.startupId))reject('room_actor_forbidden');
      const old=get('host',ctx.hostPrincipal);
      if(old?.startupId===input.startupId)return {host:old};
      const held=store.db.prepare("SELECT room_id FROM room_disclosure_leases WHERE state='PREPARED'").all();
      const affected=new Set(held.map(row=>row.room_id));
      for(const row of store.db.prepare("SELECT room_id,value_json FROM room_workspace_records WHERE kind IN ('config','claim','grant','disclosure-grant')").all()){
        const value=JSON.parse(row.value_json);
        if(value.hostPrincipal===ctx.hostPrincipal||old&&value.originHostId===old.hostId)affected.add(row.room_id);
      }
      const roomIds=[...affected].sort();if(roomIds.length>256)reject('disclosure_quota');
      const facts={kind:'host-incarnation',scope:'broker-global-conservative',hostPrincipal:ctx.hostPrincipal,oldHostDigest:workspaceDigest('disclosure-host',old),startupId:input.startupId,actor:ctx.actor,roomIds};
      const mutationId=workspaceDigest('disclosure-authority-mutation',{...facts,roomIds:[]});
      const pending=store.db.prepare("SELECT mutation_id,state,payload_json FROM room_disclosure_mutations WHERE state='PENDING'").all();
      if(pending.some(row=>row.mutation_id!==mutationId))reject('disclosure_mutation_conflict');
      const prior=pending.find(row=>row.mutation_id===mutationId);
      if(prior){
        const fixed=JSON.parse(prior.payload_json);
        if(!Array.isArray(fixed.roomIds)||fixed.roomIds.length>256||fixed.roomIds.some(id=>typeof id!=='string')||workspaceDigest('disclosure-authority-mutation',{...fixed,roomIds:[]})!==mutationId||roomIds.some(id=>!fixed.roomIds.includes(id)))reject('disclosure_mutation_conflict');
      }
      if(held.length){
        if(!prior){if(store.db.prepare('SELECT count(*) AS n FROM room_disclosure_mutations').get().n>=256)reject('disclosure_quota');
          const payload=JSON.stringify(facts);if(Buffer.byteLength(payload)>32768)reject('disclosure_quota');
          store.db.prepare("INSERT INTO room_disclosure_mutations VALUES(?,'','PENDING',?)").run(mutationId,payload);}
        return {ok:false,code:'disclosure_revocation_pending',mutationId};
      }
      const h={hostId:old?.hostId??`host-${randomUUID()}`,hostPrincipal:ctx.hostPrincipal,hostIncarnation:(old?.hostIncarnation??0)+1,startupId:input.startupId};
      put('host',ctx.hostPrincipal,'',h);
      if(prior)store.db.prepare("UPDATE room_disclosure_mutations SET state='APPLIED' WHERE mutation_id=? AND state='PENDING'").run(mutationId);
      return {host:h};
    }),
    getState: action((input,ctx)=>{
      room(input.roomId,false);member(input.roomId,ctx);
      const c=config(input.roomId);
      const m=member(input.roomId,ctx);
      const visibleGrants=list('grant',input.roomId).filter(g=>g.scope.kind==='room_only'&&(m.role==='owner'||g.subjectId===(ctx.actor.userId??ctx.actor.logicalAgentId)));
      const canRead=hasRootGrant(c,ctx,m);
      const canRegister=canRead&&ctx.requestSource==='user'&&c?.phase==='active'&&room(input.roomId,false).status==='active';
      return {config:c,permissions:{canManage:ctx.requestSource==='user'&&m.role==='owner',canRead,canRegister},members:store.listMembers(input.roomId),claims:list('claim',input.roomId).filter(cl=>cl.contextScope.kind==='room_only'),grants:visibleGrants,instructions:c?.instructionsRef?get('instructions',`${input.roomId}:${input.instructionsRevision??c.instructionsRef.revision}`):null,
        decisions:list('decision',input.roomId).filter(d=>d.contextScope.kind==='room_only'),requiredProtocol:get('minimum',input.roomId)?.requiredProtocol??null};
    }),
    beginChange: action((input,ctx)=>{
      room(input.roomId);member(input.roomId,ctx,true);const h=host(ctx);let c=config(input.roomId);
      if(!nonempty(input.requestId))reject('workspace_input_invalid');digest(input.payloadDigest);
      const prior=get('operation',`${input.roomId}:${input.requestId}`);
      if(prior){if(prior.payloadDigest!==input.payloadDigest)reject('workspace_idempotency_conflict');return {config:c,operation:prior};}
      cas(c,input);if(c)sameHost(c,ctx);
      if(c && !['active','activation_failed','unbound'].includes(c.phase))reject('workspace_change_pending');
      if(list('mapping',input.roomId).some(m=>m.state==='updating'))reject('workspace_mapping_pending');
      const disclosure=deferSourceMutation('begin-change',input.roomId,{requestId:input.requestId,payloadDigest:input.payloadDigest,configRevision:c?.revision??0,hostIncarnation:h.hostIncarnation},ctx);
      if(disclosure.blocked)return {ok:false,code:'disclosure_revocation_pending',mutationId:disclosure.mutationId};
      const operationId=input.requestId;
      const previous=c?structuredClone(c):null;
      const nextGeneration=Math.max(c?.generation??0,c?.lastAllocatedGeneration??0)+1;
      c={...(c??{roomId:input.roomId,revision:0,generation:0,workspaceId:null,activeBindingId:null}),originHostId:h.hostId,nextGeneration,lastAllocatedGeneration:nextGeneration,phase:'draining',operationId,requiredProtocol:WORKSPACE_PROTOCOL};
      put('operation',`${input.roomId}:${operationId}`,input.roomId,{operationId,payloadDigest:input.payloadDigest,previous,generation:nextGeneration,status:'draining'});
      put('minimum',input.roomId,input.roomId,{requiredProtocol:WORKSPACE_PROTOCOL,contextVersion:1});
      const result={config:saveConfig(c,ctx,'begin-change'),nextGeneration};finishSourceMutation(disclosure);return result;
    }),
    commitBinding: guardedMutation((input,ctx)=>{
      room(input.roomId);member(input.roomId,ctx,true);const c=config(input.roomId);if(!c)reject('workspace_not_active');sameHost(c,ctx);
      const op=get('operation',`${input.roomId}:${input.operationId}`);
      if(!op||c.operationId!==input.operationId)reject('workspace_operation_mismatch');
      if(op.payloadDigest!==input.payloadDigest)reject('workspace_idempotency_conflict');
      if(c.phase==='committed'||c.phase==='active'){if(c.activeBindingId!==input.bindingId)reject('workspace_idempotency_conflict');return {config:c};}
      cas(c,input);if(c.phase!=='draining')reject('workspace_change_pending');noClaims(input.roomId);
      if(list('mapping',input.roomId).some(m=>m.state==='updating'))reject('workspace_mapping_pending');
      if(!nonempty(input.bindingId)||!nonempty(input.workspaceId))reject('workspace_input_invalid');
      const identity=get('workspace',input.workspaceId);
      if(identity && identity.originHostId!==c.originHostId)reject('workspace_origin_unavailable');
      if(get('binding',input.bindingId))reject('workspace_binding_reused');
      c.workspaceId=input.workspaceId;c.activeBindingId=input.bindingId;c.phase='committed';c.generation=op.generation;delete c.nextGeneration;
      put('workspace',c.workspaceId,'',{originHostId:c.originHostId});
      put('binding',input.bindingId,input.roomId,{bindingId:input.bindingId,generation:c.generation,workspaceId:c.workspaceId,originHostId:c.originHostId});
      op.status='committed';put('operation',`${input.roomId}:${input.operationId}`,input.roomId,op);
      return {config:saveConfig(c,ctx,'commit-binding')};
    }),
    activateBinding: guardedMutation((input,ctx)=>{
      room(input.roomId);member(input.roomId,ctx,true);const c=config(input.roomId);if(!c)reject('workspace_not_active');sameHost(c,ctx);
      if(c.operationId!==input.operationId)reject('workspace_operation_mismatch');if(c.phase==='active')return {config:c};
      cas(c,input);if(!['committed','activation_failed'].includes(c.phase))reject('workspace_change_pending');
      c.phase='active';return {config:saveConfig(c,ctx,'activate-binding')};
    }),
    activationFailed: guardedMutation((input,ctx)=>{
      room(input.roomId);member(input.roomId,ctx,true);const c=config(input.roomId);if(!c)reject('workspace_not_active');sameHost(c,ctx);cas(c,input);
      if(c.operationId!==input.operationId||!['committed','activation_failed'].includes(c.phase))reject('workspace_operation_mismatch');
      c.phase='activation_failed';return {config:saveConfig(c,ctx,'activation-failed')};
    }),
    cancelChange: guardedMutation((input,ctx)=>{
      room(input.roomId);member(input.roomId,ctx,true);const c=config(input.roomId);if(!c)reject('workspace_not_active');sameHost(c,ctx);cas(c,input);
      if(c.phase!=='draining'||c.operationId!==input.operationId)reject('workspace_operation_mismatch');
      const op=get('operation',`${input.roomId}:${input.operationId}`);op.status='cancelled';put('operation',`${input.roomId}:${input.operationId}`,input.roomId,op);
      const restored={...(op.previous??c),revision:c.revision,phase:op.previous?'active':'unbound'};
      // Never reuse the allocated generation even when a preparation was cancelled.
      restored.lastAllocatedGeneration=c.lastAllocatedGeneration;delete restored.nextGeneration;return {config:saveConfig(restored,ctx,'cancel-change')};
    }),
    publishInstructions: action((input,ctx)=>{
      room(input.roomId);member(input.roomId,ctx,true);const c=config(input.roomId);if(!c)reject('workspace_not_active');
      if(!nonempty(input.requestId))reject('workspace_input_invalid');
      const requestDigest=workspaceDigest('publish-instructions',{publishedText:input.publishedText,description:input.description??'',directoryNotes:input.directoryNotes??[],sourceRelativePath:input.sourceRelativePath??null,sourceHash:input.sourceHash??null});
      const prior=get('instructions-request',`${input.roomId}:${input.requestId}`);
      if(prior){if(prior.payloadDigest!==requestDigest)reject('workspace_idempotency_conflict');return {config:c,instructions:get('instructions',`${input.roomId}:${prior.revision}`)};}
      cas(c,input);
      if(typeof input.publishedText!=='string'||typeof (input.description??'')!=='string')reject('workspace_input_invalid');
      const disclosure=deferSourceMutation('publish-instructions',input.roomId,{requestId:input.requestId,requestDigest,configRevision:c.revision},ctx);
      if(disclosure.blocked)return {ok:false,code:'disclosure_revocation_pending',mutationId:disclosure.mutationId};
      const revision=(c.instructionsRef?.revision??0)+1;
      const snapshot={roomId:input.roomId,revision,publishedText:input.publishedText,description:input.description??'',directoryNotes:input.directoryNotes??[],sourceRelativePath:input.sourceRelativePath??null,sourceHash:input.sourceHash??null};
      snapshot.snapshotDigest=workspaceDigest('instructions',snapshot);snapshot.publishedBy=ctx.actor;snapshot.publishedAt=time();
      put('instructions',`${input.roomId}:${revision}`,input.roomId,snapshot);c.instructionsRef={revision,snapshotDigest:snapshot.snapshotDigest};
      put('instructions-request',`${input.roomId}:${input.requestId}`,input.roomId,{payloadDigest:requestDigest,revision});
      const result={config:saveConfig(c,ctx,'publish-instructions'),instructions:snapshot};finishSourceMutation(disclosure);return result;
    }),
    acquireClaim: guardedMutation((input,ctx)=>{
      room(input.roomId);if(ctx.requestSource!=='agent')reject('room_actor_forbidden');const m=member(input.roomId,ctx);const c=activeConfig(input.roomId);const h=sameHost(c,ctx);
      const s=scope(input.contextScope);const cap=input.capability;
      if(!cap||cap.contextVersion!==1||cap.resultVersion!==1||cap.releaseVersion!==1||!cap.canSetCwd||!cap.canTrackChildren||!cap.canRelease)reject('workspace_protocol_required');
      if(!nonempty(input.runId)||!nonempty(input.executorInstanceId))reject('workspace_input_invalid');
      if(s.kind==='project'){
        const mapping=get('mapping',`${input.roomId}:${s.projectId}`);
        if(!mapping||mapping.state!=='active'||mapping.generation!==c.generation||mapping.mappingRevision!==input.projectMappingRevision)reject('workspace_mapping_required');
      }
      if(input.taskId!==undefined&&!nonempty(input.taskId))reject('workspace_input_invalid');
      const parentTaskId=input.parentClaimId?get('claim',input.parentClaimId)?.taskId:null;
      if(input.parentClaimId&&input.taskId!==undefined&&input.taskId!==(parentTaskId??null))reject('workspace_parent_mismatch');
      const taskId=input.parentClaimId?(parentTaskId??null):(input.taskId??null);
      const frozen={roomId:input.roomId,runId:input.runId,logicalAgentId:ctx.actor.logicalAgentId,executorInstanceId:input.executorInstanceId,contextScope:s,parentClaimId:input.parentClaimId??null,projectMappingRevision:input.projectMappingRevision??null,taskId};
      const acquireDigest=workspaceDigest('acquire',frozen);const prior=get('run',input.runId);
      if(prior){if(prior.acquireDigest!==acquireDigest)reject('workspace_idempotency_conflict');return {claim:ownClaim({roomId:input.roomId,claimId:prior.claimId},ctx)};}
      let parent=null;
      if(input.parentClaimId){parent=get('claim',input.parentClaimId);if(!parent||parent.roomId!==input.roomId||parent.authorizationState!=='valid'||parent.executionState!=='running'||parent.bindingId!==c.activeBindingId||workspaceDigest('scope',parent.contextScope)!==workspaceDigest('scope',s))reject('workspace_parent_mismatch');}
      const claim={...frozen,claimId:`claim-${randomUUID()}`,protocolVersion:1,workspaceId:c.workspaceId,originHostId:h.hostId,hostPrincipal:ctx.hostPrincipal,hostIncarnation:h.hostIncarnation,bindingId:c.activeBindingId,generation:c.generation,workspaceRevision:c.revision,instructionsRevision:parent?.instructionsRevision??c.instructionsRef?.revision??0,instructionsDigest:parent?.instructionsDigest??c.instructionsRef?.snapshotDigest??null,membershipRevision:m.membershipRevision,executionState:'admitted',authorizationState:'valid',createdAt:time(),acquireDigest};
      if(typeof input.taskName==='string'&&input.taskName.trim())claim.taskName=input.taskName.trim().slice(0,200);
      if(parent)claim.workspaceRevision=parent.workspaceRevision;
      if(s.kind==='project'){claim.projectId=s.projectId;claim.mappingRevision=input.projectMappingRevision;}
      put('run',input.runId,input.roomId,{claimId:claim.claimId,acquireDigest});return writeClaim(claim,'acquire');
    }),
    ackClaim: guardedMutation((input,ctx)=>{
      const c=ownClaim(input,ctx);checkEcho(c,input);if(!nonempty(input.actualCwd)||input.cwdVerified!==true)reject('workspace_ack_mismatch');if(c.executionState==='running')return {claim:c};
      if(c.executionState!=='admitted'||input.bindingId!==c.bindingId||input.generation!==c.generation||input.cwdVerified!==true)reject('workspace_ack_mismatch');
      c.executionState='running';return writeClaim(c,'ack');
    }),
    cancelClaim: guardedMutation((input,ctx)=>{
      room(input.roomId,false);member(input.roomId,ctx,true);const c=get('claim',input.claimId);if(!c||c.roomId!==input.roomId)reject('workspace_claim_not_found');
      c.authorizationState='cancel_requested';return writeClaim(c,'cancel');
    }),
    heartbeatClaim: action((input,ctx)=>{
      const c=ownClaim(input,ctx);checkEcho(c,input);
      if(c.executionState==='released')reject('workspace_claim_not_running');
      c.lastHeartbeatAt=time();c.roomSequence=sequence(c.roomId);c.updatedAt=time();
      const updated=store.db.prepare("UPDATE room_workspace_records SET value_json=? WHERE kind='claim' AND record_key=? AND room_id=?").run(JSON.stringify(c),c.claimId,c.roomId);
      if(updated.changes!==1)reject('workspace_claim_not_found');return {claim:c};
    }),
    releasingClaim: action((input,ctx)=>{
      const c=ownClaim(input,ctx,{valid:false});checkEcho(c,input);
      if(c.executionState==='released')reject('workspace_claim_not_running');c.executionState='releasing';return writeClaim(c,'releasing');
    }),
    orphanClaim: action((input,ctx)=>{
      room(input.roomId,false);member(input.roomId,ctx,true);const c=get('claim',input.claimId);if(!c||c.roomId!==input.roomId)reject('workspace_claim_not_found');
      c.authorizationState='orphaned';return writeClaim(c,'orphan');
    }),
    releaseClaim: action((input,ctx)=>{
      const c=ownClaim(input,ctx,{valid:false});checkEcho(c,input);if(c.executionState==='released')return {claim:c};
      const proof=input.terminationEvidence;
      if(input.cleanupOutcome!=='released'||proof?.verified!==true||proof.executorInstanceId!==c.executorInstanceId||!['process-exit','session-disposed','resources-disposed'].includes(proof.kind))reject('workspace_release_evidence_required');
      c.executionState='released';c.terminationEvidence=proof;return writeClaim(c,'release');
    }),
    recoverAdmission: action((input,ctx)=>{
      room(input.roomId,false);member(input.roomId,ctx,true);if(ctx.requestSource!=='user')reject('room_actor_forbidden');
      const h=host(ctx),r=input.request;
      if(!r||!nonempty(r.runId)||!nonempty(r.executorInstanceId)||!nonempty(r.logicalAgentId))reject('workspace_input_invalid');
      const prior=get('run',r.runId),c=prior?get('claim',prior.claimId):null;
      if(!c||c.roomId!==input.roomId||c.hostPrincipal!==ctx.hostPrincipal||c.originHostId!==h.hostId)reject('workspace_claim_not_found');
      const frozen={roomId:input.roomId,runId:r.runId,logicalAgentId:r.logicalAgentId,executorInstanceId:r.executorInstanceId,contextScope:scope(r.contextScope),parentClaimId:r.parentClaimId??null,projectMappingRevision:r.projectMappingRevision??null,taskId:r.taskId??(r.parentClaimId?get('claim',r.parentClaimId)?.taskId:null)??null};
      if(workspaceDigest('acquire',frozen)!==prior.acquireDigest)reject('workspace_idempotency_conflict');
      return {claim:c};
    }),
    recoverClaim: action((input,ctx)=>{
      room(input.roomId,false);member(input.roomId,ctx,true);if(ctx.requestSource!=='user')reject('room_actor_forbidden');
      const h=host(ctx);const c=get('claim',input.claimId);
      if(!c||c.roomId!==input.roomId||c.hostPrincipal!==ctx.hostPrincipal||c.originHostId!==h.hostId)reject('workspace_claim_not_found');
      // Exact-ID recovery by the installation that already owned the executor.
      // No Room projection, execution authorization, or state mutation is granted.
      return {claim:c};
    }),
    takeoverClaim: guardedMutation((input,ctx)=>{
      room(input.roomId,false);member(input.roomId,ctx,true);const h=host(ctx);const c=get('claim',input.claimId);
      if(!c||c.roomId!==input.roomId||c.hostPrincipal!==ctx.hostPrincipal)reject('workspace_claim_not_found');
      if(input.recoveryEvidence?.verified!==true||input.recoveryEvidence.executorInstanceId!==c.executorInstanceId||!['process-exit','attached'].includes(input.recoveryEvidence.kind))reject('workspace_release_evidence_required');
      const recoveryDigest=workspaceDigest('takeover-evidence',input.recoveryEvidence);
      if(c.hostIncarnation!==input.expectedHostIncarnation){
        const receipt=get('takeover-receipt',c.claimId);
        if(c.hostIncarnation===h.hostIncarnation&&receipt?.hostPrincipal===ctx.hostPrincipal&&receipt.fromHostIncarnation===input.expectedHostIncarnation&&receipt.toHostIncarnation===h.hostIncarnation&&receipt.recoveryDigest===recoveryDigest)return {claim:c};
        reject('workspace_host_fenced');
      }
      put('takeover-receipt',c.claimId,c.roomId,{hostPrincipal:ctx.hostPrincipal,fromHostIncarnation:c.hostIncarnation,toHostIncarnation:h.hostIncarnation,recoveryDigest});
      c.hostIncarnation=h.hostIncarnation;c.authorizationState='orphaned';if(input.recoveryEvidence.kind==='process-exit')c.executionState='released';
      return writeClaim(c,'takeover');
    }),
    issueCommitTicket: guardedMutation((input,ctx)=>{
      room(input.roomId);const m=member(input.roomId,ctx);const current=config(input.roomId);if(!current)reject('workspace_not_active');sameHost(current,ctx);
      let subject,bindingId,generation,workspaceRevision,s;
      if(ctx.requestSource==='agent'){
        const c=ownClaim(input,ctx,{running:true});subject={kind:'agentClaim',claimId:c.claimId};({bindingId,generation,workspaceRevision}=c);s=c.contextScope;
      }else if(ctx.requestSource==='user'){
        const c=activeConfig(input.roomId);checkBinding(c,input);s=scope(input.contextScope);if(!hasRootGrant(c,ctx,m))reject('workspace_read_denied');subject={kind:'authenticatedUserAction',userPrincipal:ctx.actor.userId,membershipRevision:m.membershipRevision,actionId:input.submissionId};({generation}=c);bindingId=c.activeBindingId;workspaceRevision=c.revision;
      }else reject('room_actor_forbidden');
      if(s.kind==='project'&&ctx.requestSource!=='agent')reject('workspace_project_artifact_requires_kswarm');
      if(!nonempty(input.submissionId))reject('workspace_input_invalid');digest(input.payloadDigest);
      const key=workspaceDigest('submission',{roomId:input.roomId,subjectId:subject.claimId??subject.userPrincipal,submissionId:input.submissionId});
      const old=get('submission',key);
      if(old){if(old.payloadDigest!==input.payloadDigest)reject('workspace_idempotency_conflict');return {ticket:get('ticket',old.ticketId)};}
      const ticket={ticketId:`ticket-${randomUUID()}`,subject,submissionId:input.submissionId,payloadDigest:input.payloadDigest,roomId:input.roomId,contextScope:s,workspaceId:current.workspaceId,originHostId:current.originHostId,bindingId,generation,workspaceRevision,commitSequence:sequence(input.roomId),authorizedAt:time()};
      ticket.allowedEventKinds=['artifact.registered','handoff.registered'];
      put('ticket',ticket.ticketId,input.roomId,ticket);put('submission',key,input.roomId,ticket);return {ticket};
    }),
    confirmArtifact: guardedMutation((input,ctx)=>{
      room(input.roomId);member(input.roomId,ctx,true);const c=activeConfig(input.roomId);sameHost(c,ctx);checkBinding(c,input);
      if(!nonempty(input.submissionId)||!nonempty(input.versionId))reject('workspace_input_invalid');digest(input.payloadDigest);
      const key=workspaceDigest('confirmation',{roomId:input.roomId,userPrincipal:ctx.actor.userId,submissionId:input.submissionId});
      const prior=get('submission',key);if(prior){if(prior.payloadDigest!==input.payloadDigest)reject('workspace_idempotency_conflict');return {ticket:get('ticket',prior.ticketId)};}
      cas(c,input);
      const ticket={ticketId:`ticket-${randomUUID()}`,roomId:input.roomId,subject:{kind:'authenticatedUserAction',userPrincipal:ctx.actor.userId,actionId:input.submissionId},submissionId:input.submissionId,versionId:input.versionId,payloadDigest:input.payloadDigest,contextScope:{kind:'room_only'},workspaceId:c.workspaceId,originHostId:c.originHostId,bindingId:c.activeBindingId,generation:c.generation,commitSequence:sequence(input.roomId),authorizedAt:time(),allowedEventKinds:['artifact.confirmed']};
      put('ticket',ticket.ticketId,input.roomId,ticket);put('submission',key,input.roomId,ticket);return {ticket,config:saveConfig(c,ctx,'confirm-artifact')};
    }),
    verifyCommitTicket: action((input,ctx)=>{
      requireKSwarm(ctx);const ticket=get('ticket',input.ticketId);
      if(!ticket||ticket.roomId!==input.roomId||ticket.submissionId!==input.submissionId||ticket.payloadDigest!==input.payloadDigest||ticket.contextScope.kind!=='project'||ticket.contextScope.projectId!==input.projectId||ticket.subject.kind!=='agentClaim'||ticket.subject.claimId!==input.claimId)reject('workspace_ticket_mismatch');
      return {ticket};
    }),
    recoverTicket: action((input,ctx)=>{
      if(ctx.requestSource!=='user')reject('room_actor_forbidden');const h=host(ctx);
      if(!nonempty(input.submissionId))reject('workspace_input_invalid');
      const key=input.confirmation===true?workspaceDigest('confirmation',{roomId:input.roomId,userPrincipal:ctx.actor.userId,submissionId:input.submissionId}):workspaceDigest('submission',{roomId:input.roomId,subjectId:input.claimId??ctx.actor.userId,submissionId:input.submissionId});
      const prior=get('submission',key);const t=prior?get('ticket',prior.ticketId):null;
      if(!t||t.roomId!==input.roomId||t.originHostId!==h.hostId||t.payloadDigest!==input.payloadDigest)reject('workspace_ticket_mismatch');
      return {ticket:t};
    }),
    projectEvent: guardedMutation((input,ctx)=>{
      const h=host(ctx);const t=get('ticket',input.ticketId);
      if(!t||t.roomId!==input.roomId||t.originHostId!==h.hostId||t.payloadDigest!==input.payloadDigest)reject('workspace_ticket_mismatch');
      // Historical projection is trusted main transport only, never a new grant.
      if(ctx.requestSource!=='user')reject('room_actor_forbidden');
      if(!t.allowedEventKinds?.includes(input.eventKind)||t.contextScope.kind!=='room_only')reject('workspace_ticket_mismatch');
      const eventId=workspaceDigest('event',{ticketId:t.ticketId,eventKind:input.eventKind});const old=get('event',eventId);if(old)return {event:old};
      const event={eventId,ticketId:t.ticketId,eventKind:input.eventKind,roomId:t.roomId,payloadDigest:t.payloadDigest,contextScope:t.contextScope,roomSequence:sequence(t.roomId)};
      put('event',eventId,t.roomId,event);
      // Timeline carries only a refresh reference. No unverified manifest,
      // local path or file body is accepted through this projection endpoint.
      const message={messageId:`workspace-${eventId}`,roomId:t.roomId,threadId:`thread-${t.roomId}`,sender:{kind:'system',service:'intent-broker'},kind:'workspace_event',contextScope:t.contextScope,mentions:[],responsePolicy:'none',sourceRef:{eventId,ticketId:t.ticketId,eventKind:input.eventKind,payloadDigest:t.payloadDigest},idempotencyKey:`workspace-${eventId}`,roomSequence:event.roomSequence,discussionEpoch:room(t.roomId,false).discussionEpoch,createdAt:time()};
      store.insertMessage(message);
      for(const m of store.listMembers(t.roomId).filter(m=>m.status==='active'))store.insertDelivery({roomMessageId:message.messageId,recipientKey:m.subject.kind==='user'?`user:${m.subject.userId}`:`agent:${m.subject.logicalAgentId}`,logicalRecipientId:m.subject.logicalAgentId??null,wakeStatus:'not_requested'});
      return {event};
    }),
    issueReadGrant: guardedMutation((input,ctx)=>{
      room(input.roomId);member(input.roomId,ctx,true);const c=activeConfig(input.roomId);sameHost(c,ctx);const s=scope(input.contextScope);
      if(!nonempty(input.requestId))reject('workspace_input_invalid');
      const key=`${input.roomId}:${input.requestId}`;
      const requestDigest=workspaceDigest('read-grant',{subjectKind:input.subjectKind,subjectId:input.subjectId,scope:s,bindingId:input.bindingId,generation:input.generation,allowedPathsOrVersions:input.allowedPathsOrVersions});
      const previous=get('grant-request',key);if(previous){if(previous.payloadDigest!==requestDigest)reject('workspace_idempotency_conflict');return {grant:get('grant',previous.grantId),config:c};}
      cas(c,input);
      if(!['user','agent'].includes(input.subjectKind)||!nonempty(input.subjectId))reject('workspace_input_invalid');
      const actor=input.subjectKind==='user'?{kind:'user',userId:input.subjectId}:{kind:'agent',logicalAgentId:input.subjectId};const m=store.getMember(input.roomId,actor);
      if(!m||m.status!=='active')reject('room_membership_required');
      const b=get('binding',input.bindingId);if(!b||b.generation!==input.generation||!list('binding',input.roomId).some(x=>x.bindingId===b.bindingId))reject('workspace_binding_mismatch');
      if(!Array.isArray(input.allowedPathsOrVersions)||input.allowedPathsOrVersions.length===0)reject('workspace_input_invalid');
      for(const item of input.allowedPathsOrVersions){
        if(item?.kind==='version'&&nonempty(item.versionId))continue;
        if(b.bindingId!==c.activeBindingId||item?.kind!=='path')reject('workspace_read_grant_invalid');relativePath(item.relativePath);
      }
      const grant={grantId:`grant-${randomUUID()}`,roomId:input.roomId,subjectKind:input.subjectKind,subjectId:input.subjectId,scope:s,bindingId:b.bindingId,generation:b.generation,allowedPathsOrVersions:input.allowedPathsOrVersions,membershipRevision:m.membershipRevision,issuedSequence:sequence(input.roomId)};
      put('grant',grant.grantId,input.roomId,grant);put('grant-request',key,input.roomId,{grantId:grant.grantId,payloadDigest:requestDigest});return {grant,config:saveConfig(c,ctx,'grant-read')};
    }),
    revokeReadGrant: action((input,ctx)=>{
      room(input.roomId,false);member(input.roomId,ctx,true);const g=get('grant',input.grantId);if(!g||g.roomId!==input.roomId)reject('workspace_read_denied');
      if(g.revokedSequence)return {grant:g};
      const facts={kind:'revoke-read-grant',roomId:input.roomId,grantId:g.grantId,grantDigest:workspaceDigest('disclosure-revoked-grant',g),actor:ctx.actor,requestSource:'user'};
      const mutationId=workspaceDigest('disclosure-authority-mutation',facts);
      if(store.db.prepare("SELECT 1 FROM room_disclosure_mutations WHERE (room_id=? OR room_id='') AND state='PENDING' AND mutation_id<>? LIMIT 1").get(input.roomId,mutationId))reject('disclosure_mutation_conflict');
      const prior=store.db.prepare('SELECT state,payload_json FROM room_disclosure_mutations WHERE mutation_id=?').get(mutationId);
      if(prior&&(prior.state!=='PENDING'||prior.payload_json!==JSON.stringify(facts)))reject('disclosure_mutation_conflict');
      const held=store.db.prepare("SELECT 1 FROM room_disclosure_leases WHERE room_id=? AND state='PREPARED' LIMIT 1").get(input.roomId);
      if(held){
        if(!prior){
          if(store.db.prepare('SELECT count(*) AS n FROM room_disclosure_mutations').get().n>=256)reject('disclosure_quota');
          store.db.prepare("INSERT INTO room_disclosure_mutations(mutation_id,room_id,state,payload_json) VALUES(?,?,'PENDING',?)").run(mutationId,input.roomId,JSON.stringify(facts));
        }
        // Return, do not throw: this original transaction must commit the intent.
        return {ok:false,code:'disclosure_revocation_pending',mutationId};
      }
      g.revokedSequence=sequence(input.roomId);put('grant',g.grantId,input.roomId,g);
      if(prior)store.db.prepare("UPDATE room_disclosure_mutations SET state='APPLIED' WHERE mutation_id=? AND state='PENDING'").run(mutationId);
      return {grant:g};
    }),
    authorizeRead: action((input,ctx)=>{
      room(input.roomId,false);const m=member(input.roomId,ctx);const c=config(input.roomId);if(!c)reject('workspace_not_active');sameHost(c,ctx);const s=scope(input.contextScope);
      if(input.relativePath!==undefined)relativePath(input.relativePath);
      // Project authorization is a separate authoritative KSwarm check. Broker
      // never accepts a boolean assertion in this public payload.
      const requiresProjectAuthorization=s.kind==='project';
      if(ctx.requestSource==='agent'){
        const claim=ownClaim(input,ctx,{running:true});if(claim.bindingId!==input.bindingId||claim.generation!==input.generation||canonicalWorkspaceJSON(claim.contextScope)!==canonicalWorkspaceJSON(s))reject('workspace_read_denied');
        return {authorized:true,requiresProjectAuthorization,claimId:claim.claimId,scope:s,bindingId:claim.bindingId,generation:claim.generation};
      }
      const grants=list('grant',input.roomId).filter(g=>!g.revokedSequence&&g.subjectKind==='user'&&g.subjectId===ctx.actor.userId&&g.membershipRevision===m.membershipRevision&&g.bindingId===input.bindingId&&g.generation===input.generation&&canonicalWorkspaceJSON(g.scope)===canonicalWorkspaceJSON(s));
      const grant=grants.find(g=>g.allowedPathsOrVersions.some(p=>p.kind==='version'?p.versionId===input.versionId:c.activeBindingId===g.bindingId&&typeof input.relativePath==='string'&&(p.relativePath===input.relativePath||p.recursive===true&&(p.relativePath===''||input.relativePath.startsWith(p.relativePath+'/')))));
      if(!grant)reject('workspace_read_denied');return {authorized:true,requiresProjectAuthorization,grant};
    }),
    confirmDecision: guardedMutation((input,ctx)=>{
      room(input.roomId);member(input.roomId,ctx,true);const s=scope(input.contextScope);const id=input.decisionId??`decision-${randomUUID()}`;
      const old=get('decision',id);if(old&&old.roomId!==input.roomId)reject('room_scope_mismatch');if((input.expectedRevision??0)!==(old?.revision??0))reject('room_revision_conflict');
      if(!nonempty(input.text)||!Array.isArray(input.sourceMessageIds)||input.sourceMessageIds.length===0)reject('workspace_input_invalid');
      const messages=input.sourceMessageIds.map(id=>store.getMessageById(id));if(messages.some(m=>!m||m.roomId!==input.roomId))reject('room_scope_mismatch');
      // Shared Room sources may inform a project decision; another project's
      // private source cannot. Explicit owner promotion to room_only stays valid.
      if(s.kind==='project'&&messages.some(m=>m.contextScope?.kind==='project'&&m.contextScope.projectId!==s.projectId))reject('room_scope_mismatch');
      const d={decisionId:id,roomId:input.roomId,contextScope:s,revision:(old?.revision??0)+1,text:input.text,sourceMessageIds:input.sourceMessageIds,sourceSequenceRange:[Math.min(...messages.map(m=>m.roomSequence)),Math.max(...messages.map(m=>m.roomSequence))],sourceHash:workspaceDigest('decision-sources',messages.map(m=>({messageId:m.messageId,text:m.text??'',roomSequence:m.roomSequence}))),confirmedBy:ctx.actor,confirmedAt:time(),revoked:input.revoked===true,roomSequence:sequence(input.roomId)};
      put('decision-version',`${id}:${d.revision}`,input.roomId,d);put('decision',id,input.roomId,d);return {decision:d};
    }),
    beginMapping: guardedMutation((input,ctx)=>{
      room(input.roomId);member(input.roomId,ctx,true);const c=activeConfig(input.roomId);sameHost(c,ctx);cas(c,input);
      if(!nonempty(input.projectId)||!nonempty(input.operationId))reject('workspace_input_invalid');
      if(get('mapping-cancel',workspaceDigest('mapping-operation',{roomId:input.roomId,projectId:input.projectId,operationId:input.operationId})))reject('workspace_operation_finished');
      const key=`${input.roomId}:${input.projectId}`;const old=get('mapping',key);if(old?.state==='updating'){if(old.operationId!==input.operationId)reject('workspace_mapping_pending');return {mapping:old,config:c};}
      const m={roomId:input.roomId,projectId:input.projectId,operationId:input.operationId,bindingId:c.activeBindingId,generation:c.generation,originHostId:c.originHostId,userPrincipal:ctx.actor.userId,state:'updating',previous:old,roomSequence:sequence(input.roomId)};put('mapping',key,input.roomId,m);return {mapping:m,config:c};
    }),
    recoverMappingOperation: action((input,ctx)=>{
      if(ctx.requestSource!=='user')reject('room_actor_forbidden');const h=host(ctx);
      const cancelled=get('mapping-cancel',workspaceDigest('mapping-operation',{roomId:input.roomId,projectId:input.projectId,operationId:input.operationId}));
      const m=cancelled??get('mapping',`${input.roomId}:${input.projectId}`);
      if(!m||m.operationId!==input.operationId||m.originHostId!==h.hostId||m.userPrincipal!==ctx.actor.userId)reject('workspace_operation_mismatch');
      return {mapping:m};
    }),
    recoverMappingTicket: action((input,ctx)=>{
      if(ctx.requestSource!=='user')reject('room_actor_forbidden');const h=host(ctx);
      const t=list('mapping-ticket',input.roomId).find(t=>t.projectId===input.projectId&&t.operationId===input.operationId);
      if(!t||t.originHostId!==h.hostId||t.userPrincipal!==ctx.actor.userId||t.payloadDigest!==input.payloadDigest||t.expectedProjectRevision!==input.expectedProjectRevision)reject('workspace_ticket_mismatch');
      // Historical authority only. A rejection remains visible and is not undone.
      return {ticket:t};
    }),
    issueMappingTicket: guardedMutation((input,ctx)=>{
      room(input.roomId);member(input.roomId,ctx,true);const c=activeConfig(input.roomId);sameHost(c,ctx);
      const m=get('mapping',`${input.roomId}:${input.projectId}`);if(!m||m.state!=='updating'||m.operationId!==input.operationId||m.generation!==c.generation)reject('workspace_mapping_pending');noClaims(input.roomId,input.projectId);digest(input.payloadDigest);
      if(!Number.isSafeInteger(input.expectedProjectRevision))reject('workspace_input_invalid');
      if(m.ticketId){const old=get('mapping-ticket',m.ticketId);if(old.payloadDigest!==input.payloadDigest||old.expectedProjectRevision!==input.expectedProjectRevision)reject('workspace_idempotency_conflict');return {ticket:old};}
      const t={ticketId:`mapping-ticket-${randomUUID()}`,operationId:input.operationId,projectId:input.projectId,roomId:input.roomId,workspaceId:c.workspaceId,bindingId:c.activeBindingId,generation:c.generation,originHostId:c.originHostId,userPrincipal:ctx.actor.userId,payloadDigest:input.payloadDigest,expectedProjectRevision:input.expectedProjectRevision,roomSequence:sequence(input.roomId)};
      m.ticketId=t.ticketId;put('mapping-ticket',t.ticketId,input.roomId,t);put('mapping',`${input.roomId}:${input.projectId}`,input.roomId,m);return {ticket:t};
    }),
    verifyMappingTicket: action((input,ctx)=>{
      requireKSwarm(ctx);const t=get('mapping-ticket',input.ticketId);
      if(!t||t.rejected||['roomId','operationId','projectId','payloadDigest'].some(k=>t[k]!==input[k]))reject('workspace_ticket_mismatch');return {ticket:t};
    }),
    mappingApplied: guardedMutation((input,ctx)=>{
      requireKSwarm(ctx);const t=get('mapping-ticket',input.ticketId);if(!t||t.rejected||['roomId','operationId','projectId','payloadDigest'].some(k=>t[k]!==input[k]))reject('workspace_ticket_mismatch');
      if(!Number.isSafeInteger(input.mappingRevision))reject('workspace_input_invalid');const key=`${input.roomId}:${input.projectId}`;const m=get('mapping',key);
      if(!m||m.operationId!==t.operationId)reject('workspace_operation_mismatch');if(m.state==='active'){if(m.mappingRevision!==input.mappingRevision)reject('workspace_idempotency_conflict');return {mapping:m};}
      m.state='active';m.mappingRevision=input.mappingRevision;m.roomSequence=sequence(input.roomId);delete m.previous;put('mapping',key,input.roomId,m);return {mapping:m};
    }),
    cancelMapping: guardedMutation((input,ctx)=>{
      room(input.roomId,false);member(input.roomId,ctx,true);const key=`${input.roomId}:${input.projectId}`;const m=get('mapping',key);
      if(!m||m.operationId!==input.operationId)reject('workspace_operation_mismatch');if(m.ticketId)reject('workspace_mapping_pending');
      const restored=m.previous??{...m,state:'mapping_required'};delete restored.previous;restored.roomSequence=sequence(input.roomId);
      const receipt={roomId:input.roomId,projectId:input.projectId,operationId:input.operationId,originHostId:m.originHostId,userPrincipal:m.userPrincipal,bindingId:m.bindingId,generation:m.generation,state:'cancelled',roomSequence:restored.roomSequence};
      put('mapping-cancel',workspaceDigest('mapping-operation',{roomId:input.roomId,projectId:input.projectId,operationId:input.operationId}),input.roomId,receipt);
      put('mapping',key,input.roomId,restored);return {mapping:restored};
    }),
    mappingRejected: guardedMutation((input,ctx)=>{
      requireKSwarm(ctx);const t=get('mapping-ticket',input.ticketId);if(!t||['roomId','operationId','projectId','payloadDigest'].some(k=>t[k]!==input[k]))reject('workspace_ticket_mismatch');
      const key=`${input.roomId}:${input.projectId}`;const m=get('mapping',key);if(!m||m.operationId!==t.operationId||m.state!=='updating')reject('workspace_operation_mismatch');
      t.rejected=true;put('mapping-ticket',t.ticketId,t.roomId,t);const restored=m.previous??{...m,state:'mapping_required'};delete restored.previous;restored.roomSequence=sequence(input.roomId);put('mapping',key,input.roomId,restored);return {mapping:restored};
    }),
    verifyClaim: action((input,ctx)=>{
      requireKSwarm(ctx);room(input.roomId);const c=get('claim',input.claimId);const cfg=config(input.roomId);
      if(!c||c.roomId!==input.roomId||c.contextScope.kind!=='project'||c.contextScope.projectId!==input.projectId||c.authorizationState!=='valid'||c.executionState!=='running')reject('workspace_claim_revoked');
      const h=get('host',c.hostPrincipal);const m=store.getMember(c.roomId,{kind:'agent',logicalAgentId:c.logicalAgentId});
      if(h?.hostIncarnation!==c.hostIncarnation||m?.status!=='active'||m.membershipRevision!==c.membershipRevision)reject('workspace_claim_revoked');
      if(input.mappingRevision!==undefined&&input.mappingRevision!==c.projectMappingRevision)reject('workspace_mapping_required');return {claim:c,config:cfg};
    }),
    authorizeWakeAbandon: action((input,ctx)=>{
      if(ctx.requestSource!=='user'||ctx.actor.kind!=='user')reject('room_actor_identity_mismatch');
      const h=host(ctx);const grant=get('wake',input.claimToken);
      if(!grant||grant.roomId!==input.roomId||grant.hostPrincipal!==ctx.hostPrincipal||!Number.isSafeInteger(grant.hostIncarnation)||grant.hostIncarnation>h.hostIncarnation||(grant.userPrincipal!==undefined&&grant.userPrincipal!==ctx.actor.userId))reject('workspace_wake_owner_mismatch');
      const source=store.getMessageById(grant.roomMessageId);
      if(!source||source.roomId!==grant.roomId)reject('room_message_not_found');
      return {authorization:grant};
    }),
    authorizeWake: action((input,ctx)=>{
      const r=room(input.roomId);const m=member(input.roomId,ctx);if(ctx.requestSource!=='agent'||ctx.actor.logicalAgentId!==input.logicalAgentId)reject('room_actor_identity_mismatch');
      const source=store.getMessageById(input.roomMessageId);if(!source||source.roomId!==input.roomId)reject('room_message_not_found');
      const sourceScope=source.contextScope??{kind:'room_only'};
      const h=host(ctx);let claim=null;
      // Project discussion has no filesystem claim. The credential-bearing
      // main checks KSwarm membership per operation; scope is always taken
      // from this authoritative message, never a caller-supplied assertion.
      if(input.discussionOnly===true){scope(sourceScope);}
      else {claim=ownClaim(input,ctx,{running:true});if(canonicalWorkspaceJSON(claim.contextScope)!==canonicalWorkspaceJSON(sourceScope))reject('room_scope_mismatch');}
      return {authorization:{roomId:r.roomId,roomMessageId:source.messageId,discussionOnly:input.discussionOnly===true,claimId:claim?.claimId??null,logicalAgentId:ctx.actor.logicalAgentId,membershipRevision:m.membershipRevision,discussionEpoch:r.discussionEpoch,hostPrincipal:ctx.hostPrincipal,hostIncarnation:h.hostIncarnation}};
    }),
  };
  api.recordWake=(claimToken,authorization)=>put('wake',claimToken,authorization.roomId,authorization);
  api.validateWake=claimToken=>{
    const grant=get('wake',claimToken);if(!grant)return {ok:true};
    const r=store.getRoomRow(grant.roomId);const m=store.getMember(grant.roomId,{kind:'agent',logicalAgentId:grant.logicalAgentId});
    if(r?.status!=='active'||r.discussionEpoch!==grant.discussionEpoch||m?.status!=='active'||m.membershipRevision!==grant.membershipRevision)return {ok:false,code:'workspace_claim_revoked'};
    if(get('host',grant.hostPrincipal)?.hostIncarnation!==grant.hostIncarnation)return {ok:false,code:'workspace_host_fenced'};
    if(grant.claimId){const c=get('claim',grant.claimId);if(!c||c.authorizationState!=='valid'||c.executionState!=='running')return {ok:false,code:'workspace_claim_revoked'};}
    return {ok:true};
  };
  // Called inside archive/member mutation's existing Room transaction.
  api.onRoomMutation=(roomId,reason)=>{
    if(!config(roomId))return;
    const seq=sequence(roomId);
    for(const c of list('claim',roomId)){
      const m=store.getMember(roomId,{kind:'agent',logicalAgentId:c.logicalAgentId});
      if(reason==='archive'||reason==='discussion-cancel'||m?.status!=='active'||m.membershipRevision!==c.membershipRevision){c.authorizationState=reason==='discussion-cancel'?'cancel_requested':'revoked';c.roomSequence=seq;put('claim',c.claimId,roomId,c);}
    }
    put('audit',`${roomId}:${seq}`,roomId,{roomSequence:seq,action:reason,at:time()});
  };
  api.requiresProtocol=roomId=>Boolean(get('minimum',roomId));
  return api;
}
