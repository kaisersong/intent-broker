import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
const instanceId = randomUUID();
let identity;
function executableHash() {
  const fd=openSync(process.execPath,'r'),buffer=Buffer.allocUnsafe(1048576),hash=createHash('sha256');
  try{let n;while((n=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));return hash.digest('hex');}
  finally{closeSync(fd);}
}
export function activityServiceIdentity() {
  if (identity) return identity;
  const entryPath = resolve(process.argv[1]);
  const entryHash = createHash('sha256').update(readFileSync(entryPath)).digest('hex');
  const sourceRoot = dirname(dirname(entryPath)), hash = createHash('sha256');
  const visit = dir => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const path = join(dir,item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && /\.(js|json)$/.test(item.name)) { hash.update(relative(sourceRoot,path)); hash.update('\0'); hash.update(readFileSync(path)); hash.update('\0'); }
    }
  };
  visit(sourceRoot);
  return identity = { pid: process.pid, instanceId, entryPath, entryHash, sourceHash: hash.digest('hex'), runtime: {node:process.versions.node,sqlite:process.versions.sqlite,execPath:process.execPath,executableSha256:executableHash()} };
}
