# Task Steps 读取契约

状态：持久化结构、完整集合与单项 HTTP 读取已实现。本文拥有当前可用的 Steps 读取行为；Task 的常规读取、列表、图和同步保持各自资源投影。

## 所有权与模型

Steps 是父 Task 拥有的有序记录，保留独立名称、Markdown 说明、通用状态和内容时间。记录独立于 Session、Controller 和 Worker，在服务重启后保持。项目决定其名称、粒度和流程；系统不会生成默认阶段，也不从步骤状态推导 Task 可交付性或 review 结论。

| 字段 | 读取结果 |
|---|---|
| `id` | 恰好 8 位小写十六进制字符串，在一个 Task 内唯一；保留前导零，`00000000` 合法。 |
| `title` | 完整原值，至少包含一个非 Unicode `White_Space` 字符；允许重复名称。 |
| `description` | 完整 Markdown 原值，空说明为 `""`。 |
| `status` | `todo`、`in_progress`、`done` 或 `skipped`。 |
| `createdAt` | UTC RFC 3339 时间，精确到持久化的微秒。 |
| `updatedAt` | UTC RFC 3339 内容或状态更新时间，精确到持久化的微秒。 |

标题和说明必须是无 NUL 的有效 UTF-8；读取不得补造字段、改写空白或跳过损坏行。U+FEFF 是合法标题字符，只有 U+0085 的标题无效。存储位置只由集合数组顺序公开，不是身份或执行时间。四种 Step 状态独立于 Task 的三种整体状态，`done` 不表示业务审查通过。

## 独立 HTTP 资源

以下 `T` 表示 `/api/v1/projects/{projectId}/tasks/{taskId}`。Project 与 Task 使用完整 UUID，Step 输入接受大小写并规范化为小写；完整 UUID、短前缀和展示编号均不能作为 Step ID。

| 方法与路径 | 成功结果 |
|---|---|
| `GET T/steps` | `200`，完整有序 `StepsResource`。 |
| `GET T/steps/{stepId}` | `200`，完整 `StepResource`。 |
| `HEAD` 对应上述路径 | 相同状态、类型及身份回执，不返回正文。 |

两种读取均不接受 query，包括尾部空 `?`；其他方法返回认证后的 `405` 和 `Allow: GET, HEAD`。所有响应使用 `Cache-Control: no-store`，沿用认证、principal 回执及 request ID。

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

## 权限、快照与失败

读取在同一个 `REPEATABLE READ` 快照中检查项目成员关系、父资源存在性与软删除，再读取父版本及目标内容。admin 与 member 具有相同读取能力；Task 的状态、执行许可、Worker 归属及 Session 是否存在不增加门槛。访问只在明确指定的 Project/Task 内解释，同值短 ID 不会触发其他 Task 的查找。

| 情况 | 结果 |
|---|---|
| 未认证 | `401 unauthenticated`。 |
| 无项目成员权限、父资源不存在或 Task 不属于项目 | `404 not_found`。 |
| 已授权父 Task 软删除 | `410 task_deleted`。 |
| 该 Task 内没有目标 Step | `404 not_found`，不意味着父 Task 失效。 |
| 非法 ID 或任何 query | `400 invalid_input`。 |
| 非法存储、非稠密集合、编码超限、数据库或事务清理失败 | `500 internal_error`，不返回局部集合或伪造空态。 |

父版本、完整内容及顺序必须属于一个一致快照。读取不改变父版本、更新时间、执行计时、状态、依赖、属性或执行归属。业务拒绝与事务 cleanup 故障同时出现时，整体按内部故障处理，保留错误链。

## 验证要求

| 编号 | 可观察结果 |
|---|---|
| ST-R1 | 新旧 Task 具有真实空集合；合法种入数据在实际服务进程重启后保持。 |
| ST-R2 | 顺序、Markdown、微秒时间和精确 int64 完整返回，父版本与内容属于同一快照。 |
| ST-R3 | 成员、Task 内 ID、子项缺失和父删除分别执行本文的权限与失败契约。 |
| ST-R4 | 读取保留 Task 全部字段，且不依赖无关属性、执行归属或 Session。 |
| ST-R5 | 实际 HTTP 完整返回恰好达到预留容量的资源，计入转义、换行与版本位宽。 |
| ST-R6 | HEAD、方法与 query 拒绝、非法存储及 cleanup 失败按本文暴露，不伪造空态。 |

## 公开编码容量

完整 `StepsResource` 的容量上限为 **67,108,864 字节（64 MiB）**，计入实际 JSON UTF-8、默认 HTML 转义、封装及末尾换行。父版本始终按最大正 int64 的 19 位预留；因此普通父版本位数增长不会使合法集合不可读。恰好达到预留容量的资源必须完整可读。错误不能通过截断、删减说明或隐藏条目规避。

[服务验证说明](../../packages/daynight-server/README.md#task-steps-read-api)拥有测试与独立压力验证命令；实际产物及运行结果随对应源码和 PR 保存。
