// Test process only. Install before every product import; never mutate HOME.
import os from 'node:os';
import {mkdirSync,mkdtempSync,realpathSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const original=os.userInfo,identity=original(),environmentHome=process.env.HOME;
const root=realpathSync(mkdtempSync(join(os.tmpdir(),'broker-source-test-'))),home=join(root,'account'),config=join(root,'config');
mkdirSync(home,{mode:0o700});mkdirSync(config,{mode:0o700});process.env.XIAOK_CONFIG_DIR=config;
os.homedir=()=>home;os.userInfo=options=>{const info=original(options);return {...info,homedir:Buffer.isBuffer(info.homedir)?Buffer.from(home):home};};syncBuiltinESMExports();
writeSync(1,JSON.stringify({kind:'broker-source-test-birth',pid:process.pid,root,config,uid:identity.uid})+'\n');
process.on('exit',()=>{const current=original();writeSync(1,JSON.stringify({kind:'broker-source-test-exit',pid:process.pid,uidPreserved:current.uid===identity.uid,gidPreserved:current.gid===identity.gid,homeEnvironmentUnchanged:process.env.HOME===environmentHome})+'\n');});
