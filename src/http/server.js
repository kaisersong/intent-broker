import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { URL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

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
    const decoder = new StringDecoder('utf8');

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        if (!rejected) {
          rejected = true;
          reject(httpError(413, 'request_body_too_large'));
        }
        return;
      }
      raw += decoder.write(chunk);
    });
    req.on('end', () => {
      if (rejected) {
        return;
      }
      raw += decoder.end();
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

function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function roomStatus(result, successStatus = 200) {
  if (result?.ok !== false) return successStatus;
  if (result.code === 'room_authentication_required') return 401;
  if (result.code === 'room_actor_forbidden' || result.code === 'room_actor_identity_mismatch') return 403;
  if (result.code === 'room_not_found' || result.code === 'room_message_not_found') return 404;
  if (result.code === 'room_delete_pending' || result.code === 'disclosure_revocation_pending') return 409;
  if (result.code === 'room_revision_conflict' || result.code === 'room_message_duplicate') return 409;
  return 400;
}

export function createServer({
  broker,
  healthProvider = null,
  roomService = null,
  roomDesktopToken = null,
  roomKSwarmToken = null,
  roomHostPrincipal = null,
} = {}) {
  const getHealth = healthProvider || (() => ({ ok: true }));
  const raw = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;

    const roomPath = pathname === '/rooms' || pathname.startsWith('/rooms/')
      || pathname === '/room-wakes' || pathname.startsWith('/room-wakes/');
    // Legacy generic APIs still support the Tauri webview. Room APIs are
    // main-process-only and never advertise a browser origin.
    if (!roomPath) res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-intent-broker-room-token');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (roomPath) {
        const token = req.headers['x-intent-broker-room-token'];
        const desktopAuthenticated = tokenMatches(token, roomDesktopToken);
        const kswarmAuthenticated = tokenMatches(token, roomKSwarmToken);
        if (!roomService || (!desktopAuthenticated && !kswarmAuthenticated)) {
          writeJson(res, 401, { error: 'room_authentication_required' });
          return;
        }
        if (req.method === 'GET' && pathname === '/rooms/workspace-protocol' && roomService.workspace) {
          writeJson(res,200,{ok:true,protocols:{room_workspace_v1:{contextVersion:1,resultVersion:1,releaseVersion:1}},capabilities:['workspace-cas','execution-claims','commit-tickets','physical-release','read-grants']});
          return;
        }

        // Wake claim/complete is a Desktop-main-only transport surface. The
        // renderer never receives this token or a generic HTTP primitive.
        if (pathname === '/room-wakes' || pathname.startsWith('/room-wakes/')) {
          if (!desktopAuthenticated) {
            writeJson(res, 403, { code: 'room_actor_forbidden' });
            return;
          }
          if (req.method === 'GET' && pathname === '/room-wakes') {
            const logicalAgentId = requestUrl.searchParams.get('logicalAgentId') || '';
            const result = roomService.listPendingWakeObligations({ logicalAgentId });
            writeJson(res, roomStatus(result), result);
            return;
          }
          if (req.method === 'POST' && pathname === '/room-wakes/claim') {
            const body = await readJson(req);
            const dispatcherAgentCtx = {
              sessionId: 'desktop-room-wake-dispatcher',
              requestSource: 'agent',
              actor: { kind: 'agent', logicalAgentId: body.logicalAgentId },
              allowedLogicalAgentIds: [body.logicalAgentId],
              hostParticipantId: body.hostParticipantId,
              issuedAt: new Date().toISOString(),
            };
            const result = roomService.claimWake(body, dispatcherAgentCtx);
            writeJson(res, roomStatus(result), result);
            return;
          }
          if (req.method === 'POST' && pathname === '/room-wakes/complete') {
            const result = await roomService.completeWake(await readJson(req));
            writeJson(res, roomStatus(result, 201), result);
            return;
          }
          // design §6.2 RoomHistoryReadCapability：agent-only claim-token-bound
          // 历史分页读取。与 GET /rooms/:roomId/messages（desktop UI 全量/分页
          // 读取，走宽松 ctx）完全独立，不复用同一鉴权分支——这里只信任
          // claim token 自身，body 不能声明 requestSource/actor 覆盖它。
          if (req.method === 'POST' && pathname === '/room-wakes/history-page') {
            const body = await readJson(req);
            const result = roomService.listRoomMessagesPage({
              claimToken: body.claimToken,
              roomId: body.roomId,
              afterSequence: body.afterSequence,
              beforeSequence: body.beforeSequence,
              limit: body.limit,
            });
            writeJson(res, roomStatus(result), result);
            return;
          }
          writeJson(res, 404, { error: 'not_found' });
          return;
        }

        const ctx = desktopAuthenticated
          ? {
              sessionId: 'desktop-main-user',
              requestSource: 'user',
              actor: { kind: 'user', userId: 'user.local' },
              allowedLogicalAgentIds: [],
              issuedAt: new Date().toISOString(),
            }
          : {
              sessionId: 'kswarm-system',
              requestSource: 'system',
              actor: { kind: 'system', service: 'kswarm' },
              scopes: ['room-read', 'room-membership-lease', 'room-project-event-publisher'],
              issuedAt: new Date().toISOString(),
            };
        const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const roomId = segments[1];
        const action = segments[2];
        let result;

        if (roomId && action === 'workspace' && roomService.workspace) {
          const commands = {
            'register-host':'registerHost', 'begin-change':'beginChange',
            'commit-binding':'commitBinding', 'activate-binding':'activateBinding',
            'activation-failed':'activationFailed', 'cancel-change':'cancelChange',
            'publish-instructions':'publishInstructions', acquire:'acquireClaim',
            ack:'ackClaim', release:'releaseClaim', cancel:'cancelClaim', takeover:'takeoverClaim',
            heartbeat:'heartbeatClaim', releasing:'releasingClaim', orphan:'orphanClaim',
            ticket:'issueCommitTicket', 'agent-ticket':'issueCommitTicket', projection:'projectEvent',
            'confirm-artifact':'confirmArtifact', 'verify-commit-ticket':'verifyCommitTicket',
            'recover-ticket':'recoverTicket', 'recover-claim':'recoverClaim', 'recover-admission':'recoverAdmission',
            'recover-mapping-ticket':'recoverMappingTicket', 'recover-mapping-operation':'recoverMappingOperation',
            'grant-read':'issueReadGrant', 'revoke-read':'revokeReadGrant', 'authorize-read':'authorizeRead',
            'agent-authorize-read':'authorizeRead', 'confirm-decision':'confirmDecision',
            'project-fence':'beginMapping', 'mapping-ticket':'issueMappingTicket',
            'verify-mapping-ticket':'verifyMappingTicket', 'mapping-applied':'mappingApplied',
            'verify-claim':'verifyClaim',
            'claim-wake':'claimWake',
            'abandon-wake':'abandonWake',
            'recover-wake':'recoverWake',
            'cancel-mapping':'cancelMapping', 'mapping-rejected':'mappingRejected',
          };
          const command=segments[3];
          const serviceOnly=['verify-mapping-ticket','mapping-applied','verify-claim','verify-commit-ticket','mapping-rejected'];
          if ((serviceOnly.includes(command) && !kswarmAuthenticated) || (!serviceOnly.includes(command) && !desktopAuthenticated)) {
            writeJson(res,403,{ok:false,code:'room_actor_forbidden'});return;
          }
          const workspaceCtx={...ctx};
          if(desktopAuthenticated){
            // Credential-derived installation principal, never request body.
            workspaceCtx.hostPrincipal=roomHostPrincipal??createHash('sha256').update('room-host-installation\n'+roomDesktopToken).digest('hex');
            workspaceCtx.hostIncarnation=Number(req.headers['x-intent-broker-host-incarnation']);
          }
          if(req.method==='GET'&&!command){
            result=roomService.workspace.getState({roomId,instructionsRevision:requestUrl.searchParams.has('instructionsRevision')?Number(requestUrl.searchParams.get('instructionsRevision')):undefined},workspaceCtx);
          }else if(req.method==='POST'&&Object.hasOwn(commands,command)){
            const body=await readJson(req,{maxBytes:1024*1024});
            if(['acquire','ack','agent-ticket','agent-authorize-read','claim-wake'].includes(command)){
              if(typeof body.logicalAgentId!=='string'||!body.logicalAgentId.trim()){writeJson(res,400,{ok:false,code:'room_actor_identity_mismatch'});return;}
              // Only the credential-bearing main dispatcher can select an agent;
              // service verifies active membership and ownership of every claim.
              workspaceCtx.requestSource='agent';workspaceCtx.actor={kind:'agent',logicalAgentId:body.logicalAgentId};workspaceCtx.allowedLogicalAgentIds=[body.logicalAgentId];
            }
            result=roomService.workspace[commands[command]]({...body,roomId},workspaceCtx);
          }else{writeJson(res,404,{error:'not_found'});return;}
          writeJson(res,roomStatus(result),result);return;
        }

        if (req.method === 'GET' && segments.length === 1) {
          result = roomService.listCollaborationRooms({}, ctx);
          writeJson(res, roomStatus(result), result);
          return;
        }
        if (req.method === 'POST' && segments.length === 1) {
          result = roomService.createRoom(await readJson(req), ctx);
          writeJson(res, roomStatus(result, 201), result);
          return;
        }
        if (req.method === 'GET' && roomId && !action) {
          result = roomService.getCollaborationRoom({ roomId }, ctx);
          writeJson(res, roomStatus(result), result);
          return;
        }
        if (req.method === 'POST' && roomId && action === 'scheduled-wakes') {
          if(!desktopAuthenticated){writeJson(res,403,{code:'room_actor_forbidden'});return;}
          result=roomService.sendScheduledRoomWake({...await readJson(req),roomId},ctx);
          writeJson(res,roomStatus(result,201),result);return;
        }
        if (req.method === 'POST' && roomId && action === 'messages') {
          result = roomService.sendRoomMessage({ ...(await readJson(req)), roomId }, ctx);
          writeJson(res, roomStatus(result, 201), result);
          return;
        }
        // design §6.2：GET /rooms/:roomId/messages?afterSequence=&beforeSequence=&limit=
        // 只委托同一 roomService.listRoomMessages；不新建第二套 store query 路径。
        // 无查询参数的调用保持旧全量语义供现有 UI 使用。
        if (req.method === 'GET' && roomId && action === 'messages') {
          const afterSequenceRaw = requestUrl.searchParams.get('afterSequence');
          const beforeSequenceRaw = requestUrl.searchParams.get('beforeSequence');
          const limitRaw = requestUrl.searchParams.get('limit');
          result = roomService.listRoomMessages({
            roomId,
            ...(afterSequenceRaw !== null ? { afterSequence: Number(afterSequenceRaw) } : {}),
            ...(beforeSequenceRaw !== null ? { beforeSequence: Number(beforeSequenceRaw) } : {}),
            ...(limitRaw !== null ? { limit: Number(limitRaw) } : {}),
          }, ctx);
          writeJson(res, roomStatus(result), result);
          return;
        }
        if (req.method === 'PUT' && roomId && action === 'members') {
          result = roomService.updateRoomMembers({ ...(await readJson(req)), roomId }, ctx);
          writeJson(res, roomStatus(result), result);
          return;
        }
        if (req.method === 'POST' && roomId && action === 'delete') {
          const input = await readJson(req);
          result = roomService.deleteRoom({roomId, expectedRoomRevision: input?.expectedRoomRevision}, ctx);
          writeJson(res, roomStatus(result), result);
          return;
        }
        if (req.method === 'POST' && roomId && action === 'archive') {
          result = roomService.archiveRoom({ ...(await readJson(req)), roomId }, ctx);
          writeJson(res, roomStatus(result), result);
          return;
        }
        if (req.method === 'POST' && roomId && action === 'seen') {
          result = roomService.markRoomSeen({ ...(await readJson(req)), roomId }, ctx);
          writeJson(res, roomStatus(result), result);
          return;
        }
        if (req.method === 'POST' && roomId && action === 'discussions') {
          result = roomService.startTeamDiscussion({ ...(await readJson(req)), roomId }, ctx);
          writeJson(res, roomStatus(result, 201), result);
          return;
        }
        if (req.method === 'POST' && roomId && action === 'discussion' && segments[3] === 'cancel') {
          result = roomService.cancelDiscussion({ ...(await readJson(req)), roomId }, ctx);
          writeJson(res, roomStatus(result), result);
          return;
        }
        if (req.method === 'POST' && roomId && action === 'membership-leases') {
          result = roomService.acquireMembershipLease({ ...(await readJson(req)), roomId }, ctx);
          writeJson(res, roomStatus(result, 201), result);
          return;
        }
        if (req.method === 'POST' && roomId && action === 'project-events') {
          const body = await readJson(req);
          const sourceRefs = body.sourceRefs && typeof body.sourceRefs === 'object' && !Array.isArray(body.sourceRefs)
            ? body.sourceRefs
            : {};
          result = roomService.sendRoomMessage({
            roomId,
            kind: 'project_event',
            text: body.text ?? body.summary,
            sourceRef: {
              ...sourceRefs,
              projectId: body.projectId,
              projectRevision: body.projectRevision,
              eventType: body.eventType,
              projectionEventId: body.projectionEventId,
            },
            responsePolicy: 'none',
            idempotencyKey: body.idempotencyKey ?? body.projectionEventId,
          }, ctx);
          writeJson(res, roomStatus(result, 201), result);
          return;
        }

        writeJson(res, 404, { error: 'not_found' });
        return;
      }

      if (req.method === 'GET' && pathname === '/health') {
        writeJson(res, 200, { ...getHealth(), ...(roomService?.workspace ? { protocols: { room_workspace_v1: { contextVersion: 1, resultVersion: 1, releaseVersion: 1 } } } : {}) });
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
