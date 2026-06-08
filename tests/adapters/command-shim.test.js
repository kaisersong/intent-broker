import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildCommandShimContent,
  defaultCommandShimPath,
  ensureCommandShim,
  isPathDirAvailable,
  resolveCommandShimNodePath
} from '../../adapters/hook-installer-core/command-shim.js';

test('defaultCommandShimPath uses ~/.local/bin/intent-broker on POSIX', () => {
  assert.equal(
    defaultCommandShimPath({ homeDir: '/Users/song', platform: 'linux' }),
    path.join('/Users/song', '.local', 'bin', 'intent-broker')
  );
  assert.equal(
    defaultCommandShimPath({ homeDir: '/Users/song', platform: 'darwin' }),
    path.join('/Users/song', '.local', 'bin', 'intent-broker')
  );
});

test('defaultCommandShimPath uses a .cmd shim on Windows', () => {
  assert.equal(
    defaultCommandShimPath({ homeDir: 'C:\\Users\\song', platform: 'win32' }),
    path.join('C:\\Users\\song', '.local', 'bin', 'intent-broker.cmd')
  );
});

test('buildCommandShimContent wraps unified cli with node on POSIX', () => {
  const content = buildCommandShimContent({
    cliPath: '/Users/song/projects/intent-broker/bin/intent-broker.js',
    nodePath: '/usr/local/bin/node',
    platform: 'darwin'
  });

  assert.match(content, /^#!\/bin\/sh/);
  assert.match(content, /exec "\/usr\/local\/bin\/node" "\/Users\/song\/projects\/intent-broker\/bin\/intent-broker\.js" "\$@"/);
});

test('buildCommandShimContent avoids packaged macOS Electron executable in POSIX shim', () => {
  const content = buildCommandShimContent({
    cliPath: '/Applications/xiaok.app/Contents/Resources/services/intent-broker/bin/intent-broker.js',
    nodePath: '/Applications/xiaok.app/Contents/MacOS/xiaok',
    platform: 'darwin',
    env: {},
    exists: candidate => candidate === '/usr/local/bin/node'
  });

  assert.match(content, /exec "\/usr\/local\/bin\/node" "\/Applications\/xiaok\.app\/Contents\/Resources\/services\/intent-broker\/bin\/intent-broker\.js" "\$@"/);
  assert.doesNotMatch(content, /Contents\/MacOS\/xiaok/);
});

test('resolveCommandShimNodePath preserves explicit overrides', () => {
  const nodePath = resolveCommandShimNodePath({
    nodePath: '/Applications/xiaok.app/Contents/MacOS/xiaok',
    platform: 'darwin',
    env: { INTENT_BROKER_NODE_PATH: '/custom/bin/node' },
    exists: () => false
  });

  assert.equal(nodePath, '/custom/bin/node');
});

test('buildCommandShimContent wraps unified cli with node on Windows', () => {
  const content = buildCommandShimContent({
    cliPath: 'D:\\projects\\intent-broker\\bin\\intent-broker.js',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    platform: 'win32'
  });

  assert.match(content, /^@echo off\r?\n/);
  assert.match(content, /"C:\\Program Files\\nodejs\\node\.exe" "D:\\projects\\intent-broker\\bin\\intent-broker\.js" %\*/);
});

test('ensureCommandShim writes executable POSIX shim file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intent-broker-shim-'));
  const shimPath = path.join(dir, '.local', 'bin', 'intent-broker');

  try {
    ensureCommandShim(shimPath, '#!/bin/sh\necho ok\n', { platform: 'linux' });
    assert.match(readFileSync(shimPath, 'utf8'), /echo ok/);
    if (process.platform !== 'win32') {
      assert.equal(statSync(shimPath).mode & 0o777, 0o755);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCommandShim writes Windows .cmd shim and removes old POSIX shim', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intent-broker-shim-'));
  const shimPath = path.join(dir, '.local', 'bin', 'intent-broker.cmd');
  const legacyShimPath = path.join(dir, '.local', 'bin', 'intent-broker');

  try {
    mkdirSync(path.dirname(legacyShimPath), { recursive: true });
    writeFileSync(legacyShimPath, '#!/bin/sh\nexec "/usr/local/bin/node" "/repo/bin/intent-broker.js" "$@"\n');
    ensureCommandShim(shimPath, '@echo off\r\necho ok\r\n', { platform: 'win32' });

    assert.match(readFileSync(shimPath, 'utf8'), /echo ok/);
    assert.equal(existsSync(legacyShimPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isPathDirAvailable checks whether shim directory is on PATH', () => {
  const shimPath = '/Users/song/.local/bin/intent-broker';
  assert.equal(isPathDirAvailable(shimPath, `/usr/bin${path.delimiter}/Users/song/.local/bin`), true);
  assert.equal(isPathDirAvailable(shimPath, '/usr/bin:/bin'), false);
});
