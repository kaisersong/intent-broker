import test from 'node:test';
import { runManagedCase } from '../fixtures/managed-sqlite-case.js';
const onlyDarwin = { skip: process.platform !== 'darwin' };
const opened = `const event=createEventStore({dbPath:path});const room=createRoomStore({dbPath:path});room.migrate();const state=globalThis.__managedFixture;`;
const intent = `{intentId:'one',kind:'report_progress',fromParticipantId:'a',payload:{message:'original'},recipients:['b']}`;
test('fixed managed resource is one actual scheduling connection behind original Event and Room APIs', onlyDarwin, () => runManagedCase(opened + `
 assert.ok(state,'original fixed managed resource must be consumed');assert.equal(state.constructors,1);assert.equal(existsSync(path),false);
 event.appendIntent(${intent});assert.equal(event.readInbox('b').items.length,1);assert.equal(room.getSchemaVersion(),9);
 room.close();assert.equal(state.databaseCloses,0);assert.equal(readBrokerDatabaseFate(room).closed,false);assert.equal(readBrokerDatabaseFate(room).physicalKnown,false);
 assert.throws(()=>room.getSchemaVersion(),/retired|closed/);assert.equal(event.listEvents().length,1);event.close();assert.equal(state.databaseCloses,1);assert.equal(state.namespaceCloses,1);assert.equal(state.finishes,1);
 assert.equal(readBrokerDatabaseFate(room).physicalKnown,true);assert.equal(readBrokerDatabaseFate(event).physicalKnown,true);`));
test('old Room db, statements and iterator next seal per lease while original cursor return remains negative', onlyDarwin, () => runManagedCase(opened + `
 const old=room.db,statement=old.prepare('SELECT 1 AS number'),cursor=statement.iterate();assert.equal(cursor.next().value.number,1);
 room.close();assert.throws(()=>old.exec('SELECT 1'),/retired|closed/);assert.throws(()=>old.prepare('SELECT 1'),/retired|closed/);assert.throws(()=>statement.get(),/retired|closed/);assert.throws(()=>cursor.next(),/retired|closed/);
 assert.doesNotThrow(()=>cursor.return());event.appendIntent(${intent});assert.equal(event.listEvents().length,1);event.close();`));
test('closing Room inside its original transaction prevents commit and permits private rollback without reviving public SQL', onlyDarwin, () => runManagedCase(opened + `
 let invoked=false;assert.throws(()=>room.withTransaction(()=>{room.db.exec('CREATE TABLE should_rollback(value)');room.db.prepare('INSERT INTO should_rollback VALUES(1)').run();room.close();invoked=true;assert.throws(()=>room.db.exec('ROLLBACK'),/retired|closed/);}),/retired|closed/);
 assert.equal(invoked,true);assert.equal(state.databaseCloses,0);assert.equal(state.databases[0].db.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'").get(),undefined);event.appendIntent(${intent});assert.equal(event.listEvents().length,1);event.close();`));
test('different original lease cannot enter the same actual Room transaction or manual raw transaction', onlyDarwin, () => runManagedCase(opened + `
 room.withTransaction(()=>{assert.throws(()=>event.listEvents(),/busy|transaction_owner/);});assert.equal(event.listEvents().length,0);
 room.db.exec('BEGIN');try{assert.throws(()=>event.listEvents(),/busy|transaction_owner/);}finally{room.db.exec('ROLLBACK');}
 assert.equal(event.listEvents().length,0);room.close();event.close();`));
test('a single originally born Event lease still physically closes the original namespace without inventing Room', onlyDarwin, () => runManagedCase(`
 const event=createEventStore({dbPath:path});const state=globalThis.__managedFixture;assert.ok(state);assert.equal(state.constructors,1);event.close();assert.equal(state.databaseCloses,1);assert.equal(state.namespaceCloses,1);assert.equal(state.finishes,1);assert.equal(readBrokerDatabaseFate(event).physicalKnown,true);`));
test('negative close bare undefined remains present and sticky while namespace and finish are all attempted', onlyDarwin, () => runManagedCase(opened + `
 room.close();state.faults.close={phase:'before',raw:undefined};let caught;try{event.close();}catch(raw){caught={raw};}assert.ok(caught);assert.equal(caught.raw,undefined);assert.equal(state.databaseCloses,1);assert.equal(state.namespaceCloses,1);assert.equal(state.finishes,1);
 assert.equal(readBrokerDatabaseFate(event).physicalKnown,false);assert.equal(readBrokerDatabaseFate(room).physicalKnown,false);let again;try{event.close();}catch(raw){again={raw};}assert.ok(again);assert.equal(again.raw,undefined);assert.equal(state.databaseCloses,1);`));
test('one unknown negative accessor cannot hide an original known Promise tail from physical-close wait', onlyDarwin, () => runManagedCase(opened + `
 room.close();let release;const held=new Promise(yes=>{release=yes;});const original=new Error('original-negative');let getters=0;Object.defineProperty(original,Symbol('unknown'),{get(){getters++;throw 0;}});Object.defineProperty(original,Symbol('known-held'),{value:held});state.faults.close={phase:'after',raw:original};
 assert.throws(()=>event.close(),raw=>raw===original);let settled=false;const joined=waitBrokerDatabaseCloseKnown(event).then(()=>{settled=true;return null;},raw=>{settled=true;return raw;});await new Promise(yes=>setImmediate(yes));assert.equal(settled,false);assert.equal(getters,0);assert.equal(state.finishes,1);release();assert.ok(await joined);assert.equal(readBrokerDatabaseFate(event).physicalKnown,false);assert.equal(getters,0);`));
test('Room physical cap applies to the shared actual Event writer and still permits transaction cleanup', onlyDarwin, () => runManagedCase(`
 const event=createEventStore({dbPath:path});const room=createRoomStore({dbPath:path,storageBudget:{databaseBytes:1048576}});room.migrate();const state=globalThis.__managedFixture;assert.ok(state);
 assert.equal(Object.values(room.db.prepare('PRAGMA journal_mode').get())[0],'delete');assert.equal(Object.values(room.db.prepare('PRAGMA synchronous').get())[0],2);
 assert.throws(()=>event.appendIntent({...${intent},payload:{large:'x'.repeat(2097152)}}),/full/i);assert.equal(event.listEvents().length,0);room.close();event.close();assert.equal(state.constructors,1);`));
test('raw DB UDF close reentry inventories the same retired error and its newly visible tails', onlyDarwin, () => runManagedCase(opened + `
 let release,retired,getters=0;const held=new Promise(yes=>{release=yes;});
 room.db.function('retire_same_lease',()=>{room.close();try{room.db.exec('SELECT 1');}catch(raw){retired=raw;Object.defineProperty(raw,Symbol('unknown'),{get(){getters++;throw 0;}});Object.defineProperty(raw,Symbol('known-held'),{value:held});}return 1;});
 const statement=room.db.prepare('SELECT retire_same_lease()');assert.throws(()=>statement.get(),raw=>raw===retired);
 let close;try{event.close();}catch(raw){close={raw};}assert.ok(close);assert.equal(readBrokerDatabaseFate(room).physicalKnown,false);
 let settled=false;const waited=waitBrokerDatabaseCloseKnown(room).then(()=>{settled=true;return null;},raw=>{settled=true;return raw;});await new Promise(yes=>setImmediate(yes));assert.equal(settled,false);assert.equal(getters,0);release();assert.ok(await waited);assert.equal(readBrokerDatabaseFate(room).physicalKnown,false);assert.equal(getters,0);
`));

test('an explicit WAL profile is refused before a managed lease or Native constructor is born', onlyDarwin, () => runManagedCase(`
 assert.throws(()=>createEventStore({dbPath:path,storageMode:'wal-full-v1'}),/broker_storage_mode/);
 const state=globalThis.__managedFixture;assert.equal(state.constructors,0);
 const event=createEventStore({dbPath:path});assert.equal(state.constructors,1);event.close();assert.equal(state.databaseCloses,1);assert.equal(state.namespaceCloses,1);
`));
