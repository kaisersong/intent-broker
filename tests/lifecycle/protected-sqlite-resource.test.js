import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../../src/store/protected-sqlite-resource.js',import.meta.url));
function run(module,body,platform){
 const root=mkdtempSync(join(tmpdir(),'broker-protected-resource-'));
 try{
  mkdirSync(join(root,'src','store'),{recursive:true});mkdirSync(join(root,'runtime'));mkdirSync(join(root,'config'),{mode:0o700});
  writeFileSync(join(root,'package.json'),JSON.stringify({type:'module'}));
  writeFileSync(join(root,'src','store','protected-sqlite-resource.js'),readFileSync(source));
  if(module!==undefined)writeFileSync(join(root,'runtime','original-authority-sqlite.cjs'),module);
  const child=spawnSync(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict';import fs from 'node:fs';"+(platform?`Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});`: '')+"const {readBrokerProtectedSQLiteResource:read}=await import('./src/store/protected-sqlite-resource.js');"+body],{cwd:root,env:{...process.env,XIAOK_CONFIG_DIR:join(root,'config')},encoding:'utf8',timeout:5000});
  assert.equal(child.error,undefined);assert.equal(child.signal,null);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
 }finally{rmSync(root,{recursive:true,force:true});}
}
const valid="const f=Object.freeze(function(){});module.exports=Object.freeze({namespace:null,bindNamespace:f,finish:f});";
test('rejects arguments before the fixed resource can execute',()=>run("throw Error('MUST_NOT_LOAD')", "assert.throws(()=>read({}),/broker_protected_resource_arguments/);"));
test('unsupported platform returns null before importing a present hostile resource',()=>run("throw Error('MUST_NOT_LOAD')", "assert.equal(read(),null);assert.equal(read(),null);",'win32'));
test('missing fixed resource is a sticky ordinary result',()=>run(undefined,"assert.equal(read(),null);fs.writeFileSync('./runtime/original-authority-sqlite.cjs',`throw Error('LATE_RESOURCE')`);assert.equal(read(),null);"));
test('retains null namespace and exact fixed module identity without consuming Native birth',{skip:process.platform!=='darwin'},()=>run(valid,"const a=read();assert.equal(a.namespace,null);assert.equal(read(),a);fs.writeFileSync('./runtime/original-authority-sqlite.cjs',`throw Error('LATE_RESOURCE')`);assert.equal(read(),a);"));
test('bare undefined import failure remains a sticky failure',{skip:process.platform!=='darwin'},()=>run('throw undefined;',"for(let i=0;i<2;i++){let caught=false;try{read();}catch(raw){caught=true;assert.equal(raw,undefined);}assert.equal(caught,true);fs.writeFileSync('./runtime/original-authority-sqlite.cjs',`module.exports={};`);}"));
test('module Proxy is rejected without accessing any properties',{skip:process.platform!=='darwin'},()=>run("globalThis.hits=0;module.exports=new Proxy({},{ownKeys(){globalThis.hits++;throw 0;},get(){globalThis.hits++;throw 0;}});","assert.throws(()=>read(),/broker_protected_resource_invalid/);assert.equal(globalThis.hits,0);"));
test('resource accessors and extra fields cannot become fixed exports',{skip:process.platform!=='darwin'},()=>{for(const module of ["const f=Object.freeze(function(){});module.exports=Object.freeze({get namespace(){throw 0;},bindNamespace:f,finish:f});","const f=Object.freeze(function(){});module.exports=Object.freeze({namespace:null,bindNamespace:f,finish:f,extra:true});"])run(module,"assert.throws(()=>read(),/broker_protected_resource_invalid/);");});
test('mutable functions and Proxy namespace are rejected',{skip:process.platform!=='darwin'},()=>{for(const module of ["module.exports=Object.freeze({namespace:null,bindNamespace(){},finish(){}});","const f=Object.freeze(function(){});module.exports=Object.freeze({namespace:new Proxy({},{ownKeys(){throw 0;}}),bindNamespace:f,finish:f});"])run(module,"assert.throws(()=>read(),/broker_protected_resource_invalid/);");});
test('reentrant fixed module birth is sticky even when the resource swallows the first rejection',{skip:process.platform!=='darwin'},()=>run("try{globalThis.reenter();}catch{}"+valid,"globalThis.reenter=read;let first;assert.throws(()=>read(),raw=>{first=raw;return raw.message==='broker_protected_resource_birth_pending';});assert.throws(()=>read(),raw=>raw===first);"));
test('constructor misuse is rejected before birth and preserves the ordinary null result',()=>run(undefined,"assert.throws(()=>new read(),/broker_protected_resource_constructor/);assert.equal(read(),null);"));
