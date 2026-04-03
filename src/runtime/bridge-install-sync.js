import os from 'node:os';

import { ensureClaudeCodeInstall } from '../../adapters/claude-code-plugin/install.js';
import { ensureCodexInstall } from '../../adapters/codex-plugin/install.js';

function log(logger, level, message) {
  const fn = logger?.[level];
  if (typeof fn === 'function') {
    fn.call(logger, message);
    return;
  }

  if (typeof logger?.log === 'function') {
    logger.log(message);
  }
}

export async function syncAgentBridges({
  repoRoot = process.cwd(),
  homeDir = os.homedir(),
  logger = console
} = {}) {
  const runners = [
    {
      name: 'codex',
      run: () => ensureCodexInstall({ repoRoot, homeDir })
    },
    {
      name: 'claude-code',
      run: () => ensureClaudeCodeInstall({ cwd: repoRoot, homeDir })
    }
  ];

  const results = [];

  for (const runner of runners) {
    try {
      const result = await runner.run();
      results.push({ name: runner.name, ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name: runner.name, ok: false, error: message });
      log(logger, 'warn', `intent-broker bridge sync: ${runner.name}=failed (${message})`);
    }
  }

  const summary = results
    .map((item) => {
      if (!item.ok) {
        return `${item.name}=failed`;
      }
      return `${item.name}=${item.changed ? 'updated' : 'ok'}`;
    })
    .join(', ');

  log(logger, 'log', `intent-broker bridge sync: ${summary}`);

  return results;
}
