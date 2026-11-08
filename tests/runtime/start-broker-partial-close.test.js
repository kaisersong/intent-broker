import test from 'node:test';
import assert from 'node:assert/strict';
import { startBrokerApp } from '../../src/runtime/start-broker-app.js';

function fixture(overrides = {}) {
  const calls = [];
  const broker = { registerParticipant() {}, attachWebSocket() {}, close() { calls.push('broker'); } };
  const server = { async listen() {}, raw() { return {}; }, address() { return { port: 1 }; }, async close() { calls.push('server'); } };
  const channels = { async startAll() {}, describe() { return []; }, async stopAll() { calls.push('channels'); } };
  const discovery = { async start() {}, async stop() { calls.push('discovery'); } };
  const options = {
    cwd: process.cwd(), env: {}, socketPath: null, persistedSessionRefreshIntervalMs: 0,
    logger: { log() {}, warn() {} }, syncAgentBridges: async () => [],
    loadConfig: () => ({ server: { dbPath: './.tmp/test-partial.sqlite', host: '127.0.0.1', port: 1 }, channels: {} }),
    createBroker: () => broker, createHttpServer: () => server,
    createChannelsRuntime: () => channels, createCodexResumeDiscoveryRuntime: () => discovery,
    refreshPersistedAgentSessions: async () => [], ...overrides
  };
  return { calls, broker, server, channels, discovery, options };
}
async function failure(work) {
  try { await work(); return { rejected: false }; }
  catch (raw) { return { rejected: true, raw }; }
}

test('original startBrokerApp closes its partial Broker and HTTP server after listen rejection', async () => {
  const f = fixture(), original = Error('listen-first');
  f.server.listen = async () => { throw original; };
  const result = await failure(() => startBrokerApp(f.options));
  assert.equal(result.rejected, true);
  assert.equal(result.raw, original);
  assert.deepEqual(f.calls, ['broker', 'server']);
});

test('original startBrokerApp closes all born resources after refresh rejection', async () => {
  const original = Error('refresh-first'), f = fixture({ refreshPersistedAgentSessions: async () => { throw original; } });
  const result = await failure(() => startBrokerApp(f.options));
  assert.equal(result.rejected, true);
  assert.equal(result.raw, original);
  assert.deepEqual(f.calls, ['broker', 'server']);
});

test('original app close retains bare undefined and attempts every later resource once', async () => {
  const f = fixture();
  f.discovery.stop = async () => { f.calls.push('discovery'); throw undefined; };
  const app = await startBrokerApp(f.options), result = await failure(() => app.close());
  assert.equal(result.rejected, true);
  assert.equal(result.raw, undefined);
  assert.deepEqual(f.calls, ['discovery', 'channels', 'broker', 'server']);
  const again = await failure(() => app.close());
  assert.equal(again.rejected, true);
  assert.equal(again.raw, undefined);
  assert.deepEqual(f.calls, ['discovery', 'channels', 'broker', 'server']);
});

test('original startup preserves undefined first cause plus independent close errors', async () => {
  const f = fixture(), secondary = Error('close-second');
  f.server.listen = async () => { throw undefined; };
  f.broker.close = () => { f.calls.push('broker'); throw secondary; };
  const result = await failure(() => startBrokerApp(f.options));
  assert.equal(result.rejected, true);
  assert.ok(result.raw instanceof AggregateError);
  assert.equal(Object.hasOwn(result.raw, 'cause'), true);
  assert.equal(result.raw.cause, undefined);
  assert.equal(result.raw.errors[0], undefined);
  assert.equal(result.raw.errors[1], secondary);
  assert.deepEqual(f.calls, ['broker', 'server']);
});

test('original app close exposes the actual nested SDK Promise tails to its original custody', async () => {
  const { readBrokerSourceRuntime } = await import('../../src/store/source-runtime.js');
  const { observeOriginalBrokerPromise } = await import('../../src/runtime/original-broker-startup-promise.js');
  const stock = readBrokerSourceRuntime().createRoomTurnCustody(), retained = [], f = fixture();
  let release;
  const held = new Promise(yes => { release = yes; });
  f.discovery.stop = () => {
    f.calls.push('discovery');
    const raw = Promise.resolve(undefined);
    Object.defineProperty(raw, Symbol('actual-stop-tail'), { value: held });
    return raw;
  };
  const app = await startBrokerApp(f.options);
  await stock.root(async () => { await observeOriginalBrokerPromise(stock, retained, app.close()); });
  let settled = false;
  const joined = stock.waitPhysicalKnown().then(() => { settled = true; });
  await new Promise(yes => setImmediate(yes));
  assert.equal(settled, false);
  release(); await joined;
  assert.deepEqual(f.calls, ['discovery', 'channels', 'broker', 'server']);
});
