import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readOriginalBrokerStartup } from '../../src/runtime/original-broker-startup-config.js';
import { observeOriginalBrokerPromise } from '../../src/runtime/original-broker-startup-promise.js';
import { readBrokerSourceRuntime } from '../../src/store/source-runtime.js';
function frame(root) {
  return { kind: 'original_broker_start_v1', environment: {
    XIAOK_CONFIG_DIR: root, PORT: '0', INTENT_BROKER_DB: join(root, 'logical.sqlite'),
    INTENT_BROKER_SOCKET_PATH: '', INTENT_BROKER_DESKTOP_TOKEN: 'desktop-test', INTENT_BROKER_KSWARM_TOKEN: 'kswarm-test'
  } };
}
function invalid(raw) { assert.throws(() => readOriginalBrokerStartup(raw), error => error.code === 'BROKER_ORIGINAL_STARTUP_INVALID'); }

test('closed original startup rejects role/environment injection and getters before any config access', () => {
  for (const name of ['HOME', 'USERPROFILE', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'namespace', 'provider', 'known', 'authority', 'family', 'seed']) {
    const value = frame('not-an-absolute-directory'); value.environment[name] = 'forbidden'; invalid(value);
  }
  let gets = 0;
  const value = frame('not-read'); Object.defineProperty(value.environment, 'PORT', { get() { gets++; throw 0; } });
  invalid(value); assert.equal(gets, 0);
  const symbol = frame('not-read'); symbol[Symbol('unknown')] = undefined; invalid(symbol);
});

test('closed original startup validates required fields and canonical port without changing HOME', () => {
  const home = process.env.HOME;
  for (const key of Object.keys(frame('not-read').environment)) {
    const value = frame('not-read'); delete value.environment[key]; invalid(value);
  }
  for (const port of ['-1', '+1', '01', '1.5', '65536', 'NaN']) { const value = frame('not-read'); value.environment.PORT = port; invalid(value); }
  assert.equal(process.env.HOME, home);
});

test('closed original startup accepts only the existing private directory and contained config', { skip: process.platform === 'win32' }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'broker-bootstrap-config-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'config'); mkdirSync(config, { mode: 0o700 });
  const value = frame(config); value.environment.INTENT_BROKER_CONFIG = 'service.json';
  writeFileSync(join(config, 'service.json'), '{}');
  assert.equal(readOriginalBrokerStartup(value).XIAOK_CONFIG_DIR, config);
  const escape = frame(config); escape.environment.INTENT_BROKER_CONFIG = '../outside.json'; invalid(escape);
  symlinkSync(join(config, 'service.json'), join(config, 'linked.json'));
  const link = frame(config); link.environment.INTENT_BROKER_CONFIG = 'linked.json'; invalid(link);
  const shared = join(root, 'shared'); mkdirSync(shared, { mode: 0o755 }); invalid(frame(shared));
});

test('original finite Promise adapter preserves reject undefined and own held tails', async () => {
  const stock = readBrokerSourceRuntime().createRoomTurnCustody(), retained = [];
  let release, first;
  const held = new Promise(yes => { release = yes; });
  const raw = Promise.reject(undefined); Object.defineProperty(raw, Symbol('known-held'), { value: held });
  try { await stock.root(async () => { await observeOriginalBrokerPromise(stock, retained, raw); }); }
  catch (error) { first = { raw: error }; }
  assert.ok(first); assert.equal(first.raw, undefined);
  let settled = false; const joined = stock.waitPhysicalKnown().then(() => { settled = true; });
  await new Promise(yes => setImmediate(yes)); assert.equal(settled, false);
  release(); await joined; assert.equal(settled, true);
});

test('original finite Promise adapter keeps unknown independent from known held tails', async () => {
  const stock = readBrokerSourceRuntime().createRoomTurnCustody(), retained = [];
  let release, gets = 0;
  const held = new Promise(yes => { release = yes; }), raw = Promise.resolve(undefined);
  Object.defineProperty(raw, Symbol('unknown'), { get() { gets++; throw 0; } });
  Object.defineProperty(raw, Symbol('known-held'), { value: held });
  await stock.root(async () => { await observeOriginalBrokerPromise(stock, retained, raw); });
  let settled = false;
  const joined = stock.waitPhysicalKnown().then(() => { settled = true; return null; }, error => { settled = true; return error; });
  await new Promise(yes => setImmediate(yes)); assert.equal(settled, false); assert.equal(gets, 0);
  release(); assert.ok(await joined); assert.equal(gets, 0); assert.throws(() => stock.assertPhysicalKnown());
});
