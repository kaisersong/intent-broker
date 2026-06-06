import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/http/server.js';
import { createBrokerService } from '../../src/broker/service.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';

async function startServer() {
  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const server = createServer({ broker });
  await server.listen(0, '127.0.0.1');
  return { broker, server, port: server.address().port };
}

test('/intents rejects oversized request bodies before JSON parse', { concurrency: false }, async (t) => {
  const { server, port } = await startServer();
  t.after(async () => {
    await server.close();
  });

  const response = await fetch(`http://127.0.0.1:${port}/intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intentId: 'oversized-http-sync',
      kind: 'context_sync_request',
      fromParticipantId: 'sender',
      to: { mode: 'participant', participants: ['receiver'] },
      payload: {
        syncId: 'sync-songkai-1770000000000',
        userId: 'songkai',
        sourceNodeId: 'mb',
        sourceBrokerId: 'broker-local',
        context: {
          summary: 'x'.repeat(17 * 1024),
        },
        expiresAt: '2026-06-05T09:17:00.000Z',
      },
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.error, 'request_body_too_large');
});
