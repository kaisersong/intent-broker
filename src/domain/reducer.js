function ensureTask(state, event) {
  if (!state.tasks[event.taskId]) {
    state.tasks[event.taskId] = {
      taskId: event.taskId,
      threadId: event.threadId ?? null,
      status: 'open',
      assignees: [],
      submissions: [],
      duplicateSubmissionIds: [],
      latestSubmissionId: null
    };
  }

  return state.tasks[event.taskId];
}

function ensureApproval(state, event) {
  if (!state.approvals[event.approvalId]) {
    state.approvals[event.approvalId] = {
      approvalId: event.approvalId,
      taskId: event.taskId ?? null,
      status: 'pending',
      scope: event.approvalScope ?? null
    };
  }

  const approval = state.approvals[event.approvalId];
  if (!approval.taskId && event.taskId) {
    approval.taskId = event.taskId;
  }
  if (!approval.scope && event.approvalScope) {
    approval.scope = event.approvalScope;
  }

  return approval;
}

export function reduceEventStream(events) {
  const state = {
    tasks: {},
    approvals: {}
  };

  for (const event of events) {
    const task = event.taskId ? ensureTask(state, event) : null;

    switch (event.kind) {
      case 'request_task':
        if (task) {
          task.status = 'open';
        }
        break;
      case 'accept_task':
        if (task) {
          task.assignees = Array.from(new Set([...task.assignees, event.participantId]));
          task.status = 'assigned';
        }
        break;
      case 'report_progress':
        if (task && event.stage === 'started') {
          task.status = 'in_progress';
        }
        break;
      case 'submit_result':
        if (task) {
          // Idempotent redelivery of the same submissionId is not a race —
          // it is the same fact repeated (e.g. an at-least-once retry) and
          // must not be tracked as a duplicate.
          if (event.submissionId === task.latestSubmissionId) {
            break;
          }
          // A task that already has a canonical submission, or has moved to
          // a terminal state (cancelled), does not accept a second result as
          // truth — the first submission (or the cancellation) stays
          // canonical and the late/racing submission is recorded separately
          // so callers can surface it instead of silently overwriting state.
          if (task.submissions.length > 0 || task.status === 'cancelled') {
            task.duplicateSubmissionIds.push(event.submissionId);
            break;
          }
          task.submissions.push(event.submissionId);
          task.latestSubmissionId = event.submissionId;
          task.status = 'submitted';
        }
        break;
      case 'request_approval': {
        ensureApproval(state, event);
        if (task) {
          task.status = 'blocked';
        }
        break;
      }
      case 'respond_approval': {
        const approval = ensureApproval(state, event);
        approval.status = event.decision;
        const approvalTask = task ?? (approval.taskId ? state.tasks[approval.taskId] ?? null : null);
        if (approvalTask) {
          approvalTask.status = event.completesTask ? 'completed' : 'assigned';
        }
        break;
      }
      case 'cancel_task':
        if (task) {
          task.status = 'cancelled';
        }
        break;
      default:
        break;
    }
  }

  return state;
}
