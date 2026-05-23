import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceEventStream } from '../../src/domain/reducer.js';

test('participant unavailable does not synthesize task result', () => {
  const state = reduceEventStream([
    { kind: 'request_task', taskId: 'task-1', threadId: 'thread-1' },
    {
      kind: 'handoff_delivery_failed',
      targetParticipantId: 'xiaok-worker',
      taskId: 'task-1',
      reason: 'participant_unavailable',
    },
  ]);

  assert.notEqual(state.tasks['task-1']?.status, 'completed');
  assert.equal(state.tasks['task-1']?.latestSubmissionId ?? null, null);
});
