import { startBrokerApp } from './runtime/start-broker-app.js';

const app = await startBrokerApp();

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    await app.close();
  } finally {
    process.exit(signal ? 0 : 1);
  }
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
