/**
 * Simple WebSocket client test
 * Usage: node tests/ws-client-test.js
 */
import WebSocket from 'ws';

const participantId = 'test-client';
const ws = new WebSocket(`ws://127.0.0.1:4318/ws?participantId=${participantId}`);

ws.on('open', () => {
  console.log('✓ WebSocket connected');
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  console.log('✓ Received:', JSON.stringify(message, null, 2));
});

ws.on('error', (error) => {
  console.error('✗ WebSocket error:', error.message);
});

ws.on('close', () => {
  console.log('✓ WebSocket closed');
});

// Keep alive for 30 seconds to receive messages
setTimeout(() => {
  console.log('Closing connection...');
  ws.close();
}, 30000);

console.log(`Connecting to ws://127.0.0.1:4318/ws?participantId=${participantId}`);
