import { reduceEventStream } from '../domain/reducer.js';
import { validateBrokerIntent } from '../domain/validators.js';
import { createEventStore } from '../store/event-store.js';
import { createPresenceTracker } from './presence.js';
import { createWebSocketNotifier } from './websocket.js';

function unique(values) {
  return Array.from(new Set(values));
}

function toReducerEvent(event) {
  return {
    kind: event.kind,
    taskId: event.taskId,
    threadId: event.threadId,
    participantId: event.payload.participantId,
    assignmentMode: event.payload.assignmentMode,
    submissionId: event.payload.submissionId,
    approvalId: event.payload.approvalId,
    approvalScope: event.payload.approvalScope,
    decision: event.payload.decision,
    completesTask: event.payload.completesTask,
    stage: event.payload.stage
  };
}

// Default delivery.semantic hint when a caller does not set one explicitly.
// This is metadata only — the broker does not gate inbox membership on it.
// reply_message is intentionally absent: its handling (interrupt vs not) is an
// orchestration/consumer concern, and callers set semantic explicitly when needed.
const ACTIONABLE_INTENT_KINDS = new Set([
  'request_task',
  'ask_clarification',
  'request_approval'
]);

function deriveDeliverySemantic({ kind, fromParticipant }) {
  if (fromParticipant?.kind === 'human') {
    return 'actionable';
  }

  if (ACTIONABLE_INTENT_KINDS.has(kind)) {
    return 'actionable';
  }

  return 'informational';
}

function buildApprovalListItem(approval, originEvent) {
  const payload = originEvent?.payload && typeof originEvent.payload === 'object'
    ? originEvent.payload
    : {};
  const body = payload.body && typeof payload.body === 'object'
    ? payload.body
    : {};

  return {
    approvalId: approval.approvalId,
    taskId: approval.taskId,
    threadId: originEvent?.threadId ?? null,
    createdAt: originEvent?.timestamp ?? null,
    summary: body.summary ?? payload.summary ?? null,
    decision: approval.status,
    participantId: originEvent?.fromParticipantId ?? null,
    actions: Array.isArray(payload.actions) ? payload.actions : [],
    detailText: body.detailText ?? null,
    commandTitle: body.commandTitle ?? null,
    commandLine: body.commandLine ?? null,
    commandPreview: body.commandPreview ?? null,
    body: payload
  };
}

export function createBrokerService({
  dbPath,
  presenceTimeoutMs = 600000,
  presenceSweepIntervalMs = 5000,
  websocketHeartbeatIntervalMs = 30000,
  offlineContextSyncEmitter = null
}) {
  const participants = new Map();
  const aliases = new Map();
  const logicalParticipants = new Map();
  const workStates = new Map();
  const store = createEventStore({ dbPath });
  const presence = createPresenceTracker({ timeoutMs: presenceTimeoutMs });
  const wsNotifier = createWebSocketNotifier({
    heartbeatIntervalMs: websocketHeartbeatIntervalMs
  });
  let awayMode = false;

  const TASK_UNACK_THRESHOLD_MS = 5 * 60 * 1000;
  const TASK_UNACK_DEDUP_MS = 30 * 60 * 1000;
  const watchdogTimers = new Map();

  function scheduleWatchdog(taskId, delayMs) {
    if (watchdogTimers.has(taskId)) return;
    const timer = setTimeout(() => {
      watchdogTimers.delete(taskId);
      checkAndNotifyUnacked(taskId);
    }, delayMs).unref();
    watchdogTimers.set(taskId, timer);
  }

  function checkAndNotifyUnacked(taskId) {
    const state = buildState();
    const task = state.tasks[taskId];
    if (!task || task.status !== 'open') return;

    const events = store.listEvents({ taskId, limit: null });
    const latestEvent = events[events.length - 1];
    if (!latestEvent) return;

    const unackedEvents = events.filter((e) => e.kind === 'task_unacked');
    if (unackedEvents.length) {
      const lastUnacked = unackedEvents[unackedEvents.length - 1];
      const ageSinceLastUnacked = Date.now() - new Date(lastUnacked.createdAt).getTime();
      if (ageSinceLastUnacked < TASK_UNACK_DEDUP_MS) return;
    }

    const requestEvent = events.find((e) => e.kind === 'request_task');
    const targetParticipantIds = (requestEvent?.payload?.delivery?.targetParticipantIds) || [];

    const pmParticipantIds = [...participants.values()]
      .filter((p) => p.roles.includes('governance-pm'))
      .map((p) => p.participantId);

    const recipients = unique([...pmParticipantIds]);
    if (!recipients.length) return;

    const now = new Date();
    const ageMs = now.getTime() - new Date(latestEvent.createdAt).getTime();

    sendIntentInternal({
      intentId: `task-unacked-${taskId}-${Date.now()}`,
      kind: 'task_unacked',
      fromParticipantId: 'broker.system',
      taskId,
      threadId: task.threadId,
      to: { mode: 'participant', participants: recipients },
      payload: {
        taskId,
        threadId: task.threadId,
        ageMs,
        requesterId: requestEvent?.fromParticipantId ?? null,
        targetParticipantIds
      }
    });
  }

  function reconcileWatchdogs() {
    const state = buildState();
    const now = Date.now();
    for (const [taskId, task] of Object.entries(state.tasks)) {
      if (task.status !== 'open') continue;
      const events = store.listEvents({ taskId, limit: null });
      const latestEvent = events[events.length - 1];
      if (!latestEvent) continue;

      const requestEvent = events.find((e) => e.kind === 'request_task');
      if (!requestEvent) continue;
      const hasTargetedDelivery = requestEvent.payload?.delivery?.targetParticipantIds?.length > 0;
      if (!hasTargetedDelivery) continue;

      const age = now - new Date(latestEvent.createdAt).getTime();
      if (age > TASK_UNACK_THRESHOLD_MS) {
        checkAndNotifyUnacked(taskId);
      } else {
        scheduleWatchdog(taskId, TASK_UNACK_THRESHOLD_MS - age);
      }
    }
  }

  const watchdogReconcileTimer = setTimeout(reconcileWatchdogs, 30_000).unref();
  const watchdogPeriodicTimer = setInterval(reconcileWatchdogs, TASK_UNACK_THRESHOLD_MS).unref();

  // Resolve a single target token into recipient sessionIds.
  // Explicit namespaces remove ambiguity:
  //   session:<id>  -> exact participant only
  //   logical:<id>  -> fan-out to all sessions under a logical id (explicit broadcast)
  //   alias:<name> / @name -> alias lookup only
  // Bare tokens resolve exact sessionId, then alias. Bare tokens never implicitly
  // fan-out via logical id: broadcast must be explicit. This is the broker's only
  // job here — turn a token into addresses and report how it resolved. It does not
  // decide who *should* act; that is the orchestration layer's concern.
  function resolveTargetToken(fromParticipantId, rawToken) {
    const token = String(rawToken || '').trim();
    const matched = token.match(/^(session|logical|alias):(.+)$/i);
    const scheme = matched ? matched[1].toLowerCase() : (token.startsWith('@') ? 'alias' : null);
    const value = matched ? matched[2].trim() : token.replace(/^@/, '');
    const drop = (ids) => ids.filter((id) => id && id !== fromParticipantId);

    if (scheme === 'session') {
      return { kind: 'session', recipients: drop(participants.has(value) ? [value] : []), token };
    }
    if (scheme === 'logical') {
      const set = logicalParticipants.get(value);
      return { kind: 'logical', recipients: drop(set ? [...set] : []), token };
    }
    if (scheme === 'alias') {
      const byAlias = aliases.get(aliasKey(value));
      return { kind: 'alias', recipients: drop(byAlias ? [byAlias] : []), token };
    }

    if (participants.has(value)) {
      return { kind: 'session', recipients: drop([value]), token };
    }
    const byAlias = aliases.get(aliasKey(value));
    if (byAlias) {
      return { kind: 'alias', recipients: drop([byAlias]), token };
    }
    return { kind: 'unresolved', recipients: drop([value]), token };
  }

  function resolveParticipantTargets(fromParticipantId, tokens = []) {
    const resolutions = tokens.map((token) => resolveTargetToken(fromParticipantId, token));
    const recipients = unique(resolutions.flatMap((entry) => entry.recipients));
    return { recipients, resolutions };
  }

  function resolveRecipients(fromParticipantId, to = { mode: 'broadcast' }) {
    if (to.mode === 'participant') {
      return resolveParticipantTargets(fromParticipantId, to.participants || []).recipients;
    }

    if (to.mode === 'role') {
      return unique(
        [...participants.values()]
          .filter((participant) => participant.participantId !== fromParticipantId)
          .filter((participant) => (to.roles || []).some((role) => participant.roles.includes(role)))
          .map((participant) => participant.participantId)
      );
    }

    if (to.mode === 'capability') {
      return unique(
        [...participants.values()]
          .filter((participant) => participant.participantId !== fromParticipantId)
          .filter((participant) => (to.capabilities || []).some((capability) => participant.capabilities.includes(capability)))
          .map((participant) => participant.participantId)
      );
    }

    return unique(
      [...participants.values()]
        .filter((participant) => participant.participantId !== fromParticipantId)
        .map((participant) => participant.participantId)
    );
  }

  function buildState() {
    return reduceEventStream(store.listEvents({ limit: null }).map(toReducerEvent));
  }

  function normalizeAlias(alias) {
    return String(alias || '')
      .trim()
      .replace(/^@+/, '')
      .replace(/\s+/g, '-');
  }

  function aliasKey(alias) {
    return normalizeAlias(alias).toLowerCase();
  }

  function deriveAliasBase(participant) {
    const explicitAlias = normalizeAlias(participant.alias);
    if (explicitAlias) {
      return explicitAlias;
    }

    const participantId = String(participant.participantId || '');
    const loweredId = participantId.toLowerCase();

    if (loweredId.startsWith('claude-code')) {
      return 'claude';
    }
    if (loweredId.startsWith('codex')) {
      return 'codex';
    }
    if (loweredId.startsWith('opencode')) {
      return 'opencode';
    }
    if (loweredId.startsWith('xiaok-code')) {
      return 'xiaok';
    }
    if (loweredId.startsWith('human.')) {
      return 'human';
    }
    if (loweredId.startsWith('adapter.')) {
      return loweredId.split('.').at(-1) || 'adapter';
    }

    return participantId.split(/[._-]/).find(Boolean) || 'participant';
  }

  function hasNonEmptyMetadataValue(value) {
    return !(value === null || value === undefined || (typeof value === 'string' && value.trim() === ''));
  }

  function normalizeParticipantMetadata(metadata, existingMetadata) {
    const merged = metadata && typeof metadata === 'object'
      ? { ...(existingMetadata || {}), ...metadata }
      : { ...(existingMetadata || {}) };

    for (const key of ['sessionHint', 'terminalTTY', 'terminalSessionID']) {
      if (!hasNonEmptyMetadataValue(metadata?.[key]) && hasNonEmptyMetadataValue(existingMetadata?.[key])) {
        merged[key] = existingMetadata[key];
      }
    }

    return merged;
  }

  function normalizeComparableMetadataPath(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  }

  function sanitizeConflictingGhosttyLocator(participantId, metadata) {
    if (metadata?.terminalApp !== 'Ghostty' || !hasNonEmptyMetadataValue(metadata?.terminalSessionID)) {
      return metadata;
    }

    const incomingSessionId = String(metadata.terminalSessionID).trim();
    const incomingTTY = hasNonEmptyMetadataValue(metadata.terminalTTY)
      ? String(metadata.terminalTTY).trim()
      : null;
    const incomingProjectPath = normalizeComparableMetadataPath(metadata.projectPath);

    for (const existing of participants.values()) {
      if (existing.participantId === participantId) {
        continue;
      }

      const existingMetadata = existing.metadata || {};
      if (existingMetadata.terminalApp !== 'Ghostty') {
        continue;
      }

      if (String(existingMetadata.terminalSessionID || '').trim() !== incomingSessionId) {
        continue;
      }

      const existingTTY = hasNonEmptyMetadataValue(existingMetadata.terminalTTY)
        ? String(existingMetadata.terminalTTY).trim()
        : null;
      const existingProjectPath = normalizeComparableMetadataPath(existingMetadata.projectPath);
      const ttyConflict = incomingTTY && existingTTY && incomingTTY !== existingTTY;
      const pathConflict = incomingProjectPath && existingProjectPath && incomingProjectPath !== existingProjectPath;

      if (!ttyConflict && !pathConflict) {
        continue;
      }

      const sanitized = {
        ...metadata,
        terminalSessionID: null
      };

      if (sanitized.sessionHint === incomingSessionId) {
        sanitized.sessionHint = null;
      }

      return sanitized;
    }

    return metadata;
  }

  function alignGhosttySessionHint(metadata, alias) {
    if (metadata?.terminalApp !== 'Ghostty') {
      return metadata;
    }

    if (hasNonEmptyMetadataValue(metadata.terminalSessionID)) {
      return metadata;
    }

    return {
      ...metadata,
      sessionHint: alias || null
    };
  }

  function releaseAlias(alias, participantId) {
    const key = aliasKey(alias);
    if (aliases.get(key) === participantId) {
      aliases.delete(key);
    }
  }

  function shouldPruneOfflineParticipant(participantId, metadata = {}) {
    const participant = participants.get(participantId);
    if (!participant || participant.kind !== 'agent') {
      return false;
    }

    if (metadata?.transport === 'websocket') {
      return false;
    }

    if (participant.metadata?.fromRelay && metadata?.fromRelay) {
      return true;
    }

    return metadata?.reason === 'timeout' || metadata?.reason === 'parent-exit';
  }

  function pruneParticipant(participantId) {
    const participant = participants.get(participantId);
    if (!participant) {
      return false;
    }

    releaseAlias(participant.alias, participantId);
    if (participant.logicalParticipantId) {
      const sessions = logicalParticipants.get(participant.logicalParticipantId);
      if (sessions) {
        sessions.delete(participantId);
        if (sessions.size === 0) logicalParticipants.delete(participant.logicalParticipantId);
      }
    }
    participants.delete(participantId);
    workStates.delete(participantId);
    return true;
  }

  function assignUniqueAlias(participantId, requestedAlias, currentAlias = null) {
    const base = normalizeAlias(requestedAlias) || 'participant';
    let candidate = base;
    let suffix = 2;

    while (true) {
      const key = aliasKey(candidate);
      const owner = aliases.get(key);
      if (!owner || owner === participantId) {
        if (currentAlias && currentAlias !== candidate) {
          releaseAlias(currentAlias, participantId);
        }
        aliases.set(key, participantId);
        return candidate;
      }

      candidate = `${base}${suffix}`;
      suffix += 1;
    }
  }

  function normalizeWorkState(participantId, state) {
    const participant = participants.get(participantId);
    if (!participant) {
      throw new Error(`participant_not_found:${participantId}`);
    }

    return {
      participantId,
      projectName: participant.context?.projectName ?? null,
      status: state.status,
      summary: state.summary ?? null,
      taskId: state.taskId ?? null,
      threadId: state.threadId ?? null,
      updatedAt: state.updatedAt ?? new Date().toISOString()
    };
  }

  function enrichEvent(event) {
    const sender = participants.get(event.fromParticipantId);

    return {
      ...event,
      fromAlias: sender?.alias ?? null,
      fromProjectName: sender?.context?.projectName ?? null
    };
  }

  function formatPresenceSummary(participant, status) {
    const subject = participant.alias ? `@${participant.alias}` : participant.participantId;
    const projectName = participant.context?.projectName ? `，项目 ${participant.context.projectName}` : '';
    if (status === 'online') {
      return `${subject} 已上线${projectName}`;
    }
    if (status === 'offline') {
      return `${subject} 已离线${projectName}`;
    }
    return `${subject} 状态更新为 ${status}${projectName}`;
  }

  function sendIntentInternal(input) {
    const validation = validateBrokerIntent(input);
    if (!validation.ok) {
      const error = new Error(validation.error);
      error.validation = validation;
      throw error;
    }

    const intentId = input.intentId || `${input.fromParticipantId}-${input.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const participantResolution = input.to?.mode === 'participant'
      ? resolveParticipantTargets(input.fromParticipantId, input.to.participants || [])
      : null;
    const recipients = participantResolution
      ? participantResolution.recipients
      : resolveRecipients(input.fromParticipantId, input.to);
    const sender = participants.get(input.fromParticipantId);
    const delivery = {
      semantic: input.payload?.delivery?.semantic ?? deriveDeliverySemantic({
        kind: input.kind,
        fromParticipant: sender
      }),
      source: input.payload?.delivery?.source ?? 'default',
      ...(input.to?.mode === 'participant' ? { targetParticipantIds: recipients } : {})
    };
    const payload = {
      ...input.payload,
      participantId: input.payload?.participantId ?? input.fromParticipantId,
      delivery
    };
    const event = store.appendIntent({
      intentId,
      kind: input.kind,
      fromParticipantId: input.fromParticipantId,
      taskId: input.taskId || null,
      threadId: input.threadId || null,
      payload,
      recipients
    });

    const onlineRecipients = [];
    const offlineRecipients = [];

    for (const recipientId of recipients) {
      const recipient = participants.get(recipientId);
      const notification = recipient?.kind === 'mobile'
        ? formatMobileNotification(event)
        : { type: 'new_intent', event: enrichEvent(event) };
      const sent = wsNotifier.notify(recipientId, notification);
      if (sent > 0) {
        onlineRecipients.push(recipientId);
      } else {
        offlineRecipients.push(recipientId);
      }
    }

    if (input.kind === 'request_task' && input.to?.mode === 'participant' && input.taskId) {
      scheduleWatchdog(input.taskId, TASK_UNACK_THRESHOLD_MS);
    }

    return {
      eventId: event.eventId,
      recipients,
      onlineRecipients,
      offlineRecipients,
      deliveredCount: onlineRecipients.length,
      ...(participantResolution ? { resolutions: participantResolution.resolutions } : {})
    };
  }

  function listTasks({ status, assignee } = {}) {
    const state = buildState();
    const entries = Object.values(state.tasks).filter((task) => {
      if (status && task.status !== status) return false;
      if (assignee && !task.assignees.includes(assignee)) return false;
      return true;
    });
    return entries.map((task) => {
      const events = store.listEvents({ taskId: task.taskId, limit: null });
      const latestEvent = events[events.length - 1];
      const requestEvent = events.find((e) => e.kind === 'request_task');
      const latestEventAt = latestEvent?.createdAt ?? null;
      const ageMs = latestEventAt
        ? Date.now() - new Date(latestEventAt).getTime()
        : null;
      return {
        taskId: task.taskId,
        threadId: task.threadId,
        status: task.status,
        assignees: task.assignees,
        latestSubmissionId: task.latestSubmissionId,
        latestEventKind: latestEvent?.kind ?? null,
        latestEventAt,
        ageMs,
        requesterId: requestEvent?.fromParticipantId ?? null
      };
    });
  }

  function broadcastPresenceChange(participantId, status, previousStatus) {
    const participant = participants.get(participantId);
    if (!participant || previousStatus === status) {
      return;
    }

    const recipients = [...participants.keys()].filter((id) => id !== participantId);
    if (!recipients.length) {
      return;
    }

    sendIntentInternal({
      intentId: `participant-presence-${participantId}-${status}-${Date.now()}`,
      kind: 'participant_presence_updated',
      fromParticipantId: 'broker.system',
      taskId: null,
      threadId: null,
      to: { mode: 'participant', participants: recipients },
      payload: {
        participantId,
        alias: participant.alias ?? null,
        status,
        previousStatus,
        participantKind: participant.kind,
        projectName: participant.context?.projectName ?? null,
        roles: participant.roles ?? [],
        capabilities: participant.capabilities ?? [],
        body: {
          summary: formatPresenceSummary(participant, status)
        }
      }
    });
  }

  function broadcastParticipantRolesChange(participantId) {
    const participant = participants.get(participantId);
    if (!participant) {
      return;
    }

    const recipients = [...participants.keys()].filter((id) => id !== participantId);
    const status = presence.getPresence(participantId)?.status ?? 'online';

    sendIntentInternal({
      intentId: `participant-roles-${participantId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'participant_presence_updated',
      fromParticipantId: 'broker.system',
      taskId: null,
      threadId: null,
      to: { mode: 'participant', participants: recipients },
      payload: {
        participantId,
        alias: participant.alias ?? null,
        status,
        previousStatus: status,
        participantKind: participant.kind,
        projectName: participant.context?.projectName ?? null,
        roles: participant.roles ?? [],
        capabilities: participant.capabilities ?? [],
        body: {
          summary: `@${participant.alias ?? participantId} 角色已更新`
        }
      }
    });
  }

  function setPresence(participantId, status, metadata = {}) {
    const previousEffectiveStatus = presence.getPresence(participantId)?.status ?? 'offline';
    const previousStoredStatus = presence.peekPresence(participantId)?.status ?? 'offline';
    const previousStatus = status === 'offline' ? previousStoredStatus : previousEffectiveStatus;
    const next = presence.updatePresence(participantId, status, metadata);
    broadcastPresenceChange(participantId, next.status, previousStatus);

    if (status === 'offline' && typeof offlineContextSyncEmitter === 'function') {
      try {
        offlineContextSyncEmitter({
          participantId,
          metadata,
          sendIntent: sendIntentInternal
        });
      } catch {
        // Offline context sync is best-effort and must not block presence.
      }
    }

    if (status === 'offline' && shouldPruneOfflineParticipant(participantId, metadata)) {
      pruneParticipant(participantId);
    }

    return next;
  }

  function sweepStalePresence() {
    for (const item of presence.listPresence()) {
      const raw = presence.peekPresence(item.participantId);
      if (!raw) {
        continue;
      }

      if (item.status === 'offline' && raw.status !== 'offline') {
        setPresence(item.participantId, 'offline', {
          ...raw.metadata,
          reason: 'timeout'
        });
      }
    }
  }

  const presenceSweepTimer = presenceSweepIntervalMs > 0
    ? setInterval(sweepStalePresence, presenceSweepIntervalMs)
    : null;
  presenceSweepTimer?.unref?.();

  function formatMobileNotification(event) {
    const notificationMap = {
      request_approval: {
        title: '需要审批',
        body: event.payload.body?.summary || '有新的审批请求',
        action: 'approve',
        data: { approvalId: event.payload.approvalId, taskId: event.taskId }
      },
      ask_clarification: {
        title: '需要澄清',
        body: event.payload.body?.summary || '有问题需要回答',
        action: 'clarify',
        data: { taskId: event.taskId, threadId: event.threadId }
      },
      request_task: {
        title: '新任务',
        body: event.payload.body?.summary || '收到新任务',
        action: 'view_task',
        data: { taskId: event.taskId }
      }
    };

    const notification = notificationMap[event.kind] || {
      title: '新消息',
      body: event.payload.body?.summary || event.kind,
      action: 'view',
      data: { eventId: event.eventId }
    };

    return {
      type: 'mobile_notification',
      eventId: event.eventId,
      timestamp: event.timestamp,
      ...notification
    };
  }

  return {
    registerParticipant(participant) {
      const isFromRelay = participant.metadata?.fromRelay === true;
      const existing = participants.get(participant.participantId);
      const rawAlias = existing?.alias || participant.alias;
      const preferredAlias = isFromRelay ? rawAlias : String(rawAlias || '').replace(/:/g, '');
      const normalizedAlias = assignUniqueAlias(
        participant.participantId,
        deriveAliasBase({
          ...participant,
          alias: preferredAlias
        }),
        existing?.alias || null
      );
      const incomingRoles = participant.roles || [];
      const persistedRoles = store.getParticipantRoles(participant.participantId);
      const newRoles = incomingRoles.filter((role) => !persistedRoles.includes(role));
      if (newRoles.length) {
        store.addParticipantRoles(participant.participantId, newRoles);
      }
      const mergedRoles = unique([...persistedRoles, ...incomingRoles]);
      const normalized = {
        participantId: participant.participantId,
        kind: participant.kind,
        roles: mergedRoles,
        capabilities: participant.capabilities || [],
        alias: normalizedAlias,
        inboxMode: participant.inboxMode ?? existing?.inboxMode ?? null,
        context: participant.context || {},
        metadata: alignGhosttySessionHint(
          sanitizeConflictingGhosttyLocator(
            participant.participantId,
            normalizeParticipantMetadata(
              participant.metadata,
              existing?.metadata
            )
          ),
          normalizedAlias
        )
      };
      participants.set(normalized.participantId, normalized);

      const logicalId = participant.logicalParticipantId || null;
      if (logicalId) {
        normalized.logicalParticipantId = logicalId;
        if (!logicalParticipants.has(logicalId)) {
          logicalParticipants.set(logicalId, new Set());
        }
        logicalParticipants.get(logicalId).add(normalized.participantId);
      }

      setPresence(normalized.participantId, 'online', {
        source: 'registration',
        kind: normalized.kind,
        projectName: normalized.context?.projectName ?? null
      });
      return normalized;
    },
    listParticipants({ projectName, role } = {}) {
      return [...participants.values()].filter((participant) => {
        if (projectName && participant.context?.projectName !== projectName) {
          return false;
        }
        if (role && !participant.roles.includes(role)) {
          return false;
        }
        return true;
      });
    },
    resolveParticipantsByAliases(aliasList = []) {
      const participantsByAlias = [];
      const missingAliases = [];

      for (const rawAlias of aliasList) {
        const key = aliasKey(rawAlias);
        const participantId = aliases.get(key);
        if (!participantId) {
          missingAliases.push(normalizeAlias(rawAlias));
          continue;
        }

        const participant = participants.get(participantId);
        if (participant) {
          participantsByAlias.push(participant);
        }
      }

      return {
        participants: participantsByAlias,
        missingAliases
      };
    },
    updateParticipantAlias(participantId, requestedAlias) {
      const participant = participants.get(participantId);
      if (!participant) {
        throw new Error(`participant_not_found:${participantId}`);
      }

      const sanitizedAlias = String(requestedAlias || '').replace(/:/g, '');
      const previousAlias = participant.alias;
      const nextAlias = assignUniqueAlias(participantId, sanitizedAlias, previousAlias);
      participant.alias = nextAlias;
      participant.metadata = alignGhosttySessionHint(participant.metadata, nextAlias);

      if (previousAlias !== nextAlias) {
        sendIntentInternal({
          intentId: `participant-alias-updated-${participantId}-${Date.now()}`,
          kind: 'participant_alias_updated',
          fromParticipantId: 'broker.system',
          taskId: null,
          threadId: null,
          to: { mode: 'participant', participants: [...participants.keys()] },
          payload: {
            participantId,
            alias: nextAlias,
            previousAlias,
            body: {
              summary: `${participantId} alias updated: ${previousAlias} -> ${nextAlias}`
            }
          }
        });
      }

      return participant;
    },
    addParticipantRoles(participantId, roles) {
      const participant = participants.get(participantId);
      if (!participant) {
        throw new Error(`participant_not_found:${participantId}`);
      }
      const added = roles.filter((r) => !participant.roles.includes(r));
      if (added.length) {
        store.addParticipantRoles(participantId, added);
        participant.roles = unique([...participant.roles, ...roles]);
        broadcastParticipantRolesChange(participantId);
      }
      return { participantId, roles: participant.roles, added };
    },
    removeParticipantRoles(participantId, roles) {
      const participant = participants.get(participantId);
      if (!participant) {
        throw new Error(`participant_not_found:${participantId}`);
      }
      const removed = roles.filter((r) => participant.roles.includes(r));
      if (removed.length) {
        store.removeParticipantRoles(participantId, removed);
        participant.roles = participant.roles.filter((r) => !roles.includes(r));
        broadcastParticipantRolesChange(participantId);
      }
      return { participantId, roles: participant.roles, removed };
    },
    updateWorkState(participantId, state) {
      const normalized = normalizeWorkState(participantId, state);
      workStates.set(participantId, normalized);
      setPresence(participantId, 'online', {
        source: 'work-state',
        status: normalized.status,
        projectName: normalized.projectName
      });
      return normalized;
    },
    getWorkState(participantId) {
      return workStates.get(participantId) ?? null;
    },
    listWorkStates({ participantId, projectName, status } = {}) {
      return [...workStates.values()].filter((item) => {
        if (participantId && item.participantId !== participantId) {
          return false;
        }
        if (projectName && item.projectName !== projectName) {
          return false;
        }
        if (status && item.status !== status) {
          return false;
        }
        return true;
      });
    },
    sendIntent(input) {
      return sendIntentInternal(input);
    },
    readInbox(participantId, options = {}) {
      const { semantic = null, kind = null, ...storeOptions } = options;
      const inbox = store.readInbox(participantId, storeOptions);
      const kinds = kind == null ? null : new Set(Array.isArray(kind) ? kind : [kind]);
      const items = inbox.items
        .filter((event) => (kinds ? kinds.has(event.kind) : true))
        .filter((event) => (semantic ? event.payload?.delivery?.semantic === semantic : true))
        .map(enrichEvent);
      return { ...inbox, items };
    },
    readMobileInbox(participantId, options) {
      const inbox = store.readInbox(participantId, options);
      const humanActionKinds = ['request_approval', 'ask_clarification', 'request_task'];
      return {
        ...inbox,
        items: inbox.items.filter(event => humanActionKinds.includes(event.kind)).map(enrichEvent)
      };
    },
    ackInbox(participantId, eventId) {
      return store.ackInbox(participantId, eventId);
    },
    respondApproval({ approvalId, taskId, fromParticipantId, decision, decisionMode = null, nativeDecision = null, completesTask = false }) {
      const task = this.getTaskView(taskId);
      const assignees = task?.assignees || [];

      // Find the original request_approval event to include its requester as a recipient
      const originEvent = store.listEvents({ taskId, limit: null })
        .find((e) => e.kind === 'request_approval' && e.payload?.approvalId === approvalId);
      const requester = originEvent?.fromParticipantId ?? null;

      const recipients = unique([...assignees, ...(requester && requester !== fromParticipantId ? [requester] : [])]);

      return sendIntentInternal({
        intentId: `approval-${approvalId}-${decision}-${Date.now()}`,
        kind: 'respond_approval',
        fromParticipantId,
        taskId,
        threadId: null,
        to: { mode: 'participant', participants: recipients },
        payload: {
          approvalId,
          decision,
          ...(decisionMode ? { decisionMode } : {}),
          ...(nativeDecision !== null && nativeDecision !== undefined ? { nativeDecision } : {}),
          completesTask
        }
      });
    },
    getApprovalView(approvalId) {
      return buildState().approvals[approvalId] ?? null;
    },
    getTaskView(taskId) {
      return buildState().tasks[taskId] ?? null;
    },
    listTasks(options) {
      return listTasks(options);
    },
    reconcileWatchdogs() {
      reconcileWatchdogs();
    },
    getThreadView(threadId) {
      return {
        threadId,
        events: store.listEvents({ threadId }).map(enrichEvent)
      };
    },
    replayEvents(options) {
      return {
        items: store.listEvents(options).map(enrichEvent)
      };
    },
    updatePresence(participantId, status, metadata) {
      return setPresence(participantId, status, metadata);
    },
    getPresence(participantId) {
      return presence.getPresence(participantId);
    },
    listPresence() {
      return presence.listPresence();
    },
    sweepPresence() {
      sweepStalePresence();
    },
    attachWebSocket(httpServer) {
      wsNotifier.attachToServer(httpServer, {
        onConnect: ({ participantId, connectionCount }) => {
          setPresence(participantId, 'online', {
            transport: 'websocket',
            connectionCount
          });
        },
        onHeartbeat: ({ participantId, connectionCount }) => {
          setPresence(participantId, 'online', {
            transport: 'websocket',
            connectionCount
          });
        },
        onDisconnect: ({ participantId, connectionCount }) => {
          setPresence(participantId, 'offline', {
            transport: 'websocket',
            connectionCount
          });
        }
      });
    },
    getWebSocketNotifier() {
      return wsNotifier;
    },
    setAwayMode(value) {
      awayMode = Boolean(value);
    },
    getAwayMode() {
      return awayMode;
    },
    getProjectSnapshot(projectName, { recentLimit = 20 } = {}) {
      const projectParticipants = this.listParticipants({ projectName });
      const presenceItems = new Map(presence.listPresence().map((item) => [item.participantId, item]));
      const workStateItems = new Map(this.listWorkStates({ projectName }).map((item) => [item.participantId, item]));
      const pendingApprovalCount = this.listProjectApprovals(projectName, { status: 'pending' }).length;
      const recentEvents = store.listEvents({ limit: recentLimit })
        .filter((item) => {
          const sender = participants.get(item.fromParticipantId);
          return sender?.context?.projectName === projectName;
        })
        .map(enrichEvent);

      const projectedParticipants = projectParticipants.map((participant) => ({
        participantId: participant.participantId,
        alias: participant.alias,
        kind: participant.kind,
        projectName,
        presence: presenceItems.get(participant.participantId)?.status || 'offline',
        workState: workStateItems.get(participant.participantId) || null
      }));

      return {
        projectName,
        counts: {
          online: projectedParticipants.filter((item) => item.presence === 'online').length,
          busy: projectedParticipants.filter((item) => item.workState?.status === 'implementing').length,
          blocked: projectedParticipants.filter((item) => item.workState?.status === 'blocked').length,
          pendingApproval: pendingApprovalCount
        },
        participants: projectedParticipants,
        recentEvents
      };
    },
    listProjectApprovals(projectName, { status = null } = {}) {
      const state = buildState();
      const approvalEvents = new Map(
        store.listEvents({ limit: null }).filter((e) => e.kind === 'request_approval').map((e) => [e.payload.approvalId, e])
      );
      return Object.values(state.approvals).filter((approval) => {
        const originEvent = approvalEvents.get(approval.approvalId);
        const fromParticipantId = originEvent?.fromParticipantId;
        const sender = fromParticipantId ? participants.get(fromParticipantId) : null;
        const matchesProject = !projectName || sender?.context?.projectName === projectName;
        const matchesStatus = !status || approval.status === status;
        return matchesProject && matchesStatus;
      }).map((approval) => buildApprovalListItem(approval, approvalEvents.get(approval.approvalId)));
    },
    close() {
      if (presenceSweepTimer) {
        clearInterval(presenceSweepTimer);
      }
      clearTimeout(watchdogReconcileTimer);
      clearInterval(watchdogPeriodicTimer);
      for (const timer of watchdogTimers.values()) {
        clearTimeout(timer);
      }
      watchdogTimers.clear();
      wsNotifier.close();
    }
  };
}
