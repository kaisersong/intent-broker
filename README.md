# Intent Broker

[中文版本](./README.zh-CN.md)

Local-first collaboration broker for multi-agent workflows. It is not a chat server and not a workflow platform. It is a reliable protocol layer that persists events before delivery, so agents like Codex, Claude Code, and OpenCode can collaborate with human participants around the same task object.

Current release version: `0.1.2`

`Intent Broker` is a coordination layer for one human and multiple coding agents working on the same project.

Its value is not "letting agents send messages". Its value is reducing the coordination cost of parallel agent work: who is working on what, who should pick up the next task, who may conflict, who needs approval, and how collaboration survives restarts or disconnects.

Without that layer, the human becomes the router, memory, and conflict detector for every Codex / Claude Code / OpenCode window. `Intent Broker` moves that coordination burden into a recoverable local system.

## Why It Exists

Multi-agent coding gets hard before model quality becomes the bottleneck.

Even if you use multiple terminals, worktrees, or separate branches, the same coordination problems still appear:

- a human has to remember which agent is doing which part of the project
- agents do not naturally know who else is already active on the same repo
- parallel work creates ownership confusion and conflict risk
- approval, handoff, and progress updates get lost across chat windows
- if a broker, client, or message channel restarts, the collaboration context often disappears

`Intent Broker` is meant to solve that layer first. The human should set direction, approve risky steps, and make final calls. Routine synchronization, task handoff, recovery, and most negotiation should move into the brokered collaboration flow.

## Design Principles

The design target is straightforward: make multi-agent collaboration reliable enough that people can run several coding agents in parallel without becoming a full-time dispatcher.

The current design follows four principles:

- Coordination-first: model outputs matter, but the immediate product problem is coordination cost across agents on the same project.
- Human-as-supervisor: the human should set goals, approve risky actions, and resolve disputes, not manually forward every update between agents.
- Recoverable-by-default: tasks, threads, approvals, and delivery state should survive broker restarts, idle sessions, and reconnects.
- Non-invasive integration: Codex, Claude Code, and similar tools should keep their native UX. Broker support should arrive through hooks, skills, adapters, and local bridge processes rather than wrappers that take over the tool.

In practice that means the broker owns shared collaboration state such as presence, work-state, routing, delivery, replay, and task/thread history. Each agent still keeps its own reasoning loop and tool execution.

## Use Cases

This project is a good fit when:

- You run multiple Codex / Claude Code / OpenCode windows on the same machine and need them to collaborate on the same task.
- Human participants need to interrupt, approve, take over, or confirm delivery instead of only watching agents run.
- Agents should actively pull pending work at hooks, idle points, or task boundaries instead of staying on a permanent websocket connection.
- You need a task timeline that supports reconnect replay, task/thread event playback, and event-level debugging.
- You want a reliable local protocol layer before building higher-level adapters, mobile approval panels, or LAN collaboration.

## Example Scenario

One practical scenario is a human coordinating multiple coding agents on the same project:

1. A human opens one Codex session and one Claude Code session in the same repo.
2. Both sessions auto-register to `Intent Broker` with the same `projectName`, publish presence, and expose short aliases such as `@codex` and `@claude`.
3. The human sends `@codex` a task from Yunzhijia such as "own the websocket reconnect fix", then sends `@claude` a parallel task such as "review the shutdown path and look for conflicts".
4. Each agent updates its own work-state, publishes progress, and can ask the other agent for help without relying on copy-paste through the human. When a broker-injected actionable item expects a reply, the agent can answer normally in its local TUI and let the bridge mirror that answer back into broker.
5. Before landing, one agent can query who else is touching the same project, warn about overlap, and negotiate handoff or conflict resolution through the same task/thread timeline.
6. If broker restarts or one agent goes idle, the task context is still durable. Codex can auto-resume actionable broker work while idle, and Claude Code still resumes from broker state on the next prompt submit or explicit inbox pull instead of losing coordination.

The point is not just "agents can chat". The point is that the human can delegate parallel work, and the agents can keep enough shared state to coordinate ownership, progress, approvals, and conflict handling with less manual relay.

## Current Capabilities

The current prototype supports:

- participant registration
- globally unique participant aliases with automatic numeric suffixes
- project-scoped participant discovery
- current work-state tracking by participant
- default delivery semantics for task, ask, note, and progress-style collaboration
- actionable vs informational delivery semantics with default mapping by sender and intent kind
- websocket-backed online / offline presence tracking
- join / leave presence broadcasts for connected collaborators
- `request_task`, `report_progress`, `request_approval`, `respond_approval`
- routing by `participant`, `role`, and `broadcast`
- inbox pull and ack cursor
- delivery feedback with `onlineRecipients`, `offlineRecipients`, and `deliveredCount`
- `GET /tasks/:taskId`
- `GET /threads/:threadId`
- `GET /events/replay`
- `GET /work-state`
- SQLite-backed persistent event storage
- WebSocket real-time notification channel
- verified Yunzhijia adapter inbound and outbound integration
- non-invasive Codex hook integration for real session inbox injection
- Codex idle auto-dispatch for actionable queue items plus post-turn continuation through the `Stop` hook
- non-invasive Claude Code hook integration for project-level inbox injection
- automatic actionable-reply mirroring from real Codex / Claude Code transcript output back into broker, with explicit `intent-broker reply` fallback when transcript capture is unavailable
- session-scoped realtime bridge queue with quiet reconnect after broker restart

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

By default, `npm start` now reads [intent-broker.config.json](./intent-broker.config.json) and starts the broker-managed channels declared there. For the current prototype, that means you can let the broker manage the Yunzhijia channel instead of starting a separate adapter process.

Default listen address:

- `http://127.0.0.1:4318`

Recommended managed-channel config:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 4318,
    "dbPath": "./.tmp/intent-broker.db"
  },
  "channels": {
    "yunzhijia": {
      "enabled": true,
      "sendUrlEnv": "YZJ_SEND_URL"
    }
  }
}
```

Then start with:

```bash
YZJ_SEND_URL='https://www.yunzhijia.com/gateway/robot/webhook/send?yzjtype=0&yzjtoken=YOUR_TOKEN' npm start
```

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
- broker config loading and managed channel startup
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

Accepted intents now return both routing and real-time delivery feedback:

```json
{
  "eventId": 71,
  "recipients": ["codex.main", "claude.main"],
  "onlineRecipients": ["codex.main"],
  "offlineRecipients": ["claude.main"],
  "deliveredCount": 1
}
```

That means:

- `recipients`: who the broker routed to
- `onlineRecipients`: who had an active websocket and saw the event immediately
- `offlineRecipients`: who only received durable inbox delivery and must pull later
- `deliveredCount`: how many recipients got real-time delivery right now

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

### Presence

```http
GET /presence
GET /presence/:participantId
POST /presence/:participantId
```

Presence is also updated automatically when a registered participant connects or disconnects on the broker websocket. Those transitions emit `participant_presence_updated` events so other connected agents and human channels can see who just came online or left.

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

On `SessionStart`, the local bridge also launches two quiet background helpers:

- a presence keeper that re-registers after broker restart and marks the session offline when the parent exits
- a realtime bridge that subscribes over websocket and appends incoming events into local queue state under `~/.intent-broker/<tool>/`

Current bridge behavior by tool:

- human channel -> agent defaults to actionable commands
- agent `task` / `ask` defaults to actionable; agent `note` / `progress` / reply defaults to informational
- Codex can auto-dispatch actionable queue items while idle, and auto-continue them after the current turn through the `Stop` hook
- those Codex automatic execution paths also sync broker `work-state` between `idle` and `implementing`, so project peers and message channels can see who is actively working
- broker-injected actionable work now prefers "normal local answer, automatic broker mirror" over "answer locally and then manually retype a reply"
- if transcript capture fails, explicit `intent-broker reply ...` remains the safe fallback and no automatic reply is sent
- Claude Code keeps the same queue semantics, but consumes queued work on the next prompt submit or explicit inbox pull

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

Current delivery defaults:

- human channel -> agent: actionable
- agent `task` / `ask`: actionable
- agent `note` / `progress` / reply: informational

When needed, you can still override the semantic explicitly with `payload.delivery`.

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
- when a mentioned target is offline, Yunzhijia tells the human that the message was queued in broker inbox and not delivered in real time
- Yunzhijia supports `@broker list` and `@broker list <projectName>` to show online/offline agents in the channel
- agent online/offline transitions are also announced into the Yunzhijia channel

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

If you care about immediate coordination, do not stop at `recipients`. Check `onlineRecipients` and `offlineRecipients` in the broker response. A routed message is durable either way, but only `onlineRecipients` saw it instantly.

### 6. Let humans inspect live collaborator state from the channel

In Yunzhijia, the human should not need to leave the channel just to see who is safe to `@`.

Use:

- `@broker list`
- `@broker list intent-broker`

The adapter will post a channel message grouped by `online` and `offline`, including each agent alias, project, and latest work-state summary.

## Codex Integration

The current best Codex UX is a non-invasive hook + skill bridge. It does not wrap how Codex starts. Instead, it installs three Codex hooks and one local skill:

- `SessionStart` hook: when a real Codex session starts or resumes, it silently registers the session to the broker, records the current `projectName`, publishes an initial `idle` work state, and launches a lightweight background keeper that keeps the session present while the TUI stays open.
- `SessionStart` hook: it also launches a realtime bridge daemon that subscribes over websocket and persists inbound events into local queue state immediately.
- `UserPromptSubmit` hook: before a real user prompt is submitted, it silently re-registers the session, then checks for newly arrived broker events and injects them into the turn only when there is pending collaboration context.
- `Stop` hook: when the current Codex turn finishes, it checks whether actionable broker work arrived meanwhile and, if so, turns that queue into an auto-continue prompt for the next turn without interrupting the work that just finished.
- `intent-broker` skill: gives the Codex session an explicit way to send task handoffs and progress updates.

Normal flow:

- do not manually register the Codex session
- open Codex in the target project directory
- let `SessionStart` auto-register the session on startup
- let the background keeper keep presence alive and re-register after a broker restart even if the session is idle
- let the realtime bridge auto-dispatch actionable queue items when the Codex session is idle
- let `UserPromptSubmit` inject queued context first when the local session enters another prompt submit
- let `Stop` auto-continue actionable queue items after the current turn finishes, so collaboration work is not lost and the current turn is not interrupted mid-flight

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
- `~/.intent-broker/codex/*.json` local cursor state, realtime queue state, runtime state, and helper metadata

The Codex bridge now auto-registers the current project name using the current working directory basename by default. You can override it with `PROJECT_NAME`.

Notes:

- This preserves unrelated Codex hooks and only replaces previous `intent-broker` hook entries.
- The default install is now quiet: it does not print `Running ... hook: intent-broker ...` on every prompt submit.
- Current Codex source indicates lifecycle hooks are not supported on Windows yet, so this path is currently intended for macOS/Linux.
- In current real Codex behavior, `SessionStart` is observed when the session actually enters its first turn or resume flow, not merely when the TUI frame first appears.
- Hook-provided `session_id` now takes precedence over inherited `CODEX_THREAD_ID`, so starting a new Codex from inside another agent environment will not accidentally reuse the parent participant id.
- The background keeper keeps presence online while the Codex parent process is alive, and marks the participant offline after the parent exits.
- The realtime bridge quietly reconnects after broker restart and keeps appending websocket events into local queue state.
- On the next prompt submit, Codex now drains the local realtime queue before falling back to broker poll, so websocket-delivered items are injected first.
- Hook-injected collaboration context now separates actionable items from informational items. Human-channel messages and `task` / `ask` default to actionable; `note` / `progress` default to informational.
- If the Codex session is idle and actionable queue items arrive, the realtime bridge can auto-run `codex exec --json --full-auto resume ...` so work starts without a manual prompt.
- If the Codex session is already busy, the `Stop` hook converts queued actionable work into an auto-continue prompt after the current turn completes.
- If a broker-injected actionable item is answered inside the Codex TUI, the bridge now tries to mirror the final local answer back to the original broker participant at `Stop` time, so humans or peer agents receive the reply without a separate manual command.
- Those automatic Codex transitions now also update broker `work-state`: active execution reports `implementing` with the current task/thread context, and an idle stop path returns to `idle`.
- Informational-only queue items still wait for the next prompt submit or explicit local inbox pull instead of starting a new autonomous turn on their own.
- If transcript extraction is unavailable for that turn, Codex falls back to the explicit `intent-broker reply ...` path instead of guessing.
- If you move this repo, run `npm run codex:install` again so the hook command paths are refreshed.

### Send from a real Codex session

Manual register remains available only as a debugging command when you need to inspect a session's derived participant id:

```bash
intent-broker register
```

Send a task to another participant:

```bash
intent-broker task claude-real-1 real-task-1 real-thread-1 "Please pick up the regression triage"
```

Send an informational progress update:

```bash
intent-broker progress real-task-1 real-thread-1 "Still investigating the failing broker handoff"
```

Send a directed note or a blocking question:

```bash
intent-broker note claude-real-1 real-task-1 real-thread-1 "Queue state is persisted locally now"
intent-broker ask claude-real-1 real-task-1 real-thread-1 "Please confirm the retry semantics"
```

Check unread collaboration context without querying broker by hand:

```bash
intent-broker inbox
```

See who is active on the same project and what they are doing:

```bash
intent-broker who
```

Reply on the latest remembered `taskId/threadId` context.
This is the fallback path when transcript-based auto-mirroring cannot infer the local final answer:

```bash
intent-broker reply "Received, starting now"
```

Reply to an explicit alias while still reusing the latest `taskId/threadId`:

```bash
intent-broker reply @claude2 "Please review the latest patch"
```

Send explicit collaboration semantics without hand-writing HTTP:

```bash
intent-broker task claude2 real-task-1 real-thread-1 "Pick up the failing smoke test"
intent-broker ask claude2 real-task-1 real-thread-1 "Need your decision on the conflict"
intent-broker note claude2 real-task-1 real-thread-1 "I rebased and pushed the queue fix"
intent-broker progress real-task-1 real-thread-1 "Still investigating the reconnect edge case"
```

### What this enables

Once installed, an already-open real Codex session can naturally participate in multi-agent communication:

- it keeps its native startup flow
- it receives broker context through hooks instead of a wrapper shell
- it can auto-start actionable broker work while idle and auto-continue after busy turn boundaries
- it can explicitly hand off tasks or publish progress with the same local bridge command set

## Claude Code Integration

Claude Code now has the same non-invasive hook bridge model as Codex, but installs into project settings:

- `SessionStart` hook: auto-registers the Claude Code session into broker context, publishes an initial `idle` work state, and launches the same lightweight background keeper so presence survives idle time and broker restarts
- `SessionStart` hook: also launches the same realtime bridge daemon so websocket events land in local queue state immediately
- `UserPromptSubmit` hook: silently re-registers after broker restart and injects only newly arrived broker inbox context before prompt submission
- `Stop` hook: after a Claude Code turn finishes, the bridge tries to mirror the final local answer for the latest broker-injected actionable item back into broker, without requiring a separate manual reply command

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
- `~/.intent-broker/claude-code/*.json` local cursor state, realtime queue state, and helper metadata

Notes:

- this preserves unrelated Claude Code hooks and only replaces previous `intent-broker` hook entries
- the default install is now quiet: it does not print `Running ... hook: intent-broker ...` on every prompt submit
- hook-provided `session_id` takes precedence over inherited session env, so nested launcher environments do not accidentally collapse multiple clients onto one participant id
- the background keeper keeps Claude Code presence online while the parent session stays open, and marks it offline after the parent exits
- the realtime bridge quietly reconnects after broker restart and keeps appending websocket events into local queue state
- on the next prompt submit, Claude Code now drains the local realtime queue before falling back to broker poll, so websocket-delivered items are injected first
- hook-injected collaboration context now separates actionable items from informational items. Human-channel messages and `task` / `ask` default to actionable; `note` / `progress` default to informational
- broker-injected actionable items now prefer transcript-based automatic reply mirroring at `Stop` time; if transcript capture fails, explicit `intent-broker --tool claude-code reply ...` remains the fallback
- Claude Code still consumes queued broker inbox context on the next prompt submit or explicit local inbox pull, not by silently acting on messages while idle
- if you move this repo, run `npm run claude-code:install` again to refresh command paths

### Send from a real Claude Code session

Manual register remains available for debugging or inspecting derived participant ids:

```bash
intent-broker --tool claude-code register
```

Send a task to another participant:

```bash
intent-broker --tool claude-code task codex-real-1 real-task-1 real-thread-1 "Please pick up the regression triage"
```

Send an informational progress update:

```bash
intent-broker --tool claude-code progress real-task-1 real-thread-1 "Still investigating the failing broker handoff"
```

Send a directed note or a blocking question:

```bash
intent-broker --tool claude-code note codex-real-1 real-task-1 real-thread-1 "Reconnect path is green locally"
intent-broker --tool claude-code ask codex-real-1 real-task-1 real-thread-1 "Please review the handoff semantics"
```

Check unread collaboration context:

```bash
intent-broker --tool claude-code inbox
```

See same-project collaborators and work-state:

```bash
intent-broker --tool claude-code who
```

Reply on the latest remembered collaboration context.
This remains the fallback when automatic transcript mirroring is unavailable:

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

The default user path is broker-managed channels via `intent-broker.config.json`. Standalone adapter processes still exist as an advanced mode for debugging or future multi-process deployments:

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
