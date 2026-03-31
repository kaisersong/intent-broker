#!/usr/bin/env node
/**
 * Multi-agent collaboration demo
 * Demonstrates all four adapters working together
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🚀 Starting multi-agent collaboration demo\n');
console.log('This demo will start all four adapters:');
console.log('  - Claude Code');
console.log('  - Codex');
console.log('  - OpenCode');
console.log('  - xiaok code\n');

const adapters = [
  { name: 'Claude Code', path: join(__dirname, 'claude-code/example.js') },
  { name: 'Codex', path: join(__dirname, 'codex/example.js') },
  { name: 'OpenCode', path: join(__dirname, 'opencode/example.js') },
  { name: 'xiaok code', path: join(__dirname, 'xiaok-code/example.js') }
];

const processes = [];

// Start all adapters
for (const adapter of adapters) {
  console.log(`Starting ${adapter.name}...`);
  const proc = spawn('node', [adapter.path], {
    stdio: 'inherit',
    cwd: __dirname
  });

  proc.on('error', (error) => {
    console.error(`Error starting ${adapter.name}:`, error.message);
  });

  processes.push({ name: adapter.name, proc });
}

console.log('\n✓ All adapters started\n');
console.log('You can now send tasks to any adapter via the Intent Broker API');
console.log('Example:');
console.log('  curl -X POST http://127.0.0.1:4318/intents \\');
console.log('    -H "Content-Type: application/json" \\');
console.log('    -d \'{"intentId":"test","kind":"request_task","fromParticipantId":"human","taskId":"task-1","threadId":"thread-1","to":{"mode":"broadcast"},"payload":{"body":{"summary":"测试任务"}}}\'');
console.log('\nPress Ctrl+C to stop all adapters\n');

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down all adapters...');
  for (const { name, proc } of processes) {
    console.log(`  Stopping ${name}...`);
    proc.kill('SIGINT');
  }
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});
