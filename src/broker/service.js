import { reduceEventStream } from '../domain/reducer.js';
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

export function createBrokerService({
  dbPath,
  presenceTimeoutMs = 600000,
  presenceSweepIntervalMs = 5000
}) {
  const participants = new Map();
  const aliases = new Map();
  const workStates = new Map();
  const store = createEventStore({ dbPath });
  const presence = createPresenceTracker({ timeoutMs: presenceTimeoutMs });
  const wsNotifier = createWebSocketNotifier();

  function resolveRecipients(fromParticipantId, to = { mode: 'broadcast' }) {
    if (to.mode === 'participant') {
      return unique((to.participants || []).filter((participantId) => participantId !== fromParticipantId));
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
    return reduceEventStream(store.listEvents().map(toReducerEvent));
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

  function releaseAlias(alias, participantId) {
    const key = aliasKey(alias);
    if (aliases.get(key) === participantId) {
      aliases.delete(key);
    }
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
    const recipients = resolveRecipients(input.fromParticipantId, input.to);
    const sender = participants.get(input.fromParticipantId);
    const delivery = {
      semantic: input.payload?.delivery?.semantic ?? deriveDeliverySemantic({
        kind: input.kind,
        fromParticipant: sender
      }),
      source: input.payload?.delivery?.source ?? 'default'
    };
    const payload = {
      ...input.payload,
      participantId: input.payload?.participantId ?? input.fromParticipantId,
      delivery
    };
    const event = store.appendIntent({
      intentId: input.intentId,
      kind: input.kind,
      fromParticipantId: input.fromParticipantId,
      taskId: input.taskId,
      threadId: input.threadId,
      payload,
      recipients
    });

    const onlineRecipients = [];
    const offlineRecipients = [];

    for (const recipientId of recipients) {
      const recipient = participants.get(recipientId);
      const notification = recipient?.kind === 'mobile'
        ? formatMobileNotification(event)
        : { type: 'new_intent', event };
      const sent = wsNotifier.notify(recipientId, notification);
      if (sent > 0) {
        onlineRecipients.push(recipientId);
      } else {
        offlineRecipients.push(recipientId);
      }
    }

    return {
      eventId: event.eventId,
      recipients,
      onlineRecipients,
      offlineRecipients,
      deliveredCount: onlineRecipients.length
    };
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
        body: {
          summary: formatPresenceSummary(participant, status)
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
      const existing = participants.get(participant.participantId);
      const preferredAlias = existing?.alias || participant.alias;
      const normalized = {
        participantId: participant.participantId,
        kind: participant.kind,
        roles: participant.roles || [],
        capabilities: participant.capabilities || [],
        alias: assignUniqueAlias(
          participant.participantId,
          deriveAliasBase({
            ...participant,
            alias: preferredAlias
          }),
          existing?.alias || null
        ),
        context: participant.context || {}
      };
      participants.set(normalized.participantId, normalized);
      setPresence(normalized.participantId, 'online', {
        source: 'registration',
        kind: normalized.kind,
        projectName: normalized.context?.projectName ?? null
      });
      return normalized;
    },
    listParticipants({ projectName } = {}) {
      return [...participants.values()].filter((participant) => {
        if (!projectName) {
          return true;
        }

        return participant.context?.projectName === projectName;
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

      const previousAlias = participant.alias;
      const nextAlias = assignUniqueAlias(participantId, requestedAlias, previousAlias);
      participant.alias = nextAlias;

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
    readInbox(participantId, options) {
      const inbox = store.readInbox(participantId, options);
      return {
        ...inbox,
        items: inbox.items.map(enrichEvent)
      };
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
    respondApproval({ approvalId, taskId, fromParticipantId, decision, completesTask = false }) {
      // Get task assignees to route approval response
      const task = this.getTaskView(taskId);
      const assignees = task?.assignees || [];

      return sendIntentInternal({
        intentId: `approval-${approvalId}-${decision}-${Date.now()}`,
        kind: 'respond_approval',
        fromParticipantId,
        taskId,
        threadId: null,
        to: { mode: 'participant', participants: assignees },
        payload: { approvalId, decision, completesTask }
      });
    },
    getApprovalView(approvalId) {
      return buildState().approvals[approvalId] ?? null;
    },
    getTaskView(taskId) {
      return buildState().tasks[taskId] ?? null;
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
    close() {
      if (presenceSweepTimer) {
        clearInterval(presenceSweepTimer);
      }
      wsNotifier.close();
    }
  };
}
