import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTENT_KINDS,
  validateWorkflowProgressBatchIntent,
} from '../../src/intent-types.js';

function batch(overrides = {}) {
  const payloadOverrides = overrides.payload || {};
  const rootOverrides = { ...overrides };
  delete rootOverrides.payload;
  return {
    kind: 'workflow_progress_batch',
    payload: {
      kind: 'workflow.progress_batch',
      workflowRunId: 'wf-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      fromParticipantId: 'xiaok-worker',
      sequence: 1,
      emittedAt: 1770000000000,
      events: [{ type: 'workflow.agent.heartbeat', nodeId: 'node-1', at: 1770000000000 }],
      ...payloadOverrides,
    },
    ...rootOverrides,
  };
}

test('workflow progress batch is a known intent kind', () => {
  assert.equal(INTENT_KINDS.includes('workflow_progress_batch'), true);
});

test('workflow progress batch intent requires durable workflow identity', () => {
  assert.equal(validateWorkflowProgressBatchIntent(batch()).ok, true);

  for (const field of ['workflowRunId', 'projectId', 'fromParticipantId', 'sequence', 'events']) {
    const intent = batch();
    delete intent.payload[field];
    const result = validateWorkflowProgressBatchIntent(intent);
    assert.equal(result.ok, false, field);
    assert.equal(result.error, `workflow_progress_${field}_required`);
  }
});

test('workflow progress batch rejects malformed heartbeat and material events', () => {
  const missingHeartbeatNode = validateWorkflowProgressBatchIntent(batch({
    payload: { events: [{ type: 'workflow.agent.heartbeat' }] },
  }));
  assert.equal(missingHeartbeatNode.ok, false);
  assert.equal(missingHeartbeatNode.error, 'workflow_progress_event_node_id_required');

  const unknownEvent = validateWorkflowProgressBatchIntent(batch({
    payload: { events: [{ type: 'unknown.workflow.event', nodeId: 'node-1' }] },
  }));
  assert.equal(unknownEvent.ok, false);
  assert.equal(unknownEvent.error, 'workflow_progress_event_type_invalid');
});
