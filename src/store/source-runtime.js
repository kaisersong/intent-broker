import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {types} from 'node:util';
import {fileURLToPath} from 'node:url';
const fixed=new URL('../../runtime/xiaok-source-runtime.cjs',import.meta.url),load=createRequire(import.meta.url);
let birth;
// A missing standalone build retains legacy behavior. A managed Native child
// must verify its fixed resource closure in its original bootstrap (pending),
// never via an environment token, caller path, verifier or this JS adapter.
export function readBrokerSourceRuntime(){
 if(birth){if(birth.failure)throw birth.failure.raw;return birth.value;}
 const row={};birth=row;
 try{
  if(!existsSync(fixed)){row.value=null;return null;}
  row.raw=load(fileURLToPath(fixed));
  if(!row.raw||typeof row.raw!=='object'||types.isProxy(row.raw)||!Object.isFrozen(row.raw))throw Error('broker_source_runtime_invalid');
  const names=['createRoomTurnCustody','retainSourceErrorTails','assertOrdinarySourceWriterRoute','observeOrdinarySQLiteWriter'];
  const actual=Reflect.ownKeys(row.raw);if(actual.length!==names.length)throw Error('broker_source_runtime_invalid');
  for(const name of names){const d=Object.getOwnPropertyDescriptor(row.raw,name);if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function'||types.isProxy(d.value)||!Object.isFrozen(d.value))throw Error('broker_source_runtime_invalid');}
  row.value=row.raw;return row.value;
 }catch(raw){row.failure={raw};throw raw;}
}
