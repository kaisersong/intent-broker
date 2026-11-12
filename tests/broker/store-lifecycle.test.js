import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEventStore} from '../../src/store/event-store.js';
import {createBrokerService} from '../../src/broker/service.js';

const append=store=>store.appendIntent({intentId:'synthetic-one',kind:'progress_update',fromParticipantId:'synthetic-owner',taskId:'task-synthetic',threadId:'thread-synthetic',payload:{body:{summary:'persisted synthetic result'}},recipients:['synthetic-reader']});
test('event store close is idempotent, releases its real connection and preserves durable facts on reopen',()=>{
 const root=mkdtempSync(join(tmpdir(),'broker-store-lifecycle-')),dbPath=join(root,'broker.sqlite');let store=createEventStore({dbPath});
 try{append(store);store.close();store.close();assert.throws(()=>store.readInbox('synthetic-reader'),/not open|closed/i);store=createEventStore({dbPath});assert.equal(store.readInbox('synthetic-reader').items[0].payload.body.summary,'persisted synthetic result');store.close();rmSync(dbPath);}
 finally{store.close();rmSync(root,{recursive:true,force:true});}
});
for(const aimpEnabled of [false,true])test(`broker close releases its original event store with AIMP ${aimpEnabled?'enabled':'disabled'}, without closing another broker`,()=>{
 const root=mkdtempSync(join(tmpdir(),'broker-close-lifecycle-')),firstPath=join(root,'first.sqlite'),secondPath=join(root,'second.sqlite'),first=createBrokerService({dbPath:firstPath,aimpEnabled}),second=createBrokerService({dbPath:secondPath,aimpEnabled});
 try{first.close();first.close();assert.throws(()=>first.readInbox('synthetic-reader'),/not open|closed/i);assert.deepEqual(second.readInbox('synthetic-reader').items,[]);rmSync(firstPath);second.close();rmSync(secondPath);}
 finally{first.close();second.close();rmSync(root,{recursive:true,force:true});}
});
test('failure in one shutdown component does not hide or leak the remaining original stores',()=>{
 const root=mkdtempSync(join(tmpdir(),'broker-close-failure-')),dbPath=join(root,'broker.sqlite'),broker=createBrokerService({dbPath,aimpEnabled:true}),notifier=broker.getWebSocketNotifier(),close=notifier.close;
 try{notifier.close=()=>{throw Error('synthetic_websocket_close_failure');};assert.throws(()=>broker.close(),error=>error instanceof AggregateError&&error.errors.some(e=>e.message==='synthetic_websocket_close_failure'));assert.throws(()=>broker.readInbox('synthetic-reader'),/not open|closed/i);broker.close();close.call(notifier);rmSync(dbPath);}
 finally{close.call(notifier);broker.close();rmSync(root,{recursive:true,force:true});}
});
