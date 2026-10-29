# daynight-server 任务管理需求

状态：Go 服务、事务存储、project/task 用例与 HTTP 接口、覆盖率门槛和完整进程
验收均已实现。[服务端验证说明](../../packages/daynight-server/README.md#built-process-acceptance-and-ci-evidence)
定义验证范围、要求与测试映射和 CI 产物解释；逐次运行结果随对应 PR 与 CI 保存。

本文定义 `daynight-server` 面向本机 CLI 和内部程序的任务管理行为。
[技术设计](../design/daynight-server.md)拥有分层、存储和并发机制；
[设计决策](../../.agents/notes/archived/architecture/2026-10-19-daynight-server-task-design.md)
记录取舍和范围。

[预定义属性需求](daynight-task-properties.md)扩展本文的 task 资源，PR 引用的
服务端存储、更新与迁移已实现；[架构](../design/daynight-task-properties.md)拥有机制。

[附件需求](daynight-task-attachments.md)扩展本文的服务基线：本地内容、PG 元数据、
单文件 API 和固定预览路径已实现，CLI 与 Web 管理界面按其任务继续交付。其
[架构](../design/daynight-task-attachments.md)拥有附件机制。

[鉴权需求](daynight-auth.md)定义已接入主站的 UniAuth 登录、Daynight 会话、个人
访问令牌、CLI 设备授权和项目成员授权；[架构](../design/daynight-auth.md)拥有机制。全部 project、task、
图和附件业务请求必须通过认证，并按项目成员关系授权。已有项目后续手工补齐成员，
零成员项目不可访问。[统一启用决策](../../.agents/notes/implemented/architecture/2026-10-22-authentication-activation.md)
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
| R5 | task 默认 todo，专用 PUT status 设置三状态；普通任务支持九种组合，worker 归属保护完成/释放和原成果接续；先精确版本、同状态 +0/实际改变 +1，保留前置/后继与计时规则；metadata PATCH 不接受 status |
| R6 | task 更新必须支持版本冲突检测，字段和依赖必须原子提交 |
| R7 | 通过 HTTP JSON API 提供上述行为，错误和分页具有明确语义 |
| R8 | 采用 `api / service / server / core` 分层，store 位于 `core` 内 |
| R9 | 使用真实 PostgreSQL 验证存储与并发行为，通过 `go-cov` 执行覆盖率门禁 |
| R10 | 服务启动、关闭、请求取消和失败必须可观测，持久化失败不得伪装成成功或空列表 |

服务与现有 TypeScript 客户端的 review 命令 分别管理各自的数据和生命周期。创建 project
只登记 repo 地址，不触发 clone、GitHub 请求、review 启动或 CLI 配置修改。
客户端的[需求](daynight.md)与 review 的[需求](daynight-review.md)分别由其自身文档定义。

受保护 worker 属性、原子认领/更新/释放/强制撤回和显式人工接续由[认领架构](../design/daynight-worker-claims.md)拥有。账号级运行快照由[快照需求](daynight-worker-snapshots.md)定义，记录认证客户端最近的机器和任务观测。快照读写不改变 claim 或任务状态；服务端不启动执行进程，前台 Worker 与真实资源恢复仍是独立运行时能力。

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
名称必须是无 NUL 的有效 UTF-8 文本。HTTPS 地址不得包含凭据，SSH 地址允许用户名，
但不得包含密码；查询参数和 fragment
不属于仓库地址。无效地址作为输入错误拒绝，地址中 SSH 用户名不作为业务身份。

接口提供创建、列表、单项读取及专用设置修改；创建者在同一事务中成为项目管理员，
列表在数据库中先按当前成员关系过滤，再进行分页。创建后 `repoUrl` 不可通过 task 或设置更新改变。
创建、详情、列表、图内 Project 及成功设置修改均返回完整 settings。已有项目通过迁移获得 `60` 分钟、
版本 `1`，迁移保持原 createdAt/updatedAt。

设置修改只接受观察到的 `version` 和 `executionWarningMinutes`，范围分别为
`1..9223372036854775807`、`1..2147483647`。项目成员可读，只有管理员可写；
取得项目锁后重新检查当前成员和管理员身份，再检查版本，最后才判断同值空操作。
过期同值请求仍冲突，当前版本同值保存返回未改变 Project；实际数值变化只递增一次设置版本并更新 project.updatedAt，
不改 createdAt 或任务时间。降权/移除、版本冲突或存储失败不能留下部分设置更新。

## Task 与依赖

Task 包含以下持久化字段：

| 字段 | 语义 |
|---|---|
| `id` | 服务生成的 UUID |
| `projectId` | 所属 project，创建后不可变 |
| `title` | 必填的非空 UTF-8 标题，不含 NUL |
| `description` | 不含 NUL 的 UTF-8 描述，省略时为空字符串，允许更新为空字符串 |
| `properties` | 必含 pullRequests 有序字符串记录数组与 worker:null/执行归属；PR 默认空数组，worker 为服务端受保护记录 |
| `status` | `todo / in_progress / done`，创建时为 todo；普通设置使用状态资源，受控 worker 操作原子改变对应状态 |
| `allowAgents` | 必填布尔自动执行许可，新任务为 `false`；与状态、依赖、实际执行者独立 |
| `requiredPlatform` | 字段必填，值为 `null`、`windows`、`linux` 或 `macos`；`null` 表示不限制，新旧任务默认均不限制 |
| `version` | 从 `1` 开始的正整数，每次实际变更增加一次 |
| `createdAt`、`updatedAt` | UTC 创建和最后实际变更时间 |
| `startedAt`、`completedAt` | 只读 UTC 执行起止时间，字段必填但允许 `null`，未知事实不补造 |
| 内部 `deleted_at` | 可空删除时间；不出现在公共 Task JSON，已标记任务退出正常业务读取 |

Task 响应还包含 `dependsOn`、`externalDependsOn`、`blockedBy` 和 `ready`：

- `dependsOn` 是全部直接前置 task ID，按 ID 升序返回。
- `externalDependsOn` 是其中标记为外部的 ID 子集，必填、无重复且按 ID 升序；空子集为 `[]`。
- `blockedBy` 是其中尚未处于 `done` 的 task ID，按 ID 升序返回。
- `ready` 当且仅当本 task 为 `todo` 且 `blockedBy` 为空时为 `true`。

这些派生字段来自读取时的一致状态；依赖任务变化不会自动修改本 task 的 `status`、
`version` 或 `updatedAt`。`ready` 描述可开始条件，不代表已调度或归属于某个执行者。
todo 可有未完成前置，in_progress/done 的前置必须全部完成；状态与自动执行许可及实际归属独立。

## 状态与更新规则

新建 task 和数据库默认值均为 `todo`，初始版本为 1，执行起止为 null，`allowAgents=false`。
创建只接受 `title`、可选 `description`、`dependsOn`、`externalDependsOn`、`requiredPlatform` 和 `properties`；
禁止提交 status、allowAgents 和执行时间。省略描述、依赖和 PR 列表分别为空字符串、空集合与空数组。
任务登记不启动执行，也不提供实现、部署、发布、合并或主线 push 的权限。
创建的 requiredPlatform 省略或 null 表示不限制，三个枚举可设置要求。迁移 013 只为旧行
增加 nullable 平台字段，保留其状态、版本、时间、属性和边；迁移 014 再执行三状态归类。
平台运行时值必填，缺失或非法值拒绝，不从服务端操作系统推断执行平台。


统一状态入口为 `PUT /api/v1/projects/{projectId}/tasks/{taskId}/status`，普通请求为
`{"version":123,"status":"in_progress"}`，done 目标另可提供 claimId 以完成当前 worker 执行。版本为正 int64 JSON 数字，范围
`1..9223372036854775807`；拒绝缺失、null、字符串、非整数、越界、重复或未知字段及 query。
只接受 `todo`、`in_progress`、`done`。普通成员与管理员均可设置状态；删除旧动作入口，不保留别名。

没有 active/released 执行归属的普通任务支持九种状态对；受控执行另有[认领保护](../design/daynight-worker-claims.md)。项目锁后复核成员及精确版本，先判断版本，再判断同状态。
同状态返回当前完整资源，不写持久化字段、版本、updatedAt 或计时；过期同状态仍返回
`409 version_conflict`。实际改变增加一次版本，原子更新状态、时间与 updatedAt。
实际进入 in_progress/done 要求全部普通和外部直接前置已 done；done 退回 todo/in_progress
要求没有 in_progress/done 直接后继，否则 `409 dependency_unsatisfied` 返回稳定排序的阻塞 ID。
拒绝不级联、不修改后继。权限、版本、依赖、取消、存储或事务失败均不留下部分结果。

执行时间由锁后的数据库 statement 时间产生：进入 in_progress 替换起点并清空终点；
退回 todo 清空两端；in_progress→done 保留可空起点并写终点；todo→done 的起点为 null，
仅写真实终点。普通编辑和同状态保留时间，未知历史起点不从其他时间戳推算。
状态写入保留标题、正文、PR、allowAgents、requiredPlatform、全部依赖及外部分类和附件；claim-bound done 同时把当前 worker 记录置为 completed。普通状态写入不能替代 active 释放或 released 接续，具体授权由[认领架构](../design/daynight-worker-claims.md)拥有。

新增迁移将全部历史 proposed 改为 todo，只对转换行增加一次 version 并更新 updatedAt，
保留其他字段及历史起止时间。归类迁移不调用运行时 todo 清空规则；其他状态行保持不变。
默认值、转换、三状态 CHECK 与迁移 ledger 同一事务，失败回滚，重复启动不重复转换。
已应用迁移及 checksum 不变，运行时拒绝旧状态，不提供兼容读取映射。

PATCH 可修改 `title`、`description`、`dependsOn`、`externalDependsOn`、`allowAgents`、`requiredPlatform` 和预定义属性，
必须带读取到的 version 并至少包含一个可修改字段。status 不属于 PATCH；即使同时提交合法字段也整体拒绝。
省略字段保留，只有 requiredPlatform 允许 null 清除，其他字段 null 拒绝；空描述、`dependsOn: []`、`properties.pullRequests: []` 明确清空对应内容。
空 properties 不算修改。todo 可有未完成前置；in_progress/done 的完整候选仍须全部直接前置完成。
引用须存在于同 project，不能重复、自身引用或成环。依赖 D/E 独立 PATCH 语义由
[外部依赖需求](daynight-external-dependencies.md)拥有；任何无关写入均保留完整分类。

版本匹配的语义空编辑保持版本和 updatedAt；过期等值仍冲突。依赖顺序不构成变化；
PR 顺序、重复项与字符串参与比较。allowAgents 省略保留，false 关闭，null/非布尔拒绝；
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
[三状态要求](daynight-task-status.md)拥有完整状态契约，[状态架构](../design/daynight-task-status.md)解释并发与迁移机制。

## HTTP API

| 方法 | 路径 | 结果 |
|---|---|---|
| `POST` | `/api/v1/projects` | 创建 project，返回 `201` 和资源 |
| `GET` | `/api/v1/projects` | 返回 project 分页列表 |
| `GET` | `/api/v1/projects/{projectId}` | 返回 project，缺失时 `404` |
| `PATCH` | `/api/v1/projects/{projectId}/settings` | 管理员按精确设置 version 修改阈值，返回 `200` 和完整 Project |
| `POST` | `/api/v1/projects/{projectId}/tasks` | 创建 task，返回 `201` 和资源 |
| `GET` | `/api/v1/projects/{projectId}/tasks` | 返回 task 分页列表 |
| `GET` | `/api/v1/projects/{projectId}/tasks/{taskId}` | 返回 task，缺失或不属于该 project 时 `404` |
| `GET` | `/api/v1/projects/{projectId}/task-graph` | 返回同一完整快照的 project、任务图和统计 |
| `GET` | `/api/v1/projects/{projectId}/task-sync` | 返回有界任务摘要 snapshot/delta，使用 epoch 与任务最大 updatedAt 水位 |
| `PATCH` | `/api/v1/projects/{projectId}/tasks/{taskId}` | 原子更新元数据和依赖，返回 `200` 和资源 |
| `PUT` | `/api/v1/projects/{projectId}/tasks/{taskId}/status` | `200`，三状态精确版本设置，返回完整任务 |
| `DELETE` | `/api/v1/projects/{projectId}/tasks/{taskId}` | 精确版本软删除；可选 removeDepends=true 原子解除全部传入引用，成功 `204`，保留任务与附件数据 |
| `POST` | `/api/v1/me/workers/{workerId}/report` | 保存账号自己的最新运行快照，返回服务端 observation 与 lastReportedAt |
| `GET` | `/api/v1/me/workers` | 返回最近 72 小时的账号级 Worker 摘要及稳定分页 cursor |
| `GET` | `/api/v1/me/workers/{workerId}` | 返回近期 Worker telemetry 与按当前权限过滤的任务观测 |

HTTP 创建请求使用 `Content-Type: application/json`，可附带 UTF-8 charset。请求体
最多 1 MiB，必须是单个 JSON 对象；拒绝无效 UTF-8、重复 key、字段名大小写不符、
未知或只读字段、错误类型、必填字段为 `null` 和尾随 JSON。

所有成功读取返回 `200`。Project 不存在时，其 task 子路径必须返回 `404`，
不能将空 task 列表作为不存在 project 的结果。授权成员访问已软删除任务的定点资源返回
`410 task_deleted`；非成员与不存在任务仍为 `404 not_found`。列表、ready、图、同步、统计与
新依赖引用排除已删除任务。DELETE 正文 removeDepends 可省略或为严格布尔：省略/false 遇未删除引用者时拒绝且零变更；true 原子清除全部传入普通/外部及已删除源历史引用，并各自增加受影响源版本一次。目标自己的前置与附件保留，active 目标 worker 仍禁止删除。[软删除需求](daynight-task-deletion.md)拥有删除保护、数据保留及完整错误规则。

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
Task 列表支持单个三状态 status、ready/allowAgents 布尔值、compatiblePlatform=windows|linux|macos，以及可选 UUID workerId。布尔只接受 true/false，兼容匹配包含 null 或同值要求；省略不筛选。workerId 只匹配当前认证用户、指定 worker 的有效 active claim，排除 null/released/completed；不隐式增加状态、ready、许可或平台资格条件。全部显式条件 AND 组合，在最终分页和 lookahead 前成立，不能取有界页再丢弃不匹配项。

仅以 workerId 筛选并成功读完该 runner 全部项目和分页，才得到用于资源对账的完整自有 claim 清单。额外显式条件得到的是子集，不能据其缺席清理其他执行；读取失败或部分页不能视为空清单。
Cursor 必须绑定列表类型、所属 project 和规范化筛选条件；指定 workerId 时还绑定隐式认证 userId，不能换用户、移除或改变 workerId 续页。格式错误或条件不匹配返回输入错误。重复 query 参数、显式空值和未知参数也作为
输入错误拒绝；`limit` 的默认值仅用于未提供该参数。
单次响应中的 task、依赖和派生字段保持一致；多次翻页不承诺跨请求快照。

### 账号级 Worker 快照

Worker 资源归属来自认证 principal，报告不能提供 userId 或权威任务状态。完整结构、Probe 分支、null/空/旧清单、72 小时窗口及任务计数由[快照协议](daynight-worker-snapshots.md)拥有。GET 不续活，详情超窗、未知与他人资源统一为 404。离线和移出近期列表不改变任务执行；读取时的当前项目权限同时约束历史标题、任务行和计数。

### 时间窗口任务摘要

`GET /api/v1/projects/{projectId}/task-sync` 已实现，与完整任务图并存。唯一可选参数为
`epoch`、`since`；since 必须伴随规范 UUID epoch，并为 UTC `Z` 结尾、0–9 位小数的有效时间。
无 epoch 或 epoch 不同返回完整 snapshot；相同 epoch 返回 delta，带 since 时读取
`updatedAt >= since - overlap`，无 since 时返回全部摘要供空基线使用。所有状态和依赖性质均参与，
无当前请求时间上界、筛选或分页。默认 overlap 为 `10s`，环境配置
`DAYNIGHT_TASK_SYNC_OVERLAP` 必须为正 Go duration。重复尾窗口是正常结果。

Project、缓存 epoch、完整容量检查、匹配任务和 observedAt 来自一次只读快照；
即使窗口只命中少量任务，项目超过 1,000/5,000 上限也明确拒绝。摘要的业务 version
使用精确十进制字符串，包含 requiredPlatform，省略 description/properties 及派生 ready/blockedBy。
纳秒下界向上对齐到 PostgreSQL 微秒精度，避免驱动截断造成边界外记录进入结果。
身份/权限、HEAD、no-store 和错误优先级服从既有合同。完整行为由
[任务缓存需求](daynight-task-sync.md)拥有；Web 持久缓存尚未在当前交付中接入。

### 完整任务图

`GET /api/v1/projects/{projectId}/task-graph` 提供同一只读 `REPEATABLE READ` 快照中的
project、完整 tasks、summary 及数据库时间样本 `observedAt`，不使用分页或状态筛选。任何非空 query，包括未知
字段、分页/筛选字段和无效编码，均返回 `400 invalid_input`。成功、拒绝和读取错误
响应采用 `Cache-Control: no-store`；GET 同时支持 HEAD，其他方法返回 405 与 Allow。

summary 必须包含 `total`、`todo`、`inProgress`、`done`、`ready`、`blocked` 六个非负整数，零值也必须返回。
满足 `total = todo + inProgress + done` 与 `todo = ready + blocked`。
blocked 只计入前置未全部完成的 todo；图读取不改变任务状态、版本或时间。
图节点返回 `id`、`titlePreview`、`titleTruncated`、`status`、`dependsOn`、
`externalDependsOn`、`blockedBy`、`ready`、必填布尔 `allowAgents`、必填可空枚举 `requiredPlatform`、`createdAt`、`updatedAt` 以及明确可空的 `startedAt`、`completedAt`。
顶层 `observedAt` 是图数据与统计读取后的数据库时间样本，使用 UTC RFC 3339；
它不是事务开始时间或任务更新时间，不修改任务状态或版本。标题预览最多 160 Unicode code
points，截短时标记 titleTruncated；不返回完整标题、description 或 version。完整
任务内容继续使用既有详情接口。节点按 `(createdAt,id)` 排序，前置及阻塞 ID 数组
按 ID 排序；空图和空数组使用 `[]`，时间使用 UTC。真实边由全部 `dependsOn` 表示，
`externalDependsOn` 仅保留其中的性质，不减免阻塞、环检测或图边数。

一个成功图最多包含 1,000 节点、5,000 边。快照内先获取精确数量；超过任一上限
返回 `409 graph_limit_exceeded`，error.details 包含 `nodeCount`、`edgeCount`、
`maxNodes`、`maxEdges`，不包含 taskIds，不返回部分图。缺失 project 仍为 404。
数据库、取消和事务完成失败优先于暂存的缺失或超限结果，不得被降格成 404/409。
计数、依赖、ready 与 summary 必须来自同一次快照，即使读取期间有并发写入。

错误响应统一包含 `error.code`、`error.message`、`error.requestId`，必要时包含
`error.details.taskIds` 中按 ID 排序的阻塞 task ID。HTTP 状态与错误分类如下：

| HTTP 状态 | `error.code` | 场景 |
|---|---|---|
| `400` | `invalid_input` | 格式、字段、分页参数、依赖引用、自身或重复依赖不合法 |
| `401` | `unauthenticated` | 会话或个人访问令牌缺失、失效或已撤销 |
| `403` | `forbidden` | 普通成员执行管理员操作，或 Cookie 会话写请求来源不符合要求 |
| `404` | `not_found` | 路径资源缺失、当前用户不是项目成员或 task 不属于指定 project |
| `405` | `method_not_allowed` | 已知路径使用不支持的方法，并返回 `Allow` |
| `409` | `version_conflict` | 任务元数据、生命周期或项目设置的期望版本过期 |
| `409` | `invalid_transition` | in_progress 中禁止实际切换 allowAgents/requiredPlatform，或删除目标仍有 active worker 归属 |
| `409` | `dependency_cycle` | 候选依赖图成环 |
| `409` | `dependency_unsatisfied` | 进入 active/done 或元数据候选违反前置完成规则、done 重开存在 active/done 直接后继，或严格删除存在未删除引用者 |
| `409` | `graph_limit_exceeded` | 完整图超过节点或边上限，返回精确数量和支持上限 |
| `410` | `task_deleted` | 授权成员访问已软删除任务；不表示项目访问撤回 |
| `500` | `internal_error` | 内部或持久化操作失败，响应不泄露数据库连接信息或 SQL |

## 运行与范围

服务默认监听 `127.0.0.1`，继续只接受数值 loopback 监听地址；认证对全部业务
请求强制启用。启动必须配置公开 origin、UniAuth 服务地址、App ID、App Secret
和同 origin 的 callback URL，要求见[鉴权需求](daynight-auth.md)，操作配置由
[部署指南](../../deployment/localhost/README.md)拥有。生产公开 origin 使用 HTTPS；
受控 HTTP 测试例外与 UniAuth loopback HTTP 例外分别显式配置，不提供关闭鉴权模式。
`/healthz` 和 `/readyz` 公开可读，后者仅检查数据库可用性，不检查用户登录或 UniAuth。
[本地 Docker Compose 部署](../../deployment/localhost/README.md)提供一条命令构建
并启动内嵌任务看板、API 和 PostgreSQL，等待数据库及完整 readiness 转发路径健康后返回。
页面和 API 共用服务 origin，宿主机 HTTP 端口只发布到 `127.0.0.1`，数据库不发布宿主机端口；容器重建和普通停止必须
保留项目与任务，删除持久卷须使用单独的显式命令。
项目、任务及身份/成员状态由 PostgreSQL 持久化，启动失败必须非零退出。
附件扩展将文件内容保存到独立存储，其非原子性边界由附件需求记录。
关闭时停止接收新请求，在有界期限内排空请求，再关闭数据库连接。

本文的任务管理接口范围不包含自动任务执行、PR 关联、review 调度、跨 project
依赖或 project/task 删除接口。完整图读取由本文定义，浏览器页面及内嵌交付要求由
[看板需求](daynight-web.md)与[公开入口要求](daynight-landing.md)拥有，包括公开 `/` 推广页、
独立 `/login`、`/projects` 项目列表、公开静态 `/setup` 日常使用引导，以及基础任务路径
和附件路径的独立完整详情 GET/HEAD 深链接。页面只交付既有 index，完整详情、项目图、附件清单与文件读取继续使用原接口；
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
| V4 | 三状态九组合、当前同状态+0/实际改变+1、过期同状态冲突、PATCH status 拒绝、状态/重开/后继/依赖竞争保持约束 |
| V5 | 并发相同版本更新最多一个实际变更成功；过期版本冲突；无变化更新保持版本 |
| V6 | 分页、筛选、派生字段和错误映射与本文一致，空列表不掩盖读取失败 |
| V7 | 真实 PostgreSQL 测试覆盖事务回滚、迁移失败、并发写入和一致读取；取消和关闭有明确结果 |
| V8 | `go vet`、race 测试和 `go-cov --ci` 通过；覆盖率总计严格大于 90%、每包至少 85%、每函数至少 80%，保留关键代码块检查 |
| V9 | 覆盖率不足或 PostgreSQL 不可用使 Go 检查失败；[CI 路由](../../README.md#ci-selection)选择的检查必须成功，未选中的检查必须为 `skipped`，main push 保留全量门禁 |
| V10 | 请求日志可按 request ID 关联业务和存储失败，记录错误类别、组件和阶段，敏感值不进入日志 |
| V11 | 自动执行许可覆盖旧行迁移/新行默认、所有 task/graph 资源的布尔字段、创建拒绝与 PATCH 省略/false/null/类型语义、双值筛选与 cursor、精确版本同值与旧值、in_progress 拒绝、同版本状态/许可竞争及时间/PR/依赖保全 |
| V12 | 平台要求覆盖迁移保全、默认null、创建/PATCH省略/设置/清除/非法值、必填nullable资源、四种要求×三查询平台并组合ready/许可、分页前筛选/cursor、精确版本no-op/运行锁/状态竞争及全部字段保全；自动worker事务与实际记录按worker验收 |

实际进程与安装 CLI 验收通过固定的真实 UniAuth gateway 夹具取得浏览器会话与 PAT，
再执行 V1–V12 业务场景。受控外部 provider 响应与真实上游登录具有不同证据
范围；认证配置、私有夹具元数据和凭据不得写入公开产物。

覆盖率是验证门禁，不能替代 V2–V7 的行为证据。测试归属及工具版本固定规则由
[设计](../design/daynight-server.md)定义。
