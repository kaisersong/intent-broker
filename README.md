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
- globally unique participant aliases with automatic numeric suffixes
- project-scoped participant discovery
- current work-state tracking by participant
- `request_task`, `report_progress`, `request_approval`, `respond_approval`
- routing by `participant`, `role`, and `broadcast`
- inbox pull and ack cursor
- `GET /tasks/:taskId`
- `GET /threads/:threadId`
- `GET /events/replay`
- `GET /work-state`
- SQLite-backed persistent event storage
- WebSocket real-time notification channel
- verified Yunzhijia adapter inbound and outbound integration
- non-invasive Codex hook integration for real session inbox injection
- non-invasive Claude Code hook integration for project-level inbox injection

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

Automated collaboration smoke verification:

```bash
npm run verify:collaboration
```

This starts a temporary local broker, drives the real Codex and Claude Code bridge entrypoints, and writes logs plus an analysis summary under `.tmp/collaboration-smoke-*`.

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
  "alias": "codex",
  "kind": "agent",
  "roles": ["coder"],
  "capabilities": ["frontend.react"],
  "context": {
    "projectName": "intent-broker"
  }
}
```

List participants, optionally filtered by project:

```http
GET /participants
GET /participants?projectName=intent-broker
```

Resolve aliases for message-channel mentions:

```http
GET /participants/resolve?aliases=codex,claude
```

Rename a participant alias:

```http
POST /participants/:participantId/alias
```

Example:

```json
{
  "alias": "reviewer"
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

### Work State

Store or update the current work owned by a participant:

```http
POST /participants/:participantId/work-state
```

Example:

```json
{
  "status": "implementing",
  "summary": "Refactoring broker work-state API",
  "taskId": "task-9",
  "threadId": "thread-9"
}
```

Query the latest work state:

```http
GET /participants/:participantId/work-state
GET /work-state
GET /work-state?projectName=intent-broker
GET /work-state?participantId=codex.main
GET /work-state?status=blocked
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

## To Agents

If you are a coding agent such as Claude Code, Codex, OpenCode, xiaok code, or a similar worker, `Intent Broker` is the coordination layer you should talk to when you need durable task handoff, approvals, replay, or human-in-the-loop collaboration.

Use it like this:

### 1. Register yourself once per session

Register a participant before doing any work:

```http
POST /participants/register
```

Example:

```json
{
  "participantId": "codex.main",
  "kind": "agent",
  "roles": ["coder"],
  "capabilities": ["backend.node", "frontend.react"],
  "context": {
    "projectName": "intent-broker"
  }
}
```

Recommended naming:

- `participantId`: stable and tool-specific, for example `claude-code.main`, `codex.review`, `opencode.worker-1`, `xiaok-code.backend`
- `alias`: short human-facing handle, for example `codex`, `claude`, `xiaok`; broker keeps this globally unique and will auto-suffix on collision, such as `codex2`
- `roles`: broad routing labels such as `coder`, `reviewer`, `approver`
- `capabilities`: narrower skill labels such as `frontend.react`, `backend.node`, `docs.write`
- `context.projectName`: the current project the agent is actively working on, such as `intent-broker`

Why `projectName` matters:

- You can ask "who is working on `intent-broker`?"
- You can route a task to the agents already active on the same project
- You can warn before a handoff or submission when multiple agents are already on that project

If you installed the Codex or Claude Code hook bridge, session registration is already automatic. The current hook bridge also publishes an initial `idle` work state on session start, so other agents can discover that this session exists before any explicit handoff happens.

The bridge now also sends a preferred alias hint at registration time. Broker owns the final alias and may append numeric suffixes to keep aliases globally unique.

### 2. Pull work instead of assuming a permanent connection

The reliable path is inbox pull:

```http
GET /inbox/:participantId?after=0&limit=50
```

Read pending intents, execute the next useful action, then acknowledge what you consumed:

```http
POST /inbox/:participantId/ack
```

This design is intentional. If your process restarts, you can reconnect and pull again without losing task context.

Treat identifiers differently:

- `taskId`: the stable task handle you should reason about and reference in collaboration
- `threadId`: the stable conversation / negotiation handle you should continue replying on
- `eventId`: an internal event cursor for replay, inbox pull, ack, and debugging only

In other words, agents should coordinate around `taskId` and `threadId`, not around raw `eventId` values.

### 3. Query project state before you grab work

Before you take a same-project task, ask the broker what is already happening:

```http
GET /participants?projectName=intent-broker
GET /work-state?projectName=intent-broker
```

Use these queries to answer:

- who is already active on this project
- who is currently idle, blocked, reviewing, or implementing
- whether another agent is already touching the same task or thread

Recommended `work-state` values in the current prototype:

- `idle`
- `planning`
- `implementing`
- `reviewing`
- `blocked`
- `waiting_approval`
- `ready_to_submit`

When your focus changes, update your own work state before or alongside a progress report. That is the minimal building block for later autonomous negotiation and conflict avoidance.

### 4. Use aliases for human-to-agent coordination

Humans should not need to type long `participantId` values in a message channel. Use aliases instead:

- `@codex fix the failing broker test`
- `@claude @codex split the regression triage`
- `@all sync current blockers`

Current v1 behavior:

- aliases are globally unique across the broker
- collisions are auto-resolved with numeric suffixes, such as `codex2`
- alias changes create a broker event so connected clients can learn the new short name
- Yunzhijia now resolves `@alias` and `@all` into exact broker recipients
- Yunzhijia also supports `/alias @old newalias` to rename a participant from the message channel

### 5. Send intents as stateful collaboration events

Use `POST /intents` to communicate meaningful work state, not just raw chat text.

Typical patterns:

- `request_task`: assign or hand off a task to another participant or role
- `report_progress`: publish execution state, partial results, or blockers
- `request_approval`: ask a human to approve a risky or final step
- `respond_approval`: return a human approval decision back into the task flow

Example progress update:

```json
{
  "intentId": "progress-1",
  "kind": "report_progress",
  "fromParticipantId": "codex.main",
  "taskId": "task-1",
  "threadId": "thread-1",
  "to": {
    "mode": "participant",
    "participants": ["human.song"]
  },
  "payload": {
    "stage": "in_progress",
    "body": {
      "summary": "Implemented the adapter handshake and running verification"
    }
  }
}
```

## Codex Integration

The current best Codex UX is a non-invasive hook + skill bridge. It does not wrap how Codex starts. Instead, it installs two Codex hooks and one local skill:

- `SessionStart` hook: when a real Codex session starts or resumes, it silently registers the session to the broker, records the current `projectName`, and publishes an initial `idle` work state.
- `UserPromptSubmit` hook: before a real user prompt is submitted, it silently re-registers the session, then checks for newly arrived broker events and injects them into the turn only when there is pending collaboration context.
- `intent-broker` skill: gives the Codex session an explicit way to send task handoffs and progress updates.

Normal flow:

- do not manually register the Codex session
- open Codex in the target project directory
- let `SessionStart` auto-register the session on startup
- let `UserPromptSubmit` recover registration after a broker restart and only inject context when there is new collaboration work

### Install the Codex bridge

From this repo:

```bash
npm run codex:install
```

If you want the old visible hook execution lines for debugging, install with:

```bash
node adapters/codex-plugin/bin/codex-broker.js install --verbose-hooks
```

This writes or updates:

- `~/.codex/hooks.json`
- `~/.codex/skills/intent-broker` (symlink)
- `~/.local/bin/intent-broker` unified command shim
- `~/.intent-broker/codex/*.json` local cursor state

The Codex bridge now auto-registers the current project name using the current working directory basename by default. You can override it with `PROJECT_NAME`.

Notes:

- This preserves unrelated Codex hooks and only replaces previous `intent-broker` hook entries.
- The default install is now quiet: it does not print `Running ... hook: intent-broker ...` on every prompt submit.
- Current Codex source indicates lifecycle hooks are not supported on Windows yet, so this path is currently intended for macOS/Linux.
- In current real Codex behavior, `SessionStart` is observed when the session actually enters its first turn or resume flow, not merely when the TUI frame first appears.
- Hook-provided `session_id` now takes precedence over inherited `CODEX_THREAD_ID`, so starting a new Codex from inside another agent environment will not accidentally reuse the parent participant id.
- If you move this repo, run `npm run codex:install` again so the hook command paths are refreshed.

### Send from a real Codex session

Manual register remains available only as a debugging command when you need to inspect a session's derived participant id:

```bash
intent-broker register
```

Send a task to another participant:

```bash
intent-broker send-task claude-real-1 real-task-1 real-thread-1 "Please pick up the regression triage"
```

Send a progress update:

```bash
intent-broker send-progress real-task-1 real-thread-1 "Still investigating the failing broker handoff"
```

Check unread collaboration context without querying broker by hand:

```bash
intent-broker inbox
```

See who is active on the same project and what they are doing:

```bash
intent-broker who
```

Reply on the latest remembered `taskId/threadId` context:

```bash
intent-broker reply "Received, starting now"
```

Reply to an explicit alias while still reusing the latest `taskId/threadId`:

```bash
intent-broker reply @claude2 "Please review the latest patch"
```

### What this enables

Once installed, an already-open real Codex session can naturally participate in multi-agent communication:

- it keeps its native startup flow
- it receives broker context through hooks instead of a wrapper shell
- it can explicitly hand off tasks or publish progress with the same local bridge command set

## Claude Code Integration

Claude Code now has the same non-invasive hook bridge model as Codex, but installs into project settings:

- `SessionStart` hook: auto-registers the Claude Code session into broker context and publishes an initial `idle` work state
- `UserPromptSubmit` hook: silently re-registers after broker restart and injects only newly arrived broker inbox context before prompt submission

### Install the Claude Code bridge

From this repo root:

```bash
npm run claude-code:install
```

If you want visible hook execution lines for debugging, install with:

```bash
node adapters/claude-code-plugin/bin/claude-code-broker.js install --verbose-hooks
```

This writes or updates:

- `.claude/settings.json`
- `~/.local/bin/intent-broker` unified command shim
- `~/.intent-broker/claude-code/*.json` local cursor state

Notes:

- this preserves unrelated Claude Code hooks and only replaces previous `intent-broker` hook entries
- the default install is now quiet: it does not print `Running ... hook: intent-broker ...` on every prompt submit
- hook-provided `session_id` takes precedence over inherited session env, so nested launcher environments do not accidentally collapse multiple clients onto one participant id
- if you move this repo, run `npm run claude-code:install` again to refresh command paths

### Send from a real Claude Code session

Manual register remains available for debugging or inspecting derived participant ids:

```bash
intent-broker --tool claude-code register
```

Send a task to another participant:

```bash
intent-broker --tool claude-code send-task codex-real-1 real-task-1 real-thread-1 "Please pick up the regression triage"
```

Send a progress update:

```bash
intent-broker --tool claude-code send-progress real-task-1 real-thread-1 "Still investigating the failing broker handoff"
```

Check unread collaboration context:

```bash
intent-broker --tool claude-code inbox
```

See same-project collaborators and work-state:

```bash
intent-broker --tool claude-code who
```

Reply on the latest remembered collaboration context:

```bash
intent-broker --tool claude-code reply "Received, starting now"
```

Override the reply target by alias while keeping the latest `taskId/threadId`:

```bash
intent-broker --tool claude-code reply @codex2 "Please rebase before submit"
```

### 6. Use approvals for risky or user-visible transitions

If you are about to:

- submit final results
- deploy or release
- perform destructive changes
- ask a human to confirm correctness

send `request_approval` instead of inventing your own ad hoc message format. That keeps the approval state queryable and replayable.

### 7. Recover through replay, not memory

If you crash, restart, or lose local context:

- pull your inbox again
- query `GET /tasks/:taskId`
- query `GET /threads/:threadId`
- use `GET /events/replay` for wider reconstruction

Do not depend on ephemeral terminal history as the system of record.

### 8. Use adapters when humans are not inside the terminal

If the human lives in Yunzhijia, Feishu, DingTalk, Telegram, Discord, or mobile surfaces, use a platform adapter instead of hard-coding chat logic into the agent.

See:

- [adapters/yunzhijia/README.md](./adapters/yunzhijia/README.md)
- [adapters/yunzhijia/QUICKSTART.md](./adapters/yunzhijia/QUICKSTART.md)
- [docs/adapter-example.js](./docs/adapter-example.js)

### 9. Practical recommendation for code agents

For Claude Code / Codex / OpenCode / xiaok code style agents, the most effective pattern is:

1. Register at startup.
2. Poll inbox at task boundaries, idle points, or explicit hooks.
3. Query same-project participants and work state before taking ownership.
4. Acknowledge consumed events.
5. Update work state and emit progress at meaningful milestones.
6. Ask for approval before irreversible or user-visible completion.
7. Replay task state after restart instead of guessing.

That gives you a durable collaboration timeline without forcing every agent into the same runtime or websocket lifecycle.

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
