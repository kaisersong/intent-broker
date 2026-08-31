import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceEventStream } from '../../src/domain/reducer.js';

test('request -> accept -> progress -> result -> complete produces expected task state', () => {
  const state = reduceEventStream([
    { kind: 'request_task', taskId: 'task-1', threadId: 'thread-1' },
    { kind: 'accept_task', taskId: 'task-1', assignmentMode: 'single', participantId: 'agent.a' },
    { kind: 'report_progress', taskId: 'task-1', stage: 'started' },
    { kind: 'submit_result', taskId: 'task-1', submissionId: 'sub-1' },
    { kind: 'request_approval', taskId: 'task-1', approvalId: 'app-1', approvalScope: 'submit_result' },
    { kind: 'respond_approval', taskId: 'task-1', approvalId: 'app-1', decision: 'approved', completesTask: true }
  ]);

  assert.equal(state.tasks['task-1'].status, 'completed');
  assert.equal(state.tasks['task-1'].assignees[0], 'agent.a');
  assert.equal(state.tasks['task-1'].latestSubmissionId, 'sub-1');
  assert.equal(state.approvals['app-1'].status, 'approved');
});

test('request approval creates pending approval and blocks task', () => {
  const state = reduceEventStream([
    { kind: 'request_task', taskId: 'task-2', threadId: 'thread-2' },
    { kind: 'request_approval', taskId: 'task-2', approvalId: 'app-2', approvalScope: 'submit_result' }
  ]);

  assert.equal(state.tasks['task-2'].status, 'blocked');
  assert.equal(state.approvals['app-2'].status, 'pending');
});

test('approval response without task id updates the existing approval task', () => {
  const state = reduceEventStream([
    { kind: 'request_task', taskId: 'task-3', threadId: 'thread-3' },
    { kind: 'request_approval', taskId: 'task-3', approvalId: 'app-3', approvalScope: 'submit_result' },
    { kind: 'respond_approval', approvalId: 'app-3', decision: 'approved', completesTask: true }
  ]);

  assert.equal(state.tasks['task-3'].status, 'completed');
  assert.equal(state.approvals['app-3'].status, 'approved');
});

test('orphan approval response does not crash task state rebuild', () => {
  const state = reduceEventStream([
    { kind: 'respond_approval', approvalId: 'app-orphan', decision: 'approved', completesTask: true }
  ]);

  assert.deepEqual(state.tasks, {});
  assert.equal(state.approvals['app-orphan'].status, 'approved');
});

test('task lifecycle events without task id are ignored during state rebuild', () => {
  const state = reduceEventStream([
    { kind: 'accept_task', assignmentMode: 'single', participantId: 'agent.a' },
    { kind: 'report_progress', stage: 'started' },
    { kind: 'submit_result', submissionId: 'sub-orphan' },
    { kind: 'cancel_task' }
  ]);

  assert.deepEqual(state.tasks, {});
});

test('a second submit_result for an already-submitted task is recorded as a duplicate, not a silent overwrite', () => {
  // Mirrors cumora's atomic verbatim-dup gate: once a task has a canonical
  // submission, a second submit_result for the same taskId (e.g. two workers
  // racing on the same dispatch, or a retried submission) must not silently
  // replace latestSubmissionId. The first submission stays canonical; the
  // second is tracked as a rejected duplicate so the caller can be told.
  const state = reduceEventStream([
    { kind: 'request_task', taskId: 'task-dup', threadId: 'thread-dup' },
    { kind: 'accept_task', taskId: 'task-dup', assignmentMode: 'single', participantId: 'agent.a' },
    { kind: 'submit_result', taskId: 'task-dup', submissionId: 'sub-1' },
    { kind: 'submit_result', taskId: 'task-dup', submissionId: 'sub-2' },
  ]);

  const task = state.tasks['task-dup'];
  assert.equal(task.latestSubmissionId, 'sub-1', 'first submission remains canonical');
  assert.deepEqual(task.submissions, ['sub-1'], 'duplicate submission id is not appended to the canonical list');
  assert.deepEqual(task.duplicateSubmissionIds, ['sub-2'], 'duplicate is tracked separately for visibility');
});

test('re-submitting the same submissionId twice is idempotent, not a duplicate', () => {
  // A retried delivery of the exact same submissionId (network retry, at-least-once
  // redelivery) is not a race between two different results — it is the same
  // fact repeated. It must not appear in duplicateSubmissionIds.
  const state = reduceEventStream([
    { kind: 'request_task', taskId: 'task-retry', threadId: 'thread-retry' },
    { kind: 'submit_result', taskId: 'task-retry', submissionId: 'sub-1' },
    { kind: 'submit_result', taskId: 'task-retry', submissionId: 'sub-1' },
  ]);

  const task = state.tasks['task-retry'];
  assert.equal(task.latestSubmissionId, 'sub-1');
  assert.deepEqual(task.submissions, ['sub-1']);
  assert.deepEqual(task.duplicateSubmissionIds, []);
});

test('submit_result after cancel_task is rejected as a duplicate rather than reopening the task', () => {
  const state = reduceEventStream([
    { kind: 'request_task', taskId: 'task-cancelled', threadId: 'thread-cancelled' },
    { kind: 'cancel_task', taskId: 'task-cancelled' },
    { kind: 'submit_result', taskId: 'task-cancelled', submissionId: 'sub-late' },
  ]);

  const task = state.tasks['task-cancelled'];
  assert.equal(task.status, 'cancelled', 'a late submission does not resurrect a cancelled task');
  assert.deepEqual(task.duplicateSubmissionIds, ['sub-late']);
});
