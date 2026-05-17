export const ASK_USER_QUESTION_POLICIES = Object.freeze({
  'claude-code': 'wait-for-answer',
  'xiaok-code': 'mirror-and-suppress',
  codex: 'native-or-context-only',
  qodercli: 'native-or-context-only'
});

export function resolveAskUserQuestionPolicy(agentTool) {
  const key = typeof agentTool === 'string' ? agentTool.trim().toLowerCase() : '';
  return ASK_USER_QUESTION_POLICIES[key] ?? 'native-or-context-only';
}

export function shouldWaitForAskUserQuestionAnswer(agentTool) {
  return resolveAskUserQuestionPolicy(agentTool) === 'wait-for-answer';
}
