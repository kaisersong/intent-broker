import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerService } from '../../src/broker/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

test('broadcast request_task routes to participants matching role', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'agent.a', kind: 'agent', roles: ['coder'], capabilities: ['frontend.react'] });
  broker.registerParticipant({ participantId: 'agent.b', kind: 'agent', roles: ['reviewer'], capabilities: [] });

  const result = broker.sendIntent({
    intentId: 'int-1',
    kind: 'request_task',
    fromParticipantId: 'human.song',
    taskId: 'task-1',
    threadId: 'thread-1',
    to: { mode: 'role', roles: ['coder'] },
    payload: { body: { summary: 'fix export font' } }
  });

  assert.deepEqual(result.recipients, ['agent.a']);
  assert.equal(broker.readInbox('agent.a', { after: 0 }).items.length, 1);
});

test('broadcast request_task routes to all registered participants except sender', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [] });
  broker.registerParticipant({ participantId: 'agent.a', kind: 'agent', roles: ['coder'], capabilities: [] });
  broker.registerParticipant({ participantId: 'agent.b', kind: 'agent', roles: ['coder'], capabilities: [] });

  const result = broker.sendIntent({
    intentId: 'int-broadcast',
    kind: 'request_task',
    fromParticipantId: 'human.song',
    taskId: 'task-2',
    threadId: 'thread-2',
    to: { mode: 'broadcast' },
    payload: { body: { summary: 'help' } }
  });

  assert.deepEqual(result.recipients, ['agent.a', 'agent.b']);
});

test('capability routing matches participants by capability', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'agent.a', kind: 'agent', roles: ['coder'], capabilities: ['frontend.react', 'backend.node'] });
  broker.registerParticipant({ participantId: 'agent.b', kind: 'agent', roles: ['coder'], capabilities: ['backend.python'] });
  broker.registerParticipant({ participantId: 'agent.c', kind: 'agent', roles: ['coder'], capabilities: ['frontend.react'] });

  const result = broker.sendIntent({
    intentId: 'int-cap',
    kind: 'request_task',
    fromParticipantId: 'human.song',
    taskId: 'task-cap',
    threadId: 'thread-cap',
    to: { mode: 'capability', capabilities: ['frontend.react'] },
    payload: { body: { summary: 'fix React component' } }
  });

  assert.deepEqual(result.recipients.sort(), ['agent.a', 'agent.c']);
});

test('respondApproval updates approval view to approved', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [] });
  broker.registerParticipant({ participantId: 'agent.a', kind: 'agent', roles: ['coder'], capabilities: [] });

  broker.sendIntent({
    intentId: 'int-task',
    kind: 'request_task',
    fromParticipantId: 'human.song',
    taskId: 'task-3',
    threadId: 'thread-3',
    to: { mode: 'participant', participants: ['agent.a'] },
    payload: {}
  });
  broker.sendIntent({
    intentId: 'int-approval',
    kind: 'request_approval',
    fromParticipantId: 'agent.a',
    taskId: 'task-3',
    threadId: 'thread-3',
    to: { mode: 'participant', participants: ['human.song'] },
    payload: { approvalId: 'app-1', approvalScope: 'submit_result' }
  });

  broker.respondApproval({ approvalId: 'app-1', taskId: 'task-3', fromParticipantId: 'human.song', decision: 'approved' });

  assert.equal(broker.getApprovalView('app-1').status, 'approved');
});
