import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildCommandShimContent,
  defaultCommandShimPath,
  ensureCommandShim,
  isPathDirAvailable
} from '../../adapters/hook-installer-core/command-shim.js';

test('defaultCommandShimPath uses ~/.local/bin/intent-broker', () => {
  assert.equal(
    defaultCommandShimPath({ homeDir: '/Users/song' }),
    path.join('/Users/song', '.local', 'bin', 'intent-broker')
  );
});

test('buildCommandShimContent wraps unified cli with node', () => {
  const content = buildCommandShimContent({
    cliPath: '/Users/song/projects/intent-broker/bin/intent-broker.js',
    nodePath: '/usr/local/bin/node'
  });

  assert.match(content, /^#!\/bin\/sh/);
  assert.match(content, /exec "\/usr\/local\/bin\/node" "\/Users\/song\/projects\/intent-broker\/bin\/intent-broker\.js" "\$@"/);
});

test('ensureCommandShim writes executable shim file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intent-broker-shim-'));
  const shimPath = path.join(dir, '.local', 'bin', 'intent-broker');

  try {
    ensureCommandShim(shimPath, '#!/bin/sh\necho ok\n');
    assert.match(readFileSync(shimPath, 'utf8'), /echo ok/);
    assert.equal(statSync(shimPath).mode & 0o777, 0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isPathDirAvailable checks whether shim directory is on PATH', () => {
  const shimPath = '/Users/song/.local/bin/intent-broker';
  assert.equal(isPathDirAvailable(shimPath, `/usr/bin${path.delimiter}/Users/song/.local/bin`), true);
  assert.equal(isPathDirAvailable(shimPath, '/usr/bin:/bin'), false);
});
