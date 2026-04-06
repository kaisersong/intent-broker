/**
 * User Confirm Service
 *
 * 管理用户确认请求的生命周期
 *
 * 流程:
 * 1. Agent 发送确认请求 → 保存到 pending
 * 2. Broker 推送到云之家
 * 3. 用户回复 → 转发给 Agent
 * 4. 超时 → 执行 fallback 策略
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_ROOT = path.join(os.homedir(), '.intent-broker', 'user-confirm');
const PENDING_FILE = path.join(STATE_ROOT, 'pending-confirms.json');
const HISTORY_FILE = path.join(STATE_ROOT, 'confirm-history.json');

const DEFAULT_TIMEOUT_MS = 300000; // 5 分钟
const FALLBACK_ACTIONS = ['wait', 'cancel', 'auto-decide'];

function ensureStateDir() {
  mkdirSync(STATE_ROOT, { recursive: true });
}

function loadPending() {
  try {
    return JSON.parse(readFileSync(PENDING_FILE, 'utf8'));
  } catch {
    return { requests: [] };
  }
}

function savePending(pending) {
  ensureStateDir();
  writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
}

function loadHistory() {
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { history: [] };
  }
}

function saveHistory(history) {
  ensureStateDir();
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function generateRequestId() {
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建确认请求
 */
export async function createConfirmRequest({
  question,
  type = 'confirmation',
  options = null,
  context = {},
  timeout = DEFAULT_TIMEOUT_MS,
  fallback = 'wait',
  fromParticipantId,
  brokerUrl = 'http://127.0.0.1:4318'
}) {
  const requestId = generateRequestId();
  const createdAt = Date.now();
  const timeoutAt = createdAt + timeout;

  const request = {
    requestId,
    fromParticipantId,
    type,
    question,
    options,
    context,
    timeout,
    timeoutAt,
    fallback,
    status: 'pending',
    createdAt,
    response: null,
    respondedAt: null
  };

  // 保存到 pending
  const pending = loadPending();
  pending.requests.push(request);
  savePending(pending);

  // 发送到 broker
  try {
    const res = await fetch(`${brokerUrl}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intentId: `confirm-${requestId}`,
        kind: 'user_confirm_request',
        fromParticipantId,
        taskId: context.taskId || null,
        threadId: context.threadId || null,
        to: { mode: 'broadcast' },
        payload: {
          body: {
            summary: `[确认请求] ${question}`
          },
          metadata: {
            requestId,
            type,
            options,
            context,
            timeout,
            fallback
          },
          delivery: {
            semantic: 'actionable',
            source: 'user-confirm'
          }
        }
      })
    });

    if (!res.ok) {
      throw new Error(`Broker returned ${res.status}`);
    }

    const result = await res.json();

    return {
      success: true,
      requestId,
      eventId: result.eventId,
      deliveredCount: result.deliveredCount,
      status: 'pending'
    };
  } catch (error) {
    // 降级：本地记录，等待 fallback
    console.error(`[User Confirm] Failed to send to broker:`, error.message);
    return {
      success: false,
      requestId,
      error: error.message,
      status: 'pending',
      fallback: 'broker-unavailable'
    };
  }
}

/**
 * 处理用户回复
 */
export async function handleConfirmResponse({
  requestId,
  response,
  comment = null,
  brokerUrl = 'http://127.0.0.1:4318'
}) {
  const pending = loadPending();
  const requestIndex = pending.requests.findIndex(r => r.requestId === requestId);

  if (requestIndex === -1) {
    return {
      success: false,
      error: 'Request not found',
      requestId
    };
  }

  const request = pending.requests[requestIndex];
  request.status = 'completed';
  request.response = response;
  request.comment = comment;
  request.respondedAt = Date.now();

  // 移动到 history
  const history = loadHistory();
  history.history.push(request);
  saveHistory(history);

  // 从 pending 移除
  pending.requests.splice(requestIndex, 1);
  savePending(pending);

  // 通知 agent
  try {
    const res = await fetch(`${brokerUrl}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intentId: `confirm-response-${requestId}`,
        kind: 'user_confirm_response',
        fromParticipantId: 'human.user',
        taskId: request.context.taskId || null,
        threadId: request.context.threadId || null,
        to: { mode: 'participant', participants: [request.fromParticipantId] },
        payload: {
          body: {
            summary: `[确认回复] ${requestId}: ${response}${comment ? ` - ${comment}` : ''}`
          },
          metadata: {
            requestId,
            response,
            comment,
            originalQuestion: request.question
          },
          delivery: {
            semantic: 'actionable',
            source: 'user-confirm'
          }
        }
      })
    });

    return {
      success: true,
      requestId,
      delivered: res.ok
    };
  } catch (error) {
    return {
      success: true, // 回复已记录
      requestId,
      delivered: false,
      error: error.message
    };
  }
}

/**
 * 检查超时请求并执行 fallback
 */
export async function checkTimeouts({ brokerUrl = 'http://127.0.0.1:4318' } = {}) {
  const pending = loadPending();
  const now = Date.now();
  const timedOut = [];

  for (const request of pending.requests) {
    if (request.status === 'pending' && request.timeoutAt < now) {
      request.status = 'timeout';
      request.respondedAt = now;
      timedOut.push(request);

      // 执行 fallback
      if (request.fallback === 'cancel') {
        // 通知 agent 取消
        try {
          await fetch(`${brokerUrl}/intents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              intentId: `confirm-timeout-${request.requestId}`,
              kind: 'user_confirm_timeout',
              fromParticipantId: 'system',
              taskId: request.context.taskId || null,
              threadId: request.context.threadId || null,
              to: { mode: 'participant', participants: [request.fromParticipantId] },
              payload: {
                body: {
                  summary: `[确认超时] ${request.requestId} - 已取消`
                },
                metadata: {
                  requestId: request.requestId,
                  fallback: request.fallback,
                  reason: 'timeout'
                }
              }
            })
          });
        } catch (e) {
          console.error(`[User Confirm] Failed to notify timeout:`, e.message);
        }
      } else if (request.fallback === 'auto-decide') {
        // 使用默认值继续
        try {
          await fetch(`${brokerUrl}/intents`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              intentId: `confirm-timeout-${request.requestId}`,
              kind: 'user_confirm_timeout',
              fromParticipantId: 'system',
              taskId: request.context.taskId || null,
              threadId: request.context.threadId || null,
              to: { mode: 'participant', participants: [request.fromParticipantId] },
              payload: {
                body: {
                  summary: `[确认超时] ${request.requestId} - 使用默认选项继续`
                },
                metadata: {
                  requestId: request.requestId,
                  fallback: request.fallback,
                  reason: 'timeout'
                }
              }
            })
          });
        } catch (e) {
          console.error(`[User Confirm] Failed to notify timeout:`, e.message);
        }
      }
      // fallback === 'wait' 时，继续等待
    }
  }

  // 保存状态
  const history = loadHistory();
  for (const request of timedOut) {
    history.history.push(request);
  }
  saveHistory(history);

  pending.requests = pending.requests.filter(r => !timedOut.includes(r));
  savePending(pending);

  return {
    checked: pending.requests.length + timedOut.length,
    timedOut: timedOut.length,
    requests: timedOut.map(r => ({
      requestId: r.requestId,
      question: r.question,
      fallback: r.fallback
    }))
  };
}

/**
 * 获取请求状态
 */
export function getRequestStatus(requestId) {
  const pending = loadPending();
  const history = loadHistory();

  const pendingRequest = pending.requests.find(r => r.requestId === requestId);
  if (pendingRequest) {
    return {
      requestId,
      status: pendingRequest.status,
      question: pendingRequest.question,
      createdAt: pendingRequest.createdAt,
      timeoutAt: pendingRequest.timeoutAt,
      remaining: Math.max(0, pendingRequest.timeoutAt - Date.now())
    };
  }

  const historyRequest = history.history.find(r => r.requestId === requestId);
  if (historyRequest) {
    return {
      requestId,
      status: historyRequest.status,
      question: historyRequest.question,
      createdAt: historyRequest.createdAt,
      response: historyRequest.response,
      respondedAt: historyRequest.respondedAt
    };
  }

  return null;
}

/**
 * 列出所有待处理的请求
 */
export function listPendingRequests() {
  const pending = loadPending();
  const now = Date.now();

  return pending.requests.map(r => ({
    requestId: r.requestId,
    status: r.timeoutAt < now ? 'timeout' : r.status,
    question: r.question,
    type: r.type,
    fromParticipantId: r.fromParticipantId,
    createdAt: r.createdAt,
    remaining: Math.max(0, r.timeoutAt - now)
  }));
}
