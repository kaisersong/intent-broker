import { reduceEventStream } from '../domain/reducer.js';
import { createEventStore } from '../store/event-store.js';

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
        capabilities: participant.capabilities || []
      };
      participants.set(normalized.participantId, normalized);
      return normalized;
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
      return { eventId: event.eventId, recipients };
    },
    readInbox(participantId, options) {
      return store.readInbox(participantId, options);
    },
    ackInbox(participantId, eventId) {
      return store.ackInbox(participantId, eventId);
    },
    respondApproval({ approvalId, taskId, fromParticipantId, decision, completesTask = false }) {
      return this.sendIntent({
        intentId: `approval-${approvalId}-${decision}-${Date.now()}`,
        kind: 'respond_approval',
        fromParticipantId,
        taskId,
        threadId: null,
        to: { mode: 'participant', participants: [] },
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
    }
  };
}
