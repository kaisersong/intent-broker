import http from 'node:http';
import { URL } from 'node:url';

export const INTENTS_MAX_BODY_BYTES = 16 * 1024;

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function httpError(statusCode, code) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function readJson(req, { maxBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        if (!rejected) {
          rejected = true;
          reject(httpError(413, 'request_body_too_large'));
        }
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (rejected) {
        return;
      }
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

export function createServer({ broker, healthProvider = null } = {}) {
  const getHealth = healthProvider || (() => ({ ok: true }));
  const raw = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;

    // CORS headers for Tauri webview fetch requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && pathname === '/health') {
        writeJson(res, 200, getHealth());
        return;
      }

      if (req.method === 'POST' && pathname === '/participants/register') {
        const body = await readJson(req);
        writeJson(res, 200, broker.registerParticipant(body));
        return;
      }

      if (req.method === 'GET' && pathname === '/participants/resolve') {
        const aliases = requestUrl.searchParams.get('aliases') || '';
        writeJson(res, 200, broker.resolveParticipantsByAliases(
          aliases.split(',').map((item) => item.trim()).filter(Boolean)
        ));
        return;
      }

      if (req.method === 'GET' && pathname === '/participants') {
        const projectName = requestUrl.searchParams.get('projectName');
        const role = requestUrl.searchParams.get('role');
        writeJson(res, 200, { participants: broker.listParticipants({ projectName, role }) });
        return;
      }

      if (req.method === 'POST' && pathname.startsWith('/participants/') && pathname.endsWith('/alias')) {
        const participantId = pathname.split('/')[2];
        const body = await readJson(req);
        writeJson(res, 200, { participant: broker.updateParticipantAlias(participantId, body.alias) });
        return;
      }

      if (req.method === 'POST' && pathname.startsWith('/participants/') && pathname.endsWith('/roles')) {
        const participantId = pathname.split('/')[2];
        const body = await readJson(req);
        writeJson(res, 200, broker.addParticipantRoles(participantId, body.roles || []));
        return;
      }

      if (req.method === 'DELETE' && pathname.startsWith('/participants/') && pathname.endsWith('/roles')) {
        const participantId = pathname.split('/')[2];
        const body = await readJson(req);
        writeJson(res, 200, broker.removeParticipantRoles(participantId, body.roles || []));
        return;
      }

      if (pathname.startsWith('/participants/') && pathname.endsWith('/work-state')) {
        const participantId = pathname.split('/')[2];

        if (req.method === 'POST') {
          const body = await readJson(req);
          writeJson(res, 200, broker.updateWorkState(participantId, body));
          return;
        }

        if (req.method === 'GET') {
          writeJson(res, 200, { workState: broker.getWorkState(participantId) });
          return;
        }
      }

      if (req.method === 'GET' && pathname === '/work-state') {
        const participantId = requestUrl.searchParams.get('participantId');
        const projectName = requestUrl.searchParams.get('projectName');
        const status = requestUrl.searchParams.get('status');
        writeJson(res, 200, {
          items: broker.listWorkStates({ participantId, projectName, status })
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/intents') {
        const body = await readJson(req, { maxBytes: INTENTS_MAX_BODY_BYTES });
        writeJson(res, 202, broker.sendIntent(body));
        return;
      }

      if (req.method === 'GET' && pathname === '/tasks') {
        const status = requestUrl.searchParams.get('status') || null;
        const assignee = requestUrl.searchParams.get('assignee') || null;
        writeJson(res, 200, { tasks: broker.listTasks({ status, assignee }) });
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
        const semantic = requestUrl.searchParams.get('semantic') || null;
        const kindParam = requestUrl.searchParams.get('kind');
        const kind = kindParam ? kindParam.split(',').map((value) => value.trim()).filter(Boolean) : null;
        writeJson(res, 200, broker.readInbox(participantId, {
          after,
          limit,
          ...(semantic ? { semantic } : {}),
          ...(kind && kind.length ? { kind } : {})
        }));
        return;
      }

      if (req.method === 'POST' && pathname.endsWith('/ack')) {
        const [, , participantId] = pathname.split('/');
        const body = await readJson(req);
        broker.ackInbox(participantId, Number(body.eventId));
        writeJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/tasks/')) {
        const taskId = pathname.split('/')[2];
        writeJson(res, 200, { task: broker.getTaskView(taskId) });
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/threads/')) {
        const threadId = pathname.split('/')[2];
        writeJson(res, 200, { thread: broker.getThreadView(threadId) });
        return;
      }

      if (req.method === 'GET' && pathname === '/events/replay') {
        const after = Number(requestUrl.searchParams.get('after') || '0');
        const limit = Number(requestUrl.searchParams.get('limit') || '100');
        const taskId = requestUrl.searchParams.get('taskId');
        const threadId = requestUrl.searchParams.get('threadId');
        writeJson(res, 200, broker.replayEvents({ after, limit, taskId, threadId }));
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
          decisionMode: body.decisionMode ?? null,
          nativeDecision: body.nativeDecision ?? null,
          completesTask: body.completesTask ?? false
        });
        writeJson(res, 200, { approval: broker.getApprovalView(approvalId) });
        return;
      }

      if (req.method === 'POST' && pathname.startsWith('/presence/')) {
        const participantId = pathname.split('/')[2];
        const body = await readJson(req);
        writeJson(res, 200, broker.updatePresence(participantId, body.status, body.metadata));
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/presence/')) {
        const participantId = pathname.split('/')[2];
        writeJson(res, 200, broker.getPresence(participantId));
        return;
      }

      if (req.method === 'GET' && pathname === '/presence') {
        writeJson(res, 200, { participants: broker.listPresence() });
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/mobile/inbox/')) {
        const participantId = pathname.split('/')[3];
        const after = Number(requestUrl.searchParams.get('after') || '0');
        const limit = Number(requestUrl.searchParams.get('limit') || '50');
        writeJson(res, 200, broker.readMobileInbox(participantId, { after, limit }));
        return;
      }

      if (pathname === '/away') {
        if (req.method === 'GET') {
          writeJson(res, 200, { away: broker.getAwayMode() });
          return;
        }
        if (req.method === 'POST') {
          broker.setAwayMode(true);
          writeJson(res, 200, { away: true });
          return;
        }
        if (req.method === 'DELETE') {
          broker.setAwayMode(false);
          writeJson(res, 200, { away: false });
          return;
        }
      }

      if (req.method === 'GET' && pathname.startsWith('/projects/') && pathname.endsWith('/snapshot')) {
        const projectName = decodeURIComponent(pathname.split('/')[2]);
        writeJson(res, 200, { snapshot: broker.getProjectSnapshot(projectName) });
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/projects/') && pathname.endsWith('/approvals')) {
        const projectName = decodeURIComponent(pathname.split('/')[2]);
        const status = requestUrl.searchParams.get('status');
        writeJson(res, 200, { items: broker.listProjectApprovals(projectName, { status }) });
        return;
      }

      writeJson(res, 404, { error: 'not_found' });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      writeJson(res, statusCode, {
        error: error.code || 'internal_error',
        message: error.message
      });
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
    },
    raw() {
      return raw;
    }
  };
}
