import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  defaultInstallPaths,
  ensureXiaokInstall
} from '../../adapters/xiaok-code-plugin/install.js';

test('ensureXiaokInstall registers approval hooks for PreToolUse and PermissionRequest', () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-xiaok-home-'));
  const repoRoot = '/Users/song/projects/intent-broker';

  try {
    ensureXiaokInstall({ homeDir, repoRoot });
    const paths = defaultInstallPaths({ homeDir, repoRoot });
    const manifest = JSON.parse(readFileSync(path.join(paths.pluginDir, 'plugin.json'), 'utf8'));

    assert.deepEqual(
      manifest.hooks.map((hook) => hook.events[0]),
      ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop']
    );
    assert.match(manifest.hooks[2].command, /hook pre-tool-use$/);
    assert.match(manifest.hooks[3].command, /hook permission-request$/);
    assert.equal(manifest.hooks[2].async, false);
    assert.equal(manifest.hooks[3].async, false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
