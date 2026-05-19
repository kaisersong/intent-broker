import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadRuntimeState,
  saveRuntimeState
} from '../../adapters/session-bridge/runtime-state.js';

test('runtime state preserves auto-dispatch owner identity while running', () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-runtime-'));
  const statePath = path.join(homeDir, 'runtime.json');

  saveRuntimeState(statePath, {
    status: 'running',
    source: 'auto-dispatch',
    ownerPid: 4242,
    ownerStartedAt: '2026-05-19T10:11:12.000Z'
  });

  assert.equal(loadRuntimeState(statePath).ownerPid, 4242);
  assert.equal(loadRuntimeState(statePath).ownerStartedAt, '2026-05-19T10:11:12.000Z');
});

test('runtime state clears owner identity outside running auto-dispatch', () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-runtime-'));
  const statePath = path.join(homeDir, 'runtime.json');

  saveRuntimeState(statePath, {
    status: 'idle',
    source: 'auto-dispatch-complete',
    ownerPid: 4242,
    ownerStartedAt: '2026-05-19T10:11:12.000Z'
  });

  assert.equal(loadRuntimeState(statePath).ownerPid, null);
  assert.equal(loadRuntimeState(statePath).ownerStartedAt, null);
});
