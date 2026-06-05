import {
  collectGitContext,
  createAndPushWipCommit,
  createIsolatedBranch,
  fetchAndVerifyWipCommit,
} from './git-transport.js';

const DEFAULT_CHECKPOINT_TTL_MS = 15 * 60 * 1000;
const ACTIVE_SYNC_STATUSES = new Set(['prepared', 'emitted', 'cleanup_pending']);

function toIso(date) {
  return date.toISOString();
}

function callNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value : new Date(value);
}

function buildSyncId(userId, timestampMs) {
  return `sync-${userId}-${timestampMs}`;
}

function compactContext(context) {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined)
  );
}

export function createContextSyncService({
  store,
  broker = null,
  participantId,
  userId,
  sourceNodeId,
  sourceBrokerId,
  cwd = process.cwd(),
  now = () => new Date(),
  checkpointTtlMs = DEFAULT_CHECKPOINT_TTL_MS,
  includeRecentUserMessages = false,
  gitTransport = {
    collectGitContext,
    createAndPushWipCommit,
    fetchAndVerifyWipCommit,
    createIsolatedBranch,
  },
} = {}) {
  if (!store) throw new Error('context_sync_store_required');
  if (!participantId) throw new Error('context_sync_participant_id_required');
  if (!userId) throw new Error('context_sync_user_id_required');
  if (!sourceNodeId) throw new Error('context_sync_source_node_id_required');
  const loadedSyncKeys = new Set();

  function expireExistingActiveSyncs(nextSyncId) {
    for (const record of store.listContextSyncs({ userId, sourceNodeId, limit: null })) {
      if (record.syncId !== nextSyncId && ACTIVE_SYNC_STATUSES.has(record.status)) {
        store.updateContextSync(record.syncId, { status: 'expired' });
      }
    }
  }

  function buildPayload({
    syncId,
    context,
    expiresAt,
    wipBranch = null,
    latestRef = null,
    wipCommitSha = null,
    wipRemote = null,
  }) {
    return {
      syncId,
      userId,
      sourceNodeId,
      sourceBrokerId: sourceBrokerId ?? null,
      context,
      wipBranch,
      latestRef,
      wipCommitSha,
      wipRemote,
      expiresAt,
    };
  }

  function sendContextSyncRequest({ record, targetParticipantIds }) {
    if (!broker) throw new Error('context_sync_broker_required');
    return broker.sendIntent({
      intentId: record.syncId,
      kind: 'context_sync_request',
      fromParticipantId: participantId,
      taskId: null,
      threadId: `context-sync-${userId}`,
      to: { mode: 'participant', participants: targetParticipantIds },
      payload: record.payload,
    });
  }

  function sendContextSyncAck({
    syncId,
    toParticipantId,
    status,
    wipVerified,
    loadedReadOnly = true,
    appliedToWorktree = false,
    failureReason = null,
  }) {
    if (!broker) throw new Error('context_sync_broker_required');
    return broker.sendIntent({
      intentId: `sync-ack-${participantId}-${Date.now()}`,
      kind: 'context_sync_ack',
      fromParticipantId: participantId,
      taskId: null,
      threadId: `context-sync-${userId}`,
      to: { mode: 'participant', participants: [toParticipantId] },
      payload: {
        syncId,
        status,
        wipVerified,
        loadedReadOnly,
        appliedToWorktree,
        failureReason,
      },
    });
  }

  function buildDisplayText({ payload, status, wipVerified, isolation, failureReason }) {
    const context = payload.context || {};
    const lines = [
      `━━━ 来自 ${payload.sourceNodeId || 'unknown'} 的工作上下文 ━━━`,
      `摘要: ${context.summary || ''}`,
      `分支: ${context.branch || payload.wipBranch || ''}${wipVerified ? ' (commit 已验证)' : ''}`,
      `修改: ${(context.filesModified || []).join(', ') || '无'}`,
      `状态: 只读加载，尚未应用到当前 worktree`,
    ];
    if (isolation?.branchName) {
      lines.push(`隔离分支: ${isolation.branchName}`);
    }
    if (status === 'partial' && failureReason) {
      lines.push(`WIP 加载失败: ${failureReason}`);
    }
    lines.push('输入 /apply-sync 并确认后才会应用代码变更。');
    return lines.join('\n');
  }

  async function prepareCheckpoint({
    summary,
    phase = null,
    keyDecisions = [],
    recentUserMessages = [],
  } = {}) {
    const preparedAt = callNow(now);
    const syncId = buildSyncId(userId, preparedAt.getTime());
    const expiresAt = toIso(new Date(preparedAt.getTime() + checkpointTtlMs));
    const gitContext = await gitTransport.collectGitContext({ cwd });
    const context = compactContext({
      summary,
      recentUserMessages: includeRecentUserMessages ? recentUserMessages : [],
      phase,
      branch: gitContext.branch,
      gitHead: gitContext.gitHead,
      filesModified: gitContext.filesModified ?? [],
      filesPending: gitContext.filesPending ?? [],
      keyDecisions,
    });
    const payload = buildPayload({ syncId, context, expiresAt });

    expireExistingActiveSyncs(syncId);
    return store.saveContextSync({
      syncId,
      userId,
      sourceNodeId,
      status: 'prepared',
      payload,
      preparedAt: toIso(preparedAt),
      createdAt: toIso(preparedAt),
      expiresAt,
    });
  }

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
      payload,
      wipBranch: payload.wipBranch,
      latestRef: payload.latestRef,
      wipCommitSha: payload.wipCommitSha,
      wipPushedAt: wip ? toIso(emittedAt) : null,
      lastError,
    });

    sendContextSyncRequest({ record: ready, targetParticipantIds });
    return store.updateContextSync(checkpoint.syncId, {
      status: 'emitted',
      emittedAt: toIso(emittedAt),
      lastEmitAt: toIso(emittedAt),
      emitAttempts: (ready.emitAttempts ?? 0) + 1,
    });
  }

  async function emitLatestPreparedCheckpoint({
    targetParticipantIds,
    maxAgeMs = DEFAULT_CHECKPOINT_TTL_MS,
  } = {}) {
    const emittedAt = callNow(now);
    const checkpoint = store.getLatestPreparedContextSync({
      userId,
      now: emittedAt,
      maxAgeMs,
    });
    if (!checkpoint) {
      return null;
    }

    sendContextSyncRequest({ record: checkpoint, targetParticipantIds });
    return store.updateContextSync(checkpoint.syncId, {
      status: 'emitted',
      emittedAt: toIso(emittedAt),
      lastEmitAt: toIso(emittedAt),
      emitAttempts: (checkpoint.emitAttempts ?? 0) + 1,
    });
  }

  function markAcked(syncId, { receiverParticipantId, ackedAt = callNow(now) } = {}) {
    return store.markContextSyncAcked(syncId, {
      receiverParticipantId,
      ackedAt: toIso(ackedAt),
    });
  }

  async function loadContextSyncRequest(event) {
    const payload = event?.payload || {};
    const syncId = payload.syncId;
    const dedupeKey = `${syncId}:${payload.wipCommitSha || 'inline'}`;
    if (loadedSyncKeys.has(dedupeKey)) {
      return { duplicate: true, syncId };
    }

    let status = payload.context ? 'loaded' : 'failed';
    let wipVerified = false;
    let isolation = null;
    let failureReason = null;

    if (payload.wipBranch || payload.latestRef) {
      try {
        const verified = await gitTransport.fetchAndVerifyWipCommit({
          cwd,
          remote: payload.wipRemote || 'origin',
          wipBranch: payload.wipBranch,
          latestRef: payload.latestRef,
          wipCommitSha: payload.wipCommitSha,
        });
        wipVerified = verified.wipVerified;
        isolation = await gitTransport.createIsolatedBranch({
          cwd,
          syncId,
          wipCommitSha: verified.wipCommitSha,
        });
        status = payload.context ? 'loaded' : 'failed';
      } catch (error) {
        failureReason = error.message;
        status = payload.context ? 'partial' : 'failed';
      }
    }

    store.saveContextSync({
      syncId,
      userId: payload.userId,
      sourceNodeId: payload.sourceNodeId ?? null,
      receiverParticipantId: participantId,
      status: 'acked',
      payload,
      wipBranch: payload.wipBranch ?? null,
      latestRef: payload.latestRef ?? null,
      wipCommitSha: payload.wipCommitSha ?? null,
      expiresAt: payload.expiresAt,
      ackedAt: toIso(callNow(now)),
      lastError: failureReason,
    });

    sendContextSyncAck({
      syncId,
      toParticipantId: event.fromParticipantId,
      status,
      wipVerified,
      failureReason,
    });
    loadedSyncKeys.add(dedupeKey);

    return {
      syncId,
      status,
      wipVerified,
      loadedReadOnly: true,
      appliedToWorktree: false,
      isolation,
      failureReason,
      displayText: buildDisplayText({ payload, status, wipVerified, isolation, failureReason }),
    };
  }

  return {
    prepareCheckpoint,
    explicitSync,
    emitLatestPreparedCheckpoint,
    loadContextSyncRequest,
    markAcked,
  };
}
