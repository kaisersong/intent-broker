import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const QODER_UPDATE_WINDOWS_HOOK_COMMAND = 'cmd.exe /c ${QODER_PLUGIN_ROOT}/qoder-update.exe';

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function qoderPluginsV2Path(homeDir) {
  return path.join(homeDir, '.qoder', 'plugins', 'installed_plugins_v2.json');
}

function pluginManifestPath(installPath) {
  const qoderPluginManifest = path.join(installPath, '.qoder-plugin', 'plugin.json');
  if (readJson(qoderPluginManifest)) {
    return qoderPluginManifest;
  }
  return path.join(installPath, 'plugin.json');
}

function resolvePluginHooksPath(installPath, manifest) {
  if (typeof manifest?.hooks !== 'string' || !manifest.hooks.trim()) {
    return null;
  }

  return path.resolve(installPath, manifest.hooks);
}

function installedPluginPaths(installedPluginsV2) {
  const plugins = installedPluginsV2?.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    return [];
  }

  const paths = [];
  for (const entries of Object.values(plugins)) {
    const normalizedEntries = Array.isArray(entries) ? entries : [entries];
    for (const entry of normalizedEntries) {
      if (typeof entry?.installPath === 'string' && entry.installPath) {
        paths.push(entry.installPath);
      }
    }
  }
  return paths;
}

function removeWindowsOnlyQoderUpdateHooks(hooksConfig) {
  const hooks = hooksConfig?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { changed: false, hooksConfig };
  }

  let changed = false;
  const nextHooks = { ...hooks };

  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      continue;
    }

    const nextGroups = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        nextGroups.push(group);
        continue;
      }

      const nextGroupHooks = group.hooks.filter((hook) => {
        return hook?.command !== QODER_UPDATE_WINDOWS_HOOK_COMMAND;
      });

      if (nextGroupHooks.length !== group.hooks.length) {
        changed = true;
      }
      if (nextGroupHooks.length > 0) {
        nextGroups.push({ ...group, hooks: nextGroupHooks });
      }
    }

    if (nextGroups.length > 0) {
      nextHooks[eventName] = nextGroups;
    } else {
      delete nextHooks[eventName];
      changed = true;
    }
  }

  return {
    changed,
    hooksConfig: changed ? { ...hooksConfig, hooks: nextHooks } : hooksConfig
  };
}

export function repairQoderManagedPluginHooks({
  homeDir = os.homedir(),
  platform = process.platform
} = {}) {
  if (platform === 'win32') {
    return { repairedFiles: [] };
  }

  const repairedFiles = [];
  const installedPluginsV2 = readJson(qoderPluginsV2Path(homeDir));

  for (const installPath of installedPluginPaths(installedPluginsV2)) {
    const manifestPath = pluginManifestPath(installPath);
    const manifest = readJson(manifestPath);
    if (manifest?.name !== 'qoder-update') {
      continue;
    }

    const hooksPath = resolvePluginHooksPath(installPath, manifest);
    if (!hooksPath) {
      continue;
    }

    const hooksConfig = readJson(hooksPath);
    const repair = removeWindowsOnlyQoderUpdateHooks(hooksConfig);
    if (!repair.changed) {
      continue;
    }

    writeJson(hooksPath, repair.hooksConfig);
    repairedFiles.push(hooksPath);
  }

  return { repairedFiles };
}
