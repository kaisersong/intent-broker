import { spawn } from 'node:child_process';

function parseLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function safeBranchComponent(value) {
  const normalized = String(value || 'user')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'user';
}

function normalizeRemoteBranchRef(ref) {
  return String(ref || '').replace(/^refs\/heads\//, '');
}

function buildWipResult({ userId, timestamp, remote, wipCommitSha, filesModified }) {
  const userComponent = safeBranchComponent(userId);
  const wipBranch = `wip/sync-${userComponent}-${timestamp}`;
  const latestRef = `wip/sync-${userComponent}-latest`;
  return {
    wipBranch,
    latestRef,
    wipCommitSha,
    wipRemote: remote,
    filesModified,
  };
}

function parseLsRemote(stdout) {
  return parseLines(stdout).map((line) => {
    const [sha, ref] = line.split(/\s+/);
    return { sha, ref };
  }).filter((item) => item.sha && item.ref);
}

async function readRemoteRefSha({ cwd, remote, ref, runner }) {
  const normalized = normalizeRemoteBranchRef(ref);
  const result = await runner(['ls-remote', remote, `refs/heads/${normalized}`], { cwd });
  const parsed = parseLsRemote(result.stdout)[0];
  return parsed?.sha ?? null;
}

export function runGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(stderr.trim() || `git exited with ${code}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

export async function collectGitContext({ cwd = process.cwd(), runner = runGit } = {}) {
  const [branch, head, modified, pending] = await Promise.all([
    runner(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
    runner(['rev-parse', 'HEAD'], { cwd }),
    runner(['diff', '--name-only', 'HEAD', '--'], { cwd }),
    runner(['ls-files', '--others', '--exclude-standard'], { cwd }),
  ]);

  return {
    branch: branch.stdout.trim(),
    gitHead: head.stdout.trim(),
    filesModified: parseLines(modified.stdout),
    filesPending: parseLines(pending.stdout),
  };
}

export async function createAndPushWipCommit({
  cwd = process.cwd(),
  userId,
  timestamp = Date.now(),
  remote = 'origin',
  runner = runGit,
} = {}) {
  const modified = await runner(['diff', '--name-only', 'HEAD', '--'], { cwd });
  const filesModified = parseLines(modified.stdout);
  if (filesModified.length === 0) {
    return null;
  }

  const stash = await runner(['stash', 'create'], { cwd });
  const wipCommitSha = stash.stdout.trim();
  if (!wipCommitSha) {
    return null;
  }

  const wip = buildWipResult({ userId, timestamp, remote, wipCommitSha, filesModified });

  await runner(['push', remote, `${wipCommitSha}:refs/heads/${wip.wipBranch}`], { cwd });
  try {
    await runner(['push', remote, `${wipCommitSha}:refs/heads/${wip.latestRef}`], { cwd });
  } catch (error) {
    error.partialWip = {
      ...wip,
      failedRef: wip.latestRef,
    };
    throw error;
  }

  return wip;
}

export async function fetchAndVerifyWipCommit({
  cwd = process.cwd(),
  remote = 'origin',
  wipBranch = null,
  latestRef = null,
  wipCommitSha,
  runner = runGit,
} = {}) {
  const ref = wipBranch ?? latestRef;
  if (!ref) throw new Error('wip_ref_required');
  if (!wipCommitSha) throw new Error('wip_commit_sha_required');

  const fetchedRef = normalizeRemoteBranchRef(ref);
  await runner(['fetch', remote, `refs/heads/${fetchedRef}`], { cwd });
  const fetched = await runner(['rev-parse', 'FETCH_HEAD'], { cwd });
  const fetchedSha = fetched.stdout.trim();
  if (fetchedSha.toLowerCase() !== String(wipCommitSha).toLowerCase()) {
    throw new Error('wip_commit_sha_mismatch');
  }

  return {
    wipVerified: true,
    wipCommitSha: fetchedSha,
    fetchedRef,
  };
}

export async function discoverLatestWipRefs({
  cwd = process.cwd(),
  remote = 'origin',
  userId,
  runner = runGit,
  limit = 3,
} = {}) {
  const userComponent = safeBranchComponent(userId);
  const latestRef = `refs/heads/wip/sync-${userComponent}-latest`;
  const timestampPattern = `refs/heads/wip/sync-${userComponent}-*`;
  const [latestResult, alternativesResult] = await Promise.all([
    runner(['ls-remote', remote, latestRef], { cwd }),
    runner(['ls-remote', remote, timestampPattern], { cwd }),
  ]);
  const latest = parseLsRemote(latestResult.stdout)[0] ?? null;
  const alternatives = parseLsRemote(alternativesResult.stdout)
    .filter((item) => item.ref !== latestRef)
    .sort((a, b) => b.ref.localeCompare(a.ref))
    .slice(0, limit);

  return { latest, alternatives };
}

export async function cleanupRemoteWipRefs({
  cwd = process.cwd(),
  remote = 'origin',
  refs = [],
  expectedSha,
  runner = runGit,
} = {}) {
  if (!expectedSha) throw new Error('cleanup_expected_sha_required');
  const deletedRefs = [];
  const skippedRefs = [];
  const errors = [];

  for (const ref of refs.filter(Boolean)) {
    const normalized = normalizeRemoteBranchRef(ref);
    try {
      const actualSha = await readRemoteRefSha({ cwd, remote, ref: normalized, runner });
      if (!actualSha) {
        skippedRefs.push({ ref: normalized, reason: 'missing' });
        continue;
      }
      if (actualSha.toLowerCase() !== String(expectedSha).toLowerCase()) {
        skippedRefs.push({ ref: normalized, reason: 'sha_mismatch', actualSha });
        continue;
      }
      await runner(['push', remote, `:refs/heads/${normalized}`], { cwd });
      deletedRefs.push(normalized);
    } catch (error) {
      errors.push({ ref: normalized, error: error.message });
    }
  }

  return { deletedRefs, skippedRefs, errors };
}

export async function createIsolatedBranch({
  cwd = process.cwd(),
  syncId,
  wipCommitSha,
  runner = runGit,
} = {}) {
  if (!syncId) throw new Error('sync_id_required');
  if (!wipCommitSha) throw new Error('wip_commit_sha_required');
  const branchName = `context-sync/${safeBranchComponent(syncId)}`;
  await runner(['branch', branchName, wipCommitSha], { cwd });
  return { branchName, wipCommitSha };
}

export async function applyVerifiedWipCommit({
  cwd = process.cwd(),
  wipCommitSha,
  filesModified = [],
  governanceCheck,
  runner = runGit,
  strategy = 'cherry-pick',
  expectedBaseHead = null,
} = {}) {
  if (!wipCommitSha) throw new Error('wip_commit_sha_required');
  const status = await runner(['status', '--porcelain'], { cwd });
  if (parseLines(status.stdout).length > 0) {
    throw new Error('worktree_dirty');
  }
  if (typeof governanceCheck !== 'function') {
    throw new Error('governance_check_required');
  }
  if (expectedBaseHead) {
    const currentHead = await runner(['rev-parse', 'HEAD'], { cwd });
    if (currentHead.stdout.trim().toLowerCase() !== String(expectedBaseHead).toLowerCase()) {
      throw new Error('sender_receiver_head_diverged');
    }
  }
  const governance = await governanceCheck({ files: filesModified, wipCommitSha });
  if (governance && governance.ok === false) {
    throw new Error('governance_check_failed');
  }

  if (strategy !== 'cherry-pick') {
    throw new Error('apply_strategy_unsupported');
  }
  await runner(['cherry-pick', wipCommitSha], { cwd });
  return { applied: true, strategy };
}
