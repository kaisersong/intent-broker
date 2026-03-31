/**
 * Example usage of Codex adapter
 * Demonstrates how Codex connects to Intent Broker and handles tasks
 */
import { CodexAdapter } from './adapter.js';

const adapter = new CodexAdapter({
  brokerUrl: 'http://127.0.0.1:4318',
  participantId: 'codex-1',
  roles: ['coder', 'reviewer', 'architect'],
  capabilities: ['code-review', 'refactoring', 'architecture', 'security-audit']
});

// Handle task requests
adapter.on('request_task', async (event) => {
  console.log('\n📋 [Codex] New task received:');
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

  console.log('  ✓ Task accepted by Codex');

  // Report progress
  await adapter.reportProgress(
    event.taskId,
    event.threadId,
    'in_progress',
    'Codex analyzing code and generating solution...'
  );

  // Simulate Codex work
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Request approval before submitting
  const approvalId = `approval-${Date.now()}`;
  await adapter.requestApproval(
    event.taskId,
    event.threadId,
    approvalId,
    'submit_result',
    'Codex has completed the analysis. Ready to submit?'
  );

  console.log('  ⏳ Waiting for approval...');
});

// Handle approval responses
adapter.on('respond_approval', async (event) => {
  console.log('\n✅ [Codex] Approval response received:');
  console.log(`  Decision: ${event.payload.decision}`);

  if (event.payload.decision === 'approved') {
    // Submit result
    await adapter.submitResult(
      event.taskId,
      event.threadId,
      `submission-${Date.now()}`,
      {
        status: 'completed',
        message: 'Codex analysis complete',
        agent: 'codex'
      }
    );
    console.log('  ✓ Result submitted by Codex');
  }
});

// Connect to broker
console.log('🚀 Starting Codex adapter...\n');
await adapter.connect();

console.log('\n✓ Codex adapter ready and listening for tasks');
console.log('  Press Ctrl+C to exit\n');

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down Codex...');
  await adapter.disconnect();
  process.exit(0);
});
