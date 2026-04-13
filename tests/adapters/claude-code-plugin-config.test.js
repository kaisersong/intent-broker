import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildHookCommand,
  defaultInstallPaths,
  ensureClaudeCodeInstall,
  mergeIntentBrokerHooks,
  readClaudeSettings,
  writeClaudeSettings
} from '../../adapters/claude-code-plugin/install.js';

test('buildHookCommand quotes the claude broker cli path and hook mode', () => {
  const command = buildHookCommand('/Users/song/projects/intent-broker/adapters/claude-code-plugin/bin/claude-code-broker.js', 'session-start');

  assert.equal(
    command,
    'node "/Users/song/projects/intent-broker/adapters/claude-code-plugin/bin/claude-code-broker.js" hook session-start'
  );
});

test('defaultInstallPaths targets project .claude settings and claude state root', () => {
  const paths = defaultInstallPaths({
    cwd: '/Users/song/projects/intent-broker',
    homeDir: '/Users/song'
  });

  assert.equal(paths.settingsPath, path.join('/Users/song/projects/intent-broker', '.claude', 'settings.json'));
  assert.equal(paths.stateRoot, path.join('/Users/song', '.intent-broker', 'claude-code'));
  assert.equal(paths.commandShimPath, path.join('/Users/song', '.local', 'bin', 'intent-broker'));
  assert.equal(paths.unifiedCliPath, path.join('/Users/song/projects/intent-broker', 'bin', 'intent-broker.js'));
});

test('defaultInstallPaths can install project settings while pointing commands at packaged broker root', () => {
  const paths = defaultInstallPaths({
    cwd: '/Users/song/projects/app',
    repoRoot: '/Users/song/Library/Application Support/com.hexdeck.app/kernel/intent-broker-0.2.2',
    homeDir: '/Users/song'
  });

  assert.equal(paths.settingsPath, path.join('/Users/song/projects/app', '.claude', 'settings.json'));
  assert.equal(
    paths.unifiedCliPath,
    path.join('/Users/song/Library/Application Support/com.hexdeck.app/kernel/intent-broker-0.2.2', 'bin', 'intent-broker.js')
  );
});

test('mergeIntentBrokerHooks adds session start, user prompt submit, and stop hooks', () => {
  const merged = mergeIntentBrokerHooks({}, {
    sessionStartCommand: 'node "/repo/claude-code-broker.js" hook session-start',
    userPromptSubmitCommand: 'node "/repo/claude-code-broker.js" hook user-prompt-submit',
    permissionRequestCommand: 'node "/repo/claude-code-broker.js" hook permission-request',
    stopCommand: 'node "/repo/claude-code-broker.js" hook stop'
  });

  assert.deepEqual(merged, {
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|resume',
          hooks: [
            {
              type: 'command',
              command: 'node "/repo/claude-code-broker.js" hook session-start'
            }
          ]
        }
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "/repo/claude-code-broker.js" hook user-prompt-submit'
            }
          ]
        }
      ],
      PermissionRequest: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "/repo/claude-code-broker.js" hook permission-request'
            }
          ]
        }
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "/repo/claude-code-broker.js" hook stop'
            }
          ]
        }
      ]
    }
  });
});

test('mergeIntentBrokerHooks can opt into visible hook status messages', () => {
  const merged = mergeIntentBrokerHooks({}, {
    sessionStartCommand: 'node "/repo/claude-code-broker.js" hook session-start',
    userPromptSubmitCommand: 'node "/repo/claude-code-broker.js" hook user-prompt-submit',
    permissionRequestCommand: 'node "/repo/claude-code-broker.js" hook permission-request',
    stopCommand: 'node "/repo/claude-code-broker.js" hook stop'
  }, { verbose: true });

  assert.equal(merged.hooks.SessionStart[0].hooks[0].statusMessage, 'intent-broker session sync');
  assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].statusMessage, 'intent-broker inbox sync');
  assert.equal(merged.hooks.Stop[0].hooks[0].statusMessage, 'intent-broker auto continue');
});

test('mergeIntentBrokerHooks preserves unrelated hooks and replaces existing intent-broker hooks', () => {
  const merged = mergeIntentBrokerHooks(
    {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              {
                type: 'command',
                command: 'node keep-me',
                statusMessage: 'other startup hook'
              }
            ]
          },
          {
            matcher: 'startup|resume',
            hooks: [
              {
                type: 'command',
                command: 'node old-intent-broker session-start',
                statusMessage: 'intent-broker session sync'
              }
            ]
          }
        ]
      }
    },
    {
      sessionStartCommand: 'node "/repo/claude-code-broker.js" hook session-start',
      userPromptSubmitCommand: 'node "/repo/claude-code-broker.js" hook user-prompt-submit',
      permissionRequestCommand: 'node "/repo/claude-code-broker.js" hook permission-request',
      stopCommand: 'node "/repo/claude-code-broker.js" hook stop'
    }
  );

  assert.equal(merged.hooks.SessionStart.length, 2);
  assert.equal(merged.hooks.SessionStart[0].hooks[0].command, 'node keep-me');
  assert.equal(merged.hooks.SessionStart[1].hooks[0].command, 'node "/repo/claude-code-broker.js" hook session-start');
  assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].command, 'node "/repo/claude-code-broker.js" hook user-prompt-submit');
  assert.equal(merged.hooks.Stop[0].hooks[0].command, 'node "/repo/claude-code-broker.js" hook stop');
  assert.equal(merged.hooks.PermissionRequest[0].hooks[0].command, 'node "/repo/claude-code-broker.js" hook permission-request');
});

test('readClaudeSettings and writeClaudeSettings round-trip JSON config', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intent-broker-claude-settings-'));
  const settingsPath = path.join(dir, '.claude', 'settings.json');

  try {
    const expected = {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [
              {
                type: 'command',
                command: 'node test session-start',
                statusMessage: 'intent-broker session sync'
              }
            ]
          }
        ]
      }
    };

    writeClaudeSettings(settingsPath, expected);
    const loaded = readClaudeSettings(settingsPath);

    assert.deepEqual(loaded, expected);
    assert.match(readFileSync(settingsPath, 'utf8'), /intent-broker session sync/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureClaudeCodeInstall writes missing managed files and becomes stable on rerun', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'intent-broker-claude-project-'));
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'intent-broker-claude-repo-'));
  const homeDir = mkdtempSync(path.join(tmpdir(), 'intent-broker-claude-home-'));

  try {
    const first = ensureClaudeCodeInstall({ cwd, repoRoot, homeDir });
    assert.equal(first.changed, true);
    assert.deepEqual(first.updated.sort(), ['command-shim', 'settings']);

    const paths = defaultInstallPaths({ cwd, repoRoot, homeDir });
    assert.match(readFileSync(paths.settingsPath, 'utf8'), /hook stop/);
    assert.match(readFileSync(paths.settingsPath, 'utf8'), new RegExp(`${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/adapters\\/claude-code-plugin\\/bin\\/claude-code-broker\\.js`));
    assert.match(readFileSync(paths.commandShimPath, 'utf8'), /bin\/intent-broker\.js/);

    const second = ensureClaudeCodeInstall({ cwd, repoRoot, homeDir });
    assert.equal(second.changed, false);
    assert.deepEqual(second.updated, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
