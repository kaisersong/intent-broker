# Intent Broker

[中文版本](./README.zh-CN.md)

Local-first collaboration broker for multi-agent workflows. It is not a chat server and not a workflow platform. It is a reliable protocol layer that persists events before delivery, so agents like Codex, Claude Code, and OpenCode can collaborate with human participants around the same task object.

Current release version: `0.1.0`

## Design Principles

The focus of `Intent Broker` is not "letting multiple windows send messages to each other". The goal is to upgrade collaboration from ad hoc copy-paste into a recoverable, replayable, auditable protocol.

There are four core ideas:

- Event-first: every intent is written to a SQLite event log before inbox delivery and state aggregation.
- Protocol-first: a small set of stable structural fields carries task semantics, while natural language bodies carry the concrete work intent.
- Local-first: v1 solves single-machine collaboration without requiring remote services or permanently connected agents.
- Reliability-first: `HTTP pull + ack cursor` is the primary consumption path, so losing a connection does not lose critical task context.

That means the broker is responsible for tasks, threads, approvals, routing, and replay. It does not replace the reasoning or tool execution done by each agent.

## Use Cases

This project is a good fit when:

- You run multiple Codex / Claude Code / OpenCode windows on the same machine and need them to collaborate on the same task.
- Human participants need to interrupt, approve, take over, or confirm delivery instead of only watching agents run.
- Agents should actively pull pending work at hooks, idle points, or task boundaries instead of staying on a permanent websocket connection.
- You need a task timeline that supports reconnect replay, task/thread event playback, and event-level debugging.
- You want a reliable local protocol layer before building higher-level adapters, mobile approval panels, or LAN collaboration.

## Current Capabilities

The current prototype supports:

- participant registration
- `request_task`, `report_progress`, `request_approval`, `respond_approval`
- routing by `participant`, `role`, and `broadcast`
- inbox pull and ack cursor
- `GET /tasks/:taskId`
- `GET /threads/:threadId`
- `GET /events/replay`
- SQLite-backed persistent event storage
- WebSocket real-time notification channel
- verified Yunzhijia adapter inbound and outbound integration

## Tech Stack

- Node 22
- native ESM
- `node:http`
- `node:sqlite`
- `node:test`

The goal is straightforward: get the system running today, avoid unnecessary runtime dependencies, and validate the protocol and reliability path first.

## Quick Start

### 1. Requirements

Use Node 22 or newer.

### 2. Start the broker

```bash
npm start
```

Default listen address:

- `http://127.0.0.1:4318`

You can override it with environment variables:

```bash
PORT=4321
INTENT_BROKER_DB=./.tmp/intent-broker.db npm start
```

Windows PowerShell:

```powershell
$env:PORT='4321'
$env:INTENT_BROKER_DB='D:\projects\intent-broker\.tmp\intent-broker.db'
npm start
```

## Tests

```bash
npm test
```

Current test coverage includes:

- reducer task / approval state transitions
- SQLite store append / inbox / ack / replay
- broker service routing and approval aggregation
- HTTP API end-to-end flow
- Yunzhijia adapter config regression test
- Yunzhijia adapter inbound / outbound integration test

Note: the test script uses `node --experimental-test-isolation=none --test` because, in the current sandbox environment, plain `node --test` can trigger child-process `EPERM`.

## API Overview

### Health

```http
GET /health
```

### Participants

```http
POST /participants/register
```

Example:

```json
{
  "participantId": "agent.a",
  "kind": "agent",
  "roles": ["coder"],
  "capabilities": ["frontend.react"]
}
```

### Send Intent

```http
POST /intents
```

Example:

```json
{
  "intentId": "int-1",
  "kind": "request_task",
  "fromParticipantId": "human.song",
  "taskId": "task-1",
  "threadId": "thread-1",
  "to": {
    "mode": "participant",
    "participants": ["agent.a"]
  },
  "payload": {
    "body": {
      "summary": "Please fix the export font issue"
    }
  }
}
```

### Inbox Pull / Ack

```http
GET /inbox/:participantId?after=0&limit=50
POST /inbox/:participantId/ack
```

Ack body:

```json
{
  "eventId": 12
}
```

### Query Views

```http
GET /tasks/:taskId
GET /threads/:threadId
GET /events/replay?after=0&taskId=task-1
```

### Approval Response

```http
POST /approvals/:approvalId/respond
```

Example:

```json
{
  "taskId": "task-1",
  "fromParticipantId": "human.song",
  "decision": "approved"
}
```

## Project Structure

```text
src/
  broker/        coordination layer for participants, routing, and aggregate queries
  domain/        pure state transition logic
  http/          HTTP server and routes
  store/         SQLite schema and event storage
  cli.js         local broker entry point

tests/
  broker/        service tests
  domain/        reducer tests
  http/          API integration tests
  store/         SQLite store tests
```

## Extensions

### Mobile Connectivity

A phone can connect as a `kind: "mobile"` participant and support:

- WebSocket real-time notifications
- simplified inboxes that only show actionable items
- approval and confirmation actions

See [MOBILE.md](./MOBILE.md).

### Messaging Platform Integration

Use standalone adapter processes to connect Yunzhijia, Feishu, DingTalk, Telegram, Discord, and other platforms:

```text
Messaging Platform → Platform Adapter → Intent Broker → Agents
```

See:

- [docs/ADAPTERS.md](./docs/ADAPTERS.md) - adapter architecture
- [docs/adapter-example.js](./docs/adapter-example.js) - minimal implementation example
- [docs/platform-adapters.md](./docs/platform-adapters.md) - platform integration guide

This repository already includes a working Yunzhijia adapter:

- [adapters/yunzhijia/README.md](./adapters/yunzhijia/README.md) - configuration and runtime details
- [adapters/yunzhijia/QUICKSTART.md](./adapters/yunzhijia/QUICKSTART.md) - quick integration steps

## Next Steps

The repository is still in the prototype stage. The most valuable next steps are:

- fuller `capability` routing coverage
- richer task / approval / thread projection views
- Feishu / DingTalk / Telegram / Discord adapters
- LAN / remote deployment mode

## License

Not declared yet. Follow the repository owner's later decision.
