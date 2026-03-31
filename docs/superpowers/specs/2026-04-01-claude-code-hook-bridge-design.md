# Claude Code Hook Bridge Design

## Goal

Add Claude Code support that matches the current Codex hook bridge behavior, while improving extensibility by extracting a reusable hook installer core that future agent integrations can share.

## Scope

This design covers:

- extracting reusable hook installation helpers from the current Codex plugin implementation
- adding a new `claude-code-plugin` integration that installs project-level Claude Code hooks
- supporting only `SessionStart` and `UserPromptSubmit` for Claude Code
- preserving the existing `session-bridge` transport and broker protocol
- maintaining backward compatibility for the existing Codex integration

This design does not cover:

- changing broker HTTP or WebSocket APIs
- adding Claude Code specific events like `Stop`, `TaskCompleted`, or `SubagentStart`
- replacing the existing standalone `adapters/claude-code/adapter.js`
- adding user-level Claude Code settings support

## Context

The repository already has:

- a `session-bridge` layer that handles broker registration, inbox polling, ack, and cursor state
- a `codex-plugin` integration that installs Codex hooks and injects broker context into prompts
- a basic `claude-code` adapter, but not a local hook-based Claude Code integration comparable to Codex

The user wants Claude Code support that behaves like Codex, but does not want a second copy-pasted installation stack. Extensibility matters more than the smallest possible patch.

## Proposed Architecture

### Layering

Keep the existing network and state flow in `adapters/session-bridge/`, and introduce a new reusable installation layer under `adapters/hook-installer-core/`.

The resulting layers are:

1. `adapters/session-bridge/`
   Handles broker transport, participant registration, inbox polling, ack cursor, and generic broker context rendering.

2. `adapters/hook-installer-core/`
   Handles reusable install-time concerns:
   - stable status labels for intent-broker managed hooks
   - hook command construction
   - idempotent pruning and replacement of intent-broker managed hooks
   - path helpers for repo-relative CLIs and per-tool state roots

3. Tool-specific plugin adapters:
   - `adapters/codex-plugin/`
   - `adapters/claude-code-plugin/`

Each tool-specific plugin keeps responsibility for:

- tool configuration file locations
- tool-specific hook config schema shape
- tool-specific hook output JSON shape
- tool-specific hook input to environment/session mapping

This keeps the core small and stable while still reducing duplicated installation logic.

### File Layout

```text
adapters/
  hook-installer-core/
    command.js
    install-core.js
    state-paths.js
  session-bridge/
    api.js
    cli.js
    config.js
    hook-context.js
    state.js
  codex-plugin/
    bin/codex-broker.js
    format.js
    hooks.js
    install.js
    skills/intent-broker/SKILL.md
  claude-code-plugin/
    bin/claude-code-broker.js
    format.js
    hooks.js
    install.js
```

`session-bridge/codex-hooks.js` will be renamed or generalized to avoid encoding Codex in the filename once both tools use the same context summary logic.

## Configuration Model

### Codex

The existing Codex integration remains supported. Its install-time implementation is refactored to call shared installer helpers rather than owning the full merge logic directly.

### Claude Code

The new Claude Code integration writes project-level hooks to:

- `.claude/settings.json`

Only two hook events are installed:

- `SessionStart`
- `UserPromptSubmit`

The generated commands point to:

- `node "<repo>/adapters/claude-code-plugin/bin/claude-code-broker.js" hook session-start`
- `node "<repo>/adapters/claude-code-plugin/bin/claude-code-broker.js" hook user-prompt-submit`

### Idempotency Rules

Installers for both tools must:

- preserve unrelated existing hooks
- replace only intent-broker managed entries
- never duplicate intent-broker hook entries on repeated install
- remain deterministic for repeated execution

The stable identity marker will continue to be a known status label owned by intent-broker. This is already how the Codex implementation detects its own hook entries and can be reused for Claude Code.

## Runtime Data Flow

### Shared Flow

Both tools follow the same broker flow:

1. derive participant config from environment plus current working directory
2. register participant on `SessionStart`
3. poll inbox after the last seen event
4. summarize broker events into prompt context
5. persist the new cursor and ack consumed events on prompt submission

### Claude Code SessionStart

`SessionStart` should:

- read `session_id` from Claude Code hook input
- map that to `CLAUDE_CODE_SESSION_ID` in the session bridge config path
- derive a `claude-code-session-<8-char-prefix>` participant id
- register the participant
- poll recent inbox events
- return Claude Code hook JSON with `hookSpecificOutput.additionalContext` when events exist

If no events exist, it should return no output.

### Claude Code UserPromptSubmit

`UserPromptSubmit` should:

- ignore slash-command style prompts to avoid polluting command UX
- load the participant cursor state
- poll inbox since the last seen event
- build an `additionalContext` block when new events exist
- save the latest cursor and ack the highest event id

If no events exist, it should return no output.

## Hook Output Format

Codex and Claude Code both support hook-specific `additionalContext`, but the output wrapper is tool-specific in practice because the command entrypoints and surrounding install model differ.

The design therefore keeps output wrappers in tool-specific `format.js` modules instead of forcing a premature universal formatter.

Expected Claude Code output shape:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Intent Broker update for claude-code-session-12345678:\n..."
  }
}
```

and similarly for `UserPromptSubmit`.

## Error Handling

The hook bridge must degrade safely:

- broker unavailable: return no output and do not block Claude Code
- malformed or missing settings file: create directories and write a valid config file
- malformed local cursor state: treat as `lastSeenEventId = 0`
- unrelated hook config present: preserve it
- duplicate broker events: continue relying on existing dedupe and cursor behavior

No install or runtime path should require private Claude Code internals.

## Testing Strategy

### Shared Installer Core

Add tests for:

- hook command construction
- intent-broker hook identification
- pruning and replacement behavior
- path helpers for per-tool state directories

### Codex Regression

Update Codex tests to target the refactored modules and verify:

- generated commands remain unchanged
- merge behavior remains unchanged
- existing hook runtime behavior remains unchanged

### Claude Code Install

Add tests for:

- writing `.claude/settings.json`
- preserving unrelated hooks
- replacing prior intent-broker managed Claude Code entries
- idempotent repeated install

### Claude Code Runtime Hooks

Add tests for:

- `SessionStart` registration and empty inbox behavior
- `UserPromptSubmit` slash-command bypass
- `UserPromptSubmit` context injection, cursor save, and ack
- participant id derivation from Claude Code session ids

## Compatibility and Migration

This work is intentionally additive:

- existing broker APIs remain unchanged
- existing Codex commands remain unchanged
- existing Codex tests should still pass after refactor
- new Claude Code support is opt-in through an install command

The only structural migration is internal code movement to a shared install core.

## Success Criteria

The feature is complete when:

- Claude Code can be installed via a repository command that writes `.claude/settings.json`
- the installed `SessionStart` and `UserPromptSubmit` hooks inject broker context using `additionalContext`
- the Codex install path still behaves as before
- the full test suite passes with new Claude Code coverage
- the README documents how to install and use Claude Code integration
