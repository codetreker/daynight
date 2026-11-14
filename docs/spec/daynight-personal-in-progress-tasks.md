# 账号进行中任务读取

`GET /api/v1/me/in-progress-tasks` 返回当前认证账号可访问的全部项目中，分配给该账号且处于 `in_progress` 的普通 Task。个人、Team 和共享项目均纳入；Goal 仅作为实际 Parent 上下文。任务是否暂停或存在 Session 不影响收录。接口不返回描述、依赖或完整属性。

请求只接受 `limit` 和 `cursor`，各最多一次。`limit` 默认 50，范围 1–100。游标绑定认证账号、读取类型、清单 revision 和完整排序位置；非法输入返回 `400 invalid_input`，清单变化返回 `409 reset_required`。每次读取均重新验证凭据和项目权限。响应包含 `Daynight-User-ID` 和 `Cache-Control: no-store`。

成功响应包括 `observedAt`、`inventoryRevision`、完整的 `totalTaskCount` 和 `totalProjectCount`、`sessionPartial`、非 null 的 `items` 数组和 nullable `nextCursor`。每项包含：

- `project`：`id`、完整 `name`、`ownerTeam`（`id`、`kind`、nullable `name`）、`executionWarningMinutes` 和完整 `matchedTaskCount`。Personal Team 的 name 为 null。
- `task`：`id`、十进制字符串 `version`、完整 `title`、`status`、nullable `startedAt`、`allowAgents`、`paused`、nullable `goal`（实际 Parent 的 `id` 和完整 `title`）及必需的 nullable `worker`。active claim 的 `worker` 仅包含 UUID `workerId` 和 `machine`（UUID `id`、非空合法 Unicode `name`）；没有 active claim 时为 null。名称来自 claim，不依赖 Worker 心跳或 Session 状态，也不包含完整属性、claim、用户、工作树或原生 Session 身份。
- `session`：既有 [Task Session 观测合同](task-session-observation.md) 的完整结构。

按项目名称的 C 排序、所属空间种类及名称、Team ID、项目 ID 排序；组内按 `startedAt` 降序、未知时间最后、Task ID 升序。数量在分页之前统计，项目可跨页；同一 revision 的项目元数据与数量一致。Session 失败保留任务并标记不可观测，`sessionPartial` 仅表示本页观测不完整，不表示清单缺项。凭据失效、取消、存储失败及真实权限变化不能伪装成成功空页。Session 状态和时钟变化不改变 inventory revision。

revision 覆盖匹配项目的名称、归属、设置、完整匹配数量及其全部 Task 历史的版本事实。无关任务或 Goal 更新也可能触发重置；持续变化时不保证完整遍历成功。客户端每个正常同步周期或手动刷新最多尝试一次完整遍历，遇到 409 不紧循环重试，并明确标识旧结果未更新或读取不完整。

Worker 与任务版本来自同一选定快照。来源缺失、身份或版本不一致及来源读取失败拒绝整页，不能作为无 Worker 或 Session partial 返回。遍历、采样及发布前复核发现 claim 引起的版本变化时按 `reset_required` 拒绝；复核后的普通归属变化由定期或手动刷新反映，不保证即时更新。
