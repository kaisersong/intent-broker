import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {transitionBrokerStorage,recoverBrokerStorage} from '../../src/store/sqlite-profile-migration.js';
import {isSupportedWalRuntime} from '../../src/store/sqlite-profile.js';
test('the real migration module imports on the ordinary Node floor without requiring optional backup exports',()=>{
 assert.equal(typeof transitionBrokerStorage,'function');assert.equal(typeof recoverBrokerStorage,'function');
});
test('an unqualified WAL runtime is still refused before the original migration enters any database or sidecar', {skip:isSupportedWalRuntime()},async t=>{
 const root=mkdtempSync(join(tmpdir(),'broker-storage-runtime-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 await assert.rejects(transitionBrokerStorage({dbPath:join(root,'not-born.sqlite'),targetMode:'wal-full-v1'}),/broker_storage_runtime/);
 assert.deepEqual(readdirSync(root),[]);
});
