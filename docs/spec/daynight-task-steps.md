# Task Steps 资源契约

状态：持久化结构、完整集合与单项 HTTP 读取，以及集合添加已实现。本文拥有当前可用的 Steps 行为；Task 的常规读取、列表、图和同步保持各自资源投影。

## 所有权与模型

Steps 是父 Task 拥有的有序记录，保留独立名称、Markdown 说明、通用状态和内容时间。记录独立于 Session、Controller 和 Worker，在服务重启后保持。项目决定其名称、粒度和流程；系统不会生成默认阶段，也不从步骤状态推导 Task 可交付性或 review 结论。

| 字段 | 资源结果 |
|---|---|
| `id` | 恰好 8 位小写十六进制字符串，在一个 Task 内唯一；保留前导零，`00000000` 合法。 |
| `title` | 完整原值，至少包含一个非 Unicode `White_Space` 字符；允许重复名称。 |
| `description` | 完整 Markdown 原值，空说明为 `""`。 |
| `status` | `todo`、`in_progress`、`done` 或 `skipped`。 |
| `createdAt` | UTC RFC 3339 时间，精确到持久化的微秒。 |
| `updatedAt` | UTC RFC 3339 内容或状态更新时间，精确到持久化的微秒。 |

标题和说明必须是无 NUL 的有效 UTF-8，原有空白、换行和 Unicode 字符保持。U+FEFF 是合法标题字符，只有 U+0085 的标题无效。读取不得补造字段、改写空白或跳过损坏行。存储位置只由集合数组顺序公开，不是身份或执行时间。四种 Step 状态独立于 Task 的三种整体状态，`done` 不表示业务审查通过。

## 独立 HTTP 资源

以下 `T` 表示 `/api/v1/projects/{projectId}/tasks/{taskId}`。Project 与 Task 使用完整 UUID，Step 输入接受大小写并规范化为小写；完整 UUID、短前缀和展示编号均不能作为 Step ID。Step 身份与位置锚点只在指定 Task 中解释，不跨 Task 查找同值 ID。

| 方法与路径 | 输入 | 成功结果 |
|---|---|---|
| `GET T/steps` | 无 query。 | `200`，完整有序 `StepsResource`。 |
| `GET T/steps/{stepId}` | 无 query。 | `200`，完整 `StepResource`。 |
| `HEAD` 对应上述路径 | 无 query。 | 相同状态、类型及身份回执，不返回正文。 |
| `POST T/steps` | `version`、`id`、`title`；可选 `description`、`status`、`before` 或 `after`。 | `201`，完整有序 `StepsResource`；`Location` 指向新增项的规范单项路径。 |

所有 Steps 请求均不接受 query，包括尾部空 `?`。集合的其他方法返回认证后的 `405` 和 `Allow: GET, HEAD, POST`；单项的其他方法返回认证后的 `405` 和 `Allow: GET, HEAD`。所有响应使用 `Cache-Control: no-store`，沿用认证、Cookie 写请求的 Origin 检查、principal 回执及 request ID。

完整集合如下，`version` 是父 Task 的正 int64 精确十进制整数，不能转为丢失精度的浮点数：

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "taskId": "00000000-0000-4000-8000-000000000002",
  "version": 9007199254740993,
  "steps": [
    {
      "id": "00abcdef",
      "title": "Review 第 1 轮",
      "description": "## 结果\n需修改的问题保留在说明中。",
      "status": "done",
      "createdAt": "2026-11-03T10:11:12.123456Z",
      "updatedAt": "2026-11-03T11:12:13.654321Z"
    }
  ]
}
```

单项结果具有相同 `projectId`、`taskId` 和 `version`，以 `step` 字段返回一个完整记录。空集合必须为 `steps: []`，不能为 `null`、缺失或读取失败的替代结果。Task 的 show/list/ready/graph/task-sync 不内嵌完整 Steps。

## 添加输入与结果

添加请求只接受一个 UTF-8 JSON 对象，正文最多 1 MiB，`Content-Type` 为 `application/json`，可附带 UTF-8 charset。拒绝未知、重复或只读字段、字段名大小写不符、尾随 JSON、`null`、错误类型、无效 UTF-8、NUL 和孤立的转义 UTF-16 surrogate。有效 surrogate pair、原文 U+FFFD 和表示字面反斜线的 JSON 转义合法。

| 字段 | 添加语义 |
|---|---|
| `version` | 必填，范围为 `1..9223372036854775807` 的精确 JSON 整数；不是字符串、小数或指数表示。 |
| `id` | 必填，提交前已确定的 8 位十六进制身份，取 UUIDv4 第一段。大小写输入统一为小写；服务不替调用者生成或更换 ID。 |
| `title` | 必填，遵守模型中的原值文本规则。 |
| `description` | 省略时为 `""`；显式空字符串合法。 |
| `status` | 省略时为 `todo`；显式值必须是四种状态之一。 |
| `before` | 可选，插入该 Task 内指定 Step 之前。 |
| `after` | 可选，插入该 Task 内指定 Step 之后。 |

`before` 与 `after` 互斥。二者均省略时追加到末尾；锚点缺失明确拒绝，不转为追加或其他位置。相同标题可创建独立项；重复现存 ID 始终为冲突，不覆盖记录，也不视为重复请求成功。

例如请求 `{"version":12,"id":"00ABCDEF","title":"Review 第 2 轮","after":"12345678"}` 返回父版本 `13`、完整新顺序和 `Location: T/steps/00abcdef`。新增项的创建与更新时间相等，采用同一个数据库 UTC 微秒时间；父 Task 的更新时间采用该时间。现存 Step 仅按插入位置平移，全部内容、状态和内容时间保持。添加总是实际变化，不存在成功的无变化添加。

## 权限、快照与原子写入

admin 与 member 具有相同读取和添加能力；Task 的 `todo`、`in_progress`、`done`，自动执行许可关闭、无 Session 或有效 Worker/Session 归属均不增加 Steps 门槛。访问首先检查正常项目成员关系和父资源可见性，再检查父墓碑。Steps 写入不读取 Worker 属性来决定可写性，不改变执行归属，也不冻结 Session。

读取在同一个 `REPEATABLE READ` 快照中检查项目成员关系、父资源存在性与软删除，再读取父版本及目标内容。父版本、完整内容及顺序必须属于一个一致状态；读取不改变父版本、更新时间、执行计时、状态、依赖、属性或执行归属。

添加复用项目写事务，依次完成项目锁、成员准入、窄父任务头锁及墓碑检查，随后比较精确父版本。读取当前集合后，先检查重复 ID，再解析锚点并构造不修改原集合的完整候选。检查版本耗尽、取得数据库 UTC 微秒时间后，使用新父版本和实际时间编码候选；通过容量预检后才平移位置、插入新行及 touch 父任务。位置始终稠密为 `0..n-1`，唯一约束在提交时验证最终顺序。

Task 元数据与 Steps 共享 `Task.version`。成功添加只推进父版本一次，并只改变父 `updatedAt`；标题、说明、整体状态、负责人、平台、许可、属性、依赖、执行起止时间及 Worker/Session 归属保持。相同观察版本的 Steps 与 Task 元数据竞争最多一个实际变更成功；即使修改不同字段，陈旧版本也冲突。拒绝在数据修改前决定；行写入或父 touch 后的故障经确认回滚时，完整集合、排列、父版本和全部时间均零变更。

## 公开编码容量

完整 `StepsResource` 的容量上限为 **67,108,864 字节（64 MiB）**，计入实际 JSON UTF-8、默认 HTML 转义、封装及末尾换行。父版本始终按最大正 int64 的 19 位预留；因此普通父版本位数增长不会使合法集合不可读。恰好达到预留容量的候选必须添加成功，其资源必须完整可读。

候选检查与 HTTP 响应共用一个公共 codec；检查的时间值就是持久化和响应中的时间，编码通过后冻结响应字节。超限返回 `409 steps_limit_exceeded`，`error.details` 包含 `encodedBytes` 与 `maxEncodedBytes`，前者包含版本位宽预留，后者为 `67108864`。容量拒绝发生在任何步骤或父任务数据修改之前。错误不能通过截断、删减说明或隐藏条目规避。

## 失败、提交已知性与核对

语法错误可在事务前拒绝。有效输入在事务内依次检查成员/父资源可见性、父删除、版本、重复 ID、锚点、版本耗尽和候选容量；陈旧版本先于身份与锚点错误，重复 ID 先于缺失锚点。

| 情况 | 结果 |
|---|---|
| 未认证 | `401 unauthenticated`。 |
| Cookie 写请求的 Origin 不符合要求 | `403 forbidden`。 |
| 无项目成员权限、父资源不存在或 Task 不属于项目 | `404 not_found`。 |
| 已授权父 Task 软删除 | `410 task_deleted`。 |
| 该 Task 内没有目标 Step 或位置锚点 | `404 not_found`，不意味着父 Task 失效。 |
| 非法输入、ID 或任何 query | `400 invalid_input`。 |
| 观察的父版本过期 | `409 version_conflict`。 |
| 现存 Step ID 重复 | `409 step_id_conflict`。 |
| 父版本已达最大正 int64 | `409 version_exhausted`。 |
| 添加候选超过完整编码容量 | `409 steps_limit_exceeded`，包含字节 details。 |
| 非法存储、非稠密集合、读取编码超限、数据库、提交或事务清理失败 | `500 internal_error`，不返回局部集合或伪造空态。 |

业务拒绝与事务 cleanup 故障同时出现时，整体按内部故障处理，保留两条错误原因。事务完成事实分别为 `committed`、`not_committed` 或 `unknown`：确认提交成功后，响应失败仍属已提交；明确提交回滚或提交前确认回滚为未提交；未确认的 Commit 错误为未知。失败 Commit 后的 `ErrTxClosed` cleanup 不能证明该操作已回滚，取消或 HTTP 状态也不能代替提交事实。

响应使用独立的 `written`、`failed` 或 `canceled_before_body` 结果，并记录已写字节；写入网络不等于客户端确认收到。未知写入按原 Project、Task、Step ID 只读核对当前集合或单项，不自动重放 POST，不为未知新增换 ID。当前存在、缺失或版本只表达当前事实，不能归因于某次未知操作。

沿用 `X-Request-ID`。恢复 GET 可使用原请求 ID 加 `.r1`、`.r2` 等后缀关联诊断，记录 `read_kind=reconcile`、当前版本及 `found`、`absent` 或 `current_state`。该约定不参与授权、版本、身份或幂等判断。日志由 handler 记录操作、prepare/persist/commit/response 阶段、独立事务/响应结果、安全原因类别和必要 SQLSTATE；固定诊断不输出标题、Markdown、URL、令牌、任意 Fault message 或数据库消息。

## 验证要求

| 编号 | 可观察结果 |
|---|---|
| ST-R1 | 新旧 Task 具有真实空集合；合法数据在实际服务进程重启后保持。 |
| ST-R2 | 顺序、Markdown、微秒时间和精确 int64 完整返回，父版本与内容属于同一快照。 |
| ST-R3 | 成员、Task 内 ID、子项缺失和父删除分别执行本文的权限与失败契约。 |
| ST-R4 | 读取保留 Task 全部字段，且不依赖无关属性、执行归属或 Session。 |
| ST-R5 | 实际 HTTP 完整返回恰好达到预留容量的资源，计入转义、换行与版本位宽。 |
| ST-R6 | HEAD、方法与 query 拒绝、非法存储及 cleanup 失败按本文暴露，不伪造空态。 |
| ST-A1 | 真实服务完成追加、before/after 插入及同名独立项，规范化身份、默认值、201、Location 和完整有序资源正确。 |
| ST-A2 | 严格输入、授权、Origin、错误顺序、版本耗尽和坏存储明确失败且零变更。 |
| ST-A3 | 同版本添加及 Task 元数据竞争最多一次实际变更；成功添加保留父业务字段、其他 Step 时间及 Worker/Session。 |
| ST-A4 | 真实 HTTP 的精确容量成功与超限一字节拒绝成立，并证明拒绝前没有数据写入；容量压力案例独立于日常 CI。 |
| ST-A5 | 行写入和父 touch 后的故障经真实事务确认回滚，完整前后状态相同；cleanup 故障优先于业务拒绝且错误链保持。 |
| ST-A6 | 确认提交、明确回滚、未知 Commit 与提交后丢响应分别保留真实事实；只读核对和日志哨兵验证没有重放或内容泄露。 |

[服务验证说明](../../packages/daynight-server/README.md#task-steps-api)拥有测试与独立压力验证命令；实际产物及运行结果随对应源码和 PR 保存。
