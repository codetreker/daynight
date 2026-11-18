# Task 调度优先级设计

## 状态与设计边界

本文是**待实现提案**，不表示数据库、协议或 Worker 已支持优先级。
[规格](../spec/task-priority.md)拥有产品结果；
[决策记录](../../.agents/notes/proposed/feature/2026-11-18-task-scheduling-priority.md)
拥有范围取舍和替代方案。本文固定重要实现机制，但不授权实现或部署。
示例里的新路径、header、字段、命令参数和错误码均是拟新增合同。

服务端分层遵循[组织规则](../daynight-server.md)与
[数据库规则](../daynight-server-database.md)，Web 遵循
[UI 原则](../ui-design.md)。不改变现有依赖满足规则：前置为 `done` **或**
`cancelled` 即满足；“external dependency”是同项目其他链的前置，不是跨项目依赖。

## 固定基线与差异

源码基线为
[`ef50c49665b46fb47563174cbc9c19001def4d78`](https://github.com/codetreker/daynight/tree/ef50c49665b46fb47563174cbc9c19001def4d78)。
复核的 main 为
[`7eef2f1c4bd638b51a2d7a9fd5293807119704ae`](https://github.com/codetreker/daynight/tree/7eef2f1c4bd638b51a2d7a9fd5293807119704ae)；
其间包含 Webhook 测试与 token usage 功能。后者追加迁移 086、UsageStore
和独立用量协议；共用 query error 分类增加 UsageFault，不改变下述 Task
投影/选择/迁移前缀机制。本文不预占新的迁移编号或扩展 usage 数据。
后续实现仍需对届时主线重新核对，不把这份设计当作未发布 API 的发现结果。

| 已有事实 | 固定源码证据 |
| --- | --- |
| `model.Task` 没有业务等级；依赖的 cancelled 也满足 | [task.go](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight-server/internal/core/model/task.go) |
| REST Tasks 为 `createdAt/id` 分页；候选过滤在 limit 前 | [reader.go](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight-server/internal/core/store/postgres/task/reader.go) |
| `TaskPriorityList` 是状态/readiness 分组，不是业务等级 | [priority_list.go](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight-server/internal/core/store/postgres/task/priority_list.go) |
| MCP list 独有 count/version-sum fence，不能当作 REST 候选已具备 | [mcp_list.go](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight-server/internal/core/task/mcp_list.go) |
| Worker 先平台类别、再项目轮转，两个轮转位置独立；原 pending 先推进 | [coordinator.ts](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight/src/commands/worker/coordinator.ts#L1430-L1612) |
| Worker 候选使用 REST list、每页 100、拒绝重复 cursor | [remote.ts](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight/src/commands/worker/remote.ts) |
| claim 精确版本后重验本人、许可、平台、父 Goal、标签过滤 | [task_worker.go](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight-server/internal/service/task/task_worker.go) |
| 更新以 CurrentWrite 保留字段，版本检查先于 Changed/no-op | [mutation.go](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight-server/internal/core/task/mutation.go)、[task.go](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight-server/internal/core/task/task.go) |
| 只读 scope 使用 repeatable-read；迁移逐个事务、账本前缀和 checksum 校验 | [snapshot.go](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight-server/internal/core/store/postgres/snapshot.go)、[migrate.go](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight-server/internal/core/store/postgres/migrate.go#L380-L436) |
| Web detail/summary 读取已知字段，个人列表严格限定字段 | [parse.ts](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight-web/src/api/parse.ts)、[task-sync.ts](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight-web/src/api/task-sync.ts)、[personal-tasks.ts](https://github.com/codetreker/daynight/blob/ef50c49665b46fb47563174cbc9c19001def4d78/packages/daynight-web/src/api/personal-tasks.ts) |

## 数据与迁移

### 表达与规则所有者

在 `tasks` 加 `priority smallint NOT NULL DEFAULT 1`：
`low=0`、`normal=1`、`high=2`、`urgent=3`。Go 模型用有名 `TaskPriority`
类型、显式 `Valid` 与字符串编解码；不能让 Go 零值意外成为创建默认值。
创建的缺省判定与默认 `normal` 由 core 显式完成，SQL default 服务迁移和
兼容写入。Goal 行存 `1` 作为内部占位；core 拒绝 Goal 输入，输出映射为 null。

**不采用草案中的 `CHECK (priority BETWEEN 0 AND 3)`**：
现行数据库规则禁止默认把业务枚举复制到 CHECK。所有 REST/MCP/CLI 输入
共享 core 校验，DAO 扫描与协议映射遇非法存储值显式报错，不修复为普通，
不跳过坏记录。数据库仅约束类型和非空；直接绕过服务写入属于运维越界，
不能把未加入的数据库枚举约束宣称为已有保证。

`CreateTask` 用可选枚举表示省略；`UpdateTask` 用可选值表示未修改。
HTTP raw 字段存在但为 null 时在 adapter 拒绝，不能由指针吞掉存在性。
core `CurrentWrite`、`UpdateCandidate`、`Changed`、`ValidateUpdateFields`、
`ValidateUpdate` 与 store `TaskWrite` 一起增加字段。
终态的**显式** priority 输入一律拒绝，包含同值；旧请求省略不受影响。
Goal 显式输入同理。允许进行中修改，但不复用当前锁定进行中平台的 predicate。
权限/版本先于同值判断，非法类型在解析阶段先拒绝。

DAO 同步所有完整、紧凑投影和行扫描：`TaskProjection/ScanTask`、
INSERT/UPDATE、状态/许可/负责人/属性/claim 的 CurrentWrite 路径、
MCP summary/full、同步 summary、搜索行、个人列表、图与 Goal 成员。
其他字段写入不发出默认 priority，更新 SQL 使用已有行所复制的值。
变更仍只调用一次正常 Task 更新，保留版本、时间、同步和 Webhook 事务行为；
已有 Webhook 的旧事件形状保持不变，首期不扩展其订阅或 schema。

候选查询另需两个**内部派生列**，不新增业务表或公开可写字段：
`automatic_execution_paused boolean NOT NULL DEFAULT false` 和
`worker_claim_active boolean NOT NULL DEFAULT false`。
它们分别投影 `properties.blocked` 的有效 true 与 `properties.worker.state`
的 active；worker 属性存在但为 completed 时必须为 false。
`taskproperty` 的既有 Go 解码器定义含义，core 在形成最终 TaskWrite 后统一
计算二者，DAO 仅保存明确的布尔值，禁止通过 SQL JSON 提取、trigger 或 generated
column 重建属性规则。所有通用属性 PATCH、独立 set/remove-property、
claim/update/release/withdraw、状态与修复写路径都必须经过该最终写入准备；
删除属性相应归 false，同值 no-op 不额外写库。
完整 Task 读取校验布尔投影与合法属性一致，矛盾为存储错误，不静默择一。
轻量候选可直接查询标量；支持写入入口的原子维护是该优化的前提。

### 迁移与索引

追加新迁移，不修改历史 SQL/校验身份。迁移编号由实施时账本尾部确定，
不在本文抢占编号。迁移事务依次增加常量默认列、扩展视图、创建索引、写账本：

```sql
ALTER TABLE tasks ADD COLUMN priority smallint NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN automatic_execution_paused boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN worker_claim_active boolean NOT NULL DEFAULT false;
CREATE INDEX tasks_claim_priority_idx
ON tasks (project_id, assigned_to, priority DESC, created_at, id)
WHERE type='task' AND status='todo' AND allow_agents=true AND deleted_at IS NULL;
CREATE INDEX tasks_claim_priority_platform_idx
ON tasks (project_id, assigned_to, priority DESC,
          (CASE WHEN required_platform IS NULL THEN 1 ELSE 0 END), created_at, id)
WHERE type='task' AND status='todo' AND allow_agents=true AND deleted_at IS NULL;
```

第一索引对应关闭平台偏好的排序；第二索引对应开启偏好且先平台兼容过滤后的
类别排序。不能直接把 `required_platform` 字符串顺序当类别。保留现有索引，
因为普通列表和其他状态查询仍用它们。两索引增加写放大；实施验收必须用实际
计划证明价值，不能无测量地再加每等级或每平台重复索引。
依赖、父 Goal、暂停和 claim 不放入部分索引静态谓词，仍在候选查询中判断。

`task_resource_rows` 已冻结旧 SELECT 展开，须 `CREATE OR REPLACE VIEW`，
**保持已有列名称/顺序/类型，在末尾追加 `t.priority` 和两个派生列**，保留
`effective_deleted_at` 及父 Goal 删除投影。不能把 `t.*` 放在旧列前导致
replace view 重命名失败，也不能 drop cascade。同步更新 schema snapshot、
视图依赖投影、受限运行角色的 SELECT/INSERT/UPDATE 权限验证。

PostgreSQL 常量 default 可避免逐行回填，但 ALTER/视图更新和普通 CREATE
INDEX 仍会锁表，索引扫描有大表成本。沿用现有事务迁移器，不在事务中使用
`CREATE INDEX CONCURRENTLY`。发布安排维护窗口，迁移 session 设置
`lock_timeout=5s`、`statement_timeout=10min`；超时整个迁移回滚，读回账本后
由部署者重新安排，不无限自动重试。大库若无法接受窗口，必须先批准独立的
在线迁移能力，不能临时在账本外建索引或改 checksum。

升级不改变现有 Task.version/updatedAt；缺省普通属于 schema 初始解释，
不是逐 Task 用户修改。新投影启用前清除旧客户端缓存分区并重建快照。
新库 snapshot 与旧库 replay 的列、视图、索引、默认值必须等价。

两个派生列通过同迁移的 Go transform 分批读取现有属性、调用既有纯解码器
并回填，每批最多 500 Task，不全量物化。无效属性使迁移回滚并报告具体资源，
不得当作无暂停/无 active claim。回填不改业务版本/时间，迁移账本与回填同事务。
迁移封存当时的解码合同和 transform 源码校验身份，不直接依赖未来可变化的
运行时解码行为；沿用现有 Go 数据迁移的 `transformSource` 机制，并以历史
fixture 证明以后版本重放仍等价。运行时属性规则演进另加迁移，不重写此身份。
迁移前停止所有旧服务写入、确认连接排空，完成后只启动维护派生列的新服务；
不能在旧服务仍写属性时回填然后开放候选。迁移窗口包含该真实回填成本。
兼容回退包也必须维护这两个列，不能只认识 migration 编号。

## 协议协商与元数据

### 独立能力

新增认证只读 `GET /api/v1/task-priority-capabilities`，200 精确返回：

```json
{"schemaVersion":1,"metadataProtocol":"task-priority-v1","candidateProtocol":"priority-v1","writesEnabled":false}
```

部署配置 `DAYNIGHT_TASK_PRIORITY_WRITES` 默认 false，仅控制显式等级写入；
普通 Task 创建省略字段仍创建 normal，旧写入仍保留已存值。该开关是发布安全
门，不是项目权限或强制 Worker 准入。所有服务实例必须一致配置后才开放编辑。
false 时显式等级输入返回 409 `task_priority_unavailable`，而不是忽略字段。
能力端点认证失败不解释为旧服务；旧服务的路由 404 或缺少新能力只能表示
不支持/未确认。能力只按 origin+principal 暂存，最长 60s；写入仍由服务重验。

HTTP 请求 `Daynight-Task-Priority: 1` 协商元数据投影；新服务对所有携带
Task 等级的成功响应回显同 header，并设置
`Vary: Daynight-Task-Priority`，保留既有禁止共享敏感缓存规则。
无 header 精确保持旧字段集合；未知 header 值返回 400
`invalid_input`。新客户端必须检查响应 header 后再解析新字段。
已有 `Daynight-Worker-Protocol: 2` **只**属于 claim/执行表达，不复用其版本。

能力声明后未回显或缺字段是协议失败，不降级 normal。
新客户端对未协商数据的本地类型用 `unsupported/unknown` 分支，不用
`TaskPriority | undefined` 混淆默认值。新服务不向老严格个人列表注入字段。

### REST 写入与回执

沿用现有创建、PATCH 和精确整数版本，不另设等级写接口：

```http
POST /api/v1/projects/{projectId}/tasks
Daynight-Task-Priority: 1
Content-Type: application/json

{"title":"修复导出","priority":"high"}
```

```http
PATCH /api/v1/projects/{projectId}/tasks/{taskId}
Daynight-Task-Priority: 1
Content-Type: application/json

{"version":42,"priority":"urgent"}
```

成功仍为现有 201/200 完整 Task，新增 `"priority":"urgent"`；
Goal 投影 `"priority":null`。其余字段不删、不改版本编码。
Web/CLI 继续使用 lossless JSON/BigInt，不能经 Number 损失 int64 精度。
携带 priority 的写入必须协商新 header；未协商却显式提供字段为 400
`invalid_input`，避免“旧形状成功但看不到等级”的不确定回执。

| 条件 | 结果与写入效果 |
| --- | --- |
| 非法枚举/null/类型、Goal 显式设置 | 400 `invalid_input`，不调用业务写入或不提交 |
| 项目无访问/无写权限、Task 不存在 | 沿用现有 403/404 的授权与隐藏策略 |
| 旧版本（即使同值） | 409 `version_conflict`，不提交 |
| 当前版本、终态显式设置 | 409 `invalid_transition`，不提交 |
| 当前版本、可编辑、同值 | 200，保留版本与全部时间 |
| 正常变化 | 200，版本 +1，updatedAt 更新，createdAt 保留 |
| 提交确认丢失/损坏回执 | 未知；读回 Task，不自动重放 |

修改优先级的事务沿用现有项目写 scope 与行版本检查，不另建优先级锁。
现有锁保护权限、依赖与 claim 等组合事实，不能在本项只留下 Task 行版本
而移除原授权/项目/Worker 配置的锁定。排序观察不进入 claim 事务。
两个 Worker 持同版本领取时最多一个提交；另一方按现有冲突完成合同重选。

### 全部投影与客户端

| 表面 | 新版本接入点与不变量 |
| --- | --- |
| REST detail/create/update/status/property/worker 回执 | `internal/protocol/task` 统一映射；协商后普通 Task 必有枚举、Goal 必为 null |
| REST list、graph、Goal 子任务 | 同一 projection 选项下补字段，不更改原排序和 cursor |
| task-sync snapshot/delta | summary 含字段；协议变更后客户端旧分区失效并完整 snapshot，不能复用不含字段的 delta 基点 |
| personal in-progress | 新 header 下扩展严格 task 字段集，旧请求字段集不变；分页身份绑定投影版本 |
| search | 扩展专用 search row/DTO 和 Web 搜索 row model；不改变相关性 keyset 或总数 |
| MCP summary/full | 字段与 REST 语义相同；版本仍十进制字符串 |
| CLI/Web parser、types、formatter | 能力确认后严格验证新枚举；宽松读取其他未知字段的既有行为不因此一律收紧 |

Web 的 `TaskDetailSessions` 增加 `priority` mutation 操作；
`preservesMaterials` 等非目标字段保全验证要增加 priority，只有该操作可改变它。
`sameSummary`、detail-summary 校验、IndexedDB schema/分区身份、committed
projection、搜索/个人列表到 `TaskRowModel` 的适配全部同步。
缓存投影版本加一，只淘汰 Task 缓存，不清除独立 composer/创建草稿。
不能给旧缓存补 normal，因为它可能对应已保存的 high。

MCP `task_create`/`task_update` 输入 schema 增加枚举 priority；
所有返回 Task 的工具增加可选 `projection:"task-priority-v1"`。
缺省保持旧响应；显式 priority 必须同时传该 projection，否则
`invalid_input`。schema、严格 jsonobject 允许键、business body 计量、
summary/full encoder、输出 schema 与产品 manual 必须一起更新。
示例：

```json
{"name":"task_update","arguments":{"projectId":"fb1a3e30-f945-4c48-ab0f-55be117e098e","taskId":"a74167a7-5a45-4e71-a145-3a12e7716e12","ifVersion":"42","priority":"urgent","projection":"task-priority-v1"}}
```

`tools/list` 的新 schema 用于发现输入支持，不拿 MCP 通用协议版本或工具路径
版本冒充等级能力；新消费者必须请求投影，输出新旧 schema 用明确分支。
旧 MCP 客户端按旧参数仍得到旧形状，`ifVersion` 和写入未知结果规则不变。
MCP list 的状态分组 fence/cursor 不改为业务等级 cursor。

CLI `task create/update --priority urgent|high|normal|low`：
先查能力，自动协商 header；明确不支持则非零退出，不发送 mutation。
show/list/graph/text 与 JSON 输出的等级来源为协商结果；未知显示未知，
不新增普通展示排序。create/update 帮助、补全、类型、请求构造与
`using-daynight` **源目录** manual 同片更新，不修改安装副本。

## 候选读取协议

### 独立有序流

新增 `GET /api/v1/projects/{projectId}/task-candidates`，必须携带
`Daynight-Task-Priority: 1`。它只用于新调度器，不改变旧 `/tasks`：

```text
?workerId=<uuid>&platform=windows&preferPlatformSpecific=true&limit=100
```

服务从认证主体及当前 Worker 配置读取负责人、tag name filter，要求 Worker
属于主体；客户端不传任意 assignee/allowAgents/ready 来扩大范围。
Worker 的实际平台仍由现有 Worker 识别/claim 门禁校验，查询不是授权凭据。
scope 绑定当前配置中的有效 `taskTagFilterKey` 与平台偏好值。
请求偏好不等于已应用配置时返回 409 `candidate_configuration_changed`，
Worker 刷新配置，不用陈旧策略继续领取。

服务定义并在 SQL limit 前执行完整候选条件：普通 Task、有效未删除 Task/父、
todo、ready（含 cancelled 前置满足）、本人、allowAgents、平台兼容、父 Goal
非终态、没有 active claim、未暂停及当前 tag 过滤。SQL 通过
`NOT automatic_execution_paused AND NOT worker_claim_active` 在 limit 前过滤；
二者由前述 core 写入投影和 Go 迁移提供，不能以 worker 属性存在替代 active。
非法属性或投影不一致在完整读/迁移中显式报错，不用 SQL JSON 解码修复。
本地准备、资源所有权和容量仍由 Worker 判断，不假装服务知道本地进程。

返回精确轻量候选，避免返回描述正文：

```json
{"protocol":"priority-v1","observedAt":"2026-11-18T12:00:00Z","fence":{"epoch":"89f1d317-1b48-4c6a-8c3d-b8fc80701abe","count":"25","versionSum":"314","tagEpoch":"fb1a3e30-f945-4c48-ab0f-55be117e098e"},"items":[{"projectId":"fb1a3e30-f945-4c48-ab0f-55be117e098e","id":"a74167a7-5a45-4e71-a145-3a12e7716e12","version":"42","priority":"urgent","requiredPlatform":null,"createdAt":"2026-11-18T10:00:00Z"}],"nextCursor":null}
```

候选版本特意使用字符串，是**新端点**的编码，不改变旧 REST Task.version。
空集为 `items:[]/nextCursor:null`；禁止空页带 continuation。保留
request ID、principal 校验和现有认证错误语义。

排序键为 `(priority DESC, platformClass ASC, createdAt ASC, id ASC)`；
偏好开启时专用 `platformClass=0`、通用 `1`，关闭时恒为 0。
core 定义类别规则，DAO 执行对应表达式。
keyset 条件为 priority 小于上页，或 priority 相等且后续
`(platformClass,createdAt,id)` 大于上页；不可对混合升降序直接全元组 `>`。
limit 为 1..100，使用 limit+1。没有每等级/平台重复扫描。

### Fence、cursor 与新观察

每次请求在同一个授权 repeatable-read scope 中：
读取权限/Worker 配置、项目 task-cache epoch、全项目 tasks 的
`count(*)::text/sum(version::numeric)::text`（含 Goal 和软删除）、tag catalog
epoch，再查候选页。复用已有聚合 DAO 能力，但定义独立的
`TaskCandidateFence` 和 cursor；不是声称 MCP fence 已自动保护 REST。
不新增调度业务表，也不在每次读取增加写锁。

所有影响候选的 Task 头/依赖/属性/标签关联写入都必须推进所属 Task.version；
前置/父 Goal 的变化由全项目聚合捕获，永久删除/历史重建由 task-cache epoch
捕获，tag 重命名/删除由 tag epoch 捕获。权限每请求重验，不通过 fence
授予权限。Worker 配置 filter key 与偏好进入 scope。现行同项目依赖关系使
全项目聚合可覆盖前置；未来允许跨项目依赖前必须扩展此机制。
迁移验收必须逐写入入口证明此覆盖，不允许仅给 priority 写入加失效。
没有推进这些标识的后台修复必须在同事务更换 task-cache epoch。

cursor 使用 canonical JSON + base64url，最大 16 KiB；含：
`v=1`、kind、order、actor、project、worker、platform、preferPlatformSpecific、
filterKey、projection、fence、last 的 priority/class/createdAt/id。
时间使用 UTC 无损精度，ID 使用 canonical UUID。拒绝未知/重复字段、非法
枚举/版本/日期、非规范编码、scope 不匹配、旧 cursor。cursor 不是授权 token，
即使被修改也不能跳过权限或扩大候选；合法性仍全量重验。

scope/编码错误为 400 `invalid_cursor`；fence 改变为 409
`candidate_list_changed`；不返回部分页。不要把当前新 fence 贴到旧页继续。
一个项目每轮最多从头重启一次，再次失效标记本轮未完整观察，不当作空。

候选头跨轮保存只在内存；每轮使用前通过同端点的检查模式：
`?workerId=...&platform=...&preferPlatformSpecific=...&checkFence=<encoded-fence>`。
检查模式与 limit/cursor 互斥；200 返回
`{"protocol":"priority-v1","observedAt":"...","fence":{...},"unchanged":true}`；
scope 同样绑定，变化仍为 409，权限撤销仍为 403/404。
同一项目的页、缓存头和 fence 必须同时丢弃；不能只刷新头的版本。
检查完成后新到任务属于下一观察边界，不宣称取得全局数据库快照。

聚合每页有 O(项目历史 Task 数) 存储扫描成本，只有常量结果返回应用层；
它不是 O(1) 的调度 revision。首期明确接受这一成本以避免给全部写路径
引入共享热点计数器；性能门禁不达标时必须重审专用 revision 方案，不能
删除 fence 或缩小为仅当前页。项目数/页数上界不等于 SQL 扫描成本有常数界。

## Worker 选择与生命周期

### 有界、多项目归并

保留原 inventory、项目准备、映射完整性、容量计算、pending 启动和原执行
恢复/清理。只替换新领取的候选选择阶段。运行时配置变化取消候选阶段，
先重新协调，不取消已提交的 claim 或原责任。

每个合格项目持一个候选流状态：scope、fence、cursor、最多一页缓存、
首个本地可领取 head、是否耗尽、本轮页数。配置最多 128 项，查询并发 4；
候选阶段总 deadline 180s，每 HTTP 请求 deadline 5s，包含取消/drain。
每轮每项目最多 8 个页请求（包含首次及唯一重启），每页最多 100 条，
另最多一次 fence 检查；总请求不超过 `9P`，新增 claim 请求最多一次。
超过 deadline 不再派发；未完成的健康项目保留有限 continuation 到下一轮，
已发请求必须取消并 join，不因轮次结束泄漏。

1. 先为所有项目取得/验证 head 或完整耗尽证明，查询并发受限；本地资源
   冲突的候选明确记录原因，向同一有序流推进，直到得到 head 或页预算耗尽。
2. 任一**健康但预算耗尽**项目尚无 head/耗尽证明，本轮不新增 claim；
   保留其 cursor，下一轮继续。其他项目缓存 head 下一轮检查 fence 后再用。
   不能跳过这个健康项目直接选择低等级，也不能每轮从第一页重新扫描使
   第 801 条以后永久不可见。
3. 网络/服务错误、不支持、权限丢失单独分类为失败项目；清除其候选，
   报告 scheduler partial 和具体原因，按既有轮询/退避再查。其他已完整观察
   的项目可推进；此时明确只是在可观察子集选取，不提供失败项目的顺序保证。
   不改变现有“本地映射不完整则禁止新领取”等更强安全门禁。
4. 所有健康流有 head/耗尽后，取最高等级及其最佳平台类别，在该分组按项目
   轮转选 head。提交前重验配置身份、资源、容量和 executor freeze；
   若本地门禁变化则丢弃受影响 head/继续流，不越过优先级直接提交次选。
5. claim 成功后结束本轮。确定拒绝时下轮重建选择；未知时保留原 claim
   ID/冻结选择/资源预留，先由 inventory 查原请求，不发另一个 claim 补偿。

跨轮 continuation 同时绑定本地 resource/config generation，变更则重头。
重启丢弃扫描状态并重头；不持久化未领取候选为业务任务。
单页内检查 fence 的新鲜性不代替每轮 checkFence；所有缓存 observation
最迟在下一轮验证，不能长期把一个不存在的 urgent head 当排序门槛。
若项目持续变化使遍历不能完成，公开该活性限制，不降级成“队列为空”。

### 同级轮转

项目环按 canonical project ID 升序，不依赖异步请求完成顺序。
位置按 `(priority,category)` 保存：开启偏好为 8 个分组；关闭为 4 个 mixed
分组。值为上次**成功 claim** 的项目 ID；下次从严格大于该 ID 的项目开始，
末尾回绕。没有 head 的项目被略过，但不推进位置；读取、失败、冲突、跳过、
预算耗尽不推进任何分组。成功 urgent/specific 不改 normal/mixed 或其他组。

进程启动位置为空，从最小 ID 开始；重启不保证跨重启公平。
项目新增/移除时保留上次 ID 作为环上的锚点，即使该项目已移除也按字典后继
定位，不将删除位置转换成不稳定数组索引。开关变化清除所有组位置及流，
防止沿用不同类别解释。其他配置仅清流，位置在当前 Worker 内存保留。
该公平性只在同级同类别、持续合格、连续运行的单 Worker 中成立；
不承诺不同 Worker、不同等级或资源不合格任务的最大等待。

### 竞争与不可抢占

claim 仍走现有 endpoint、descriptor、version、tag filter key 和事务。
所选 Task 的 priority 修改也推进版本，使旧候选 claim 冲突。
父 Goal/前置/权限/许可/暂停/平台/标签变化即使未改候选版本，也必须由
claim 的事务门禁重验，不能依赖候选查询替代。基线 `ClaimAdmission` 未独立检查
blocked；实施时在共享自动领取 admission 增加通过 `taskproperty` 解码的
blocked=true 拒绝，返回 409 `invalid_transition`。这明确补齐优先级候选的
原子准入，不把新增检查误称为基线已有机制，也不改变已取得的 claim。
两个 Worker 不会合法共享同一 active claim；排序选择并不令多项目原子化。

pending 已有远端 grant，必须保持原轮转、启动、容量占用；
优先级高的新 Task 不挤占 pending、运行中、停止未确认、归档或清理责任。
进行中 priority 更新可能使普通执行报告遇版本冲突；报告方读回同一 claim
后按现有安全规则重算更新，不误判撤销、不创建新 Session、不回滚等级。

## Web 交互与能力呈现

生产实现使用共享 `NativeSelect`，不自建另一个菜单体系。
创建草稿增加默认 normal；Task detail 增加独立 priority 选择、保存与反馈；
成功通过 `TaskDetailSessions` 和 committed projection 更新现有节点，不能
重挂详情或整图。普通等级、未知、Goal 无等级是三个不同状态。

徽标采用 `#344054` 文字、中性浅底与可辨识等级图标，完整显示中英名称；
不用 high 红色填充或 urgent 橙色背景覆盖状态。
badge 非交互；详情 selector 与 save 具有 label、焦点和至少 44px 触控区域。
320px 自然换行，不横向滚动，不隐藏依赖、权限或真实状态信息。
已保存值与未提交草稿区分；后台新版只更新确认值，草稿保留并标记需复核。

| 状态 | 行为 |
| --- | --- |
| idle + 可写 | 选择草稿，只有变化可保存；保存时固定 Task/version/账号作用域 |
| pending | 不重复提交，同 Task 其他写入串行化；确认值不提前发布 |
| refused | 原确认值不变，草稿保留，显示可纠正错误与 request ID |
| conflict | 不自动重放；读回当前版本并要求重新确认草稿 |
| unknown | 禁止新写入；查看当前状态。读回仅证明当前事实 |
| read failure | 继续 unknown，保留草稿和可重试读取，不假报成功 |
| scope changed | 旧回执只归原作用域；不污染另一 Task/账号，不清除无关草稿 |
| read-only/terminal/Goal | 普通 Task 等级可读；Goal 无 selector；可访问的禁用原因 |

首期不在 Goal/Chain 标题计算最高等级，也不把 urgent 引起的未执行称为调度
故障。Worker 配置说明改为“同一业务优先级内优先本平台任务”，默认值不变。
Worker scheduling 状态明确为 `priority-v1`、`legacy`、`unknown`，
与元数据可写能力分开展示；不计算未经证实的“全部 Worker 已升级”。

## 混合版本、发布与回退

新 Worker 在新协议成功选择后报告
`scheduling:{"protocol":"priority-v1","observedAt":"...","configurationRevision":"..."}`；
走旧算法报告 `legacy`，未应用/尚未查询为 unknown。
该字段进入现有 Worker report 的**协商投影**，仅
`Daynight-Task-Priority:1` 的 report 允许新字段，Worker detail 也按该 header
输出；无 header 的严格请求/响应保持旧形状。不扩展旧 cloud target schema。
服务保存真实报告，不从版本号或配置目标制造 applied 状态。
报告过期沿用 Worker 可用性窗口后显示 unknown，历史值仍注明历史时间。

| 组合 | 元数据与调度行为 |
| --- | --- |
| 旧客户端 + 新服务 | 旧形状，省略写入保留 priority；可能根本不显示等级 |
| 新客户端 + 旧服务 | 能力不支持/未确认，禁编辑；不把缺字段转普通 |
| 新客户端 + 新服务 | header/projection 协商严格新字段，写入仍受部署门和权限约束 |
| 新 Worker + 新服务 | priority-v1 候选流/版本 claim；报告实际协议 |
| 新 Worker + 旧服务 | 不调用未知候选路径死循环；明确 legacy 模式继续旧调度，报告本地降级；旧服务无法展示新报告则 Web 为 unknown |
| 旧 Worker + 新服务 | 原候选顺序与 claim 继续工作；服务不替它保证跨项目业务优先 |

发布顺序：兼容 schema/服务和关闭的写门 → 新 Worker/客户端 → 核对各 Worker
实际报告与混合风险 → 部署者开放写门。开放门不表示旧 Worker 被封禁；
若用户要求全体强制排序，必须另行确认旧 Worker 新领取准入设计，
不从本方案推导授权。此项是**明确未纳入的产品选择**，不阻碍观察式调度实现。

所有滚动服务实例须先具备新 schema 和协商协议再开放门。
回退先关门并停用新编辑，保留等级数据；Worker 明确回到 legacy。
旧二进制不认识新增迁移会被 ordered-prefix 校验拒绝：
回退包必须包含同一新增迁移身份、保留新字段 CurrentWrite 与旧形状兼容逻辑，
只关闭功能；不能直接运行任意历史二进制、删列或删除 schema_migrations。
灾难恢复从受控备份恢复整库是独立运维决定，不是此功能普通回退。

## 模块责任与增量实施

| 切片 | 负责范围 | 依赖及安全边界 |
| --- | --- | --- |
| A 数据与协议 | core/model/task、store 合同、postgres/task/internal/schema，server/task、protocol/task、service/task；priority/派生列、Go 回填及所有属性写入维护、能力、协商投影、候选 fence 与 claim 暂停重验 | 写门默认关闭；旧服务排空后迁移，旧协议回归先通过；候选不接管旧 list |
| B Worker | CLI api/types/parse、worker remote/coordinator/monitoring；多项目归并、页预算、分组轮转、原责任保护、实际协议报告 | 依赖 A；元数据写门仍可关闭，历史全 normal；旧服务降级显式可见 |
| C 用户入口 | Web API/cache/detail/row/graph/search/my-tasks/i18n；CLI create/update/help/completion；MCP schema/manual | 依赖 A；与 B 组合验证后才开放写门，不扩展容器或列表排序 |
| D 组合验收 | 同一固定整合版本，多 Worker/混合版本、真实 HTTP/存储/浏览器与回退证明 | 依赖 A/B/C；压力独立，确认范围后才开放发布 |

MCP adapter 与 HTTP adapter 只解析、映射；业务校验归 core/task，
权限/Worker 配置/Task 的一致性流程归 service，DAO 接口归 core/store，
SQL/锁/迁移归 postgres。不能把跨模块调度策略放进 handler 或 DAO。
本表是实施建议，不自动创建或启动实际后续任务。

## 验证矩阵

以下是**后续实现的验收要求**，不是本提案已经执行的生产验证。
遵循[测试规则](../writing_tests.md)，不在日常 CI 中跑压力场景。

| 所有者 | 必须证明的观察结果 |
| --- | --- |
| core/task 纯规则 | 四级映射、显式默认、非法值/Goal/终态拒绝、进行中可改、版本先于 no-op、其他字段保全 |
| server HTTP/MCP | 精确 header/参数/schema、null/重复键/未知值拒绝、旧新字段形状、错误码、request ID、精确 int64、取消传递 |
| service/task | 授权 snapshot 中读取配置/fence/页，旧 cursor 拒绝，配置变更、事务结果优先级，原 claim 重验不受排序替代 |
| 真实 PostgreSQL DAO | 新库/旧库迁移等价、数据/权限保留、视图末尾列、索引、rollback/超时/账本；派生列覆盖缺省/true/false/active/completed/删除，所有写入口原子维护；非法属性回填失败，投影矛盾显式失败 |
| 真实 PostgreSQL 分页 | 过滤早于 limit，混合升降序 keyset 无遗漏；字段/前置/父/标签/暂停/claim/删除变化使 fence 失效，旧页不得贴新 fence |
| CLI Worker | 跨项目 urgent 通用胜 normal 专用；偏好开关；同组成功才推进轮转；新增/移除/重启；第 801 条后可推进；重复 cursor/超时/预算/partial/配置变化可见 |
| 并发与恢复 | 两 Worker 同 Task 至多一个 grant；选中 Task 改级冲突；其他项目新 urgent 的观察边界；未知 claim 先 inventory；pending/恢复/归档/清理不抢占 |
| Web 模块/真实浏览器 fixture | 创建/详情/卡片/图/链/Goal成员/搜索/个人列表一致；失败/冲突/未知/读失败/迟到响应/账号切换；焦点/草稿/视口保留；中英、320px/桌面、长文、对比度 |
| 固定版本 API 集成 | 正常创建默认→调级→读取各投影→合法领取；真实服务和隔离 PostgreSQL，不把边界矩阵全搬入 E2E |
| 兼容/发布组合 | 旧客户端新服务不丢字段；新客户端旧服务不假成功；旧 Worker 新服务不虚构保证；混合/未知/离线报告；同迁移身份兼容包回退保留等级 |
| 独立性能运行 | 128 项目、不同历史规模和阻塞密度；EXPLAIN ANALYZE/BUFFERS、写放大、聚合耗时、实际请求≤9P、并发≤4、内存≤P页与head、deadline取消回收 |

性能报告须给硬件、Task/历史/依赖/标签规模、分布、冷暖缓存、p50/p95、
SQL 扫描与锁等待、轮次未完成率。当前没有生产基线，不预填“提升百分比”。
验收要求固定上界可测，且持续静态队列能完成跨轮扫描并领取；若代表性负载
持续达 deadline 导致无领取，D 不通过，必须优化或重审 fence 设计，不能仅
用“单次 SQL 绿色”接受无法推进的调度。
