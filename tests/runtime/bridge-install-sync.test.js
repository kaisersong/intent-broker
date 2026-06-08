import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { syncAgentBridges } from '../../src/runtime/bridge-install-sync.js';

test('syncAgentBridges writes Claude project settings to cwd while commands point at repoRoot', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'intent-broker-bridge-sync-'));
  const repoRoot = path.join(root, 'packaged-repo');
  const cwd = path.join(root, 'runtime-cwd');
  const homeDir = path.join(root, 'home');
  const logger = { log() {}, warn() {} };

  try {
    await syncAgentBridges({ repoRoot, cwd, homeDir, logger });

    const runtimeSettingsPath = path.join(cwd, '.claude', 'settings.json');
    const repoSettingsPath = path.join(repoRoot, '.claude', 'settings.json');
    const settingsText = readFileSync(runtimeSettingsPath, 'utf8');

    assert.equal(existsSync(runtimeSettingsPath), true);
    assert.equal(existsSync(repoSettingsPath), false);
    assert.match(
      settingsText,
      new RegExp(path.join(repoRoot, 'adapters', 'claude-code-plugin', 'bin', 'claude-code-broker.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
