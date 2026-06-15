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
