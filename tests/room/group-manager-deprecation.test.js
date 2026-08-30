/**
 * Legacy group-manager deprecation contract (design §2.2, §9.1, §16.1).
 *
 * RED until Phase 1 implementation lands.
 *
 * The experimental group-manager path (in-process Map, notify collapsing to
 * file change notifications, `group_notification` kind rejected by the
 * validator) is migrated into the formal Room domain. The old CLI surface
 * must keep a stable deprecation contract for at least one release cycle:
 *   - `intent-broker group *` exits non-zero with a stable deprecated error
 *     and points users at the new Room commands.
 *   - it performs no broker network requests and never reports success.
 *   - no production code path emits `group_notification` anymore
 *     (both group-manager and conflict-detector senders are removed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runGroupCli(args) {
  return spawnSync(
    process.execPath,
    [path.join(repoRoot, 'bin/intent-broker.js'), 'group', ...args],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        // point at a dead port: the deprecated command must not depend on
        // any broker round trip to produce its stable error
        BROKER_URL: 'http://127.0.0.1:1',
      },
    }
  );
}

test('group list exits non-zero with a stable deprecated error and migration guidance', () => {
  const result = runGroupCli(['list', '--project', 'demo']);
  assert.notEqual(result.status, 0, 'deprecated command must not exit 0');
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /deprecated/i);
  assert.match(output, /intent-broker room/i, 'must point users at the new Room commands');
});

test('group notify exits non-zero and never claims success', () => {
  const result = runGroupCli(['notify', 'file-changed', 'src/app.js', '--reason', 'test']);
  assert.notEqual(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /deprecated/i);
  assert.doesNotMatch(output, /sent\s*:\s*[1-9]/, 'must not report delivered notifications');
});

test('group register exits non-zero with the same deprecation contract', () => {
  const result = runGroupCli(['register']);
  assert.notEqual(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /deprecated/i);
});

test('no production adapter emits the legacy group_notification kind anymore', () => {
  // design §2.2: both sender sites (group-manager and conflict-detector)
  // must stop emitting `group_notification`; it is not a valid broker kind.
  const senders = [
    'adapters/group-manager/service.js',
    'adapters/conflict-detector/service.js',
  ];
  for (const relative of senders) {
    const source = readFileSync(path.join(repoRoot, relative), 'utf8');
    assert.ok(
      !source.includes("'group_notification'") && !source.includes('"group_notification"'),
      `${relative} must no longer emit the group_notification kind`
    );
  }
});
