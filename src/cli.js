import { startBrokerApp } from './runtime/start-broker-app.js';
import {
  resolveBrokerRuntimePaths,
  saveBrokerHeartbeat
} from './runtime/broker-runtime-state.js';

let shuttingDown = false;
let app = null;
let heartbeatTimer = null;

const runtimePaths = resolveBrokerRuntimePaths();
const heartbeatState = {
  pid: process.pid,
  status: 'starting',
  startedAt: new Date().toISOString(),
  readyAt: null,
  updatedAt: new Date().toISOString(),
  exitAt: null,
  signal: null,
  error: null
};

function serializeError(error) {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || null
    };
  }

  return {
    name: 'Error',
    message: String(error),
    stack: null
  };
}

function persistHeartbeat(overrides = {}) {
  const guarded = overrides.status && overrides.status !== 'starting';
  const nextState = {
    ...heartbeatState,
    ...overrides,
    updatedAt: new Date().toISOString()
  };
  const saved = saveBrokerHeartbeat(
    runtimePaths.heartbeat,
    nextState,
    guarded ? { onlyIfOwnedByPid: process.pid } : {}
  );
  if (saved) {
    Object.assign(heartbeatState, nextState);
  }
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  try {
    await app?.close?.();
  } finally {
    persistHeartbeat({
      status: signal ? 'stopped' : 'failed',
      signal: signal || null,
      exitAt: new Date().toISOString()
    });
    process.exit(signal ? 0 : 1);
  }
}

process.on('uncaughtException', (error) => {
  console.error(error);
  persistHeartbeat({
    status: 'crashed',
    error: serializeError(error),
    exitAt: new Date().toISOString()
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(reason);
  persistHeartbeat({
    status: 'crashed',
    error: serializeError(reason),
    exitAt: new Date().toISOString()
  });
  process.exit(1);
});

process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

persistHeartbeat();

try {
  app = await startBrokerApp();
  const readyAt = new Date().toISOString();
  persistHeartbeat({
    status: 'running',
    readyAt,
    error: null
  });
  heartbeatTimer = setInterval(() => {
    persistHeartbeat({ status: 'running' });
  }, 5000);
  heartbeatTimer.unref?.();
} catch (error) {
  persistHeartbeat({
    status: 'failed-to-start',
    error: serializeError(error),
    exitAt: new Date().toISOString()
  });
  throw error;
}
