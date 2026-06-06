# Context Sync Local E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the default local Context Sync E2E suite and the Git/store lifecycle fixes required for it to pass without a live relay or public network.

**Architecture:** Add a real-Git E2E harness under `tests/e2e/context-sync/`, then drive implementation changes through failing tests. Keep the default suite local and deterministic; it verifies WIP push/fetch/SHA, metadata-only untracked handling, partial push/emit states, store-backed dedupe, safe apply guard, cleanup exact-SHA behavior, and package verification scripts.

**Tech Stack:** Node.js built-in test runner, Node `node:sqlite`, real `git` CLI, existing `createContextSyncService`, existing `createEventStore`, existing `createBrokerService`.

---

## Scope

This plan implements the first independently shippable slice from `design/context-sync-e2e-verification.md`:

- Default local E2E suite: `npm run test:e2e:context-sync`.
- Verification command: `npm run verify:context-sync`.
- Git transport fixes needed by the default E2E suite.
- Store/service lifecycle fixes needed by duplicate, retry, partial, and cleanup scenarios.

This plan does not implement local relay integration or real relay canary. Those get separate plans after the default local suite is deterministic.

## File Structure

- Create `tests/e2e/context-sync/harness.js`
  - Owns temp directory setup, real Git command execution, two-machine repository setup, mutation helpers, remote hook failure injection, remote ref inspection, and cleanup/report behavior.
- Create `tests/e2e/context-sync/context-sync-local.e2e.test.js`
  - Covers inline-only sync, tracked WIP, untracked metadata-only, mixed tracked/untracked, duplicate after service restart, dirty receiver guard, and safe apply guard.
- Create `tests/e2e/context-sync/context-sync-failure.e2e.test.js`
  - Covers SHA mismatch, latest ref overwrite behavior, partial push, push-succeeded/emit-failed, expired checkpoint, and cleanup exact-SHA.
- Modify `src/sync/git-transport.js`
  - Preserve current success behavior, add partial push metadata on latest-ref failure, add exact-SHA cleanup helper, and require sender base HEAD validation before cherry-pick apply.
- Modify `src/sync/context-sync.js`
  - Await request/ack sends, represent push/emit failures explicitly, add retry, add store-backed receiver dedupe, add cleanup method, and make untracked metadata-only display visible.
- Modify `src/store/event-store.js`
  - Add helper methods for receiver dedupe and cleanup listing/marking using existing columns.
- Modify `tests/sync/git-transport.test.js`
  - Add unit coverage for partial push, exact-SHA cleanup, and safe apply base validation.
- Modify `tests/sync/context-sync-service.test.js`
  - Add unit coverage for push-succeeded/emit-failed, retry, persisted dedupe, and untracked metadata display.
- Modify `tests/store/context-sync-store.test.js`
  - Add unit coverage for receiver dedupe and cleanup query helpers.
- Modify `package.json`
  - Add `test:e2e:context-sync` and `verify:context-sync`.

## Task 1: Add Real-Git E2E Harness

**Files:**
- Create: `tests/e2e/context-sync/harness.js`

- [ ] **Step 1: Create the harness file**

Create `tests/e2e/context-sync/harness.js` with:

```js
import { mkdtemp, rm, mkdir, writeFile, readFile, appendFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

export async function runGit(args, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const result = { args, cwd, code, stdout, stderr };
      if (code === 0) {
        resolve(result);
        return;
      }
      const error = new Error(stderr.trim() || `git ${args.join(' ')} exited with ${code}`);
      error.result = result;
      reject(error);
    });
  });
}

export async function createContextSyncE2EHarness() {
  const root = await mkdtemp(join(tmpdir(), 'intent-broker-context-sync-e2e-'));
  const remote = join(root, 'remote.git');
  const machineA = join(root, 'machine-a');
  const machineB = join(root, 'machine-b');
  const logs = join(root, 'logs');
  const reportPath = join(root, 'report.json');

  const commandLog = [];
  async function git(args, options = {}) {
    const result = await runGit(args, options);
    commandLog.push(result);
    return result;
  }

  async function setup() {
    await mkdir(logs, { recursive: true });
    await git(['init', '--bare', remote], { cwd: root });
    await git(['init', machineA], { cwd: root });
    await git(['-C', machineA, 'config', 'user.email', 'machine-a@example.test'], { cwd: root });
    await git(['-C', machineA, 'config', 'user.name', 'Machine A'], { cwd: root });
    await writeFile(join(machineA, 'README.md'), 'base\n');
    await git(['-C', machineA, 'add', 'README.md'], { cwd: root });
    await git(['-C', machineA, 'commit', '-m', 'base'], { cwd: root });
    await git(['-C', machineA, 'branch', '-M', 'main'], { cwd: root });
    await git(['-C', machineA, 'remote', 'add', 'origin', remote], { cwd: root });
    await git(['-C', machineA, 'push', '-u', 'origin', 'main'], { cwd: root });
    await git(['clone', remote, machineB], { cwd: root });
    await git(['-C', machineB, 'config', 'user.email', 'machine-b@example.test'], { cwd: root });
    await git(['-C', machineB, 'config', 'user.name', 'Machine B'], { cwd: root });
    return api;
  }

  async function writeMachineFile(machinePath, relativePath, content) {
    const fullPath = join(machinePath, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  async function appendMachineFile(machinePath, relativePath, content) {
    await appendFile(join(machinePath, relativePath), content);
  }

  async function commit(machinePath, message) {
    await git(['-C', machinePath, 'add', '.'], { cwd: root });
    await git(['-C', machinePath, 'commit', '-m', message], { cwd: root });
  }

  async function makeDivergentHead() {
    await appendMachineFile(machineB, 'README.md', 'machine-b divergent commit\n');
    await commit(machineB, 'machine b diverges');
  }

  async function rejectLatestRefPushes() {
    const hookPath = join(remote, 'hooks', 'pre-receive');
    await writeFile(hookPath, [
      '#!/bin/sh',
      'while read oldrev newrev refname; do',
      '  case "$refname" in',
      '    refs/heads/wip/*-latest) exit 1 ;;',
      '  esac',
      'done',
      'exit 0',
      '',
    ].join('\n'));
    await chmod(hookPath, 0o755);
  }

  async function listRemoteWipRefs() {
    const result = await git(['ls-remote', remote, 'refs/heads/wip/*'], { cwd: root });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/);
        return { sha, ref };
      });
  }

  async function status(machinePath) {
    const result = await git(['-C', machinePath, 'status', '--short', '--branch'], { cwd: root });
    return result.stdout;
  }

  async function writeReport(extra = {}) {
    const report = {
      root,
      remote,
      machineA,
      machineB,
      commandLog,
      remoteWipRefs: await listRemoteWipRefs().catch((error) => [{ error: error.message }]),
      machineAStatus: await status(machineA).catch((error) => error.message),
      machineBStatus: await status(machineB).catch((error) => error.message),
      ...extra,
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    return report;
  }

  async function cleanup() {
    if (process.env.CONTEXT_SYNC_E2E_KEEP_TMP === '1') {
      await writeReport({ kept: true });
      return;
    }
    await rm(root, { recursive: true, force: true });
  }

  const api = {
    root,
    remote,
    machineA,
    machineB,
    logs,
    reportPath,
    setup,
    git,
    writeMachineFile,
    appendMachineFile,
    commit,
    makeDivergentHead,
    rejectLatestRefPushes,
    listRemoteWipRefs,
    status,
    writeReport,
    cleanup,
  };
  return api;
}
```

- [ ] **Step 2: Run the harness file through the test loader**

Run:

```bash
node --experimental-sqlite --test tests/e2e/context-sync/harness.js
```

Expected:

```text
# tests 0
# pass 0
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/context-sync/harness.js
git commit -m "test(sync): add context sync e2e git harness"
```

## Task 2: Add Default Local Happy-Path E2E Tests

**Files:**
- Create: `tests/e2e/context-sync/context-sync-local.e2e.test.js`
- Use: `tests/e2e/context-sync/harness.js`

- [ ] **Step 1: Write the failing local E2E tests**

Create `tests/e2e/context-sync/context-sync-local.e2e.test.js` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createBrokerService } from '../../../src/broker/service.js';
import { createEventStore } from '../../../src/store/event-store.js';
import { createContextSyncService } from '../../../src/sync/context-sync.js';
import { applyVerifiedWipCommit } from '../../../src/sync/git-transport.js';
import { createTempDbPath } from '../../fixtures/temp-dir.js';
import { createContextSyncE2EHarness } from './harness.js';

function registerPair(broker) {
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });
}

function createServicePair({ harness, broker = createBrokerService({ dbPath: createTempDbPath() }) }) {
  registerPair(broker);
  const senderStore = createEventStore({ dbPath: createTempDbPath() });
  const receiverStore = createEventStore({ dbPath: createTempDbPath() });
  const sender = createContextSyncService({
    store: senderStore,
    broker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
  });
  const receiver = createContextSyncService({
    store: receiverStore,
    broker,
    participantId: 'receiver',
    userId: 'songkai',
    sourceNodeId: 'machine-b',
    sourceBrokerId: 'broker-b',
    cwd: harness.machineB,
  });
  return { broker, senderStore, receiverStore, sender, receiver };
}

test('local e2e: inline-only context loads and acks without WIP', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  const { broker, sender, receiver } = createServicePair({ harness });

  const emitted = await sender.explicitSync({
    targetParticipantIds: ['receiver'],
    summary: 'inline handoff',
  });
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  const loaded = await receiver.loadContextSyncRequest(request);
  const ack = broker.readInbox('sender', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_ack');

  assert.equal(emitted.status, 'emitted');
  assert.equal(request.payload.wipCommitSha, null);
  assert.equal(loaded.status, 'loaded');
  assert.equal(loaded.wipVerified, false);
  assert.equal(ack.payload.status, 'loaded');
});

test('local e2e: tracked dirty WIP is pushed, fetched by exact SHA, and isolated', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  const { broker, sender, receiver } = createServicePair({ harness });

  const emitted = await sender.explicitSync({
    targetParticipantIds: ['receiver'],
    summary: 'tracked handoff',
  });
  const refs = await harness.listRemoteWipRefs();
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  const loaded = await receiver.loadContextSyncRequest(request);

  assert.equal(emitted.status, 'emitted');
  assert.match(request.payload.wipBranch, /^wip\/sync-songkai-/);
  assert.equal(typeof request.payload.wipCommitSha, 'string');
  assert.equal(request.payload.wipCommitSha.length, 40);
  assert.equal(refs.some((ref) => ref.ref === `refs/heads/${request.payload.wipBranch}`), true);
  assert.equal(loaded.status, 'loaded');
  assert.equal(loaded.wipVerified, true);
  assert.match(loaded.isolation.branchName, /^context-sync\/sync-songkai-/);
});

test('local e2e: untracked-only work is metadata only and does not create WIP', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.writeMachineFile(harness.machineA, 'scratch.md', 'untracked note\n');
  const { broker, sender, receiver } = createServicePair({ harness });

  const emitted = await sender.explicitSync({
    targetParticipantIds: ['receiver'],
    summary: 'untracked metadata handoff',
  });
  const refs = await harness.listRemoteWipRefs();
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  const loaded = await receiver.loadContextSyncRequest(request);

  assert.equal(emitted.status, 'emitted');
  assert.deepEqual(request.payload.context.filesPending, ['scratch.md']);
  assert.equal(request.payload.wipCommitSha, null);
  assert.equal(refs.length, 0);
  assert.match(loaded.displayText, /未跟踪文件仅作为元数据/);
});

test('local e2e: mixed tracked and untracked work syncs tracked content only', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  await harness.writeMachineFile(harness.machineA, 'scratch.md', 'untracked note\n');
  const { broker, sender, receiver } = createServicePair({ harness });

  await sender.explicitSync({
    targetParticipantIds: ['receiver'],
    summary: 'mixed handoff',
  });
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  const loaded = await receiver.loadContextSyncRequest(request);

  assert.deepEqual(request.payload.context.filesModified, ['README.md']);
  assert.deepEqual(request.payload.context.filesPending, ['scratch.md']);
  assert.equal(typeof request.payload.wipCommitSha, 'string');
  assert.match(loaded.displayText, /未跟踪文件仅作为元数据/);
});

test('local e2e: duplicate delivery after receiver service restart is idempotent', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  registerPair(broker);
  const senderStore = createEventStore({ dbPath: createTempDbPath() });
  const receiverDbPath = createTempDbPath();
  const sender = createContextSyncService({
    store: senderStore,
    broker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
  });

  await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'restart duplicate' });
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  const firstReceiverStore = createEventStore({ dbPath: receiverDbPath });
  const firstReceiver = createContextSyncService({
    store: firstReceiverStore,
    broker,
    participantId: 'receiver',
    userId: 'songkai',
    sourceNodeId: 'machine-b',
    sourceBrokerId: 'broker-b',
    cwd: harness.machineB,
  });
  const first = await firstReceiver.loadContextSyncRequest(request);
  const secondReceiverStore = createEventStore({ dbPath: receiverDbPath });
  const secondReceiver = createContextSyncService({
    store: secondReceiverStore,
    broker,
    participantId: 'receiver',
    userId: 'songkai',
    sourceNodeId: 'machine-b',
    sourceBrokerId: 'broker-b',
    cwd: harness.machineB,
  });
  const second = await secondReceiver.loadContextSyncRequest(request);
  const acks = broker.readInbox('sender', { after: 0 }).items
    .filter((item) => item.kind === 'context_sync_ack');

  assert.equal(first.status, 'loaded');
  assert.equal(second.duplicate, true);
  assert.equal(acks.length, 1);
});

test('local e2e: apply rejects when receiver HEAD differs from sender base', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  await harness.makeDivergentHead();
  const { broker, sender, receiver } = createServicePair({ harness });

  await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'divergent handoff' });
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  await receiver.loadContextSyncRequest(request);

  await assert.rejects(
    () => applyVerifiedWipCommit({
      cwd: harness.machineB,
      wipCommitSha: request.payload.wipCommitSha,
      filesModified: request.payload.context.filesModified,
      expectedBaseHead: request.payload.context.gitHead,
      governanceCheck: async () => ({ ok: true }),
    }),
    /sender_receiver_head_diverged/
  );
});
```

- [ ] **Step 2: Run the new E2E test and verify it fails**

Run:

```bash
node --experimental-sqlite --test tests/e2e/context-sync/context-sync-local.e2e.test.js
```

Expected:

```text
FAIL
```

Expected failure reasons include missing untracked metadata display and missing persisted dedupe or sender base HEAD validation.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/e2e/context-sync/context-sync-local.e2e.test.js
git commit -m "test(sync): cover local context sync e2e contracts"
```

## Task 3: Add Git Transport Unit Tests For Partial Push, Cleanup, And Safe Apply

**Files:**
- Modify: `tests/sync/git-transport.test.js`

- [ ] **Step 1: Add failing unit tests**

Append these tests to `tests/sync/git-transport.test.js`:

```js
test('createAndPushWipCommit exposes partial WIP when latest ref push fails', async () => {
  const latestError = new Error('latest rejected');
  const runner = fakeRunner({
    'diff --name-only HEAD --': 'README.md\n',
    'stash create': 'def456\n',
    'push origin def456:refs/heads/wip/sync-songkai-1770000000000': '',
    'push origin def456:refs/heads/wip/sync-songkai-latest': latestError,
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
```

Also update the import block at the top of `tests/sync/git-transport.test.js`:

```js
import {
  applyVerifiedWipCommit,
  cleanupRemoteWipRefs,
  collectGitContext,
  createAndPushWipCommit,
  createIsolatedBranch,
  discoverLatestWipRefs,
  fetchAndVerifyWipCommit,
} from '../../src/sync/git-transport.js';
```

- [ ] **Step 2: Run the unit tests and verify they fail**

Run:

```bash
node --experimental-sqlite --test tests/sync/git-transport.test.js
```

Expected:

```text
FAIL
```

Expected failure reasons include `cleanupRemoteWipRefs` not exported and `sender_receiver_head_diverged` not implemented.

- [ ] **Step 3: Commit**

```bash
git add tests/sync/git-transport.test.js
git commit -m "test(sync): cover wip cleanup and safe apply transport behavior"
```

## Task 4: Implement Git Transport Fixes

**Files:**
- Modify: `src/sync/git-transport.js`
- Modify: `tests/sync/git-transport.test.js`

- [ ] **Step 1: Add helper functions in `src/sync/git-transport.js`**

Add these helpers after `normalizeRemoteBranchRef`:

```js
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

async function readRemoteRefSha({ cwd, remote, ref, runner }) {
  const normalized = normalizeRemoteBranchRef(ref);
  const result = await runner(['ls-remote', remote, `refs/heads/${normalized}`], { cwd });
  const parsed = parseLsRemote(result.stdout)[0];
  return parsed?.sha ?? null;
}
```

- [ ] **Step 2: Replace `createAndPushWipCommit` with partial metadata support**

Replace the existing `createAndPushWipCommit` function with:

```js
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
```

- [ ] **Step 3: Add `cleanupRemoteWipRefs`**

Add this export after `discoverLatestWipRefs`:

```js
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
```

- [ ] **Step 4: Replace `applyVerifiedWipCommit` with base HEAD validation**

Replace the existing `applyVerifiedWipCommit` function with:

```js
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
```

- [ ] **Step 5: Update the existing clean apply unit test**

In `tests/sync/git-transport.test.js`, update `applyVerifiedWipCommit runs governance before cherry-pick on a clean worktree` so the fake runner includes HEAD validation:

```js
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

assert.deepEqual(calls.map((call) => call.args), [
  ['status', '--porcelain'],
  ['rev-parse', 'HEAD'],
  ['cherry-pick', 'def456'],
]);
```

- [ ] **Step 6: Run tests**

Run:

```bash
node --experimental-sqlite --test tests/sync/git-transport.test.js
```

Expected:

```text
PASS
```

- [ ] **Step 7: Commit**

```bash
git add src/sync/git-transport.js tests/sync/git-transport.test.js
git commit -m "fix(sync): make wip transport partial and cleanup states explicit"
```

## Task 5: Add Store Helper Tests And Methods

**Files:**
- Modify: `tests/store/context-sync-store.test.js`
- Modify: `src/store/event-store.js`

- [ ] **Step 1: Add failing store helper tests**

Append these tests to `tests/store/context-sync-store.test.js`:

```js
test('receiver dedupe lookup finds terminal context sync for same receiver and SHA', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.saveContextSync(syncRecord({
    status: 'acked',
    receiverParticipantId: 'receiver',
    wipCommitSha: 'def456',
    ackedAt: '2026-06-04T09:19:00.000Z',
  }));

  const duplicate = store.findReceiverContextSync({
    syncId: 'sync-songkai-1770000000000',
    receiverParticipantId: 'receiver',
    wipCommitSha: 'def456',
  });

  assert.equal(duplicate.status, 'acked');
  assert.equal(duplicate.receiverParticipantId, 'receiver');
});

test('cleanup candidates include terminal records with WIP refs', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.saveContextSync(syncRecord({
    status: 'acked',
    cleanupStatus: 'pending',
  }));
  store.saveContextSync(syncRecord({
    syncId: 'sync-inline',
    status: 'acked',
    wipBranch: null,
    latestRef: null,
    wipCommitSha: null,
    cleanupStatus: 'pending',
  }));

  const candidates = store.listContextSyncCleanupCandidates({ limit: 10 });

  assert.deepEqual(candidates.map((record) => record.syncId), ['sync-songkai-1770000000000']);
});

test('cleanup marker records status, attempt time, and error', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.saveContextSync(syncRecord({
    status: 'cleanup_pending',
    cleanupStatus: 'pending',
  }));

  store.markContextSyncCleanup('sync-songkai-1770000000000', {
    cleanupStatus: 'failed',
    cleanupAttemptedAt: '2026-06-04T09:21:00.000Z',
    cleanupError: 'remote rejected delete',
  });

  const saved = store.getContextSync('sync-songkai-1770000000000');
  assert.equal(saved.cleanupStatus, 'failed');
  assert.equal(saved.cleanupAttemptedAt, '2026-06-04T09:21:00.000Z');
  assert.equal(saved.cleanupError, 'remote rejected delete');
});
```

- [ ] **Step 2: Run store tests and verify they fail**

Run:

```bash
node --experimental-sqlite --test tests/store/context-sync-store.test.js
```

Expected:

```text
FAIL
```

Expected failure reason: helper methods are missing.

- [ ] **Step 3: Add store helper methods**

In `src/store/event-store.js`, add these methods inside the returned object after `getContextSync(syncId)`:

```js
findReceiverContextSync({ syncId, receiverParticipantId, wipCommitSha = null } = {}) {
  const row = db.prepare(`
    SELECT *
    FROM context_syncs
    WHERE sync_id = ?
      AND receiver_participant_id = ?
      AND COALESCE(wip_commit_sha, 'inline') = COALESCE(?, 'inline')
      AND status IN ('acked', 'partial', 'failed', 'cleaned')
    LIMIT 1
  `).get(syncId, receiverParticipantId, wipCommitSha);
  return row ? mapContextSyncRow(row) : null;
},
```

Add these methods after `listContextSyncs(...)`:

```js
listContextSyncCleanupCandidates({ limit = 50 } = {}) {
  return db.prepare(`
    SELECT *
    FROM context_syncs
    WHERE cleanup_status = 'pending'
      AND wip_commit_sha IS NOT NULL
      AND (wip_branch IS NOT NULL OR latest_ref IS NOT NULL)
    ORDER BY COALESCE(acked_at, emitted_at, created_at) ASC
    LIMIT ?
  `).all(limit).map(mapContextSyncRow);
},
markContextSyncCleanup(syncId, {
  cleanupStatus,
  cleanupAttemptedAt = new Date().toISOString(),
  cleanupError = null,
} = {}) {
  db.prepare(`
    UPDATE context_syncs
    SET cleanup_status = ?,
        cleanup_attempted_at = ?,
        cleanup_error = ?
    WHERE sync_id = ?
  `).run(cleanupStatus, cleanupAttemptedAt, cleanupError, syncId);
  return this.getContextSync(syncId);
},
```

- [ ] **Step 4: Run store tests**

Run:

```bash
node --experimental-sqlite --test tests/store/context-sync-store.test.js
```

Expected:

```text
PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/store/event-store.js tests/store/context-sync-store.test.js
git commit -m "fix(sync): add context sync dedupe and cleanup store helpers"
```

## Task 6: Add Context Sync Service Unit Tests

**Files:**
- Modify: `tests/sync/context-sync-service.test.js`

- [ ] **Step 1: Add failing service tests**

Append these tests to `tests/sync/context-sync-service.test.js`:

```js
test('explicitSync records partial WIP when latest ref push fails but timestamped ref exists', async () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });
  const error = new Error('latest rejected');
  error.partialWip = {
    wipBranch: 'wip/sync-songkai-1770000000000',
    latestRef: 'wip/sync-songkai-latest',
    wipCommitSha: 'def456',
    wipRemote: 'origin',
    filesModified: ['README.md'],
    failedRef: 'wip/sync-songkai-latest',
  };

  const { store, service } = baseService({
    broker,
    gitTransport: {
      collectGitContext: async () => ({
        branch: 'main',
        gitHead: 'abc123',
        filesModified: ['README.md'],
        filesPending: [],
      }),
      createAndPushWipCommit: async () => {
        throw error;
      },
    },
  });

  const result = await service.explicitSync({
    targetParticipantIds: ['receiver'],
    summary: 'partial latest handoff',
  });
  const request = broker.readInbox('receiver', { after: 0, kind: 'context_sync_request' }).items[0];
  const stored = store.getContextSync(result.syncId);

  assert.equal(result.status, 'emitted');
  assert.equal(stored.lastError, 'latest rejected');
  assert.equal(stored.cleanupStatus, 'pending');
  assert.equal(request.payload.wipBranch, 'wip/sync-songkai-1770000000000');
  assert.equal(request.payload.wipCommitSha, 'def456');
});

test('explicitSync records partial state when WIP pushed but broker emit fails', async () => {
  const broker = {
    sendIntent: async () => {
      throw new Error('broker offline');
    },
  };
  const { store, service } = baseService({
    broker,
    gitTransport: {
      collectGitContext: async () => ({
        branch: 'main',
        gitHead: 'abc123',
        filesModified: ['README.md'],
        filesPending: [],
      }),
      createAndPushWipCommit: async () => ({
        wipBranch: 'wip/sync-songkai-1770000000000',
        latestRef: 'wip/sync-songkai-latest',
        wipCommitSha: 'def456',
        wipRemote: 'origin',
        filesModified: ['README.md'],
      }),
    },
  });

  const result = await service.explicitSync({
    targetParticipantIds: ['receiver'],
    summary: 'emit failure handoff',
  });
  const stored = store.getContextSync(result.syncId);

  assert.equal(result.status, 'partial');
  assert.equal(stored.status, 'partial');
  assert.equal(stored.wipBranch, 'wip/sync-songkai-1770000000000');
  assert.equal(stored.lastError, 'broker offline');
  assert.equal(stored.emitAttempts, 1);
  assert.equal(stored.cleanupStatus, 'pending');
});

test('retryContextSync re-emits a partial sync without pushing another WIP', async () => {
  let pushCount = 0;
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });
  const { store, service } = baseService({
    broker,
    gitTransport: {
      collectGitContext: async () => ({
        branch: 'main',
        gitHead: 'abc123',
        filesModified: ['README.md'],
        filesPending: [],
      }),
      createAndPushWipCommit: async () => {
        pushCount += 1;
        return {
          wipBranch: 'wip/sync-songkai-1770000000000',
          latestRef: 'wip/sync-songkai-latest',
          wipCommitSha: 'def456',
          wipRemote: 'origin',
          filesModified: ['README.md'],
        };
      },
    },
  });
  store.saveContextSync({
    syncId: DEFAULT_SYNC_ID,
    userId: 'songkai',
    sourceNodeId: 'mb',
    status: 'partial',
    payload: {
      syncId: DEFAULT_SYNC_ID,
      userId: 'songkai',
      sourceNodeId: 'mb',
      context: { summary: 'retry me', recentUserMessages: [] },
      wipBranch: 'wip/sync-songkai-1770000000000',
      latestRef: 'wip/sync-songkai-latest',
      wipCommitSha: 'def456',
      wipRemote: 'origin',
      expiresAt: FIXED_EXPIRES_AT,
    },
    wipBranch: 'wip/sync-songkai-1770000000000',
    latestRef: 'wip/sync-songkai-latest',
    wipCommitSha: 'def456',
    createdAt: FIXED_PREPARED_AT,
    expiresAt: FIXED_EXPIRES_AT,
    emitAttempts: 1,
    cleanupStatus: 'pending',
  });

  const result = await service.retryContextSync({
    syncId: DEFAULT_SYNC_ID,
    targetParticipantIds: ['receiver'],
  });
  const inbox = broker.readInbox('receiver', { after: 0, kind: 'context_sync_request' }).items;

  assert.equal(result.status, 'emitted');
  assert.equal(result.emitAttempts, 2);
  assert.equal(pushCount, 0);
  assert.equal(inbox.length, 1);
});

test('loadContextSyncRequest deduplicates using persisted store state after service recreation', async () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });
  let fetchCount = 0;
  const store = createEventStore({ dbPath: createTempDbPath() });
  const makeReceiver = () => createContextSyncService({
    store,
    broker,
    participantId: 'receiver',
    userId: 'songkai',
    sourceNodeId: 'receiver-node',
    gitTransport: {
      collectGitContext: async () => {
        throw new Error('receiver load must not checkpoint');
      },
      fetchAndVerifyWipCommit: async () => {
        fetchCount += 1;
        return { wipVerified: true, wipCommitSha: 'def456', fetchedRef: 'wip/sync-songkai-1770000000000' };
      },
      createIsolatedBranch: async () => ({
        branchName: 'context-sync/sync-songkai-1770000000000',
        wipCommitSha: 'def456',
      }),
    },
  });

  const first = await makeReceiver().loadContextSyncRequest(syncRequestEvent());
  const duplicate = await makeReceiver().loadContextSyncRequest(syncRequestEvent());
  const acks = broker.readInbox('sender', { after: 0, kind: 'context_sync_ack' }).items;

  assert.equal(first.status, 'loaded');
  assert.equal(duplicate.duplicate, true);
  assert.equal(fetchCount, 1);
  assert.equal(acks.length, 1);
});

test('loadContextSyncRequest display marks untracked files as metadata only', async () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });
  const { service } = baseService({
    broker,
    participantId: 'receiver',
    gitTransport: {
      collectGitContext: async () => {
        throw new Error('receiver load must not checkpoint');
      },
    },
  });

  const loaded = await service.loadContextSyncRequest(syncRequestEvent({
    payload: {
      wipBranch: null,
      latestRef: null,
      wipCommitSha: null,
      wipRemote: null,
    },
  }));

  assert.match(loaded.displayText, /未跟踪文件仅作为元数据/);
});
```

- [ ] **Step 2: Run service tests and verify they fail**

Run:

```bash
node --experimental-sqlite --test tests/sync/context-sync-service.test.js
```

Expected:

```text
FAIL
```

Expected failure reasons include missing `retryContextSync`, persisted dedupe, and partial emit state.

- [ ] **Step 3: Commit**

```bash
git add tests/sync/context-sync-service.test.js
git commit -m "test(sync): cover context sync partial retry and persisted dedupe"
```

## Task 7: Implement Context Sync Service Lifecycle

**Files:**
- Modify: `src/sync/context-sync.js`
- Modify: `tests/sync/context-sync-service.test.js`

- [ ] **Step 1: Import cleanup helper**

Update the import block in `src/sync/context-sync.js`:

```js
import {
  cleanupRemoteWipRefs,
  collectGitContext,
  createAndPushWipCommit,
  createIsolatedBranch,
  fetchAndVerifyWipCommit,
} from './git-transport.js';
```

Update the default `gitTransport` object:

```js
gitTransport = {
  collectGitContext,
  createAndPushWipCommit,
  fetchAndVerifyWipCommit,
  createIsolatedBranch,
  cleanupRemoteWipRefs,
},
```

- [ ] **Step 2: Add terminal status helper near `ACTIVE_SYNC_STATUSES`**

```js
const TERMINAL_RECEIVE_STATUSES = new Set(['acked', 'partial', 'failed', 'cleaned']);

function computeNextRetryAt(date, delayMs = 30 * 1000) {
  return toIso(new Date(date.getTime() + delayMs));
}
```

- [ ] **Step 3: Update display text for untracked metadata**

In `buildDisplayText`, after the `修改:` line, add:

```js
if ((context.filesPending || []).length > 0) {
  lines.push(`未跟踪文件仅作为元数据: ${(context.filesPending || []).join(', ')}`);
}
```

- [ ] **Step 4: Replace `explicitSync` with awaited emit and partial state handling**

Replace the existing `explicitSync` function with:

```js
async function explicitSync({
  targetParticipantIds,
  summary,
  phase = null,
  keyDecisions = [],
  recentUserMessages = [],
} = {}) {
  const checkpoint = await prepareCheckpoint({
    summary,
    phase,
    keyDecisions,
    recentUserMessages,
  });
  const emittedAt = callNow(now);
  let lastError = null;
  let wip = null;

  try {
    wip = await gitTransport.createAndPushWipCommit({
      cwd,
      userId,
      timestamp: emittedAt.getTime(),
    });
  } catch (error) {
    lastError = error.message;
    wip = error.partialWip ?? null;
  }

  const payload = buildPayload({
    syncId: checkpoint.syncId,
    context: checkpoint.payload.context,
    expiresAt: checkpoint.expiresAt,
    wipBranch: wip?.wipBranch ?? null,
    latestRef: wip?.latestRef ?? null,
    wipCommitSha: wip?.wipCommitSha ?? null,
    wipRemote: wip?.wipRemote ?? null,
  });
  const ready = store.updateContextSync(checkpoint.syncId, {
    status: wip ? 'wip_pushed' : 'prepared',
    payload,
    wipBranch: payload.wipBranch,
    latestRef: payload.latestRef,
    wipCommitSha: payload.wipCommitSha,
    wipPushedAt: wip ? toIso(emittedAt) : null,
    lastError,
    cleanupStatus: wip ? 'pending' : null,
  });

  try {
    await sendContextSyncRequest({ record: ready, targetParticipantIds });
    return store.updateContextSync(checkpoint.syncId, {
      status: 'emitted',
      emittedAt: toIso(emittedAt),
      lastEmitAt: toIso(emittedAt),
      emitAttempts: (ready.emitAttempts ?? 0) + 1,
      nextRetryAt: null,
      lastError,
    });
  } catch (error) {
    return store.updateContextSync(checkpoint.syncId, {
      status: 'partial',
      lastEmitAt: toIso(emittedAt),
      emitAttempts: (ready.emitAttempts ?? 0) + 1,
      nextRetryAt: computeNextRetryAt(emittedAt),
      lastError: error.message,
      cleanupStatus: wip ? 'pending' : null,
    });
  }
}
```

- [ ] **Step 5: Add `retryContextSync` after `emitLatestPreparedCheckpoint`**

```js
async function retryContextSync({
  syncId,
  targetParticipantIds,
} = {}) {
  if (!syncId) throw new Error('sync_id_required');
  const record = store.getContextSync(syncId);
  if (!record) throw new Error('context_sync_not_found');
  if (!['partial', 'wip_pushed', 'emitted'].includes(record.status)) {
    throw new Error('context_sync_not_retryable');
  }
  const attemptedAt = callNow(now);

  try {
    await sendContextSyncRequest({ record, targetParticipantIds });
    return store.updateContextSync(syncId, {
      status: 'emitted',
      emittedAt: record.emittedAt ?? toIso(attemptedAt),
      lastEmitAt: toIso(attemptedAt),
      emitAttempts: (record.emitAttempts ?? 0) + 1,
      nextRetryAt: null,
      lastError: null,
    });
  } catch (error) {
    return store.updateContextSync(syncId, {
      status: 'partial',
      lastEmitAt: toIso(attemptedAt),
      emitAttempts: (record.emitAttempts ?? 0) + 1,
      nextRetryAt: computeNextRetryAt(attemptedAt),
      lastError: error.message,
    });
  }
}
```

- [ ] **Step 6: Add store-backed dedupe at the start of `loadContextSyncRequest`**

In `loadContextSyncRequest`, after computing `dedupeKey`, insert:

```js
const persistedDuplicate = typeof store.findReceiverContextSync === 'function'
  ? store.findReceiverContextSync({
    syncId,
    receiverParticipantId: participantId,
    wipCommitSha: payload.wipCommitSha || null,
  })
  : null;
if (persistedDuplicate && TERMINAL_RECEIVE_STATUSES.has(persistedDuplicate.status)) {
  loadedSyncKeys.add(dedupeKey);
  return { duplicate: true, syncId, status: persistedDuplicate.status };
}
```

- [ ] **Step 7: Preserve cleanup status when receiver saves a WIP sync**

In the `store.saveContextSync` call inside `loadContextSyncRequest`, add:

```js
cleanupStatus: payload.wipCommitSha ? 'pending' : null,
```

- [ ] **Step 8: Add `cleanupContextSync` after `loadContextSyncRequest`**

```js
async function cleanupContextSync(syncId) {
  if (!syncId) throw new Error('sync_id_required');
  const record = store.getContextSync(syncId);
  if (!record) throw new Error('context_sync_not_found');
  if (!record.wipCommitSha) {
    return store.updateContextSync(syncId, {
      cleanupStatus: 'cleaned',
      cleanupAttemptedAt: toIso(callNow(now)),
      cleanupError: null,
    });
  }

  const attemptedAt = callNow(now);
  const result = await gitTransport.cleanupRemoteWipRefs({
    cwd,
    remote: record.payload?.wipRemote || 'origin',
    refs: [record.wipBranch, record.latestRef],
    expectedSha: record.wipCommitSha,
  });
  const failed = result.errors.length > 0;
  return store.updateContextSync(syncId, {
    status: failed ? record.status : 'cleaned',
    cleanupStatus: failed ? 'failed' : 'cleaned',
    cleanupAttemptedAt: toIso(attemptedAt),
    cleanupError: failed ? JSON.stringify(result.errors) : null,
  });
}
```

- [ ] **Step 9: Export new service methods**

Update the returned object at the bottom of `createContextSyncService`:

```js
return {
  prepareCheckpoint,
  explicitSync,
  emitLatestPreparedCheckpoint,
  retryContextSync,
  loadContextSyncRequest,
  cleanupContextSync,
  markAcked,
};
```

- [ ] **Step 10: Run service tests**

Run:

```bash
node --experimental-sqlite --test tests/sync/context-sync-service.test.js
```

Expected:

```text
PASS
```

- [ ] **Step 11: Commit**

```bash
git add src/sync/context-sync.js tests/sync/context-sync-service.test.js
git commit -m "fix(sync): persist context sync partial retry and dedupe state"
```

## Task 8: Add Failure-Path Local E2E Tests

**Files:**
- Create: `tests/e2e/context-sync/context-sync-failure.e2e.test.js`

- [ ] **Step 1: Write failure-path E2E tests**

Create `tests/e2e/context-sync/context-sync-failure.e2e.test.js` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerService } from '../../../src/broker/service.js';
import { createEventStore } from '../../../src/store/event-store.js';
import { createContextSyncService } from '../../../src/sync/context-sync.js';
import { createTempDbPath } from '../../fixtures/temp-dir.js';
import { createContextSyncE2EHarness } from './harness.js';

function registerPair(broker) {
  broker.registerParticipant({ participantId: 'sender', kind: 'agent', roles: [], capabilities: [] });
  broker.registerParticipant({ participantId: 'receiver', kind: 'agent', roles: [], capabilities: [] });
}

function createSender({ harness, broker }) {
  return createContextSyncService({
    store: createEventStore({ dbPath: createTempDbPath() }),
    broker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
  });
}

function createReceiver({ harness, broker }) {
  return createContextSyncService({
    store: createEventStore({ dbPath: createTempDbPath() }),
    broker,
    participantId: 'receiver',
    userId: 'songkai',
    sourceNodeId: 'machine-b',
    sourceBrokerId: 'broker-b',
    cwd: harness.machineB,
  });
}

test('failure e2e: latest ref push failure still emits timestamped WIP and records cleanup pending', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.rejectLatestRefPushes();
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  registerPair(broker);
  const senderStore = createEventStore({ dbPath: createTempDbPath() });
  const sender = createContextSyncService({
    store: senderStore,
    broker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
  });

  const result = await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'partial push' });
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  const refs = await harness.listRemoteWipRefs();
  const stored = senderStore.getContextSync(result.syncId);

  assert.equal(result.status, 'emitted');
  assert.match(request.payload.wipBranch, /^wip\/sync-songkai-/);
  assert.equal(request.payload.latestRef, 'wip/sync-songkai-latest');
  assert.equal(refs.some((ref) => ref.ref === `refs/heads/${request.payload.wipBranch}`), true);
  assert.equal(refs.some((ref) => ref.ref === 'refs/heads/wip/sync-songkai-latest'), false);
  assert.equal(stored.cleanupStatus, 'pending');
  assert.match(stored.lastError, /pre-receive hook declined|latest rejected|hook declined/);
});

test('failure e2e: pushed WIP plus broker emit failure stores retryable partial state', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  const senderStore = createEventStore({ dbPath: createTempDbPath() });
  const failingBroker = {
    sendIntent: async () => {
      throw new Error('broker offline');
    },
  };
  const sender = createContextSyncService({
    store: senderStore,
    broker: failingBroker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
  });

  const result = await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'emit failure' });
  const refs = await harness.listRemoteWipRefs();
  const stored = senderStore.getContextSync(result.syncId);

  assert.equal(result.status, 'partial');
  assert.equal(stored.lastError, 'broker offline');
  assert.equal(stored.emitAttempts, 1);
  assert.equal(stored.cleanupStatus, 'pending');
  assert.equal(refs.length >= 1, true);
});

test('failure e2e: cleanup deletes only exact-SHA matching refs', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  registerPair(broker);
  const senderStore = createEventStore({ dbPath: createTempDbPath() });
  const sender = createContextSyncService({
    store: senderStore,
    broker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
  });

  const emitted = await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'cleanup' });
  await harness.appendMachineFile(harness.machineA, 'README.md', 'newer dirty change\n');
  await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'moves latest' });
  const cleaned = await sender.cleanupContextSync(emitted.syncId);
  const refs = await harness.listRemoteWipRefs();

  assert.equal(cleaned.cleanupStatus, 'cleaned');
  assert.equal(refs.some((ref) => ref.ref === `refs/heads/${emitted.wipBranch}`), false);
  assert.equal(refs.some((ref) => ref.ref === 'refs/heads/wip/sync-songkai-latest'), true);
});

test('failure e2e: expired prepared checkpoint is not emitted', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  registerPair(broker);
  const store = createEventStore({ dbPath: createTempDbPath() });
  const service = createContextSyncService({
    store,
    broker,
    participantId: 'sender',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    sourceBrokerId: 'broker-a',
    cwd: harness.machineA,
    now: () => new Date('2026-06-06T10:00:00.000Z'),
  });
  store.saveContextSync({
    syncId: 'sync-songkai-expired',
    userId: 'songkai',
    sourceNodeId: 'machine-a',
    status: 'prepared',
    payload: {
      syncId: 'sync-songkai-expired',
      userId: 'songkai',
      sourceNodeId: 'machine-a',
      context: { summary: 'expired', recentUserMessages: [] },
      expiresAt: '2026-06-06T09:00:00.000Z',
    },
    createdAt: '2026-06-06T08:00:00.000Z',
    preparedAt: '2026-06-06T08:00:00.000Z',
    expiresAt: '2026-06-06T09:00:00.000Z',
  });

  const result = await service.emitLatestPreparedCheckpoint({ targetParticipantIds: ['receiver'] });
  const inbox = broker.readInbox('receiver', { after: 0 }).items;

  assert.equal(result, null);
  assert.equal(inbox.length, 0);
});

test('failure e2e: receiver records SHA mismatch as partial', async (t) => {
  const harness = await createContextSyncE2EHarness();
  await harness.setup();
  t.after(() => harness.cleanup());
  await harness.appendMachineFile(harness.machineA, 'README.md', 'tracked dirty change\n');
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  registerPair(broker);
  const sender = createSender({ harness, broker });
  const receiver = createReceiver({ harness, broker });

  await sender.explicitSync({ targetParticipantIds: ['receiver'], summary: 'sha mismatch' });
  const request = broker.readInbox('receiver', { after: 0 }).items
    .find((item) => item.kind === 'context_sync_request');
  request.payload.wipCommitSha = '0000000000000000000000000000000000000000';
  const loaded = await receiver.loadContextSyncRequest(request);

  assert.equal(loaded.status, 'partial');
  assert.equal(loaded.failureReason, 'wip_commit_sha_mismatch');
});
```

- [ ] **Step 2: Run failure E2E tests**

Run:

```bash
node --experimental-sqlite --test tests/e2e/context-sync/context-sync-failure.e2e.test.js
```

Expected:

```text
PASS
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/context-sync/context-sync-failure.e2e.test.js
git commit -m "test(sync): cover local context sync failure e2e paths"
```

## Task 9: Add Package Scripts And Verification Command

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add scripts**

Modify the `scripts` object in `package.json` so it includes:

```json
"test:e2e:context-sync": "node --experimental-sqlite --test tests/e2e/context-sync/*.test.js",
"verify:context-sync": "npm test && npm run test:e2e:context-sync && git diff --check"
```

The final scripts block should look like:

```json
"scripts": {
  "test": "node scripts/run-tests.js",
  "test:e2e:context-sync": "node --experimental-sqlite --test tests/e2e/context-sync/*.test.js",
  "verify:context-sync": "npm test && npm run test:e2e:context-sync && git diff --check",
  "start": "node --experimental-sqlite src/cli.js",
  "broker:status": "node scripts/broker-control.js status",
  "broker:stop": "node scripts/broker-control.js stop",
  "broker:restart": "node scripts/broker-control.js restart",
  "verify:collaboration": "node scripts/run-collaboration-smoke.js",
  "codex:install": "node adapters/codex-plugin/bin/codex-broker.js install",
  "claude-code:install": "node adapters/claude-code-plugin/bin/claude-code-broker.js install",
  "agy:install": "node adapters/agy-plugin/bin/agy-broker.js install",
  "opencode:install": "node adapters/opencode-plugin/bin/opencode-broker.js install"
}
```

- [ ] **Step 2: Run E2E script**

Run:

```bash
npm run test:e2e:context-sync
```

Expected:

```text
PASS
```

- [ ] **Step 3: Run full verification**

Run:

```bash
npm run verify:context-sync
```

Expected:

```text
PASS
```

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(sync): add context sync verification scripts"
```

## Task 10: Final Verification And Review

**Files:**
- Review: all files changed by Tasks 1-9

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --experimental-sqlite --test tests/sync/git-transport.test.js
node --experimental-sqlite --test tests/sync/context-sync-service.test.js
node --experimental-sqlite --test tests/store/context-sync-store.test.js
npm run test:e2e:context-sync
```

Expected:

```text
PASS
PASS
PASS
PASS
```

- [ ] **Step 2: Run full suite**

Run:

```bash
npm test
```

Expected:

```text
PASS
```

- [ ] **Step 3: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git diff --stat origin/master...HEAD
```

Expected:

```text
Only intentional tracked changes are present.
Untracked governance/temp files are not staged.
```

- [ ] **Step 5: Request code review**

Use superpowers:requesting-code-review before landing. The reviewer should check:

- E2E harness does not depend on public network or a live broker daemon.
- Untracked content is not implied to transfer.
- Partial push and emit failure states are inspectable and retryable.
- Duplicate delivery after service recreation is idempotent.
- Cleanup never deletes a ref whose SHA has moved.

## Self-Review

Spec coverage:

- Default local E2E: covered by Tasks 1, 2, 8, and 9.
- Real Git push/fetch/SHA verification: covered by Tasks 1, 2, 3, 4, and 8.
- Untracked metadata-only contract: covered by Tasks 2 and 7.
- Stash/cherry-pick divergent HEAD safety: covered by Tasks 2, 3, and 4.
- Push/emit separate failure domains: covered by Tasks 6, 7, and 8.
- Latest ref source-of-truth behavior: covered by Tasks 4 and 8 through timestamped ref cleanup and moved-latest cleanup.
- Store-backed dedupe after restart: covered by Tasks 5, 6, and 7.
- Lifecycle cleanup exact-SHA: covered by Tasks 3, 4, 5, 7, and 8.
- Verification command: covered by Task 9.

Known gaps intentionally left for the next plan:

- Local relay request/ack forwarding.
- Relay disconnect/reconnect replay.
- Backpressure integration.
- Production offline presence wiring.
- Real relay and cross-machine canary.

Placeholder scan result:

- No placeholder markers remain in this plan.
- The plan uses concrete file paths, commands, expected results, and code blocks
  for each implementation step.
