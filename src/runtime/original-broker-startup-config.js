// IPC configuration only: these values never select or authenticate a namespace.
import { types } from 'node:util';
import { lstatSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
const keys = Reflect.ownKeys, descriptor = Object.getOwnPropertyDescriptor, own = Object.hasOwn;
const required = ['XIAOK_CONFIG_DIR', 'PORT', 'INTENT_BROKER_DB', 'INTENT_BROKER_SOCKET_PATH', 'INTENT_BROKER_DESKTOP_TOKEN', 'INTENT_BROKER_KSWARM_TOKEN'];
const allowed = new Set([...required, 'INTENT_BROKER_CONFIG', 'INTENT_BROKER_LOCAL_CONFIG']);
export function originalBrokerStartupError(code = 'BROKER_ORIGINAL_STARTUP_INVALID') {
  const error = new Error(code); error.code = code; return error;
}
function reject() { throw originalBrokerStartupError(); }
function dataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) reject();
}
function within(root, name) {
  const rel = relative(root, name);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
export function readOriginalBrokerStartup(raw) {
  dataObject(raw);
  const names = keys(raw);
  if (names.length !== 2 || !own(raw, 'kind') || !own(raw, 'environment')) reject();
  const kind = descriptor(raw, 'kind'), environment = descriptor(raw, 'environment');
  if (!kind || !own(kind, 'value') || kind.value !== 'original_broker_start_v1' || !environment || !own(environment, 'value')) reject();
  dataObject(environment.value);
  const source = environment.value, result = Object.create(null); let bytes = 0;
  for (const name of keys(source)) {
    const field = descriptor(source, name);
    if (typeof name !== 'string' || !allowed.has(name) || !field || !own(field, 'value') || typeof field.value !== 'string' || field.value.includes('\0')) reject();
    bytes += Buffer.byteLength(name) + Buffer.byteLength(field.value);
    if (bytes > 262144) reject();
    Object.defineProperty(result, name, { value: field.value, enumerable: true });
  }
  for (const name of required) if (!own(result, name)) reject();
  if (!/^(0|[1-9][0-9]{0,4})$/.test(result.PORT) || Number(result.PORT) > 65535) reject();
  // Port zero requests the existing HTTP server's ephemeral port; no authority.
  if (result.INTENT_BROKER_SOCKET_PATH !== '' || !result.INTENT_BROKER_DB) reject();
  const a = result.INTENT_BROKER_DESKTOP_TOKEN, b = result.INTENT_BROKER_KSWARM_TOKEN;
  if (!a || !b || a.length > 4096 || b.length > 4096 || a === b) reject();
  const root = result.XIAOK_CONFIG_DIR;
  if (!isAbsolute(root) || resolve(root) !== root) reject();
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(root) !== root || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) reject();
  for (const name of ['INTENT_BROKER_CONFIG', 'INTENT_BROKER_LOCAL_CONFIG']) {
    const path = resolve(root, result[name] || (name === 'INTENT_BROKER_CONFIG' ? 'intent-broker.config.json' : 'intent-broker.local.json'));
    if (!within(root, path)) reject();
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !within(root, realpathSync(path)))) reject();
  }
  return Object.freeze(result);
}
