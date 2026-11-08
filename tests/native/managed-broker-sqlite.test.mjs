import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const repo = resolve(import.meta.dirname, '../..');
const hash = raw => createHash('sha256').update(raw).digest('hex');
const lock = JSON.parse(readFileSync(join(repo, 'tests/fixtures/managed-broker-native-input.lock.json'), 'utf8'));
function snapshot(root, paths) {
    return paths.map(name => { const p = join(root, name), s = statSync(p, { bigint: true }); return [name, hash(readFileSync(p)), s.size.toString(), s.mtimeNs.toString()]; });
}
function sources(directory) {
    const paths = [];
    function walk(dir) { for (const item of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, item.name);
        if (item.isDirectory())
            walk(p);
        else if (item.isFile())
            paths.push(relative(repo, p));
        else
            assert.fail('source input must be a plain file');
    } }
    walk(directory);
    return paths.sort();
}
test('real original Broker Native namespace runs original Event and Room through one guarded connection', { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
    const configured = process.env.XIAOK_BROKER_NATIVE_INPUT_ROOT;
    assert.ok(configured, 'explicit task-private Native build input prerequisite required');
    const root = realpathSync(configured), allowed = [realpathSync('/tmp'), realpathSync(tmpdir())];
    assert.ok(allowed.some(parent => root.startsWith(parent + sep)), 'test input must stay in a private temporary root');
    assert.equal(lstatSync(configured).isSymbolicLink(), false);
    const inputPaths = lock.files.map(row => row[0]);
    for (const [name, sha, bytes] of lock.files) {
        const raw = readFileSync(join(root, name));
        assert.equal(raw.length, bytes, name);
        assert.equal(hash(raw), sha, name);
    }
    const template = readFileSync(join(repo, 'tests/fixtures/managed-broker-native-entry.cjs'), 'utf8');
    const entry = template.replace('__MANAGED_SIBLING_ROOT__', JSON.stringify(repo));
    assert.equal(readFileSync(join(root, 'tests/native/fixtures/broker-authority-node.cjs'), 'utf8'), entry, 'only this new fixture entry differs from the original helper inputs');
    const localPaths = [...sources(join(repo, 'src')), 'runtime/xiaok-source-runtime.cjs', 'tests/fixtures/managed-broker-native-entry.cjs', 'tests/fixtures/source-account-preload.mjs'];
    const before = snapshot(root, inputPaths), localBefore = snapshot(repo, localPaths);
    const { runOriginalBrokerNode } = await import(pathToFileURL(join(root, 'tests/native/helpers/broker-authority-node-fixture.mjs')));
    const rows = await runOriginalBrokerNode();
    assert.deepEqual(snapshot(root, inputPaths), before, 'original production Native/helper inputs changed');
    assert.deepEqual(snapshot(repo, localPaths), localBefore, 'actual sibling business/runtime inputs changed');
    const actual = rows.find(row => row.kind === 'broker-managed-native-business');
    assert.ok(actual);
    assert.equal(actual.schema, 9);
    assert.equal(actual.events, 2);
    assert.equal(actual.closed, true);
    assert.equal(actual.productionQualified, false);
    const parent = rows.find(row => row.kind === 'broker-fixed-native-core-component');
    assert.ok(parent);
    assert.equal(parent.failure, 0);
    assert.equal(parent.rootFilesClosed, true);
    assert.equal(parent.unknown, false);
    console.log(JSON.stringify({ kind: 'managed-broker-component-evidence', node: process.versions.node, upstreamNativeCommit: lock.upstreamCommit, localInputCount: localPaths.length, nativeInputCount: inputPaths.length, nativeAndHelperInputsUnchanged: true, actualBusinessInputsUnchanged: true, genuineElectronMain: false, productionQualified: false }));
});
for (const scenario of ['constructor', 'close-undefined', 'close-held', 'getter-held']) {
    test('real original Native SDK fault keeps ' + scenario + ' custody and negative consumers', { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
        const configured = process.env.XIAOK_BROKER_NATIVE_FAULT_INPUT_ROOT;
        assert.ok(configured, 'explicit task-private Native fault input prerequisite required');
        const root = realpathSync(join(configured, scenario));
        assert.ok([realpathSync('/tmp'), realpathSync(tmpdir())].some(parent => root.startsWith(parent + sep)));
        const changed = 'native/protected-sqlite-facade/protected-sqlite-facade.c';
        for (const [name, sha, bytes] of lock.files) {
            const selected = name === changed ? 'native/protected-sqlite-facade/protected-sqlite-original.c' : name;
            const raw = readFileSync(join(root, selected));
            assert.equal(raw.length, bytes, selected);
            assert.equal(hash(raw), sha, selected);
        }
        assert.equal(readFileSync(join(root, changed), 'utf8'), readFileSync(join(repo, 'tests/fixtures/managed-broker-native-tap.c'), 'utf8'));
        const template = readFileSync(join(repo, 'tests/fixtures/managed-broker-native-fault-entry.cjs'), 'utf8');
        const entry = template.replace('__MANAGED_SIBLING_ROOT__', JSON.stringify(repo)).replace('__MANAGED_NATIVE_FAULT_CASE__', JSON.stringify(scenario));
        assert.equal(readFileSync(join(root, 'tests/native/fixtures/broker-authority-node.cjs'), 'utf8'), entry);
        const inputPaths = lock.files.map(row => row[0]);
        inputPaths.push('native/protected-sqlite-facade/protected-sqlite-original.c');
        const localPaths = [...sources(join(repo, 'src')), 'runtime/xiaok-source-runtime.cjs', 'tests/fixtures/managed-broker-native-fault-entry.cjs', 'tests/fixtures/managed-broker-native-tap.c', 'tests/fixtures/source-account-preload.mjs'];
        const before = snapshot(root, inputPaths), localBefore = snapshot(repo, localPaths);
        const { runOriginalBrokerNode } = await import(pathToFileURL(join(root, 'tests/native/helpers/broker-authority-node-fixture.mjs')));
        const rows = await runOriginalBrokerNode();
        assert.deepEqual(snapshot(root, inputPaths), before);
        assert.deepEqual(snapshot(repo, localPaths), localBefore);
        const actual = rows.find(row => row.kind === 'broker-managed-native-fault');
        assert.ok(actual);
        assert.equal(actual.scenario, scenario);
        if (scenario === 'getter-held')
            assert.equal(actual.metadataUnknownRetained, true);
        else
            assert.equal(actual.originalFirstValueRetained, true);
        assert.equal(actual.productionQualified, false);
        const parent = rows.find(row => row.kind === 'broker-fixed-native-core-component');
        assert.ok(parent);
        assert.equal(parent.failure, 0);
        assert.equal(parent.rootFilesClosed, true);
        assert.equal(parent.unknown, false);
        console.log(JSON.stringify({ kind: 'managed-broker-native-fault-evidence', scenario, node: process.versions.node, upstreamNativeCommit: lock.upstreamCommit, originalFacadeBodyUnchanged: true, onlyAcknowledgementTestTap: true, genuineElectronMain: false, productionQualified: false }));
    });
}
