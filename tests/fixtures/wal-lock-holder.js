// Synthetic test child. Never accepts a general SQL statement or a production path.
import {DatabaseSync} from 'node:sqlite';
import {existsSync,realpathSync} from 'node:fs';
import {resolve,dirname,basename,join} from 'node:path';
const c=JSON.parse(process.argv[2]);
if(!process.send||!c||realpathSync(c.root)!==resolve(c.root)||!basename(c.root).startsWith('intent-broker-wal-lock-')||resolve(c.dbPath)!==join(c.root,'broker.db')||!['none','revision','revokeMember','advanceEpoch','settleDelivery','archiveRoom'].includes(c.mutation)||!['manual','attempt-file'].includes(c.release))throw Error('synthetic_lock_holder_config');
if(c.release==='attempt-file'&&resolve(c.attemptFile)!==join(c.root,'attempt'))throw Error('synthetic_attempt_path');
const db=new DatabaseSync(c.dbPath);db.function('solpi_disclosure_write_guard_v1',()=>0);
let poll,deadline,closed=false;
function stop(commit){
 if(closed)return;
 if(db.isTransaction)db.exec(commit?'COMMIT':'ROLLBACK');
 db.close();closed=true;clearInterval(poll);clearTimeout(deadline);
 process.send({kind:commit?'committed':'rolled-back'},()=>process.disconnect());
}
process.on('message',m=>{if(m?.kind==='stop')stop(false);else if(m?.kind==='release')stop(true);});
process.once('disconnect',()=>{if(!closed){if(db.isTransaction)db.exec('ROLLBACK');db.close();}});
deadline=setTimeout(()=>{try{stop(false);}finally{process.exitCode=1;}},15000);
db.exec('BEGIN IMMEDIATE');
if(c.mutation==='revision')db.prepare('UPDATE rooms SET revision=2 WHERE room_id=?').run(c.roomId);
if(c.mutation==='revokeMember')db.prepare("UPDATE room_members SET status='removed',membership_revision=membership_revision+1 WHERE room_id=? AND subject_kind='agent' AND subject_id='a'").run(c.roomId);
if(c.mutation==='advanceEpoch')db.prepare('UPDATE rooms SET discussion_epoch=discussion_epoch+1 WHERE room_id=?').run(c.roomId);
if(c.mutation==='archiveRoom')db.prepare("UPDATE rooms SET status='archived' WHERE room_id=?").run(c.roomId);
if(c.mutation==='settleDelivery')db.prepare("UPDATE room_message_deliveries SET wake_status='completed' WHERE room_message_id=? AND recipient_key='agent:a'").run(c.roomMessageId);
process.send({kind:'locked'});
if(c.release==='attempt-file')poll=setInterval(()=>{if(existsSync(c.attemptFile)){clearInterval(poll);poll=undefined;setTimeout(()=>stop(true),5);}},1);
