export const INTENT_KINDS = [
  'request_task',
  'accept_task',
  'decline_task',
  'ask_clarification',
  'answer_clarification',
  'report_progress',
  'reply_message',
  'submit_result',
  'request_approval',
  'respond_approval',
  'cancel_task',
  'workflow_progress_batch'
];

const ALLOWED_WORKFLOW_PROGRESS_EVENT_TYPES = new Set([
  'workflow.started',
  'workflow.phase.started',
  'workflow.node.queued',
  'workflow.node.started',
  'workflow.node.progress',
  'workflow.agent.heartbeat',
  'workflow.node.completed',
  'workflow.node.failed',
  'workflow.node.cancelled',
  'workflow.budget.updated',
  'workflow.review.completed',
  'workflow.completed',
]);

export function validateWorkflowProgressBatchIntent(intent = {}) {
  if (!intent || typeof intent !== 'object') return { ok: false, error: 'workflow_progress_intent_required' };
  if (intent.kind !== 'workflow_progress_batch') return { ok: false, error: 'workflow_progress_intent_kind_invalid' };
  const payload = intent.payload || {};
  if (payload.kind !== 'workflow.progress_batch') return { ok: false, error: 'workflow_progress_kind_invalid' };
  for (const field of ['workflowRunId', 'projectId', 'fromParticipantId']) {
    if (!payload[field]) return { ok: false, error: `workflow_progress_${field}_required` };
  }
  if (!Number.isFinite(Number(payload.sequence))) return { ok: false, error: 'workflow_progress_sequence_required' };
  if (!Array.isArray(payload.events)) return { ok: false, error: 'workflow_progress_events_required' };

  for (const event of payload.events) {
    if (!ALLOWED_WORKFLOW_PROGRESS_EVENT_TYPES.has(String(event?.type || ''))) {
      return { ok: false, error: 'workflow_progress_event_type_invalid', eventType: event?.type };
    }
    if ((event.type === 'workflow.agent.heartbeat' || String(event.type).includes('.node.')) && !event.nodeId) {
      return { ok: false, error: 'workflow_progress_event_node_id_required', eventType: event.type };
    }
  }
  return { ok: true };
}
