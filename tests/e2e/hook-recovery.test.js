import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';

import { createBrokerService } from '../../src/broker/service.js';
import { createServer } from '../../src/http/server.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { runSessionStartHook, runUserPromptSubmitHook } from '../../adapters/codex-plugin/hooks.js';

async function startBrokerOnPort(port) {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({ broker });
  await server.listen(port, '127.0.0.1');
  return { broker, server };
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForHealth(brokerUrl) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${brokerUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`broker_not_ready:${brokerUrl}`);
}

test('Codex hook silently re-registers after broker restart', { concurrency: false }, async (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), 'intent-broker-hook-recovery-'));
  const port = await getFreePort();
  const brokerUrl = `http://127.0.0.1:${port}`;

  const first = await startBrokerOnPort(port);
  await waitForHealth(brokerUrl);
  t.after(async () => {
    try {
      await first.server.close();
    } catch {}
  });

  await runSessionStartHook(
    { session_id: '019d6000-aaaa-bbbb-cccc-111111111111' },
    {
      env: {
        BROKER_URL: brokerUrl,
        PROJECT_NAME: 'intent-broker'
      },
      cwd: '/Users/song/projects/intent-broker',
      homeDir
    }
  );

  assert.equal(first.broker.listParticipants().length, 1);
  assert.equal(first.broker.listParticipants()[0].alias, 'codex');

  await first.server.close();

  const second = await startBrokerOnPort(port);
  await waitForHealth(brokerUrl);
  t.after(async () => {
    await second.server.close();
  });

  const result = await runUserPromptSubmitHook(
    {
      session_id: '019d6000-aaaa-bbbb-cccc-111111111111',
      prompt: 'check recovery'
    },
    {
      env: {
        BROKER_URL: brokerUrl,
        PROJECT_NAME: 'intent-broker'
      },
      cwd: '/Users/song/projects/intent-broker',
      homeDir
    }
  );

  assert.equal(result, null);
  assert.equal(second.broker.listParticipants().length, 1);
  assert.equal(second.broker.listParticipants()[0].participantId, 'codex-session-019d6000');
  assert.equal(second.broker.listParticipants()[0].alias, 'codex');
});
