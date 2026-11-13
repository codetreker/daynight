# daynight-server 任务管理需求

状态：Go 服务、事务存储、project/task 用例与 HTTP 接口已实现。当前 Go 检查的
关键代码块配置未满足下文 V8；完整进程证据须按被测源码另行提供。
[服务端验证说明](../../packages/daynight-server/README.md#validate)记录当前入口与限制；
逐次运行结果随对应 PR 与 CI 保存。

本文定义 `daynight-server` 面向本机 CLI 和内部程序的任务管理行为。
[Steps 资源契约](daynight-task-steps.md)定义独立的完整有序集合、单项读取、原子添加、内容与状态更新、位置移动、当前记录删除、共享父版本、编码容量及未知结果核对；常规 Task 投影保持独立。
[Thread 需求](daynight-task-thread.md)定义任务范围内的持久讨论、引用回复、作者快照、Id 分页与独立的 HTTP 读写；它不改变 Task 版本或执行状态。
[技术设计](../design/daynight-server.md)拥有分层、存储和并发机制；
[设计决策](../../.agents/notes/archived/architecture/2026-10-19-daynight-server-task-design.md)
记录取舍和范围。

[预定义属性需求](daynight-task-properties.md)扩展本文的 task 资源，PR 引用的
服务端存储、更新与迁移已实现；[架构](../design/daynight-task-properties.md)拥有机制。
[负责人契约](daynight-task-assignment.md)定义原生 assignedTo 字段、普通 HTTP 写入、任务筛选和项目内人员读取；它与属性及执行领取归属独立。

[附件需求](daynight-task-attachments.md)扩展本文的服务基线：本地内容、PG 元数据、
单文件 API 和固定预览路径已实现，CLI 与 Web 管理界面按其任务继续交付。其
[架构](../design/daynight-task-attachments.md)拥有附件机制。

[鉴权需求](daynight-auth.md)定义已接入主站的 UniAuth 登录、Daynight 会话、个人
访问令牌、CLI 设备授权、Team 生命周期和项目成员授权；[架构](../design/daynight-auth.md)拥有机制。全部 Team、project、task、
图和附件业务请求必须通过认证。项目准入统一计算当前 owner Team role 与独立 direct grant role
的最大值；没有任何有效来源时不可访问。真实 Personal 归属、初始化和存量迁移由
[鉴权要求](daynight-auth.md)拥有。[统一启用决策](../../.agents/notes/archived/architecture/2026-10-22-authentication-activation.md)
记录运行时接线与验收凭据边界；对应源码的验证结论仍以完整运行回执为准。

[执行计时需求](daynight-task-timing.md)的任务起止事实与数据库图时间样本已实现。
本文拥有它们的资源、写入和快照约定；项目提醒阈值及管理员设置接口已实现，实时卡片使用同一资源事实，当前展示由[看板需求](daynight-web.md)拥有。

## 目标与交付范围

| 编号 | 要求 |
|---|---|
| R1 | 使用 Go 实现独立的 `daynight-server`，使用 PostgreSQL 持久化业务数据 |
| R2 | 支持创建、列表查询和读取关联一个 repo 地址的 project |
| R3 | 在 project 内支持创建、列表查询、读取和更新 task |
| R4 | task 支持同 project 内的依赖关系，任何成功提交都必须保持无环 |
| R5 | task 默认 proposed，创建可显式 todo，专用 PUT status 设置五状态；proposed/todo/in_progress/done 可直接设置，cancelled不可恢复，worker 归属保护完成/释放和原成果接续；先精确版本、同状态 +0/实际改变 +1，保留前置/后继与计时规则；metadata PATCH 不接受 status |
| R6 | task 更新必须支持版本冲突检测，字段和依赖必须原子提交 |
| R7 | 通过 HTTP JSON API 提供上述行为，错误和分页具有明确语义 |
| R8 | 采用 `api / service / server / core` 分层，store 位于 `core` 内 |
| R9 | 使用真实 PostgreSQL 验证存储与并发行为，通过 `go-cov` 执行覆盖率门禁 |
| R10 | 服务启动、关闭、请求取消和失败必须可观测，持久化失败不得伪装成成功或空列表 |

服务与现有 TypeScript 客户端的 review 命令 分别管理各自的数据和生命周期。创建 project
只登记 repo 地址，不触发 clone、GitHub 请求、review 启动或 CLI 配置修改。
客户端的[需求](daynight.md)与 review 的[需求](daynight-review.md)分别由其自身文档定义。

受保护 worker 属性、原子认领/更新/释放/强制撤回由[认领架构](../design/daynight-worker-claims.md)拥有。账号级运行快照由[快照需求](daynight-worker-snapshots.md)定义，记录认证客户端最近的机器和任务观测。快照读写不改变 claim 或任务状态；服务端不启动执行进程，前台 Worker 与真实资源恢复仍是独立运行时能力。

## HTTP 输入边界

HTTP/1 请求行与请求头初始读取合计不超过 64 KiB，原始 request-target 和 query 分别不超过 48 KiB 和 24 KiB。通用 encoded cursor 在解码前限制为 16 KiB；更小的专用限制保持有效。普通 REST JSON 最大 1 MiB，MCP body 最大 4 MiB。普通短 body 从读取开始限时 15 秒；实际 body 超限返回 `413 payload_too_large`，目标或 query 超限返回 414，头超限返回 431 或安全关闭，读取超时在可写时返回 `408 request_timeout` 并关闭连接。确定的正文超限或读取超时，即使关闭正文已取消请求 context，仍在连接可写时有界尝试发送对应拒绝；不得恢复业务处理或返回空 200。认证后的 MCP 预读每实例最多 16 个，满额立即返回 429。成功读完 body 后可继续复用连接；拒绝未读 body 不等待客户端发送剩余内容。错误与日志不回显正文或秘密。

附件和归档的读取期限合同分别为 60 秒和 120 秒，由对应入口接入；Session 消息、SSE、WebSocket 和长轮询沿用专用协议及生命周期。[输入与资源额度](daynight-api-input-limits.md)列出领域额度的实施状态。

## Project

Project 包含以下字段：

| 字段 | 语义 |
|---|---|
| `id` | 服务生成的 UUID，不随名称或 repo 改变 |
| `name` | 必填的非空名称 |
| `repoUrl` | 必填的远程 Git repo 地址 |
| `settings` | 必填对象；`version` 为初始 `1` 的正 int64，`executionWarningMinutes` 为初始 `60` 的正 int32 分钟数 |
| `createdAt`、`updatedAt` | UTC 时间，HTTP 使用 RFC 3339 格式 |

一个 project 关联一个 repo，多个 project 可以关联同一 repo。支持 HTTPS URL、
SSH URL 和 SCP 风格 SSH 地址，地址必须包含主机和仓库路径；地址登记不验证实际访问权限。
名称必须是无 NUL 的有效 UTF-8 文本，最多 256 个 Unicode code points 且最多 1024 个
UTF-8 bytes；`repoUrl` 最多 4096 个 UTF-8 bytes。HTTPS 地址不得包含凭据，SSH 地址允许用户名，
但不得包含密码；查询参数和 fragment 不属于仓库地址。无效或超限输入返回 `400 invalid_input`，
不创建项目、管理员授权或仓库绑定；地址中 SSH 用户名不作为业务身份。

MCP 认证客户端可以通过标准 `resources/list` 发现十二篇英文产品手册，并按目录返回的
`daynight://manuals/<主题>.md` URI 读取完整 Markdown。主题按对象与 Project 上下文、Task、
依赖、写入安全、正式材料、Steps、Thread、附件读取、附件写入、Session 读取、Session 消息和
Worker assignment 操作划分，精确目录由服务源码拥有。服务器 instructions 按操作提供简短导航；
每个主题说明必要的额外读取条件，写入需取得完整公共写入安全规则及操作自身的约束。

无 Project 的有效账户也可读取。手册不修改业务数据，不建立 Worker assignment 或操作授权。
文稿随服务版本发布，内部主题引用指向可读取的绝对 URI。更新服务后，客户端重新发现目录并请求
当前正文；`queries-and-lifecycle`、`files-and-references` 和 `operation-boundaries` 的旧混合主题 URI
由独立操作主题取代。未知或移除的 URI 返回协议错误，不返回空正文或替代内容。
公开 GET/HEAD 安装说明保持独立。

MCP `project_resolve` 接受唯一的 `repoUrl`，按仓库身份规则解析调用者可见项目。唯一匹配返回普通 Project，
其 ID 位于 `data.id`；零匹配返回 `not_found`，多个匹配返回 `resource_conflict`，非法或超限地址返回
`invalid_input`。读取及快照完成故障不得伪装成无匹配。该操作不创建项目、改变默认绑定或访问宿主及远端仓库；
后续操作仍检查当前权限。

接口提供创建、列表、单项读取、删除预览、删除及专用设置修改；创建输入的身份、目标 Team 与原子性规则由
[鉴权需求](daynight-auth.md#项目成员与邀请)拥有。创建者在同一事务中成为项目管理员，
列表在数据库中先按当前成员关系过滤，再进行分页。创建后 `repoUrl` 不可通过 task 或设置更新改变。
创建、详情、列表、图内 Project 及成功设置修改均返回完整 settings。已有项目通过迁移获得 `60` 分钟、
版本 `1`，迁移保持原 createdAt/updatedAt。

设置修改只接受观察到的 `version` 和 `executionWarningMinutes`，范围分别为
`1..9223372036854775807`、`1..2147483647`。项目成员可读，只有管理员可写；
取得项目锁后重新检查当前成员和管理员身份，再检查版本，最后才判断同值空操作。
过期同值请求仍冲突，当前版本同值保存返回未改变 Project；实际数值变化只递增一次设置版本并更新 project.updatedAt，
不改 createdAt 或任务时间。降权/移除、版本冲突或存储失败不能留下部分设置更新。

Project 的 owner Team admin 可以读取删除预览并删除项目。预览返回当前项目身份、可见任务、未完成任务和附件计数，以及按 Task UUID 分页的全部 active Worker claim；离线、暂停或等待均不解除阻塞。Worker 连通性只依据该 claim 对应的最后报告时间：不足 120 秒为 online，有更旧报告为 offline，没有报告为 unknown。预览是当前观察，不作为删除条件。`DELETE` 不接受查询参数、正文、预览版本或名称；删除时重新检查当前权限与所有历史 Task 的 claim。存在 active claim 返回 `409 active_worker_claims`，不改数据。

预览返回 `observedAt`、`project:{id,name,repoUrl,ownerTeam}`、`summary:{taskCount,unfinishedTaskCount,attachmentCount}`、`activeClaims` 和可空 `nextCursor`。每条阻塞项包含 `taskId`、`title` 及 `worker:{machineName,platform,phase,paused,connectivity}`。分页默认 50、最大 100，cursor 绑定当前用户和 Project；按条数返回完整阻塞项，不按标题或响应字节缩短页面。

成功返回 `200` 与 `{projectId, deleted:true}`，此后项目及其子资源不再可访问或接受新写入，重复删除返回 404。删除保留任务状态、版本、计时、依赖、成员关系、历史和附件文件；撤回项目 Session 的可操作状态，不声称本机进程已退出。其他项目、账号 Bot 和独立测试 Session 保持可用。Team 非空检查只计活跃项目；旧邀请不可消费，Worker 历史输出不显示已删除项目。事务结果未知返回 `503 write_outcome_unknown`，已确认未提交的内部失败返回 `500 internal_error` 和 `error.details.writeOutcome: "not_committed"`；后续读取不能恢复原操作回执。

## Task 与依赖

Task 包含以下持久化字段：

| 字段 | 语义 |
|---|---|
| `id` | 服务生成的 UUID |
| `projectId` | 所属 project，创建后不可变 |
| `type` | 必填资源类型，公开创建支持 `task` 或 `goal` |
| `parentId` | 必填、可空的父 Goal UUID；普通 Task 创建和更新可指定 |
| `title` | 必填的非空 UTF-8 标题，不含 NUL，最多 1024 bytes |
| `description` | 不含 NUL 的 UTF-8 描述，最多 65536 bytes；省略时为空字符串，允许更新为空字符串 |
| `properties` | 服务端预定义属性的完整 JSON 对象；键可缺失，新任务为 {}，pullRequests 为有序数组，worker 为只读执行归属对象 |
| `status` | `proposed / todo / in_progress / done / cancelled`，创建默认 proposed，可显式指定 todo；普通设置使用状态资源，受控 worker 操作原子改变对应状态 |
| `allowAgents` | 必填布尔自动执行许可，新任务为 `false`；与状态、依赖、实际执行者独立 |
| `requiredPlatform` | 字段必填，值为 `null`、`windows`、`linux` 或 `macos`；`null` 表示不限制，新旧任务默认均不限制 |
| `assignedTo` | 字段必填，值为规范本地用户 UUID 或 null；表示人的责任归属，新旧任务默认未分配 |
| `version` | 从 `1` 开始的正整数，每次实际变更增加一次 |
| `createdAt`、`updatedAt` | UTC 创建和最后实际变更时间 |
| `startedAt`、`completedAt`、`cancelledAt` | 只读UTC执行起止与取消时间，字段必填但允许`null`，未知事实不补造 |
| 内部 `deleted_at` | 可空删除时间；不出现在公共 Task JSON，已标记任务退出正常业务读取 |

完整 REST Task、列表、ready、搜索结果和同步摘要，以及 MCP Task 完整和摘要结果包含必填 `tags` 数组，元素为 `{id,name}`；无关联时为 `[]`。Task 和 Goal 各自拥有独立关联，不继承或汇总父子标签。REST 和 MCP 创建可用 `tagIds` 指定本项目标签的完整 ID 集合，省略或 `[]` 表示无标签；创建与关联原子提交，成功回执包含规范化集合的实际引用。失效、已删除或跨项目 ID、权限及响应容量拒绝均不留下部分创建。REST PATCH 和 MCP `task_update` 可用 `tagIds` 指定完整集合：省略保留，`[]` 清空；无效 ID 整组拒绝。只提交标签时保留执行归属和其他字段；与其他字段组合时按原字段规则在同一事务提交或回滚，实际变更只推进一次版本。标签改名或删除推进关联条目的版本并通过普通增量返回当前引用，不轮换任务缓存 epoch。

完整 Task、列表摘要、搜索、图与同步摘要均输出 `type` 和 `parentId`；最小写回执、仅依赖投影以及工作和 Session 引用保持各自的窄字段集。完整 Goal 读取包含只读 `progress`（total、done、cancelled、unfinished），摘要和同步不含进度。

单个 Task GET 成功返回完整 Task 和必填 `Daynight-Task-Epoch` UUID 响应头；权限、Task 与 epoch 属于同一只读快照，快照失败不能返回成功。未授权响应不暴露 epoch；404、410 和 `no-store` 保持既有语义。

Task 响应还包含 `dependsOn`、`externalDependsOn`、`blockedBy` 和 `ready`：

- `dependsOn` 是全部直接前置 task ID，按 ID 升序返回；完整写入集合最多 30 项，external 不另占额度。
- `externalDependsOn` 是其中标记为外部的 ID 子集，必填、无重复且按 ID 升序；空子集为 `[]`。
- `blockedBy` 是其中尚未处于done或cancelled的task ID，按 ID 升序返回。
- `ready` 当且仅当本 task 为 `todo` 且 `blockedBy` 为空时为 `true`。

这些派生字段来自读取时的一致状态；依赖任务变化不会自动修改本 task 的 `status`、
`version` 或 `updatedAt`。`ready` 描述可开始条件，不代表已调度或归属于某个执行者。
proposed/todo/cancelled 可有未满足前置，in_progress/done 的前置必须全部为done或cancelled；状态与自动执行许可及实际归属独立。

## 状态与更新规则

新建 task 和数据库默认值均为 `proposed`，初始版本为1，执行起止和取消时间均为null，`allowAgents=false`。
创建只接受 `title`、可选 `status`、`description`、`dependsOn`、`externalDependsOn`、`requiredPlatform`、`assignedTo` 和 `properties`；
status 仅接受 proposed/todo，省略为 proposed；禁止提交 allowAgents 和执行时间。内部已确认的多步任务可显式创建 todo。省略描述与依赖分别为空字符串与空集合；省略属性不创建默认属性行。
任务登记不启动执行，也不提供实现、部署、发布、合并或主线 push 的权限。字段、依赖和属性写入额度及完整 Task 成功响应预算见[输入与资源额度](daynight-api-input-limits.md)；确定的容量拒绝在提交前回滚。提交后发送失败不得表述为确定未写入。
创建的 requiredPlatform 省略或 null 表示不限制，三个枚举可设置要求。迁移 013 只为旧行
增加 nullable 平台字段，保留其状态、版本、时间、属性和边；迁移 014 再执行三状态归类。
平台运行时值必填，缺失或非法值拒绝，不从服务端操作系统推断执行平台。


统一状态入口为 `PUT /api/v1/projects/{projectId}/tasks/{taskId}/status`，普通请求为
`{"version":123,"status":"in_progress"}`，done 目标另可提供 claimId 以完成当前 worker 执行。版本为正 int64 JSON 数字，范围
`1..9223372036854775807`；拒绝缺失、null、字符串、非整数、越界、重复或未知字段及 query。
只接受 `proposed`、`todo`、`in_progress`、`done`、`cancelled`。普通成员与管理员均可设置状态；删除旧动作入口，不保留别名。

没有 active 执行归属的普通任务可在 proposed/todo/in_progress/done 之间直接设置状态，无需经过固定阶段，并允许进入不可恢复的cancelled；受控执行另有[认领保护](../design/daynight-worker-claims.md)。项目锁后复核成员及精确版本，先判断版本，再判断同状态。
同状态返回当前完整资源，不写持久化字段、版本、updatedAt 或计时；附带 claimId 的 done 同状态须匹配 completed 记录及其 owner。过期同状态仍返回
`409 version_conflict`。实际改变增加一次版本，原子更新状态、时间与 updatedAt。
实际进入 in_progress/done 要求全部普通和外部直接前置为done或cancelled；done 退回 proposed/todo/in_progress
要求没有 in_progress/done 直接后继，否则 `409 dependency_unsatisfied` 返回稳定排序的阻塞 ID。
拒绝不级联、不修改后继。权限、版本、依赖、取消、存储或事务失败均不留下部分结果。

执行时间由锁后的数据库 statement 时间产生：进入 in_progress 替换起点并清空终点；
退回 proposed/todo 清空两端；in_progress→done 保留可空起点并写终点；proposed/todo→done 的起点为 null，
仅写真实终点。取消写入cancelledAt并保留执行起止；done→cancelled保留原completedAt。普通编辑和同状态保留时间，未知历史起点不从其他时间戳推算。
状态写入保留标题、正文、PR、allowAgents、requiredPlatform、assignedTo、全部依赖及外部分类和附件；claim-bound done 同时把当前 worker 记录置为 completed。active 取消须先解除归属；release 后任务可取消，取消后不能认领或 withdraw 恢复。普通状态写入不能替代 active 释放；release 后普通认领可创建新执行，具体授权由[认领架构](../design/daynight-worker-claims.md)拥有。

历史迁移014将proposed改为todo，只对转换行增加一次 version 并更新 updatedAt，
保留其他字段及历史起止时间。归类迁移不调用运行时 todo 清空规则；其他状态行保持不变。
默认值、转换、三状态 CHECK 与迁移 ledger 同一事务，失败回滚，重复启动不重复转换。
已应用迁移及checksum不变。取消使用新增迁移扩展状态约束并加入nullable cancelledAt，原三态记录与资料保持，cancelledAt为null。新增 proposed 迁移扩展 CHECK 并改变默认值，既有任务状态、版本、时间和资料均保持原样，不反向重建旧提议，也不提供兼容读取映射。

PATCH 可修改 `title`、`description`、`dependsOn`、`externalDependsOn`、`allowAgents`、`requiredPlatform`、`assignedTo` 和预定义属性，
必须带读取到的 version 并至少包含一个可修改字段。status 不属于 PATCH；即使同时提交合法字段也整体拒绝。
省略字段保留，requiredPlatform 与 assignedTo 允许 null 清除，其他字段 null 拒绝；空描述、`dependsOn: []`、`properties.pullRequests: []` 明确清空对应内容。
空 properties 不算修改。proposed/todo 可有未完成前置；in_progress/done 的完整候选仍须全部直接前置为done或cancelled，cancelled本身不要求前置满足。
引用须存在于同 project，不能重复、自身引用或成环。依赖 D/E 独立 PATCH 语义由
[外部依赖需求](daynight-external-dependencies.md)拥有；任何无关写入均保留完整分类。

版本匹配的语义空编辑保持版本和 updatedAt；过期等值仍冲突。依赖顺序不构成变化；
PR 顺序、重复项与字符串参与比较。负责人不变时 allowAgents 省略保留；负责人实际变化时原子关闭许可，组合请求中的 true 也不能覆盖该结果。显式 false 关闭，null/非布尔拒绝；
in_progress 实际切换许可仍返回 `409 invalid_transition`，同值精确版本不写入。
许可、状态、元数据和依赖编辑共用项目锁及版本规则。许可只约束自动发现选择，明确指定的执行可采用任一值。
[worker 要求](daynight-worker.md)中的唯一 claim 仍属独立计划，状态设置不提供归属或停止进程。

requiredPlatform 未提供保留，windows/linux/macos 设置，null 清除；大小写变体、其他字符串与非字符串非 null
输入拒绝。精确版本同值不修改版本或时间，过期同值冲突；in_progress 的实际设置/切换/清除
返回 invalid_transition，整个组合 PATCH 拒绝。平台、许可和状态相互保留，共用项目锁。
普通人工状态设置不按平台或许可筛选；平台不改变 ready、统计或执行授权。共享领域兼容谓词为
null 或与实际平台同值；自动 worker 的事务重验和执行平台记录仍按 worker 要求另行实现。

PR url/title 仅验证字符串与必填结构，保留空白、控制字符、顺序及重复项；不检查远端 PR。
严格拒绝属性未知字段、重复 key、null、缺项或错误类型，详见[属性需求](daynight-task-properties.md)。
HTTP 状态资源及方法拒绝均认证；Cookie 写入要求精确主站 Origin，响应 no-store。
[状态要求](daynight-task-status.md)拥有完整状态契约，[状态架构](../design/daynight-task-status.md)解释并发与迁移机制。

## HTTP API

Team 生命周期的公开字段、成员资格、Personal 禁用操作、精确版本和写入结果由
[鉴权需求](daynight-auth.md#team-生命周期)拥有。普通 Team 创建和真实改名的非空名称必须同时
不超过 256 个 Unicode code points 和 1024 个 UTF-8 bytes；超限返回 `400 invalid_input`，
不改变 Team、成员关系或版本。Personal Team 的名称仍为 `null`。下表保留服务的完整资源入口索引。

| 方法 | 路径 | 结果 |
|---|---|---|
| `POST` | `/api/v1/teams` | 创建普通 Team 与创建者 admin，返回 `201`、Team 和 Location |
| `GET` | `/api/v1/teams` | 按本人成员资格返回 Team 分页 |
| `GET` | `/api/v1/teams/{teamId}` | 返回 Team 与本人真实成员关系，不可见时 `404` |
| `PATCH` | `/api/v1/teams/{teamId}` | 当前 admin 按元数据 version 保存原文名称，返回 `200` 和 Team |
| `DELETE` | `/api/v1/teams/{teamId}` | 当前 admin 核对 version/name，原子删除空普通 Team，返回 `200` 和有限回执 |
| `POST` | `/api/v1/projects` | 创建 project，返回 `201` 和资源 |
| `GET` | `/api/v1/projects` | 返回 project 分页列表 |
| `GET` | `/api/v1/projects/{projectId}` | 返回 project，缺失时 `404` |
| `GET` | `/api/v1/projects/{projectId}/deletion-preview` | owner Team admin 读取有界分页的删除影响与 active claim |
| `DELETE` | `/api/v1/projects/{projectId}` | 当前 owner Team admin 删除无 active claim 的项目，返回提交回执 |
| `PATCH` | `/api/v1/projects/{projectId}/settings` | 管理员按精确设置 version 修改阈值，返回 `200` 和完整 Project |
| `GET` | `/api/v1/projects/{projectId}/tags` | 项目标签目录，支持名称子串、分页和目录 epoch |
| `POST` | `/api/v1/projects/{projectId}/tags` | 创建标签，返回 `201` 和资源 |
| `GET` | `/api/v1/projects/{projectId}/tags/{tagId}` | 按稳定 ID 读取标签及可见 Task/Goal 使用计数 |
| `PATCH` | `/api/v1/projects/{projectId}/tags/{tagId}` | 按原始 version 重命名标签 |
| `DELETE` | `/api/v1/projects/{projectId}/tags/{tagId}` | 按原始 version 和明确确认删除标签及全部关联，返回回执 |
| `POST` | `/api/v1/projects/{projectId}/tags/resolve` | 在当前项目批量解析全部标签 ID，任一失效则拒绝 |
| `POST` | `/api/v1/projects/{projectId}/tasks` | 创建 task，返回 `201` 和资源 |
| `GET` | `/api/v1/projects/{projectId}/tasks` | 返回 task 分页列表，支持显式负责人筛选 |
| `GET` | `/api/v1/projects/{projectId}/task-assignees` | 返回项目成员与保留负责人目录，或限定 userId 解析；始终有 items/unresolvedUserIds |
| `GET` | `/api/v1/projects/{projectId}/tasks/{taskId}` | 返回 task，缺失或不属于该 project 时 `404` |
| `GET` | `/api/v1/projects/{projectId}/tasks/{taskId}/steps` | 返回完整有序 StepsResource，合法空集合为 [] |
| `GET` | `/api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}` | 返回同一父版本及 Task 内指定 Step |
| `POST` | `/api/v1/projects/{projectId}/tasks/{taskId}/steps` | 按父 version 原子追加或 before/after 插入，返回 `201`、规范单项 Location 和完整集合 |
| `PATCH` | `/api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}` | 按父 version 原子更新 title/description，返回 `200` 和完整集合 |
| `PUT` | `/api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}/status` | 按父 version 独立设置四状态，返回 `200` 和完整集合 |
| `PUT` | `/api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}/position` | 按父 version 以 before/after/first/last 移动，返回 `200` 和完整集合 |
| `DELETE` | `/api/v1/projects/{projectId}/tasks/{taskId}/steps/{stepId}` | JSON version 原子删除当前记录并压紧位置，返回 `200` 和完整剩余集合，空为 [] |
| `GET` | `/api/v1/task-properties/schema` | 认证后读取全服务属性定义，无项目参数 |
| `GET` | `/api/v1/projects/{projectId}/tasks/{taskId}/properties` | 返回 projectId、taskId、version 和完整 properties |
| `PUT` | `/api/v1/projects/{projectId}/tasks/{taskId}/properties/{name}` | version/valueText，服务端解析与校验后设置完整单值，返回 200 属性资源 |
| `DELETE` | `/api/v1/projects/{projectId}/tasks/{taskId}/properties/{name}` | version，真正移除可写属性，返回 200 属性资源 |
| `GET` | `/api/v1/projects/{projectId}/task-graph?taskId={taskId}` | 返回同一快照中的 project、完整本链及一层外部前置、相应统计 |
| `GET` | `/api/v1/projects/{projectId}/task-sync` | 返回有界任务摘要 snapshot/delta 及完整轻量 sessions，使用 epoch 与任务最大 updatedAt 水位 |
| `PATCH` | `/api/v1/projects/{projectId}/tasks/{taskId}` | 原子更新元数据和依赖，返回 `200` 和资源 |
| `PUT` | `/api/v1/projects/{projectId}/tasks/{taskId}/status` | `200`，五状态精确版本设置，返回完整任务 |
| `DELETE` | `/api/v1/projects/{projectId}/tasks/{taskId}` | 精确版本软删除；可选 removeDepends=true 原子解除全部传入引用，成功 `204`，保留任务与附件数据 |
| `POST` | `/api/v1/me/workers/{workerId}/report` | 保存账号自己的最新运行快照，返回服务端 observation 与 lastReportedAt |
| `GET` | `/api/v1/me/workers` | 返回最近 72 小时的账号级 Worker 摘要及稳定分页 cursor |
| `GET` | `/api/v1/me/workers/{workerId}` | 返回近期 Worker telemetry 与按当前权限过滤的任务观测 |
| `GET, HEAD` | `/api/v1/me/workers/{workerId}/configuration` | 读取账号拥有的云端目标与逐项应用观测，不受近期窗口限制 |
| `PUT` | `/api/v1/me/workers/{workerId}/configuration` | 精确目标版本保存完整配置，返回当前配置资源 |

项目成员和管理员可管理标签库。标签名称去除 Unicode 首尾空白后为 1–64 个 code point，拒绝控制字符及 U+2028/U+2029；同项目名称按 ASCII 大小写不区分重名，展示拼写保留。目录默认每页 50 条、最多 100 条，按名称键和 ID 排序；cursor 绑定项目、principal、查询、limit 与目录 epoch。目录名称或成员变化后旧 cursor 明确失效。使用计数是读取快照中的提示，不属于标签 version；确认删除包括之后新增的关联。resolve 的编码结果最多 512 KiB，超限拒绝而不截断。

HTTP 创建请求使用 `Content-Type: application/json`，可附带 UTF-8 charset。请求体
最多 1 MiB，必须是单个 JSON 对象；拒绝无效 UTF-8、重复 key、字段名大小写不符、
未知或只读字段、错误类型、必填字段为 `null` 和尾随 JSON。

Steps 读取与写入均不接受 query，包括尾部空 `?`。集合允许 `GET, HEAD, POST`，
单项允许 `GET, HEAD, PATCH, DELETE`，单项 status 和 position 子路径只允许 `PUT`。
添加要求提交前确定的 8 位十六进制 id、title 和正 int64 version；可选 description
省略为空字符串，status 省略为 todo，before 与 after 互斥。内容 PATCH 仅接受
version 及 title/description 至少一个，省略字段保留，空 description 明确清空，
成对内容一次原子保存；状态 PUT 仅接受 version 和必填四状态之一，允许自由转换。
位置 PUT 仅接受 version 和 before/after/position 恰好一个；position 为 first 或 last，
相对锚点必须为同 Task 内另一 Step，自引用拒绝，缺失锚点不回退其他位置。
Step DELETE 仅接受 JSON version，所有状态均可删除；不存在目标为 404，不是 no-op。
当前缺失目标先于版本耗尽，陈旧版本先于目标缺失；存在目标的删除总是实际变化。
所有字段拒绝显式 null，文本拒绝 NUL、无效 UTF-8 和孤立转义 UTF-16 surrogate，
保留合法原值；详情由 [Steps 资源契约](daynight-task-steps.md)拥有。

admin/member 均可修改 Steps，Task 状态、许可和 Worker/Session 归属不增加门槛。
准入先检查父墓碑与精确版本，再解析 Task 内目标；当前同值更新返回完整原集合，
保留全部版本和时间，且不采样时钟、UPDATE 目标或 touch 父任务。当前位置的移动同样
为 no-op，不写位置。最大 int64 版本的 no-op 仍成功，陈旧同值仍冲突；
缺失目标或锚点先于真实变化的版本耗尽拒绝。
真实变化只推进父版本及更新时间一次，内容/状态修改只更新目标内容时间，目标创建
时间、身份和位置以及其他 Step 的字段与时间保持。移动仅修改受影响区间的稠密位置，
保留所有 Step 的内容和创建/更新时间。删除移除目标并压紧后续位置，保留其他 Step
的内容、时间和相对顺序，释放 Task 内 ID；后续同 ID 的 POST 是新建，不是恢复。
Step 删除不删除引用附件、PR 或 Session。所有 Steps 操作保留其他 Task
业务字段、依赖、属性、执行计时及 Worker/Session 归属，不冻结 Session。

完整候选必须在任何数据修改前通过公共 codec 的 64 MiB 检查，编码计入转义、末尾 LF
及父版本的 19 位预留。超限返回 `steps_limit_exceeded`，`error.details` 包含
`encodedBytes`、`maxEncodedBytes`，不提交部分修改；状态值变长也参与相同检查。
事务完成与响应结果独立记录，no-op 的业务 unchanged 与事务 committed 可同时成立。
未知 Commit 或响应丢失按原身份只读核对当前事实，不自动重放写入；当前缺失不能
证明某次未知删除造成了该状态，同 ID 当前存在也不能证明是原记录。

所有成功读取返回 `200`。Project 不存在时，其 task 子路径必须返回 `404`，
不能将空 task 列表作为不存在 project 的结果。授权成员访问自身或父 Goal 已删除的任务的定点资源返回
`410 task_deleted`；非成员与不存在任务仍为 `404 not_found`。列表、ready、图、同步、统计与
新增依赖引用排除有效删除的普通任务；未改变的依赖保留物理状态用于满足性、重开保护和环检测。DELETE 正文 removeDepends 可省略或为严格布尔：省略/false 遇未删除引用者时拒绝且零变更；true 原子清除全部传入普通/外部及已删除源历史引用，并各自增加受影响源版本一次。目标自己的前置与附件保留，active 目标 worker 仍禁止删除。[软删除需求](daynight-task-deletion.md)拥有删除保护、数据保留及完整错误规则。

设置 PATCH 必须同时提供 `version` 与 `executionWarningMinutes`，不接受 query 参数。
缺失、重复、未知、只读、`null`、非整数、非正或超界字段按既有严格 JSON 规则拒绝；
认证、Cookie 写 Origin 和 no-store 同样适用。成员写设置为 `403 forbidden`，非成员或缺失项目为 `404 not_found`。

Task 创建示例：

```json
{
  "title": "Implement task API",
  "description": "Expose project-scoped task endpoints.",
  "dependsOn": ["b4163ef9-93b0-4e79-b56f-4cd88f41e61a"]
}
```

Task 更新示例：

```json
{
  "version": 3,
  "title": "Implement versioned task API"
}
```

列表使用 `limit`、`cursor`。`limit` 默认 `50`，允许 `1..100`；按
`createdAt ASC, id ASC` 稳定排序，返回 `items` 和 `nextCursor`，末页后者为 `null`。
Team、Project 和 Task 列表按请求条数读取一批候选，并以一项 lookahead 判断续页；cursor 指向最后返回项。普通资源直接读取保存的规范数据，不重复结构、字段或容量检查，也不设置领域或共享 MCP 读取响应字节预算。普通 Task 写入成功响应在提交前保留 512 KiB 准入。
Project 列表默认返回当前主体全部可访问项目；单值 `teamId` 选择当前主体所属 Team 的项目，`shared=true` 选择有 direct grant 且没有 owner Team 成员关系的项目。二者互斥；非成员或不存在的 Team 返回 404，读取失败不能视为空列表。资格筛选先于排序和分页，不返回总数。Project cursor 使用独立 kind 与版本 2，绑定规范主体及 all/team/shared 范围和 Team ID；旧 cursor 和不匹配范围被拒绝。cursor 不需要防篡改，也不授予访问权。

Task 列表的 `type` 缺省为 `task`，可显式选择 `goal`；`parentId` 缺省不筛选，`none` 只匹配无 Parent，UUID 匹配直接孩子。Goal 不能选择非空 Parent。筛选在分页前执行，游标绑定类型及 Parent。Task 列表支持单个五状态 status、ready/allowAgents/platformSpecific 布尔值、compatiblePlatform=windows|linux|macos、assignedTo=UUID|me|unassigned，以及可选 UUID workerId。布尔只接受 true/false。compatiblePlatform 匹配 null 或同值要求；platformSpecific=true 仅匹配非 null 平台要求，false 仅匹配 null，与兼容条件组合可分别选择当前平台专用和不限平台任务。各条件省略时不筛选；platformSpecific 仅属于普通列表，不加入搜索或单次 ready 查询合同。assignedTo 的 me 先解析为认证用户 UUID，unassigned 匹配原生 NULL；指定 UUID 不要求其当前仍为成员。workerId 只匹配当前认证用户、指定 worker 的有效 active claim，排除缺失/completed；不隐式增加状态、ready、许可或平台资格条件。全部显式条件 AND 组合，在最终分页和 lookahead 前成立，不能取有界页再丢弃不匹配项。

普通列表及 ready 支持 `tagIds`、`tagMatch` 和 `untagged`。GET 的 `tagIds` 为逗号分隔 UUID 集合，规范化后去重排序；`tagMatch` 为 `all`（默认）或 `any`，分别要求全部或任一关联。`untagged=true` 只匹配无关联条目，不能与非空 ID 集合组合；省略 ID 且不选择无标签时不增加标签条件。全部标签必须在当前 Project 存在；不存在、跨项目或已删除 ID 返回 `400 invalid_tag_filter`。资格与选页在同一读取快照完成，标签条件与现有条件 AND 组合，在排序、分页和 ready 候选限制前执行。Task 与 Goal 只按自身关联匹配，Parent 条件保持。cursor 绑定规范化集合、模式与无标签选择的摘要，改变条件后不能续页；ID 顺序或重复不改变范围。既有 query、request-target 和 cursor 大小限制继续适用，不增加标签数量配额。

仅以 workerId 筛选并成功读完该 runner 全部项目和分页，才得到用于资源对账的完整自有 claim 清单。额外显式条件得到的是子集，不能据其缺席清理其他执行；读取失败或部分页不能视为空清单。
Task 列表 cursor 使用版本3，必需 scope 包含解析后的 all/unassigned/user:UUID 选择；账号级 `/api/v1/me/workers` 保持版本1。me 与同一 UUID 的 scope 相同，其他账号的 me 不得续用；旧版 Task cursor 拒绝并从第一页重读。Cursor 还绑定列表类型、所属 project 和其他规范化筛选；platformSpecific 的省略、true 和 false 是不同范围，不能跨范围续页，排序位置仍为 createdAt、id。指定 workerId 时绑定隐式认证 userId，不能换用户、移除或改变 workerId 续页。格式错误或条件不匹配返回输入错误。重复 query 参数、显式空值和未知参数也作为
输入错误拒绝；`limit` 的默认值仅用于未提供该参数。
单次响应中的 task、依赖和派生字段保持一致；多次翻页不承诺跨请求快照。

项目内 task-assignees 采用单个只读快照验证项目读取权限，并返回最小 userId/name/avatarUrl/hasProjectAccess 条目。无参数为当前成员与未删除任务保留负责人的完整并集；一个或多个 userId 参数为最多100个互异规范UUID的限定解析。两种模式始终返回非null items/unresolvedUserIds，完整目录的未解数组为空；限定结果互斥且精确覆盖请求。无作用域资格的ID只列为未解，不透露全局资料；有原始成员/任务资格但users行缺失是500完整性错误。资料nullable值不合成姓名或邮箱，任何查询/事务错误不返回局部集合。详细输入、资格和隐私规则由[负责人契约](daynight-task-assignment.md#项目内人员资源)拥有。

### 账号级 Worker 快照

Worker 资源归属来自认证 principal，报告不能提供 userId 或权威任务状态。完整结构、Probe 分支、null/空/旧清单、72 小时窗口及任务计数由[快照协议](daynight-worker-snapshots.md)拥有。GET 不续活，详情超窗、未知与他人资源统一为 404。列表按条数分页；列表与详情信任写入入口已校验和规范化的存储数据，不重复结构、字段或容量检查，也不设置领域读取响应字节预算。自然解码和编码错误继续传播。离线和移出近期列表不改变任务执行；读取时的当前项目权限同时约束历史标题、任务行和计数。[云端配置接口](daynight-worker-configuration.md)独立管理目标与应用观测，通过显式报告协议交换。配置读取/保存不续活，也不以 active claim 为接入条件。

### 时间窗口任务摘要

`GET /api/v1/projects/{projectId}/task-sync` 已实现，与任务链图查询并存。唯一可选参数为
`epoch`、`since`；since 必须伴随规范 UUID epoch，并为 UTC `Z` 结尾、0–9 位小数的有效时间。
无 epoch 或 epoch 不同返回完整 snapshot；相同 epoch 返回 delta，带 since 时读取
`updatedAt >= since - overlap`，无 since 时返回全部摘要供空基线使用。所有状态和依赖性质均参与，
无当前请求时间上界、筛选或分页。默认 overlap 为 `10s`，环境配置
`DAYNIGHT_TASK_SYNC_OVERLAP` 必须为正 Go duration。重复尾窗口是正常结果。

Project、缓存 epoch、匹配任务和 observedAt 来自一次只读快照；
同步不复查存储图节点、边或响应字节容量。摘要的业务 version
使用精确十进制字符串，包含 requiredPlatform、明确 nullable 的 assignedTo 与完整 properties，省略 description 及派生 ready/blockedBy。
任务行及批量读取的完整规范属性来自同一快照，缺失属性不补默认值。读取不调用属性 Normalize/Validate/Admit；自然解码、编码、数据库或事务完成故障继续传播，不返回局部成功。
每个成功响应必含非 null 的 `sessions: Record<TaskId, "working" | "notice" | "warning" | "pending">`，没有贡献时为 `{}`。它是全项目未删除且进行中 Task 的可靠当前 Web Session 状态集合，独立于任务窗口；即使 `tasks=[]` 也完整返回。键用 Task ID，不重复执行或 Session 身份，不含完整 Current 数据，不维护 Session 增量。状态、适用范围与失败规则由[任务缓存需求](daynight-task-sync.md#轻量-session-集合与列表读取)拥有。Task、Worker 和持久 Session 来自同一只读快照，live 标量取自共享 Engine 的已提交状态；不推进 Session 生命周期。完整 JSON 含状态 map 一次返回，不新增领域读取字节预算；正常编码错误仍会传播。
纳秒下界向上对齐到 PostgreSQL 微秒精度，避免驱动截断造成边界外记录进入结果。
身份/权限、HEAD、no-store 和错误优先级服从既有合同。完整行为由
[任务缓存需求](daynight-task-sync.md)拥有；Web 已使用持久摘要及本地完整图投影。

### 任务链图查询

`GET /api/v1/projects/{projectId}/task-graph?taskId={taskId}` 提供指定任务所属任务链的
轻量图。`taskId` 为必填且唯一的 UUID query 参数；缺失、空值、重复值、未知参数、
分页或筛选参数及无效编码均返回 `400 invalid_input`。不提供无 taskId 的全项目图模式。
成功、拒绝和读取错误采用 `Cache-Control: no-store`；GET 同时支持 HEAD，其他方法返回
405 与 Allow。授权成员访问不存在或不属于该项目的目标返回 `404 not_found`，已软删除
目标返回 `410 task_deleted`；项目缺失或非成员仍为 `404 not_found`。

先以普通依赖，即 `dependsOn` 排除 `externalDependsOn` 后的关系，按无向连通分量确定
目标所在任务链的全部成员。所有任务状态都参与，分叉、汇合、兄弟分支和孤立任务均保留。
再补充这些成员直接声明的 `externalDependsOn` 所引用的外部前置任务。只补充这一层，
不从补充的外部任务继续展开任何前置或其所属任务链；链外任务对本链的外部引用也不触发展开。

例如本链 B 的 `externalDependsOn = [X]` 会补充 X；链外 Z 的
`externalDependsOn = [B]` 不会补充 Z。若 X 又依赖 Y，返回 X 的任务行和其真实依赖 ID，
但不因该关系补充 Y。每个返回节点保留完整的 `dependsOn`、`externalDependsOn`、
`blockedBy` 与 `ready`；这些字段不因投影边界裁剪或重新解释。因此外部上下文节点可以引用
本次未返回的任务，读取者不能把缺少其任务行解释为不存在该依赖。

响应的 project、所选 tasks、summary 及数据库时间样本 `observedAt` 来自同一只读
`REPEATABLE READ` 快照，不使用分页或状态筛选。summary 统计所有返回节点，包含补充的外部
节点；必须包含total、proposed、todo、inProgress、done、cancelled、ready、blocked八个非负整数，
零值也返回，满足 `total = proposed + todo + inProgress + done + cancelled` 与 `todo = ready + blocked`。
blocked 只计入前置未全部完成的 todo；查询不改变任务状态、版本或时间。

图节点返回 `id`、`titlePreview`、`titleTruncated`、`status`、`dependsOn`、
`externalDependsOn`、`blockedBy`、`ready`、必填布尔 `allowAgents`、必填可空枚举
`requiredPlatform`、明确 nullable 的 `assignedTo`、`createdAt`、`updatedAt` 以及明确可空的 `startedAt`、`completedAt`、`cancelledAt`。
顶层 `observedAt` 是图数据与统计读取后的数据库 UTC RFC 3339 时间样本，不是事务开始时间
或任务更新时间。标题预览最多 160 Unicode code points，截短时标记 titleTruncated；
不返回完整标题、description 或 version。完整任务继续使用既有详情接口。节点按
`(createdAt,id)` 排序，前置及阻塞 ID 数组按 ID 排序；空数组为 `[]`，时间使用 UTC。
`externalDependsOn` 仅保留依赖性质，不减免阻塞或环检测。

查询完整返回本链及一层外部前置的并集，保留这些节点的完整 `dependsOn`，
包含指向投影外任务的引用。不复查保存图的节点或边容量，也不以新的项目累计写入配额代替。
数据库、取消和事务完成失败优先于暂存的缺失或已删除结果，不得被降格为 404 或 410。
节点、依赖、ready 与 summary 必须来自同一次快照，即使读取期间有并发写入。

错误响应统一包含 `error.code`、`error.message`、`error.requestId`，必要时包含
`error.details.taskIds` 中按 ID 排序的阻塞 task ID。HTTP 状态与错误分类如下：

| HTTP 状态 | `error.code` | 场景 |
|---|---|---|
| `400` | `invalid_input` | 格式、字段、分页参数、依赖引用、自身或重复依赖不合法 |
| `401` | `unauthenticated` | 会话或个人访问令牌缺失、失效或已撤销 |
| `403` | `forbidden` | 普通成员执行管理员操作，或 Cookie 会话写请求来源不符合要求 |
| `404` | `not_found` | 路径资源缺失、当前用户不是对应 Team/项目成员或 task 不属于指定 project |
| `405` | `method_not_allowed` | 已知路径使用不支持的方法，并返回 `Allow` |
| `409` | `version_conflict` | 任务元数据、生命周期、Steps、Team 元数据或项目设置的期望版本过期；删除 Team 的名称原文不匹配 |
| `409` | `identity_mismatch` | Team 管理或项目创建输入的 expectedUserId 与实际 principal 不符，领域行和版本零变化 |
| `409` | `personal_team_immutable` | 变更 Personal Team |
| `409` | `team_not_empty` | 删除仍有活跃 Project 的 Team |
| `409` | `active_worker_claims` | 项目仍有 active Worker claim，删除未执行 |
| `409` | `step_id_conflict` | 同一 Task 内添加的 Step ID 已存在；版本检查先于身份与锚点检查 |
| `409` | `steps_limit_exceeded` | Steps 真实变化候选超过完整编码容量，返回 encodedBytes/maxEncodedBytes |
| `409` | `resource_limit_exceeded` | 已知写入响应在提交前无法通过容量准入 |
| `409` | `version_exhausted` | Steps 父 Task 或 Team 真实改名所需版本已达最大正 int64；同值 no-op 仍有效 |
| `409` | `invalid_transition` | in_progress 中禁止实际切换 allowAgents/requiredPlatform/assignedTo，或删除目标仍有 active worker 归属 |
| `409` | `dependency_cycle` | 候选依赖图成环 |
| `409` | `dependency_unsatisfied` | 进入 active/done 或元数据候选违反前置完成规则、done 重开存在 active/done 直接后继，或严格删除存在未删除引用者 |
| `410` | `task_deleted` | 授权成员访问已软删除任务；不表示项目访问撤回 |
| `500` | `internal_error` | 内部、持久化或事务清理操作失败，响应不泄露数据库连接信息或 SQL |
| `503` | `write_outcome_unknown` | 无法确认 Team 管理、项目创建或项目删除的提交结果，不自动重放写入 |

## 运行与范围

服务默认监听 `127.0.0.1`，继续只接受数值 loopback 监听地址；认证对全部业务
请求强制启用。启动必须配置公开 origin、UniAuth 服务地址、App ID、App Secret
和同 origin 的 callback URL，要求见[鉴权需求](daynight-auth.md)，操作配置由
[部署指南](../../deployment/localhost/README.md)拥有。生产公开 origin 使用 HTTPS；
受控 HTTP 测试例外与 UniAuth loopback HTTP 例外分别显式配置，不提供关闭鉴权模式。
`/healthz` 和 `/readyz` 公开可读；后者检查数据库可用性和 Webhook 后台工作故障，不检查用户登录或 UniAuth。
[本地 Docker Compose 部署](../../deployment/localhost/README.md)提供一条命令构建
并启动内嵌任务看板、API 和 PostgreSQL，等待数据库及完整 readiness 转发路径健康后返回。
页面和 API 共用服务 origin，宿主机 HTTP 端口只发布到 `127.0.0.1`，数据库不发布宿主机端口；容器重建和普通停止必须
保留项目与任务，删除持久卷须使用单独的显式命令。
项目、任务及身份/成员状态由 PostgreSQL 持久化，启动失败必须非零退出。
附件扩展将文件内容保存到独立存储，其非原子性边界由附件需求记录。
关闭时停止新请求和 Webhook 领取，在共享期限内排空使用者并释放依赖；无法确认使用者停止时返回错误并保留依赖。

本文的任务管理接口范围不包含自动任务执行、PR 关联、review 调度、跨 project
依赖或 project/task 删除接口。任务链图查询由本文定义，浏览器页面及内嵌交付要求由
[看板需求](daynight-web.md)与[公开入口要求](daynight-landing.md)拥有，包括公开 `/` 推广页、
独立 `/login`、`/projects` 项目列表、账号级 `/workers` 和 `/workers/{workerId}`、公开静态 `/setup` 日常使用引导，以及基础任务路径
和附件路径的独立完整详情 GET/HEAD 深链接。页面只交付既有 index，Worker 观测、完整任务详情、项目图、附件清单与文件读取使用各自已有接口；
页面行为遵守[独立详情要求](daynight-task-inspection.md#独立完整任务详情)，附件路径校验、
未知路径和方法拒绝遵守[附件阅读要求](daynight-task-attachments.md#独立页面完整阅读)。现有分页接口继续
遵循本文的快照边界。后续扩展必须保留现有 task 身份、
状态约束、事务原子性和错误语义。源码构建需要先安装固定的 Node/pnpm workspace
依赖并构建真实页面资源；缺少资源必须构建失败，不能交付占位页面。容器验收使用独立
[dev-ci 部署](../../deployment/dev-ci/README.md)，正常、失败或取消均定向清理本次
资源，日常部署的项目与任务数据保持不变。

## 验收要求

| 编号 | 必须提供的证据 |
|---|---|
| V1 | Project 和 task 的 HTTP 创建、列表、读取、更新可跨服务重启持久化 |
| V2 | 无效引用、跨 project、自身、重复和间接环被拒绝且无部分写入 |
| V3 | 同 project 并发反向依赖最多一个成功，不同 project 的写入可独立推进 |
| V4 | 五态转换与取消不可恢复、当前同状态+0/实际改变+1、过期同状态冲突、PATCH status 拒绝、状态/重开/后继/依赖竞争保持约束 |
| V5 | 并发相同版本更新最多一个实际变更成功；过期版本冲突；无变化更新保持版本 |
| V6 | 分页、筛选、派生字段和错误映射与本文一致，空列表不掩盖读取失败 |
| V7 | 真实 PostgreSQL 测试覆盖事务回滚、迁移失败、并发写入和一致读取；取消和关闭有明确结果 |
| V8 | `go vet`、完整测试和 `go-cov --ci` 通过；race 按[服务端验证策略](../../packages/daynight-server/README.md#race-instrumentation)在本地默认与 main CI 开启、PR CI 关闭；覆盖率总计严格大于 90%、每包至少 85%、每函数至少 80%，保留关键代码块检查 |
| V9 | 覆盖率不足或 PostgreSQL 不可用使 Go 检查失败；[CI 路由](../../README.md#ci-selection)选择的检查必须成功，未选中的检查必须为 `skipped`，main push 保留全量门禁 |
| V10 | 请求日志可按 request ID 关联业务和存储失败，记录错误类别、组件和阶段，敏感值不进入日志 |
| V11 | 自动执行许可覆盖旧行迁移/新行默认、所有 task/graph 资源的布尔字段、创建拒绝与 PATCH 省略/false/null/类型语义、双值筛选与 cursor、精确版本同值与旧值、in_progress 拒绝、同版本状态/许可竞争及时间/PR/依赖保全 |
| V12 | 平台要求覆盖迁移保全、默认null、创建/PATCH省略/设置/清除/非法值、必填nullable资源、四种要求×三查询平台并组合ready/许可、分页前筛选/cursor、精确版本no-op/运行锁/状态竞争及全部字段保全；自动worker事务与实际记录按worker验收 |
| V13 | assignedTo 覆盖历史及软删除行NULL、三套同快照响应的必填nullable键、创建/PATCH四态与规范化、实际变更原子关闭许可、等值/陈旧值/运行锁、访问变化、全部写入保留、真实竞态及回滚；具体契约由负责人需求拥有 |
| V14 | 负责人多页原生筛选和解析后scope、Task cursor2、项目 cursor2 与账号 Worker cursor1、项目人员两种模式的资格/隐私/nullable/完整覆盖、原始引用缺失资料的500、真实快照并发/取消及查询计划样本 |

V1–V14 的服务规则、真实 PostgreSQL、授权、边界、冲突、并发与故障由 Go 模块
验证承担，使用该模块需要的隔离数据库和认证 fixture。独立产品 E2E 以正常授权
身份验证 CLI 与 Web 对同一数据的顺序成功路径，不展开异常或竞争矩阵。受控外部
provider 响应与真实上游登录具有不同证据范围；认证配置、私有夹具元数据和凭据
不得写入公开产物。

覆盖率是验证门禁，不能替代 V2–V7 的行为证据。测试归属及工具版本固定规则由
[设计](../design/daynight-server.md)定义。
