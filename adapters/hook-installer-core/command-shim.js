import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultCommandShimPath({ homeDir = os.homedir(), commandName = 'intent-broker' } = {}) {
  return path.join(homeDir, '.local', 'bin', commandName);
}

export function buildCommandShimContent({ cliPath, nodePath = process.execPath } = {}) {
  return `#!/bin/sh\nexec "${nodePath}" "${cliPath}" "$@"\n`;
}

export function ensureCommandShim(commandShimPath, content) {
  mkdirSync(path.dirname(commandShimPath), { recursive: true });
  writeFileSync(commandShimPath, content);
  chmodSync(commandShimPath, 0o755);
}

export function isPathDirAvailable(commandShimPath, envPath = process.env.PATH || '') {
  const commandDir = path.dirname(commandShimPath);
  return envPath.split(path.delimiter).includes(commandDir);
}
