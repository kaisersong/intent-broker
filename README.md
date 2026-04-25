# Intent Broker

> You have multiple AI assistants (Codex, Claude Code, OpenCode) working on the same project, but they don't know about each other — until the human becomes the router, memory, and conflict detector between all windows. Intent Broker solves this coordination problem: persist events first, then deliver; let multiple agents collaborate around the same task object, with humans handling approvals and final decisions, while daily sync, task handoff, and state recovery all flow through broker-managed coordination.

Local-first multi-agent collaboration broker. Not a chat server, not a workflow platform — a reliable coordination protocol layer.

English | [简体中文](README.zh-CN.md)

---

## Live Demo

**A typical scenario:**

1. Human opens one Codex session and one Claude Code session in the same repository
2. Both sessions auto-register to Intent Broker, report presence, expose aliases (`@codex`, `@claude`)
3. Human sends tasks in Yunzhijia: "Fix websocket reconnect" to `@codex`, "Check shutdown path" to `@claude`
4. Each agent updates work-state, can directly request info or handoff to another agent
5. Before committing, query who else is working on this project to check for overlapping changes
6. Even if broker restarts, task context persists

**This is not "let agents chat" — it's letting humans delegate work in parallel while agents retain enough shared state to coordinate.**

---

## Design Philosophy: Collaboration Protocol Layer

Intent Broker follows four principles:

### 1. Coordination First

The hard part of multi-agent coding isn't model capability — it's coordination cost. Even with multiple terminals, worktrees, or branches:

- Humans must remember what each agent is working on
- Agents don't know who else is in this repository
- Parallel development creates ownership chaos and conflict risk
- Approvals, handoffs, progress updates scatter across chat windows

Broker productizes this coordination work and makes it recoverable.

### 2. Humans as Supervisors

Humans do:
- Set direction
- Approve high-risk actions
- Make final decisions

Broker handles:
- Daily sync
- Task handoff
- State recovery
- Most negotiation

### 3. Recoverable by Default

Tasks, threads, approvals, delivery state should all survive broker restarts, session idle, or disconnection.

**How:**
- SQLite persistent event storage
- Inbox pull with ack cursor
- Event replay API
- Background heartbeat and logs

### 4. Non-Invasive Integration

Codex, Claude Code should keep native experience. Broker integrates via hooks, skills, adapters, and local bridges — not by wrapping the tool in a new shell.

### Terminal Jump Contract

The broker-side terminal locator contract lives in [TERMINAL_JUMP.md](TERMINAL_JUMP.md).

- Ghostty exact jump metadata must come from `terminalSessionID`
- Terminal.app exact jump metadata must come from `terminalTTY`
- `sessionHint` is compatibility metadata, not the Ghostty primary key
- If metadata conflicts across `projectPath` or `terminalTTY`, degrade instead of jumping to the wrong terminal

---

## Install

### Claude Code

Tell Claude: "Install https://github.com/kaisersong/intent-broker"

Or manually:
```bash
git clone https://github.com/kaisersong/intent-broker ~/.claude/skills/intent-broker
```

### Codex

```bash
git clone https://github.com/kaisersong/intent-broker ~/.codex/skills/intent-broker
```

### Start Broker

```bash
cd /Users/song/projects/intent-broker
npm start
```

Listens on `http://127.0.0.1:4318` by default.

**Recommended config:**

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

**Restart and check runtime:**

```bash
npm run broker:restart
npm run broker:status
```

---

## Usage

### Commands

```bash
# See collaborators on same project
intent-broker who

# See unread collaboration messages
intent-broker inbox

# Manual participant registration (debug only)
intent-broker register

# Send task
intent-broker task <participantId> <taskId> <threadId> "Please take over"

# Send progress
intent-broker progress <taskId> <threadId> "50% done"

# Send notification
intent-broker note <participantId> <taskId> <threadId> "Locally verified"

# Send blocking question
intent-broker ask <participantId> <taskId> <threadId> "Please confirm semantics"

# Reply
intent-broker reply "Got it, starting now"
```

### Typical Workflows

**One-step collaboration:**

```bash
# Send task to another participant
intent-broker task claude-real-1 task-1 thread-1 "Please take over regression"
```

**Query project state before accepting work:**

```bash
# Ask who's online and what they're doing
intent-broker who

# Query participants and work-state by project
GET /participants?projectName=intent-broker
GET /work-state?projectName=intent-broker
```

**Approval flow:**

Before key actions (commit, deploy, destructive ops):

```bash
intent-broker request-approval <taskId> "Ready to submit final result"
# Human confirms in Yunzhijia or terminal
intent-broker confirm reply <requestId> Y
```

---

## Features

### Core

- **Participant registration** — Globally unique alias, auto-suffix on conflict
- **Project query** — Filter participants by projectName
- **Work-state** — Track and query participant current work status
- **Collaboration semantics** — Default delivery for `task`, `ask`, `note`, `progress`
- **Delivery feedback** — Returns `onlineRecipients`, `offlineRecipients`, `deliveredCount`

### Agent Group

- **Auto-discovery** — Same-project agents auto-discover via `projectName`
- **File change broadcast** — Notify group members
- **Conflict detection** — Detect concurrent modifications and notify both parties
- **File locking** — Prevent simultaneous edits on same file

### Human Confirmation

- **Blocking confirm** — `intent-broker confirm ask`
- **Multi-type** — yes/no, multi-select, free text input
- **Timeout fallback** — `wait`, `cancel`, `auto-decide`
- **Terminal fallback** — Degrades when Yunzhijia unavailable

### Task Management

- **Parent/child tasks** — Create parent, decompose into subtasks
- **Task assignment** — Assign subtasks to specific agents
- **Status tracking** — `pending`, `in_progress`, `completed`, `blocked`

### Code Review

- **Review request** — `intent-broker review request <file> --reviewer @senior-dev`
- **Review opinion** — approve/reject
- **Review list** — Filter by pending

### Collaboration History

- **Event logging** — All collaboration events persisted
- **Multi-dim query** — By type, participant, project, time range
- **Stats report** — 7-day window by default
- **Recent activity** — Feed view

### Graceful Degradation

| Failure | Degradation |
|---------|-------------|
| Broker unavailable | Log locally, don't block |
| Yunzhijia disconnected | Terminal I/O fallback |
| WebSocket disconnected | Exponential backoff (1s → 2s → 4s → 8s → 16s) |
| Crash | `~/.intent-broker/` persisted state, supports recovery |

---

## For AI Agents

If you're Claude Code, Codex, OpenCode, or other coding agent, Intent Broker should be used as a collaboration protocol layer.

### 1. Register on Session Start

```http
POST /participants/register
```

```json
{
  "participantId": "codex.main",
  "alias": "codex",
  "kind": "agent",
  "roles": ["coder"],
  "capabilities": ["backend.node", "frontend.react"],
  "context": {
    "projectName": "intent-broker"
  }
}
```

**Naming conventions:**

| Field | Example | Description |
|-------|---------|-------------|
| `participantId` | `claude-code.main` | Stable, tool-unique |
| `alias` | `codex`, `claude`, `xiaok` | Short name for humans/agents |
| `roles` | `coder`, `reviewer`, `approver` | Coarse-grained role |
| `capabilities` | `frontend.react`, `backend.node` | Fine-grained capability |
| `context.projectName` | `intent-broker` | Current project name |

### 2. Prefer Inbox Pull

```http
GET /inbox/:participantId?after=0&limit=50
POST /inbox/:participantId/ack
```

**Keep identifiers separate:**

- `taskId` — Stable task primary key
- `threadId` — Stable conversation primary key
- `eventId` — Broker internal only (replay, incremental pull, ack cursor)

### 3. Query Project State Before Accepting Work

```http
GET /participants?projectName=intent-broker
GET /work-state?projectName=intent-broker
```

Answer these:
- Which agents are online on this project
- Who is `idle`, `blocked`, `reviewing`, `implementing`
- Is someone already handling the same task/thread

**work-state values:** `idle`, `planning`, `implementing`, `reviewing`, `blocked`, `waiting_approval`, `ready_to_submit`

### 4. Use Aliases for Human Command

Humans in Yunzhijia can send:
- `@codex Fix the broker tests`
- `@claude @codex Debug this regression together`
- `@all Sync current blockers`

### 5. Recover via Replay After Restart

```http
GET /tasks/:taskId
GET /threads/:threadId
GET /events/replay?after=0&taskId=task-1
```

---

## API Overview

### Health

```http
GET /health
```

### Participants

```http
POST /participants/register
GET /participants?projectName=intent-broker
GET /participants/resolve?aliases=codex,claude
POST /participants/:participantId/alias
```

### Send Intent

```http
POST /intents
```

Returns routing and real-time delivery result:

```json
{
  "eventId": 71,
  "recipients": ["codex.main", "claude.main"],
  "onlineRecipients": ["codex.main"],
  "offlineRecipients": ["claude.main"],
  "deliveredCount": 1
}
```

### Work State

```http
POST /participants/:participantId/work-state
GET /participants/:participantId/work-state
GET /work-state?projectName=intent-broker
```

### Project Snapshot

```http
GET /projects/:projectName/snapshot
```

Returns aggregated read-only project view: participants with presence and work-state, counts (online, busy, blocked, pending approval), and recent events.

---

## Tech Stack

- Node 22
- Native ESM
- `node:http`
- `node:sqlite`
- `node:test`

**Goal:** Run today without third-party runtime deps, validate protocol and reliability path first.

---

## Testing

```bash
npm test
npm run verify:collaboration
```

Collaboration smoke test runs through real Codex and Claude Code bridges, writes logs and analysis to `.tmp/collaboration-smoke-*`.

---

## Extensions

### Mobile Connection

Mobile devices can connect as `kind: "mobile"` participants, with WebSocket real-time notifications, simplified inbox (shows only events requiring confirmation), and approval/confirm operations.

See [MOBILE.md](./MOBILE.md).

### Platform Integration

```text
Messaging Platform → Platform Adapter → Intent Broker → Agents
```

See:
- [docs/ADAPTERS.md](./docs/ADAPTERS.md) - Adapter architecture
- [adapters/yunzhijia/README.md](./adapters/yunzhijia/README.md) - Yunzhijia config

---

## Compatibility

| Tool | Integration |
|------|-------------|
| Claude Code | `.claude/settings.json` hooks |
| Codex | `~/.codex/hooks.json` + skill symlink |
| OpenCode | TBD |
| xiaok-code | TBD |

---

## Version History

**v0.3.2** — Windows sidecars and Codex app-server now start hidden with cross-process startup locks; approval projection now scans beyond the first 100 events and reports pending approval counts correctly; Codex resume discovery and xiaok hook coverage tightened.

**v0.3.1** — Condensed informational broker events: markdown stripped, 50-char summary truncation, max 3 lines total for the informational section.

**v0.3.0** — PreToolUse hooks across all 3 adapters; AskUserQuestion mirroring (Claude Code + xiaok); Codex native escalation + destructive command detection; xiaok human approval/clarification roundtrips; pending tool-use context correlation; hook approval timeout resolution; condensed informational broker events with truncation; 175 tests.

**v0.2.3** — Graceful shutdown, kill previous processes on start, session-keeper auto-recovery, realtime bridge queue improvements.

**v0.2.2** — Packaged broker install path fix for Claude Code hook.

**v0.2.1** — Agent hook approval cards: mirrored AskUserQuestion, Codex native escalation approvals.

**v0.2.0** — Agent Group collaboration: auto-discovery, file change broadcast, conflict detection, file locking; Human confirmation: blocking confirm, timeout fallback; Task distribution and review; Collaboration history; Graceful degradation.

**v0.1.0** — Initial prototype: participant registration, globally unique alias, project query, work-state, task/ask/note/progress delivery semantics, presence tracking, inbox pull, task/thread/event query.
