import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomStore} from '../../src/room/store.js';
import {createRoomService} from '../../src/room/service.js';
import {createTempDbPath} from '../fixtures/temp-dir.js';
function fixture(t){const store=createRoomStore({dbPath:createTempDbPath()});store.migrate();t.after(()=>store.close());const service=createRoomService({store}),w=service.workspace;const user={sessionId:'desktop',requestSource:'user',actor:{kind:'user',userId:'user.local'},issuedAt:new Date().toISOString(),hostPrincipal:'host'};const roomId=service.createRoom({title:'source',memberAgentIds:['a']},user).room.roomId;user.hostIncarnation=w.registerHost({startupId:'boot'},user).host.hostIncarnation;let r=w.beginChange({roomId,expectedRevision:0,requestId:'bind',payloadDigest:'a'.repeat(64)},user);r=w.commitBinding({roomId,expectedRevision:r.config.revision,operationId:r.config.operationId,workspaceId:'workspace',bindingId:'binding',payloadDigest:'a'.repeat(64)},user);r=w.activateBinding({roomId,expectedRevision:r.config.revision,operationId:r.config.operationId},user);assert.equal(r.ok,true);const agent={...user,requestSource:'agent',actor:{kind:'agent',logicalAgentId:'a'},allowedLogicalAgentIds:['a']};const acquired=w.acquireClaim({roomId,runId:'run',executorInstanceId:'executor',contextScope:{kind:'room_only'},capability:{contextVersion:1,resultVersion:1,releaseVersion:1,canSetCwd:true,canTrackChildren:true,canRelease:true}},agent);assert.equal(acquired.ok,true);const c=acquired.claim;const echo=Object.fromEntries(['protocolVersion','runId','executorInstanceId','workspaceId','originHostId','hostIncarnation','bindingId','generation','instructionsRevision'].map(k=>[k,c[k]]));assert.equal(w.ackClaim({roomId,claimId:c.claimId,...echo,cwdVerified:true,actualCwd:'/fixture'},agent).ok,true);return {store,service,w,user,agent,roomId,claim:c};}
const destination={url:'https://example.test/v1/chat/completions',model:'fixture-model',protocol:'generic-openai'};
test('participant preparation requires actual user disclosure consent, freezes exact source facts, and blocks original archive',t=>{const f=fixture(t);const grantInput={roomId:f.roomId,requestId:'grant',logicalAgentId:'a',destination,expiresAt:Date.now()+60000};assert.equal(f.w.approveDisclosureGrant(grantInput,f.agent).ok,false);const grant=f.w.approveDisclosureGrant(grantInput,f.user);assert.equal(grant.ok,true,JSON.stringify(grant));const request={roomId:f.roomId,claimId:f.claim.claimId,grantId:grant.grant.grantId,attemptId:'attempt',invocationId:'invocation',bodySha256:'b'.repeat(64),destination,egressId:'egress',egressGeneration:1,sourceMessageIds:[],includeInstructions:false};const prepared=f.w.prepareDisclosure(request,f.agent);assert.equal(prepared.ok,true,JSON.stringify(prepared));assert.equal(prepared.lease.state,'PREPARED');assert.equal(prepared.lease.claim.claimId,f.claim.claimId);assert.deepEqual(f.w.prepareDisclosure(request,f.agent).lease,prepared.lease);assert.equal(f.w.prepareDisclosure({...request,bodySha256:'c'.repeat(64)},f.agent).ok,false);assert.equal(f.w.prepareDisclosure({...request,attemptId:'retry-with-new-id'},f.agent).ok,false);assert.equal(f.w.prepareDisclosure({...request,unclassifiedMaterial:'ignored?'},f.agent).ok,false);assert.equal(f.w.prepareDisclosure({...request,attemptId:'other',destination:{...destination,model:'other'}},f.agent).ok,false);assert.equal(f.service.archiveRoom({roomId:f.roomId},f.user).code,'disclosure_revocation_pending');assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM room_disclosure_mutations WHERE state='PENDING'").get().n,1);assert.equal(f.w.queryDisclosure({roomId:f.roomId,attemptId:'attempt'},f.agent).lease.bodySha256,request.bodySha256);});
test('claim and grant provenance cannot be replaced by another actor or DTO',t=>{const f=fixture(t);assert.equal(f.w.prepareDisclosure({roomId:f.roomId,claimId:f.claim.claimId,grantId:'fake'},f.agent).ok,false);assert.equal(f.w.approveDisclosureGrant({roomId:f.roomId,requestId:'grant',logicalAgentId:'missing',destination,expiresAt:Date.now()+60000},f.user).ok,false);});
test('instruction publication persists pending in its original transaction and cannot replace its exact pending input',t=>{
 const f=fixture(t);const revision=f.w.getState({roomId:f.roomId},f.user).config.revision;
 f.store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run('instructions-held',f.roomId,'{}');
 const input={roomId:f.roomId,expectedRevision:revision,requestId:'instructions-change',publishedText:'new policy'};
 const pending=f.w.publishInstructions(input,f.user);assert.equal(pending.code,'disclosure_revocation_pending');
 assert.equal(f.w.getState({roomId:f.roomId},f.user).config.revision,revision);
 assert.equal(f.w.publishInstructions({...input,publishedText:'different policy'},f.user).code,'disclosure_mutation_conflict');
 f.store.db.prepare("UPDATE room_disclosure_leases SET state='RELEASED' WHERE attempt_id='instructions-held'").run();
 const applied=f.w.publishInstructions(input,f.user);assert.equal(applied.ok,true);assert.equal(applied.instructions.publishedText,'new policy');
 assert.equal(f.store.db.prepare('SELECT state FROM room_disclosure_mutations WHERE mutation_id=?').get(pending.mutationId).state,'APPLIED');
});
test('binding change does not move source generation until its durable held disclosure is resolved',t=>{
 const f=fixture(t);const before=f.w.getState({roomId:f.roomId},f.user).config;
 f.store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run('binding-held',f.roomId,'{}');
 const input={roomId:f.roomId,expectedRevision:before.revision,requestId:'change-binding',payloadDigest:'d'.repeat(64)};
 const pending=f.w.beginChange(input,f.user);assert.equal(pending.code,'disclosure_revocation_pending');
 assert.equal(f.w.getState({roomId:f.roomId},f.user).config.phase,'active');
 f.store.db.prepare("UPDATE room_disclosure_leases SET state='RELEASED' WHERE attempt_id='binding-held'").run();
 const applied=f.w.beginChange(input,f.user);assert.equal(applied.ok,true);assert.equal(applied.config.phase,'draining');
 assert.equal(f.store.db.prepare('SELECT state FROM room_disclosure_mutations WHERE mutation_id=?').get(pending.mutationId).state,'APPLIED');
});
test('host incarnation change records one atomic global pending intent without partially advancing source authority',t=>{
 const f=fixture(t);const second=f.service.createRoom({title:'second source',memberAgentIds:['a']},f.user).room.roomId;
 f.store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run('host-held',f.roomId,'{}');
 f.store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run('second-host-held',second,'{}');
 const old=f.user.hostIncarnation;const pending=f.w.registerHost({startupId:'next-boot'},f.user);
 assert.equal(pending.code,'disclosure_revocation_pending');
 const host=JSON.parse(f.store.db.prepare("SELECT value_json FROM room_workspace_records WHERE kind='host' AND record_key='host'").get().value_json);
 assert.equal(host.hostIncarnation,old);
 const rows=f.store.db.prepare("SELECT room_id,payload_json FROM room_disclosure_mutations WHERE state='PENDING'").all();
 assert.equal(rows.length,1);assert.equal(rows[0].room_id,'');assert.ok(JSON.parse(rows[0].payload_json).roomIds.includes(f.roomId));
 assert.equal(f.w.registerHost({startupId:'third-boot'},f.user).code,'disclosure_mutation_conflict');
 f.store.db.prepare("UPDATE room_disclosure_leases SET state='RELEASED' WHERE attempt_id='host-held'").run();
 f.store.db.prepare("UPDATE room_disclosure_leases SET state='RELEASED' WHERE attempt_id='second-host-held'").run();
 const applied=f.w.registerHost({startupId:'next-boot'},f.user);assert.equal(applied.ok,true);assert.equal(applied.host.hostIncarnation,old+1);
 assert.equal(f.store.db.prepare('SELECT state FROM room_disclosure_mutations WHERE mutation_id=?').get(pending.mutationId).state,'APPLIED');
 assert.equal(f.store.getRoomRow(second).status,'active');
});
test('another actual source-grant mutation cannot strand an already pending instruction revision',t=>{
 const f=fixture(t);const config=f.w.getState({roomId:f.roomId},f.user).config;
 f.store.db.prepare("INSERT INTO room_disclosure_leases VALUES(?,?,'PREPARED',?)").run('pending-grant-race',f.roomId,'{}');
 const input={roomId:f.roomId,expectedRevision:config.revision,requestId:'pending-policy',publishedText:'authorized policy'};
 assert.equal(f.w.publishInstructions(input,f.user).code,'disclosure_revocation_pending');
 f.store.db.prepare("UPDATE room_disclosure_leases SET state='RELEASED' WHERE attempt_id='pending-grant-race'").run();
 const competing=f.w.issueReadGrant({roomId:f.roomId,expectedRevision:config.revision,requestId:'competing-grant',subjectKind:'agent',subjectId:'a',contextScope:{kind:'room_only'},bindingId:config.activeBindingId,generation:config.generation,allowedPathsOrVersions:[{kind:'path',relativePath:'',recursive:true}]},f.user);
 assert.equal(competing.ok,false);assert.equal(competing.code,'disclosure_mutation_pending');
 assert.equal(f.w.publishInstructions(input,f.user).ok,true);
});

test('independent regression: actual claim heartbeat remains available while disclosure is held',t=>{const f=fixture(t);const grant=f.w.approveDisclosureGrant({roomId:f.roomId,requestId:'hb-grant',logicalAgentId:'a',destination,expiresAt:Date.now()+60000},f.user);assert.equal(grant.ok,true);const result=f.w.prepareDisclosure({roomId:f.roomId,claimId:f.claim.claimId,grantId:grant.grant.grantId,attemptId:'hb-attempt',invocationId:'hb-invocation',bodySha256:'b'.repeat(64),destination,egressId:'egress',egressGeneration:1,sourceMessageIds:[],includeInstructions:false},f.agent);assert.equal(result.ok,true);const echo=Object.fromEntries(['protocolVersion','runId','executorInstanceId','workspaceId','originHostId','hostIncarnation','bindingId','generation','instructionsRevision'].map(k=>[k,f.claim[k]]));assert.equal(f.w.heartbeatClaim({roomId:f.roomId,claimId:f.claim.claimId,...echo},f.agent).ok,true);
 assert.equal(f.w.heartbeatClaim({roomId:f.roomId,claimId:'unknown',...echo},f.agent).ok,false);
 const row=f.store.db.prepare("SELECT value_json FROM room_workspace_records WHERE kind='claim' AND record_key=?").get(f.claim.claimId);const claim=JSON.parse(row.value_json);
 assert.throws(()=>f.store.db.prepare("UPDATE room_workspace_records SET value_json=? WHERE kind='claim' AND record_key=?").run(JSON.stringify({...claim,authorizationState:'revoked'}),f.claim.claimId),/disclosure_lease_held/);
});
test('participant preserves an explicitly approved provider query and rejects changed query reuse',t=>{
 const f=fixture(t),exact={...destination,url:destination.url+'?api-version=2026-01-01'};
 const approved=f.w.approveDisclosureGrant({roomId:f.roomId,requestId:'query-grant',logicalAgentId:'a',destination:exact,expiresAt:Date.now()+60000},f.user);
 assert.equal(approved.ok,true,JSON.stringify(approved));
 const request={roomId:f.roomId,claimId:f.claim.claimId,grantId:approved.grant.grantId,attemptId:'query-attempt',invocationId:'query-invocation',bodySha256:'b'.repeat(64),destination:exact,egressId:'egress',egressGeneration:1,sourceMessageIds:[],includeInstructions:false};
 const prepared=f.w.prepareDisclosure(request,f.agent);assert.equal(prepared.ok,true,JSON.stringify(prepared));assert.equal(prepared.lease.destination.url,exact.url);
 assert.equal(f.w.prepareDisclosure({...request,destination:{...exact,url:destination.url+'?api-version=2026-02-01'}},f.agent).ok,false);
});
