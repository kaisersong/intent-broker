/**
 * Group Manager Service
 *
 * 管理 Agent Group 的注册、发现、通知
 *
 * Group 定义：同项目 (projectName) 的 agent 自动成组
 */

const GROUP_TTL_MS = 30000; // 30s 超时
const SWEEP_INTERVAL_MS = 10000; // 10s 清理

export function createGroupManager({ brokerUrl = 'http://127.0.0.1:4318' } = {}) {
  const groups = new Map(); // projectName -> Set<participantId>
  const memberMetadata = new Map(); // participantId -> { alias, status, updatedAt }
  let sweepTimer = null;

  function startSweep() {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [participantId, meta] of memberMetadata.entries()) {
        if (now - meta.updatedAt > GROUP_TTL_MS) {
          // 成员超时，从所有组中移除
          for (const members of groups.values()) {
            members.delete(participantId);
          }
          memberMetadata.delete(participantId);
        }
      }
    }, SWEEP_INTERVAL_MS);
  }

  function stopSweep() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  /**
   * 注册成员到组
   */
  async function registerMember(participant) {
    const { participantId, alias, context } = participant;
    const projectName = context?.projectName || 'default';

    if (!groups.has(projectName)) {
      groups.set(projectName, new Set());
    }

    groups.get(projectName).add(participantId);
    memberMetadata.set(participantId, {
      alias: alias || participantId,
      status: 'online',
      updatedAt: Date.now()
    });

    return {
      groupId: `group-${projectName}`,
      projectName,
      memberCount: groups.get(projectName).size
    };
  }

  /**
   * 获取项目组成员列表
   */
  function getGroupMembers(projectName) {
    const members = groups.get(projectName);
    if (!members || members.size === 0) {
      return [];
    }

    return [...members].map(participantId => ({
      participantId,
      ...memberMetadata.get(participantId)
    }));
  }

  /**
   * 获取成员所在的项目组
   */
  function getMemberGroups(participantId) {
    const result = [];
    for (const [projectName, members] of groups.entries()) {
      if (members.has(participantId)) {
        result.push({
          groupId: `group-${projectName}`,
          projectName,
          memberCount: members.size
        });
      }
    }
    return result;
  }

  /**
   * 通知组成员
   */
  async function notifyGroup(projectName, notification, { fromParticipantId, brokerUrl } = {}) {
    const members = getGroupMembers(projectName);
    const recipients = members
      .filter(m => m.participantId !== fromParticipantId)
      .map(m => m.participantId);

    if (recipients.length === 0) {
      return { sent: 0, recipients: [] };
    }

    // 发送到 broker
    try {
      const res = await fetch(`${brokerUrl}/intents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intentId: `group-notify-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          kind: 'group_notification',
          fromParticipantId: fromParticipantId || 'group-manager',
          taskId: notification.taskId || null,
          threadId: null,
          to: { mode: 'participant', participants: recipients },
          payload: {
            body: { summary: notification.summary },
            metadata: {
              type: notification.type,
              groupName: projectName,
              ...notification.metadata
            },
            delivery: {
              semantic: 'informational',
              source: 'group-notify'
            }
          }
        })
      });

      if (!res.ok) {
        throw new Error(`Broker returned ${res.status}`);
      }

      const result = await res.json();
      return {
        sent: result.deliveredCount || 0,
        recipients,
        eventId: result.eventId
      };
    } catch (error) {
      // 降级：记录日志，不阻塞
      console.error(`[Group Notify] Failed to notify group ${projectName}:`, error.message);
      return {
        sent: 0,
        recipients,
        error: error.message
      };
    }
  }

  /**
   * 文件变更通知快捷方法
   */
  async function notifyFileChange(projectName, file, { fromParticipantId, reason, brokerUrl } = {}) {
    return notifyGroup(projectName, {
      type: 'file_changed',
      taskId: `file-change-${file}`,
      summary: `文件变更：${file}`,
      metadata: {
        file,
        reason,
        timestamp: new Date().toISOString()
      }
    }, { fromParticipantId, brokerUrl });
  }

  return {
    registerMember,
    getGroupMembers,
    getMemberGroups,
    notifyGroup,
    notifyFileChange,
    startSweep,
    stopSweep,
    // 调试用
    _debug: {
      groups: () => new Map(groups),
      members: () => new Map(memberMetadata)
    }
  };
}
