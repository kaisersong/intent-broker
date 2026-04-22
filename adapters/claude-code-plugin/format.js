export function buildClaudeCodeHookOutput(hookEventName, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext
    }
  };
}

export function buildClaudeCodePreToolUseOutput(directive) {
  if (!directive) {
    return null;
  }

  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision: directive.permissionDecision,
    permissionDecisionReason: directive.permissionDecisionReason,
    updatedInput: directive.updatedInput,
    additionalContext: directive.additionalContext
  };

  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: Object.fromEntries(
      Object.entries(hookSpecificOutput).filter(([, value]) => value !== undefined)
    )
  };
}
