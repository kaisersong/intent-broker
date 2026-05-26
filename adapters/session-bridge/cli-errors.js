import { isBrokerUnavailableError } from './api.js';

export function formatCliError(error) {
  if (isBrokerUnavailableError(error)) {
    const fetchCode = error.fetchCause?.cause?.code;
    const curlCode = error.curlCause?.code;
    if (fetchCode === 'EPERM') {
      const fallback = curlCode
        ? ` The curl fallback also failed with exit code ${curlCode}.`
        : '';
      return [
        `Intent Broker could not be reached from this process at ${error.brokerUrl}.`,
        `Node fetch was blocked by the local execution sandbox (EPERM).${fallback}`,
        `Verify the broker with: curl -sS ${error.brokerUrl}/health`,
        'Run the broker command outside the sandbox, or allow this command prefix for the current agent session.'
      ].join('\n');
    }

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
