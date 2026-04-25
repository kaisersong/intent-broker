import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_STALE_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readLockOwnerPid(lockPath) {
  try {
    return normalizePid(JSON.parse(readFileSync(lockPath, 'utf8'))?.pid);
  } catch {
    return null;
  }
}

export function isLockFileStale(
  lockPath,
  {
    nowMs = Date.now(),
    staleMs = DEFAULT_STALE_MS,
    isProcessAlive = () => false
  } = {}
) {
  try {
    const ageMs = nowMs - statSync(lockPath).mtimeMs;
    if (ageMs < staleMs) {
      return false;
    }

    const ownerPid = readLockOwnerPid(lockPath);
    return !ownerPid || !isProcessAlive(ownerPid);
  } catch {
    return false;
  }
}

export async function acquireInterprocessLock(
  lockPath,
  {
    waitMs = DEFAULT_WAIT_MS,
    pollMs = DEFAULT_POLL_MS,
    staleMs = DEFAULT_STALE_MS,
    sleepImpl = sleep,
    isProcessAlive = () => false
  } = {}
) {
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString()
        }, null, 2),
        { flag: 'wx' }
      );

      return () => {
        rmSync(lockPath, { force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
    }

    if (isLockFileStale(lockPath, { staleMs, isProcessAlive })) {
      rmSync(lockPath, { force: true });
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(`timeout waiting for lock ${lockPath}`);
    }

    await sleepImpl(pollMs);
  }
}
