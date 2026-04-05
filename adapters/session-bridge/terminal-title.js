import { openSync, writeSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
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

/**
 * Schedule title update after CC/Codex UI overwrites it.
 * Uses a detached child process to survive hook exit.
 */
export function scheduleAliasTitle(alias, { cwd = process.cwd(), delayMs = 1000 } = {}) {
  if (!alias) {
    return;
  }

  const project = path.basename(cwd);
  const title = project ? `${project} · @${alias}` : `@${alias}`;

  // Spawn detached process that waits then writes to /dev/tty
  const script = `
    const { openSync, writeSync, closeSync } = require('fs');
    setTimeout(() => {
      try {
        const fd = openSync('/dev/tty', 'w');
        writeSync(fd, '\\x1b]2;${title}\\x07');
        closeSync(fd);
      } catch {}
    }, ${delayMs});
  `;

  try {
    spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  } catch {
    // spawn failed — silently skip
  }
}
