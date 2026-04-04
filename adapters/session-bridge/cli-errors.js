import { isBrokerUnavailableError } from './api.js';

export function formatCliError(error) {
  if (isBrokerUnavailableError(error)) {
    return `Intent Broker is unavailable at ${error.brokerUrl}. Start it with "npm start" and retry.`;
  }

  return error?.stack || error?.message || String(error);
}

export async function runCliMain(main, { err = console.error, exit = process.exit } = {}) {
  try {
    await main();
  } catch (error) {
    err(formatCliError(error));
    exit(1);
  }
}
