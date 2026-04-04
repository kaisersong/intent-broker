import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadBrokerHeartbeat,
  resolveBrokerRuntimePaths,
  saveBrokerHeartbeat
} from '../../src/runtime/broker-runtime-state.js';

test('resolveBrokerRuntimePaths returns stable broker log and heartbeat paths', () => {
  const paths = resolveBrokerRuntimePaths({
    cwd: '/Users/song/projects/intent-broker',
    env: {}
  });

  assert.deepEqual(paths, {
    stdout: '/Users/song/projects/intent-broker/.tmp/broker.stdout.log',
    stderr: '/Users/song/projects/intent-broker/.tmp/broker.stderr.log',
    heartbeat: '/Users/song/projects/intent-broker/.tmp/broker.heartbeat.json'
  });
});

test('saveBrokerHeartbeat does not let an old pid overwrite a newer owner', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'intent-broker-heartbeat-'));
  const heartbeatPath = path.join(cwd, '.tmp', 'broker.heartbeat.json');

  saveBrokerHeartbeat(heartbeatPath, {
    pid: 200,
    status: 'running',
    updatedAt: '2026-04-04T12:20:00.000Z'
  });

  const replaced = saveBrokerHeartbeat(
    heartbeatPath,
    {
      pid: 100,
      status: 'stopped',
      updatedAt: '2026-04-04T12:20:01.000Z'
    },
    { onlyIfOwnedByPid: 100 }
  );

  assert.equal(replaced, false);
  assert.deepEqual(loadBrokerHeartbeat(heartbeatPath), {
    pid: 200,
    status: 'running',
    updatedAt: '2026-04-04T12:20:00.000Z'
  });
  assert.match(readFileSync(heartbeatPath, 'utf8'), /"pid": 200/);
});
