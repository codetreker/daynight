# Daynight Server 架构设计

状态：Go 服务、事务存储、project/task 用例与 HTTP 接口已实现；Go 二进制
内嵌看板并与 API 同源交付。当前验证与 V8 的 race 和关键代码块要求存在差距。

`daynight-server` 是独立的 Go 服务，为本机 CLI 和内部程序提供 project、task
及任务依赖管理。行为要求由[需求文档](../spec/daynight-server.md)拥有；架构选择及
重新评估条件由[决策记录](../../.agents/notes/archived/architecture/2026-10-19-daynight-server-task-design.md)
拥有。决策记录标记的是已采用的设计，不表示服务已经交付。
[看板设计](daynight-web.md)定义浏览器完整项目图的本地投影、页面和内嵌静态资源
交付；任务链图 API 保留本文的领域与事务结构，不改变现有分页读取的一致性承诺。

已采用的[附件架构](daynight-task-attachments.md)提供独立的 bucket/path 文件存储；
通用本地存储、元数据及单文件附件接口已实现；[附件需求](../spec/daynight-task-attachments.md)
拥有行为与已知问题。
现有 PostgreSQL task 事务规则不扩展为文件与元数据的原子提交保证。

[鉴权架构](daynight-auth.md)定义已接入运行时的 UniAuth 身份交接、本地用户、会话、
访问令牌、CLI 设备授权、Team 生命周期及项目成员授权，行为由[鉴权需求](../spec/daynight-auth.md)拥有。
[身份基础模块](../../.agents/notes/archived/architecture/2026-10-22-identity-credentials.md)
提供独立的用户/凭据存储和 handler；[项目成员模块](../../.agents/notes/archived/architecture/2026-10-22-project-membership.md)
提供事务内授权、私有创建和邀请。`internal/config` 组合各模块拥有的强类型启动配置并协调两层 YAML、显式环境变量加载和跨模块验证；各模块拥有自身字段、默认值和纯校验，通用配置错误和标量解析归 `utils/configvalue`。`service.App` 创建并共享身份客户端、持久化、文件根、领域模块和集成服务。`server.New` 接收已组装的应用并注册身份、Team、成员和全部业务路由。
Team 元数据与存在性锁由[鉴权架构](daynight-auth.md#team-元数据与生命周期事务)拥有，
不引入 Project/Task 的反向锁依赖。
每个资源 service 方法显式接收 `model.Principal`；不保留匿名业务入口或私有创建/列表
别名。[统一启用决策](../../.agents/notes/archived/architecture/2026-10-22-authentication-activation.md)
记录组合、凭据隐私与验证边界。

现有 `packages/daynight/` TypeScript CLI、YAML 配置和 SQLite review 状态继续独立
运行。服务不读取或迁移这些状态；注册 project 也不启动现有 review 协调器。

[预定义属性设计](daynight-task-properties.md)为完整 task 提供通用属性对象、服务端静态定义与独立属性表。pullRequests 是公开可写的 PR 列表，worker 是服务端受保护的执行归属；缺失不补默认值。
[需求](../spec/daynight-task-properties.md)拥有扩展行为。
[负责人设计](daynight-task-assignment.md)拥有独立原生 UUID 列、跨字段写入规则、负责人筛选和项目内人员读取；[需求](../spec/daynight-task-assignment.md)定义其行为。

[执行计时架构](daynight-task-timing.md)的起止事实与图数据库时间样本已接入相同事务和读取模型。
项目阈值通过项目同行设置、管理员 PATCH 与完整 Project 投影交付；实时卡片消费这些事实，当前显示机制由[看板设计](daynight-web.md)拥有。

## 账号级 Worker 观测

`Workers` service 与既有任务用例共享具体 store 和认证 principal，使用独立的报告事务保存账号级最新运行快照。`workersRoutes` 注册报告、列表和详情，并沿用既有认证及清洗日志。报告只按输入任务主键批量规范化 claim 引用，读取按当前成员关系过滤保存的观测；该路径不取得 project 写锁或修改任务归属。列表一次查询规范摘要字段，以 UUID 关联计算当前可见任务数；详情普通解码完整快照。两者按写入入口生成的存储表示读取，不重复结构、字段或容量检查，不设置领域读取字节预算。列表按请求条数和一项 lookahead 生成稳定 cursor。

[快照设计](daynight-worker-snapshots.md)拥有 `workers` 表、原子 UPSERT、旧 observation 保护、稳定分页和时间语义；[需求](../spec/daynight-worker-snapshots.md)拥有公开字段与错误。任务图、claim inventory 和本机执行恢复保持各自的职责。

## 任务链图查询

`Tasks.Graph` 接收明确的 projectId 与 taskId，复用既有具体 store 与只读
`ReadSnapshot`。同一快照内先检查项目成员关系，读取 Project 并核对目标任务，再以
普通依赖的无向连通分量确定完整链成员。store 用递归 `UNION` 去重，沿普通前置和
普通后继两侧查询；现有依赖主键与反向索引分别支持两个方向，无需增加持久组身份或迁移。
从链成员直接声明的 external 依赖补充一层外部前置；不沿外部节点递归，不包含只在链外
依赖本链的任务。选择集合在 SQL 中确定，不先加载整个项目的图节点。

同一选择规则直接批量读取完整轻量节点并折叠 summary，不先执行存储节点或边的容量计数。
每个节点保留完整 dependsOn，包括指向返回集合外的引用；查询仍须遍历目标分量，
不承诺常数查询成本。core 的 `GraphTask`、`TaskGraphSummary`、`TaskGraph` 与 HTTP DTO
保持分离；SQL 直接截取 160 code points 的标题预览，不加载 description 或完整标题，
并投影可空执行起止、平台和许可。外部节点保留原始完整依赖、阻塞和 ready，不能用输出
节点的状态重算并删去投影外前置。summary 覆盖全部返回节点。

Project、目标、选择集合、依赖及 ready 都来自同一次 `REPEATABLE READ`。
节点与统计读取后，通过同一 snapshot 的 `ObservedAt` 取得数据库
`statement_timestamp()`，作为顶层 observedAt；不使用事务开始时刻或 HTTP Date。
缺失和软删除 Fault 在事务成功收尾后才返回，操作或清理失败仍优先。
HTTP 接受且仅接受一个必填 taskId query，返回 no-store，沿用 requestId、GET/HEAD
和结构化错误机制。具体响应与拒绝由
[服务端需求](../spec/daynight-server.md#任务链图查询)拥有；决策取舍见
[任务链查询记录](../../.agents/notes/archived/architecture/2026-10-29-chain-scoped-task-graph.md)。

浏览器从 task-sync 摘要物化完整项目图，其完整上游闭包由
[看板设计](daynight-web.md#图投影与统计)拥有。CLI 的一层外部前置查询不改变浏览器的
链投影，也不适合作为完整项目图输入。

## 时间窗口摘要读取

`NewTaskSync(store, engine, overlap)` 接收消费方定义的单方法 `SessionStateReader` 及已验证的配置；应用组装注入同一个共享 Session Engine，独立的 `taskSyncRoutes` 与原任务/图路由共同注册。
服务复用具体 store、项目读授权及 `ReadSnapshot`，在同一快照中取得 Project、
`task_cache_epoch`、窗口摘要与数据库时钟。已有授权、Project 和 ReadSync 成功且无 refusal 后，同一 SnapshotScope 的只读 SessionReader 查询全项目当前 Task Session source；共享 Engine 只读已提交 live 标量，投影完整最小 `sessions` 集合，不读完整 Current 或持有 live draft。域拒绝在事务成功结束后返回，
操作和清理失败优先，与任务链图查询相同。

store 先投影任务自身的 160 字符标题预览、业务 version、状态、许可/平台、assignedTo、时间和两类依赖，
关闭任务 rows 后，以选中 task IDs 的一次 `ANY` 查询批量读取并装配完整规范属性；不读取正文或计算阻塞字段。下界由原始 since 减配置 overlap，非微秒对齐时向上取整再绑定，
保持准确的包含边界选择。迁移为项目生成稳定缓存 epoch 并创建 `(project_id, updated_at, id)`
索引，不新增同步计数。HTTP 以十进制字符串编码业务版本。完整协议及后续客户端责任见
[时间窗口架构](daynight-task-sync.md)；当前 Web 消费 task-sync 并在本地物化完整项目图。Worker 归属及其他属性修改沿用已有 version/updatedAt 事务，snapshot/delta 都携带同快照的完整属性，普通属性变化不轮换 epoch。读取直接装入 `json.RawMessage`，不调用属性 Normalize/Validate/Admit，也不复查图规模或读取响应字节。正常解码、编码、数据库和事务完成错误沿原链路传播。身份核对仍 GET 已知任务，不以缓存属性授予操作权。

## 目录与调用方向

稳定代码组织规则由[服务端规则](../daynight-server.md)拥有。

服务位于 `packages/daynight-server/`，使用独立 `go.mod` 和可执行程序：

```text
packages/daynight-server/
├── go.mod
├── cmd/
│   └── daynight-server/main.go
├── api/
└── internal/
    ├── server/
    │   └── webui/                页面和资源 HTTP 适配
    ├── service/
    │   └── webui/
    │       └── dist/             生成的真实页面与资源，不提交
    └── core/
        ├── model/
        │   ├── project.go
        │   └── task.go
        └── store/
            └── postgres/
                ├── internal/
                └── migrations/
```

`cmd/daynight-server` 解析配置、创建应用和 HTTP runtime 并协调进程退出。应用在打开文件和数据库前完成配置与身份客户端验证；部分启动失败按依赖逆序释放资源。HTTP runtime 在同一准入门控下停止新请求；MCP 先取消并等待已接纳的工具工作，再停止共享 relay。已接纳的普通 HTTP 和 WebSocket handler 退出且断连事务完成后，Session engine 封闭 Operation 准入并等待事务、草稿、锁、通知和文件工作结束。HTTP、Session、Webhook 工作与依赖释放共用 `DAYNIGHT_SHUTDOWN_TIMEOUT`，上限十秒。超时后取消请求、通知 Operation 停止并强关 transport；已准入 transport 的断连收尾仍可启动所需事务。只有全部使用者退出后应用才关闭文件和数据库，未确认停止时保留资源供关闭重试并返回错误。Webhook 的监督和关闭顺序见[运行设计](webhook-runtime.md)。
`api` 拥有 HTTP 请求、响应和错误
结构；`internal/server` 使用标准库 `net/http` 处理路由、JSON、请求大小限制、
HTTP 错误映射和服务生命周期。`internal/service` 拥有 project/task 用例、业务
校验与事务编排。`internal/core/model` 拥有共享领域模型；`internal/core/store` 定义数据库中立的 DAO、作用域与事务合同；
`internal/core/store/postgres` 实现 PostgreSQL 查询、事务和迁移。`internal/service/webui` 拥有 `go:embed` 资源和读取，`internal/server/webui`
在既有 mux 精确注册页面及资源响应。静态处理不访问业务 store；请求仍只经过一次现有日志包装。HTML、图、Worker 观测及最新详情为 no-store，
哈希资源为 immutable，缺失资源不回退 HTML。精确 UI 页面形状包含公开根路径、
`/login`、`/projects`、项目页、账号级 `/workers` 与 `/workers/{workerId}`、公开静态使用引导 `/setup`、
`/projects/{projectId}/tasks/{taskId}` 完整详情和其附件路径入口。
[公开入口设计](daynight-landing.md)区分介绍、认证和工作台；使用引导在认证组件外挂载，
不发起身份核验或其他 API 请求。`/login`、`/setup`、`/workers`、`/teams` 根及后代，
以及 `/api/v1/teams` 命名空间在 callback 配置验证中保留，冲突在路由注册前拒绝。GET 沿用 HEAD 语义，其他方法返回 405，未知形状不回退 index。UI 的无效 ID 仍交付
index 后由前端显示未找到页面。独立附件命名空间复用原始路径守卫，在 ServeMux
清理和重定向前拒绝非法路径；数据与授权仍由已有任务、图和附件接口负责，机制见
[详情页面设计](daynight-task-inspection.md#独立完整任务详情)及
[附件阅读设计](daynight-task-attachments.md#独立附件阅读页)。

调用方向为 `server → service → core/store`。传输层将 API DTO 转换为 service
参数，core 不依赖 HTTP，store 不决定状态转换或依赖规则。事务内查询所需的数据、
加锁和持久化操作由 store 提供，已拆分领域的候选变更由 core 判断，service 编排作用域与跨领域操作。现有关系型数据只有 PostgreSQL 一个实现，
`SnapshotReader` 以 `SnapshotScope` 提供 Credential、Team、Project、Task、Tag、Session、Worker、Bot 和 Attachment 的只读 Reader；各 Reader 与 `ObservedAt` 绑定同一个只读 Repeatable Read 事务，仅在 callback 内有效。授权和数据读取因此共享快照，业务拒绝需要暂存时仍在事务正常完成后返回，完成或清理失败优先。`Completion` 和事务错误保留 committed、not_committed、unknown 及原因链，未知结果不能推断为回滚。Project 领域规则由 `core/project` 处理，`service/project` 选择快照、创建或已有项目写作用域并处理完成结果，`server/project` 负责 HTTP 和可复用投影；它声明实际消费的 `ProjectOperations`、`MembershipOperations` 业务接口，以及 `RouteAuthentication` 和需要 Origin 的 `MembershipAuthentication` 认证能力，生产 service 与真实请求认证组件满足这些能力，HTTP 单元测试直接控制业务结果并实际执行协议机制。创建先锁用户和目标 Team，再原子写入 Project、ownership 与 creator admin grant；已有 Project 写在 callback 前锁项目，Project、Task、Tag、Task 标签关联与 Session DAO 共享该事务。`ProjectScope` 仍是列表查询值。Worker 领域规则由 `core/worker` 处理，`service/worker` 组织账号观测、Task inventory 与配置事务，`server/worker` 负责 HTTP。Worker 写作用域保留独立 Read Committed 事务及完成结果。`postgres` 根包组装各领域 DAO，内部共享查询和扫描由 `postgres/internal` 持有。`service/persistence.go` 选择后端并提供事务、readiness 和关闭能力。附件的字节存储接口由其独立
架构拥有，不替代这里的具体 PostgreSQL store。

独立模块允许服务拥有自己的 Go/PostgreSQL 生命周期，避免将数据库事务接入现有
客户端的 review 命令。`cmd/` 与 `internal/` 的职责遵循
[Go 服务项目布局建议](https://go.dev/doc/modules/layout#server-project)。

## 领域模型与存储结构

Project/Task ID 使用应用生成的 UUID；[Thread 消息](daynight-task-thread.md)的 message_id 由数据库 DEFAULT gen_random_uuid() 生成，并与 task_id 共同标识消息。HTTP 将 UUID 作为不透明字符串处理。时间由数据库
生成，存为 `timestamptz`，API 输出 UTC RFC 3339。任务版本使用正整数，初始值为 1。

| 对象 | 字段与含义 |
|---|---|
| Project | `id`、非空 `name`、`repoUrl`、`createdAt`、`updatedAt`，以及具体 `settings`（正 int64 version、正 int32 executionWarningMinutes）；内部真实 `Ownership` 保存 TeamID、Version、UpdatedAt，公开内在字段必含 `ownership:{teamId,version}`；GET 另含同快照 access |
| Task | `id`、`projectId`、资源类型 `type`、可空 `parentId`、非空 `title`、`description`、`status`、布尔 `allowAgents`、可空平台枚举 `requiredPlatform`、可空用户 UUID `assignedTo`、通用属性对象 `properties`、`version`、`createdAt`、`updatedAt`，以及可空 `startedAt`、`completedAt`、`cancelledAt` |
| TaskDependency | `projectId`、`taskId`、`dependsOnTaskId`、非空布尔 `external`（默认 false） |
| WorkerSnapshot | 认证 userId 与 workerId、不可变创建时刻、服务端最近报告时刻、typed telemetry 与规范化任务观测；[独立机制](daynight-worker-snapshots.md) |
| WorkerConfiguration | 同一账号 Worker 行上的独立目标版本、值、应用观测版本与最近结果；[配置设计](daynight-worker-configuration.md) |

`TaskDependency` 的方向是“`taskId` 依赖 `dependsOnTaskId`”。project 拥有任务及依赖
图；不同 project 可以关联相同仓库地址，`repoUrl` 不作为 project 唯一键。当前 API
没有修改 project 仓库或删除资源的操作。

任务和关系使用 `projects`、`tasks`、`task_dependencies`，属性使用独立 `task_properties` 表；账号级 Worker 观测使用 `workers`。属性主键为 `(task_id,name)`，value 保存完整 JSON 文本，不重复 project_id，不具有独立版本、时间或删除标记。完整任务先取得可见父行，再在同一快照批量加载属性；图查询保持显式精简投影。其他主键分别为 `id`、`id`、`(project_id, task_id, depends_on_task_id)`。数据库使用非空、状态枚举检查、正版本
检查、非自身依赖检查及主键唯一性保证可局部表达的约束。索引支持以下访问：

- project 按 `(created_at, id)` 列表；
- task 按 `(project_id, created_at, id)` 列表及按状态筛选；
- 类型和直接父资源分别按 `(project_id, type, created_at, id)` 与 `(project_id, parent_id, created_at, id)` 排序；
- task 的原生负责人按 `(project_id, assigned_to, created_at, id)` 完整索引，并保留未删除行的部分索引；
- 依赖按 `(project_id, task_id)` 查询前置任务；
- 依赖按 `(project_id, depends_on_task_id)` 查询直接下游任务。

`009_task_timing.sql` 给 task 同行增加可空 `started_at`、`completed_at timestamptz`；
既有记录保持 `NULL`，core 和 API 用可空时间表示，JSON 字段明确输出 `null`。
不回填创建/编辑时间，也不在读路径判断旧格式。
`010_project_settings.sql` 给项目同行增加正值 `execution_warning_minutes integer DEFAULT 60` 与
`settings_version bigint DEFAULT 1`，两列均非空；既有项目的创建/更新时间保持不变。
项目创建、成员可见列表、单项读取、任务链图与摘要同步共用同一 settings 扫描与 HTTP DTO。
`011_task_agent_permission.sql` 为 task 增加非空布尔 `allow_agents`：既有行取得 true，随后数据库新行默认值为 false；应用创建同样显式提供 false。迁移保持任务版本、业务时间及其他字段不变。完整读写、图精简投影和生命周期候选都显式携带许可，严格读取不补缺字段默认值。

`012_external_dependencies.sql` 给依赖行增加 `external boolean NOT NULL DEFAULT false`，
旧边保持原端点并取得普通性质，其他任务、设置、计时、自动执行许可和迁移校验和不变。
`013_task_required_platform.sql` 增加 task 同行的 `required_platform` 可空 text，CHECK 仅接受 windows/linux/macos；既有和未指定值的新行均为 null，不重写任务版本、业务时间或其他字段。完整任务、图精简投影、创建/更新候选和生命周期写入都显式携带平台；API 资源始终输出 `requiredPlatform`，不以字段缺失表达任意平台。

`028_task_assignment.sql` 增加 `assigned_to uuid NULL` 和未删除任务的项目/负责人/keyset 索引。全部既有及软删除任务取得 NULL，version、业务时间、properties、worker 和 Session 保持。完整 Task、同步摘要和图 projection/scanner 显式读取同一原生列，不从属性或执行者推断责任。

`061_task_type_parent.sql` 为 Task 增加非空 `type`（默认 `task`）、可空 `parent_id` 及类型和父资源分页索引。旧行仅取得结构默认值，不改变业务身份、状态、版本、时间、资料或依赖。公开创建使用 `type` 和可空 `parentId`；省略类型为普通 Task，类型创建后不可修改。完整与摘要资源的映射和编码携带两者，窄回执和引用保持原投影。MCP 的既有 Task 工具将 Type 和 Parent 输入交给共享业务；原始字段存在性区分 Parent 省略、null 与 UUID，写入大小核算包括两字段。列表游标绑定规范化的类型和 Parent，围栏覆盖所有可见类型的变更。

`062_task_resource_rows.sql` 以同项目 Parent 的类型与删除事实构造有效删除视图；无需锁定的存在性和对外查询复用该关系，在排序、分页和聚合前过滤。资料和 Session 的带锁入口先预读 Parent，按 UUID 顺序锁目标与 Parent 的物理行，再以新语句复核 Parent 和有效删除。Session 注册对目标直接取得 UPDATE，其他资源锁使用 SHARE；Parent 变化返回 `resource_conflict`，不补锁或重放。依赖不变量继续读取物理普通任务与边，只有新增目标要求可见。Goal full 的进度在同一读取快照对选定页批量聚合，空容器为零；摘要和同步不携带进度。

`063_task_assignment_all_index.sql` 增加完整项目/负责人/keyset 索引，以支持视图上的负责人查询；部分索引继续保留。查询仍过滤有效删除状态。索引会维护所有任务行，并在迁移事务构建期间阻塞相关写入。

`070_task_tags.sql` 为 Project 增加独立的 `tag_catalog_epoch`，并建立标签库 `project_tags` 与关联表 `task_tags`。标签名称键按 `C` 排序，同一 Project 内由唯一索引保证唯一；关联以 `(project_id, task_id, tag_id)` 为主键，反向索引支持标签到条目的集合操作。两表不复制名称，也不引入外键或触发器。旧 Task 自然拥有空关联。标签目录在同一读取快照按名称键和 ID 分页、按字面子串查询及批量解析；使用计数通过有效删除视图统计可见 Task 和 Goal，包含终态。项目写事务提供原始版本条件写、关联集合替换、关联条目版本与时间的集合 touch，以及包含已删除保留条目的关联清理。独立 epoch 旋转不修改 Project 元数据或 `task_cache_epoch`。`core/tag` 拥有名称、版本与标签库规则；`service/tag` 在同一项目写作用域核验权限、原始版本并协调关联 touch 与删除，读取在同一快照核验权限和计数；`server/tag` 负责 REST 解析、认证接入、编码与错误映射。创建、实际改名和删除仅旋转标签目录 epoch；改名和删除集合 touch 关联条目，删除清除包括已删除保留条目的全部关联，不读取所有条目正文或失效任务缓存。目录 cursor 绑定项目、principal、查询、limit、epoch 和排序位置；批量解析以实际编码限制输出并拒绝任何失效 ID。设计取舍见[标签存储决策](../../.agents/notes/implemented/architecture/2026-11-13-project-tag-storage.md)与[标签目录决策](../../.agents/notes/implemented/feature/2026-11-13-project-tag-catalog.md)。

`core/task` 规范化并排序标签集合。创建省略或提交空集合时无关联；项目锁内校验候选及全部标签后，在原创建事务写入 Task/Goal 和关联，重新加载实际引用并核对集合，响应准入失败回滚全部写入。创建不 touch 条目，保留原始版本和数据库时间。更新省略标签保留、空集合清除，即使无变化也检查原始版本。`service/task` 的独立关联操作在项目锁内检查成员、有效 Task/Goal 和全部本项目标签；实际变化替换关联并使用锁后数据库时间 touch 一次，不改变执行归属或冻结 Session。PATCH 仅提交 `tagIds` 时使用独立关联操作；混合 metadata 时在原写事务校验最终集合，关联替换与 metadata 写入、响应准入共同提交或回滚，最多推进一次版本。单资源读取及完整写回执在同一事务加载真实标签引用；列表、ready、搜索和同步在截取选定页后批量加载引用，与任务行共享快照。关联变化不旋转任务缓存 epoch。

有标签的完整 Task 写入在提交前对准入副本保留实际 ID，将名称设为 64 个 `&`，并预留最大版本和最长 UTC 更新时间，再用与实际输出相同的有界 REST 编码器及当前 MCP envelope 检查预算。实际输出保留真实值；此上界使合法改名无需逐条读取大正文。无标签仍按实际值准入，超限回滚整个事务。详见[关联容量决策](../../.agents/notes/implemented/architecture/2026-11-13-task-tag-admission.md)。

`032_personal_project_ownership.sql` 建立真实 `teams`、`team_members` 与 `project_ownership`，
并原地重命名 `project_members` 及其 sequence/约束/索引为 `project_grants`。
[鉴权架构](daynight-auth.md#数据与并发)拥有全用户 Personal、现任 admin 回填、sequence 状态保全、
登录/项目 writer 与双来源计算。Project 点读 LEFT JOIN 归属并校验必需事实，缺行明确失败；
不存在业务读取时补 owner 的分支。

`044_project_soft_delete.sql` 为 Project 增加可空删除时间和活跃列表索引，并为 Project 内历史 Task 和 Session 的 UUID 锁扫描建立索引。Project 读取和准入先排除删除标记，再校验活跃 owner Team 的完整性；保留的历史 ownership 因此可以指向后来删除的 Team。Team 非空检查、邀请和 Worker 投影使用同一活跃语义。

Project 删除在 Read Committed 事务内先锁活跃 Project，再按 UUID 锁全部 Task，包括已删除 Task；锁等待后以新语句锁定并复核 owner Team admin、普通解码每个已有 Worker 属性，任一 active claim 阻止删除。标记、缓存 epoch 轮换和 Session 撤回同事务提交。附件、Thread 和 Session 在 Task 锁后以新语句复核活跃 Project，避免等待语句保留旧快照；附件文件变更与元数据在该锁保护下完成，删除项目不删除文件。Session 按 UUID、每批至多 128 行生成撤回计划，提交后按对象身份撤回本实例有界 relay 条目，其他实例通过既有轮询退出。实际数据库 Completion 与已产生的删除候选共同决定回执；未知提交不能推断为回滚。

删除预览在同一只读快照验证权限、计数并扫描 Worker 事实；按 Task UUID 和请求条数分页，完整投影阻塞项，不按标题或响应字节缩短页面。Worker 连通性取关联报告时间，不扩展账号级权限。预览不产生删除前提；DELETE 仍以锁内当前状态决定。

项目与任务相关表不建立 foreign key。引用存在性、同 project 限制和图规则由获得 project 写锁后的
service 写入路径校验；所有写入都必须经过该路径。`017_task_soft_delete.sql` 增加可空
`deleted_at`，删除保留任务与附件。removeDepends 省略/false 时，存在未删除引用者即拒绝；true 明确解除全部传入引用，包括已删除源历史边，受影响源版本各增加一次，目标自己的前置保持。新依赖不能引用已删除任务，两种删除模式均保持活动图完整。[软删除设计](daynight-task-deletion.md)拥有事务保护、可见性和缓存失效。
其他数据库写入者仍须遵守同一引用维护规则。

`033_bots.sql` 的 Bot 定义独立于项目锁，使用用户外键及 `(owner_user_id, worker_id)`
组合外键保证归属关系；凭据、请求指纹和版本仍由 Bot 事务校验。
[助手定义设计](assistant.md)拥有其冻结配置、幂等创建和删除责任。

## 仓库地址注册

创建 project 接受 HTTPS、SSH URL 和 scp 风格 Git 地址，例如：

```text
https://git.example.com/team/repo.git
ssh://git@git.example.com/team/repo.git
git@git.example.com:team/repo.git
```

Team 与 Project 的共同领域准入分别检查原始名称的有效性，以及最多 256 个 Unicode code points
和 1024 个 UTF-8 bytes；普通 Team 创建和真实改名、Project 创建及仓库注册共用这些规则。Team 同名 no-op 保留存量超限名称。
Project `repoUrl` 在 URL/SCP 解析和仓库匹配前检查最多 4096 个 UTF-8 bytes；容量失败
映射为 `invalid_input`，发生在创建或修改任何持久数据之前，不截断输入。

解析器校验协议、主机及非空仓库路径等语法，拒绝控制字符、嵌入密码、HTTPS userinfo、
query 和 fragment。SSH 用户名是传输地址组成部分，可以保存；私钥、口令、token 等
认证材料不得出现在保存的地址中。地址处理不限定 GitHub 或其他 provider，不进行
网络访问、仓库存在性检查、认证验证或 clone。

`repoUrl` 保留校验后的地址写法，用于 project 关联，不推导本地 clone 路径。REST
创建接口直接注册项目。MCP 的 `project_create` 与只读 `project_resolve` 在单个只读快照中按 CLI 的仓库身份规则
比较调用者可见项目。两者复用 `core/project` 的匹配和完整 keyset 分页遍历，service 负责快照及创建协调。
唯一匹配返回完整 Project；多个匹配立即拒绝。无匹配时解析返回 `not_found`，注册仅在明确确认后创建。
快照完成失败时不返回暂存结果；后续对象操作重新检查权限。扫描保留一页和一个匹配，未引入持久身份索引。
该检查不设置全局唯一约束；并发创建仍可能产生多个项目，后续识别会报告歧义。

## 状态与依赖不变量

普通 Task 使用 `proposed`、`todo`、`in_progress`、`done`、`cancelled`，创建与数据库默认均为 proposed；创建可显式选择 proposed 或 todo。Goal 使用四态及独立的状态时间和负责人策略，详见 [Goal 需求](../spec/daynight-goals.md)。
`014_task_status_assignment.sql` 将旧 proposed 行归类为 todo，对转换行 version+1、更新 updatedAt，
保留执行时间及所有其他事实；默认、数据、CHECK 与 ledger 同一事务。已应用历史迁移保持不变。
[状态架构](daynight-task-status.md)拥有五态转换、迁移和计时的完整机制与理由。

`Tasks.SetStatus` 复用 `Tasks.write`，在项目锁和成员复核后先比较精确版本，再处理同状态 no-op。
实际进入in_progress/done检查全部直接前置为done或cancelled，取消本身不要求前置满足；done退回proposed/todo/in_progress检查全部直接active/done后继；done→cancelled保持依赖满足，取消后继不增加重开保护；普通与外部边一致。
反向查询仅取稳定排序的阻塞 ID，使用已有反向索引，不读取正文或级联修改。
同状态 +0，实际改变 +1，完整 TaskWrite 保留正文、许可、requiredPlatform、assignedTo 及两类依赖，附件保持独立。Worker claim-bound done 在同一事务更新受保护属性；普通 setter 不能释放 active；release 清除当前归属后普通状态规则生效，cancelled 不能恢复。[认领架构](daynight-worker-claims.md)拥有归属检查与普通重新认领。

普通 Update DTO 没有 status，允许标题、描述、依赖、许可、平台、负责人、Parent 和属性。完整候选校验保证
in_progress/done 的全部直接前置已done或cancelled，todo/cancelled允许未满足前置。引用必须同 project 且存在；
重复、自身引用、缺失、跨项目和环均拒绝。状态设置与元数据具有单独公开职责。

Goal 不进入依赖图，其 blockedBy 为空且 ready=false。普通 Task 的 blockedBy 是按 ID 排序的未完成直接前置；dependsOn 包含全部直接前置，externalDependsOn 是
external=true 的排序子集；数组明确为空。ready 当且仅当 todo 且 blockedBy 为空。
派生值不持久化，前置变化不修改本任务版本或更新时间；因此同版本读取可有新 ready/blockedBy。
POST/PATCH 按最终 D/E 验证分类，完整写入始终携带分类，详见[外部依赖架构](daynight-external-dependencies.md)。

## 写事务与并发

所有 Task 与 Goal 创建、元数据更新及生命周期操作，包括语义空更新，都遵循相同事务协议：

1. 以 `READ COMMITTED` 开启事务，用 `SELECT ... FOR UPDATE` 查找并锁定 project
   行；不存在时返回 `not_found`。获得锁后检查当前成员关系，非成员同样返回
   `not_found`，管理员操作另行要求 `admin`。
2. 在获得锁后执行新的查询，读取目标任务、现有依赖和校验所需任务状态。更新检查
   请求中的 `version`，与当前任务版本不一致则返回 `version_conflict`。
3. 元数据更新构造完整候选；状态设置先检查版本，再判断同状态。实际改变检查全部前置及受保护后继，
   不满足时使用 dependency_unsatisfied。in_progress 实际许可、平台或负责人变化继续使用 invalid_transition。
4. 原子写入任务、依赖集合与执行起止；存在真实变更时，将版本加 1，并更新 `updatedAt`。
5. DAO 返回最终资源后、提交前以实际协议编码检查成功响应容量；超限作为事务错误回滚。提交后返回资源；提交或发送故障保留实际完成事实与原始错误链。

同 project 的 task 写入由 project 行锁串行化，不同 project 可以并行。获得锁与读取
任务不能合并为一个依赖同一旧快照的 SQL 语句：等待锁结束后，后续查询需要看到刚
提交的 project 内写入。任务 UPDATE 依据实际旧/新状态维护时间：进入 in_progress 产生新起点并清空终点，
退回 proposed/todo 清空两端，in_progress→done 保留可空起点并写真实终点，proposed/todo→done起点保持null。取消记录cancelledAt并保留原执行起止；同状态和普通编辑不刷新取消时间。
普通编辑和同状态不改变执行时间。时间使用锁后的 `statement_timestamp()`，不使用可能早于锁等待结束的事务时间。该机制依赖 PostgreSQL 在 `READ COMMITTED` 下为每条命令
取得新快照的语义，见[事务隔离文档](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED)
及[行锁文档](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)。

写锁同时覆盖“检查再写入”，所以并发添加 `A → B` 和 `B → A`，以及依赖更新与
开始、完成或重开竞争，都根据取得锁后的最新结果校验。状态先检查 version，使落后请求
返回版本冲突；当前版本同状态不写入。版本检查解决同一任务
的过期客户端覆盖问题；project 锁解决跨任务图和状态的不变量，两者职责不同。

更新 `dependsOn` 是替换完整直接前置集合。环检测使用递归可达性查询或等价的有界
遍历，候选图必须先移除该任务旧的出边，再加入完整候选出边。对每条候选边
`task → predecessor`，若 predecessor 能在候选图中到达 task，则拒绝。校验基于本次
锁内读取的数据，不依赖请求前查询或进程缓存。

Goal 的父资源校验和新 Worker claim 准入在同一项目锁内读取当前事实。普通 Task 的 Parent 可指向同项目未删除 Goal，结束状态不限制归属。自动候选和锁内新 claim 排除父 Goal 已结束的孩子；自有库存不使用该筛选。统一 Task 写入链路依据普通 Task 的变化前后状态判断实际进入 `in_progress`，并在同一项目事务读取当前 Parent；若 Goal 为 `todo`，复用 core 的 Goal 状态候选与持久化机制将其推进到 `in_progress`。人工状态修改和 Worker claim 均经过此链路，项目锁使并发子 Task 的启动只推进 Goal 一次。父子写入任一失败均回滚；同状态或归属等其他编辑不触发。Goal 状态时间由 core 候选以锁后权威时间生成，DAO 保存明确值，实际写入的版本可由读取及增量同步观察。Goal 删除只标记 Goal 并同事务轮换 epoch，不修改子项；其有效删除使库存缺失进入既有 cleanup。写后 Goal progress 在同一事务内聚合并参与精确响应准入，进度本身不派生状态。Goal 不发布现有可执行 Task Webhook。设计取舍见[子任务启动 Goal 决策](../../.agents/notes/implemented/feature/2026-11-13-start-goal-with-child.md)。

中性 `currentTaskWrite` 统一复制普通编辑、状态、属性与 worker 写入的全部字段。AssignedTo 先规范化再参与 changed 值比较；明确 no-op 和删除分支先于负责人策略，不能把空候选当作清空。实际变化时检查执行状态和新目标访问，强制候选 allowAgents=false；共享领域错误分类保持暂存拒绝与事务失败优先级。

PATCH 的语义空操作仍检查版本及输入，返回当前资源，保持 `version` 和 `updatedAt`
不变。许可判断沿用此顺序：锁后检查成员与版本，再判断 `allowAgents` 是否变化；同值返回当前资源，实际变化在 `in_progress` 拒绝。许可编辑与状态设置并发时共享该项目锁；自动执行许可不改变显式执行、ready 或依赖约束。任意真实字段、状态或依赖集合变化只增加一次版本；依赖顺序变化不算真实变更。
平台写入复用同一成员/版本顺序与项目锁：requiredPlatform 的字段存在性区分省略、设置、清除，
精确版本同值不写，任一实际变化在 in_progress 拒绝并整体回滚组合编辑。状态、许可和平台相互保留；
普通人工 setter 不执行自动发现资格筛选。model.TaskPlatform.Valid 与 PlatformCompatible
拥有枚举与 null/同值兼容，不使用服务器操作系统推测远端执行环境。

业务校验先生成候选变更计划，完成全部检查后才执行写入。预期拒绝保留为业务结果，
callback 不执行写入并正常结束；只有外层事务成功后才返回业务 Fault，提交或清理失败
优先暴露为内部失败。Project 写入锁定时排除删除标记，并在等待后重新检查权限。Task 软删除在同一项目锁内先检查成员、目标精确版本和目标 active worker；严格模式再保护未删除引用者，显式 removeDepends=true 则在执行阶段解除全部传入引用并更新源版本。准备阶段不能有副作用，避免等待外层事务结束才返回的 Fault 提交修改；解除引用、目标标记和一次项目缓存 epoch 轮换原子执行。任务和边不能分次提交。响应资源在同一事务快照内构造，提交成功后再返回，避免提交后
分次重读混合不同状态。事务内不执行网络访问、Git、子进程或其他外部操作。

该设计以同 project 写入吞吐量换取明确的串行规则。采用 `SERIALIZABLE` 可以提供
另一种并发控制，但还需要全操作重试及冲突响应策略；project 已经是依赖范围，因此
以 project 行锁组织写入更直接。若出现单 project 写入瓶颈，再根据观测重新评估。

## HTTP 传输准入

Runtime 在业务路由前限制原始 target 和 query，并将 Go 的 `MaxHeaderBytes` 设置为 64 KiB 减去初始读取的 4096-byte slop。该预算适用于 HTTP/1；未来 HTTP/2 的解压头字段需独立定义。`httpx` 沿 `ResponseWriter.Unwrap` 使用 `ResponseController`，在实际读取开始时设置 socket deadline。成功读到 EOF 后清除期限；请求入口跟踪底层 body 的实际 EOF，使已消费正文的业务错误保留连接与正常取消语义。取消或未消费正文时关闭连接并阻止自动 drain。流式读取使用 `DeadlineBody`，供附件和归档入口在授权后的实际读取处应用各自期限。

确定的正文超限和读取超时共用传输拒绝输出：关闭未读连接，保留业务 context 的取消，以保留 request ID 等值的独立 context 和真实 socket 写入期限，在最多一秒内尝试发送并 flush `413 payload_too_large` 或 `408 request_timeout`。关闭超限 chunked body 也可能因剩余 chunk framing 或 trailer 读取遇到已过期的读取期限而取消原 context；不能仅为 408 独立发送。完整正文已消费且连接可复用时，拒绝响应成功 flush 后清除本次写入期限，后续 keepalive 不继承它。独立 context 只用于这个终止响应，不传给业务处理或重新执行操作。附件实际字节超限由共享 reader 的 `ContentOverflowError` 标识并保留领域 Fault；分类器检查错误树中的每个发布结果均为 `not_published`、事务仅为未尝试提交且清理成功的 operation 拒绝，才将其映射为终止 413。一般 `payload_too_large` Fault 不授予独立响应资格。普通业务错误、客户端取消和无法确定未提交的写入仍保留原取消及完成事实；响应设置、写入或 flush 失败按真实传输失败记录，生产 HTTP/1 writer 设置写入期限发生实际错误时中止连接。

MCP 产品手册以 Go embed 和固定十二项目录随服务发布。`productManualManifest` 是生产目录的
唯一所有者，注册、正文加载和引用校验使用同一组声明；路径、Name 和 URI 保持一致，Title、
Description、MIMEType 和严格 UTF-8 byte Size 随正文同步。Entry 在注册前校验完整目录、非空有效
UTF-8 正文、大小及 instructions 与正文中的绝对内部 URI 引用，构造失败保留错误链。
SDK 原生 Resources 提供目录和每个主题的完整原文，独立 instructions 同时供两版协议使用。

入口按操作选择主题。公共 write-safety 拥有精确版本、授权和写完成规则；各资源拥有其分页、
身份、完整性、失败和恢复的具体条件。Session 读取与发送、Steps、Thread 和附件读取与写入
各自可独立取得，不需要从混合长文截取章节。正式材料的用途与充分性由 materials 拥有。
内部链接直接指向当前目录的 `daynight://manuals/...` URI，不在运行时聚合文稿或转换链接。
客户端在服务更新后重新发现目录；移除的混合主题 URI 沿用未知 URI 的协议错误。
[主题决策](../../.agents/notes/implemented/architecture/2026-11-11-mcp-topic-manuals.md)记录划分理由。

静态 Resources capability 不承诺订阅或变更通知。每次读取创建独立结果，并在构造前非阻塞取得
共享 Control 名额，直到 handler 与 HTTP 交付均结束才释放。饱和返回顶层协议内部错误；该限制
不覆盖 SDK 内置列表或整个 batch 的内存。HTTP 保持 no-store，现代协议结果使用 private、
零 TTL；未知 URI 沿用 SDK 协议错误净化。

MCP 身份确认后非阻塞取得独立的 16 个输入名额，再有界预读并交给 SDK。名额持续到 HTTP 与 SDK handler 均不再持有输入，与 Control 和 Large 工具预算独立。失败、取消、初始化和关闭均释放名额。详细额度及适用状态见[输入规范](../spec/daynight-api-input-limits.md)。

## HTTP API

接口使用 `/api/v1` 和 JSON：

| 方法与路径 | 操作 |
|---|---|
| `GET/POST /api/v1/teams` | 本人成员资格分页；原子创建普通 Team 和创建者 admin |
| `GET/PATCH/DELETE /api/v1/teams/{teamId}` | 读取本人关系，按元数据版本改名或核对名称后删除空 Team |
| `POST /api/v1/projects` | 创建 project |
| `GET /api/v1/projects` | 分页列出 project |
| `GET /api/v1/projects/{projectId}` | 获取 project |
| `GET /api/v1/projects/{projectId}/deletion-preview` | 当前 owner Team admin 的有界影响及阻塞观察 |
| `DELETE /api/v1/projects/{projectId}` | 锁内复核权限和全部 claim，提交删除屏障并返回回执 |
| `PATCH /api/v1/projects/{projectId}/settings` | 管理员按观察设置版本保存分钟阈值，返回完整 Project |
| `POST /api/v1/projects/{projectId}/tasks` | 创建普通 Task 或 Goal，默认分别为 `proposed` 和 `todo` |
| `GET /api/v1/projects/{projectId}/tasks` | 分页列出 task |
| `GET /api/v1/projects/{projectId}/tasks/{taskId}` | 获取 task |
| `PATCH /api/v1/projects/{projectId}/tasks/{taskId}` | 原子更新元数据及依赖 |
| `PUT /api/v1/projects/{projectId}/tasks/{taskId}/status` | 精确版本与目标五状态，done 可带当前 claimId |
| `POST/PATCH .../tasks/{taskId}/worker-claim` | 原子自动认领/当前 owner 更新摘要 |
| `POST .../tasks/{taskId}/worker-claim/release` | owner/admin 确认停止后释放并返回 todo |
| `POST .../tasks/{taskId}/worker-claim/withdraw` | owner/admin 原子撤回 active，清除归属并关闭自动执行 |
| `POST /api/v1/me/workers/{workerId}/report` | 原子保存账号级最新运行快照，不写 task |
| `GET /api/v1/me/workers` | 近期 Worker 摘要、当前可见任务计数及稳定 cursor |
| `GET /api/v1/projects/{projectId}/task-assignees` | 同一读取快照中的项目成员与保留负责人目录或限定ID解析 |
| `GET /api/v1/me/workers/{workerId}` | telemetry 与按当前权限过滤的任务观测 |
| `GET, PUT /api/v1/me/workers/{workerId}/configuration` | 独立于任务状态的目标 CAS 与实际应用观测，查询不续活 |

创建 project 的输入为 `name`、`repoUrl`、必填 `expectedUserId` 和可选 `teamId`；
目标成员检查与事务锁由[鉴权架构](daynight-auth.md#数据与并发)拥有；成功返回 Project 与同事务 access。
创建 task 的输入为 `title`、可省略的
`type`、`parentId`、`status`、`description`、`dependsOn`、`externalDependsOn`、`requiredPlatform`、`assignedTo` 与 `properties`；省略描述表示空字符串，省略依赖和
属性表示没有对应行，完整属性对象为空时返回 {}。创建成功
返回 `201`、资源体和对应资源的 `Location`；读取、更新及全部 worker 操作成功返回 `200`。Worker DTO/授权/事务规则由[认领架构](daynight-worker-claims.md)拥有；普通 create/PATCH 不能提供 properties.worker，PR 更新保留它。

项目设置 PATCH 独立接受必填正 int64 `version` 和 `1..2147483647` 的 `executionWarningMinutes`，
拒绝 query、缺失/未知/重复字段及非法类型，不接受 Project 其他字段。
`Projects.UpdateSettings` 复用 `WriteProject`：锁后复核成员、admin，再核对 settings.version，
最后处理同值空操作或更新。空操作不改版本和 updatedAt；实际更新在同一 SQL 中增加 settings_version，
并用锁后的 statement 时间更新 project.updatedAt。响应在该事务内构造完整 Project，沿用已有提交/清理错误优先规则。

Task PATCH 必须提交期望的 `version`，并至少提供 `title`、`description`、
`dependsOn`、`externalDependsOn`、`allowAgents`、`requiredPlatform`、`assignedTo`、`parentId` 或一个已定义属性。只有 `version` 或空 `properties` 的请求返回
`invalid_input`；
提供字段但值未变的请求采用前述语义空操作规则。例如：

```json
{
  "version": 3,
  "title": "Implement task API",
  "dependsOn": ["f3fc4136-4422-4b01-9864-0c721798b03a"]
}
```

状态 PUT 严格接受正 int64 version 与五状态 status，返回 200 和完整 task。通用 PATCH 中出现
status 是输入错误，含其他合法字段也不写入。HTTP 与日志保留 invalid_transition
用于 in_progress 的实际许可或平台切换拒绝；前置或受保护后继拒绝使用 dependency_unsatisfied。
严格 request DTO 和具体服务 use case 共用原 project 锁。

省略可更新字段表示保持原值；`description: ""` 清空描述，`dependsOn: []` 清空
依赖，`properties.pullRequests: []` 清空 PR 引用。`allowAgents` 使用可选布尔输入保留 omitted/false 的区别，创建严格拒绝该字段。`requiredPlatform` 使用明确的字段存在性和可空值区分省略、设置与清除：PATCH 省略保持、枚举设置、null 清除；创建省略或 null 均不限制。`model.TaskPlatform.Valid()` 验证枚举，`model.PlatformCompatible(required, actual)` 以 null/同值规则匹配，不读取服务进程的平台。PATCH 的双层指针明确区分未提供和显式 null，不把清除转换为省略。属性数组按序比较并整体替换，
具体记录只有字符串 `url` 和 `title`；保留原始文本语义并执行各自字节额度。assignedTo 同样以双层指针区分 omitted/null/UUID；service 先规范化，精确版本等值保留，新目标在事务内验证访问。实际变化同时关闭许可，进行中的任务拒绝变化；其他写入保留负责人。除平台、负责人和 Parent 字段允许清除外，显式 `null`、嵌套未知或
重复字段、不合理的类型及非法枚举均为输入错误。`id`、
`projectId`、创建时间及更新时间不可由调用者写入。任务返回结构包含模型字段及
`dependsOn`、`externalDependsOn`、`blockedBy`、`ready`；外部子集是必填读取字段，也是创建/PATCH 的可选分类输入。

Task 路径先确认指定 project 存在，再在其范围内查找资源。Project 不存在时，
包括 task 列表在内的所有子路径均返回 `not_found`，不能返回成功的空列表。其他
project 中存在的 `taskId` 仍返回 `not_found`。依赖输入中的缺失或跨 project ID
作为非法依赖返回输入错误，不读取或返回其他 project 的任务内容。

## 列表与读取一致性

项目列表在数据库中先按调用者的 owner Team 成员关系与 direct grant 过滤，再执行分页；项目、task 与完整图的
读取在同一 `ReadSnapshot` 内检查成员关系并读取资源。HTTP 入口每次重新验证
会话或 PAT，数据库成员检查遵循所属快照或项目写锁的时点；凭据验证不属于业务
事务中的再次校验。附件读取在文件 I/O 前完成快照授权；附件变更在 Task 锁保护下检查授权并完成文件和元数据操作，详见
[附件架构](daynight-task-attachments.md)。

两个列表接口接受 `limit` 和不透明 `cursor`。`limit` 默认 50，范围为 1 至 100，
使用 `(createdAt, id)` 升序 keyset 分页；响应为 `items` 和 `nextCursor`，没有
下一页时后者为 `null`。
task 列表接受 `type`、`parentId`、`status`、`ready`、`allowAgents`、`compatiblePlatform`、`platformSpecific`、`assignedTo` 和可选规范 UUID `workerId`，显式条件按 AND 组合。platformSpecific 是仅普通列表支持的可选布尔条件，true 对应 required_platform IS NOT NULL，false 对应 IS NULL，省略保留两类；它与 compatiblePlatform 组合后在排序、分页和 lookahead 前执行。assignedTo 在 service 转为 all/unassigned/user 选择，me 先解析当前 principal；原生 UUID 等值或 IS NULL 与许可、平台和 ready 一起在 SQL 中过滤；workerId 由 service 与认证 principal.UserID 组成一对内部筛选，只匹配解码后 worker 的 active/userId/workerId，不按 task 状态推断归属。

普通列表按原 keyset 和请求条数在同一快照一次读取 `limit+1` 候选，再批量加载选中任务的完整属性。指定 workerId 时，store 用一次关联查询按原 keyset 顺序扫描候选及其唯一 worker 属性，在 Go 中普通解码并匹配 active/userId/workerId；最终分页和 lookahead 在归属筛选后计算。cursor 指向最后返回的匹配项，不跳过下一候选；不引入独立 claim 权威表。读取不执行结构、字段或容量复查，也不按字节裁页。[批量读取决策](../../.agents/notes/implemented/simplification/2026-11-09-task-canonical-batch-reads.md)记录职责与查询成本。

项目列表默认返回全部可访问项目；`teamId` 选择当前主体所属 Team 的项目，`shared=true` 选择有 direct grant 且没有 owner Team 成员关系的项目。二者互斥，非成员或不存在的 Team 返回 404，数据库失败仍为错误；资格、Team 和主体条件均先于 LIMIT。列表不返回总数。项目 cursor 使用独立 kind 和版本 2，绑定规范主体及 all/team/shared 范围和 Team ID，旧版本或跨范围续页被拒绝。游标不提供防篡改保护，也不作为授权凭据；每次请求独立检查访问权限。

普通列表与 priority/ready 查询共享 `store.TagFilter`。`core/task` 将 ID 规范化、去重排序并验证 all/any/untagged 组合；service 在已授权的同一 repeatable-read scope 中通过 `TagDAO.ResolveTags` 校验全部项目内标签后再选择任务。缺失标签返回 `invalid_tag_filter`，数据库与取消错误保留。DAO 使用关联表集合条件在排序和 LIMIT 前执行 all、any 或无关联选择，与类型、Parent、状态、负责人和就绪条件 AND 组合；有效删除视图继续排除自身或父 Goal 已删除的条目。选定页仍批量加载标签引用。cursor 使用规范化标签过滤的 SHA-256 摘要绑定集合、模式和无标签状态，避免合法的大型 query 使 cursor 超过 16 KiB；摘要不承担授权或防篡改。ranked 搜索与客户端参数采用由各自查询入口拥有。取舍见[标签筛选决策](../../.agents/notes/implemented/feature/2026-11-13-task-tag-filters.md)。

Task cursor 版本3绑定 type、parent、解析后的 all/unassigned/user:UUID 选择及全部其他显式筛选，platformSpecific 以可空布尔保留省略与 false 的区别，编码省略未提供的条件，排序位置仍是 createdAt、id；workerId 还绑定隐式认证 userId。me 与同一具体 UUID 具有相同 scope；另一用户的 me 或变化后的选择不能沿用旧 cursor。未指定 worker 且负责人不是 me 时仍按原显式 scope 处理，不把查询身份当作隐式负责人。账号级 Worker 列表保持版本1；workerId 筛选的 Task 页仍是任务版本3。

cursor 编码最后一项的位置、资源类型、project 路径范围及规范化筛选条件。解码时
校验格式和范围，拒绝旧版本任务 cursor、将 project 列表 cursor 用于 task 列表，或在修改筛选后复用。
cursor 不承担身份授权或加密职责。列表不承诺跨多次请求维持同一数据库快照；新增
或更新后的任务可能影响后续页中按筛选条件可见的集合。

单次 GET 或列表的任务状态、依赖与派生字段必须来自同一个数据库快照。实现可以在
同一 SQL 语句中聚合，或在只读 `REPEATABLE READ` 事务内完成分页、依赖和状态查询。
`ready` 筛选在数据库中使用同一状态条件，`allowAgents`、`requiredPlatform` 和 `assignedTo` 使用 task 同行值；不能取一页后在应用中删掉 blocked、许可不匹配或平台不兼容的任务。
分页边界应用于筛选后的结果，`nextCursor` 根据该结果中是否还有记录产生。仅 workerId 筛选的全部项目/页成功汇总后，调用者才可按自有 claim 清单缺席对账；带额外条件（包括 assignedTo）或部分页不是完整归属集合。

人员读取复用 Tasks/ReadSnapshot 和项目读取权限。完整目录从原始成员ID与有效可见任务的DISTINCT assigned_to做UNION；限定模式从最多100个请求UUID出发，以成员主键及原生任务索引探测资格，再按资格LEFT JOIN users。保留原始候选ID与nullable users.id，使缺失资料行成为内部完整性错误，而合法nullable姓名/头像原样返回。所有结果与授权属于同一RR快照，事务完成错误优先于领域拒绝，失败不返回部分集合。[负责人设计](daynight-task-assignment.md#项目内人员读取)拥有完整请求与组装机制。

## 错误与诊断

service 返回可识别的领域错误；server 负责唯一的 HTTP 映射。错误响应统一使用
`error` 对象，包含稳定的 `code`、可读 `message` 和 `requestId`，必要时用
`details` 返回阻塞 task ID；不包含 SQL、连接串、堆栈或认证材料。

| 错误码 | HTTP | 情形 |
|---|---|---|
| `invalid_input` | `400` | JSON、字段、分页、地址或依赖引用非法，含自身及重复依赖 |
| `unauthenticated` | `401` | 会话或 PAT 缺失、失效或撤销 |
| `forbidden` | `403` | 缺少项目管理员角色或 Cookie 会话写请求来源不合法 |
| `not_found` | `404` | 指定 project 不存在、调用者不是成员或其范围内的 task 不存在 |
| `method_not_allowed` | `405` | 已知路径不支持该方法，`Allow` 提供允许的方法 |
| `version_conflict` | `409` | 元数据更新或生命周期动作的期望版本过期 |
| `invalid_transition` | `409` | in_progress 中禁止实际切换 allowAgents/requiredPlatform/assignedTo，或删除目标仍有 active worker 归属 |
| `dependency_cycle` | `409` | 候选依赖产生环 |
| `dependency_unsatisfied` | `409` | 状态或依赖修改违反前置完成规则、重开存在 active/done 直接后继，或严格删除存在未删除引用者 |
| `task_deleted` | `410` | 已授权的任务定点读取或操作命中软删除标记，不撤回整个项目 |
| `internal_error` | `500` | 数据库或其他未分类服务端失败 |

HTTP 只映射 service 的类型化业务错误；其他失败统一作为内部错误。读取缺失资源时，
service 在 snapshot callback 内保留缺失结果但返回成功，待只读事务正常结束后才生成
`not_found`。如果事务提交或清理失败，内部错误优先，不能因错误链含缺失标记而返回
`404`。数据库错误不能转换为空列表、成功响应或领域资源不存在。service/store 保留 cause
链，顶层按错误类别映射；请求取消通过 context 传递，已断开的请求不再尝试写响应。
事务提交错误必须作为失败暴露，不能宣称写入成功或自动重复整个非幂等创建请求。

采用标准库 `slog` 结构化日志，每个请求生成或校验 `requestId`。涉及已解析资源时
记录 `projectId`、`taskId`，同时记录组件、阶段、错误类型和经脱敏的 cause。
已知业务拒绝使用同名 `error_code` 和 cause，例如 `dependency_unsatisfied`；取消、
数据库和网络失败分类优先，不能被错误链中的业务标记掩盖。脱敏必须覆盖数据库连接
信息、请求体及仓库地址中的认证材料；不直接记录原始
driver 错误或完整请求体。成功日志提供方法、路由模板、状态和耗时。

普通服务在 root 选定后先独占 `logs/.writer.lock`，再打开追加日志并加载配置。
一个 JSON handler 同步写 stderr 与 `logs/daynight-server.log`，文件达到 100 MiB
时按编号保留十个旧文件；超大单条记录保持完整。不同进程须使用不同日志目录，
可通过绝对 storage 路径共享数据。文件或 stderr 失败会取消服务并导致非零退出，
安全的 `logging_failed` 诊断直接写 stderr。生产者停止后关闭文件并释放锁；锁文件
保留供下次启动使用。stderr 管道断开时，普通服务将 SIGPIPE 转为写入错误，仍尝试
文件输出并完成关闭。HTTP 和 metrics 的 drain 覆盖整个日志包装器，包括已劫持连接的
完成记录。`verify-storage` 只写 stderr，不创建日志或获取锁。

凭据使用记录器由 App 显式构造和启动，HTTP grace 期间继续接受已准入请求的事件。
HTTP/relay 退出后 App 等待其他 producer，再 seal 并 join 记录器及其日志 consumer。
App 的外层 `Drained()`/`Closed()` 错误分别表明整个应用已排空或已关闭，并保留原始 cause；
Runtime 不从单个嵌套错误推断整体完成。完成但失败的 drain 不阻止依赖释放，未退出时则保留
资源。persistence 通过原关闭 channel join pool，包括驱动异步清理，超时后继续等待同一次关闭。
request-local 故障的前置发布、版本确认和异常兜底见[认证设计](daynight-auth.md#凭据使用记录器)。

诊断服务失败时，先以响应 `requestId` 定位日志，再沿组件和阶段定位失败；数据库
问题另外检查迁移版本及 PostgreSQL 日志。验收应通过非法状态、版本冲突和受控
数据库故障确认错误码、日志关联和脱敏内容，不能只检查健康请求的输出。

## 启动、迁移与关闭

启动配置通过模块默认值、root 下两层 YAML 和显式环境变量依次覆盖。root 由 `--root`、`DAYNIGHT_ROOT` 或 `/var/lib/daynight` 选择，相对文件路径以 root 为基准，默认存储目录为 `storage`。配置加载不创建业务资源；`verify-storage` 只对数据库和存储执行语义验证。PostgreSQL 连接信息及五个鉴权字段必须由 YAML 或环境变量提供；鉴权字段对应的环境变量为：`DAYNIGHT_PUBLIC_ORIGIN`、`DAYNIGHT_UNIAUTH_URL`、`DAYNIGHT_UNIAUTH_APP_ID`、
`DAYNIGHT_UNIAUTH_APP_SECRET`、`DAYNIGHT_UNIAUTH_CALLBACK_URL`。公开 origin 与
callback 必须同 origin；callback 无 query/fragment，使用规范的非根路径，并在
创建登录事务前拒绝路由冲突和返回循环。仅该配置路径接收 callback，不保留旧路径
别名。生产使用 HTTPS；`DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN` 控制主站受控 HTTP
测试策略及 literal localhost/numeric-loopback 应用 CORS HTTP 例外；
`s2s.allowed_origin` 的精确配置与用户 REST 接入由[鉴权设计](daynight-auth.md#用户-rest-的精确-cors)拥有。
`DAYNIGHT_ALLOW_LOOPBACK_HTTP` 单独传给 UniAuth SDK，允许字面量
loopback gateway HTTP，两者不能互相替代。

HTTP 默认监听 `127.0.0.1`。LocalStorage 在打开数据库和监听前准备可写根目录并
探测大小写能力。Linux 要求区分大小写；macOS 原生开发允许普通目录，同时拒绝
与真实目录项拼写不一致的路径别名，不静默覆盖另一附件。
运行时以 `Dependencies` 向装配层提供数据库与文件存储，并在启动失败或 HTTP
排空结束后关闭已取得的文件根句柄。服务继续只接受 loopback 监听地址，公开
origin 不改变绑定策略。项目 ID 只标识资源，不能代替身份或成员权限。具体配置
与部署操作见[鉴权架构](daynight-auth.md)及[部署指南](../../deployment/localhost/README.md)。

[本地 Compose 部署](../../deployment/localhost/README.md)将 PostgreSQL、Go 服务与
TCP 网关组合启动，Go 服务同时提供内嵌任务看板和 JSON API。生产 Dockerfile 以
仓库根目录为 context，在 Node 24/pnpm 11.28.6 阶段构建并发布真实 UI，在 Go
1.27.2 阶段内嵌资源。最终运行镜像基于 Node 24 Bookworm slim，以非 root 用户运行
Go 二进制，并包含 sharp 图片验证 helper 和 Debian 系统 CA 证书；Go 出站 HTTPS
使用系统信任库验证证书。专属 ignore
纳入锁文件、workspace manifests、`patches/` 声明补丁和实际源码，排除宿主
依赖、临时文件及生成资源。网关拥有网络命名空间，Go 服务加入该命名空间并继续监听
`127.0.0.1:8787`；网关监听容器端口 `80`，仅发布到宿主机 `127.0.0.1`。
转发不解析 HTTP，响应、请求大小限制和错误语义继续由服务处理。数据库通过内部
Compose 网络访问，PostgreSQL 18 数据卷挂到 `/var/lib/postgresql`。
服务等待数据库健康后启动，由既有流程执行迁移；两条 HTTP 健康检查分别通过
服务回环端口和网关访问公开 `/readyz`，验证数据库与 Webhook 后台工作状态；`/healthz` 提供进程存活
响应，二者均支持 HEAD，不要求登录。网关配置或网络拓扑变化时整体
重建容器并保留数据卷。部署脚本每次重新构建并整体重建容器，用相同命令完成启动、
源码更新及转发恢复；数据卷持续保留。网关意外单独重启时，Docker 不会自动重启
共享命名空间的服务，健康检查会暴露转发失败，需要重新运行脚本恢复。
[部署决策](../../.agents/notes/archived/architecture/2026-10-20-localhost-compose.md)
记录拓扑选择及运行限制。[内嵌交付决策](../../.agents/notes/archived/architecture/2026-10-20-embedded-dashboard-deployment.md)
记录构建与隔离验收结构。独立 `deployment/dev-ci` 复用同一 Dockerfile 和 nginx
配置，采用唯一项目身份、随机 loopback 端口和专用数据库卷，按 run ID 有界清理，
日常 localhost 数据与资源不作为测试前置。

进程启动时创建 `pgxpool` 并验证数据库连接，然后从 pool 获取并固定一条专用
`pgxpool.Conn`。该连接取得 PostgreSQL session-level advisory migration lock，
并在同一物理连接上完成版本读取、校验和全部内嵌 SQL 迁移。当前迁移依次建立 project、
task/依赖、属性、附件与身份/成员机制，并持久化任务起止、项目设置、设备授权及共享速率窗口；
应用记录必须是内嵌迁移的有序前缀。锁必须跨越整个迁移
序列，不能使用会在单个迁移提交时释放的 transaction-level advisory lock，也不能
通过 pool 的任意连接分别取得和释放锁。

每个迁移在专用连接上的事务中连同版本记录一起提交；失败回滚当前迁移并退出，
保留已成功的早先版本。版本未知、迁移内容与已记录校验值不一致或锁获取超时都
明确失败。成功与失败路径都先在锁所属连接上显式解锁，再将连接归还 pool；若无法
确认解锁，则关闭该物理连接使 session 结束，不能把可能持锁的连接归还 pool。清理
使用独立且有界的 context，避免已取消的启动 context 跳过解锁。

服务启动期间只支持当前迁移序列中已有的版本，不在业务读取时判断或修补旧格式。
所有迁移成功且数据库可用之后才开始接受 HTTP 请求；启动失败释放已创建的 pool
及监听资源。没有依赖后台任务去补齐图状态或引用。

请求 context 贯穿 server、service 和 store，数据库查询及锁等待遵守取消和截止
时间。服务关闭时停止接受新连接，在共享期限内等待请求和后台工作，并在使用者停止后关闭
连接池；超时未确认停止时保留连接池并返回错误。`main` 拥有根 context、HTTP server 和 pool 的关闭顺序；请求代码只拥有
自身事务。错误回滚及资源释放不得覆盖原始失败；若清理也失败，保留两者的错误信息。

## 验证设计

[测试编写规则](../writing_tests.md)定义依赖和场景归属，并按被测职责选择隔离边界。
core 实际执行业务规则，使用合成领域输入及所需受控 DAO、scope 和 transaction。
service 实际执行自身装配、编排、事务协调与共享资源生命周期；server 保留实际路由、
协议认证、编解码与请求生命周期。按行为及准备、执行、清理成本选择范围，保留廉价
确定的真实协作；昂贵、不可控或需要精确结果、错误及时间顺序时控制所需窄能力。真实
SQL、传输和资源生命周期证明仍使用实际机制。

Mock 明确检查 principal、ID、输入、context、事务绑定能力、方法、调用次数及所需
顺序，独立提供操作结果、完成结果和错误。service 的实际事务 callback 仍执行，
验证后续操作、完成结果优先级、错误链和失败清理；拟写不代表持久化，后续给定读取
也不模拟提交或回滚。并发工作使用所属操作的 barrier，未配置的后台访问必须使测试
失败并完成取消与 drain。共享模型、领域错误和普通数据直接构造，纯逻辑、协议、
传输及生命周期的被测机制仍实际执行。Task 与 Session HTTP 单元测试采用直接
用例边界；Session 的私有类型化回调、不透明归档能力及实际 socket 证明由
[Session HTTP 用例决策](../../.agents/notes/implemented/testing/2026-11-09-session-http-use-cases.md)维护。

装配和生命周期测试使用受控协作者及外部资源边界执行生产构造及绑定，验证依赖身份、
readiness、部分启动清理、后台退出、资源保留和停止使用后关闭的顺序，不通过完整
下层业务矩阵取得固定数据。根 `internal/service` 测试拥有 App 组装、启动、readiness、
后台监督和关闭重试。
公开入口与测试共用同一 `openApp` 组装流程，通过实例级资源 factory 控制下层；
`openPersistence` 将同一个 backend 绑定为 Transactions、Ready 和 Close，应用与
公开持久化入口共用这段绑定。测试保留实际 Engine、文件、permit 和 worker 生命周期，
不自行拼装替代 App。普通和显式 tagged 部分启动测试都清理数据库与认证 fixture 变量，
未配置的后台调用必须失败并完成取消与 drain。真实配置、存储和数据库打开失败仍通过
公开入口验证；成功的原生组装归独立 startup/shutdown 入口。领域规则和完成结果矩阵
归 core 或对应子 service，物理事务及持久化归 Store，具体依据由
[根 service 测试归属决策](../../.agents/notes/implemented/testing/2026-11-09-root-service-test-ownership.md)维护。

现有根 server fixture 组装真实模块、路由和认证适配。HTTP/TCP、MCP SDK、WebSocket、
Session Engine、文件和 runtime 生命周期按实际机制运行；HTTP control 与 WebSocket
共享同一 application 和 Engine。UniAuth 浏览器绑定、一次性结果及 SDK 断流测试保留隔离的
真实 gateway、代理与 socket。其他认证输入通过明确 credential 与 Identity DAO 事实提供，
不为取得固定 Project/Task/Worker 模型重复完整登录与数据库准备。

`core/store` 的数据库中立接口能力和纯错误合同测试直接构造输入。PostgreSQL 实现
测试在测试环境拥有的隔离实例验证 SQL、映射、约束、快照、锁、提交、回滚与迁移。
领域 DAO 测试随 `postgres` 子包组织；根包保留连接、迁移、scope、事务完成、共享
快照及跨 DAO 原子性证明。真实数据库缺失应明确失败，不以跳过取得通过。

`postgres/testdata/testutil` 共享有效领域 fixture、历史 schema 设置和数据库观察工具。
它接收既有 store 合同与显式连接池，测试调用方将 `postgres.Open` 传给 factory，公共
fixture 不反向导入 `postgres` 根包。混合测试按独立证明拆分，小文件按相同所有者与
职责归组，原有断言、资源清理和独立 stress tag 保持可执行。具体安排和替代方案见
[PostgreSQL 测试归属决策](../../.agents/notes/implemented/testing/2026-11-09-postgres-test-ownership.md)。

正常 Go API 集成和产品 E2E 不承担边界、错误与竞态矩阵。完整进程的组装、drain
和重启持久化由实际 process 所属测试证明；CLI/Web 与 Go 模块测试保持独立入口。

正常资源操作、非法字段和地址、同 Project 限制、自身及重复依赖、环、完整依赖替换、
五态转换、默认 proposed 与显式 todo 创建、取消不可恢复、同状态 +0/实际改变 +1、PATCH status 拒绝、版本冲突、语义空
更新、原子起止时间、未知历史、锁等待后的实际开始、普通编辑保持计时及一致的
`dependsOn`/`blockedBy`/`ready`，分别由对应规则、协议和 Store 所属测试验证。
真实锁测试通过协调屏障证明反向依赖、同版本状态、依赖更新/状态竞争、重开与后继
开始/完成竞争仍保持不变量，并验证不同 Project 可以并行。

HTTP 测试保留路由、DTO、错误映射、Project 范围、分页筛选、cursor、日志、no-write
及 native 内容和容量边界。真实进程通过 HTTP 创建和读回资源，在重启后核对完整已提交
数据；凭据只保存在权限为 0600 的私有夹具元数据中，日志与产物只记录非秘密身份。
静态 response DTO 不能替代跨重启持久化或实际 SQL 的前后比较。

关键数据库验证保留以下可观察机制：

- 回滚：更新 Task 元数据和至少一条依赖后，通过受控数据库失败使后续写入出错，
  读回 Task、完整依赖、版本和更新时间与提交前相同。写前非法输入拒绝不能替代该证明。
- 一致读取：用同步屏障交错同一快照的读取与另一连接的提交，结果对应完整提交前或后
  状态，不能混合字段、依赖及派生数据。
- 取消：实际 SQL 或行锁等待后取消，验证终止、无迟到写入、事务和连接回收及后续
  可用。独立观察连接在 `pg_stat_activity` 匹配当前数据库、唯一 SQL 标记和非观察 PID，
  确认 `active`、`Timeout/PgSleep` 后再取消，join 关闭并核对原查询不再 active。
  Runtime 单元测试独立验证请求 context、准入、transport drain 和依赖关闭顺序。
- 凭证与 fence：在实际 unchanged lock 后观察数据库时钟过期或已提交的权限/版本变化，
  重检后拒绝并读回完整原状态。Mock 的前后事实只证明逻辑重检，不证明数据库锁和时间。
- 迁移：空数据库、重复启动及实例争用同一锁时跨多个迁移的行为；部分失败保留版本、
  数据、锁和专用连接的实际清理证据。

生命周期验证保留连接失败、有界关闭、取消、错误链和日志脱敏。数据库与文件、
网络不共享自动事务，必须分别核对实际提交与副作用的所有权。最终交付仍需提供需求
V1–V10 的全部验收证据，覆盖率不能替代并发、回滚、进程或调用方行为证明。

`bash scripts/check.sh` 与 `bash scripts/startup-shutdown.sh` 使用隔离
`DAYNIGHT_TEST_DATABASE_URL`、单测资源 overlay 与固定 UniAuth fixture。普通模块入口
验证命令包以外的生产包；命令生命周期入口使用 `startupshutdown` tag 验证
`cmd/daynight-server`，并执行 Webhook Runner 的独立进程恢复证明。两者分别运行
适用的 build、vet 与 go-cov：package 85%、function 80%、total 门槛 90%，实际各自
的未取整语句比较都要求严格大于 90%。全部生产包均有覆盖率归属；模块分区保留
分区内全部生产 package 的 coverpkg，命令分区只度量命令实现，两者都保留 atomic。
各分区均满足 `covered * 10 > total * 9`，因此总合也严格大于 90%；恰好 90% 失败。诊断 mutation 与计时 overlay 必须确认实际
进入执行代码；诊断 instrumentation 与正常验收分别记录，不修改质量门禁。

需求 V8 要求本地与 main CI 开启 race、PR CI 关闭并阻断关键代码块缺口。
入口按事件选择 race；当前 `.go-cov.toml` 的 `critical_blocks.fail = false`
不分析关键代码块，因此该部分要求仍未满足。配置、实际入口及独立本地 stress 命令由
[服务端验证说明](../../packages/daynight-server/README.md#validate)维护。

PR 按[仓库 CI 路由](../../README.md#ci-selection)选择模块，main push 执行全部应用检查。
Go 模块与 startup/shutdown job 分别使用独立 PostgreSQL 服务并归档各自原始覆盖率。
最终 `checks` 要求已选中的两个 Go job 实际 `success`；未选中时可按路由
`skipped`，失败、取消及其他结果使汇总失败。包耗时、组合命令、
完整门禁与 hosted job 时间分别记录，保持源码、toolchain、cache、instrumentation 和资源
预算可核对。性能比较包括承接原有物理证明的所有者，不能用本地包提速推断托管收益。

## 账号进行中任务读取

[账号读取合同](../spec/daynight-personal-in-progress-tasks.md)通过账号权限关系与有效删除视图，在数据库中筛选本人进行中普通 Task、聚合完整项目数量并以有界页面返回轻量投影。Parent Goal 标题来自实际父资源；暂停属性和 Session 来源按页面批量读取。服务从同一快照捕获的内存来源按 Task ID、Project ID、版本和状态核对行，由个人任务规则选择 active claim 的 Worker 和机器摘要；无 Session 注册也可取得 claim。来源缺失或不一致以及严格读取错误拒绝选择，HTTP 仅映射摘要，不查询 Worker 目录或逐任务追加读取。

选择快照验证凭据并读取活跃项目事实、页面和 Session 来源，结束后才采样 Session。发布前在新快照复核凭据及清单 revision；权限或清单变化拒绝发布，普通观测失败保留行及已确认的 Worker 并报告部分观测。claim 获取、完成或释放改变 Task 版本，复核发现变化时重置清单；最终复核后的变化由后续刷新反映。revision 是按项目 ID 排序的规范事实向量的 SHA-256，包含项目归属、设置、匹配数及项目全部 Task 的 epoch、数量和版本和，不包含 Session 或时钟。版本和使用精确十进制，避免溢出。

每页选择与最终复核均聚合活跃项目全部 Task 历史；无关更新可能重置遍历，持续变化不保证完成。该机制复用既有项目版本事实，不依赖进程内快照或持久化全局版本。真实成本取决于数据和负载，不承诺性能收益。
