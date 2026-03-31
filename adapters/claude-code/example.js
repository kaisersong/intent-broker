/**
 * Example usage of Claude Code adapter
 * Demonstrates how to connect to Intent Broker and handle tasks
 */
import { ClaudeCodeAdapter } from './adapter.js';

const adapter = new ClaudeCodeAdapter({
  brokerUrl: 'http://127.0.0.1:4318',
  participantId: 'claude-code-1',
  roles: ['coder', 'reviewer'],
  capabilities: ['frontend.react', 'backend.node', 'testing']
});

// Handle task requests
adapter.on('request_task', async (event) => {
  console.log('\n📋 New task received:');
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

  console.log('  ✓ Task accepted');

  // Report progress
  await adapter.reportProgress(
    event.taskId,
    event.threadId,
    'in_progress',
    'Starting implementation...'
  );

  // Simulate work
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Request approval before submitting
  const approvalId = `approval-${Date.now()}`;
  await adapter.requestApproval(
    event.taskId,
    event.threadId,
    approvalId,
    'submit_result',
    'Implementation complete. Ready to submit?'
  );

  console.log('  ⏳ Waiting for approval...');
});

// Handle approval responses
adapter.on('respond_approval', async (event) => {
  console.log('\n✅ Approval response received:');
  console.log(`  Decision: ${event.payload.decision}`);

  if (event.payload.decision === 'approved') {
    // Submit result
    await adapter.submitResult(
      event.taskId,
      event.threadId,
      `submission-${Date.now()}`,
      { status: 'completed', message: 'Task completed successfully' }
    );
    console.log('  ✓ Result submitted');
  }
});

// Connect to broker
console.log('🚀 Starting Claude Code adapter...\n');
await adapter.connect();

console.log('\n✓ Adapter ready and listening for tasks');
console.log('  Press Ctrl+C to exit\n');

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down...');
  await adapter.disconnect();
  process.exit(0);
});
