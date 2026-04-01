import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG_FILENAME = 'intent-broker.config.json';
const DEFAULT_LOCAL_CONFIG_FILENAME = 'intent-broker.local.json';

function readJsonConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function mergeConfig(baseConfig = {}, overrideConfig = {}) {
  return {
    ...baseConfig,
    ...overrideConfig,
    server: {
      ...(baseConfig.server || {}),
      ...(overrideConfig.server || {})
    },
    channels: {
      ...(baseConfig.channels || {}),
      ...(overrideConfig.channels || {})
    }
  };
}

function resolveYunzhijiaConfig(config = {}, env = {}) {
  if (!config || typeof config !== 'object') {
    return undefined;
  }

  const sendUrl = config.sendUrl || (config.sendUrlEnv ? env[config.sendUrlEnv] : undefined);

  return {
    enabled: Boolean(config.enabled),
    sendUrlEnv: config.sendUrlEnv,
    sendUrl
  };
}

export function loadIntentBrokerConfig({
  cwd = process.cwd(),
  env = process.env,
  configPath = env.INTENT_BROKER_CONFIG || DEFAULT_CONFIG_FILENAME,
  localConfigPath = env.INTENT_BROKER_LOCAL_CONFIG || DEFAULT_LOCAL_CONFIG_FILENAME
} = {}) {
  const resolvedConfigPath = path.resolve(cwd, configPath);
  const resolvedLocalConfigPath = path.resolve(cwd, localConfigPath);
  const fileConfig = mergeConfig(
    readJsonConfig(resolvedConfigPath),
    readJsonConfig(resolvedLocalConfigPath)
  );

  const server = fileConfig.server || {};
  const channels = fileConfig.channels || {};

  return {
    configPath: resolvedConfigPath,
    localConfigPath: resolvedLocalConfigPath,
    server: {
      host: server.host || '127.0.0.1',
      port: Number(env.PORT || server.port || '4318'),
      dbPath: env.INTENT_BROKER_DB || server.dbPath || './.tmp/intent-broker.db'
    },
    channels: {
      ...(channels.yunzhijia ? { yunzhijia: resolveYunzhijiaConfig(channels.yunzhijia, env) } : {})
    }
  };
}
