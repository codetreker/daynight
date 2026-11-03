# 任务持久讨论 Thread 需求

## 职责与范围

每个 Task 有一条服务端持久 Thread。具备项目访问权的用户或 Agent 可以显式读取、发言和引用回复；任务尚未开始、原执行环境离线、执行者更换或任务完成不妨碍读写。任务软删除后，消息保留，任务接口拒绝访问。

Task 描述与附件保存有效要求、方案和正式成果；Thread 保存讨论；[Session](task-sessions.md) 保存原生执行内容及操作证据。发言只追加不可变消息，不触发 Agent，不改变 Task 状态、version、时间、属性、依赖或缓存 epoch，不进入 [task-sync](daynight-task-sync.md) 和任务图投影。

本文定义已实现的服务端存储与 HTTP 契约；CLI 文本展示、Web Discussion 和其轮询状态由各自消费者交付。消息编辑/删除、reaction、附件、全局未读、收件箱、定向派发、回执、自动唤醒与通知恢复不属于本契约。正文提及始终是普通文本。

## 消息与作者

消息唯一身份为 `(task_id, message_id)`；数据库通过 `DEFAULT gen_random_uuid()` 自动生成 message_id，INSERT 省略该字段并通过 RETURNING 获取。数据库不增加 message_id 单列唯一约束。相同 UUID 可以存在于不同任务中，回复、分页和内部更新时间均按所选 task 解释。

公开消息包含：

| 字段 | 语义 |
| --- | --- |
| `id` | 数据库生成的 canonical UUID |
| `author.userId` | 发言时认证的本地账号 UUID |
| `author.displayName` | 必填 nullable string，发言时 users.name 的不可变快照 |
| `author.Agent` | 必填 boolean；仅经过有效执行来源验证后为 true |
| `author.execution` | 仅 details=true 且 Agent=true 时出现，包含 claimId、workerId、provider |
| `body` | 完整非空白 UTF-8 正文，保留原始空白，不含 NUL |
| `createdAt` | UTC 时间，固定三位毫秒小数，如 `2026-11-03T10:20:30.000Z` |
| `replyTo` | 可选的同任务消息 UUID，非回复时省略 |

作者名称允许 null，不从 email 补造。账号改名、claim 释放或执行者更换不能改变历史作者、来源、正文和传输大小。有限执行来源不包含原生参数、路径、凭据或任意 worker JSON。

## HTTP 读写

资源前缀为 `/api/v1/projects/{projectId}/tasks/{taskId}/thread/messages`。接口使用既有 PAT/Cookie 认证、Cookie Origin 策略、`Daynight-User-ID` 和 `Cache-Control: no-store`。支持 GET/HEAD/POST；其他已认证方法返回 405，`Allow: GET, HEAD, POST`。

POST 只接受一个 JSON 对象：

```json
{"body":"完整 Markdown 正文","replyTo":"可选消息 UUID","claimId":"可选当前 claim UUID"}
```

body 必填；replyTo 和 claimId 可以省略，显式 null 拒绝。未知/只读字段、重复字段、多个 JSON 值、错误类型、非法原始 UTF-8、错误媒体类型和 query 参数均拒绝。完整请求体沿用 1 MiB 上限。

无 claimId 时 Agent=false，不从当前任务执行者推定作者。提供 claimId 时，必须匹配当前活动执行、TaskInProgress 及认证账号的 worker.UserID；项目管理员也不能冒充他人的执行。成功 POST 在确认 commit 后返回 201 和完整默认消息资源，不提供单消息 GET 或 Location。

GET 的唯一 query 参数为：

| 参数 | 行为 |
| --- | --- |
| `beforeId` | 可选 UUID，返回该消息之前的最近旧页，不含边界 |
| `afterId` | 可选 UUID，返回该消息之后的增量页，不含边界 |
| `count` | 可选整数 1–100，默认 50；不静默 clamp |
| `details` | 可选 true/false，默认 false |
| `fromBeginning` | 内部初始化模式 true/false；true 从最早消息开始 |

beforeId/afterId 互斥。fromBeginning 出现时不能同时提供任一边界。无 Id 的普通读取返回最新页。query 键不能重复、为空或未知；布尔只接受 true/false。调用方不提供时间或复合 token，UUID 接受规范 36 字符格式并归一化大小写。不存在或只属于其他任务的边界返回 message_not_found，不回退最新页。

页面固定包含 `items`、`hasMoreBefore`、`hasMoreAfter`；items 始终从旧到新排列，空页为 `[]` 且两个标记均为 false。非空页的标记表示同一快照内实际返回首项之前/末项之后是否还有消息，不按未返回候选或 head 计算。

## 顺序与容量

数据库 created_at 与输出同为毫秒。每次提交的 `(createdAt,id)` 必须严格大于上一提交位置。取得本任务 head 写锁后才采样实际数据库时钟；同毫秒 UUID 较小或时钟回拨时，保留已生成 UUID，仅准备同一未提交行的时间，等待真实时钟取得可靠前进位置。不能以 last+1ms 伪造时间或重插 UUID。时钟子预算最多 100ms，且服从更短请求/服务期限；预算内无法可靠前进时消息与 head 一起回滚。

单条完整消息的默认和详细 JSON 编码均不得超过 65,536 字节；完整页面不得超过 262,144 字节。使用同一个 codec 的实际 HTML 转义 JSON 字节，无尾随 LF。预算包含作者、Id、replyTo、时间和执行来源，不能只计算 body。超限明确拒绝；正文、名称不截断、不摘要、不静默跳过。count 是最大条数，字节限额可更早截页，每页至少容纳一条合法消息。

服务入口最多 10 秒，覆盖 pool acquire、事务、权限、锁、查询、编码后的取消检查及 commit；更短父 deadline 优先。这不是整个 HTTP handler 的总延迟承诺。rollback 使用独立最多 5 秒的清理 context，释放或丢弃连接后结束生命周期。

读取在同一个只读 Repeatable Read 快照中重验 credential、项目权限和父任务，回查边界时间、选页及查询方向标记。不锁 head。快照授权后发生的撤权/删除不撤回在途已读取内容，新快照须拒绝。写入锁定父任务、credential/member 和 head，在等待及编码完成后再次检查凭据自然过期；拒绝与 head/消息回滚一致。

## 提交结果与错误

一次成功 POST 只追加一条消息。可确认的提交前拒绝/失败回滚；COMMIT 结果不确定时不能报告成功或声称已经回滚。响应丢失也可能发生在提交后。客户端保留草稿，明确显示未知，不自动重复 POST；正文相同不能证明同一提交。参与者可读取正常 Thread 后决定是否明确再次发送，再次发送是新消息。本契约不增加提交身份、提交账本、内容相等判断或提交状态查询。

| 情况 | HTTP / code |
| --- | --- |
| 非法输入、UUID、count、正文、NUL 或请求体超过 1 MiB | 400 invalid_input |
| 完整编码消息超过 64 KiB | 413 payload_too_large |
| credential 无效或过期 | 401 unauthenticated |
| 无项目访问权或执行 owner 不符 | 403 forbidden |
| 授权后的任务不存在 | 404 not_found |
| 边界或 reply 消息不在所选任务 | 404 message_not_found |
| 任务已软删除 | 410 task_deleted |
| claim 不匹配、失效或任务非活动状态 | 409 claim_conflict |
| 时钟子预算内未取得可靠前进位置 | 503 clock_not_advanced |
| COMMIT 结果不确定 | 503 message_outcome_unknown |
| 数据库、rollback 或其他内部失败 | 500 internal_error |

rollback 失败优先于嵌套业务拒绝。普通 Error envelope 保留 requestId，日志保留安全 cause 和阶段，不输出正文、账号名称、凭据、DSN、SQL 或上游原始错误。

## 消费者与验证

消费者保存“已连续读取”的消息 Id，初始最新页建立位置，此后仅完整消费 afterId 页可推进。POST 回执、本地显示的新消息和旧历史合并不能推进位置。初始空 Thread 可用 fromBeginning 连续追赶积压。客户端状态按账号、项目和任务隔离。

真实 PostgreSQL 验证默认 UUID、复合键、同 UUID 跨任务隔离、回复归属、不可变作者、并发首写、权限/删除竞争、锁等待期间自然过期、时钟等待/回拨与回滚。同毫秒超过 100 条和页面字节限额时，双向 Id 分页必须无遗漏/重复。精确 64 KiB/+1、默认/详细资源、转义、.000/.120/.123、空页与标记均有测试。提交已应用但应答丢失的测试注入只能证明该路径分类，不能声称覆盖所有网络故障。

服务端沿用构建、vet、race、go-cov 和未经四舍五入的总 statement coverage 严格大于 90% 的门槛。[设计](../design/daynight-task-thread.md)拥有具体机制；[服务端指南](../../packages/daynight-server/README.md#task-thread-api)提供入口与验证方法。
