import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCollaborationSmoke } from '../../scripts/collaboration-smoke.js';

test('collaboration smoke verification runs real Codex and Claude Code bridges and writes logs', { concurrency: false }, async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'intent-broker-collab-smoke-'));

  const summary = await runCollaborationSmoke({
    repoRoot: '/Users/song/projects/intent-broker',
    logDir
  });

  assert.equal(summary.projectName, 'intent-broker');
  assert.equal(summary.participants.length, 2);
  assert.equal(summary.initialWorkStates.length, 2);
  assert.match(summary.claudeInjectedContext, /Intent Broker update/);
  assert.equal(summary.finalWorkStates.length, 2);
  assert.equal(summary.finalWorkStates.find((item) => item.participantId === summary.claudeParticipantId).status, 'implementing');
  assert.equal(summary.thread.events.length, 2);
  assert.equal(summary.thread.events[0].kind, 'request_task');
  assert.equal(summary.thread.events[1].kind, 'report_progress');

  assert.ok(existsSync(join(logDir, 'broker.stdout.log')));
  assert.ok(existsSync(join(logDir, 'codex.session-start.stdout.log')));
  assert.ok(existsSync(join(logDir, 'claude.session-start.stdout.log')));
  assert.ok(existsSync(join(logDir, 'codex.send-task.stdout.log')));
  assert.ok(existsSync(join(logDir, 'claude.user-prompt-submit.stdout.log')));
  assert.ok(existsSync(join(logDir, 'claude.set-work-state.stdout.log')));
  assert.ok(existsSync(join(logDir, 'claude.send-progress.stdout.log')));
  assert.ok(existsSync(join(logDir, 'analysis.md')));
});
