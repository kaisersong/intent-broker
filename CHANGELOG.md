# Changelog

All notable changes to this project will be documented in this file.

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
