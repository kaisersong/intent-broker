import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createBrokerService } from '../broker/service.js';
import { createServer } from '../http/server.js';
import { loadIntentBrokerConfig } from '../config/load-config.js';
import { syncAgentBridges as syncAgentBridgesDefault } from './bridge-install-sync.js';
import { createManagedChannelsRuntime } from './managed-channels.js';

export async function startBrokerApp({
  cwd = process.cwd(),
  env = process.env,
  logger = console,
  loadConfig = loadIntentBrokerConfig,
  createBroker = createBrokerService,
  createHttpServer = createServer,
  createChannelsRuntime = createManagedChannelsRuntime,
  syncAgentBridges = syncAgentBridgesDefault
} = {}) {
  const config = loadConfig({ cwd, env });
  const dbPath = resolve(cwd, config.server.dbPath);

  mkdirSync(dirname(dbPath), { recursive: true });

  await syncAgentBridges({
    repoRoot: cwd,
    logger
  });

  const broker = createBroker({ dbPath });
  const server = createHttpServer({ broker });

  await server.listen(config.server.port, config.server.host);
  broker.attachWebSocket(server.raw());

  const brokerUrl = `http://${config.server.host}:${server.address().port}`;
  const channels = createChannelsRuntime({
    brokerUrl,
    channels: config.channels
  });

  try {
    await channels.startAll();
  } catch (error) {
    await server.close();
    broker.close?.();
    throw error;
  }

  logger.log(`intent-broker listening on ${brokerUrl}`);
  logger.log(`intent-broker WebSocket: ws://${config.server.host}:${server.address().port}/ws`);
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
      await channels.stopAll();
      broker.close?.();
      await server.close();
    }
  };
}
