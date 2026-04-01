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

test('registerParticipant stores projectName context and listParticipants can filter by projectName', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({
    participantId: 'codex.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    context: { projectName: 'intent-broker' }
  });
  broker.registerParticipant({
    participantId: 'codex.b',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    context: { projectName: 'kvoice' }
  });

  const projectParticipants = broker.listParticipants({ projectName: 'intent-broker' });

  assert.equal(projectParticipants.length, 1);
  assert.equal(projectParticipants[0].participantId, 'codex.a');
  assert.deepEqual(projectParticipants[0].context, { projectName: 'intent-broker' });
});

test('updateWorkState stores current work summary and listWorkStates can filter by projectName', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({
    participantId: 'codex.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    context: { projectName: 'intent-broker' }
  });
  broker.registerParticipant({
    participantId: 'codex.b',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    context: { projectName: 'other-project' }
  });

  const updated = broker.updateWorkState('codex.a', {
    status: 'implementing',
    summary: 'Refactoring work-state API',
    taskId: 'task-9',
    threadId: 'thread-9'
  });
  broker.updateWorkState('codex.b', {
    status: 'reviewing',
    summary: 'Checking release notes'
  });

  const projectStates = broker.listWorkStates({ projectName: 'intent-broker' });

  assert.equal(updated.participantId, 'codex.a');
  assert.equal(updated.projectName, 'intent-broker');
  assert.equal(updated.status, 'implementing');
  assert.equal(updated.summary, 'Refactoring work-state API');
  assert.equal(updated.taskId, 'task-9');
  assert.equal(updated.threadId, 'thread-9');
  assert.ok(updated.updatedAt);
  assert.equal(projectStates.length, 1);
  assert.deepEqual(projectStates[0], broker.getWorkState('codex.a'));
});

test('registerParticipant assigns globally unique aliases and resolves collisions with numeric suffixes', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  const first = broker.registerParticipant({
    participantId: 'codex.session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex'
  });
  const second = broker.registerParticipant({
    participantId: 'codex.session-2',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex'
  });
  const third = broker.registerParticipant({
    participantId: 'claude-code.session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: []
  });

  const resolved = broker.resolveParticipantsByAliases(['codex', 'codex2', 'claude']);

  assert.equal(first.alias, 'codex');
  assert.equal(second.alias, 'codex2');
  assert.equal(third.alias, 'claude');
  assert.deepEqual(resolved.missingAliases, []);
  assert.deepEqual(
    resolved.participants.map((participant) => participant.participantId),
    ['codex.session-1', 'codex.session-2', 'claude-code.session-1']
  );
});

test('updateParticipantAlias reassigns alias and broadcasts a broker event to other participants', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({ participantId: 'codex.a', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'codex' });
  broker.registerParticipant({ participantId: 'claude.b', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'claude' });

  const updated = broker.updateParticipantAlias('claude.b', 'reviewer');
  const codexInbox = broker.readInbox('codex.a', { after: 0 });

  assert.equal(updated.alias, 'reviewer');
  assert.equal(codexInbox.items.length, 1);
  assert.equal(codexInbox.items[0].kind, 'participant_alias_updated');
  assert.equal(codexInbox.items[0].payload.previousAlias, 'claude');
  assert.equal(codexInbox.items[0].payload.alias, 'reviewer');
  assert.equal(codexInbox.items[0].payload.participantId, 'claude.b');
});

test('readInbox enriches events with sender alias and project context', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({
    participantId: 'claude.b',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'claude',
    context: { projectName: 'intent-broker' }
  });
  broker.registerParticipant({
    participantId: 'codex.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex',
    context: { projectName: 'intent-broker' }
  });

  broker.sendIntent({
    intentId: 'task-1',
    kind: 'request_task',
    fromParticipantId: 'claude.b',
    taskId: 'task-1',
    threadId: 'thread-1',
    to: { mode: 'participant', participants: ['codex.a'] },
    payload: { body: { summary: 'Review the hook output' } }
  });

  const inbox = broker.readInbox('codex.a', { after: 0 });

  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].fromParticipantId, 'claude.b');
  assert.equal(inbox.items[0].fromAlias, 'claude');
  assert.equal(inbox.items[0].fromProjectName, 'intent-broker');
});
