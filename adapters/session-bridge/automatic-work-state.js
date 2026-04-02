function isActionableItem(item = {}) {
  if (item?.payload?.delivery?.semantic === 'actionable') {
    return true;
  }

  return item?.kind === 'request_task'
    || item?.kind === 'ask_clarification'
    || item?.kind === 'request_approval';
}

function normalizeContext(context) {
  if (!context || typeof context !== 'object') {
    return null;
  }

  return {
    summary: typeof context.summary === 'string' && context.summary.length ? context.summary : null,
    taskId: typeof context.taskId === 'string' && context.taskId.length ? context.taskId : null,
    threadId: typeof context.threadId === 'string' && context.threadId.length ? context.threadId : null
  };
}

export function pickActiveWorkContext(items = [], fallbackContext = null) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isActionableItem(item) || !item?.taskId || !item?.threadId) {
      continue;
    }

    return normalizeContext({
      summary: item?.payload?.body?.summary || item?.payload?.summary || null,
      taskId: item.taskId,
      threadId: item.threadId
    });
  }

  return normalizeContext(fallbackContext);
}

export function buildAutomaticWorkState(status, context = null) {
  if (status === 'idle') {
    return {
      status: 'idle',
      summary: null,
      taskId: null,
      threadId: null
    };
  }

  const normalizedContext = normalizeContext(context);
  return {
    status,
    summary: normalizedContext?.summary ?? null,
    taskId: normalizedContext?.taskId ?? null,
    threadId: normalizedContext?.threadId ?? null
  };
}
