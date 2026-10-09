import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
const instanceId = randomUUID();
let identity;
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
  return identity = { pid: process.pid, instanceId, entryPath, entryHash, sourceHash: hash.digest('hex') };
}
