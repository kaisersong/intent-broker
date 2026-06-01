import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function collectTestFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

const files = collectTestFiles(path.resolve('tests'));
if (files.length === 0) {
  console.error('No test files found under tests/**/*.test.js');
  process.exit(1);
}

const result = spawnSync(process.execPath, [
  '--experimental-sqlite',
  '--experimental-test-isolation=none',
  '--test',
  ...files,
], {
  stdio: 'inherit',
  windowsHide: true,
});

process.exit(result.status ?? 1);
