import { readBrokerProtectedSQLiteResource } from '../store/protected-sqlite-resource.js';
import { activityServiceIdentity } from './activity-service-identity.js';
import { mkdirSync, unlinkSync, existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createBrokerService } from '../broker/service.js';
import { createHumanEscalation } from './human-escalation.js';
import { createServer } from '../http/server.js';
import { loadIntentBrokerConfig } from '../config/load-config.js';
import { syncAgentBridges as syncAgentBridgesDefault } from './bridge-install-sync.js';
import { createCodexResumeDiscoveryRuntime as createCodexResumeDiscoveryRuntimeDefault } from './codex-resume-discovery.js';
import { createManagedChannelsRuntime } from './managed-channels.js';
import { createChannelHealthRegistry } from './channel-health.js';
import { refreshPersistedAgentSessions as refreshPersistedAgentSessionsDefault } from './persisted-agent-sessions.js';
import { createRelayAdapter } from '../relay/relay-adapter.js';

export const SOCKET_PATH = join(homedir(), '.intent-broker', 'broker.sock');
const MODULE_CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolveDefaultSocketPath({
  env = process.env,
  platform = process.platform
} = {}) {
  if (Object.hasOwn(env, 'INTENT_BROKER_SOCKET_PATH')) {
    return env.INTENT_BROKER_SOCKET_PATH || null;
  }

  return platform === 'win32' ? null : SOCKET_PATH;
}

function asBrokerParticipantRegistration(config) {
  return {
    participantId: config.participantId,
    kind: 'agent',
    roles: config.roles,
    capabilities: config.capabilities,
    alias: config.alias,
    context: config.context || {},
    metadata: config.metadata || {},
    inboxMode: config.inboxMode ?? 'pull'
  };
}

const defineOwned = Object.defineProperty;
const callInventory = Symbol('original-broker-app-calls');
function exposeOriginalCalls(promise, calls) {
  defineOwned(promise, callInventory, { value: calls });
  return promise;
}
// Expose the original SDK raw calls to the existing outer custody, without a
// second walker/owner/provider. Append-only own slots cannot be erased by users.
export function startBrokerApp(options) {
  const calls = [];
  return exposeOriginalCalls(startOwnedBrokerApp(options, calls), calls);
}
async function startOwnedBrokerApp({
  cwd = process.cwd(),
  env = process.env,
  logger = console,
  loadConfig = loadIntentBrokerConfig,
  createBroker = createBrokerService,
  createHttpServer = createServer,
  createChannelsRuntime = createManagedChannelsRuntime,
  createCodexResumeDiscoveryRuntime = createCodexResumeDiscoveryRuntimeDefault,
  syncAgentBridges = syncAgentBridgesDefault,
  refreshPersistedAgentSessions = refreshPersistedAgentSessionsDefault,
  persistedSessionRefreshIntervalMs = Number(
    env.INTENT_BROKER_PERSISTED_SESSION_REFRESH_INTERVAL_MS || 5000
  ),
  socketPath = resolveDefaultSocketPath({ env })
} = {}, originalCalls) {
  const record = raw => {
    if (raw !== undefined) defineOwned(originalCalls, String(originalCalls.length), { value: raw, enumerable: true });
    return raw;
  };
  let broker, server, socketServer, channels, codexResumeDiscovery, relay;
  let persistedSessionRefreshTimer, closeState;
  // This remains the original app's one resource owner, including partial birth.
  function closeAll() {
    if (closeState) return closeState.promise;
    let accept, reject;
    const promise = new Promise((yes, no) => { accept = yes; reject = no; });
    exposeOriginalCalls(promise, originalCalls);
    closeState = { promise }; // Publish before any negative SDK may reenter.
    const close = async () => {
      const failures = [];
      const attempt = async work => { try { await record(work()); } catch (raw) { record(raw); failures.push(raw); } };
      if (persistedSessionRefreshTimer) {
        await attempt(() => clearInterval(persistedSessionRefreshTimer));
        persistedSessionRefreshTimer = null;
      }
      if (relay) await attempt(() => relay.stop());
      if (codexResumeDiscovery) await attempt(() => codexResumeDiscovery.stop?.());
      if (channels) await attempt(() => channels.stopAll());
      if (broker) await attempt(() => broker.close?.());
      if (socketServer) {
        await attempt(() => new Promise((yes, no) => socketServer.close(raw => raw ? no(raw) : yes())));
        await attempt(() => { if (socketPath && existsSync(socketPath)) unlinkSync(socketPath); });
      }
      if (server) await attempt(() => server.close());
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'broker_app_close_failed', { cause: failures[0] });
    };
    close().then(accept, reject);
    return promise;
  }
  try {
  const repoRoot = env.INTENT_BROKER_REPO_ROOT || MODULE_CODE_ROOT;
  const config = loadConfig({ cwd, env });
  const dbPath = resolve(cwd, config.server.dbPath);

  // Managed diagnostic paths never select or create files for the Native DB.
  if (!readBrokerProtectedSQLiteResource()?.namespace) mkdirSync(dirname(dbPath), { recursive: true });

  await record(syncAgentBridges({
    repoRoot,
    cwd,
    logger
  }));

  const enableEscalation = env.ENABLE_HUMAN_ESCALATION !== '0';
  broker = createBroker({ dbPath, onTaskUnacked: enableEscalation ? createHumanEscalation() : null });
  const channelHealth = createChannelHealthRegistry();
  server = createHttpServer({
    broker,
    roomService: broker.room,
    roomDesktopToken: env.INTENT_BROKER_DESKTOP_TOKEN,
    roomKSwarmToken: env.INTENT_BROKER_KSWARM_TOKEN,
    healthProvider: () => {
      const summary = channelHealth.summarize();
      return {
        ok: true,
        service: activityServiceIdentity(),
        status: summary.degraded ? 'degraded' : 'healthy',
        degraded: summary.degraded,
        reasons: summary.reasons,
        channels: summary.channels,
        updatedAt: new Date().toISOString()
      };
    }
  });

  await record(server.listen(config.server.port, config.server.host));
  broker.attachWebSocket(server.raw());

  if (socketPath) {
    mkdirSync(dirname(socketPath), { recursive: true });
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
    socketServer = net.createServer((conn) => {
      server.raw().emit('connection', conn);
    });
    await new Promise((yes, no) => {
      const failed = raw => { socketServer.removeListener('listening', ready); no(raw); };
      const ready = () => { socketServer.removeListener('error', failed); yes(); };
      socketServer.once('error', failed);
      socketServer.once('listening', ready);
      socketServer.listen(socketPath);
    });
  }

  const brokerUrl = `http://${config.server.host}:${server.address().port}`;
  const registerParticipantLocally = async (participantConfig) =>
    broker.registerParticipant(asBrokerParticipantRegistration(participantConfig));
  const refreshSessions = (refreshLogger = logger) => refreshPersistedAgentSessions({
    repoRoot: cwd,
    brokerUrl,
    env,
    logger: refreshLogger,
    registerParticipant: registerParticipantLocally
  });
  await record(refreshSessions());
  channels = createChannelsRuntime({
    brokerUrl,
    channels: config.channels
  });
  codexResumeDiscovery = createCodexResumeDiscoveryRuntime({
    brokerUrl,
    repoRoot,
    fallbackCwd: cwd,
    env,
    logger
  });

  await record(channels.startAll());
  await record(codexResumeDiscovery.start());

  if (config.relay?.enabled && config.relay?.url && config.relay?.roomSecret) {
    const brokerId = config.relay.brokerId || randomUUID();
    relay = createRelayAdapter({
      brokerService: broker,
      relayConfig: { ...config.relay, brokerVersion: '0.3.7' },
      brokerId,
      logger,
    });
    record(record(relay.start()).catch((err) => {
      logger.warn?.(`[relay-adapter] start failed: ${err.message}`);
    }));
    logger.log(`intent-broker relay: connecting to ${config.relay.url}`);
  }

  persistedSessionRefreshTimer = persistedSessionRefreshIntervalMs > 0
    ? setInterval(() => {
      void refreshSessions({ warn: logger?.warn?.bind?.(logger) }).catch((error) => {
        logger?.warn?.(
          `intent-broker persisted session refresh timer: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }, persistedSessionRefreshIntervalMs)
    : null;
  persistedSessionRefreshTimer?.unref?.();

  logger.log(`intent-broker listening on ${brokerUrl}`);
  logger.log(`intent-broker WebSocket: ws://${config.server.host}:${server.address().port}/ws`);
  if (socketPath) {
    logger.log(`intent-broker socket: ${socketPath}`);
  }
  logger.log(`intent-broker db: ${dbPath}`);
  logger.log(`intent-broker config: ${config.configPath}`);
  logger.log(`intent-broker local config: ${config.localConfigPath}`);

  const managedChannels = channels.describe();
  if (managedChannels.length) {
    logger.log(`intent-broker managed channels: ${managedChannels.map((item) => `${item.name}=${item.enabled ? 'enabled' : 'disabled'}`).join(', ')}`);
  }

  return {
    broker,
    server,
    channels,
    config,
    close: closeAll
  };
  } catch (raw) {
    try { await closeAll(); }
    catch (cleanup) { throw new AggregateError([raw, cleanup], 'broker_app_startup_cleanup_failed', { cause: raw }); }
    throw raw;
  }
}
