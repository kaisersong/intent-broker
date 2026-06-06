# Context Sync E2E Verification Design

Status: revised after adversarial review
Date: 2026-06-06

## 1. Purpose

Context Sync cannot be fully gated by another agent. The reliable control point is
human-in-the-loop approval, but the system should reduce conflict and risk before
a human has to inspect a handoff manually.

This design adds an automated verification strategy for Context Sync so that the
common failure modes are caught by repeatable tests:

- WIP refs are pushed, fetched, and verified with real Git.
- Context Sync records have a visible lifecycle instead of silent growth.
- Offline emit, missed delivery, duplicate delivery, and retry behavior are
  tested at the right layer.
- Relay integration is tested separately from the fast local developer suite.

The goal is not to prove that an agent can safely decide whether code should be
applied. The goal is to prove that the handoff mechanics are observable,
idempotent, and fail into human-reviewable states.

## 2. Constraints From Review

The adversarial review found these blocking risks in the initial E2E proposal.
The revised design treats each one as a testable contract.

### 2.1 Untracked Files Are Metadata Only In V1

Current Git transport collects `filesPending` with `git ls-files --others`, but
`git stash create` only captures tracked dirty state. Therefore V1 must not claim
that untracked file contents are synced.

Contract:

- `filesPending` is included in context payload as metadata.
- Untracked-only work emits inline context with `wipCommitSha: null`.
- Mixed tracked + untracked work may push tracked WIP, but untracked files remain
  metadata only.
- Receiver UI/display text must make the distinction visible.

E2E must fail if a test or UI message implies untracked file content was
transferred.

### 2.2 Stash Commit Apply Is Not A Default Happy Path

`git stash create` produces a stash-shaped commit. Applying it with plain
`git cherry-pick` is not equivalent to `git stash apply`, especially when sender
and receiver HEADs differ.

Contract:

- The default E2E suite verifies fetch, SHA check, and isolated branch creation.
- Worktree application remains behind explicit human approval.
- Any apply-to-worktree path must include divergent-HEAD tests before it can be
  treated as supported behavior.
- A clean same-base apply test may exist, but divergent-base behavior is the
  regression gate.

Until the apply strategy is fixed, E2E should expose the current risk rather than
papering over it with a cherry-pick-only happy path.

### 2.3 Push And Emit Are Separate Failure Domains

Current explicit sync pushes WIP before emitting `context_sync_request`. If push
succeeds but emit fails, remote refs and store state can diverge.

Contract:

- A sync with pushed WIP but failed emit must be stored as a partial state, not a
  normal `emitted` success.
- The partial state must be retryable or cleanable.
- The remote timestamped ref must be discoverable for cleanup.
- Tests must cover "push succeeded, emit failed" and "first push succeeded,
  second push failed".

### 2.4 Latest Ref Is A Convenience Pointer, Not The Source Of Truth

`latestRef` can be overwritten by a later sync. Timestamped WIP refs and exact
SHA verification are the source of truth.

Contract:

- Payloads that include `wipBranch` must fetch by `wipBranch` first.
- `latestRef` is only a discovery fallback.
- If latest points to a different SHA, receiver must not apply it.
- If a timestamped ref exists for the expected SHA, receiver should be able to
  recover from a stale or overwritten latest ref.

### 2.5 Dedupe Must Survive Process Restart

In-memory duplicate protection is not enough. Broker restart must not cause the
same sync to be loaded or applied twice.

Contract:

- Store state participates in dedupe.
- Duplicate delivery after restart returns an idempotent result.
- Repeated ack attempts do not create unbounded rows.

### 2.6 Context Syncs Need Lifecycle Closure

The `context_syncs` table and remote `wip/sync-*` refs must not grow forever.

Contract:

- Active records are limited to one per `(userId, sourceNodeId)`.
- Terminal records have retention policy.
- Remote cleanup uses exact SHA/ref matching.
- Cleanup failure is recorded and retryable.

## 3. Verification Layers

The earlier proposal mixed fast E2E, relay integration, and real cross-machine
canary into one suite. That would make local verification slow and flaky. The
revised design separates them.

### 3.1 Default Local E2E

Command:

```bash
npm run test:e2e:context-sync
```

Target:

- Runs in less than 30 seconds on a developer machine.
- Uses temporary directories only.
- Uses real Git for repository setup, commit, stash, push, fetch, branch, and
  ref discovery.
- Does not require a live broker daemon, public relay, network, or credentials.

Scope:

- Git transport correctness.
- Context Sync service request/load/ack mechanics with an in-process broker or
  test broker.
- Failure injection using real Git where practical. For example, a bare remote
  hook can reject `wip/*-latest` to simulate partial push.
- No production relay dependency.

### 3.2 Local Relay Integration

Command:

```bash
npm run test:integration:context-sync-relay
```

Target:

- Runs in less than 2 minutes.
- Starts local broker/relay components in-process or on ephemeral ports.
- Verifies that production wiring exists.

Scope:

- `context_sync_request` and `context_sync_ack` through relay-facing code.
- Relay disconnect and reconnect replay.
- Backpressure behavior for Context Sync event kinds.
- Offline presence to Context Sync emitter wiring.

### 3.3 Nightly / Canary

Commands:

```bash
CONTEXT_SYNC_E2E_REAL_RELAY=1 npm run test:e2e:context-sync-relay
CONTEXT_SYNC_CANARY=1 npm run test:canary:context-sync
```

Target:

- Runs outside the default developer loop.
- May use real relay credentials, real network, and two physical or VM-backed
  machines.

Scope:

- Cross-machine explicit sync, load, ack, and optional apply guard.
- Long disconnect recovery.
- Multiple senders racing on latest refs.
- Continuous sync soak test for store and remote ref growth.

## 4. Harness Shape

Default local E2E should live under:

```text
tests/e2e/context-sync/
  harness.js
  git-fixtures.js
  context-sync-local.e2e.test.js
  context-sync-failure.e2e.test.js
```

Each test creates a temporary root:

```text
/private/tmp/intent-broker-context-sync-e2e-<id>/
  remote.git
  machine-a/
  machine-b/
  logs/
  report.json
```

Harness responsibilities:

- Initialize `remote.git` as a bare repository.
- Clone or initialize `machine-a` and `machine-b`.
- Configure local Git identity.
- Create an initial shared base commit.
- Provide helpers for tracked changes, untracked files, divergent HEADs, and
  remote hook failure injection.
- Capture command logs and final Git refs into `report.json` on failure.
- Clean up temp directories after success and preserve them on failure when
  `CONTEXT_SYNC_E2E_KEEP_TMP=1`.

The harness should use real `git` commands for normal operations. It may use
test doubles only at explicit non-Git boundaries such as broker send failure.

## 5. Scenario Matrix

| ID | Layer | Scenario | Required Assertion |
| --- | --- | --- | --- |
| L1 | Default | Inline-only explicit sync | Receiver loads context, sends ack, no WIP SHA exists. |
| L2 | Default | Tracked dirty WIP | Sender pushes timestamped ref, receiver fetches by exact ref, SHA matches, isolated branch is created. |
| L3 | Default | Untracked-only work | Payload includes `filesPending`, no WIP commit is created, receiver display does not claim content transfer. |
| L4 | Default | Mixed tracked + untracked | Tracked WIP is verifiable, untracked entries remain metadata. |
| L5 | Default | Receiver worktree dirty | Load remains read-only; apply path rejects with `worktree_dirty`. |
| L6 | Default | Duplicate delivery in same process | Second load is idempotent and does not create duplicate terminal state. |
| L7 | Default | Duplicate delivery after restart | Store-based dedupe prevents repeat load/apply after service recreation. |
| L8 | Default | SHA mismatch | Receiver rejects mismatched fetched SHA and records partial/failed state. |
| L9 | Default | Latest ref overwritten | Receiver refuses wrong latest SHA and recovers through timestamped ref when present. |
| L10 | Default | Partial push: timestamped success, latest failure | Store records partial push state; timestamped ref is discoverable for retry/cleanup. |
| L11 | Default | Push succeeded, emit failed | Store records non-emitted partial state; retry does not push duplicate refs unnecessarily. |
| L12 | Default | Expired checkpoint | Expired prepared sync cannot be emitted as fresh context. |
| L13 | Default | Cleanup exact-SHA guard | Cleanup deletes only matching ref/SHA and leaves unrelated refs untouched. |
| L14 | Default | Divergent HEAD apply risk | Apply strategy either rejects safely or produces a documented conflict state; silent success is failure. |
| R1 | Local Relay | Request and ack through relay path | Sender observes ack after relay forwarding, not direct in-process delivery. |
| R2 | Local Relay | Relay disconnect during event production | Event is replayed or marked undelivered; no silent cursor loss. |
| R3 | Local Relay | Backpressure | Context Sync events are rate-limited/queued according to relay contract. |
| R4 | Local Relay | Offline emit wiring | Offline presence triggers real context sync emitter only for the scoped participant/project. |
| C1 | Canary | Cross-machine explicit sync | Real machines complete explicit sync, load, and ack. |
| C2 | Canary | Long disconnect recovery | After a multi-minute disconnect, missed context sync is discoverable or explicitly failed. |
| C3 | Canary | Soak cleanup | After repeated syncs, store rows and remote refs stay within retention limits. |

## 6. Expected Failure Output

Every E2E failure should print enough state to debug without rerunning manually:

- Temp root path.
- Git command that failed, exit code, stdout, stderr.
- Local `git status --short --branch` for both machines.
- Remote refs under `refs/heads/wip/`.
- Relevant `context_syncs` rows.
- Broker event ids for request and ack when applicable.
- Whether cleanup ran or was skipped.

The test report should avoid generic assertions such as "expected true". It
should name the broken contract, for example:

```text
contract failed: untracked files are metadata only
expected wipCommitSha to be null for untracked-only context
```

## 7. Retry And Lifecycle Policy To Verify

The tests should drive the implementation toward explicit state instead of
implicit best effort.

Recommended state shape:

- `prepared`: context collected, not emitted.
- `wip_pushed`: WIP ref pushed, request not yet emitted.
- `emitted`: request sent.
- `acked`: receiver acknowledged load.
- `partial`: a bounded failure occurred and can be inspected.
- `cleanup_pending`: terminal state awaiting remote ref cleanup.
- `expired`: checkpoint is no longer eligible for emit.
- `cleaned`: cleanup finished.

Retry expectations:

- Retry attempts are counted and timestamped.
- Retry is idempotent by `syncId` and `wipCommitSha`.
- Retry does not assume one attempt is enough.
- Retry budget is deterministic in tests. The default suite can use a small
  fixed budget such as three attempts with no real sleep.
- Terminal failure records the reason and preserves enough metadata for human
  review.

Cleanup expectations:

- Cleanup only deletes a remote ref if it still points to the expected SHA.
- Cleanup must never delete `latestRef` if it has moved to a newer SHA.
- Cleanup failure updates `cleanup_error` and remains retryable.

## 8. Implementation Order

### Phase 1: Local E2E Harness And Red Tests

Add the default E2E harness and the first tests that expose current risk:

1. Inline-only sync.
2. Tracked dirty WIP fetch and verify.
3. Untracked-only metadata contract.
4. Divergent HEAD apply risk.
5. Partial push with latest-ref rejection.
6. Push-succeeded emit-failed state.

This phase is allowed to produce failing tests if implementation is not ready.
The point is to lock the contracts before expanding runtime wiring.

### Phase 2: Git Transport And Store Lifecycle Fixes

Fix or explicitly constrain the behavior exposed by Phase 1:

1. Make untracked metadata behavior visible and tested.
2. Treat timestamped WIP refs as source of truth.
3. Add partial states for push/emit failures.
4. Add store-backed dedupe across service restart.
5. Add exact-SHA cleanup helpers.
6. Keep apply-to-worktree read-only by default until divergent HEAD behavior is
   safe.

### Phase 3: Default Verification Command

Add scripts:

```json
{
  "test:e2e:context-sync": "node --experimental-sqlite --test tests/e2e/context-sync/*.test.js",
  "verify:context-sync": "npm test && npm run test:e2e:context-sync && git diff --check"
}
```

The default verification command must not require relay credentials.

### Phase 4: Local Relay Integration

Add the integration suite after local Git/store contracts are stable:

1. Start local broker and relay components on ephemeral ports.
2. Verify request and ack through relay-facing code.
3. Simulate disconnect, reconnect, and backpressure.
4. Verify offline emit production wiring.

### Phase 5: Nightly / Canary

Add real relay and cross-machine checks only after local and integration suites
are deterministic.

The canary should be treated as operational monitoring, not as the only proof
that Context Sync works.

## 9. Non-Goals

- The E2E suite does not decide whether a receiver should approve applying WIP.
- The default suite does not require a real public relay.
- V1 does not promise untracked file content synchronization.
- V1 does not auto-apply WIP to a dirty worktree.
- The test harness is not a general multi-agent simulator.

## 10. Acceptance Criteria

The design is ready for implementation planning when:

- The default suite can run without network and without a live broker daemon.
- Every blocking review finding maps to at least one test scenario.
- The suite distinguishes metadata transfer from content transfer.
- Push, emit, ack, retry, and cleanup have observable states.
- Relay and real cross-machine tests are separated from the fast local command.
- Failure output is sufficient for a developer to inspect state without asking a
  human to reproduce the handoff manually.

## 11. Open Execution Decisions

These decisions are intentionally deferred to the implementation plan, but the
test contracts above constrain the outcome:

- Whether the apply strategy becomes `git apply --3way`, `git stash branch`, or
  another explicit strategy.
- Whether remote cleanup runs eagerly on ack or via a periodic cleanup command.
- Whether local relay integration starts a full broker process or imports broker
  services in-process.

Any choice is acceptable only if it satisfies the scenario matrix and failure
output requirements.
