// Fixed installed entry. Native birth is consumed before user configuration or
// business imports. IPC config and passive status messages grant no IO role.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readOriginalBrokerStartup, originalBrokerStartupError } from './original-broker-startup-config.js';
import { observeOriginalBrokerPromise } from './original-broker-startup-promise.js';
const load = createRequire(import.meta.url), apply = Reflect.apply;
const unknown = Object.freeze(Object.defineProperty(Object.create(null), 'unknown', { get() {} }));
const retained = []; let native, core, first, stock;
function remember(raw) {
  retained.push(raw);
  try { stock?.inventory(raw); }
  catch (secondary) { retained.push(secondary); first ??= { raw: secondary }; }
}
function fail(raw) { first ??= { raw }; remember(raw); }
try {
  native = load('../../runtime/protected_sqlite.node');
  core = native.consumeOriginalBrokerSource();
} catch (raw) { first = { raw }; retained.push(raw); }
// Pure fixed SDK custody resource, never a namespace/provider/config importer.
try { stock = load('../../runtime/xiaok-source-runtime.cjs').createRoomTurnCustody(); }
catch (raw) { first ??= { raw }; retained.push(raw); }
const closeNative = () => {
  if (core) {
    try { const raw = apply(core.closeOwned, core, []); if (raw !== undefined) { remember(raw); remember(unknown); throw Error('BROKER_ORIGINAL_CLOSE_UNCONFIRMED'); } }
    catch (raw) { fail(raw); remember(unknown); }
  }
  if (native) {
    try { const raw = native.finishOriginalBrokerSource(); if (raw !== undefined) { remember(raw); remember(unknown); throw Error('BROKER_ORIGINAL_FINISH_UNCONFIRMED'); } }
    catch (raw) { fail(raw); remember(unknown); }
  }
};
if (!stock) {
  closeNative();
  throw first.raw;
}
let stopping = false, app, wakeStop, rejectConfiguration, acceptFrame, frameReceived = false;
const frame = new Promise(yes => { acceptFrame = yes; });
const stopped = new Promise(yes => { wakeStop = yes; });
function stop() { stopping = true; rejectConfiguration?.(); wakeStop(); }
const signal = () => stop(), disconnected = () => stop();
process.on('SIGTERM', signal);
process.on('SIGINT', signal);
process.on('disconnect', disconnected);
const send = (kind, fields = {}) => new Promise((yes, no) => {
  if (!process.connected || typeof process.send !== 'function') { yes(); return; }
  try { process.send({ kind, ...fields }, raw => raw ? no(raw) : yes()); }
  catch (raw) { no(raw); }
});
const message = raw => {
  if (frameReceived) { remember(raw); fail(originalBrokerStartupError()); stop(); return; }
  frameReceived = true; retained.push(raw); acceptFrame({ raw });
};
// Capture the one original fd3 message before the first asynchronous turn.
process.on('message', message);
try {
  await stock.root(async () => {
    // Initial Native errors are inventoried only after this same Root exists.
    for (let i = 0; i < retained.length; i++) stock.inventory(retained[i]);
    try {
      if (!first) {
        const observe = raw => observeOriginalBrokerPromise(stock, retained, raw);
        if (!process.connected || process.channel?.fd !== 3 || typeof process.send !== 'function') throw originalBrokerStartupError('BROKER_ORIGINAL_STARTUP_CHANNEL');
        await observe(send('original_broker_waiting_v1'));
        const configuration = new Promise((yes, no) => {
          const timer = setTimeout(() => no(originalBrokerStartupError('BROKER_ORIGINAL_STARTUP_TIMEOUT')), 5000);
          rejectConfiguration = () => { clearTimeout(timer); yes(null); };
          frame.then(row => {
            clearTimeout(timer);
            try { yes(readOriginalBrokerStartup(row.raw)); }
            catch (raw) { no(raw); }
          }, no);
          if (stopping) rejectConfiguration();
        });
        const environment = (await observe(configuration)).value;
        rejectConfiguration = undefined;
        if (environment && !stopping) {
          // Only this closed configuration is applied, before the business SCC.
          for (const name of Reflect.ownKeys(environment)) process.env[name] = environment[name];
          process.argv[1] = fileURLToPath(new URL('../cli.js', import.meta.url));
          const entry = (await observe(import('./start-broker-app.js'))).value;
          const config = (await observe(import('../config/load-config.js'))).value;
          stock.current();
          if (!stopping) {
            const loadConfig = options => {
              const value = config.loadIntentBrokerConfig(options);
              if (value.server.host !== '127.0.0.1' || !Number.isInteger(value.server.port) || value.server.port < 0 || value.server.port > 65535) throw originalBrokerStartupError();
              return value;
            };
            app = (await observe(entry.startBrokerApp({
              cwd: environment.XIAOK_CONFIG_DIR, env: environment, socketPath: null,
              persistedSessionRefreshIntervalMs: 0, syncAgentBridges: async () => [], loadConfig
            }))).value;
            stock.current();
            if (!stopping) await observe(send('original_broker_ready_v1', { port: app.server.address().port, pid: process.pid }));
            if (!stopping) await stopped;
          }
        }
      }
    } catch (raw) { fail(raw); }
    finally {
      stopping = true;
      if (app) {
        try {
          await observeOriginalBrokerPromise(stock, retained, app.close());
        } catch (raw) { fail(raw); }
      }
      closeNative(); // Always attempted even after partial birth or JS unknown.
    }
  }).catch(raw => { fail(raw); });
  process.removeListener('message', message);
  try { await stock.waitPhysicalKnown(); } catch (raw) { fail(raw); }
  if (!first) {
    try { await stock.root(async () => { await observeOriginalBrokerPromise(stock, retained, send('original_broker_closed_v1')); }); }
    catch (raw) { fail(raw); }
    try { await stock.waitPhysicalKnown(); } catch (raw) { fail(raw); }
  }
} finally {
  if (message) process.removeListener('message', message);
  if (process.connected) { try { process.disconnect(); } catch (raw) { fail(raw); } }
  // An error from the final negative SDK still carries its original known tails.
  try { await stock.waitPhysicalKnown(); } catch (raw) { fail(raw); }
  process.removeListener('SIGTERM', signal);
  process.removeListener('SIGINT', signal);
  process.removeListener('disconnect', disconnected);
}
if (first) throw first.raw;
