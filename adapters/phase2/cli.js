#!/usr/bin/env node
/**
 * Phase 2 CLI Commands
 *
 * 用法:
 *   intent-broker conflict check <file>
 *   intent-broker conflict list
 *   intent-broker task create <title> [--subtask <parent>]
 *   intent-broker task status <taskId>
 *   intent-broker task list [--mine]
 *   intent-broker review request <file> --reviewer <alias>
 *   intent-broker review list
 *   intent-broker history [--days <n>]
 */

import { deriveSessionBridgeConfig } from '../session-bridge/config.js';

const BROKER_URL = process.env.BROKER_URL || 'http://127.0.0.1:4318';

// 动态导入服务
async function loadServices() {
  const [conflict, task, history] = await Promise.all([
    import('../conflict-detector/service.js'),
    import('../task-dispatcher/service.js'),
    import('../collab-history/service.js')
  ]);
  return { conflict, task, history };
}

function usage() {
  console.log(`用法:
  intent-broker conflict check <file>
  intent-broker conflict list
  intent-broker task create <title> [--subtask <parentId>] [--assign <alias>]
  intent-broker task status <taskId>
  intent-broker task list [--mine]
  intent-broker review request <file> --reviewer <alias> [--desc <text>]
  intent-broker review list [--pending]
  intent-broker history [--days <n>]`);
}

async function cmdConflictCheck(file) {
  const { conflict } = await loadServices();
  const result = conflict.checkFileLock(file);

  if (result.locked) {
    console.log(`🔒 文件已锁定: ${file}`);
    console.log(`   持有者：${result.participantId}`);
    console.log(`   获取时间：${new Date(result.acquiredAt).toLocaleString()}`);
    console.log(`   过期时间：${new Date(result.expiresAt).toLocaleString()}`);
  } else {
    console.log(`🔓 文件未锁定：${file}`);
  }
}

async function cmdConflictList() {
  const { conflict } = await loadServices();
  const conflicts = conflict.getActiveConflicts();

  if (conflicts.length === 0) {
    console.log('无活跃冲突');
    return;
  }

  console.log(`活跃冲突 (${conflicts.length}):\n`);
  for (const c of conflicts) {
    console.log(`冲突：${c.file}`);
    console.log(`  参与方：${c.locks.map(l => l.participantId).join(', ')}`);
    console.log(`  时间：${new Date(c.createdAt).toLocaleString()}\n`);
  }
}

async function cmdTaskCreate(title, options) {
  const { task } = await loadServices();
  const config = deriveSessionBridgeConfig({ toolName: 'claude-code' });

  if (options.subtask) {
    // 创建子任务
    const result = task.createSubtask({
      parentTaskId: options.subtask,
      title,
      description: options.desc || '',
      assignedTo: options.assign || config.participantId,
      createdBy: config.participantId
    });

    if (result.success) {
      console.log(`✅ 子任务已创建 (ID: ${result.subtaskId})`);
      console.log(`   分配给：${result.assignedTo}`);
    } else {
      console.error(`❌ ${result.error}`);
    }
  } else {
    // 创建父任务
    const result = task.createParentTask({
      title,
      description: options.desc || '',
      participantId: config.participantId,
      projectName: config.context?.projectName || 'default'
    });

    console.log(`✅ 任务已创建 (ID: ${result.taskId})`);
  }
}

async function cmdTaskStatus(taskId) {
  const { task } = await loadServices();
  const result = task.getTask(taskId);

  if (!result) {
    console.log(`任务不存在：${taskId}`);
    return;
  }

  console.log(`任务：${result.title}`);
  console.log(`状态：${result.status}`);
  console.log(`创建者：${result.createdBy}`);

  if (result.subtasks && result.subtasks.length > 0) {
    console.log(`\n子任务 (${result.subtasks.length}):`);
    for (const s of result.subtasks) {
      console.log(`  [${s.status}] ${s.title} - ${s.assignedTo || '未分配'}`);
    }
  }
}

async function cmdTaskList(options) {
  const { task } = await loadServices();
  const config = deriveSessionBridgeConfig({ toolName: 'claude-code' });

  let tasks;
  if (options.mine) {
    tasks = task.getMyTasks(config.participantId);
    console.log(`我的任务 (${tasks.length}):\n`);
  } else {
    tasks = task.getTask(config.participantId); // 获取所有任务需要修改 API
    console.log(`任务列表:\n`);
  }

  for (const t of tasks) {
    console.log(`[${t.status}] ${t.title} - ${t.taskId}`);
  }
}

async function cmdReviewRequest(file, options) {
  const { task } = await loadServices();
  const config = deriveSessionBridgeConfig({ toolName: 'claude-code' });

  if (!options.reviewer) {
    console.error('请指定审查者：--reviewer <alias>');
    return;
  }

  const result = await task.requestReview({
    file,
    description: options.desc || '',
    reviewerAlias: options.reviewer,
    requesterId: config.participantId,
    projectName: config.context?.projectName || 'default',
    brokerUrl: BROKER_URL
  });

  if (result.success) {
    console.log(`✅ 审查请求已发送 (ID: ${result.reviewId})`);
  } else {
    console.error(`❌ ${result.error}`);
  }
}

async function cmdReviewList(options) {
  const { task } = await loadServices();
  const config = deriveSessionBridgeConfig({ toolName: 'claude-code' });

  const reviews = task.getReviews({
    projectName: config.context?.projectName,
    status: options.pending ? 'pending' : undefined
  });

  if (reviews.length === 0) {
    console.log('无审查请求');
    return;
  }

  console.log(`审查请求 (${reviews.length}):\n`);
  for (const r of reviews) {
    console.log(`[${r.status}] ${r.file} - 请求者：${r.requesterId}`);
    console.log(`   审查者：@${r.reviewerAlias}`);
    console.log(`   描述：${r.description || '无'}\n`);
  }
}

async function cmdHistory(options) {
  const { history } = await loadServices();
  const days = options.days || 7;
  const stats = history.generateStats({ days });

  console.log(`协作统计 (${stats.period}):\n`);
  console.log(`总事件数：${stats.totalEvents}`);
  console.log(`冲突检测：${stats.conflicts.detected}`);
  console.log(`任务创建：${stats.tasks.created}`);
  console.log(`任务完成：${stats.tasks.completed}`);
  console.log(`审查请求：${stats.reviews.requested}`);
  console.log(`审查完成：${stats.reviews.completed}`);

  if (Object.keys(stats.byType).length > 0) {
    console.log('\n按类型:');
    for (const [type, count] of Object.entries(stats.byType)) {
      console.log(`  ${type}: ${count}`);
    }
  }
}

// 导出给主 CLI
export async function runCommand(toolName, args) {
  process.argv = ['', 'intent-broker', ...args];
  const [, , command, ...rest] = args;

  if (!command) {
    usage();
    process.exit(1);
  }

  switch (command) {
    case 'conflict':
      if (rest[0] === 'check' && rest[1]) {
        await cmdConflictCheck(rest[1]);
      } else if (rest[0] === 'list') {
        await cmdConflictList();
      } else {
        usage();
      }
      break;
    case 'task':
      if (rest[0] === 'create' && rest[1]) {
        const options = {};
        for (let i = 2; i < rest.length; i++) {
          if (rest[i] === '--subtask' && rest[i + 1]) { options.subtask = rest[i + 1]; i++; }
          else if (rest[i] === '--assign' && rest[i + 1]) { options.assign = rest[i + 1]; i++; }
          else if (rest[i] === '--desc' && rest[i + 1]) { options.desc = rest[i + 1]; i++; }
        }
        await cmdTaskCreate(rest[1], options);
      } else if (rest[0] === 'status' && rest[1]) {
        await cmdTaskStatus(rest[1]);
      } else if (rest[0] === 'list') {
        await cmdTaskList({ mine: rest.includes('--mine') });
      } else {
        usage();
      }
      break;
    case 'review':
      if (rest[0] === 'request' && rest[1]) {
        const options = {};
        for (let i = 2; i < rest.length; i++) {
          if (rest[i] === '--reviewer' && rest[i + 1]) { options.reviewer = rest[i + 1]; i++; }
          else if (rest[i] === '--desc' && rest[i + 1]) { options.desc = rest[i + 1]; i++; }
        }
        await cmdReviewRequest(rest[1], options);
      } else if (rest[0] === 'list') {
        await cmdReviewList({ pending: rest.includes('--pending') });
      } else {
        usage();
      }
      break;
    case 'history':
      {
        const options = {};
        for (let i = 1; i < rest.length; i++) {
          if (rest[i] === '--days' && rest[i + 1]) { options.days = parseInt(rest[i + 1]); i++; }
        }
        await cmdHistory(options);
      }
      break;
    default:
      usage();
  }
}

// 直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , module, command, ...args] = process.argv;
  if (module && command) {
    runCommand(null, [module, command, ...args]);
  } else {
    usage();
  }
}
