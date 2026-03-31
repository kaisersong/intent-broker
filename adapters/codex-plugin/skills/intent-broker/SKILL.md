---
name: intent-broker
description: Use Intent Broker to hand off tasks, publish progress, and coordinate with other local coding agents from a real Codex session.
---

# Intent Broker for Codex

Use this skill when you need durable coordination with another agent or a human through the local `intent-broker`.

## When to use

- You need to hand off a task to another participant such as `claude-real-1`.
- You need to publish progress so other agents or Yunzhijia can see it.
- You need to continue work that was injected into the current Codex session by the broker hooks.

## Commands

Register this Codex session:

```bash
node /Users/song/projects/intent-broker/adapters/codex-plugin/bin/codex-broker.js register
```

Send a task:

```bash
node /Users/song/projects/intent-broker/adapters/codex-plugin/bin/codex-broker.js send-task <toParticipantId> <taskId> <threadId> "<summary>"
```

Send a progress update:

```bash
node /Users/song/projects/intent-broker/adapters/codex-plugin/bin/codex-broker.js send-progress <taskId> <threadId> "<summary>"
```

## Working rule

When the current turn includes an `Intent Broker update`, treat that as real collaboration context:

- continue the assigned task if it matches the current work
- or explicitly send a progress/task handoff command if another participant should take over
