import { openSync, writeSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Try to set terminal title via HexDeck CLI.
 * Returns true if successful, false if HexDeck not available.
 */
function tryHexDeckTitle(alias, project) {
  try {
    const result = spawn('hexdeck', ['title', 'append', '--alias', `@${alias}`, '--project', project], {
      stdio: 'ignore',
      timeout: 2000
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write terminal title directly to /dev/tty via OSC sequence.
 * May fail in sandboxed environments (ENXIO).
 */
function writeTtyTitle(title) {
  try {
    const fd = openSync('/dev/tty', 'w');
    writeSync(fd, `\x1b]2;${title}\x07`);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function appendAliasToTerminalTitle(alias, { cwd = process.cwd() } = {}) {
  if (!alias) {
    return;
  }

  const project = path.basename(cwd);
  const title = project ? `${project} · @${alias}` : `@${alias}`;

  // Try HexDeck first (works in sandboxed environments)
  if (tryHexDeckTitle(alias, project)) {
    return;
  }

  // Fallback to direct /dev/tty write (fails in sandbox)
  writeTtyTitle(title);
}

/**
 * Schedule title update after CC/Codex UI overwrites it.
 * Uses a detached child process to survive hook exit.
 * Prefers HexDeck CLI when available, falls back to /dev/tty.
 */
export function scheduleAliasTitle(alias, { cwd = process.cwd(), delayMs = 1000 } = {}) {
  if (!alias) {
    return;
  }

  const project = path.basename(cwd);
  const aliasArg = `@${alias}`;

  // Spawn detached process that waits then tries HexDeck or /dev/tty
  const script = `
    const { spawn } = require('child_process');
    const { openSync, writeSync, closeSync } = require('fs');
    const path = require('path');

    setTimeout(() => {
      const project = '${project}';
      const alias = '${aliasArg}';
      const title = project ? project + ' · ' + alias : alias;

      // Try HexDeck first
      try {
        spawn('hexdeck', ['title', 'append', '--alias', alias, '--project', project], {
          stdio: 'ignore',
          timeout: 2000
        });
        return;
      } catch {}

      // Fallback to /dev/tty
      try {
        const fd = openSync('/dev/tty', 'w');
        writeSync(fd, '\\x1b]2;' + title + '\\x07');
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