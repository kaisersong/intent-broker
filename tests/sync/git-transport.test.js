import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyVerifiedWipCommit,
  cleanupRemoteWipRefs,
  collectGitContext,
  createAndPushWipCommit,
  createIsolatedBranch,
  discoverLatestWipRefs,
  fetchAndVerifyWipCommit,
} from '../../src/sync/git-transport.js';

function fakeRunner(handlers, calls = []) {
  return async (args, options) => {
    calls.push({ args, options });
    const key = args.join(' ');
    if (!Object.hasOwn(handlers, key)) {
      throw new Error(`unexpected git command:${key}`);
    }
    const value = handlers[key];
    if (value instanceof Error) {
      throw value;
    }
    return { stdout: value, stderr: '' };
  };
}

test('collectGitContext lists branch, head, tracked dirty files, and untracked pending files', async () => {
  const calls = [];
  const runner = fakeRunner({
    'rev-parse --abbrev-ref HEAD': 'feature/context-sync\n',
    'rev-parse HEAD': 'abc123\n',
    'diff --name-only HEAD --': 'src/broker/service.js\nsrc/store/schema.js\n',
    'ls-files --others --exclude-standard': 'scratch.md\n',
  }, calls);

  const context = await collectGitContext({ cwd: '/repo', runner });

  assert.deepEqual(context, {
    branch: 'feature/context-sync',
    gitHead: 'abc123',
    filesModified: ['src/broker/service.js', 'src/store/schema.js'],
    filesPending: ['scratch.md'],
  });
  assert.deepEqual(calls.map((call) => call.args), [
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    ['rev-parse', 'HEAD'],
    ['diff', '--name-only', 'HEAD', '--'],
    ['ls-files', '--others', '--exclude-standard'],
  ]);
});

test('createAndPushWipCommit pushes exact stash commit to timestamped and latest refs', async () => {
  const calls = [];
  const runner = fakeRunner({
    'diff --name-only HEAD --': 'src/broker/service.js\n',
    'stash create': 'def456\n',
    'push origin def456:refs/heads/wip/sync-songkai-1770000000000': '',
    'push origin +def456:refs/heads/wip/sync-songkai-latest': '',
  }, calls);

  const result = await createAndPushWipCommit({
    cwd: '/repo',
    userId: 'songkai',
    timestamp: 1770000000000,
    runner,
  });

  assert.deepEqual(result, {
    wipBranch: 'wip/sync-songkai-1770000000000',
    latestRef: 'wip/sync-songkai-latest',
    wipCommitSha: 'def456',
    wipRemote: 'origin',
    filesModified: ['src/broker/service.js'],
  });
  assert.deepEqual(calls.map((call) => call.args), [
    ['diff', '--name-only', 'HEAD', '--'],
    ['stash', 'create'],
    ['push', 'origin', 'def456:refs/heads/wip/sync-songkai-1770000000000'],
    ['push', 'origin', '+def456:refs/heads/wip/sync-songkai-latest'],
  ]);
});

test('createAndPushWipCommit returns null when there are no tracked dirty files', async () => {
  const calls = [];
  const runner = fakeRunner({
    'diff --name-only HEAD --': '',
  }, calls);

  const result = await createAndPushWipCommit({
    cwd: '/repo',
    userId: 'songkai',
    timestamp: 1770000000000,
    runner,
  });

  assert.equal(result, null);
  assert.deepEqual(calls.map((call) => call.args), [
    ['diff', '--name-only', 'HEAD', '--'],
  ]);
});

test('fetchAndVerifyWipCommit fetches the WIP branch and verifies exact SHA', async () => {
  const calls = [];
  const runner = fakeRunner({
    'fetch origin refs/heads/wip/sync-songkai-1770000000000': '',
    'rev-parse FETCH_HEAD': 'def456\n',
  }, calls);

  const result = await fetchAndVerifyWipCommit({
    cwd: '/repo',
    wipBranch: 'wip/sync-songkai-1770000000000',
    wipCommitSha: 'def456',
    runner,
  });

  assert.deepEqual(result, {
    wipVerified: true,
    wipCommitSha: 'def456',
    fetchedRef: 'wip/sync-songkai-1770000000000',
  });
});

test('fetchAndVerifyWipCommit rejects mismatched fetched SHA', async () => {
  const runner = fakeRunner({
    'fetch origin refs/heads/wip/sync-songkai-1770000000000': '',
    'rev-parse FETCH_HEAD': 'abc999\n',
  });

  await assert.rejects(
    () => fetchAndVerifyWipCommit({
      cwd: '/repo',
      wipBranch: 'wip/sync-songkai-1770000000000',
      wipCommitSha: 'def456',
      runner,
    }),
    /wip_commit_sha_mismatch/
  );
});

test('discoverLatestWipRefs prefers latest ref and limits timestamped alternatives', async () => {
  const runner = fakeRunner({
    'ls-remote origin refs/heads/wip/sync-songkai-latest': 'def456\trefs/heads/wip/sync-songkai-latest\n',
    'ls-remote origin refs/heads/wip/sync-songkai-*': [
      'aaa111\trefs/heads/wip/sync-songkai-1770000000000',
      'bbb222\trefs/heads/wip/sync-songkai-1770000001000',
      'ccc333\trefs/heads/wip/sync-songkai-1770000002000',
      'ddd444\trefs/heads/wip/sync-songkai-1770000003000',
    ].join('\n'),
  });

  const result = await discoverLatestWipRefs({
    cwd: '/repo',
    userId: 'songkai',
    runner,
  });

  assert.deepEqual(result.latest, {
    sha: 'def456',
    ref: 'refs/heads/wip/sync-songkai-latest',
  });
  assert.deepEqual(result.alternatives.map((item) => item.sha), ['ddd444', 'ccc333', 'bbb222']);
});

test('createIsolatedBranch creates a context-sync branch at the verified commit', async () => {
  const calls = [];
  const runner = fakeRunner({
    'branch context-sync/sync-songkai-1770000000000 def456': '',
  }, calls);

  const result = await createIsolatedBranch({
    cwd: '/repo',
    syncId: 'sync-songkai-1770000000000',
    wipCommitSha: 'def456',
    runner,
  });

  assert.deepEqual(result, {
    branchName: 'context-sync/sync-songkai-1770000000000',
    wipCommitSha: 'def456',
  });
});

test('applyVerifiedWipCommit refuses dirty receiver worktrees before governance', async () => {
  let governanceCalled = false;
  const runner = fakeRunner({
    'status --porcelain': ' M src/broker/service.js\n',
  });

  await assert.rejects(
    () => applyVerifiedWipCommit({
      cwd: '/repo',
      wipCommitSha: 'def456',
      filesModified: ['src/broker/service.js'],
      governanceCheck: async () => {
        governanceCalled = true;
      },
      runner,
    }),
    /worktree_dirty/
  );
  assert.equal(governanceCalled, false);
});

test('applyVerifiedWipCommit runs governance before cherry-pick on a clean worktree', async () => {
  const calls = [];
  const governanceCalls = [];
  const runner = fakeRunner({
    'status --porcelain': '',
    'rev-parse HEAD': 'base123\n',
    'cherry-pick def456': '',
  }, calls);

  const result = await applyVerifiedWipCommit({
    cwd: '/repo',
    wipCommitSha: 'def456',
    filesModified: ['src/broker/service.js'],
    expectedBaseHead: 'base123',
    governanceCheck: async (input) => {
      governanceCalls.push(input);
      return { ok: true };
    },
    runner,
  });

  assert.deepEqual(result, { applied: true, strategy: 'cherry-pick' });
  assert.deepEqual(governanceCalls, [{
    files: ['src/broker/service.js'],
    wipCommitSha: 'def456',
  }]);
  assert.deepEqual(calls.map((call) => call.args), [
    ['status', '--porcelain'],
    ['rev-parse', 'HEAD'],
    ['cherry-pick', 'def456'],
  ]);
});

test('createAndPushWipCommit exposes partial WIP when latest ref push fails', async () => {
  const latestError = new Error('latest rejected');
  const runner = fakeRunner({
    'diff --name-only HEAD --': 'README.md\n',
    'stash create': 'def456\n',
    'push origin def456:refs/heads/wip/sync-songkai-1770000000000': '',
    'push origin +def456:refs/heads/wip/sync-songkai-latest': latestError,
  });

  await assert.rejects(
    () => createAndPushWipCommit({
      cwd: '/repo',
      userId: 'songkai',
      timestamp: 1770000000000,
      runner,
    }),
    (error) => {
      assert.equal(error.message, 'latest rejected');
      assert.deepEqual(error.partialWip, {
        wipBranch: 'wip/sync-songkai-1770000000000',
        latestRef: 'wip/sync-songkai-latest',
        wipCommitSha: 'def456',
        wipRemote: 'origin',
        filesModified: ['README.md'],
        failedRef: 'wip/sync-songkai-latest',
      });
      return true;
    }
  );
});

test('cleanupRemoteWipRefs deletes only refs still pointing at the expected SHA', async () => {
  const calls = [];
  const runner = fakeRunner({
    'ls-remote origin refs/heads/wip/sync-songkai-1770000000000': 'def456\trefs/heads/wip/sync-songkai-1770000000000\n',
    'push origin :refs/heads/wip/sync-songkai-1770000000000': '',
    'ls-remote origin refs/heads/wip/sync-songkai-latest': 'abc999\trefs/heads/wip/sync-songkai-latest\n',
  }, calls);

  const result = await cleanupRemoteWipRefs({
    cwd: '/repo',
    remote: 'origin',
    refs: ['wip/sync-songkai-1770000000000', 'wip/sync-songkai-latest'],
    expectedSha: 'def456',
    runner,
  });

  assert.deepEqual(result.deletedRefs, ['wip/sync-songkai-1770000000000']);
  assert.deepEqual(result.skippedRefs, [{
    ref: 'wip/sync-songkai-latest',
    reason: 'sha_mismatch',
    actualSha: 'abc999',
  }]);
  assert.deepEqual(calls.map((call) => call.args), [
    ['ls-remote', 'origin', 'refs/heads/wip/sync-songkai-1770000000000'],
    ['push', 'origin', ':refs/heads/wip/sync-songkai-1770000000000'],
    ['ls-remote', 'origin', 'refs/heads/wip/sync-songkai-latest'],
  ]);
});

test('applyVerifiedWipCommit requires sender base HEAD to match receiver HEAD', async () => {
  const runner = fakeRunner({
    'status --porcelain': '',
    'rev-parse HEAD': 'receiver999\n',
  });

  await assert.rejects(
    () => applyVerifiedWipCommit({
      cwd: '/repo',
      wipCommitSha: 'def456',
      filesModified: ['README.md'],
      expectedBaseHead: 'sender123',
      governanceCheck: async () => ({ ok: true }),
      runner,
    }),
    /sender_receiver_head_diverged/
  );
});
