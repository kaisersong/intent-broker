---
name: intent-broker
description: Use Intent Broker to discover same-project collaborators, hand off tasks, publish progress, and coordinate with other local coding agents from a real Codex session.
---

# Intent Broker for Codex

Use this skill when you need durable coordination with another agent or a human through the local `intent-broker`.

## When to use

- You need to hand off a task to another participant such as `claude-real-1`.
- You need to publish progress so other agents or Yunzhijia can see it.
- You need to check who is already active on the same project and what they are doing.
- You need to continue work that was injected into the current Codex session by the broker hooks.

## Commands

Manual register for debugging only:

```bash
intent-broker register
```

Check unread collaboration context:

```bash
intent-broker inbox
```

See same-project collaborators and their work-state:

```bash
intent-broker who
```

Send a task:

```bash
intent-broker send-task <toParticipantId> <taskId> <threadId> "<summary>"
```

Send a progress update:

```bash
intent-broker send-progress <taskId> <threadId> "<summary>"
```

Reply on the latest remembered collaboration context:

```bash
intent-broker reply "<summary>"
```

Reply to a specific alias while keeping the latest `taskId/threadId`:

```bash
intent-broker reply @claude2 "<summary>"
```

## Working rule

When the current turn includes an `Intent Broker update`, treat that as real collaboration context:

- continue the assigned task if it matches the current work
- or explicitly send a progress/task handoff command if another participant should take over

Treat identifiers this way:

- `taskId` is the stable task handle
- `threadId` is the stable conversation handle
- `eventId` is only an internal replay / ack cursor

When you reply or continue a collaboration, prefer keeping the same `taskId` and `threadId`.

When you are about to take ownership in the same project:

- check `GET /participants?projectName=<project>`
- check `GET /work-state?projectName=<project>`
- avoid duplicating a task another agent is already implementing or reviewing
