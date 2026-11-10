import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveAskUserQuestionPolicy,
  shouldWaitForAskUserQuestionAnswer
} from '../../adapters/session-bridge/ask-user-question-policy.js';

test('AskUserQuestion policy keeps Claude on wait-for-answer and unstable agents on native/context handling', () => {
  assert.equal(resolveAskUserQuestionPolicy('claude-code'), 'wait-for-answer');
  assert.equal(shouldWaitForAskUserQuestionAnswer('claude-code'), true);

  assert.equal(resolveAskUserQuestionPolicy('xiaok-code'), 'mirror-and-suppress');
  assert.equal(shouldWaitForAskUserQuestionAnswer('xiaok-code'), false);

  assert.equal(resolveAskUserQuestionPolicy('codex'), 'native-or-context-only');
  assert.equal(shouldWaitForAskUserQuestionAnswer('codex'), false);

  assert.equal(resolveAskUserQuestionPolicy('qodercli'), 'native-or-context-only');
  assert.equal(resolveAskUserQuestionPolicy('unknown-agent'), 'native-or-context-only');
});
