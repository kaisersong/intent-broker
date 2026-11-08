import { transitionBrokerStorage, recoverBrokerStorage } from '../store/sqlite-profile-migration.js';
export function parseBrokerStorageCommand(args) {
  const [action,...options]=args;
  if(!['migrate','recover'].includes(action)||options.length%2!==0)throw Error('broker_storage_arguments');
  const values=new Map();
  for(let n=0;n<options.length;n+=2) {
    const key=options[n],value=options[n+1];
    if(!['--db','--mode'].includes(key)||values.has(key)||!value||value.startsWith('--'))throw Error('broker_storage_arguments');
    values.set(key,value);
  }
  const dbPath=values.get('--db'),targetMode=values.get('--mode');
  if(!dbPath||(action==='migrate'&&!['delete','wal-full-v1'].includes(targetMode))||(action==='recover'&&targetMode!==undefined))throw Error('broker_storage_arguments');
  return {action,dbPath,...(action==='migrate'?{targetMode}:{})};
}
export async function runBrokerStorageCommand(args) {
  const input=parseBrokerStorageCommand(args);
  const result=input.action==='migrate'?await transitionBrokerStorage(input):await recoverBrokerStorage(input);
  return {schema:'broker-storage-command/v1',mode:result.mode,phase:result.phase,backupSha256:result.backupSha256??null};
}
