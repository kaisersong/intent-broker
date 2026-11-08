import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBrokerStorageCommand } from '../../src/runtime/broker-storage-command.js';
test('storage command requires explicit db and mode, rejects duplicate/unknown/env-like options',()=>{
 assert.deepEqual(parseBrokerStorageCommand(['migrate','--db','/explicit.db','--mode','wal-full-v1']),{action:'migrate',dbPath:'/explicit.db',targetMode:'wal-full-v1'});
 assert.deepEqual(parseBrokerStorageCommand(['recover','--db','/explicit.db']),{action:'recover',dbPath:'/explicit.db'});
 for(const args of [[],['migrate','--mode','wal-full-v1'],['migrate','--db','x','--mode','persist'],['recover','--db','x','--mode','delete'],['migrate','--db','x','--db','y','--mode','delete'],['migrate','--db','x','--mode','delete','--unsafe','1']])assert.throws(()=>parseBrokerStorageCommand(args),/storage_arguments/);
});
test('a storage environment variable grants no configuration mode',async()=>{
 const {loadIntentBrokerConfig}=await import('../../src/config/load-config.js');
 const config=loadIntentBrokerConfig({env:{INTENT_BROKER_STORAGE_MODE:'wal-full-v1'},configPath:'missing-storage-config.json',localConfigPath:'missing-storage-local.json'});
 assert.equal(config.server.storageMode,undefined);
});
