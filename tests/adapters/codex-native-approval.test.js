import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCodexNativeApprovalRequest,
  buildNativeApprovalActions,
  mirrorCodexNativeApproval,
  resolveCodexNativeDecision
} from '../../adapters/session-bridge/codex-native-approval.js';

test('buildNativeApprovalActions preserves native decisions and disables unsupported amendments', () => {
  const actions = buildNativeApprovalActions([
    'accept',
    'acceptForSession',
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['mktemp'] } },
    'cancel'
  ]);

  assert.deepEqual(actions[0], {
    key: 'accept',
    label: 'Allow once',
    decisionMode: 'yes',
    nativeDecision: 'accept',
    disabled: false,
    unsupportedReason: null
  });
  assert.deepEqual(actions[1], {
    key: 'acceptForSession',
    label: 'Always',
    decisionMode: 'always',
    nativeDecision: 'acceptForSession',
    disabled: false,
    unsupportedReason: null
  });
  assert.equal(actions[2].decisionMode, 'yes');
  assert.equal(actions[2].disabled, true);
  assert.match(actions[2].label, /Allow with exec policy change/);
  assert.match(actions[2].unsupportedReason, /does not yet support amendment-bearing native Codex approval decisions/);
  assert.deepEqual(actions[3], {
    key: 'cancel',
    label: 'Cancel',
    decisionMode: 'cancel',
    nativeDecision: 'cancel',
    disabled: false,
    unsupportedReason: null
  });
});

test('buildCodexNativeApprovalRequest preserves native binding metadata and action semantics', () => {
  const request = buildCodexNativeApprovalRequest({
    config: {
      participantId: 'codex-session-019d4489'
    },
    sessionId: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
    ownerInstanceId: 'owner-1',
    serverRequest: {
      id: 7,
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'call_real_1',
        reason: 'Allow Desktop mktemp?',
        command: "/bin/zsh -lc 'mktemp -d /Users/song/Desktop/codex-owner-XXXXXX'",
        cwd: '/Users/song/projects/hexdeck',
        availableDecisions: ['accept', 'acceptForSession', 'cancel']
      }
    }
  });

  assert.equal(request.approvalId, 'codex-native-019d4489-1234-5678-9999-bbbbbbbbbbbb-turn-1-call_real_1');
  assert.equal(request.taskId, 'codex-native-approval-019d4489-1234-5678-9999-bbbbbbbbbbbb-turn-1-call_real_1');
  assert.equal(request.body.payload.body.summary, 'Allow Desktop mktemp?');
  assert.equal(request.body.payload.body.commandLine, "/bin/zsh -lc 'mktemp -d /Users/song/Desktop/codex-owner-XXXXXX'");
  assert.equal(request.body.payload.delivery.source, 'codex-native-approval');
  assert.equal(request.body.payload.nativeCodexApproval.nativeRequestId, '7');
  assert.equal(request.body.payload.nativeCodexApproval.ownerInstanceId, 'owner-1');
  assert.equal(request.body.payload.nativeCodexApproval.responseTransport, 'native-app-server');
  assert.deepEqual(
    request.body.payload.actions.map((action) => action.decisionMode),
    ['yes', 'always', 'cancel']
  );
});

test('resolveCodexNativeDecision prefers explicit nativeDecision from broker response', () => {
  const nativeDecision = resolveCodexNativeDecision({
    responseEvent: {
      payload: {
        approvalId: 'approval-1',
        nativeDecision: 'acceptForSession',
        decision: 'approved',
        decisionMode: 'always'
      }
    },
    availableDecisions: ['accept', 'acceptForSession', 'cancel']
  });

  assert.equal(nativeDecision, 'acceptForSession');
});

test('resolveCodexNativeDecision falls back from decisionMode and generic decision', () => {
  assert.equal(
    resolveCodexNativeDecision({
      responseEvent: {
        payload: {
          approvalId: 'approval-1',
          decision: 'approved',
          decisionMode: 'yes'
        }
      },
      availableDecisions: ['accept', 'cancel']
    }),
    'accept'
  );

  assert.equal(
    resolveCodexNativeDecision({
      responseEvent: {
        payload: {
          approvalId: 'approval-2',
          decision: 'cancelled',
          decisionMode: 'cancel'
        }
      },
      availableDecisions: ['accept', 'cancel']
    }),
    'cancel'
  );
});

test('mirrorCodexNativeApproval posts broker approval and resolves exact native decision', async () => {
  const requests = [];

  const result = await mirrorCodexNativeApproval({
    config: {
      brokerUrl: 'http://127.0.0.1:4318',
      participantId: 'codex-session-019d4489'
    },
    sessionId: '019d4489-1234-5678-9999-bbbbbbbbbbbb',
    ownerInstanceId: 'owner-1',
    serverRequest: {
      id: 3,
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'call_real_1',
        reason: '真实 Codex 审批',
        command: "printf 'real\\n'",
        cwd: '/Users/song/projects/hexdeck',
        availableDecisions: ['accept', 'acceptForSession', 'cancel']
      }
    },
    requestJson: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/intents')) {
        return { event: { eventId: 100 } };
      }
      if (url.includes('/events/replay?after=99&limit=100')) {
        return {
          items: [
            {
              eventId: 101,
              kind: 'respond_approval',
              payload: {
                approvalId: 'codex-native-019d4489-1234-5678-9999-bbbbbbbbbbbb-turn-1-call_real_1',
                decision: 'approved',
                decisionMode: 'always',
                nativeDecision: 'acceptForSession'
              }
            }
          ]
        };
      }
      return { items: [] };
    },
    sleep: async () => {}
  });

  assert.equal(result.approvalId, 'codex-native-019d4489-1234-5678-9999-bbbbbbbbbbbb-turn-1-call_real_1');
  assert.equal(result.responseEventId, 101);
  assert.equal(result.nativeDecision, 'acceptForSession');
  assert.deepEqual(result.serverResponse, { decision: 'acceptForSession' });

  const requestBody = JSON.parse(requests[0].options.body);
  assert.equal(requestBody.kind, 'request_approval');
  assert.equal(requestBody.fromParticipantId, 'codex-session-019d4489');
  assert.equal(requestBody.payload.nativeCodexApproval.nativeRequestId, '3');
  assert.deepEqual(
    requestBody.payload.actions.map((action) => action.nativeDecision),
    ['accept', 'acceptForSession', 'cancel']
  );
});
