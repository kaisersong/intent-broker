// Test entry only. The actual product bootstrap must consume its own Native birth.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sibling = __BOOTSTRAP_SIBLING_ROOT__, scenario = __BOOTSTRAP_SCENARIO__;
const app = path.join(__dirname, 'business');
fs.mkdirSync(app, { mode: 0o700 });
fs.cpSync(path.join(sibling, 'src'), path.join(app, 'src'), { recursive: true });
fs.cpSync(path.join(sibling, 'adapters'), path.join(app, 'adapters'), { recursive: true });
fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}');
fs.symlinkSync(path.join(__dirname, 'runtime'), path.join(app, 'runtime'), 'dir');
fs.copyFileSync(path.join(sibling, 'runtime/xiaok-source-runtime.cjs'), path.join(__dirname, 'runtime/xiaok-source-runtime.cjs'));
fs.symlinkSync(fs.realpathSync(path.join(sibling, 'node_modules')), path.join(app, 'node_modules'), 'dir');
(async () => {
  // Test-only actual OS account isolation, preserving UID/GID and HOME environment.
  await import(pathToFileURL(path.join(sibling, 'tests/fixtures/source-account-preload.mjs')));
  let failure;
  try { await import(pathToFileURL(path.join(app, 'src/runtime/original-authority-bootstrap.js'))); }
  catch (raw) { failure = { raw }; }
  if (scenario === 'no-seed') {
    assert.ok(failure, 'bootstrap requires the actual inherited Native birth');
    assert.equal(failure.raw?.code, 'BROKER_ORIGINAL_AUTHORITY_REQUIRED');
    process.exitCode = 0;
  } else if (scenario === 'wrong-config') {
    assert.ok(failure, 'original bootstrap must reject wrong configuration');
    assert.equal(failure.raw?.code, 'BROKER_ORIGINAL_STARTUP_INVALID');
    process.exitCode = 0;
  } else {
    assert.equal(failure, undefined);
  }
  console.log(JSON.stringify({ kind: 'broker-original-bootstrap-result', scenario, node: process.versions.node, rejected: !!failure, genuineElectronMain: false, productionQualified: false }));
})().catch(raw => { console.error(raw); process.exitCode = 1; });
