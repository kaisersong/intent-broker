import { openSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';

export function appendAliasToTerminalTitle(alias, { cwd = process.cwd() } = {}) {
  if (!alias) {
    return;
  }

  const project = path.basename(cwd);
  const suffix = ` · @${alias}`;
  const title = project ? `${project}${suffix}` : `@${alias}`;

  try {
    const fd = openSync('/dev/tty', 'w');
    writeSync(fd, `\x1b]2;${title}\x07`);
    closeSync(fd);
  } catch {
    // no tty available (CI, piped, sandbox) — silently skip
  }
}
