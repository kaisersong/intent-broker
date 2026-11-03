import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRoomStore } from '../../src/room/store.js';
import { createBrokerService } from '../../src/broker/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

test('broker defers due cleanup to existing housekeeping instead of writing its marker at startup',t=>{
  const path=createTempDbPath(),store=createRoomStore({dbPath:path});store.migrate();store.close();
  const original=DatabaseSync.prototype.prepare,connections=new Set();
  DatabaseSync.prototype.prepare=function(...args){connections.add(this);return original.apply(this,args);};
  let broker;
  try{broker=createBrokerService({dbPath:path,presenceSweepIntervalMs:0});}
  finally{DatabaseSync.prototype.prepare=original;}
  const check=new DatabaseSync(path,{readOnly:true});
  t.after(()=>{check.close();broker.close();for(const db of connections)if(db.isOpen)db.close();});
  const marker=()=>check.prepare("SELECT value FROM room_history_read_audit_meta WHERE key='last_cleanup_at'").get();
  assert.equal(marker(),undefined);
  broker.sweepPresence();const first=marker().value;assert.ok(Number(first)>0);
  broker.sweepPresence();assert.equal(marker().value,first);
});
