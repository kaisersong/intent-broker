# Intent Broker V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Intent Broker v1 that persists events in SQLite, exposes a minimal HTTP API, supports task collaboration plus approvals, and can be validated today with automated tests.

**Architecture:** Use a single-process Node 22 service with built-in `node:sqlite`, `node:test`, and `node:http`. The broker writes every intent to an append-only SQLite event log, derives current task and approval views in process, and delivers inbox items via HTTP pull with explicit ack cursors. WebSocket is deferred; the validation target is the durable HTTP pull path.

**Tech Stack:** Node 22 ESM, `node:sqlite`, `node:test`, `node:assert/strict`, `node:http`, `node:fs`, SQLite

---

## File Structure

- Create: `package.json` - scripts and ESM package metadata
- Create: `.gitignore` - ignore runtime db and local artifacts
- Create: `src/intent-types.js` - intent kind constants and lightweight validators
- Create: `src/domain/reducer.js` - pure event-to-view state transitions for tasks and approvals
- Create: `src/store/schema.js` - SQLite schema creation
- Create: `src/store/event-store.js` - append events, inbox queries, ack handling, replay queries
- Create: `src/broker/service.js` - orchestration layer for register participant, send intent, read inbox, respond approval
- Create: `src/http/server.js` - HTTP routing and JSON request/response helpers
- Create: `src/cli.js` - start broker from terminal with db path and port
- Create: `tests/domain/reducer.test.js` - task and approval lifecycle tests
- Create: `tests/store/event-store.test.js` - SQLite persistence, inbox, ack, replay tests
- Create: `tests/http/server.test.js` - API integration tests using live local server
- Create: `tests/fixtures/temp-dir.js` - temp sqlite path helpers for tests
- Modify: `docs/superpowers/specs/2026-03-31-intent-broker-design.md` only if implementation reveals a spec bug

### Task 1: Bootstrap Runtime And Health Endpoint

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/http/server.js`
- Create: `src/cli.js`
- Test: `tests/http/server.test.js`

- [ ] **Step 1: Create package metadata and scripts**

```json
{
  "name": "intent-broker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "start": "node src/cli.js"
  }
}
```

```gitignore
node_modules/
*.db
*.db-shm
*.db-wal
coverage/
.tmp/
```

- [ ] **Step 2: Write the failing health endpoint test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/http/server.js';

test('GET /health returns ok payload', async () => {
  const server = createServer({ broker: null });
  await server.listen(0, '127.0.0.1');
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true });

  await server.close();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- tests/http/server.test.js`
Expected: FAIL with module or `createServer` missing

- [ ] **Step 4: Write minimal implementation for server bootstrap**

```js
import http from 'node:http';

export function createServer() {
  const raw = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  return {
    listen(port, host) {
      return new Promise((resolve) => raw.listen(port, host, resolve));
    },
    close() {
      return new Promise((resolve, reject) => raw.close((err) => (err ? reject(err) : resolve())));
    },
    address() {
      return raw.address();
    }
  };
}
```

```js
import { createServer } from './http/server.js';

const server = createServer();
await server.listen(Number(process.env.PORT || 4318), '127.0.0.1');
console.log(`intent-broker listening on http://127.0.0.1:${server.address().port}`);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/http/server.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore src/http/server.js src/cli.js tests/http/server.test.js
git commit -m "feat: bootstrap intent broker server"
```

### Task 2: Domain Reducer For Task And Approval State

**Files:**
- Create: `src/intent-types.js`
- Create: `src/domain/reducer.js`
- Test: `tests/domain/reducer.test.js`

- [ ] **Step 1: Write failing domain lifecycle tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceEventStream } from '../../src/domain/reducer.js';

test('request -> accept -> progress -> result -> complete produces expected task state', () => {
  const state = reduceEventStream([
    { kind: 'request_task', taskId: 'task-1', threadId: 'thread-1' },
    { kind: 'accept_task', taskId: 'task-1', assignmentMode: 'single', participantId: 'agent.a' },
    { kind: 'report_progress', taskId: 'task-1', stage: 'started' },
    { kind: 'submit_result', taskId: 'task-1', submissionId: 'sub-1' },
    { kind: 'respond_approval', taskId: 'task-1', approvalId: 'app-1', decision: 'approved', completesTask: true }
  ]);

  assert.equal(state.tasks['task-1'].status, 'completed');
  assert.equal(state.tasks['task-1'].assignees[0], 'agent.a');
  assert.equal(state.tasks['task-1'].latestSubmissionId, 'sub-1');
});
```

```js
test('request approval creates pending approval and blocks task', () => {
  const state = reduceEventStream([
    { kind: 'request_task', taskId: 'task-2', threadId: 'thread-2' },
    { kind: 'request_approval', taskId: 'task-2', approvalId: 'app-2', approvalScope: 'submit_result' }
  ]);

  assert.equal(state.tasks['task-2'].status, 'blocked');
  assert.equal(state.approvals['app-2'].status, 'pending');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/domain/reducer.test.js`
Expected: FAIL with reducer missing

- [ ] **Step 3: Implement minimal reducer and intent constants**

```js
export const INTENT_KINDS = [
  'request_task',
  'accept_task',
  'decline_task',
  'ask_clarification',
  'answer_clarification',
  'report_progress',
  'submit_result',
  'request_approval',
  'respond_approval',
  'cancel_task'
];
```

```js
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

export function reduceEventStream(events) {
  const state = { tasks: {}, approvals: {} };

  for (const event of events) {
    const task = event.taskId ? ensureTask(state, event) : null;

    if (event.kind === 'request_task') task.status = 'open';
    if (event.kind === 'accept_task') {
      task.assignees = Array.from(new Set([...task.assignees, event.participantId]));
      task.status = 'assigned';
    }
    if (event.kind === 'report_progress' && event.stage === 'started') task.status = 'in_progress';
    if (event.kind === 'submit_result') {
      task.submissions.push(event.submissionId);
      task.latestSubmissionId = event.submissionId;
      task.status = 'submitted';
    }
    if (event.kind === 'request_approval') {
      state.approvals[event.approvalId] = { approvalId: event.approvalId, taskId: event.taskId, status: 'pending' };
      task.status = 'blocked';
    }
    if (event.kind === 'respond_approval') {
      state.approvals[event.approvalId] = { approvalId: event.approvalId, taskId: event.taskId, status: event.decision };
      task.status = event.completesTask ? 'completed' : 'assigned';
    }
  }

  return state;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/domain/reducer.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/intent-types.js src/domain/reducer.js tests/domain/reducer.test.js
git commit -m "feat: add task and approval reducer"
```

### Task 3: SQLite Event Store And Inbox Semantics

**Files:**
- Create: `src/store/schema.js`
- Create: `src/store/event-store.js`
- Create: `tests/fixtures/temp-dir.js`
- Test: `tests/store/event-store.test.js`

- [ ] **Step 1: Write failing persistence and ack tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventStore } from '../../src/store/event-store.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

test('appendIntent writes event and inbox entries for broadcast recipients', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  const event = store.appendIntent({
    intentId: 'int-1',
    kind: 'request_task',
    fromParticipantId: 'human.song',
    taskId: 'task-1',
    threadId: 'thread-1',
    payload: { body: { summary: 'fix it' } },
    recipients: ['agent.a', 'agent.b']
  });

  assert.equal(event.eventId, 1);
  assert.equal(store.readInbox('agent.a', { after: 0 }).items.length, 1);
  assert.equal(store.readInbox('agent.b', { after: 0 }).items.length, 1);
});
```

```js
test('ackInbox advances cursor and hides older events from future pulls', () => {
  const store = createEventStore({ dbPath: createTempDbPath() });
  store.appendIntent({ intentId: 'int-1', kind: 'request_task', fromParticipantId: 'human.song', taskId: 'task-1', threadId: 'thread-1', payload: {}, recipients: ['agent.a'] });
  store.ackInbox('agent.a', 1);

  assert.equal(store.readInbox('agent.a', { after: 1 }).items.length, 0);
  assert.equal(store.getCursor('agent.a'), 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/store/event-store.test.js`
Expected: FAIL with store missing

- [ ] **Step 3: Implement schema and store**

```js
import { DatabaseSync } from 'node:sqlite';

export function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      from_participant_id TEXT NOT NULL,
      task_id TEXT,
      thread_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS inbox_entries (
      inbox_entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      acked_at TEXT,
      discarded_at TEXT
    );
    CREATE TABLE IF NOT EXISTS participant_cursors (
      participant_id TEXT PRIMARY KEY,
      cursor_event_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
```

```js
export function createEventStore({ dbPath }) {
  const db = new DatabaseSync(dbPath);
  initializeSchema(db);

  return {
    appendIntent({ intentId, kind, fromParticipantId, taskId, threadId, payload, recipients }) {
      const insertEvent = db.prepare(`INSERT INTO events (intent_id, kind, from_participant_id, task_id, thread_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)`);
      const result = insertEvent.run(intentId, kind, fromParticipantId, taskId, threadId, JSON.stringify(payload));
      const eventId = Number(result.lastInsertRowid);
      const insertInbox = db.prepare(`INSERT INTO inbox_entries (participant_id, event_id) VALUES (?, ?)`);
      for (const participantId of recipients) insertInbox.run(participantId, eventId);
      return { eventId };
    },
    readInbox(participantId, { after = 0, limit = 50 } = {}) {
      const stmt = db.prepare(`SELECT ie.event_id, e.intent_id, e.kind, e.task_id, e.thread_id, e.payload_json FROM inbox_entries ie JOIN events e ON e.event_id = ie.event_id WHERE ie.participant_id = ? AND ie.event_id > ? AND ie.discarded_at IS NULL ORDER BY ie.event_id ASC LIMIT ?`);
      const items = stmt.all(participantId, after, limit).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
      return { items };
    },
    ackInbox(participantId, eventId) {
      db.prepare(`INSERT INTO participant_cursors (participant_id, cursor_event_id) VALUES (?, ?) ON CONFLICT(participant_id) DO UPDATE SET cursor_event_id = excluded.cursor_event_id, updated_at = CURRENT_TIMESTAMP`).run(participantId, eventId);
      db.prepare(`UPDATE inbox_entries SET delivery_status = 'acked', acked_at = CURRENT_TIMESTAMP WHERE participant_id = ? AND event_id <= ?`).run(participantId, eventId);
    },
    getCursor(participantId) {
      const row = db.prepare(`SELECT cursor_event_id FROM participant_cursors WHERE participant_id = ?`).get(participantId);
      return row ? row.cursor_event_id : 0;
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/store/event-store.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/schema.js src/store/event-store.js tests/store/event-store.test.js tests/fixtures/temp-dir.js
git commit -m "feat: add sqlite event store and inbox delivery"
```

### Task 4: Broker Service For Routing, Approvals, And Views

**Files:**
- Create: `src/broker/service.js`
- Modify: `src/domain/reducer.js`
- Modify: `src/store/event-store.js`
- Test: `tests/store/event-store.test.js`
- Test: `tests/domain/reducer.test.js`

- [ ] **Step 1: Write failing service tests for participant registration and intent routing**

```js
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
});
```

```js
test('respondApproval updates approval view to approved', () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  broker.registerParticipant({ participantId: 'human.song', kind: 'human', roles: ['approver'], capabilities: [] });
  broker.sendIntent({ intentId: 'int-task', kind: 'request_task', fromParticipantId: 'human.song', taskId: 'task-2', threadId: 'thread-2', to: { mode: 'participant', participants: ['agent.a'] }, payload: {} });
  broker.sendIntent({ intentId: 'int-approval', kind: 'request_approval', fromParticipantId: 'agent.a', taskId: 'task-2', threadId: 'thread-2', to: { mode: 'participant', participants: ['human.song'] }, payload: { approvalId: 'app-1' } });

  broker.respondApproval({ approvalId: 'app-1', taskId: 'task-2', fromParticipantId: 'human.song', decision: 'approved' });

  assert.equal(broker.getApprovalView('app-1').status, 'approved');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/domain/reducer.test.js tests/store/event-store.test.js`
Expected: FAIL with service missing or approval view missing

- [ ] **Step 3: Implement service orchestration**

```js
export function createBrokerService({ dbPath }) {
  const participants = new Map();
  const store = createEventStore({ dbPath });

  function resolveRecipients(to) {
    if (to.mode === 'participant') return [...new Set(to.participants || [])];
    if (to.mode === 'role') {
      return [...participants.values()].filter((entry) => (to.roles || []).some((role) => entry.roles.includes(role))).map((entry) => entry.participantId);
    }
    if (to.mode === 'capability') {
      return [...participants.values()].filter((entry) => (to.capabilities || []).some((cap) => entry.capabilities.includes(cap))).map((entry) => entry.participantId);
    }
    return [...participants.keys()];
  }

  return {
    registerParticipant(participant) {
      participants.set(participant.participantId, { roles: [], capabilities: [], ...participant });
      return participants.get(participant.participantId);
    },
    sendIntent(input) {
      const recipients = resolveRecipients(input.to).filter((id) => id !== input.fromParticipantId);
      const event = store.appendIntent({
        intentId: input.intentId,
        kind: input.kind,
        fromParticipantId: input.fromParticipantId,
        taskId: input.taskId,
        threadId: input.threadId,
        payload: { to: input.to, ...input.payload },
        recipients
      });
      return { eventId: event.eventId, recipients };
    },
    readInbox(participantId, options) {
      return store.readInbox(participantId, options);
    },
    ackInbox(participantId, eventId) {
      return store.ackInbox(participantId, eventId);
    },
    respondApproval({ approvalId, taskId, fromParticipantId, decision }) {
      return this.sendIntent({
        intentId: `approval-${approvalId}-${decision}`,
        kind: 'respond_approval',
        fromParticipantId,
        taskId,
        threadId: null,
        to: { mode: 'participant', participants: [] },
        payload: { approvalId, decision, completesTask: false }
      });
    },
    getApprovalView(approvalId) {
      const state = reduceEventStream(store.listEvents());
      return state.approvals[approvalId] ?? null;
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/domain/reducer.test.js tests/store/event-store.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/broker/service.js src/domain/reducer.js src/store/event-store.js tests/domain/reducer.test.js tests/store/event-store.test.js
git commit -m "feat: add broker service routing and approval views"
```

### Task 5: HTTP API End-To-End Flow

**Files:**
- Modify: `src/http/server.js`
- Modify: `src/cli.js`
- Test: `tests/http/server.test.js`

- [ ] **Step 1: Write failing API tests for register, send, pull, ack, and approval response**

```js
test('participant can register, receive inbox items, ack them, and respond to approval', async () => {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({ broker });
  await server.listen(0, '127.0.0.1');
  const { port } = server.address();

  await fetch(`http://127.0.0.1:${port}/participants/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId: 'agent.a', kind: 'agent', roles: ['coder'], capabilities: ['frontend.react'] })
  });

  await fetch(`http://127.0.0.1:${port}/intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intentId: 'int-1',
      kind: 'request_task',
      fromParticipantId: 'human.song',
      taskId: 'task-1',
      threadId: 'thread-1',
      to: { mode: 'participant', participants: ['agent.a'] },
      payload: { body: { summary: 'fix it' } }
    })
  });

  const inboxResponse = await fetch(`http://127.0.0.1:${port}/inbox/agent.a?after=0`);
  const inboxBody = await inboxResponse.json();

  assert.equal(inboxBody.items.length, 1);

  await fetch(`http://127.0.0.1:${port}/inbox/agent.a/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventId: inboxBody.items[0].eventId })
  });

  await server.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/http/server.test.js`
Expected: FAIL with POST routes missing

- [ ] **Step 3: Implement JSON routes and broker wiring**

```js
if (req.method === 'POST' && req.url === '/participants/register') {
  const body = await readJson(req);
  const participant = broker.registerParticipant(body);
  return json(res, 200, participant);
}

if (req.method === 'POST' && req.url === '/intents') {
  const body = await readJson(req);
  return json(res, 202, broker.sendIntent(body));
}

if (req.method === 'GET' && pathname.startsWith('/inbox/')) {
  const participantId = pathname.split('/')[2];
  const after = Number(searchParams.get('after') || '0');
  return json(res, 200, broker.readInbox(participantId, { after }));
}

if (req.method === 'POST' && pathname.endsWith('/ack')) {
  const participantId = pathname.split('/')[2];
  const body = await readJson(req);
  broker.ackInbox(participantId, Number(body.eventId));
  return json(res, 200, { ok: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/http/server.test.js`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS with all tests green

- [ ] **Step 6: Commit**

```bash
git add src/http/server.js src/cli.js tests/http/server.test.js
git commit -m "feat: expose broker http api"
```

## Self-Review

- Spec coverage:
  - participant/task/thread/approval concepts: Task 2-4
  - SQLite durable event log and inbox cursor: Task 3
  - HTTP pull API and ack flow: Task 5
  - task collaboration + approval flow: Task 2, Task 4, Task 5
- Placeholder scan:
  - no `TBD` / `TODO`
  - each code step contains concrete file targets and commands
- Type consistency:
  - `participantId`, `taskId`, `threadId`, `approvalId`, `intentId` stay consistent across tasks
  - intent kinds match the approved spec names
