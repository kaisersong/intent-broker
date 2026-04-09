# Terminal Jump Contract

This document is the producer-side contract for terminal jump metadata emitted by Intent Broker.

## Primary Rules

- Never use alias or title as the primary terminal locator.
- Ghostty exact jump metadata must use `terminalSessionID`.
- Terminal.app exact jump metadata must use `terminalTTY`.
- `sessionHint` is a compatibility field only.

## Hook-Time Metadata Rules

- `terminalApp`, `projectPath`, and `terminalTTY` should always be captured when available.
- Ghostty may consult the focused-terminal locator only when the focused terminal still matches the session's `projectPath`.
- If the focused Ghostty terminal belongs to another project, drop the exact `terminalSessionID` instead of binding the wrong one.
- Runtime state should persist terminal metadata so keepalive and realtime bridges can re-register the same session after broker restart.
- Session sidecars are keyed by the observed terminal parent process. For a given tool and `parentPid`, only one keepalive process and one realtime bridge should remain live; a new session on the same terminal must evict older sibling sidecars.

## Broker Rules

- Broker registration may preserve prior metadata when a later update omits terminal fields.
- If two Ghostty participants claim the same `terminalSessionID` but disagree on `terminalTTY` or `projectPath`, broker must clear the conflicting exact locator from the later registration.
- When a Ghostty session has no exact `terminalSessionID`, broker may align `sessionHint` to the final alias for compatibility, but consumers must not treat that alias as an exact locator.
- Stale agent registrations caused by `timeout` or `parent-exit` should be pruned from the roster.

## Consumer Expectations

- Downstream consumers such as HexDeck should treat Ghostty `terminalSessionID` as the only exact Ghostty key.
- Consumers may fall back to `projectPath` as `best_effort`.
- If metadata is ambiguous, degrade to `best_effort` or `unsupported`; never guess an exact target.
