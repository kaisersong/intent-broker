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

function deriveAlias({ toolName, env }) {
  if (env.ALIAS) {
    return env.ALIAS;
  }

  const aliasMap = {
    codex: 'codex',
    'claude-code': 'claude',
    opencode: 'opencode',
    'xiaok-code': 'xiaok'
  };

  return aliasMap[toolName] || toolName.replace(/-code$/, '');
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
    alias: deriveAlias({ toolName, env }),
    roles: ['coder'],
    capabilities: [],
    context: projectName ? { projectName } : {}
  };
}
