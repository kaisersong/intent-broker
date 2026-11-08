import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const repo = resolve(import.meta.dirname, '../..');
const hash = raw => createHash('sha256').update(raw).digest('hex');
const lock = JSON.parse(readFileSync(join(repo, 'tests/fixtures/managed-broker-native-input.lock.json'), 'utf8'));
function snapshot(root) {
  const rows = [];
  function walk(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const name = join(dir, item.name);
      if (item.isDirectory()) walk(name);
      else if (item.isFile()) { const s = statSync(name, { bigint: true }); rows.push([relative(root, name), hash(readFileSync(name)), s.size.toString(), s.mtimeNs.toString()]); }
      else assert.fail('unexpected source input link');
    }
  }
  walk(root);
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}
for (const scenario of ['normal', 'wrong-config', 'early-close', 'no-seed']) {
  test('original fixed Broker bootstrap ' + scenario + ' uses real Native parent and business', { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
    assert.ok(process.env.XIAOK_BROKER_BOOTSTRAP_NATIVE_INPUT_ROOT, 'explicit private Native source prerequisite required');
    const root = realpathSync(join(process.env.XIAOK_BROKER_BOOTSTRAP_NATIVE_INPUT_ROOT, scenario));
    assert.ok([realpathSync(tmpdir()), realpathSync('/tmp')].some(parent => {
      const rel = relative(parent, root);
      return rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
    }));
    const changed = new Set(['tests/native/fixtures/broker-authority-child-live.c']);
    for (const [name, sha, bytes] of lock.files) {
      if (changed.has(name) || (scenario === 'no-seed' && name === 'tests/native/helpers/broker-authority-node-fixture.mjs')) continue;
      const raw = readFileSync(join(root, name));
      assert.equal(raw.length, bytes, name); assert.equal(hash(raw), sha, name);
    }
    const entry = readFileSync(join(repo, 'tests/fixtures/original-broker-bootstrap-entry.cjs'), 'utf8')
      .replace('__BOOTSTRAP_SIBLING_ROOT__', JSON.stringify(repo)).replace('__BOOTSTRAP_SCENARIO__', JSON.stringify(scenario));
    const sender = readFileSync(join(repo, 'tests/fixtures/original-broker-bootstrap-parent.c'), 'utf8').replace('__BOOTSTRAP_SCENARIO__', JSON.stringify(scenario));
    assert.equal(readFileSync(join(root, 'tests/native/fixtures/broker-authority-node.cjs'), 'utf8'), entry);
    assert.equal(readFileSync(join(root, 'tests/native/fixtures/broker-authority-child-live.c'), 'utf8'), sender);
    if (scenario === 'no-seed') assert.equal(
      readFileSync(join(root, 'tests/native/helpers/broker-authority-node-fixture.mjs'), 'utf8'),
      readFileSync(join(repo, 'tests/fixtures/original-broker-no-seed-runner.mjs'), 'utf8')
    );
    const nativeBefore = snapshot(root), businessBefore = snapshot(join(repo, 'src'));
    const adaptersBefore = snapshot(join(repo, 'adapters'));
    const runtimeBefore = readFileSync(join(repo, 'runtime/xiaok-source-runtime.cjs'));
    const { runOriginalBrokerNode } = await import(pathToFileURL(join(root, 'tests/native/helpers/broker-authority-node-fixture.mjs')));
    const rows = await runOriginalBrokerNode({ withoutBirth: scenario === 'no-seed' });
    assert.deepEqual(snapshot(root), nativeBefore);
    assert.deepEqual(snapshot(join(repo, 'src')), businessBefore);
    assert.deepEqual(snapshot(join(repo, 'adapters')), adaptersBefore);
    assert.deepEqual(readFileSync(join(repo, 'runtime/xiaok-source-runtime.cjs')), runtimeBefore);
    const result = rows.find(row => row.kind === 'broker-original-bootstrap-result');
    assert.ok(result); assert.equal(result.scenario, scenario); assert.equal(result.rejected, scenario === 'wrong-config' || scenario === 'no-seed');
    if (scenario === 'no-seed') {
      console.log(JSON.stringify({ kind: 'broker-bootstrap-native-no-seed', node: process.versions.node, actualBootstrapRejected: true, productionQualified: false }));
      return;
    }
    const actual = rows.find(row => row.kind === 'broker-bootstrap-parent');
    assert.ok(actual); assert.equal(actual.ready, scenario === 'normal'); assert.equal(actual.http, scenario === 'normal');
    const fate = rows.find(row => row.kind === 'broker-fixed-native-core-component');
    assert.ok(fate); assert.equal(fate.failure, 0); assert.equal(fate.rootFilesClosed, true); assert.equal(fate.unknown, false);
    console.log(JSON.stringify({ kind: 'broker-bootstrap-native-evidence', scenario, node: process.versions.node, sourceUnchanged: true, genuineElectronMain: false, productionQualified: false }));
  });
}
