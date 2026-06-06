import { mkdtemp, rm, mkdir, writeFile, appendFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

export async function runGit(args, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const result = { args, cwd, code, stdout, stderr };
      if (code === 0) {
        resolve(result);
        return;
      }
      const error = new Error(stderr.trim() || `git ${args.join(' ')} exited with ${code}`);
      error.result = result;
      reject(error);
    });
  });
}

export async function createContextSyncE2EHarness() {
  const root = await mkdtemp(join(tmpdir(), 'intent-broker-context-sync-e2e-'));
  const remote = join(root, 'remote.git');
  const machineA = join(root, 'machine-a');
  const machineB = join(root, 'machine-b');
  const logs = join(root, 'logs');
  const reportPath = join(root, 'report.json');

  const commandLog = [];
  async function git(args, options = {}) {
    const result = await runGit(args, options);
    commandLog.push(result);
    return result;
  }

  async function setup() {
    await mkdir(logs, { recursive: true });
    await git(['init', '--bare', remote], { cwd: root });
    await git(['init', machineA], { cwd: root });
    await git(['-C', machineA, 'config', 'user.email', 'machine-a@example.test'], { cwd: root });
    await git(['-C', machineA, 'config', 'user.name', 'Machine A'], { cwd: root });
    await writeFile(join(machineA, 'README.md'), 'base\n');
    await git(['-C', machineA, 'add', 'README.md'], { cwd: root });
    await git(['-C', machineA, 'commit', '-m', 'base'], { cwd: root });
    await git(['-C', machineA, 'branch', '-M', 'main'], { cwd: root });
    await git(['-C', machineA, 'remote', 'add', 'origin', remote], { cwd: root });
    await git(['-C', machineA, 'push', '-u', 'origin', 'main'], { cwd: root });
    await git(['clone', remote, machineB], { cwd: root });
    await git(['-C', machineB, 'config', 'user.email', 'machine-b@example.test'], { cwd: root });
    await git(['-C', machineB, 'config', 'user.name', 'Machine B'], { cwd: root });
    return api;
  }

  async function writeMachineFile(machinePath, relativePath, content) {
    const fullPath = join(machinePath, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  async function appendMachineFile(machinePath, relativePath, content) {
    await appendFile(join(machinePath, relativePath), content);
  }

  async function commit(machinePath, message) {
    await git(['-C', machinePath, 'add', '.'], { cwd: root });
    await git(['-C', machinePath, 'commit', '-m', message], { cwd: root });
  }

  async function makeDivergentHead() {
    await appendMachineFile(machineB, 'README.md', 'machine-b divergent commit\n');
    await commit(machineB, 'machine b diverges');
  }

  async function rejectLatestRefPushes() {
    const hookPath = join(remote, 'hooks', 'pre-receive');
    await writeFile(hookPath, [
      '#!/bin/sh',
      'while read oldrev newrev refname; do',
      '  case "$refname" in',
      '    refs/heads/wip/*-latest) exit 1 ;;',
      '  esac',
      'done',
      'exit 0',
      '',
    ].join('\n'));
    await chmod(hookPath, 0o755);
  }

  async function listRemoteWipRefs() {
    const result = await git(['ls-remote', remote, 'refs/heads/wip/*'], { cwd: root });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/);
        return { sha, ref };
      });
  }

  async function status(machinePath) {
    const result = await git(['-C', machinePath, 'status', '--short', '--branch'], { cwd: root });
    return result.stdout;
  }

  async function writeReport(extra = {}) {
    const report = {
      root,
      remote,
      machineA,
      machineB,
      commandLog,
      remoteWipRefs: await listRemoteWipRefs().catch((error) => [{ error: error.message }]),
      machineAStatus: await status(machineA).catch((error) => error.message),
      machineBStatus: await status(machineB).catch((error) => error.message),
      ...extra,
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    return report;
  }

  async function cleanup() {
    if (process.env.CONTEXT_SYNC_E2E_KEEP_TMP === '1') {
      await writeReport({ kept: true });
      return;
    }
    await rm(root, { recursive: true, force: true });
  }

  const api = {
    root,
    remote,
    machineA,
    machineB,
    logs,
    reportPath,
    setup,
    git,
    writeMachineFile,
    appendMachineFile,
    commit,
    makeDivergentHead,
    rejectLatestRefPushes,
    listRemoteWipRefs,
    status,
    writeReport,
    cleanup,
  };
  return api;
}
