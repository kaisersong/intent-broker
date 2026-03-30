import http from 'node:http';
import { URL } from 'node:url';

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

export function createServer({ broker } = {}) {
  const raw = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        writeJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/participants/register') {
        const body = await readJson(req);
        writeJson(res, 200, broker.registerParticipant(body));
        return;
      }

      if (req.method === 'POST' && pathname === '/intents') {
        const body = await readJson(req);
        writeJson(res, 202, broker.sendIntent(body));
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/inbox/')) {
        const [, , participantId, action] = pathname.split('/');
        if (!participantId || action) {
          writeJson(res, 404, { error: 'not_found' });
          return;
        }

        const after = Number(requestUrl.searchParams.get('after') || '0');
        const limit = Number(requestUrl.searchParams.get('limit') || '50');
        writeJson(res, 200, broker.readInbox(participantId, { after, limit }));
        return;
      }

      if (req.method === 'POST' && pathname.endsWith('/ack')) {
        const [, , participantId] = pathname.split('/');
        const body = await readJson(req);
        broker.ackInbox(participantId, Number(body.eventId));
        writeJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname.startsWith('/approvals/') && pathname.endsWith('/respond')) {
        const approvalId = pathname.split('/')[2];
        const body = await readJson(req);
        broker.respondApproval({
          approvalId,
          taskId: body.taskId,
          fromParticipantId: body.fromParticipantId,
          decision: body.decision,
          completesTask: body.completesTask ?? false
        });
        writeJson(res, 200, { approval: broker.getApprovalView(approvalId) });
        return;
      }

      writeJson(res, 404, { error: 'not_found' });
    } catch (error) {
      writeJson(res, 500, { error: 'internal_error', message: error.message });
    }
  });

  return {
    listen(port, host) {
      return new Promise((resolve) => raw.listen(port, host, resolve));
    },
    close() {
      return new Promise((resolve, reject) => {
        raw.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    address() {
      return raw.address();
    }
  };
}
