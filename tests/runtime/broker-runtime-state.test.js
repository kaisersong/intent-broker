import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  isTerminalBrokerHeartbeatStatus,
  loadBrokerHeartbeat,
  resolveBrokerRuntimePaths,
  saveBrokerHeartbeat
} from '../../src/runtime/broker-runtime-state.js';

test('resolveBrokerRuntimePaths returns stable broker log and heartbeat paths', () => {
  const cwd = path.join(path.sep, 'Users', 'song', 'projects', 'intent-broker');
  const paths = resolveBrokerRuntimePaths({
    cwd,
    env: {}
  });

  assert.deepEqual(paths, {
    stdout: path.join(cwd, '.tmp', 'broker.stdout.log'),
    stderr: path.join(cwd, '.tmp', 'broker.stderr.log'),
    heartbeat: path.join(cwd, '.tmp', 'broker.heartbeat.json')
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

test('saveBrokerHeartbeat lets a running broker reclaim a terminal stale heartbeat', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'intent-broker-heartbeat-'));
  const heartbeatPath = path.join(cwd, '.tmp', 'broker.heartbeat.json');

  saveBrokerHeartbeat(heartbeatPath, {
    pid: 100,
    status: 'stopped',
    updatedAt: '2026-04-04T12:20:00.000Z'
  });

  const replaced = saveBrokerHeartbeat(
    heartbeatPath,
    {
      pid: 200,
      status: 'running',
      updatedAt: '2026-04-04T12:20:01.000Z'
    },
    {
      onlyIfOwnedByPid: 200,
      allowIfTerminal: true
    }
  );

  assert.equal(replaced, true);
  assert.deepEqual(loadBrokerHeartbeat(heartbeatPath), {
    pid: 200,
    status: 'running',
    updatedAt: '2026-04-04T12:20:01.000Z'
  });
});

test('saveBrokerHeartbeat does not let a second starter overwrite a running owner', () => {
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
      pid: 300,
      status: 'starting',
      updatedAt: '2026-04-04T12:20:01.000Z'
    },
    {
      onlyIfOwnedByPid: 300,
      allowIfMissing: true,
      allowIfTerminal: true
    }
  );

  assert.equal(replaced, false);
  assert.deepEqual(loadBrokerHeartbeat(heartbeatPath), {
    pid: 200,
    status: 'running',
    updatedAt: '2026-04-04T12:20:00.000Z'
  });
});

test('isTerminalBrokerHeartbeatStatus recognizes terminal states only', () => {
  assert.equal(isTerminalBrokerHeartbeatStatus('stopped'), true);
  assert.equal(isTerminalBrokerHeartbeatStatus('failed-to-start'), true);
  assert.equal(isTerminalBrokerHeartbeatStatus('running'), false);
  assert.equal(isTerminalBrokerHeartbeatStatus('starting'), false);
});
