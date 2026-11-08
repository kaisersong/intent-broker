import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {types} from 'node:util';

const fixed=new URL('../../runtime/original-authority-sqlite.cjs',import.meta.url);
const load=createRequire(import.meta.url),platform=process.platform;
const keys=Reflect.ownKeys,descriptor=Object.getOwnPropertyDescriptor,own=Object.hasOwn;
const frozen=Object.isFrozen,isProxy=types.isProxy,ErrorType=Error;
const names=['namespace','bindNamespace','finish'];
let birth;
function invalid(){throw new ErrorType('broker_protected_resource_invalid');}

/** Fixed resource contract only. Native membership remains the producer's job;
 * no caller namespace, resolver, factory or environment can supply this module. */
export function readBrokerProtectedSQLiteResource(){
 if(new.target)throw new ErrorType('broker_protected_resource_constructor');
 if(arguments.length)throw new ErrorType('broker_protected_resource_arguments');
 if(birth){
  if(birth.failure)throw birth.failure.raw;
  if(!birth.ready){birth.failure={raw:new ErrorType('broker_protected_resource_birth_pending')};throw birth.failure.raw;}
  return birth.value;
 }
 const row={};birth=row;
 try{
  if(platform!=='darwin'||!existsSync(fixed)){row.value=null;row.ready=true;return null;}
  row.raw=load(fileURLToPath(fixed));
  if(row.failure)throw row.failure.raw;
  const value=row.raw;
  if(!value||typeof value!=='object'||isProxy(value)||!frozen(value))invalid();
  const actual=keys(value);if(actual.length!==names.length)invalid();
  for(const name of names){
   const field=descriptor(value,name);if(!field||!own(field,'value'))invalid();
   const member=field.value;
   if(name==='namespace'){
    if(member!==null&&(!member||typeof member!=='object'||isProxy(member)||!frozen(member)))invalid();
   }else if(typeof member!=='function'||isProxy(member)||!frozen(member))invalid();
  }
  row.value=value;row.ready=true;return value;
 }catch(raw){if(!row.failure)row.failure={raw};throw row.failure.raw;}
}
