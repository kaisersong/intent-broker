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

  return {
    registerParticipant(participant) {
      const normalized = {
        participantId: participant.participantId,
        kind: participant.kind,
        roles: participant.roles || [],
        capabilities: participant.capabilities || [],
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
      return store.readInbox(participantId, options);
    },
    readMobileInbox(participantId, options) {
      const inbox = store.readInbox(participantId, options);
      const humanActionKinds = ['request_approval', 'ask_clarification', 'request_task'];
      return {
        ...inbox,
        items: inbox.items.filter(event => humanActionKinds.includes(event.kind))
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
        events: store.listEvents({ threadId })
      };
    },
    replayEvents(options) {
      return {
        items: store.listEvents(options)
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
