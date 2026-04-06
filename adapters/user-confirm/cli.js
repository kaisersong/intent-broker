#!/usr/bin/env node
/**
 * User Confirm CLI
 *
 * 用法:
 *   intent-broker confirm ask <question> [options]
 *   intent-broker confirm reply <requestId> <response>
 *   intent-broker confirm status <requestId>
 *   intent-broker confirm list
 *   intent-broker confirm check-timeouts
 */

import {
  createConfirmRequest,
  handleConfirmResponse,
  checkTimeouts,
  getRequestStatus,
  listPendingRequests
} from './service.js';
import { deriveSessionBridgeConfig } from '../session-bridge/config.js';

const BROKER_URL = process.env.BROKER_URL || 'http://127.0.0.1:4318';

function usage() {
  console.log(`用法:
  intent-broker confirm ask <question> [options]
  intent-broker confirm reply <requestId> <response>
  intent-broker confirm status <requestId>
  intent-broker confirm list
  intent-broker confirm check-timeouts

选项:
  --type <type>        确认类型：confirmation, yesno, choice, input
  --options <opts>     选项列表 (choice 类型): "A:选项 A,B:选项 B"
  --timeout <seconds>  超时时间 (秒)，默认 300
  --fallback <action>  超时处理：wait, cancel, auto-decide
  --context <json>     上下文 JSON`);
}

async function cmdAsk(question, options) {
  const config = deriveSessionBridgeConfig({ toolName: 'claude-code' });

  let parsedOptions = null;
  if (options.options) {
    // 解析 "A:选项 A,B:选项 B" 格式
    parsedOptions = options.options.split(',').map(s => {
      const [id, label] = s.split(':');
      return { id: id.trim(), label: (label || id).trim() };
    });
  }

  let context = {};
  if (options.context) {
    try {
      context = JSON.parse(options.context);
    } catch {
      console.error('无效的 context JSON');
      process.exit(1);
    }
  }

  const timeout = options.timeout ? options.timeout * 1000 : undefined;

  const result = await createConfirmRequest({
    question,
    type: options.type || 'confirmation',
    options: parsedOptions,
    context,
    timeout,
    fallback: options.fallback || 'wait',
    fromParticipantId: config.participantId,
    brokerUrl: BROKER_URL
  });

  if (result.success) {
    console.log(`✅ Confirm request sent (requestId: ${result.requestId})`);
    console.log(`等待用户确认...`);
  } else {
    console.log(`⚠️ 发送失败：${result.error}`);
    console.log(`请求已本地保存 (requestId: ${result.requestId})`);
    console.log(`Broker 不可用时使用 fallback 策略：${result.fallback}`);
  }
}

async function cmdReply(requestId, response, comment) {
  const result = await handleConfirmResponse({
    requestId,
    response,
    comment,
    brokerUrl: BROKER_URL
  });

  if (result.success) {
    console.log(`✅ Confirm received: ${response}`);
    if (!result.delivered) {
      console.log(`⚠️ 无法通知 agent: ${result.error}`);
    }
  } else {
    console.error(`❌ ${result.error}`);
    process.exit(1);
  }
}

async function cmdStatus(requestId) {
  const status = getRequestStatus(requestId);

  if (!status) {
    console.log(`请求不存在：${requestId}`);
    return;
  }

  console.log(`Request: ${requestId}`);
  console.log(`状态：${status.status}`);
  console.log(`问题：${status.question}`);

  if (status.status === 'pending') {
    const remaining = Math.floor(status.remaining / 1000);
    console.log(`剩余时间：${remaining}s`);
  } else if (status.status === 'completed') {
    console.log(`回复：${status.response}`);
    console.log(`回复时间：${new Date(status.respondedAt).toLocaleString()}`);
  } else if (status.status === 'timeout') {
    console.log(`回复：${status.response || '无'}`);
  }
}

async function cmdList() {
  const pending = listPendingRequests();

  if (pending.length === 0) {
    console.log('没有待处理的确认请求');
    return;
  }

  console.log(`待处理请求 (${pending.length}):\n`);
  console.log('ID\t\t\t\t状态\t剩余\t问题');
  console.log('─'.repeat(80));

  for (const p of pending) {
    const id = p.requestId.slice(0, 20);
    const status = p.status === 'timeout' ? '⏰' : '⏳';
    const remaining = Math.floor(p.remaining / 1000);
    console.log(`${id}\t${status}\t${remaining}s\t${p.question.slice(0, 30)}`);
  }
}

async function cmdCheckTimeouts() {
  const result = await checkTimeouts({ brokerUrl: BROKER_URL });

  console.log(`检查了 ${result.checked} 个请求`);
  console.log(`超时 ${result.timedOut} 个:`);

  for (const r of result.requests) {
    console.log(`  - ${r.requestId}: ${r.question} (fallback: ${r.fallback})`);
  }
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (!command) {
    usage();
    process.exit(1);
  }

  switch (command) {
    case 'ask': {
      const question = args[0];
      if (!question) {
        console.error('缺少问题');
        usage();
        process.exit(1);
      }
      const options = {};
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--type' && args[i + 1]) {
          options.type = args[i + 1];
          i++;
        } else if (args[i] === '--options' && args[i + 1]) {
          options.options = args[i + 1];
          i++;
        } else if (args[i] === '--timeout' && args[i + 1]) {
          options.timeout = parseInt(args[i + 1]);
          i++;
        } else if (args[i] === '--fallback' && args[i + 1]) {
          options.fallback = args[i + 1];
          i++;
        } else if (args[i] === '--context' && args[i + 1]) {
          options.context = args[i + 1];
          i++;
        }
      }
      await cmdAsk(question, options);
      break;
    }
    case 'reply': {
      const [requestId, response, ...rest] = args;
      const comment = rest.join(' ');
      if (!requestId || !response) {
        console.error('缺少 requestId 或 response');
        usage();
        process.exit(1);
      }
      await cmdReply(requestId, response, comment);
      break;
    }
    case 'status':
      if (!args[0]) {
        console.error('缺少 requestId');
        usage();
        process.exit(1);
      }
      await cmdStatus(args[0]);
      break;
    case 'list':
      await cmdList();
      break;
    case 'check-timeouts':
      await cmdCheckTimeouts();
      break;
    default:
      usage();
      process.exit(1);
  }
}

// 导出给主 CLI 调用
export async function runCommand(toolName, args) {
  // toolName 未使用，保持接口一致
  process.argv = ['', 'intent-broker', ...args];
  await main();
}

// 直接运行时执行
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
