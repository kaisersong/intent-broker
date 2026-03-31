import path from 'node:path';

function deriveProjectName({ env, cwd }) {
  if (env.PROJECT_NAME) {
    return env.PROJECT_NAME;
  }

  if (!cwd) {
    return '';
  }

  return path.basename(cwd);
}

export function deriveSessionBridgeConfig({ toolName, env = process.env, cwd = process.cwd() } = {}) {
  const brokerUrl = env.BROKER_URL || 'http://127.0.0.1:4318';
  const explicitParticipantId = env.PARTICIPANT_ID;
  const threadId = env.CODEX_THREAD_ID || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || '';
  const projectName = deriveProjectName({ env, cwd });

  let participantId = explicitParticipantId;
  if (!participantId && threadId) {
    participantId = `${toolName}-session-${threadId.slice(0, 8)}`;
  }
  if (!participantId) {
    participantId = `${toolName}-session`;
  }

  return {
    brokerUrl,
    participantId,
    roles: ['coder'],
    capabilities: [],
    context: projectName ? { projectName } : {}
  };
}
