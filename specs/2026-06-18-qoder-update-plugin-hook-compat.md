# Qoder Update Plugin Hook Compatibility Fix

Date: 2026-06-18

## Problem

QoderCLI runs two `UserPromptSubmit` hooks in affected sessions:

- user hook: `node "/Applications/xiaok.app/Contents/Resources/services/intent-broker/adapters/qodercli-plugin/bin/qodercli-broker.js" hook user-prompt-submit`
- managed plugin hook: `cmd.exe /c ${QODER_PLUGIN_ROOT}/qoder-update.exe`

Recent Qoder logs show the xiaok/intent-broker hook exits successfully. The non-blocking warning comes from the managed `qoder-update` plugin hook:

```text
source="plugins" display_text="cmd.exe /c ${QODER_PLUGIN_ROOT}/qoder-update.exe"
bash: cmd.exe: command not found
```

The plugin metadata is under:

```text
~/.qoder/plugins/cache/.../qoder-update/1.0.13/.qoder-plugin/plugin.json
~/.qoder/plugins/cache/.../qoder-update/1.0.13/hooks/hooks.json
```

`hooks.json` registers a Windows-only executable through `cmd.exe`, even on macOS.

## Goal

Remove the recurring non-blocking hook warning on macOS/Linux without changing qodercli-broker hook behavior, broker protocol, or Windows update behavior.

## Design

Add a small qoder adapter compatibility repair that:

1. Runs only when `platform !== "win32"`.
2. Reads `~/.qoder/plugins/installed_plugins_v2.json`.
3. Finds installed plugin entries whose manifest name is exactly `qoder-update`.
4. Reads the manifest `hooks` file.
5. Removes only hook commands exactly equal to:
   `cmd.exe /c ${QODER_PLUGIN_ROOT}/qoder-update.exe`
6. Writes the hooks file only if that exact command was removed.

Call this repair from qoder adapter install and qoder lifecycle hooks. `SessionStart` should repair before the first prompt in a new session. `UserPromptSubmit` is also allowed to repair for already-running sessions; it may not affect the current prompt because Qoder likely resolves plugin hooks before starting hook execution, but it fixes subsequent prompts.

## Non-Goals

- Do not edit general Qoder settings or remove unrelated plugin hooks.
- Do not disable arbitrary plugins.
- Do not patch `qoder-update.exe` or attempt to run it on non-Windows platforms.
- Do not change Codex native approval or realtime bridge behavior; current source already gates Codex native approval watcher behind `toolName === "codex"`.

## Adversarial Review

- Risk: mutating another tool's managed plugin cache could be surprising.
  Mitigation: only touch a hidden managed plugin with manifest name `qoder-update`, and only remove one exact Windows-only command that cannot succeed off Windows.

- Risk: future Qoder versions may change hook schema.
  Mitigation: preserve unknown structure and only normalize the specific `hooks.<event>[].hooks[]` arrays we edit.

- Risk: the plugin may reinstall the bad hook later.
  Mitigation: run repair during qoder adapter install and lifecycle hooks, so the bad hook is re-pruned after reinstall or update.

- Risk: Windows users may lose update behavior.
  Mitigation: no-op when `platform === "win32"`.

- Risk: broken JSON or missing plugin files could break qoder hook startup.
  Mitigation: repair is best-effort and returns no changes on parse/read failures.

## Verification

- Unit test: non-Windows repair removes the exact `cmd.exe /c ${QODER_PLUGIN_ROOT}/qoder-update.exe` hook and preserves unrelated hooks.
- Unit test: Windows repair is a no-op.
- Unit test: qoder lifecycle hooks invoke repair best-effort without failing the hook.
- Focused test command:

```bash
npm test -- tests/adapters/qodercli-plugin-compat.test.js tests/adapters/qodercli-plugin-hooks.test.js
```
