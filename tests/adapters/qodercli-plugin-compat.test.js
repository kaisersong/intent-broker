import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  repairQoderManagedPluginHooks
} from '../../adapters/qodercli-plugin/plugin-compat.js';

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

test('repairQoderManagedPluginHooks removes the Windows-only qoder-update hook on non-Windows platforms', () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'qoder-plugin-compat-'));

  try {
    const installPath = path.join(
      homeDir,
      '.qoder',
      'plugins',
      'cache',
      'enterprise',
      'qoder-update',
      '1.0.13'
    );
    const hooksPath = path.join(installPath, 'hooks', 'hooks.json');
    const unrelatedHook = {
      hooks: [
        {
          type: 'command',
          command: 'echo ok'
        }
      ]
    };

    writeJson(path.join(homeDir, '.qoder', 'plugins', 'installed_plugins_v2.json'), {
      version: 2,
      plugins: {
        'qoder-update@enterprise': [
          {
            installPath,
            version: '1.0.13'
          }
        ]
      }
    });
    writeJson(path.join(installPath, '.qoder-plugin', 'plugin.json'), {
      name: 'qoder-update',
      version: '1.0.13',
      hooks: './hooks/hooks.json'
    });
    writeJson(hooksPath, {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'cmd.exe /c ${QODER_PLUGIN_ROOT}/qoder-update.exe'
              },
              {
                type: 'command',
                command: 'echo keep'
              }
            ]
          },
          unrelatedHook
        ],
        Stop: [unrelatedHook]
      }
    });

    const result = repairQoderManagedPluginHooks({ homeDir, platform: 'darwin' });

    assert.deepEqual(result.repairedFiles, [hooksPath]);
    assert.deepEqual(JSON.parse(readFileSync(hooksPath, 'utf8')), {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo keep'
              }
            ]
          },
          unrelatedHook
        ],
        Stop: [unrelatedHook]
      }
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('repairQoderManagedPluginHooks preserves qoder-update hook on Windows', () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'qoder-plugin-compat-'));

  try {
    const installPath = path.join(homeDir, '.qoder', 'plugins', 'cache', 'enterprise', 'qoder-update', '1.0.13');
    const hooksPath = path.join(installPath, 'hooks', 'hooks.json');
    const originalHooks = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'cmd.exe /c ${QODER_PLUGIN_ROOT}/qoder-update.exe'
              }
            ]
          }
        ]
      }
    };

    writeJson(path.join(homeDir, '.qoder', 'plugins', 'installed_plugins_v2.json'), {
      version: 2,
      plugins: {
        'qoder-update@enterprise': [{ installPath }]
      }
    });
    writeJson(path.join(installPath, '.qoder-plugin', 'plugin.json'), {
      name: 'qoder-update',
      hooks: './hooks/hooks.json'
    });
    writeJson(hooksPath, originalHooks);

    const result = repairQoderManagedPluginHooks({ homeDir, platform: 'win32' });

    assert.deepEqual(result.repairedFiles, []);
    assert.deepEqual(JSON.parse(readFileSync(hooksPath, 'utf8')), originalHooks);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('repairQoderManagedPluginHooks ignores malformed or unrelated plugin entries', () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'qoder-plugin-compat-'));

  try {
    const installPath = path.join(homeDir, '.qoder', 'plugins', 'cache', 'enterprise', 'other-plugin', '1.0.0');
    const hooksPath = path.join(installPath, 'hooks', 'hooks.json');
    const originalHooks = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: 'cmd.exe /c ${QODER_PLUGIN_ROOT}/qoder-update.exe'
              }
            ]
          }
        ]
      }
    };

    writeJson(path.join(homeDir, '.qoder', 'plugins', 'installed_plugins_v2.json'), {
      version: 2,
      plugins: {
        'other-plugin@enterprise': [{ installPath }]
      }
    });
    writeJson(path.join(installPath, '.qoder-plugin', 'plugin.json'), {
      name: 'other-plugin',
      hooks: './hooks/hooks.json'
    });
    writeJson(hooksPath, originalHooks);

    const result = repairQoderManagedPluginHooks({ homeDir, platform: 'darwin' });

    assert.deepEqual(result.repairedFiles, []);
    assert.deepEqual(JSON.parse(readFileSync(hooksPath, 'utf8')), originalHooks);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
