# Goal 验收依赖 REST 协议

## 资源与权限

Goal 的验收语义、关系范围与独立修订由[Goal 需求](daynight-goals.md)定义。本协议提供 `GET/PATCH /api/v1/projects/{projectId}/tasks/{taskId}/goal-dependencies`，路径必须定位实际 Goal。请求经过现有认证与 Cookie 写入 Origin 校验，成功、错误及方法拒绝沿用现有 envelope 和 no-store 策略。HEAD 使用 GET 的读取语义但不输出正文。普通 Task 端点拒绝关系操作；源项目或 Goal 不可用继续使用既有 404/410 规则。

可读下游即可读取关系，有权编辑下游且可读新增目标才可添加。直接 Project grant 和 Team membership 均参与授权，跨项目要求当前 owner Team 相同。新增目标不存在、不可读、已删除或不是 Goal 时统一返回 `400 goal_dependency_target_unavailable`，不区分目标存在性。

## GET

仅接受可选 `limit`（默认 20，1–50）与 `cursor`，拒绝未知、重复或空查询参数。分页只作用于直接下游；游标绑定调用者、源 Project、Goal 和页大小，每页重新授权。前置最多 30 条，按边 UUID 稳定排序。响应为：

```json
{
  "goalId": "11111111-1111-4111-8111-111111111111",
  "canEdit": true,
  "revision": "7",
  "completionBlocked": true,
  "prerequisites": [
    {"edgeId": "22222222-2222-4222-8222-222222222222", "target": null}
  ],
  "successors": [],
  "nextCursor": null
}
```

可见前置的 target 与 successors 元素均包含 `projectId`、`projectName`、`goalId`、`title`、四态 `status` 和 `kind: internal|external`。不可见前置只保留 `target:null`，编辑者额外获得 opaque edgeId。`canEdit=false` 时省略所有 edgeId 和 revision。不可读下游在分页前过滤，不返回其身份、状态或总数。completionBlocked 依据全部真实前置计算，包含隐藏前置；完成写入仍重新检查。

## PATCH

不接受查询参数。正文必须是 UTF-8 JSON object，严格拒绝未知或重复字段、null、错误类型、重复项、相互冲突的操作和超限集合。ifRevision 必须为规范正 int64 十进制字符串，范围 `1..9223372036854775807`，不接受 JSON number、符号、前导零或溢出。项目、Goal 和 edge 使用 UUID。

edit 至少提交一项添加或移除，每个数组最多 30 项；不能出现 prerequisites：

```json
{"ifRevision":"7","mode":"edit","add":[{"projectId":"33333333-3333-4333-8333-333333333333","goalId":"44444444-4444-4444-8444-444444444444"}],"remove":["22222222-2222-4222-8222-222222222222"]}
```

replace 必须显式提交完整 prerequisites 数组，最多 30 项，不能出现 add/remove。每项选择保留当前下游的 edgeId，或新增 projectId/goalId 二元组，两种臂互斥。空数组明确清空：

```json
{"ifRevision":"7","mode":"replace","prerequisites":[{"edgeId":"22222222-2222-4222-8222-222222222222"}]}
```

保留臂允许引用隐藏边；移除未知、已删除或属于另一 Goal 的 edgeId 使用相同 `400 invalid_input`。新增已有可读关系是空操作，保留其 edgeId。最终前置最多 30 条。成功仅在确认提交后返回 `200` 与 `{goalId,revision,changed}`，revision 仍为精确字符串。版本比较先于空操作；空操作不推进修订，清空保留已持久化修订，删除再新增获得新 edgeId。真实编辑同时推进下游 Goal 的 Task 元数据版本和更新时间；空操作保持两者不变。

## 拒绝与写入结果

入参失败返回 `400 invalid_input`。自依赖拒绝；跨 Team、循环、已完成下游含未完成前置，以及过期修订分别返回 `409 goal_dependency_team_mismatch`、`goal_dependency_cycle`、`goal_dependency_unsatisfied`、`goal_dependency_revision_conflict`。关系修订或 Task 版本耗尽使用现有 `409 version_exhausted`。现有状态和删除入口继续使用 `goal_dependency_done_successor`、`goal_dependency_referenced`，所有失败保持原 Task 与关系。

内部错误、取消、deadline 与已确认未提交结果保留现有错误 envelope。提交确认丢失返回 `503 write_outcome_unknown`。一次请求最多调用一次编辑用例；冲突或结果未知不重放，后续 GET 仅证明当前状态。旧 Goal detail、list、sync、普通 Task 图和 ready DTO 保持原合同；关系只由本独立资源读取。
