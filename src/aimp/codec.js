import {createHash,sign,verify,createPublicKey} from 'node:crypto';

export const sha256=value=>createHash('sha256').update(value).digest('hex');
export function canonical(value,depth=0){
 if(depth>32)throw Error('aimp_depth_exceeded');
 if(value===null||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='string'){
  for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=value.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))throw Error('aimp_invalid_unicode');}else if(c>=0xdc00&&c<=0xdfff)throw Error('aimp_invalid_unicode');}
  return JSON.stringify(value);
 }
 if(typeof value==='number'&&Number.isSafeInteger(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>canonical(k)+':'+canonical(value[k],depth+1)).join(',')+'}';
 throw Error('aimp_invalid_json');
}
const fields=['aimp','id','thread_id','room_id','task_ref','control_ref','target_event','from','to','mentions','audience','exp','key_id','reply_to','act','source_level','classification','capability_token','intent_origin'];
export const pick=(input,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]));
export function intentProjection(message){
 canonical(message.body);
 const result={...pick(message,fields),body_hash:sha256(message.body)};
 if(Object.hasOwn(message,'payload'))result.payload_hash=sha256(canonical(message.payload));
 if(Object.hasOwn(message,'artifacts'))result.artifacts=message.artifacts.map(a=>pick(a,['ref','version','sha256','media_type']));
 return result;
}
export function eventProjection(event){return event.act.startsWith('sys.')?pick(event,['id','thread_id','task_ref','control_ref','target_event','act','source_level','key_id','payload']):intentProjection(event);}
export const signatureBytes=(domain,projection)=>Buffer.concat([Buffer.from('AIMP/1/'+domain+'\0'),Buffer.from(canonical(projection))]);
export const signProjection=(domain,projection,key)=>sign(null,signatureBytes(domain,projection),key).toString('hex');
export function verifyProjection(domain,projection,signature,key){
 if(!/^[a-f0-9]{128}$/.test(signature??''))return false;
 return verify(null,signatureBytes(domain,projection),createPublicKey(key),Buffer.from(signature,'hex'));
}
