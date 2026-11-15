# 账号进行中任务读取

`GET /api/v1/me/in-progress-tasks` 返回当前认证账号可访问的全部项目中，分配给该账号且处于 `in_progress` 的普通 Task。个人、Team 和共享项目均纳入；Goal 仅作为实际 Parent 上下文。任务是否暂停或存在 Session 不影响收录。接口不返回描述、完整依赖或完整属性。

请求只接受 `limit` 和 `cursor`，各最多一次。`limit` 默认 50，范围 1–100。游标绑定认证账号、读取类型、清单 revision 和完整排序位置；非法输入返回 `400 invalid_input`，清单变化返回 `409 reset_required`。每次读取均重新验证凭据和项目权限。响应包含 `Daynight-User-ID` 和 `Cache-Control: no-store`。

成功响应包括 `observedAt`、`responseTaskAt`、`responseSessionAt`、`inventoryRevision`、完整的 `totalTaskCount` 和 `totalProjectCount`、`sessionPartial`、非 null 的 `items` 数组和 nullable `nextCursor`。三个时间均为有效 UTC 时间：`observedAt` 保留原分页快照水位；`responseTaskAt` 来自 Session 采样后的最终权限与清单复核数据库快照；`responseSessionAt` 在采样和最终复核结束后取自生成 Session `observedAt`／`freshUntil` 的同一 Engine 时钟。两个响应时钟不可互相替代，也不改变游标或 revision。缺失或无效时钟是读取或协议错误。

- `project`：`id`、完整 `name`、`ownerTeam`（`id`、`kind`、nullable `name`）、`executionWarningMinutes` 和完整 `matchedTaskCount`。Personal Team 的 name 为 null。
- `task`：`id`、十进制字符串 `version`、完整 `title`、`status`、有效 UTC `createdAt`、nullable `startedAt`、`allowAgents`、`paused`、nullable `requiredPlatform`、`tags`、`blockedBy`、`ready`、nullable `goal` 和必需的 nullable `worker`。平台为既有合法平台，null 表示不限；`tags` 是当前 Task 的 `{id,name}` 引用数组；`blockedBy` 是实际未结束的前置 Task UUID 数组，即使本任务正在进行也可能非空；`ready` 遵循既有 Task 规则，进行中时为 false。`goal` 是实际 Parent 的 `id` 和完整 `title`，无 Parent 时为 null，不从依赖推断。
- `worker` 为 null 或 `{workerId,state,machine:{id,name}}`：ID 为 UUID，`state` 为 `active` 或 `completed`，机器名非空且为合法 Unicode。active 表示当前认领；completed 表示仍保留的历史机器记录，不代表完整执行历史。release 可清空记录，null 只表示没有保留记录。Worker 离线或 Session 不可用不抹去已确认记录；完成后手动重开的任务不能把历史 Session 当作当前执行的 Session。摘要不包含 claim、用户、工作树或原生 Session 身份。
- `session`：既有 [Task Session 观测合同](task-session-observation.md) 的完整结构。

按项目名称的 C 排序、所属空间种类及名称、Team ID、项目 ID 排序；组内按 `startedAt` 降序、未知时间最后、Task ID 升序。数量在分页之前统计，项目可跨页；同一 revision 的项目元数据与数量一致。Session 失败保留任务并标记不可观测，`sessionPartial` 仅表示本页观测不完整，不表示清单缺项。凭据失效、取消、存储失败及真实权限变化不能伪装成成功空页。Session 状态和时钟变化不改变 inventory revision。

revision 覆盖匹配项目的名称、归属、设置、完整匹配数量及其全部 Task 历史的版本事实。无关任务或 Goal 更新也可能触发重置；持续变化时不保证完整遍历成功。客户端每个正常同步周期或手动刷新最多尝试一次完整遍历，遇到 409 不紧循环重试，并明确标识旧结果未更新或读取不完整。

任务字段、标签、阻塞关系和 Worker 与任务版本来自同一选定快照；标签与依赖按已选页面批量读取。来源缺失、身份、版本或状态不一致及来源读取失败拒绝整页，不能伪造空标签、无阻塞或无 Worker，也不能作为 Session partial 返回。遍历、采样及发布前复核发现标签、前置状态、Worker 或访问变化引起的 revision 变化时按 `reset_required` 拒绝；复核后的变化由定期或手动刷新反映，不保证即时更新。
