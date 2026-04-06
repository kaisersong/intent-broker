#!/usr/bin/env node
/**
 * Group Notify CLI
 *
 * 用法:
 *   intent-broker group list [--project <name>]
 *   intent-broker group notify <type> <target> [--reason <text>]
 *   intent-broker group register
 */

import { createGroupManager } from './service.js';
import { deriveSessionBridgeConfig } from '../session-bridge/config.js';

const BROKER_URL = process.env.BROKER_URL || 'http://127.0.0.1:4318';

function usage() {
  console.log(`用法:
  intent-broker group list [--project <name>]
  intent-broker group register
  intent-broker group notify <type> <target> [--reason <text>]
  intent-broker group whoami

类型:
  file-changed   - 文件变更通知
  file-will-delete - 文件将要删除
  file-deleted   - 文件已删除
  review-request - 审查请求
  task-assign    - 任务分配`);
}

async function cmdRegister() {
  const config = deriveSessionBridgeConfig({ toolName: 'claude-code' });
  const groupManager = createGroupManager({ brokerUrl: BROKER_URL });

  // 先注册到 broker 获取完整 participant 信息
  const res = await fetch(`${BROKER_URL}/participants/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      participantId: config.participantId,
      kind: 'agent',
      roles: ['coder'],
      capabilities: ['broker.auto_dispatch'],
      alias: config.alias,
      context: config.context
    })
  });

  const participant = await res.json();
  const groupInfo = await groupManager.registerMember(participant);

  console.log(JSON.stringify({
    ...groupInfo,
    participantId: config.participantId,
    alias: config.alias
  }, null, 2));
}

async function cmdList(projectName) {
  const config = deriveSessionBridgeConfig({ toolName: 'claude-code' });
  const targetProject = projectName || config.context?.projectName || 'default';

  // 从 broker 获取最新成员列表
  const res = await fetch(`${BROKER_URL}/participants?projectName=${encodeURIComponent(targetProject)}`);
  const data = await res.json();
  const participants = data.participants || [];

  console.log(`\nGroup: ${targetProject}`);
  console.log(`Members (${participants.length}):\n`);

  for (const p of participants) {
    console.log(`  - @${p.alias} (${p.participantId})`);
  }
  console.log('');
}

async function cmdNotify(type, target, options) {
  const config = deriveSessionBridgeConfig({ toolName: 'claude-code' });
  const groupManager = createGroupManager({ brokerUrl: BROKER_URL });

  const projectName = config.context?.projectName || 'default';

  const notifications = {
    'file-changed': {
      summary: `文件变更：${target}`,
      metadata: { file: target, reason: options.reason }
    },
    'file-will-delete': {
      summary: `将要删除：${target}`,
      metadata: { file: target, reason: options.reason, action: 'delete' }
    },
    'file-deleted': {
      summary: `已删除：${target}`,
      metadata: { file: target, reason: options.reason }
    },
    'review-request': {
      summary: `请求审查：${target}`,
      metadata: { target, reason: options.reason, action: 'review' }
    },
    'task-assign': {
      summary: `任务分配：${target}`,
      metadata: { task: target, reason: options.reason, action: 'assign' }
    }
  };

  const notification = notifications[type];
  if (!notification) {
    console.error(`未知类型：${type}`);
    usage();
    process.exit(1);
  }

  const result = await groupManager.notifyFileChange(projectName, target, {
    fromParticipantId: config.participantId,
    reason: options.reason,
    brokerUrl: BROKER_URL
  });

  if (result.error) {
    console.log(`⚠️ 通知失败：${result.error}`);
    console.log('已记录到本地日志，网络恢复后重试');
  } else {
    console.log(`✅ 已通知 ${result.sent} 个组成员`);
  }
}

async function cmdWhoami() {
  const config = deriveSessionBridgeConfig({ toolName: 'claude-code' });
  const groupManager = createGroupManager({ brokerUrl: BROKER_URL });

  const groups = groupManager.getMemberGroups(config.participantId);

  console.log(`Participant: ${config.participantId}`);
  console.log(`Alias: ${config.alias}`);
  console.log(`Groups (${groups.length}):\n`);

  for (const g of groups) {
    console.log(`  - ${g.projectName} (${g.memberCount} members)`);
  }
  console.log('');
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (!command) {
    usage();
    process.exit(1);
  }

  switch (command) {
    case 'register':
      await cmdRegister();
      break;
    case 'list':
      await cmdList(args[0]);
      break;
    case 'notify':
      if (args.length < 2) {
        console.error('缺少参数：type 和 target');
        usage();
        process.exit(1);
      }
      {
        const [type, target, ...rest] = args;
        const options = {};
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--reason' && rest[i + 1]) {
            options.reason = rest[i + 1];
            i++;
          }
        }
        await cmdNotify(type, target, options);
      }
      break;
    case 'whoami':
      await cmdWhoami();
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
