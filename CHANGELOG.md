# Changelog

All notable changes to this project will be documented in this file.

## [0.3.9] - 2026-09-11

### Added

- Durable Room workspace authorization and recovery, so collaboration state survives broker restarts (`77fcec6`)
- Room agent aliases and scheduled wake delivery, allowing wake targets to be addressed by alias with deferred delivery (`a256f55`)

### Fixed

- Session bridge crash safety: `ensureSessionKeeper`, `ensureRealtimeBridge` and the Codex auto-dispatch resume spawn now guard detached child-process `error` events, so broken or stale Node paths degrade without crashing the host CLI (`dc04196`, documented in `f1f8d7f`)

### Documentation

- Refreshed broker collaboration documentation (`44a141e`)

## [0.3.8] - 2026-06-08

### Added

- Durable collaboration rooms with preserved delivery (`963a00d`)
- Task lifecycle governance rules (P0-A/P0-B + P1-A) for consistent task state transitions across agents (`4506527`)
- Local context sync foundation with explicit partial retry, dedupe and wip cleanup states, plus e2e verification scripts and harness (`5ad3a84`, `0e88d79`, `65e87de`, `ec1a05e`)
- Cross-machine event relay with cross-node addressing and adversarial hardening (`06fffe6`, `eabe5c6`, `11f4a34`)
- Participant role management API with role-based queries, persisted to SQLite so roles survive restarts (`a5cf4a6`, `4f894ce`, `86b7a59`)
- OpenCode adapter and updated compatibility table (`710466b`)
- Workflow progress contract (`f8d9ca7`)
- QoderCLI plugin hook compatibility (`2ae959b`)
- Reliable-transport delivery with orchestration moved out of the broker (`65b5ab3`)

### Fixed

- Event timestamps are parsed as UTC, fixing `ageMs` drift when broker and agents run in different timezones (`42b52ad`)
- Packaged broker runtime state paths (`a77766b`)
- Taskless approval replay is now tolerated (`ec6028e`)
- Broker reliability improvements, Phase 1/2/3/5 (`4788524`)
- User-local Node resolution for the macOS shim (`99ef45c`)
- Hook adapter resolution from the code root for Codex (`2d53bf6`)
- Windows: command shim for the broker CLI, auto-dispatch hardening, full suite passing (`a0ef2ad`, `602df76`, `89ea43b`)
- Stable `participantId` derived from tty/cwd hash, clarified local broker access and heartbeat state (`7d975a4`, `55de380`)
- Deduplicated session-start presence updates (`574354d`)

### Documentation

- README integration notes aligned to Xiaok Desktop v1.4.4 / 1.4.8 / 1.4.9 / 1.4.11 / 1.4.20 / 1.4.21 / 1.4.22 / 1.4.26 (`a89bce6`, `73150b7`, `a90d1e2`, `1fd6166`, `6458720`, `a0669a2`, `64b917b`, `261c568`)

## [0.3.7] - 2026-05-23

### Fixed

- Preserve KSwarm recovery semantics by ensuring broker delivery failure does not synthesize a completed task result

## [0.3.5] - 2026-05-08

### Added

- QoderCLI adapter (`adapters/qodercli-plugin/`) with full hook support (SessionStart, UserPromptSubmit, PreToolUse, Stop)
- Auto-install QoderCLI hooks on broker startup via `syncAgentBridges`
- `QODER_SESSION_ID` environment variable detection for tool inference

## [0.3.4] - 2026-05-08

### Fixed

- Push `implementing` work-state to broker on `user-prompt-submit` hook so `who` correctly shows agents as active when they are working, instead of always showing `idle`

## [0.3.3] - 2026-04-26

See GitHub releases for prior history.
