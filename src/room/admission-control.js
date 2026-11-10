import {createHash,createHmac} from 'node:crypto';
import {types} from 'node:util';

const apply=Reflect.apply,keys=Reflect.ownKeys,descriptor=Object.getOwnPropertyDescriptor,proto=Object.getPrototypeOf,own=Object.hasOwn;
const plain=Object.prototype,isProxy=types.isProxy,stringify=JSON.stringify,parse=JSON.parse;
const safe=Number.isSafeInteger,byteLength=Buffer.byteLength;
const refPattern=/^[^\x00-\x1f\x7f]+$/,digestPattern=/^[a-f0-9]{64}$/,uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const test=RegExp.prototype.test,trim=String.prototype.trim,sort=Array.prototype.sort;
const failures=new WeakMap();
function deny(code='admission_input_invalid'){const error=new Error(code);failures.set(error,code);throw error;}
export function readAdmissionControlFailure(raw){return raw!==null&&(typeof raw==='object'||typeof raw==='function')?failures.get(raw):undefined;}
function record(value,fields){
 if(!value||typeof value!=='object'||isProxy(value)||proto(value)!==plain&&proto(value)!==null)deny();
 const names=keys(value);if(names.length!==fields.length)deny();const out=Object.create(null);
 for(let i=0;i<fields.length;i++){const key=fields[i],d=descriptor(value,key);if(!d||!own(d,'value'))deny();out[key]=d.value;}
 return out;
}
function ref(value){if(typeof value!=='string'||apply(trim,value,[])!==value||byteLength(value,'utf8')>256||!apply(test,refPattern,[value]))deny();return value;}
function integer(value){if(!safe(value)||value<1)deny();return value;}
function digest(value){if(typeof value!=='string'||!apply(test,digestPattern,[value]))deny();return value;}
function scope(value){const r=record(value,['profileId','workspaceId']);ref(r.profileId);ref(r.workspaceId);return r;}
function authority(value){const r=record(value,['authorityId','authorityEpoch']);ref(r.authorityId);integer(r.authorityEpoch);return r;}
function realm(value){if(typeof value!=='string'||!apply(test,uuidPattern,[value]))deny();return value;}
function range(value){const r=record(value,['sourceBindingId','mandateId','workId']);for(const key of ['sourceBindingId','mandateId','workId'])if(r[key]!==null)ref(r[key]);if(r.mandateId!==null&&r.sourceBindingId===null||r.workId!==null&&r.mandateId===null)deny();return r;}
export function canonicalAdmissionJSON(value){
 if(value===null||typeof value==='string'||typeof value==='boolean')return stringify(value);
 if(typeof value==='number'&&safe(value)&&!Object.is(value,-0))return stringify(value);
 if(!value||typeof value!=='object'||isProxy(value)||proto(value)!==plain&&proto(value)!==null)deny();
 const names=keys(value);for(let i=0;i<names.length;i++)if(typeof names[i]!=='string')deny();apply(sort,names,[]);
 let json='{';for(let i=0;i<names.length;i++){const d=descriptor(value,names[i]);if(!d||!own(d,'value'))deny();if(i)json+=',';json+=stringify(names[i])+':'+canonicalAdmissionJSON(d.value);}return json+'}';
}
export function admissionDigest(value){return createHash('sha256').update('xiaok.broker-admission.v1\0').update(canonicalAdmissionJSON(value)).digest('hex');}
function visibility(value){const r=record(value,['kind']);if(r.kind!=='no_visibility')deny('admission_visibility_unavailable');return r;}
function baselineInput(value){const r=record(value,['schemaVersion','scope','authority','operationId','visibility']);if(r.schemaVersion!==1)deny();r.scope=scope(r.scope);r.authority=authority(r.authority);ref(r.operationId);r.visibility=visibility(r.visibility);return r;}
function policy(axis,value){
 if(axis==='mode'){const r=record(value,['mode']);if(r.mode!=='off'&&r.mode!=='observe'&&r.mode!=='auto_draft')deny();return r;}
 if(axis==='authorization'){const r=record(value,['allowed','reasonCode']);if(typeof r.allowed!=='boolean'||r.reasonCode!=='BASELINE'&&r.reasonCode!=='POLICY_CHANGE'&&r.reasonCode!=='VISIBILITY_NARROWING')deny();return r;}
 if(axis==='egress'){if(value&&typeof value==='object'&&!isProxy(value)&&own(value,'allowed')){const r=record(value,['allowed']);if(typeof r.allowed!=='boolean')deny();return r;}const r=record(value,['enabled','policyRef']);if(typeof r.enabled!=='boolean')deny();if(r.policyRef!==null)ref(r.policyRef);if(r.enabled&&r.policyRef===null)deny();return r;}
 deny('admission_axis_invalid');
}
function applyInput(value){
 const r=record(value,['schemaVersion','scope','authority','realmId','range','axis','controlKey','sourceHeadId','commandHash','epoch','operationId','canonicalPolicyHash','policy']);
 if(r.schemaVersion!==1)deny();r.scope=scope(r.scope);r.authority=authority(r.authority);realm(r.realmId);r.range=range(r.range);digest(r.controlKey);ref(r.sourceHeadId);digest(r.commandHash);if(r.controlKey!==admissionDigest({sourceHeadId:r.sourceHeadId,axis:r.axis}))deny();integer(r.epoch);ref(r.operationId);digest(r.canonicalPolicyHash);r.policy=policy(r.axis,r.policy);
 if(admissionDigest(r.policy)!==r.canonicalPolicyHash)deny('admission_policy_hash_conflict');return r;
}
function readInput(value){const r=record(value,['schemaVersion','scope','authority','realmId','operationId']);if(r.schemaVersion!==1)deny();r.scope=scope(r.scope);r.authority=authority(r.authority);realm(r.realmId);ref(r.operationId);return r;}

export const admissionControlMigration={version:9,id:'room_admission_control_v1',up(db){db.exec(`
 CREATE TABLE room_admission_baselines(scope_key TEXT PRIMARY KEY,realm_id TEXT NOT NULL,principal_id TEXT NOT NULL,authority_id TEXT NOT NULL,authority_epoch INTEGER NOT NULL CHECK(authority_epoch>=1),storage_revision INTEGER NOT NULL CHECK(storage_revision>=1),data_json TEXT NOT NULL CHECK(typeof(data_json)='text'),body_hash TEXT NOT NULL CHECK(typeof(body_hash)='text' AND length(body_hash)=64),logical_bytes INTEGER NOT NULL CHECK(logical_bytes>=1));
 CREATE TABLE room_admission_heads(scope_key TEXT NOT NULL,control_key TEXT NOT NULL,axis TEXT NOT NULL CHECK(axis IN ('mode','authorization','egress')),epoch INTEGER NOT NULL CHECK(epoch>=1),operation_id TEXT NOT NULL,data_json TEXT NOT NULL CHECK(typeof(data_json)='text'),body_hash TEXT NOT NULL CHECK(typeof(body_hash)='text' AND length(body_hash)=64),logical_bytes INTEGER NOT NULL CHECK(logical_bytes>=1),PRIMARY KEY(scope_key,control_key),FOREIGN KEY(scope_key) REFERENCES room_admission_baselines(scope_key));
 CREATE TABLE room_admission_receipts(scope_key TEXT NOT NULL,operation_id TEXT NOT NULL,receipt_kind TEXT NOT NULL CHECK(receipt_kind IN ('baseline','fence')),storage_revision INTEGER NOT NULL CHECK(storage_revision>=1),data_json TEXT NOT NULL CHECK(typeof(data_json)='text'),body_hash TEXT NOT NULL CHECK(typeof(body_hash)='text' AND length(body_hash)=64),logical_bytes INTEGER NOT NULL CHECK(logical_bytes>=1),PRIMARY KEY(scope_key,operation_id),UNIQUE(scope_key,storage_revision),FOREIGN KEY(scope_key) REFERENCES room_admission_baselines(scope_key));
 CREATE TRIGGER room_admission_receipts_update BEFORE UPDATE ON room_admission_receipts BEGIN SELECT RAISE(ABORT,'admission_receipt_immutable');END;
 CREATE TRIGGER room_admission_receipts_delete BEFORE DELETE ON room_admission_receipts BEGIN SELECT RAISE(ABORT,'admission_receipt_immutable');END;
 CREATE TRIGGER room_admission_receipts_insert BEFORE INSERT ON room_admission_receipts WHEN EXISTS(SELECT 1 FROM room_admission_receipts WHERE scope_key=NEW.scope_key AND operation_id=NEW.operation_id) BEGIN SELECT RAISE(ABORT,'admission_receipt_immutable');END;
 CREATE TRIGGER room_admission_baselines_delete BEFORE DELETE ON room_admission_baselines BEGIN SELECT RAISE(ABORT,'admission_baseline_immutable');END;
 CREATE TRIGGER room_admission_baselines_identity BEFORE UPDATE ON room_admission_baselines WHEN NEW.scope_key<>OLD.scope_key OR NEW.realm_id<>OLD.realm_id OR NEW.principal_id<>OLD.principal_id OR NEW.authority_id<>OLD.authority_id OR NEW.authority_epoch<>OLD.authority_epoch OR NEW.data_json<>OLD.data_json OR NEW.body_hash<>OLD.body_hash OR NEW.logical_bytes<>OLD.logical_bytes OR NEW.storage_revision<>OLD.storage_revision+1 BEGIN SELECT RAISE(ABORT,'admission_baseline_immutable');END;
 CREATE TRIGGER room_admission_heads_delete BEFORE DELETE ON room_admission_heads BEGIN SELECT RAISE(ABORT,'admission_head_immutable');END;
 `);}};

/** Metadata-only control domain on the original Room connection. Authenticated
 * transport supplies principal/actor; payloads never select either identity. */
export function createRoomAdmissionControl({store}){
 const db=store.db;
 function context(ctx){
  if(!ctx||ctx.requestSource!=='scheduler'||ctx.actor?.kind!=='system'||ctx.actor.service!=='desktop')deny('room_actor_forbidden');
  return ref(ctx.hostPrincipal);
 }
 function scopeKey(s,principal){return admissionDigest({scope:s,principal});}
 function textRow(row){
  if(typeof row.data_json!=='string'||typeof row.body_hash!=='string'||!safe(row.logical_bytes)||row.logical_bytes!==byteLength(row.data_json,'utf8'))deny('admission_storage_conflict');
  let data;try{data=parse(row.data_json);}catch{deny('admission_storage_conflict');}
  if(canonicalAdmissionJSON(data)!==row.data_json||admissionDigest(data)!==row.body_hash)deny('admission_storage_conflict');return data;
 }
 function base(s,principal){
  const key=scopeKey(s,principal),row=db.prepare('SELECT * FROM room_admission_baselines WHERE scope_key=?').get(key);if(!row)deny('admission_baseline_required');
  const data=record(textRow(row),['schemaVersion','scope','authority','realmId','principalId','visibility','operationId']);
  scope(data.scope);authority(data.authority);visibility(data.visibility);ref(data.operationId);realm(data.realmId);ref(data.principalId);
  if(data.schemaVersion!==1||canonicalAdmissionJSON(data.scope)!==canonicalAdmissionJSON(s)||data.principalId!==principal||data.realmId!==store.getSourceRealm()||row.realm_id!==data.realmId||row.principal_id!==principal||row.authority_id!==data.authority.authorityId||row.authority_epoch!==data.authority.authorityEpoch||!safe(row.storage_revision)||row.storage_revision<1)deny('admission_storage_conflict');
  const b={key,row,data};
  const baseline=getReceipt(b,data.operationId);if(!baseline||baseline.kind!=='baseline')deny('admission_storage_conflict');
  const revisions=db.prepare('SELECT count(*) AS n,MAX(storage_revision) AS last FROM room_admission_receipts WHERE scope_key=?').get(key);
  if(revisions.n!==row.storage_revision||revisions.last!==row.storage_revision)deny('admission_storage_conflict');
  return b;
 }
 function assertAuthority(b,input){if(canonicalAdmissionJSON(b.data.authority)!==canonicalAdmissionJSON(input.authority)||input.realmId!==undefined&&input.realmId!==b.data.realmId)deny('admission_authority_conflict');}
 function getReceipt(b,operationId){
  const row=db.prepare('SELECT * FROM room_admission_receipts WHERE scope_key=? AND operation_id=?').get(b.key,operationId);if(!row)return null;
  const data=record(textRow(row),['schemaVersion','kind','realmId','domainId','scope','authority','operationId','storageRevision','request','durableGuard']);
  const input=data.kind==='baseline'?baselineInput(data.request):data.kind==='fence'?applyInput(data.request):deny('admission_storage_conflict');
  if(data.schemaVersion!==1||row.receipt_kind!==data.kind||row.operation_id!==operationId||data.operationId!==operationId||input.operationId!==operationId||data.realmId!==b.data.realmId||data.domainId!==domain(b)||canonicalAdmissionJSON(data.scope)!==canonicalAdmissionJSON(b.data.scope)||canonicalAdmissionJSON(input.scope)!==canonicalAdmissionJSON(b.data.scope)||canonicalAdmissionJSON(data.authority)!==canonicalAdmissionJSON(b.data.authority)||canonicalAdmissionJSON(input.authority)!==canonicalAdmissionJSON(b.data.authority)||data.storageRevision!==row.storage_revision||!safe(data.storageRevision)||data.storageRevision<1||data.storageRevision>b.row.storage_revision||data.durableGuard!==admissionDigest({realmId:data.realmId,scopeKey:b.key,request:input,storageRevision:data.storageRevision}))deny('admission_storage_conflict');
  if(data.kind==='baseline'&&(data.operationId!==b.data.operationId||canonicalAdmissionJSON(input.visibility)!==canonicalAdmissionJSON(b.data.visibility)||data.storageRevision!==1))deny('admission_storage_conflict');
  return data;
 }
 function head(b,key){
  const row=db.prepare('SELECT * FROM room_admission_heads WHERE scope_key=? AND control_key=?').get(b.key,key);if(!row)return null;
  const input=applyInput(textRow(row));assertAuthority(b,input);
  if(row.control_key!==input.controlKey||row.axis!==input.axis||row.epoch!==input.epoch||row.operation_id!==input.operationId||canonicalAdmissionJSON(input.scope)!==canonicalAdmissionJSON(b.data.scope))deny('admission_storage_conflict');
  const receipt=getReceipt(b,input.operationId);if(!receipt||receipt.kind!=='fence'||canonicalAdmissionJSON(receipt.request)!==canonicalAdmissionJSON(input))deny('admission_storage_conflict');return input;
 }
 function domain(b){return 'broker-dsh:'+b.data.realmId+':'+b.key;}
 function reply(b,receipt){
  const current=receipt.kind==='baseline'?true:canonicalAdmissionJSON(head(b,receipt.request.controlKey))===canonicalAdmissionJSON(receipt.request);
  return {ok:true,domain:{schemaVersion:1,kind:'broker_dsh',ownerKind:'active_pointer',domainId:domain(b),storeId:b.data.realmId,scope:b.data.scope,writerProfile:'broker_dsh_control_v1',writerSchemaVersion:9},visibility:b.data.visibility,receipt,current};
 }
 function writeReceipt(b,input,kind,revision){
  const data={schemaVersion:1,kind,realmId:b.data.realmId,domainId:domain(b),scope:b.data.scope,authority:b.data.authority,operationId:input.operationId,storageRevision:revision,request:input,durableGuard:admissionDigest({realmId:b.data.realmId,scopeKey:b.key,request:input,storageRevision:revision})};
  const json=canonicalAdmissionJSON(data);db.prepare('INSERT INTO room_admission_receipts VALUES(?,?,?,?,?,?,?)').run(b.key,input.operationId,kind,revision,json,admissionDigest(data),byteLength(json,'utf8'));return data;
 }
 function invoke(fn,readOnly=false){return (input,ctx)=>{try{const principal=context(ctx);return (readOnly?store.withReadTransaction:store.withTransaction)(()=>fn(input,principal));}catch(error){const code=readAdmissionControlFailure(error);if(code)return {ok:false,code};throw error;}};}
 const establishAdmissionBaseline=invoke((raw,principal)=>{
  const input=baselineInput(raw),key=scopeKey(input.scope,principal),old=db.prepare('SELECT 1 FROM room_admission_baselines WHERE scope_key=?').get(key);
  if(old){const b=base(input.scope,principal);assertAuthority(b,input);const receipt=getReceipt(b,input.operationId);if(!receipt||receipt.kind!=='baseline'||canonicalAdmissionJSON(receipt.request)!==canonicalAdmissionJSON(input))deny('admission_baseline_conflict');return reply(b,receipt);}
  const realmId=store.getSourceRealm(),data={schemaVersion:1,scope:input.scope,authority:input.authority,realmId,principalId:principal,visibility:input.visibility,operationId:input.operationId},json=canonicalAdmissionJSON(data);
  db.prepare('INSERT INTO room_admission_baselines VALUES(?,?,?,?,?,?,?,?,?)').run(key,realmId,principal,input.authority.authorityId,input.authority.authorityEpoch,1,json,admissionDigest(data),byteLength(json,'utf8'));
  const b={key,row:{storage_revision:1},data},receipt=writeReceipt(b,input,'baseline',1);return reply(base(input.scope,principal),receipt);
 });
 const applyAdmissionFence=invoke((raw,principal)=>{
  const input=applyInput(raw),b=base(input.scope,principal);assertAuthority(b,input);
  const previous=getReceipt(b,input.operationId);if(previous){if(previous.kind!=='fence'||canonicalAdmissionJSON(previous.request)!==canonicalAdmissionJSON(input))deny('admission_operation_conflict');return reply(b,previous);}
  const old=head(b,input.controlKey);
  if(old&&(old.axis!==input.axis||old.sourceHeadId!==input.sourceHeadId||canonicalAdmissionJSON(old.range)!==canonicalAdmissionJSON(input.range)||input.epoch<old.epoch||input.epoch===old.epoch&&(old.commandHash!==input.commandHash||old.canonicalPolicyHash!==input.canonicalPolicyHash||canonicalAdmissionJSON(old.policy)!==canonicalAdmissionJSON(input.policy))))deny('admission_epoch_conflict');
  const revision=b.row.storage_revision+1;integer(revision);const json=canonicalAdmissionJSON(input);
  db.prepare('UPDATE room_admission_baselines SET storage_revision=? WHERE scope_key=? AND storage_revision=?').run(revision,b.key,b.row.storage_revision);
  db.prepare('INSERT INTO room_admission_heads VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope_key,control_key) DO UPDATE SET epoch=excluded.epoch,operation_id=excluded.operation_id,data_json=excluded.data_json,body_hash=excluded.body_hash,logical_bytes=excluded.logical_bytes').run(b.key,input.controlKey,input.axis,input.epoch,input.operationId,json,admissionDigest(input),byteLength(json,'utf8'));
  b.row.storage_revision=revision;const receipt=writeReceipt(b,input,'fence',revision);return reply(b,receipt);
 });
 const readAdmissionControlReceipt=invoke((raw,principal)=>{const input=readInput(raw),b=base(input.scope,principal);assertAuthority(b,input);const receipt=getReceipt(b,input.operationId);if(!receipt)deny('admission_receipt_required');return reply(b,receipt);},true);
 return {establishAdmissionBaseline,applyAdmissionFence,readAdmissionControlReceipt};
}

/** Transport-authenticated envelope; no raw payload may choose actor/source. */
export function serveAdmissionControl(service,action,raw,desktopToken){
 const envelope=record(raw,['protocol','challenge','requestDigest','input']);
 if(envelope.protocol!=='broker_dsh_control_v1'||typeof envelope.challenge!=='string'||!apply(test,digestPattern,[envelope.challenge])||envelope.requestDigest!==admissionDigest(envelope.input))deny();
 const methods={baseline:service.establishAdmissionBaseline,apply:service.applyAdmissionFence,read:service.readAdmissionControlReceipt};
 const fn=own(methods,action)?methods[action]:undefined;if(typeof fn!=='function')deny();
 const principal=createHash('sha256').update('room-host-installation\n').update(desktopToken).digest('hex');
 const body=apply(fn,service,[envelope.input,{requestSource:'scheduler',actor:{kind:'system',service:'desktop'},hostPrincipal:principal}]);
 const authenticated={protocol:envelope.protocol,challenge:envelope.challenge,requestDigest:envelope.requestDigest,body};
 const authentication=createHmac('sha256',desktopToken).update('xiaok.broker-dsh-reply.v1\0').update(canonicalAdmissionJSON(authenticated)).digest('hex');
 return {...authenticated,authentication};
}
