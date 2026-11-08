import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomStore } from '../../src/room/store.js';
import { transitionBrokerStorage } from '../../src/store/sqlite-profile-migration.js';
import { isSupportedWalRuntime } from '../../src/store/sqlite-profile.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

function fixture(t) {
  const store=createRoomStore({dbPath:createTempDbPath()});store.migrate();const originalOwnPrepare=Object.getOwnPropertyDescriptor(store.db,'prepare');t.after(()=>{if(originalOwnPrepare)Object.defineProperty(store.db,'prepare',originalOwnPrepare);else delete store.db.prepare;store.close();});
  const insert=store.db.prepare(`INSERT INTO room_messages (room_message_id,room_id,thread_id,sender_json,kind,text,context_scope_json,mentions_json,response_policy,idempotency_key,room_sequence,discussion_epoch,created_at) VALUES (?,?,'main','{"kind":"user","userId":"u"}','text',?,?,'[]','none',?,?,1,'2026-10-30T00:00:00Z')`);
  for(let n=1;n<=100;n++)insert.run('m'+n,'r','body'+n,JSON.stringify(n%10===0?{kind:'project',projectId:'p'}:{kind:'room_only'}),'i'+n,n);
  return store;
}

test('SQL scope filtering precedes limit; bounds cover entire matching scope',t=>{
  const s=fixture(t);
  const p=s.listScopedMessagesPage('r',{kind:'project',projectId:'p'},{afterSequence:10,beforeSequence:90,limit:2});
  assert.deepEqual(p.messages.map(m=>m.roomSequence),[20,30]);
  assert.deepEqual(p.bounds,{totalMessages:10,minSequence:10,maxSequence:100});
  assert.deepEqual(s.listScopedMessagesPage('r',{kind:'project',projectId:'p'},{afterSequence:100,limit:2}).messages,[]);
  assert.equal(s.listScopedMessagesPage('r',{kind:'project',projectId:'alien'},{limit:2}).bounds.totalMessages,0);
});

test('SQL scope predicate keeps JSON.parse last-key and null semantics',t=>{
  const s=fixture(t);
  s.db.prepare('UPDATE room_messages SET context_scope_json=? WHERE room_sequence=1').run('{"kind":"project","projectId":"alien","projectId":"p"}');
  s.db.prepare('UPDATE room_messages SET context_scope_json=? WHERE room_sequence=2').run('null');
  const source={kind:'project',projectId:'p'};
  assert.equal(s.listScopedMessagesPage('r',source,{limit:1}).messages[0].roomSequence,1);
  assert.equal(s.listScopedMessagesPage('r',{kind:'room_only'},{limit:1}).messages[0].roomSequence,2);
});

test('only returned bodies are decoded, page and bounds share a read snapshot',t=>{
  const s=fixture(t);
  // A malformed sender in an excluded row must never be materialized.
  s.db.prepare("UPDATE room_messages SET sender_json='bad JSON' WHERE room_sequence=99").run();
  const p=s.listScopedMessagesPage('r',{kind:'project',projectId:'p'},{limit:1});
  assert.equal(p.messages.length,1);
  assert.equal(p.bounds.totalMessages,10);
  assert.equal(s.db.isTransaction,false);
});

test('read transaction failure releases locks; caller transaction stays owned by caller',t=>{
  const s=fixture(t);
  s.db.prepare("UPDATE room_messages SET sender_json='bad JSON' WHERE room_sequence=10").run();
  assert.throws(()=>s.listScopedMessagesPage('r',{kind:'project',projectId:'p'},{limit:1}));
  assert.equal(s.db.isTransaction,false);
  s.withTransaction(()=>{
    assert.equal(s.listScopedMessagesPage('r',{kind:'room_only'},{limit:1}).messages.length,1);
    assert.equal(s.db.isTransaction,true);
  });
});

test('maintenance delete and marker roll back together without losing durable read audit',t=>{
  const s=fixture(t),now=Date.now();
  s.recordRoomHistoryReadAudit({roomId:'r',actorParticipantId:'a',resultCount:1,now:now-40*86400000});
  s.db.exec("CREATE TRIGGER block_marker BEFORE UPDATE ON room_history_read_audit_meta BEGIN SELECT RAISE(ABORT,'test marker failure'); END");
  s.recordRoomHistoryReadAudit({roomId:'r',actorParticipantId:'a',resultCount:2,now});
  assert.equal(s.listRoomHistoryReadAudits('r').length,2);
  assert.equal(s.db.isTransaction,false);
  s.db.exec('DROP TRIGGER block_marker');
  assert.equal(s.pruneStaleRoomHistoryReadAuditsIfDue(now).pruned,1);
  assert.equal(s.listRoomHistoryReadAudits('r').length,1);
});

test('WAL writer committing during scope scan cannot tear the statement snapshot',{skip:!isSupportedWalRuntime()&&'qualified WAL runtime required'},async t=>{
  const initial=fixture(t),file=initial.db.prepare('PRAGMA database_list').all().find(x=>x.name==='main').file;
  initial.close();await transitionBrokerStorage({dbPath:file,targetMode:'wal-full-v1'});
  const s=createRoomStore({dbPath:file,storageMode:'wal-full-v1'});t.after(()=>s.close());
  const writer=createRoomStore({dbPath:file,storageMode:'wal-full-v1'});t.after(()=>writer.close());
  let wrote=false;
  s.db.function('solpi_room_scope_matches_v1',(candidateJson,sourceJson)=>{
    if(!wrote){
      writer.db.prepare('UPDATE room_messages SET context_scope_json=? WHERE room_sequence=10').run('{"kind":"room_only"}');
      wrote=true;
    }
    const candidate=JSON.parse(candidateJson)??{kind:'room_only'};
    const source=JSON.parse(sourceJson)??{kind:'room_only'};
    return Number(candidate.kind===source.kind&&(candidate.kind!=='project'||candidate.projectId===source.projectId));
  });
  const page=s.listScopedMessagesPage('r',{kind:'project',projectId:'p'},{limit:1});
  assert.equal(wrote,true);
  assert.equal(page.bounds.totalMessages,10);
  assert.equal(page.messages[0].roomSequence,10);
  assert.equal(s.listScopedMessagesPage('r',{kind:'project',projectId:'p'},{limit:1}).messages[0].roomSequence,20);
});

test('cleanup savepoint failure does not roll back a caller-owned transaction',t=>{
  const s=fixture(t),now=Date.now();
  s.recordRoomHistoryReadAudit({roomId:'r',actorParticipantId:'a',resultCount:1,now:now-40*86400000});
  s.db.exec("CREATE TRIGGER block_marker BEFORE UPDATE ON room_history_read_audit_meta BEGIN SELECT RAISE(ABORT,'test marker failure'); END");
  s.withTransaction(()=>{
    s.recordRoomHistoryReadAudit({roomId:'r',actorParticipantId:'a',resultCount:2,now});
    assert.equal(s.db.isTransaction,true);
    assert.equal(s.listRoomHistoryReadAudits('r').length,2);
  });
  assert.equal(s.listRoomHistoryReadAudits('r').length,2);
});

test('SQL predicate matches the legacy JS predicate across JSON scope shapes',t=>{
  const s=fixture(t),values=[null,false,0,[],{},'project',{kind:'room_only'},{kind:'project'},{kind:'project',projectId:'p'},{kind:'project',projectId:3},{kind:'future'}];
  const update=s.db.prepare('UPDATE room_messages SET context_scope_json=? WHERE room_sequence=?');
  for(let n=1;n<=100;n++)update.run(JSON.stringify(values[(n-1)%values.length]),n);
  for(const scope of values){
    const source=scope??{kind:'room_only'};
    const expected=s.listMessages('r').filter(message=>{
      const candidate=message.contextScope??{kind:'room_only'};
      return candidate.kind===source.kind&&(candidate.kind!=='project'||candidate.projectId===source.projectId);
    });
    const actual=s.listScopedMessagesPage('r',scope,{afterSequence:2,beforeSequence:98,limit:5});
    assert.equal(actual.bounds.totalMessages,expected.length);
    assert.deepEqual(actual.messages.map(m=>m.messageId),expected.filter(m=>m.roomSequence>2&&m.roomSequence<98).slice(0,5).map(m=>m.messageId));
  }
  const plan=s.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM room_messages WHERE room_id=? AND solpi_room_scope_matches_v1(context_scope_json,?)=1 AND room_sequence>? ORDER BY room_sequence LIMIT ?').all('r','{"kind":"room_only"}',3,5);
  assert.ok(plan.some(row=>/SEARCH.*INDEX/.test(row.detail)),JSON.stringify(plan));
  assert.ok(!plan.some(row=>/TEMP B-TREE/.test(row.detail)),JSON.stringify(plan));
});

test('prepared bytecode reuse still reads current rows after mutations and schema changes',t=>{
  const s=fixture(t);let compiles=0;const prepare=s.db.prepare.bind(s.db);
  s.db.prepare=sql=>{if(sql==='SELECT * FROM room_messages WHERE room_message_id = ?')compiles++;return prepare(sql);};
  assert.equal(s.getMessageById('m10').text,'body10');
  s.db.prepare('UPDATE room_messages SET text=? WHERE room_message_id=?').run('changed','m10');
  assert.equal(s.getMessageById('m10').text,'changed');
  s.db.exec('ALTER TABLE room_messages ADD COLUMN cache_probe TEXT');
  assert.equal(s.getMessageById('m10').text,'changed');
  assert.equal(compiles,1);
});

test('statement cache is bounded and does not share statements with raw-db iterators',t=>{
  const s=fixture(t);let compiles=0;const prepare=s.db.prepare.bind(s.db);
  s.db.prepare=sql=>{if(sql==='SELECT 12345')compiles++;return prepare(sql);};
  assert.equal(s.prepareStatement('SELECT 12345').get()['12345'],12345);
  for(let n=0;n<129;n++)s.prepareStatement('SELECT '+n).get();
  s.prepareStatement('SELECT 12345').get();assert.equal(compiles,2);
  const iterator=s.db.prepare('SELECT * FROM room_messages WHERE room_message_id = ?').iterate('m10');
  assert.equal(iterator.next().value.text,'body10');
  assert.equal(s.getMessageById('m20').text,'body20');
  iterator.return();
});

test('canonical SQL fast path avoids JS callbacks and still falls back for duplicate JSON keys',t=>{
  const s=fixture(t);let fallbackCalls=0;
  s.db.function('solpi_room_scope_matches_v1',(candidateJson,sourceJson)=>{
    assert.notEqual(candidateJson,'{"kind":"room_only"}');
    assert.notEqual(candidateJson,'null');
    fallbackCalls++;
    const candidate=JSON.parse(candidateJson)??{kind:'room_only'},source=JSON.parse(sourceJson)??{kind:'room_only'};
    return Number(candidate.kind===source.kind&&(candidate.kind!=='project'||candidate.projectId===source.projectId));
  });
  s.db.prepare('UPDATE room_messages SET context_scope_json=? WHERE room_sequence=1').run('{"kind":"project","kind":"room_only"}');
  const page=s.listScopedMessagesPage('r',{kind:'room_only'},{limit:2});
  assert.equal(page.bounds.totalMessages,90);
  assert.deepEqual(page.messages.map(x=>x.roomSequence),[1,2]);
  assert.ok(fallbackCalls>0);
  page.messages[0].mentions.push({kind:'agent',logicalAgentId:'x'});
  page.messages[0].contextScope.kind='changed';
  assert.equal(page.messages[1].mentions.length,0);
  assert.equal(page.messages[1].contextScope.kind,'room_only');
});
