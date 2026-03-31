# Claude Code Hook Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a reusable hook installer core and ship a Claude Code hook bridge that matches the current Codex broker integration at the project settings level.

**Architecture:** Move shared install-time behavior into a new hook installer core, keep broker transport in `adapters/session-bridge`, and add a thin `claude-code-plugin` layer for Claude-specific config and hook output. Refactor Codex to consume the same core so future tool integrations do not duplicate hook installation code.

**Tech Stack:** Node 22, native ESM, `node:test`, JSON config files, existing Intent Broker session bridge helpers

---

## File Structure

- Create: `adapters/hook-installer-core/command.js`
- Create: `adapters/hook-installer-core/install-core.js`
- Create: `adapters/hook-installer-core/state-paths.js`
- Create: `adapters/claude-code-plugin/bin/claude-code-broker.js`
- Create: `adapters/claude-code-plugin/format.js`
- Create: `adapters/claude-code-plugin/hooks.js`
- Create: `adapters/claude-code-plugin/install.js`
- Create: `tests/adapters/claude-code-plugin-config.test.js`
- Create: `tests/adapters/claude-code-plugin-hooks.test.js`
- Modify: `adapters/codex-plugin/bin/codex-broker.js`
- Modify: `adapters/codex-plugin/install.js`
- Modify: `adapters/codex-plugin/hooks.js`
- Modify: `adapters/session-bridge/config.js`
- Modify: `adapters/session-bridge/codex-hooks.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/adapters/codex-plugin-install.test.js`
- Modify: `tests/adapters/codex-plugin-hooks.test.js`
- Modify: `tests/adapters/session-bridge.test.js`

### Task 1: Lock Shared Installer Contracts

**Files:**
- Create: `adapters/hook-installer-core/command.js`
- Create: `adapters/hook-installer-core/install-core.js`
- Create: `adapters/hook-installer-core/state-paths.js`
- Modify: `tests/adapters/codex-plugin-install.test.js`

- [ ] **Step 1: Write the failing tests for shared installer helpers**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHookCommand,
  mergeManagedCommandHooks
} from '../../adapters/hook-installer-core/install-core.js';

test('buildHookCommand quotes cli path and mode', () => {
  assert.equal(
    buildHookCommand('/repo/tool.js', 'session-start'),
    'node "/repo/tool.js" hook session-start'
  );
});

test('mergeManagedCommandHooks replaces intent-broker owned entries only', () => {
  const merged = mergeManagedCommandHooks({
    groups: [
      {
        matcher: 'startup',
        hooks: [
          { type: 'command', command: 'node keep', statusMessage: 'other hook' }
        ]
      },
      {
        matcher: 'startup|resume',
        hooks: [
          { type: 'command', command: 'node old', statusMessage: 'intent-broker session sync' }
        ]
      }
    ]
  }, {
    matcher: 'startup|resume',
    command: 'node new',
    statusMessage: 'intent-broker session sync'
  });

  assert.equal(merged.length, 2);
  assert.equal(merged[0].hooks[0].command, 'node keep');
  assert.equal(merged[1].hooks[0].command, 'node new');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-sqlite --experimental-test-isolation=none --test tests/adapters/codex-plugin-install.test.js`
Expected: FAIL with missing exports from `adapters/hook-installer-core/install-core.js`

- [ ] **Step 3: Write the shared installer helpers**

```js
export const SESSION_START_STATUS = 'intent-broker session sync';
export const USER_PROMPT_STATUS = 'intent-broker inbox sync';

export function buildHookCommand(cliPath, mode) {
  return `node "${cliPath}" hook ${mode}`;
}

export function mergeManagedCommandHooks(groups = [], managedGroup) {
  const preserved = groups
    .map((group) => ({
      ...group,
      hooks: (group.hooks || []).filter(
        (hook) =>
          hook?.statusMessage !== managedGroup.statusMessage
      )
    }))
    .filter((group) => group.hooks.length > 0);

  preserved.push({
    ...(managedGroup.matcher ? { matcher: managedGroup.matcher } : {}),
    hooks: [
      {
        type: 'command',
        command: managedGroup.command,
        statusMessage: managedGroup.statusMessage
      }
    ]
  });

  return preserved;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-sqlite --experimental-test-isolation=none --test tests/adapters/codex-plugin-install.test.js`
Expected: PASS for shared installer tests plus existing Codex config tests

- [ ] **Step 5: Commit**

```bash
git add tests/adapters/codex-plugin-install.test.js adapters/hook-installer-core/command.js adapters/hook-installer-core/install-core.js adapters/hook-installer-core/state-paths.js
git commit -m "refactor: extract shared hook installer core"
```

### Task 2: Refactor Codex to Use the Shared Core

**Files:**
- Modify: `adapters/codex-plugin/install.js`
- Modify: `adapters/codex-plugin/bin/codex-broker.js`
- Modify: `tests/adapters/codex-plugin-install.test.js`

- [ ] **Step 1: Write the failing regression test for unchanged Codex merge output**

```js
test('mergeIntentBrokerHooks still returns the existing Codex hook shape', () => {
  const merged = mergeIntentBrokerHooks({}, {
    sessionStartCommand: 'node "/repo/codex-broker.js" hook session-start',
    userPromptSubmitCommand: 'node "/repo/codex-broker.js" hook user-prompt-submit'
  });

  assert.deepEqual(merged.hooks.SessionStart[0].hooks[0].statusMessage, 'intent-broker session sync');
  assert.deepEqual(merged.hooks.UserPromptSubmit[0].hooks[0].statusMessage, 'intent-broker inbox sync');
});
```

- [ ] **Step 2: Run test to verify it fails during refactor**

Run: `node --experimental-sqlite --experimental-test-isolation=none --test tests/adapters/codex-plugin-install.test.js`
Expected: FAIL after moving helper logic until `adapters/codex-plugin/install.js` is rewired

- [ ] **Step 3: Rewrite Codex install to delegate shared responsibilities**

```js
import {
  SESSION_START_STATUS,
  USER_PROMPT_STATUS,
  buildHookCommand
} from '../hook-installer-core/install-core.js';

export function mergeIntentBrokerHooks(existingConfig = {}, commands) {
  const merged = clone(existingConfig);
  const hooks = { ...(merged.hooks || {}) };

  hooks.SessionStart = mergeManagedCommandHooks(hooks.SessionStart || [], {
    matcher: 'startup|resume',
    command: commands.sessionStartCommand,
    statusMessage: SESSION_START_STATUS
  });

  hooks.UserPromptSubmit = mergeManagedCommandHooks(hooks.UserPromptSubmit || [], {
    command: commands.userPromptSubmitCommand,
    statusMessage: USER_PROMPT_STATUS
  });

  merged.hooks = hooks;
  return merged;
}
```

- [ ] **Step 4: Run Codex tests to verify behavior is unchanged**

Run: `node --experimental-sqlite --experimental-test-isolation=none --test tests/adapters/codex-plugin-install.test.js tests/adapters/codex-plugin-hooks.test.js`
Expected: PASS with no Codex behavior regressions

- [ ] **Step 5: Commit**

```bash
git add adapters/codex-plugin/install.js adapters/codex-plugin/bin/codex-broker.js tests/adapters/codex-plugin-install.test.js tests/adapters/codex-plugin-hooks.test.js
git commit -m "refactor: route codex install through shared hook core"
```

### Task 3: Generalize Session Bridge Context for Multiple Tools

**Files:**
- Modify: `adapters/session-bridge/codex-hooks.js`
- Modify: `adapters/codex-plugin/hooks.js`
- Modify: `tests/adapters/codex-plugin-hooks.test.js`

- [ ] **Step 1: Write the failing test for tool-agnostic hook context labels**

```js
import { buildToolHookContext } from '../../adapters/session-bridge/codex-hooks.js';

test('buildToolHookContext uses the provided tool label', () => {
  const context = buildToolHookContext([
    {
      eventId: 9,
      kind: 'request_task',
      fromParticipantId: 'peer',
      taskId: 'task-1',
      threadId: 'thread-1',
      payload: { body: { summary: 'Review this' } }
    }
  ], {
    participantId: 'claude-code-session-12345678',
    sessionLabel: 'Claude Code session'
  });

  assert.match(context, /Claude Code session/);
  assert.match(context, /claude-code-session-12345678/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-sqlite --experimental-test-isolation=none --test tests/adapters/codex-plugin-hooks.test.js`
Expected: FAIL with missing `buildToolHookContext`

- [ ] **Step 3: Generalize the hook context builder**

```js
export function buildToolHookContext(items = [], { participantId, sessionLabel = 'session' } = {}) {
  if (!items.length) {
    return null;
  }

  return [
    `Intent Broker update for ${participantId || `this ${sessionLabel}`}:`,
    summarizeInboxItems(items),
    'If relevant, respond in this turn or continue the newly assigned work.'
  ].join('\n');
}

export function buildCodexHookContext(items = [], { participantId } = {}) {
  return buildToolHookContext(items, {
    participantId,
    sessionLabel: 'Codex session'
  });
}
```

- [ ] **Step 4: Run tests to verify Codex still passes with the generalized helper**

Run: `node --experimental-sqlite --experimental-test-isolation=none --test tests/adapters/codex-plugin-hooks.test.js tests/adapters/session-bridge.test.js`
Expected: PASS with Codex output unchanged and new generic helper covered

- [ ] **Step 5: Commit**

```bash
git add adapters/session-bridge/codex-hooks.js adapters/codex-plugin/hooks.js tests/adapters/codex-plugin-hooks.test.js tests/adapters/session-bridge.test.js
git commit -m "refactor: generalize broker hook context rendering"
```

### Task 4: Add Claude Code Plugin Install and Hook Runtime

**Files:**
- Create: `adapters/claude-code-plugin/bin/claude-code-broker.js`
- Create: `adapters/claude-code-plugin/format.js`
- Create: `adapters/claude-code-plugin/hooks.js`
- Create: `adapters/claude-code-plugin/install.js`
- Create: `tests/adapters/claude-code-plugin-config.test.js`
- Create: `tests/adapters/claude-code-plugin-hooks.test.js`
- Modify: `adapters/session-bridge/config.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests for Claude Code config merge and hook runtime**

```js
test('mergeIntentBrokerClaudeHooks writes SessionStart and UserPromptSubmit into .claude settings', () => {
  const merged = mergeIntentBrokerClaudeHooks({}, {
    sessionStartCommand: 'node "/repo/claude-code-broker.js" hook session-start',
    userPromptSubmitCommand: 'node "/repo/claude-code-broker.js" hook user-prompt-submit'
  });

  assert.equal(merged.hooks.SessionStart[0].hooks[0].type, 'command');
  assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].type, 'command');
});

test('runClaudeUserPromptSubmitHook injects broker context and acks cursor state', async () => {
  const result = await runUserPromptSubmitHook({
    session_id: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
    prompt: '继续当前任务'
  }, {
    env: {},
    cwd: '/Users/song/projects/intent-broker',
    loadCursorState: () => ({ lastSeenEventId: 0 }),
    saveCursorState: () => {},
    pollInbox: async () => ({
      items: [
        {
          eventId: 3,
          kind: 'request_task',
          fromParticipantId: 'peer',
          taskId: 'task-1',
          threadId: 'thread-1',
          payload: { body: { summary: 'Pick this up' } }
        }
      ]
    }),
    ackInbox: async () => {}
  });

  assert.deepEqual(result.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(result.hookSpecificOutput.additionalContext, /claude-code-session-019d4489/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-sqlite --experimental-test-isolation=none --test tests/adapters/claude-code-plugin-config.test.js tests/adapters/claude-code-plugin-hooks.test.js`
Expected: FAIL because Claude Code plugin files do not exist yet

- [ ] **Step 3: Implement Claude Code install and hook entrypoint**

```js
export function defaultInstallPaths({ cwd = process.cwd() } = {}) {
  return {
    hooksConfigPath: path.join(cwd, '.claude', 'settings.json')
  };
}

export function buildClaudeHookOutput(hookEventName, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext
    }
  };
}

function configFromHookInput(input, { env = process.env, cwd = process.cwd() } = {}) {
  return deriveSessionBridgeConfig({
    toolName: 'claude-code',
    env: {
      ...env,
      CLAUDE_CODE_SESSION_ID: env.CLAUDE_CODE_SESSION_ID || input.session_id || ''
    },
    cwd
  });
}
```

- [ ] **Step 4: Add a package script and run Claude Code tests**

Run: `node --experimental-sqlite --experimental-test-isolation=none --test tests/adapters/claude-code-plugin-config.test.js tests/adapters/claude-code-plugin-hooks.test.js tests/adapters/session-bridge.test.js`
Expected: PASS with Claude Code install and runtime behavior covered

- [ ] **Step 5: Commit**

```bash
git add adapters/claude-code-plugin adapters/session-bridge/config.js package.json tests/adapters/claude-code-plugin-config.test.js tests/adapters/claude-code-plugin-hooks.test.js tests/adapters/session-bridge.test.js
git commit -m "feat: add claude code hook bridge"
```

### Task 5: Document, Verify, and Ship

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the failing docs assertion by identifying missing install instructions**

```md
## Claude Code integration

Run:

```bash
npm run claude-code:install
```

This writes `.claude/settings.json` with `SessionStart` and `UserPromptSubmit` hooks that inject Intent Broker inbox context into Claude Code.
```

- [ ] **Step 2: Run the full test suite before docs and release verification**

Run: `npm test`
Expected: PASS with all existing and new adapter tests green

- [ ] **Step 3: Update the README and adapter docs**

```md
### Claude Code hook bridge

Intent Broker ships a Claude Code hook bridge that installs project-level hooks into `.claude/settings.json`.

```bash
npm run claude-code:install
```

Installed hooks:

- `SessionStart`
- `UserPromptSubmit`
```

- [ ] **Step 4: Run the full suite again to verify no accidental regressions**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add claude code hook bridge usage"
```

## Self-Review

- Spec coverage check:
  - shared installer extraction is covered by Task 1 and Task 2
  - Claude Code project-level hooks are covered by Task 4
  - shared session bridge runtime is covered by Task 3 and Task 4
  - README updates are covered by Task 5
- Placeholder scan:
  - no `TODO`, `TBD`, or “implement later” placeholders remain
  - every task includes explicit files, commands, and expected outcomes
- Type consistency:
  - `buildHookCommand`, `mergeManagedCommandHooks`, `buildToolHookContext`, `buildClaudeHookOutput`, and `runUserPromptSubmitHook` are used consistently across tasks
