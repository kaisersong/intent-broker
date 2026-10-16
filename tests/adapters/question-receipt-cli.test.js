import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const name of ['xiaok', 'claude-code']) {
  test(`${name}: actual hook CLI delivers a question and emits a neutral receipt`, { timeout: 10000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'broker-question-cli-'));
    const requests = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ eventId: 1, recipients: ['human.local'], deliveredCount: 1 }));
    });
    let child;
    let closed = false;
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const relative = name === 'xiaok' ? 'xiaok-code-plugin/bin/xiaok-broker.js' : 'claude-code-plugin/bin/claude-code-broker.js';
      const cli = name === 'xiaok' && process.env.QUESTION_RECEIPT_XIAOK_CLI
        ? process.env.QUESTION_RECEIPT_XIAOK_CLI
        : fileURLToPath(new URL(`../../adapters/${relative}`, import.meta.url));
      child = spawn(process.execPath, [cli, 'hook', 'pre-tool-use'], {
        cwd: home, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        signal: AbortSignal.timeout(5000),
        env: { ...process.env, HOME: home, USERPROFILE: home, BROKER_URL: `http://127.0.0.1:${server.address().port}`,
          INTENT_BROKER_SKIP_APPROVAL_SYNC: '0', PROJECT_NAME: 'synthetic-question-project' },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const completion = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
      });
      child.stdin.end(JSON.stringify({ session_id: 'synthetic-question-cli', cwd: home,
        tool_name: 'AskUserQuestion', tool_use_id: 'synthetic-question-1',
        tool_input: { questions: [{ header: 'Fixture', question: 'Should the fixture be updated?',
          options: [{ label: 'Update' }, { label: 'Keep' }] }] } }));
      const result = await completion;
      assert.equal(result.code, 0, stderr);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, '/intents');
      assert.equal(requests[0].method, 'POST');
      assert.equal(requests[0].body.kind, 'ask_clarification');
      assert.deepEqual(requests[0].body.to.participants, ['human.local']);
      assert.equal(requests[0].body.payload.body.prompt, 'Should the fixture be updated?');
      const output = JSON.parse(stdout);
      const receipt = name === 'xiaok' ? output : output.hookSpecificOutput;
      assert.match(receipt.additionalContext, /submitted through Intent Broker/);
      assert.doesNotMatch(JSON.stringify(output), /HexDeck/);
      if (name === 'xiaok') assert.equal(output.preventContinuation, true);
      else assert.equal(receipt.permissionDecision, 'deny');
    } finally {
      if (child && !closed) {
        child.kill(); await new Promise(resolve => child.once('close', resolve)); closed = true;
      }
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      rmSync(home, { recursive: true, force: true, maxRetries: 3 });
      assert.ok(!child || closed, 'owned hook process must exit');
    }
  });
}
