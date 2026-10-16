import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreToolUseHook as runXiaokHook } from '../../adapters/xiaok-code-plugin/hooks.js';
import { runPreToolUseHook as runClaudeHook } from '../../adapters/claude-code-plugin/hooks.js';
import { buildClaudeCodePreToolUseOutput } from '../../adapters/claude-code-plugin/format.js';

const adapters = [['xiaok', runXiaokHook], ['claude', runClaudeHook]];
const question = 'Should the HexDeck documentation example be updated?';
const input = {
  session_id: 'synthetic-question-receipt-session',
  cwd: '/workspace/synthetic-project', tool_name: 'AskUserQuestion', tool_use_id: 'synthetic-question-1',
  tool_input: { questions: [{ header: 'Documentation', question,
    options: [{ label: 'Update', description: 'Update the example' }, { label: 'Keep', description: 'Keep the example' }] }] },
};
const base = { env: {}, cwd: '/workspace/synthetic-project',
  resolveSessionCwdFromTranscript: () => undefined, savePendingToolUseContext: () => {} };

for (const [name, run] of adapters) {
  test(`${name}: successful question receipt names no receiving client or assistant identity`, async () => {
    const calls = [];
    const result = await run(input, { ...base, sendAsk: async (...args) => { calls.push(args); } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].prompt, question, 'user-authored product names must be preserved');
    assert.equal(calls[0][1].toParticipantId, 'human.local');
    assert.equal(calls[0][1].options.length, 2);
    assert.match(result.additionalContext, /submitted through Intent Broker/);
    assert.match(result.additionalContext, /Wait for the user's response/);
    assert.match(result.additionalContext, /do not infer a product name or a new assistant identity/);
    assert.doesNotMatch(result.additionalContext, /HexDeck|Xiaok|Claude Code/i);
    if (name === 'xiaok') assert.equal(result.preventContinuation, true);
    else {
      assert.equal(result.permissionDecision, 'deny');
      assert.equal(result.permissionDecisionReason, result.additionalContext);
      const formatted = buildClaudeCodePreToolUseOutput(result);
      assert.doesNotMatch(JSON.stringify(formatted), /HexDeck/);
      assert.equal(formatted.hookSpecificOutput.additionalContext, result.additionalContext);
    }
  });
  test(`${name}: a failed submission does not claim a receiving application or suppress the native fallback`, async () => {
    const result = await run(input, { ...base, sendAsk: async () => { throw new Error('synthetic failure'); } });
    assert.equal(result, null);
  });
  test(`${name}: explicit skip does not submit or emit a delivery receipt`, async () => {
    let calls = 0;
    const result = await run(input, { ...base, env: { INTENT_BROKER_SKIP_APPROVAL_SYNC: '1' }, sendAsk: async () => { calls++; } });
    assert.equal(result, null); assert.equal(calls, 0);
  });
}
