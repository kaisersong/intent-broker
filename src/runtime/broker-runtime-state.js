import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TERMINAL_HEARTBEAT_STATUSES = new Set([
  'stopped',
  'crashed',
  'failed',
  'failed-to-start'
]);

export function isTerminalBrokerHeartbeatStatus(status) {
  return TERMINAL_HEARTBEAT_STATUSES.has(String(status || ''));
}

export function resolveBrokerRuntimePaths({
  cwd = process.cwd(),
  env = process.env
} = {}) {
  const runtimeRoot = path.join(cwd, '.tmp');

  return {
    stdout: path.join(runtimeRoot, 'broker.stdout.log'),
    stderr: path.join(runtimeRoot, 'broker.stderr.log'),
    heartbeat: env.INTENT_BROKER_HEARTBEAT_PATH || path.join(runtimeRoot, 'broker.heartbeat.json')
  };
}

export function loadBrokerHeartbeat(heartbeatPath) {
  try {
    return JSON.parse(readFileSync(heartbeatPath, 'utf8'));
  } catch {
    return null;
  }
}

export function saveBrokerHeartbeat(
  heartbeatPath,
  state,
  {
    onlyIfOwnedByPid = null,
    allowIfMissing = false,
    allowIfTerminal = false
  } = {}
) {
  if (onlyIfOwnedByPid !== null) {
    const current = loadBrokerHeartbeat(heartbeatPath);
    const canClaimMissing = !current && allowIfMissing;
    const canClaimTerminal = current
      && allowIfTerminal
      && isTerminalBrokerHeartbeatStatus(current.status);
    if (current?.pid !== onlyIfOwnedByPid && !canClaimMissing && !canClaimTerminal) {
      return false;
    }
  }

  mkdirSync(path.dirname(heartbeatPath), { recursive: true });
  writeFileSync(heartbeatPath, JSON.stringify(state, null, 2) + '\n');
  return true;
}
