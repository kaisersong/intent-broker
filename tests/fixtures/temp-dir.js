import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'intent-broker-'));
  return join(dir, `${randomUUID()}.db`);
}
