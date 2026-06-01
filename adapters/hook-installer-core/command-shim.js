import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultCommandShimPath({ homeDir = os.homedir(), commandName = 'intent-broker', platform = process.platform } = {}) {
  const fileName = platform === 'win32' && !commandName.toLowerCase().endsWith('.cmd')
    ? `${commandName}.cmd`
    : commandName;
  return path.join(homeDir, '.local', 'bin', fileName);
}

export function buildCommandShimContent({ cliPath, nodePath = process.execPath, platform = process.platform } = {}) {
  if (platform === 'win32') {
    return `@echo off\r\n"${nodePath}" "${cliPath}" %*\r\n`;
  }

  return `#!/bin/sh\nexec "${nodePath}" "${cliPath}" "$@"\n`;
}

function isLegacyPosixShim(filePath) {
  try {
    return existsSync(filePath) && readFileSync(filePath, 'utf8').startsWith('#!/bin/sh\nexec ');
  } catch {
    return false;
  }
}

function removeLegacyWindowsShim(commandShimPath, platform) {
  if (platform !== 'win32' || path.extname(commandShimPath).toLowerCase() !== '.cmd') {
    return;
  }

  const legacyPath = commandShimPath.slice(0, -'.cmd'.length);
  if (isLegacyPosixShim(legacyPath)) {
    unlinkSync(legacyPath);
  }
}

export function ensureCommandShim(commandShimPath, content, { platform = process.platform } = {}) {
  mkdirSync(path.dirname(commandShimPath), { recursive: true });
  writeFileSync(commandShimPath, content);
  if (platform !== 'win32') {
    chmodSync(commandShimPath, 0o755);
  }
  removeLegacyWindowsShim(commandShimPath, platform);
}

export function isPathDirAvailable(commandShimPath, envPath = process.env.PATH || '') {
  const commandDir = path.dirname(commandShimPath);
  return envPath.split(path.delimiter).includes(commandDir);
}
