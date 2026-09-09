# Room workspace v1 broker API

根路径 `/rooms/:roomId/workspace`：GET状态，POST下列动作。凭证复用内部
`x-intent-broker-room-token`，Desktop和KSwarm各自独立；无CORS，不下发renderer/模型。

认证能力探测为 `GET /rooms/workspace-protocol`，返回protocols及明确capabilities。
讨论取消为 `POST /rooms/:roomId/discussion/cancel {requestId,expectedRoomRevision?}`，
仅active owner；同事务递增epoch，取消pending wake及全部root/child授权，绝不伪造物理release。

`register-host {startupId}`返回`{host:{hostId,hostIncarnation}}`。后续主机调用传
`x-intent-broker-host-incarnation`。principal由服务配置roomHostPrincipal或安装
Desktop token的域哈希产生，不接受body自报。HTTP user固定user.local；仅可信main
dispatcher能经agent专用动作选择logicalAgentId，服务继续校验成员/claim所有权。

| 动作 | 关键输入 | 输出 |
|---|---|---|
| begin-change | expectedRevision, requestId, payloadDigest | config, nextGeneration |
| commit-binding | expectedRevision, operationId, workspaceId, bindingId, payloadDigest | config |
| activate-binding / activation-failed / cancel-change | expectedRevision, operationId | config |
| publish-instructions | expectedRevision, requestId, publishedText, description?, directoryNotes? | config, instructions |
| grant-read | expectedRevision, requestId, bindingId, generation, contextScope, subjectKind, subjectId, allowedPathsOrVersions | config, grant |
| revoke-read | grantId | grant |
| authorize-read / agent-authorize-read | bindingId, generation, contextScope, relativePath?, versionId?, claimId? | authorized, grant/claimId, requiresProjectAuthorization |
| acquire | logicalAgentId, runId, executorInstanceId, contextScope, capability, parentClaimId?, projectMappingRevision?, taskId?（冻结并由子claim继承） | claim |
| ack | logicalAgentId, claimId, 完整回显, actualCwd, cwdVerified:true | claim |
| heartbeat / releasing / release | claimId, 完整回显；release另需物理证据 | claim |
| cancel / orphan | claimId；active owner | claim |
| takeover | claimId, expectedHostIncarnation, recoveryEvidence | claim |
| recover-claim | claimId；当前可信 Desktop owner、同 installation principal/originHost | 精确 claim 恢复读取，不进入 Room 列表、不授执行权 |
| recover-admission | request（原acquire payload）；当前可信 Desktop owner、同 installation | 精确run/执行器/冻结payload查既有claim，不重新acquire |
| recover-mapping-ticket | projectId, operationId, payloadDigest, expectedProjectRevision | 同installation/userPrincipal历史票据，只读、保留rejected标记 |
| recover-mapping-operation | projectId, operationId | 同installation/userPrincipal精确映射操作，或该操作持久取消收据（state=cancelled），不新增授权；无ticketId不等于可自动签票 |
| claim-wake | logicalAgentId, roomMessageId, claimId 或 discussionOnly:true | 旧wake claimToken |
| ticket / agent-ticket | submissionId, payloadDigest；user另需contextScope/bindingId/generation；agent另需claimId/logicalAgentId | ticket |
| confirm-artifact | expectedRevision, submissionId, versionId, payloadDigest, bindingId, generation；owner only | ticket, config |
| projection | ticketId, payloadDigest, eventKind | event |
| recover-ticket | submissionId, payloadDigest, claimId?, confirmation?；可信main host | 已签发历史ticket，不授新权 |
| confirm-decision | decisionId?, expectedRevision, contextScope, text, sourceMessageIds, revoked? | decision |
| project-fence | expectedRevision, projectId, operationId | mapping, config |
| mapping-ticket | projectId, operationId, expectedProjectRevision, payloadDigest | ticket |
| cancel-mapping | projectId, operationId；未签ticket才可取消 | mapping |
| verify-mapping-ticket / mapping-applied / mapping-rejected | KSwarm token；ticketId, operationId, projectId, payloadDigest；applied另需mappingRevision | ticket / mapping |
| verify-claim | KSwarm token；claimId, projectId, mappingRevision? | claim, config |
| verify-commit-ticket | KSwarm token；ticketId, submissionId, payloadDigest, projectId, claimId | 历史授权ticket |

完整回显：protocolVersion/runId/executorInstanceId/workspaceId/originHostId/
hostIncarnation/bindingId/generation/instructionsRevision；Project另需mappingRevision。
release物理证据为`cleanupOutcome:'released',terminationEvidence:{executorInstanceId,
kind:'process-exit'|'session-disposed'|'resources-disposed',verified:true}`，只由可信main
实际观察构造；actualCwd不存broker。取消、失联或孤儿状态均不构成物理释放。

capability必需contextVersion/resultVersion/releaseVersion为1及canSetCwd/canTrackChildren/
canRelease为true。不支持的adapter不得宣称。discussionOnly只允许room_only，main必须
使用无文件能力讨论runner。history-page/complete沿用`/room-wakes/*`，持久授权检查
claim、epoch、成员和主机代际；complete须在release前。legacy claim对bound room拒绝。

GET包括config、permissions(canManage/canRead/canRegister)、members、room_only claims/grants/decisions及规则快照；
`?instructionsRevision=N`读取历史版本。canRead仅表示当前用户有当前根递归grant。
Project读取的requiresProjectAuthorization要求main另做KSwarm权威校验，断连拒绝。

当前根递归grant：`[{kind:'path',relativePath:'',recursive:true}]`。历史binding只接受
`{kind:'version',versionId}`；main还须核验身份/hash。broker拒绝路径中的点组件/盘符/UNC。

begin-change保留旧generation/activeBindingId，另分配nextGeneration，commit才切换。
取消不复用代际。Room数据库事务和roomSequence统一配置/claim/ticket/成员/归档排序。
最低协议记录不随取消/解绑清除。普通ticket仅artifact.registered/handoff.registered，
确认ticket仅artifact.confirmed；projection只投影安全刷新引用，不接文件正文/manifest。
同ticket/eventKind唯一eventId。Project成果仍归KSwarm。

此模块不持有OS锁/物理进程/文件identity/路径事实，须由main落实；受支持启动器还须
执行最低协议门禁，不能仅据broker API宣称整体workspace ready。
