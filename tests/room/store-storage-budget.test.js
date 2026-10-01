import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRoomStore,getDefaultMigrations} from '../../src/room/store.js';
const cap=1024*1024;
function fixture(t){const root=mkdtempSync(join(tmpdir(),'room-cap-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return join(root,'rooms.sqlite');}
function scalar(db,pragma){return Object.values(db.prepare('PRAGMA '+pragma).get())[0];}
function assertCap(store,path){const size=scalar(store.db,'page_size'),maximum=scalar(store.db,'max_page_count');assert.equal(maximum,Math.floor(cap/size));assert.ok(scalar(store.db,'page_count')*size<=cap);assert.ok(statSync(path).size<=cap);assert.equal(scalar(store.db,'journal_mode'),'delete');assert.equal(scalar(store.db,'synchronous'),2);assert.equal(scalar(store.db,'temp_store'),2);}
test('applies the physical cap on every real open and preserves a failed transaction across reopen',t=>{
 const path=fixture(t);let store=createRoomStore({dbPath:path,storageBudget:{databaseBytes:cap}});t.after(()=>store.close());store.migrate();assertCap(store,path);
 store.withTransaction(()=>store.nextRoomSequence('room'));const previous=store.db.prepare('SELECT * FROM room_sequences').all();
 assert.throws(()=>store.withTransaction(()=>{store.nextRoomSequence('room');store.db.prepare("INSERT INTO room_workspace_records VALUES('capacity','overflow','room',?)").run('x'.repeat(2*cap));}),/full/i);
 assert.equal(store.db.isTransaction,false);assert.deepEqual(store.db.prepare('SELECT * FROM room_sequences').all(),previous);assert.equal(store.db.prepare("SELECT COUNT(*) n FROM room_workspace_records WHERE record_key='overflow'").get().n,0);assertCap(store,path);
 store.close();store=createRoomStore({dbPath:path,storageBudget:{databaseBytes:cap}});assertCap(store,path);assert.deepEqual(store.db.prepare('SELECT * FROM room_sequences').all(),previous);
});
test('two actual store connections each enforce their cap for direct SQL writers',t=>{
 const path=fixture(t),a=createRoomStore({dbPath:path,storageBudget:{databaseBytes:cap}});t.after(()=>a.close());a.migrate();const b=createRoomStore({dbPath:path,storageBudget:{databaseBytes:cap}});t.after(()=>b.close());assertCap(a,path);assertCap(b,path);let written=0,full;
 for(let i=0;i<100;i++){try{(i%2?a:b).db.prepare("INSERT INTO room_workspace_records VALUES('capacity',?,'room',?)").run(String(i),'x'.repeat(65536));written++;}catch(error){full=error;break;}}
 assert.ok(written>0);assert.match(String(full),/full/i);assert.equal(a.db.prepare("SELECT COUNT(*) n FROM room_workspace_records WHERE kind='capacity'").get().n,written);assertCap(a,path);assertCap(b,path);
});
test('a full migration rolls back its actual step table and schema version',t=>{
 const path=fixture(t),steps=getDefaultMigrations(),version=Math.max(...steps.map(s=>s.version))+1;
 const store=createRoomStore({dbPath:path,storageBudget:{databaseBytes:cap},migrations:[...steps,{version,up(db){db.exec('CREATE TABLE capacity_migration(value BLOB)');db.prepare('INSERT INTO capacity_migration VALUES(?)').run(Buffer.alloc(2*cap));}}]});t.after(()=>store.close());
 assert.throws(()=>store.migrate(),/full/i);assert.equal(store.db.isTransaction,false);assert.equal(store.getSchemaVersion(),version-1);assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='capacity_migration'").get(),undefined);assertCap(store,path);
});
test('opening an existing larger database reports capacity without changing its rows',t=>{
 const path=fixture(t);let store=createRoomStore({dbPath:path});store.migrate();store.db.prepare("INSERT INTO room_workspace_records VALUES('capacity','retained','room',?)").run('x'.repeat(2*cap));store.close();
 assert.throws(()=>createRoomStore({dbPath:path,storageBudget:{databaseBytes:cap}}),/room_storage_capacity/);
 store=createRoomStore({dbPath:path});try{assert.equal(store.db.prepare("SELECT length(value_json) n FROM room_workspace_records WHERE record_key='retained'").get().n,2*cap);}finally{store.close();}
});
