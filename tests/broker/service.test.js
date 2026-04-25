import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createBrokerService } from '../../src/broker/service.js';
import { createServer } from '../../src/http/server.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

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
  assert.equal(
    broker.readInbox('agent.a', { after: 0 }).items.filter((item) => item.kind === 'request_task').length,
    1
  );
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

test('listProjectApprovals preserves native approval actions and broker response metadata', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({
    participantId: 'human.song',
    kind: 'human',
    roles: ['approver'],
    capabilities: []
  });
  broker.registerParticipant({
    participantId: 'codex-session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    context: { projectName: 'hexdeck' }
  });

  broker.sendIntent({
    intentId: 'int-task',
    kind: 'request_task',
    fromParticipantId: 'human.song',
    taskId: 'task-native',
    threadId: 'thread-native',
    to: { mode: 'participant', participants: ['codex-session-1'] },
    payload: {}
  });
  broker.sendIntent({
    intentId: 'int-approval',
    kind: 'request_approval',
    fromParticipantId: 'codex-session-1',
    taskId: 'task-native',
    threadId: 'thread-native',
    to: { mode: 'participant', participants: ['human.song'] },
    payload: {
      approvalId: 'approval-native',
      approvalScope: 'run_command',
      body: {
        summary: 'Allow once?',
        detailText: 'Native owner',
        commandTitle: 'Codex',
        commandLine: "printf 'ok\\n'",
        commandPreview: '/Users/song/projects/hexdeck'
      },
      actions: [
        { key: 'accept', label: 'Allow once', decisionMode: 'yes', nativeDecision: 'accept' },
        { key: 'cancel', label: 'Cancel', decisionMode: 'cancel', nativeDecision: 'cancel' }
      ],
      nativeCodexApproval: {
        nativeRequestId: '3'
      }
    }
  });

  const approvals = broker.listProjectApprovals('hexdeck', { status: 'pending' });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].approvalId, 'approval-native');
  assert.equal(approvals[0].summary, 'Allow once?');
  assert.equal(approvals[0].actions[0].nativeDecision, 'accept');
  assert.equal(approvals[0].actions[1].decisionMode, 'cancel');
  assert.equal(approvals[0].body.nativeCodexApproval.nativeRequestId, '3');

  broker.respondApproval({
    approvalId: 'approval-native',
    taskId: 'task-native',
    fromParticipantId: 'human.song',
    decision: 'cancelled',
    decisionMode: 'cancel',
    nativeDecision: 'cancel'
  });

  const replay = broker.replayEvents({ after: 0 }).items;
  const responseEvent = replay.find((event) => event.kind === 'respond_approval' && event.payload?.approvalId === 'approval-native');
  assert.equal(responseEvent.payload.decisionMode, 'cancel');
  assert.equal(responseEvent.payload.nativeDecision, 'cancel');
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
  broker.registerParticipant({
    participantId: 'claude.b',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'claude',
    metadata: {
      terminalApp: 'Ghostty',
      sessionHint: null,
      projectPath: '/Users/song/projects/xiaok-cli'
    }
  });

  const updated = broker.updateParticipantAlias('claude.b', 'reviewer');
  const codexInbox = broker.readInbox('codex.a', { after: 0 });
  const aliasEvents = codexInbox.items.filter((item) => item.kind === 'participant_alias_updated');

  assert.equal(updated.alias, 'reviewer');
  assert.deepEqual(updated.metadata, {
    terminalApp: 'Ghostty',
    sessionHint: 'reviewer',
    projectPath: '/Users/song/projects/xiaok-cli'
  });
  assert.equal(aliasEvents.length, 1);
  assert.equal(aliasEvents[0].payload.previousAlias, 'claude');
  assert.equal(aliasEvents[0].payload.alias, 'reviewer');
  assert.equal(aliasEvents[0].payload.participantId, 'claude.b');
});

test('registerParticipant preserves a remotely updated alias across later re-registration', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({
    participantId: 'codex.session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex'
  });

  broker.updateParticipantAlias('codex.session-1', 'codex4');

  const reregistered = broker.registerParticipant({
    participantId: 'codex.session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex'
  });

  assert.equal(reregistered.alias, 'codex4');
  assert.deepEqual(
    broker.resolveParticipantsByAliases(['codex4']).participants.map((participant) => participant.participantId),
    ['codex.session-1']
  );
});

test('registerParticipant aligns Ghostty session hints to the final assigned alias', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  const participant = broker.registerParticipant({
    participantId: 'codex.session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex',
    metadata: {
      terminalApp: 'Ghostty',
      sessionHint: null,
      projectPath: '/Users/song/projects/hexdeck'
    }
  });

  assert.deepEqual(participant.metadata, {
    terminalApp: 'Ghostty',
    sessionHint: 'codex',
    projectPath: '/Users/song/projects/hexdeck'
  });
  assert.deepEqual(broker.listParticipants()[0].metadata, {
    terminalApp: 'Ghostty',
    sessionHint: 'codex',
    projectPath: '/Users/song/projects/hexdeck'
  });
});

test('registerParticipant rewrites Ghostty session hints after alias collisions', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({
    participantId: 'codex.session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex',
    metadata: {
      terminalApp: 'Ghostty',
      sessionHint: 'codex',
      projectPath: '/Users/song/projects'
    }
  });

  const second = broker.registerParticipant({
    participantId: 'codex.session-2',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex',
    metadata: {
      terminalApp: 'Ghostty',
      sessionHint: 'codex',
      projectPath: '/Users/song/projects/hexdeck'
    }
  });

  assert.equal(second.alias, 'codex2');
  assert.deepEqual(second.metadata, {
    terminalApp: 'Ghostty',
    sessionHint: 'codex2',
    projectPath: '/Users/song/projects/hexdeck'
  });
});

test('registerParticipant refreshes metadata on later re-registration', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({
    participantId: 'codex.session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex',
    metadata: {
      terminalApp: 'Ghostty',
      sessionHint: null,
      projectPath: '/Users/song/projects/hexdeck'
    }
  });

  const participant = broker.registerParticipant({
    participantId: 'codex.session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex',
    metadata: {
      terminalApp: 'Terminal.app',
      sessionHint: null,
      projectPath: '/Users/song/projects/intent-broker'
    }
  });

  assert.deepEqual(participant.metadata, {
    terminalApp: 'Terminal.app',
    sessionHint: 'codex',
    projectPath: '/Users/song/projects/intent-broker'
  });
});

test('registerParticipant clears conflicting Ghostty session ids when tty and project disagree', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({
    participantId: 'claude.session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'claude',
    metadata: {
      terminalApp: 'Ghostty',
      sessionHint: 'ghostty-1',
      terminalTTY: '/dev/ttys007',
      terminalSessionID: 'ghostty-1',
      projectPath: '/Users/song/projects/xiaok-cli'
    }
  });

  const participant = broker.registerParticipant({
    participantId: 'codex.session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex',
    metadata: {
      terminalApp: 'Ghostty',
      sessionHint: 'ghostty-1',
      terminalTTY: '/dev/ttys003',
      terminalSessionID: 'ghostty-1',
      projectPath: '/Users/song/projects/hexdeck'
    }
  });

  assert.deepEqual(participant.metadata, {
    terminalApp: 'Ghostty',
    sessionHint: 'codex',
    terminalTTY: '/dev/ttys003',
    terminalSessionID: null,
    projectPath: '/Users/song/projects/hexdeck'
  });
});

test('sendIntent annotates delivery semantics based on sender kind and intent kind', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({
    participantId: 'human.song',
    kind: 'human',
    roles: ['approver'],
    capabilities: []
  });
  broker.registerParticipant({
    participantId: 'agent.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: []
  });
  broker.registerParticipant({
    participantId: 'agent.b',
    kind: 'agent',
    roles: ['coder'],
    capabilities: []
  });

  broker.sendIntent({
    intentId: 'progress-1',
    kind: 'report_progress',
    fromParticipantId: 'agent.a',
    taskId: 'task-1',
    threadId: 'thread-1',
    to: { mode: 'participant', participants: ['agent.b'] },
    payload: { stage: 'in_progress', body: { summary: 'sync only' } }
  });

  broker.sendIntent({
    intentId: 'task-1',
    kind: 'request_task',
    fromParticipantId: 'human.song',
    taskId: 'task-2',
    threadId: 'thread-2',
    to: { mode: 'participant', participants: ['agent.b'] },
    payload: { body: { summary: 'need reply' } }
  });

  const inbox = broker.readInbox('agent.b', { after: 0 }).items;

  assert.equal(
    inbox.find((item) => item.intentId === 'progress-1').payload.delivery.semantic,
    'informational'
  );
  assert.equal(
    inbox.find((item) => item.intentId === 'progress-1').payload.delivery.source,
    'default'
  );
  assert.equal(
    inbox.find((item) => item.intentId === 'task-1').payload.delivery.semantic,
    'actionable'
  );
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

test('sendIntent reports which recipients are online over websocket', async (t) => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({ broker });
  await server.listen(0, '127.0.0.1');
  broker.attachWebSocket(server.raw());
  const port = server.address().port;

  broker.registerParticipant({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [] });
  broker.registerParticipant({ participantId: 'agent.online', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'online' });
  broker.registerParticipant({ participantId: 'agent.offline', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'offline' });

  const onlineSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?participantId=agent.online`);
  await once(onlineSocket, 'open');

  t.after(async () => {
    onlineSocket.close();
    await server.close();
  });

  const result = broker.sendIntent({
    intentId: 'int-online-state-1',
    kind: 'request_task',
    fromParticipantId: 'human.song',
    taskId: 'task-online-state-1',
    threadId: 'thread-online-state-1',
    to: { mode: 'participant', participants: ['agent.online', 'agent.offline'] },
    payload: { body: { summary: 'Check delivery status' } }
  });

  assert.deepEqual(result.recipients, ['agent.online', 'agent.offline']);
  assert.deepEqual(result.onlineRecipients, ['agent.online']);
  assert.deepEqual(result.offlineRecipients, ['agent.offline']);
  assert.equal(result.deliveredCount, 1);
});

test('websocket new_intent notifications include enriched sender alias fields', async (t) => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({ broker });
  await server.listen(0, '127.0.0.1');
  broker.attachWebSocket(server.raw());
  const port = server.address().port;

  broker.registerParticipant({
    participantId: 'claude.session',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'claude2',
    context: { projectName: 'intent-broker' }
  });
  broker.registerParticipant({
    participantId: 'codex.session',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex',
    context: { projectName: 'intent-broker' }
  });

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?participantId=codex.session`);
  await once(socket, 'open');
  const received = [];
  socket.on('message', (data) => {
    received.push(JSON.parse(data.toString()));
  });

  t.after(async () => {
    socket.close();
    await server.close();
  });

  broker.sendIntent({
    intentId: 'int-enriched-1',
    kind: 'report_progress',
    fromParticipantId: 'claude.session',
    taskId: 'task-enriched-1',
    threadId: 'thread-enriched-1',
    to: { mode: 'participant', participants: ['codex.session'] },
    payload: { body: { summary: 'V3可靠性实现完成。182 tests全部通过。' } }
  });

  await waitFor(() => received.some((message) => message.type === 'new_intent'));
  const pushed = received.find((message) => message.type === 'new_intent');
  assert.equal(pushed.type, 'new_intent');
  assert.equal(pushed.event.fromParticipantId, 'claude.session');
  assert.equal(pushed.event.fromAlias, 'claude2');
  assert.equal(pushed.event.fromProjectName, 'intent-broker');
});

test('websocket lifecycle updates presence and broadcasts online and offline changes', async (t) => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({ broker });
  await server.listen(0, '127.0.0.1');
  broker.attachWebSocket(server.raw());
  const port = server.address().port;

  broker.registerParticipant({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [] });
  broker.registerParticipant({
    participantId: 'agent.codex',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex4',
    context: { projectName: 'intent-broker' }
  });

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?participantId=agent.codex`);
  await once(socket, 'open');

  await waitFor(() => broker.getPresence('agent.codex')?.status === 'online');
  await waitFor(() => broker.readInbox('human.song', { after: 0 }).items.length >= 1);

  let inbox = broker.readInbox('human.song', { after: 0 });
  assert.equal(inbox.items[0].kind, 'participant_presence_updated');
  assert.equal(inbox.items[0].payload.participantId, 'agent.codex');
  assert.equal(inbox.items[0].payload.status, 'online');

  socket.close();

  await waitFor(() => broker.getPresence('agent.codex')?.status === 'offline');
  await waitFor(() => broker.readInbox('human.song', { after: 0 }).items.length >= 2);

  inbox = broker.readInbox('human.song', { after: 0 });
  assert.equal(inbox.items[1].kind, 'participant_presence_updated');
  assert.equal(inbox.items[1].payload.participantId, 'agent.codex');
  assert.equal(inbox.items[1].payload.status, 'offline');

  t.after(async () => {
    await server.close();
  });
});

test('websocket heartbeat keeps realtime participants online across presence sweeps', async (t) => {
  const broker = createBrokerService({
    dbPath: createTempDbPath(),
    presenceTimeoutMs: 50,
    presenceSweepIntervalMs: 10,
    websocketHeartbeatIntervalMs: 10
  });
  const server = createServer({ broker });
  await server.listen(0, '127.0.0.1');
  broker.attachWebSocket(server.raw());
  const port = server.address().port;

  broker.registerParticipant({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [] });
  broker.registerParticipant({
    participantId: 'adapter.yunzhijia',
    kind: 'adapter',
    roles: ['message_gateway'],
    capabilities: ['yunzhijia.im'],
    alias: 'yunzhijia'
  });

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?participantId=adapter.yunzhijia`);
  await once(socket, 'open');

  t.after(async () => {
    socket.close();
    await server.close();
  });

  await waitFor(() => broker.getPresence('adapter.yunzhijia')?.status === 'online');
  await new Promise((resolve) => setTimeout(resolve, 150));

  const stillOnline = broker.getPresence('adapter.yunzhijia');
  assert.equal(stillOnline?.status, 'online');

  const inboxWhileConnected = broker.readInbox('human.song', { after: 0 }).items
    .filter((item) => item.kind === 'participant_presence_updated' && item.payload.participantId === 'adapter.yunzhijia');
  assert.equal(inboxWhileConnected.length, 1);
  assert.equal(inboxWhileConnected[0].payload.status, 'online');

  socket.close();

  await waitFor(() => broker.getPresence('adapter.yunzhijia')?.status === 'offline');

  const inboxAfterClose = broker.readInbox('human.song', { after: 0 }).items
    .filter((item) => item.kind === 'participant_presence_updated' && item.payload.participantId === 'adapter.yunzhijia');
  assert.equal(inboxAfterClose.length, 2);
  assert.equal(inboxAfterClose[1].payload.status, 'offline');
});

test('registerParticipant marks agent online and broadcasts presence without websocket', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath(), presenceSweepIntervalMs: 0 });

  broker.registerParticipant({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [] });
  broker.registerParticipant({
    participantId: 'codex.session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex5',
    context: { projectName: 'intent-broker' }
  });

  const presence = broker.getPresence('codex.session-1');
  const humanInbox = broker.readInbox('human.song', { after: 0 });

  assert.equal(presence?.status, 'online');
  assert.equal(humanInbox.items.at(-1)?.kind, 'participant_presence_updated');
  assert.equal(humanInbox.items.at(-1)?.payload.participantId, 'codex.session-1');
  assert.equal(humanInbox.items.at(-1)?.payload.status, 'online');
});

test('presence sweep marks stale hook-only sessions offline and broadcasts the change', async () => {
  const broker = createBrokerService({
    dbPath: createTempDbPath(),
    presenceTimeoutMs: 20,
    presenceSweepIntervalMs: 5
  });

  broker.registerParticipant({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [] });
  broker.registerParticipant({
    participantId: 'claude.session-1',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'claude5',
    context: { projectName: 'intent-broker' }
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  broker.sweepPresence();

  assert.equal(broker.getPresence('claude.session-1')?.status, 'offline');
  await waitFor(() => broker.readInbox('human.song', { after: 0 }).items.filter((item) => item.kind === 'participant_presence_updated').length >= 2, {
    timeoutMs: 1000,
    intervalMs: 10
  });

  const events = broker.readInbox('human.song', { after: 0 }).items.filter((item) => item.kind === 'participant_presence_updated');
  assert.equal(events[0].payload.status, 'online');
  assert.equal(events[1].payload.status, 'offline');
  assert.equal(broker.listParticipants().some((item) => item.participantId === 'claude.session-1'), false);
});

test('parent-exit offline updates prune stale agent registrations from the roster', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath(), presenceSweepIntervalMs: 0 });

  broker.registerParticipant({
    participantId: 'codex.session-stale',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex'
  });

  broker.updatePresence('codex.session-stale', 'offline', { reason: 'parent-exit' });

  assert.equal(broker.getPresence('codex.session-stale')?.status, 'offline');
  assert.equal(broker.listParticipants().some((item) => item.participantId === 'codex.session-stale'), false);
});

test('manual offline updates keep the participant in the roster', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath(), presenceSweepIntervalMs: 0 });

  broker.registerParticipant({
    participantId: 'codex.session-manual',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex'
  });

  broker.updatePresence('codex.session-manual', 'offline', { reason: 'test' });

  assert.equal(broker.getPresence('codex.session-manual')?.status, 'offline');
  assert.equal(broker.listParticipants().some((item) => item.participantId === 'codex.session-manual'), true);
});

test('getProjectSnapshot aggregates project roster, counts, and recent events', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({
    participantId: 'codex.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex',
    context: { projectName: 'intent-broker' }
  });
  broker.registerParticipant({
    participantId: 'claude.b',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'claude',
    context: { projectName: 'intent-broker' }
  });
  broker.updateWorkState('codex.a', { status: 'implementing', taskId: 'task-1', threadId: 'thread-1', summary: 'Building snapshot API' });
  broker.updateWorkState('claude.b', { status: 'blocked', taskId: 'task-2', threadId: 'thread-2', summary: 'Waiting on approval' });

  const snapshot = broker.getProjectSnapshot('intent-broker');

  assert.equal(snapshot.projectName, 'intent-broker');
  assert.equal(snapshot.counts.online, 2);
  assert.equal(snapshot.counts.busy, 1);
  assert.equal(snapshot.counts.blocked, 1);
  assert.ok(snapshot.participants.some((item) => item.alias === 'codex'));
  assert.ok(snapshot.participants.some((item) => item.alias === 'claude'));
});

test('getProjectSnapshot includes pending approval counts for the project', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [], context: { projectName: 'intent-broker' } });
  broker.registerParticipant({ participantId: 'codex.a', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'codex', context: { projectName: 'intent-broker' } });

  broker.sendIntent({
    intentId: 'approval-snapshot',
    kind: 'request_approval',
    fromParticipantId: 'codex.a',
    taskId: 'task-snapshot',
    threadId: 'thread-snapshot',
    to: { mode: 'participant', participants: ['human.song'] },
    payload: { approvalId: 'app-snapshot', approvalScope: 'submit_result', body: { summary: 'Snapshot approval?' } }
  });

  const snapshot = broker.getProjectSnapshot('intent-broker');
  assert.equal(snapshot.counts.pendingApproval, 1);
});

test('listProjectApprovals returns pending approvals for one project', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [], context: { projectName: 'intent-broker' } });
  broker.registerParticipant({ participantId: 'codex.a', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'codex', context: { projectName: 'intent-broker' } });

  broker.sendIntent({
    intentId: 'approval-1',
    kind: 'request_approval',
    fromParticipantId: 'codex.a',
    taskId: 'task-1',
    threadId: 'thread-1',
    to: { mode: 'participant', participants: ['human.song'] },
    payload: { approvalId: 'app-1', approvalScope: 'submit_result', body: { summary: 'Ship the result?' } }
  });

  const approvals = broker.listProjectApprovals('intent-broker', { status: 'pending' });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].approvalId, 'app-1');
  assert.equal(approvals[0].decision, 'pending');
});

test('listProjectApprovals still includes recent approvals after more than 100 older events', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  broker.registerParticipant({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [], context: { projectName: 'intent-broker' } });
  broker.registerParticipant({ participantId: 'codex.a', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'codex', context: { projectName: 'intent-broker' } });

  for (let index = 0; index < 120; index += 1) {
    broker.sendIntent({
      intentId: `task-${index}`,
      kind: 'request_task',
      fromParticipantId: 'human.song',
      taskId: `task-${index}`,
      threadId: `thread-${index}`,
      to: { mode: 'participant', participants: ['codex.a'] },
      payload: { body: { summary: `Task ${index}` } }
    });
  }

  broker.sendIntent({
    intentId: 'approval-late',
    kind: 'request_approval',
    fromParticipantId: 'codex.a',
    taskId: 'task-late',
    threadId: 'thread-late',
    to: { mode: 'participant', participants: ['human.song'] },
    payload: { approvalId: 'app-late', approvalScope: 'submit_result', body: { summary: 'Review the late result?' } }
  });

  const approvals = broker.listProjectApprovals('intent-broker', { status: 'pending' });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].approvalId, 'app-late');
  assert.equal(approvals[0].decision, 'pending');
});

test('broker.close terminates active websocket clients so shutdown can complete', async () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({ broker });
  await server.listen(0, '127.0.0.1');
  broker.attachWebSocket(server.raw());

  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?participantId=agent.a`);
  await once(socket, 'open');

  broker.close();
  await once(socket, 'close');
  await server.close();
});

test('away mode defaults to off and can be toggled on and off', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });

  assert.equal(broker.getAwayMode(), false);
  broker.setAwayMode(true);
  assert.equal(broker.getAwayMode(), true);
  broker.setAwayMode(false);
  assert.equal(broker.getAwayMode(), false);
});
