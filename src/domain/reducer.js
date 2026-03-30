function ensureTask(state, event) {
  if (!state.tasks[event.taskId]) {
    state.tasks[event.taskId] = {
      taskId: event.taskId,
      threadId: event.threadId ?? null,
      status: 'open',
      assignees: [],
      submissions: [],
      latestSubmissionId: null
    };
  }

  return state.tasks[event.taskId];
}

function ensureApproval(state, event) {
  if (!state.approvals[event.approvalId]) {
    state.approvals[event.approvalId] = {
      approvalId: event.approvalId,
      taskId: event.taskId,
      status: 'pending',
      scope: event.approvalScope ?? null
    };
  }

  return state.approvals[event.approvalId];
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
        task.status = 'open';
        break;
      case 'accept_task':
        task.assignees = Array.from(new Set([...task.assignees, event.participantId]));
        task.status = 'assigned';
        break;
      case 'report_progress':
        if (event.stage === 'started') {
          task.status = 'in_progress';
        }
        break;
      case 'submit_result':
        task.submissions.push(event.submissionId);
        task.latestSubmissionId = event.submissionId;
        task.status = 'submitted';
        break;
      case 'request_approval': {
        ensureApproval(state, event);
        task.status = 'blocked';
        break;
      }
      case 'respond_approval': {
        const approval = ensureApproval(state, event);
        approval.status = event.decision;
        task.status = event.completesTask ? 'completed' : 'assigned';
        break;
      }
      case 'cancel_task':
        task.status = 'cancelled';
        break;
      default:
        break;
    }
  }

  return state;
}
