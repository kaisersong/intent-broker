/**
 * Example usage of xiaok code adapter
 * Demonstrates how xiaok code connects to Intent Broker and handles tasks
 */
import { XiaokCodeAdapter } from './adapter.js';

const adapter = new XiaokCodeAdapter({
  brokerUrl: 'http://127.0.0.1:4318',
  participantId: 'xiaok-1',
  roles: ['coder', 'designer'],
  capabilities: ['frontend.react', 'ui-design', 'chinese-localization']
});

// Handle task requests
adapter.on('request_task', async (event) => {
  console.log('\n📋 [xiaok] 收到新任务:');
  console.log(`  任务 ID: ${event.taskId}`);
  console.log(`  摘要: ${event.payload.body?.summary || '无摘要'}`);

  // Accept the task
  await adapter.sendIntent({
    intentId: `accept-${Date.now()}`,
    kind: 'accept_task',
    fromParticipantId: adapter.participantId,
    taskId: event.taskId,
    threadId: event.threadId,
    to: { mode: 'broadcast' },
    payload: { assignmentMode: 'solo' }
  });

  console.log('  ✓ xiaok 已接受任务');

  // Report progress
  await adapter.reportProgress(
    event.taskId,
    event.threadId,
    'in_progress',
    'xiaok 正在实现功能...'
  );

  // Simulate xiaok work
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Request approval before submitting
  const approvalId = `approval-${Date.now()}`;
  await adapter.requestApproval(
    event.taskId,
    event.threadId,
    approvalId,
    'submit_result',
    'xiaok 已完成实现，准备提交？'
  );

  console.log('  ⏳ 等待审批...');
});

// Handle approval responses
adapter.on('respond_approval', async (event) => {
  console.log('\n✅ [xiaok] 收到审批响应:');
  console.log(`  决定: ${event.payload.decision}`);

  if (event.payload.decision === 'approved') {
    // Submit result
    await adapter.submitResult(
      event.taskId,
      event.threadId,
      `submission-${Date.now()}`,
      {
        status: 'completed',
        message: 'xiaok 实现完成',
        agent: 'xiaok-code'
      }
    );
    console.log('  ✓ xiaok 已提交结果');
  }
});

// Connect to broker
console.log('🚀 启动 xiaok code adapter...\n');
await adapter.connect();

console.log('\n✓ xiaok adapter 就绪，正在监听任务');
console.log('  按 Ctrl+C 退出\n');

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n🛑 关闭 xiaok...');
  await adapter.disconnect();
  process.exit(0);
});
