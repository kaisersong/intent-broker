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

export function createBrokerService({ dbPath }) {
  const participants = new Map();
  const aliases = new Map();
  const workStates = new Map();
  const store = createEventStore({ dbPath });
  const presence = createPresenceTracker();
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

  return {
    registerParticipant(participant) {
      const existing = participants.get(participant.participantId);
      const normalized = {
        participantId: participant.participantId,
        kind: participant.kind,
        roles: participant.roles || [],
        capabilities: participant.capabilities || [],
        alias: assignUniqueAlias(
          participant.participantId,
          deriveAliasBase({
            ...participant,
            alias: participant.alias || existing?.alias
          }),
          existing?.alias || null
        ),
        context: participant.context || {}
      };
      participants.set(normalized.participantId, normalized);
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
        this.sendIntent({
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
      const recipients = resolveRecipients(input.fromParticipantId, input.to);
      const payload = {
        ...input.payload,
        participantId: input.payload?.participantId ?? input.fromParticipantId
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

      // Notify recipients via WebSocket
      for (const recipientId of recipients) {
        const recipient = participants.get(recipientId);
        const notification = recipient?.kind === 'mobile'
          ? this.formatMobileNotification(event)
          : { type: 'new_intent', event };
        wsNotifier.notify(recipientId, notification);
      }

      return { eventId: event.eventId, recipients };
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

      return this.sendIntent({
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
      return presence.updatePresence(participantId, status, metadata);
    },
    getPresence(participantId) {
      return presence.getPresence(participantId);
    },
    listPresence() {
      return presence.listPresence();
    },
    attachWebSocket(httpServer) {
      wsNotifier.attachToServer(httpServer);
    },
    getWebSocketNotifier() {
      return wsNotifier;
    },
    formatMobileNotification(event) {
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
        body: event.kind,
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
  };
}
