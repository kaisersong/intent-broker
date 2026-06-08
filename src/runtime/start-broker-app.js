import { mkdirSync, unlinkSync, existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
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

export async function startBrokerApp({
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
} = {}) {
  const config = loadConfig({ cwd, env });
  const dbPath = resolve(cwd, config.server.dbPath);

  mkdirSync(dirname(dbPath), { recursive: true });

  await syncAgentBridges({
    repoRoot: cwd,
    logger
  });

  const enableEscalation = process.env.ENABLE_HUMAN_ESCALATION !== '0';
  const broker = createBroker({ dbPath, onTaskUnacked: enableEscalation ? createHumanEscalation() : null });
  const channelHealth = createChannelHealthRegistry();
  const server = createHttpServer({
    broker,
    healthProvider: () => {
      const summary = channelHealth.summarize();
      return {
        ok: true,
        status: summary.degraded ? 'degraded' : 'healthy',
        degraded: summary.degraded,
        reasons: summary.reasons,
        channels: summary.channels,
        updatedAt: new Date().toISOString()
      };
    }
  });

  await server.listen(config.server.port, config.server.host);
  broker.attachWebSocket(server.raw());

  let socketServer = null;
  if (socketPath) {
    mkdirSync(dirname(socketPath), { recursive: true });
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
    socketServer = net.createServer((conn) => {
      server.raw().emit('connection', conn);
    });
    await new Promise((res) => socketServer.listen(socketPath, res));
  }

  const brokerUrl = `http://${config.server.host}:${server.address().port}`;
  const registerParticipantLocally = async (participantConfig) =>
    broker.registerParticipant(asBrokerParticipantRegistration(participantConfig));
  await refreshPersistedAgentSessions({
    repoRoot: cwd,
    brokerUrl,
    env,
    logger,
    registerParticipant: registerParticipantLocally
  });
  const channels = createChannelsRuntime({
    brokerUrl,
    channels: config.channels
  });
  const codexResumeDiscovery = createCodexResumeDiscoveryRuntime({
    brokerUrl,
    repoRoot: cwd,
    env,
    logger
  });

  let relay = null;

  try {
    await channels.startAll();
    await codexResumeDiscovery.start();
  } catch (error) {
    await codexResumeDiscovery.stop?.();
    await server.close();
    broker.close?.();
    throw error;
  }

  if (config.relay?.enabled && config.relay?.url && config.relay?.roomSecret) {
    const brokerId = config.relay.brokerId || randomUUID();
    relay = createRelayAdapter({
      brokerService: broker,
      relayConfig: { ...config.relay, brokerVersion: '0.3.7' },
      brokerId,
      logger,
    });
    relay.start().catch((err) => {
      logger.warn?.(`[relay-adapter] start failed: ${err.message}`);
    });
    logger.log(`intent-broker relay: connecting to ${config.relay.url}`);
  }

  const persistedSessionRefreshTimer = persistedSessionRefreshIntervalMs > 0
    ? setInterval(() => {
      void refreshPersistedAgentSessions({
        repoRoot: cwd,
        brokerUrl,
        env,
        logger: { warn: logger?.warn?.bind?.(logger) },
        registerParticipant: registerParticipantLocally
      }).catch((error) => {
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
    async close() {
      if (persistedSessionRefreshTimer) {
        clearInterval(persistedSessionRefreshTimer);
      }
      await relay?.stop();
      await codexResumeDiscovery.stop?.();
      await channels.stopAll();
      broker.close?.();
      if (socketServer) {
        await new Promise((res) => socketServer.close(res));
        if (socketPath && existsSync(socketPath)) {
          unlinkSync(socketPath);
        }
      }
      await server.close();
    }
  };
}
