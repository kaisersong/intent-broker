import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  defaultInstallPaths,
  buildHookCommand,
  mergeIntentBrokerHooks
} from '../../adapters/codex-plugin/install.js';
import {
  mergeManagedHookGroups,
  managedHookStatusMessages
} from '../../adapters/hook-installer-core/install-core.js';

test('buildHookCommand quotes the broker cli path and hook mode', () => {
  const command = buildHookCommand('/Users/song/projects/intent-broker/adapters/codex-plugin/bin/codex-broker.js', 'session-start');

  assert.equal(
    command,
    'node "/Users/song/projects/intent-broker/adapters/codex-plugin/bin/codex-broker.js" hook session-start'
  );
});

test('defaultInstallPaths targets codex config, state root, and unified command shim', () => {
  const paths = defaultInstallPaths({
    homeDir: '/Users/song',
    repoRoot: '/Users/song/projects/intent-broker'
  });

  assert.equal(paths.configPath, path.join('/Users/song', '.codex', 'config.toml'));
  assert.equal(paths.hooksConfigPath, path.join('/Users/song', '.codex', 'hooks.json'));
  assert.equal(paths.skillLinkPath, path.join('/Users/song', '.codex', 'skills', 'intent-broker'));
  assert.equal(paths.stateRoot, path.join('/Users/song', '.intent-broker', 'codex'));
  assert.equal(paths.commandShimPath, path.join('/Users/song', '.local', 'bin', 'intent-broker'));
  assert.equal(paths.unifiedCliPath, path.join('/Users/song/projects/intent-broker', 'bin', 'intent-broker.js'));
});

test('mergeIntentBrokerHooks adds session start and user prompt submit handlers', () => {
  const merged = mergeIntentBrokerHooks(
    {},
    {
      sessionStartCommand: 'node "/repo/codex-broker.js" hook session-start',
      userPromptSubmitCommand: 'node "/repo/codex-broker.js" hook user-prompt-submit'
    }
  );

  assert.deepEqual(merged, {
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|resume',
          hooks: [
            {
              type: 'command',
              command: 'node "/repo/codex-broker.js" hook session-start'
            }
          ]
        }
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: 'node "/repo/codex-broker.js" hook user-prompt-submit'
            }
          ]
        }
      ]
    }
  });
});

test('mergeIntentBrokerHooks can opt into visible hook status messages', () => {
  const merged = mergeIntentBrokerHooks(
    {},
    {
      sessionStartCommand: 'node "/repo/codex-broker.js" hook session-start',
      userPromptSubmitCommand: 'node "/repo/codex-broker.js" hook user-prompt-submit'
    },
    { verbose: true }
  );

  assert.equal(merged.hooks.SessionStart[0].hooks[0].statusMessage, 'intent-broker session sync');
  assert.equal(merged.hooks.UserPromptSubmit[0].hooks[0].statusMessage, 'intent-broker inbox sync');
});

test('mergeIntentBrokerHooks replaces existing intent-broker handlers but preserves unrelated hooks', () => {
  const merged = mergeIntentBrokerHooks(
    {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [
              {
                type: 'command',
                command: 'node old-intent-broker hook session-start',
                statusMessage: 'intent-broker session sync'
              }
            ]
          },
          {
            matcher: 'startup',
            hooks: [
              {
                type: 'command',
                command: 'node keep-me',
                statusMessage: 'other startup hook'
              }
            ]
          }
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node old-intent-broker hook user-prompt-submit',
                statusMessage: 'intent-broker inbox sync'
              }
            ]
          }
        ]
      }
    },
    {
      sessionStartCommand: 'node "/repo/codex-broker.js" hook session-start',
      userPromptSubmitCommand: 'node "/repo/codex-broker.js" hook user-prompt-submit'
    }
  );

  assert.equal(merged.hooks.SessionStart.length, 2);
  assert.equal(merged.hooks.SessionStart[0].hooks[0].command, 'node keep-me');
  assert.equal(
    merged.hooks.SessionStart[1].hooks[0].command,
    'node "/repo/codex-broker.js" hook session-start'
  );
  assert.equal(
    merged.hooks.UserPromptSubmit[0].hooks[0].command,
    'node "/repo/codex-broker.js" hook user-prompt-submit'
  );
});

test('managedHookStatusMessages exposes stable hook status labels', () => {
  assert.deepEqual(managedHookStatusMessages, {
    sessionStart: 'intent-broker session sync',
    userPromptSubmit: 'intent-broker inbox sync'
  });
});

test('mergeManagedHookGroups replaces only matching intent-broker owned entries', () => {
  const merged = mergeManagedHookGroups(
    [
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
            command: 'node old-intent-broker',
            statusMessage: 'intent-broker session sync'
          }
        ]
      }
    ],
    {
      matcher: 'startup|resume',
      statusMessage: 'intent-broker session sync',
      command: 'node new-intent-broker'
    }
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].hooks[0].command, 'node keep-me');
  assert.equal(merged[1].hooks[0].command, 'node new-intent-broker');
});
