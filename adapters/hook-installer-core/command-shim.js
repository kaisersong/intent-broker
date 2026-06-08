import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultCommandShimPath({ homeDir = os.homedir(), commandName = 'intent-broker', platform = process.platform } = {}) {
  const fileName = platform === 'win32' && !commandName.toLowerCase().endsWith('.cmd')
    ? `${commandName}.cmd`
    : commandName;
  return path.join(homeDir, '.local', 'bin', fileName);
}

function isPackagedMacAppExecutable(nodePath, platform) {
  return platform === 'darwin' && typeof nodePath === 'string' && nodePath.includes('.app/Contents/MacOS/');
}

export function resolveCommandShimNodePath({
  nodePath = process.execPath,
  platform = process.platform,
  env = process.env,
  exists = existsSync
} = {}) {
  const override = env.INTENT_BROKER_NODE_PATH;
  if (override) {
    return override;
  }

  if (!isPackagedMacAppExecutable(nodePath, platform)) {
    return nodePath;
  }

  const inheritedNodePath = env.npm_node_execpath || env.NODE;
  if (inheritedNodePath) {
    return inheritedNodePath;
  }

  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (exists(candidate)) {
      return candidate;
    }
  }

  return nodePath;
}

export function buildCommandShimContent({
  cliPath,
  nodePath = process.execPath,
  platform = process.platform,
  env = process.env,
  exists = existsSync
} = {}) {
  const resolvedNodePath = resolveCommandShimNodePath({ nodePath, platform, env, exists });

  if (platform === 'win32') {
    return `@echo off\r\n"${resolvedNodePath}" "${cliPath}" %*\r\n`;
  }

  return `#!/bin/sh\nexec "${resolvedNodePath}" "${cliPath}" "$@"\n`;
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
