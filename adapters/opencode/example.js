/**
 * Example usage of OpenCode adapter
 * Demonstrates how OpenCode connects to Intent Broker and handles tasks
 */
import { OpenCodeAdapter } from './adapter.js';

const adapter = new OpenCodeAdapter({
  brokerUrl: 'http://127.0.0.1:4318',
  participantId: 'opencode-1',
  roles: ['coder', 'tester'],
  capabilities: ['frontend.vue', 'backend.python', 'testing.pytest']
});

// Handle task requests
adapter.on('request_task', async (event) => {
  console.log('\n📋 [OpenCode] New task received:');
  console.log(`  Task ID: ${event.taskId}`);
  console.log(`  Summary: ${event.payload.body?.summary || 'No summary'}`);

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

  console.log('  ✓ Task accepted by OpenCode');

  // Report progress
  await adapter.reportProgress(
    event.taskId,
    event.threadId,
    'in_progress',
    'OpenCode implementing solution...'
  );

  // Simulate OpenCode work
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Request approval before submitting
  const approvalId = `approval-${Date.now()}`;
  await adapter.requestApproval(
    event.taskId,
    event.threadId,
    approvalId,
    'submit_result',
    'OpenCode implementation complete. Ready to submit?'
  );

  console.log('  ⏳ Waiting for approval...');
});

// Handle approval responses
adapter.on('respond_approval', async (event) => {
  console.log('\n✅ [OpenCode] Approval response received:');
  console.log(`  Decision: ${event.payload.decision}`);

  if (event.payload.decision === 'approved') {
    // Submit result
    await adapter.submitResult(
      event.taskId,
      event.threadId,
      `submission-${Date.now()}`,
      {
        status: 'completed',
        message: 'OpenCode implementation complete',
        agent: 'opencode'
      }
    );
    console.log('  ✓ Result submitted by OpenCode');
  }
});

// Connect to broker
console.log('🚀 Starting OpenCode adapter...\n');
await adapter.connect();

console.log('\n✓ OpenCode adapter ready and listening for tasks');
console.log('  Press Ctrl+C to exit\n');

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down OpenCode...');
  await adapter.disconnect();
  process.exit(0);
});
