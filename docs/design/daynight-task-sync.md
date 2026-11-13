# Web 任务缓存与时间窗口增量同步架构

状态：服务端时间窗口接口及完整属性、10s 配置、项目 epoch、认证响应归属和轻量完整 Session 状态集合，以及浏览器 IndexedDB schema 12、权威依赖状态及本地图投影、可见 15 秒、隐藏 5 分钟增量读取和按需详情缓存已实现。详情会话复用任务写操作与未知结果核对，摘要来源以摘要业务版本驱动内容读取，direct 来源使用带 epoch 的实时观察。服务端摘要和浏览器自身字段、详情及图投影共同保留[负责人设计](daynight-task-assignment.md)定义的原生 nullable assignedTo。

[需求](../spec/daynight-task-sync.md)拥有已确认行为。方案使用任务最大更新时间与默认 10 秒重叠窗口，沿用已有业务 version 去重。[服务端决策](../../.agents/notes/archived/architecture/2026-10-24-task-summary-window-api.md)和[浏览器摘要决策](../../.agents/notes/archived/architecture/2026-10-24-persistent-task-summary-cache.md)分别保存协议与本地存储的取舍；[完整属性同步决策](../../.agents/notes/archived/architecture/2026-10-30-task-property-sync.md)保存扩展摘要内容及缓存格式的原因与成本。[轻量 Session 投影决策](../../.agents/notes/implemented/architecture/2026-11-08-task-sync-session-projection.md)保存完整状态集合与窄读取的职责及取舍；[列表接纳决策](../../.agents/notes/implemented/architecture/2026-11-08-task-sync-session-list.md)保存本页唯一生产者、请求绑定基线与 body receipt 的理由；[后台同步决策](../../.agents/notes/implemented/feature/2026-11-11-task-sync-background-polling.md)保存隐藏时调度的取舍。

## 1. 总体方案

服务端实现入口为 `internal/service/task/task_sync.go` 的 `TaskSync.Get`、
`internal/core/store/postgres/task/task_sync.go` 及 `internal/server/task/task_sync.go`；配置在 composition
与应用共享 Engine 提供的 `service/task.SessionStateReader` 一起显式传给 `NewTaskSync(database, engine, overlap)`。`015_task_sync.sql` 提供 epoch 和更新时间索引。
浏览器 `api/task-sync.ts` 严格解码摘要，`task-cache/{database,project-cache,projection}` 拥有存储、生命周期和投影，`useTaskGraph` 保留页面读取接口及调度：按 `document.visibilityState` 选择唯一 interval：可见每 15 秒、隐藏每 5 分钟自动读取，窗口失焦不改变周期。首次挂载（包括初始隐藏）、显式刷新和恢复可见立即尝试；隐藏转换只从转换时刻重建 interval，不发请求或取消在途读取。每次可见性转换清除旧 interval 并从转换时刻重新计时；自动触发遇到活动读取时跳过，显式刷新取消并替换。浏览器节流或冻结使后台周期仅为名义值。详情缓存 `task-detail/detail-cache.ts` 使用同一缓存数据库与身份边界，现有 `TaskDetailSessions` 拥有读取、新鲜度和写结果安装；独立 profiles store 保存人员内容，在线人员清单仍归当前项目内存观察。

```text
首次完整任务摘要 → IndexedDB → 本地图 / 列表 / 统计
                       ↑
客户端摘要最大 updatedAt → 服务端减去配置窗口 → 返回匹配任务摘要
```

同一 HTTP 响应另含全项目当前适用 Session 的完整最小状态 map；Task 水位不筛选该集合。`useTaskGraph` 在同一次同步接纳后将它交给稳定的页面 Session store；该 store 仍拒绝隐藏时的 Session 观察，列表不再逐 Task 读取 Current。Session 状态不改变水位、Task version、properties 或 epoch，也不进入持久缓存和普通 Task 通知。

客户端只把已成功合并的项目同步摘要用于计算水位。服务端读取当前任务事实，不保存历史变更流，也不承诺依次返回每个业务版本；一次同步可以从 v5 直接读到 v7。重复行是协议正常部分；前端借助任务已有 version 判断是否替换内容。

| 现有机制 | 用途及证据 |
|---|---|
| 项目行锁与同事务写入 | [project_tx.go](https://github.com/codetreker/daynight/blob/c418168859a6ebf23fda95ed150767a72e3956ea/packages/daynight-server/internal/core/store/project_tx.go#L32-L124)在锁后写 version/updatedAt 与依赖，继续使用 |
| REPEATABLE READ | [snapshot.go](https://github.com/codetreker/daynight/blob/c418168859a6ebf23fda95ed150767a72e3956ea/packages/daynight-server/internal/core/store/snapshot.go#L14-L31)提供一次响应的一致集合 |
| 可见页面调度与稳定引用 | [useTaskGraph.ts](https://github.com/codetreker/daynight/blob/c418168859a6ebf23fda95ed150767a72e3956ea/packages/daynight-web/src/features/projects/useTaskGraph.ts#L27-L111)保留刷新优先级、取消与视图接口 |
| 完整图投影 | [model.ts](https://github.com/codetreker/daynight/blob/c418168859a6ebf23fda95ed150767a72e3956ea/packages/daynight-web/src/features/task-graph/model.ts#L48-L145)继续校验图、统计与链结构 |
| 按需详情会话 | [useTaskDetail.ts](https://github.com/codetreker/daynight/blob/c418168859a6ebf23fda95ed150767a72e3956ea/packages/daynight-web/src/features/task-detail/useTaskDetail.ts#L5-L35)保留操作所有权与新鲜读取限制 |

## 2. 水位、窗口与查询

对每个用户/项目，保存摘要缓存中精确最大的 updatedAt，记为 M。服务端配置 W 默认 10 秒：

```sql
SELECT <任务自身摘要字段及完整依赖>
FROM tasks
WHERE project_id = $1 AND updated_at >= $2
ORDER BY created_at, id;
-- $2 = 客户端 since 减去服务端 TaskSyncOverlap
```

M 原样保存，不预先减窗口。服务端每次应用当前 W。边界使用 >=；不增加当前请求时间上界。没有任务时 M=null，不填 1970 等默认时间，下一次无 since 读取全部当前摘要。

只从项目同步接口成功接受的摘要计算 M。单任务 GET 或写响应即使包含更大的 updatedAt，也不能推进 M：例如未读的任务 A 更新于 10:01，单独打开 B 得到 10:05；若把 B 的时间作为项目水位，就会跳过 A。

响应时间、请求开始时间、浏览器时间、Project.updatedAt 和显示 observedAt 均不作为水位。空响应和只有重复版本的响应不推进 M。正常时间下 M 随新任务数据前进；它不是额外的单调版本序列。

现有项目锁让同项目正式写入按顺序执行，updatedAt 在取得锁后生成。因此在数据库时间不倒退的前提下，已提交且返回的更晚任务时间无法越过一个未提交的较早任务。不能套用请求时间水位的长事务反例来否定本方案。

最后窗口中的任务可能在没有新变化时持续重复返回，这是已确认取舍。窗口不保证任意墙钟回拨和原始 SQL 维护的同步正确性；历史替换使用 epoch 重建。updatedAt 与业务内容继续在同一事务更新，不增加提交后的独立写入或 outbox。

## 3. 配置与最小存储

`Config.TaskSyncOverlap time.Duration` 从 `DAYNIGHT_TASK_SYNC_OVERLAP` 读取，默认 `10s`；接受 `30s`、`1m` 等正 Go duration。沿用 [config.go](https://github.com/codetreker/daynight/blob/c418168859a6ebf23fda95ed150767a72e3956ea/packages/daynight-server/internal/server/config.go#L38-L104)的环境配置与严格正 duration 规则。非法值使启动失败。窗口属于服务端配置，查询不能覆盖；各服务实例使用同一配置。

server README 的环境表与 localhost/dev-ci 部署配置共同公开该项。配置增大将多返回重叠行，减小将缩小回看范围，均直接用于后续请求；客户端保存原始 M，无需转换。

数据库仅需：

```sql
ALTER TABLE projects ADD COLUMN task_cache_epoch uuid
  NOT NULL DEFAULT gen_random_uuid();
CREATE INDEX tasks_project_updated_at_id
  ON tasks (project_id, updated_at, id);
```

epoch 标识需要完整替换的项目任务集合；受支持的数据历史替换和 Task 软删除轮换它，其他普通任务修改和服务重启不更新它；已有任务 updated_at、version 不增加另一组同步列。新建与旧项目由迁移/default 获得各自 epoch，不添加 foreign key。

已有 task.version 继续用于任务写入与详情内容。epoch 不参与增量定位；本地 userFence/cacheGeneration 只用于身份和失效生命周期。协议没有项目同步 revision、任务同步 revision、不透明 cursor、fromRevision 或 requestAt。

## 4. HTTP 协议

```http
GET /api/v1/projects/{projectId}/task-sync
GET /api/v1/projects/{projectId}/task-sync?epoch=<uuid>&since=<UTC timestamp>
```

只允许可选 epoch、since，拒绝重复、空值、未知和无效参数。since 使用与 API 相同的 UTC 精确时间规则，必须伴随 epoch；epoch 单独存在表示已有空项目基线。客户端不能设置窗口。

```ts
type TaskViewRecord = {
  id: string;
  version: string; // 已有业务 version，规范正 int64 十进制
  properties: TaskProperties; // 完整 JSON 属性对象，保留实际键
  tags: { id: string; name: string }[]; // 当前自身标签引用
  titlePreview: string;
  titleTruncated: boolean;
  status: TaskStatus;
  dependsOn: string[];
  externalDependsOn: string[];
  allowAgents: boolean;
  requiredPlatform: "windows" | "linux" | "macos" | null;
  assignedTo: string | null; // 原生负责人 UUID；服务端和浏览器均要求字段存在
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
};
type TaskSync = {
  mode: "snapshot" | "delta";
  epoch: string;
  project: Project;
  actorAccess: ProjectAccess; // 当前主体的真实归属、owner Team 与完整权限来源
  assigneeVersions: { userId: string; version: string; hasProjectAccess: boolean }[];
  observedAt: string;
  tasks: TaskViewRecord[];
  dependencyStates: Record<string, { taskVersion: string; blockedBy: string[]; ready: boolean }>;
  sessions: Record<string, "working" | "notice" | "warning" | "pending">;
};
```

| 请求 | 结果 |
|---|---|
| 无 epoch | 完整 snapshot |
| epoch 不同 | 完整 snapshot，替换旧历史 |
| 相同 epoch 且有 since | delta，返回 updatedAt >= since-W 的最新行 |
| 相同 epoch 且无 since | delta，返回全部当前摘要；用于空基线 |
| 无效参数或 since 缺少 epoch | 400 invalid_input；不猜测日期或补默认值 |
| 项目缺失/非成员 | 404 not_found |
| 数据库查询或事务完成失败 | 500 internal_error，优先于已发现的业务拒绝 |
| 请求取消 | 沿用真实取消行为，不降格为空数据 |

在一次现有只读 REPEATABLE READ 快照中计算当前主体准入，将现有
`RequireProjectRead` 返回值保存在必填 `actorAccess`，再读取 Project/epoch、
匹配摘要、完整属性、完整 assigneeVersions 和 observedAt。GET access 与该字段共用
[本人权限投影](daynight-auth.md)；即使空 delta 也返回同一快照的实际角色与 grant，
同一快照内的 assigneeVersions 复用项目人员资格查询，只输出规范 userId、资料内容 version 和当前 hasProjectAccess，按 UUID 排序去重；资格、版本与失败规则由[负责人设计](daynight-task-assignment.md)拥有。每轮读取并散列合格人员资料，CPU/数据库读取成本为 O(人员数 + 资料总字节)，清单传输为 O(人员数)；它不传姓名或头像，也不依赖登录更新时间、Task version 或访问状态来伪造内容变化。清单失败使整个同步失败。全部状态都参与同步。assignedTo 由同一任务行直接投影，字段必填且明确为 null 或规范 UUID，不依赖用户资料或属性解码。store 关闭匹配任务 rows 后，以全部选中 task IDs 的一次 `ANY` 查询批量加载完整属性，空属性为 {}。选定任务的标签引用也在关闭结果集后一次批量加载，空集合编码为 `[]`。任务、属性和标签属于同一快照，查询次数不随命中任务、属性或标签数量线性增长；授权先于这些读取。标签改名与删除 touch 关联条目的版本和时间，沿用普通增量及任务水位，不轮换 epoch。

属性读取直接装入已规范化的 `json.RawMessage` map，不重复定义注册表的结构校验或规范化；查询、扫描、自然解码与编码以及事务完成错误沿原链路传播。独立的 Session source 查询只读取全项目适用 Task 的 Worker 属性及窄 Session 标量。完整响应包含 `sessions`，不设置读取节点、边或字节预算；协议仍一次返回完整 snapshot/delta，不引入分页或中间发布。完整 assigneeVersions 及匹配摘要由当前请求物化，读取成本随实际集合增长，不承诺固定内存上限。[批量读取决策](../../.agents/notes/implemented/simplification/2026-11-09-task-canonical-batch-reads.md)拥有职责取舍。

`dependencyStates` 是必填非 null 的普通 Task 派生状态 map。snapshot 覆盖全部可见普通 Task；delta 仅包含自身或直接前置的 updatedAt 命中同一窗口下界的可见普通 Task。每项 `taskVersion` 是所属 Task 的精确十进制版本，`blockedBy` 是未满足的直接前置 ID 数组，`ready` 沿用 Task 自身规则，不受父 Goal 状态影响。每条普通 Task 摘要都伴随同版本状态；空集合为 `{}`，空阻塞数组为 `[]`。一次批量 SQL 在相同快照读取保留的物理前置事实，隐藏的 done/cancelled 前置仍满足，隐藏的未结束前置仍阻塞。读取和事务失败使整个同步失败。Web 严格解码并持久化该 map，依照所属 Task 版本合并。

map 的键和 `blockedBy` 元素是规范 Task UUID；`taskVersion` 为正 int64 的规范十进制字符串，`blockedBy` 按 ID 排序且属于该 Task 的 `dependsOn` 子集。普通 Task 的 `ready` 等价于 status 为 `todo` 且 `blockedBy` 为空。同版本状态可能反映不同前置观察，跨响应乱序时旧状态可能晚到；该协议不提供派生状态的严格全序。后续相关变化或完整 snapshot 可刷新它，但不保证下一轮轮询必然修正。

TaskStatus为proposed/todo/in_progress/done/cancelled五态，cancelledAt为必需nullable字段；仅cancelled有值。摘要必须保留 GraphTask 的 assignedTo（明确可空 UUID）、requiredPlatform（明确可空）及 allowAgents；缺失字段作为协议错误，不能补默认值。返回排序为 (createdAt,id)，依赖数组按 ID。任务摘要 version 字符串严格解码为 bigint；Project.settings.version、Project.ownership.version，以及 actorAccess 中的 ownership.version 与
directGrant.version 的 JSON number 分别在已知子树中无损解码。Project 内在字段必含
ownership:{teamId,version}，owner Team 名称和 actorAccess 不进入 Project 持久记录。
存在的 grant 必须属于请求项目和已核对的实际用户，role 与 effectiveRole 分别校验。properties 必须是对象，缺失、null 或数组均拒绝，通用 parseTaskProperties 保留客户端未知的全部键；属性内同名 version 保持普通 JSON 值，不递归转成 bigint。缓存字段不得缺省。GET/HEAD、no-store、错误信封与请求取消保持。task-sync 的完整项目摘要范围独立于[按任务查询的 task-graph](../spec/daynight-server.md#任务链图查询)；后者不能提供完整项目摘要或替代缓存基线。

认证边界为实际认证后的响应写 `Daynight-User-ID`，覆盖同步、详情、写结果及认证后资源错误。缓存发布前与当前身份核对；401 沿用会话失效流程。该头来自 model.Principal，不能回显客户端输入。

### 服务端 Session 状态投影

`core/store/reader_session.go` 定义只读 `SessionReader.CurrentTaskSessionSources` 与内部 `TaskSessionSource/TaskSessionStateSource`，由 `SnapshotScope.SessionDAO()` 提供。`store/postgres/session.NewReader(tx)` 与其他 Reader 绑定同一个只读 Repeatable Read 事务，读取能力不要求会话锁定或写入。`TaskSync.Get` 在已有主体校验、RequireProjectRead、Project 和 ReadSync 全部成功且无 refusal 后才读取 Session source，再通过消费方定义的单方法 `SessionStateReader.TaskListSessionStates` 读取状态；应用组装注入已有共享 Engine，TaskSync 不依赖 Engine 的完整内容和生命周期 API；数据库快照成功完成后才返回。权限或项目拒绝不能触发 Session 查询。

查询独立于 `since`，覆盖项目未删除的 `in_progress` Task，只取当前 `worker` 属性，以及与 task scope、web backend 和当前 claim 关联的 Session 身份、fence、生命周期、LastSeen 与 DrainUntil。`task_properties.value` 是 TEXT，claim 关联用 `(value::jsonb)->>'claimId'` 并将右侧转换为 UUID，以匹配既有 `(project_id, task_id, claim_id)` 唯一键。Worker 属性与所需 Session snapshot 标量使用普通 typed `json.Unmarshal`，不重复 Normalize/Validate/Admit、字段合法性或容量检查。写入入口仍拥有 Worker 与 Session 结构及规范 fence 表示；读取保留实际 Task/Worker/Session 绑定和 live fence 的必要比较，正常解码错误继续传播。查询不加载其他属性、controls、registration、grants、目录、source history、操作记录或操作存在性检查；不使用 `FOR UPDATE/FOR SHARE`，不另开事务。

`core/session/task_list_states.go` 的共享 Engine 只复制已提交 `liveCell.value` 中的 ControllerFence、ConnectionState、Synchronized 与 Activity。它短持 registry mutex 捕获 cell 引用后释放，再逐个锁 cell、复制标量并立即解锁；若重验 registry 引用，在 cell 解锁后进行，避免 cell→registry 的嵌套锁顺序。读取通过既有空 `BeginOperation`/`Close` 保持 Engine admission 与 Stop 的所有权，不调用 `Operation.content`、`cloneLive` 或创建 live draft。取消在请求及逐 cell 边界检查；Go mutex 等待本身不能被 context 立即中断，不能用分离 goroutine 掩盖该限制。读取不会持有 cell 锁执行 SQL、响应编码或另一个 cell 的工作。

Task、Worker 和持久 Session 来自一致的数据库快照；live 是逐 cell 观察到的最近已提交值，并非跨数据库和内存的原子快照。可靠持久绑定以及 matching fence 防止把另一执行的活动归给本 Task。期限使用本批 Engine 时刻及数据库持久 LastSeen，不能用 live.LastSeen 替代；heartbeat 使用严格 `>30s`，drain 使用到期包含边界。无本机 live 或 fence 不匹配保持既有 disconnected/false/unknown 归一化，多实例读取不增加状态总线。

按以下顺序判断，先建立可靠关联，再应用既有生命周期与活动语义：

| 条件 | `sessions[taskId]` |
|---|---|
| 非适用 Task/Worker、当前 Session 缺席或持久执行身份不匹配 | 省略键 |
| active、未断线且 activity=unknown | 省略键 |
| 生命周期非 active，或 disconnected | `warning` |
| 尚未 synchronized，或 connectionState 不是 connected | `pending` |
| connected、synchronized、waiting_input | `notice` |
| connected、synchronized、idle/stopped | `warning` |
| connected、synchronized、working | `working` |
| 其他合法初始化状态 | `pending` |

`pending` 保留可靠会话入口而不提供角标。省略表示无可靠贡献；HTTP 或存储失败不能转换为省略、pending 或成功 `{}`。Provider 继续负责 waiting_input 归一化，不从 canRespond 推测待处理交互。disconnected、idle、stopped、draining 和 archived 会话只要仍关联进行中的 Task 就继续参与；live 缺失和 fence mismatch 经断线归一化后产生 warning。

`model.TaskSync`、公开 `api.TaskSync` 及 HTTP converter 必须保留 producer 创建的非 nil map；没有贡献时正常编码 `{}`，converter 不用 nil→空对象回退掩盖 producer 错误。每轮返回完整 Task 状态集合，`tasks=[]` 仍重算；map 的处理和响应字节随适用 Task 数量增长。Task 属性一次批量读取，Session Worker 属性使用独立窄查询和普通解码，不复查存储规模或响应字节容量。

该读取不持久化归档 marker 或推进 drain，不新增 sweeper。现有 Current、Controller admission、Session 权限和归档入口继续执行各自期限与存储规则；轻量集合不授予内容或控制权限。查询、codec、Engine admission、取消及事务完成错误沿用 task-sync 的错误链和优先级，不增加 Session 部分失败协议。现有浏览器列表读取、聚合、入口和新鲜度仍由[Session 状态设计](task-session-status.md)拥有。

### 浏览器 Session 状态接纳

`api/types.ts` 定义必填 `TaskSync.sessions` 与本地 `TaskSyncRead {sync, receivedMonotonic}`。`getTaskSync` 的成功 reader 在 `await response.text()` 完成后立即记录 `performance.now()`，随后才共用 Task graph 文本解码、执行 source scan、精确字段解码及 `parseTaskSync` 校验。四态集合要求普通对象、规范 Task UUID 键和严格合法值，不设置任务条数上限，不接纳缺字段、null 或空对象 fallback。非成功响应沿用原 decoder 与 `parseServerError` 原 JSON 值；其它 API 与 relations decoder 保留各自合同。receipt 不进入 HTTP JSON。

`task-cache/execution-binding.ts` 的 `TaskExecutionBinding` 保存 Task status，以及 Worker 的 claimId、workerId、worktreeId、state 与 agentControlMode，缺少 Worker 明确为 null。`TaskSyncTicket` 扩展原 SyncTicket，将这些 slim bindings 从 beginSync 已有的完整 stored Tasks 读取结果建立为不可变 map，与 epoch、水位和 manifest 位于同一事务；不增加事务、持久字段或 Session version。`deriveTaskSyncBindings` 对 snapshot 从响应 Tasks 建立基线，对 delta 使用 ticket.taskBindings 并覆盖响应实际 Tasks。`applySync` 继续按版本合并此刻的持久集合，但该最终集合不能反向改变响应的执行观察。

`useTaskGraph` 保留唯一项目 HTTP 调度与原有 history/applySync 顺序，拥有稳定的 `TaskSessionSummaryStore`。HTTP 前捕获既有 `authRequestsPauseRevision()`，每个 await 后重验取消、请求代次与 scope；仅当 pause revision 未变化时，通过 `Store.replace({project: result.project, observedBindings, sessions, receivedMonotonic})` 发布本次 Session 观察。暂停后恢复不能让暂停前响应重建已撤销贡献；该 gate 不改变原 Task 应用、图发布或 auth shell。结果 manifest 的 userFence、cacheGeneration 和 epoch 必须仍获当前项目准入；snapshot 新建的 generation 用实际结果核验，不要求等于旧 ticket。store 经 ProjectPage、ProjectTaskWorkspace 和 TaskSessionSummaryProvider 传递，Provider 只负责 context 与展示活动。

状态值与完整 map 的键缺席使用相同 observed/current eligible binding 比较；旧 claim 的状态及缺席都不能影响较新执行或续期它的 receipt。其它 cache producer 和标签页只通过既有 Task 通知撤销不匹配绑定，不向本页发布 Session map。响应 key 不属于其 observed eligible Task 为协议错误。entry 的 30 秒期限从 API body receipt 起算，发布前、恢复展示与文档可见时复核；解码和 IDB 延迟不续期。普通在途同步保留尚有效状态，当前失败、auth pause、scope 失效和执行变化撤销相应贡献。

状态只在页面内存通知自身消费者，不进入 summaries/details、Task properties、version/updatedAt、BroadcastChannel 或普通 CacheEvent，不新增正文重读或图计算。原有 applySync 的 Task 工作执行一次。链聚合仍包含根任务及折叠/筛选隐藏的全部普通成员，外部前置链排除；pending 保留入口，warning > notice > working 优先级及原 UI 保持。详细期限、聚合和交互由[Session 状态设计](task-session-status.md)拥有。

## 当前权限的内存发布

`useTaskGraph` 在响应 principal、当前请求及 scope 生命周期验证和成功应用后，把
actorAccess 发布给同一项目的内存权限 Provider；持久 applySync 仍只处理内在 Project、
摘要和详情。provider 覆盖项目弹层、设置/成员以及独立 Task/附件路径，绑定既有
TaskCacheScope 和用户/项目生命周期，不增加第二份持久缓存或单独更改缓存 schema。

图页面的首次和周期 TaskSync 提供角色。没有 TaskSync 的设置/成员页面首次读取
GET access；每次成功观察重置可见三十秒 fallback。该 fallback 隐藏时暂停，恢复可见、focus 和管理
操作前重验；并发 GET 合并。每个实际读取在派发前捕获观察顺序与作用域，迟到的 GET
或 sync 不得替换较新成功观察，管理重验期间旧观察也不能解除提交限制。

GET access 在发送 HTTP 前通过现有 `scope.beginSync` 捕获真实 user fence 与项目
cacheGeneration，覆盖仅有磁盘历史或在途首次同步、尚无在线内存投影的冷 scope。
可信当前 not_found 先按原 ticket 核对 `canRevokeProject`，再由既有 `revokeProject`
同步退役该代际并清理对应内容；迟到的旧 delta 不能重新授权该代际或恢复缓存详情。
已经替换为新代际时忽略旧 denial，不能在收到 404 后重新取得新 ticket 并撤销它。
权限与生命周期读取失败都保留 stale/error 和重试，管理提交等待有效核验；普通网络错误
不作为撤权。现有缓存存储不可用时，这一生命周期准备也会明确失败，不构造默认权限。

权限不参与图内容相等比较，不推进水位，也不写入 Project manifest、summaries、details
或广播内容。claim owner 的资料读取沿原项目名册所有者保留，并与本人操作资格分开。

## 5. IndexedDB 与去重

采用固定的 `idb@8.0.4` 薄包装，数据库 schema 为 12，保留显式事务所有权。[固定上游 README](https://github.com/jakearchibald/idb/blob/654c746bef13f9fe7f5871e03ac58015cebace5a/README.md)说明事务 active 生命周期与 tx.done；不引入 Dexie live query 或第二个 UI 状态所有者。原生 API 需要自行包装事务完成，idb 复用原生模型且提供类型化 Promise。

schema 12 在严格解析前于升级事务中清空 projects/summaries/details 及水位，以移除缺少必需标签引用等不兼容表示；完整 snapshot 重新建立 Task 基线，并可清除项目的可重取 Session 目录。升级保留 userScopes、profiles 和兼容 Session 目录。从 schema 1–4 升级同时轮换 userFence，从 schema 7 升级清除缺少完整空证明的 Session 目录。缺少必需字段的旧记录不能补默认值。旧标签页在 versionchange 关闭连接，旧 fence 的在途响应不能跨升级发布。升级失败回滚，不部分清除旧数据库。

同源数据库 `daynight-task-cache`：

| store / key | 内容 |
|---|---|
| userScopes / userId | 持久 fence UUID，退出/换号后轮换并保留 |
| projects / [userId,projectId] | active/invalidated、invalidatedBy、userFence、cacheGeneration、generationAncestors、unknownAncestors、epoch、Project、maxUpdatedAt/null、taskCount、edgeCount |
| summaries / [userId,projectId,taskId] | 已接受的 typed 任务自身摘要、完整 properties、业务 version 与独立 dependencyState；Goal 的状态为 null |
| details / [userId,projectId,taskId] | userFence、cacheGeneration、完整任务自身内容及业务 version、byteSize、lastUsedAt |
| profiles / [userId,projectId,profileUserId] | 查看者 userFence 与 profile {userId,version,name,avatarUrl}；不保存 hasProjectAccess |
| sessionHistory / [userId,projectId,taskId] | userFence、cacheGeneration、首页记录及 nextCursor、完整空证明、保留和并发控制元数据 |

`lifecycle.ts` 统一验证用户记录与两类 manifest：userId/projectId 必须匹配请求归属，userFence 和 cacheGeneration 必须是规范 UUID，代际祖先必须是不重复且不含当前 generation 的规范 UUID，缺失表示旧格式的空链；unknownAncestors 标明损坏使更早前驱不可证明。计数必须是容量上限内的非负安全整数。active manifest 要求 invalidatedBy=null、合法 epoch/Project，且 taskCount 为零当且仅当 maxUpdatedAt=null；invalidated manifest 要求明确的 access/corrupt/user 原因、epoch/project/maxUpdatedAt 全为 null、taskCount/edgeCount 全为零。失效状态不能保留可用于增量请求的旧 epoch。

普通 Task 的派生 ready/blockedBy 与所属版本保存在摘要记录的独立状态中；详情正文仍不持久化派生值。不把 bigint 当作 IDB 键，也不 JSON.stringify bigint。`projects` 的 `by-user` 索引支持用户清理；`summaries`、`details`、`profiles`、`sessionHistory` 的 `by-user` 与 `by-project` 索引支持定向读取和清理。`TaskIntrinsicDetail = Omit<TaskDetail, "ready" | "blockedBy">` 固定详情存储边界，保留 assignedTo、description、完整 properties（保留实际键，worker 缺失表示没有保留归属）及精确业务 version。

`TaskCacheProvider` 在认证分支内、`TaskDetailSessionProvider` 外提供同一个 `TaskCacheScope`，同时覆盖项目页、独立任务页和附件路径页。scope 以用户与会话 generation 隔离；普通同用户核验保留它。`beginSync` 返回 epoch、水位和含同事务 Task 执行绑定基线的 TaskSyncTicket，`applySync` 原子应用响应，`readProject` 读取实际持久集合，`canPreviewProject` 根据已观察的项目撤权与 authorizedProjects 判断是否允许本地摘要预览，`getAuthorizedProject` 只返回本 scope 已获在线准入的内存投影。`getSummaryVersion` 和 `subscribe` 提供精确业务版本与变更通知；`detailTransaction` 在相同 fence/generation 校验后开放共享数据库内的详情事务。`readProfiles` 与 `writeProfiles` 复用当前用户和项目 ticket 校验；损坏资料会在事务内定向清除当前项目 profiles 并返回错误，保留任务记录，后续 Retry 重新补读；持久资料只带 userFence，当前 cacheGeneration 约束读取、写入与发布，允许任务 epoch 更替后由新在线清单验证相同内容再复用。assigneeVersions 只保存在本挂载已授权 CachedProject 中，本地 preview 或跨标签页读取的新 generation 尚无本页在线观察时为 null；磁盘内容不能恢复这一资格观察。人员所有者采用新的 userFence/cacheGeneration 后立即撤回旧显示和目录 ready 状态，即使新清单为 null 也先撤回；同 userFence 原始内容可保留，等待新在线清单验证，不沿用旧访问标记。

Session 记录目录复用共享 scope 的事务及身份准入，按用户、项目、任务保存成功首页及其原始 nextCursor，并独立保存遍历后确认完整空目录的证明；首页为空且有 cursor 本身不能证明全部为空。对已确认空目录重新激活时，若刷新首页为空且仍有 cursor，后台继续读取后续页，直到发现记录或真正耗尽，保持原首页及 cursor 供分页一致性校验；已观察到的非空后续页受令牌和独立标记约束，旧的空结果不能覆盖该观察。每项目最多保留 32 项、总计 2 MiB，单项上限 256 KiB；按最近使用时间淘汰可释放的记录。每任务 30 秒单持有者租约与令牌协调跨标签页刷新，成功、失败或取消后通知同 scope 与其他标签页，超时允许接管；正常存储路径的写入必须匹配有效租约，迟到响应不能覆盖较新内容。清除标记不被淘汰；普通缓存写入保护活动租约，可信拒绝需要写清除标记时可以淘汰租约。全部槽位由清除标记占用时轮换缓存 generation，保留项目、摘要与授权并清除旧代际详情和目录；受保护槽位同时包含活动租约且没有空位时，读取等待租约结束或到期后重试。缓存仍可读但刷新或分页所需事务写入失败时，保留已有有效内容并显示错误和重试，不发布无法确定跨标签顺序的新成功响应。存储完全不可读写时仍允许已认证网络结果按下述有限降级显示。清除或代际轮换的存储写入失败时，存活标签通过匹配身份与代际的广播和内存围栏保守撤下目录并提供重试；收到失效后旧在途请求不能重新发布。IndexedDB 完全不可读写时，较旧的撤权提示若晚于另一标签的新网络成功到达，接收者无法确定先后，可能保守隐藏较新的目录。若撤权时所有持久媒介均不可写且全部相关标签关闭，内存围栏无法跨重启保留，旧目录可能在下次网络撤权响应前短暂显示。scopeRevision、userFence 和 cacheGeneration 约束读取与发布。用户清理、项目失效及 snapshot 替换清除相应目录；目录内容不授予项目访问或实时 Session 控制。页面读取及刷新行为见 [Herdr Session 页面设计](herdr-session-web.md)。

### 每轮应用

1. 当前身份通过核验后读取本项目 M/epoch 及生命周期 fence。首次本地集合有效时，在网络响应前发布完整摘要供概览、列表和图浏览，随后后台同步；有效空项目也发布，没有有效集合时保持加载态。仅本地摘要不增加 scope 的在线准入，也不获得详情正文或写权限。解码、身份验证与网络等待在 IDB 事务之外。
2. 开一个共享缓存 store 的 readwrite 事务，验证用户记录及项目 manifest，重读 userFence 与项目 cacheGeneration，要求仍与请求时的生命周期相符。初次缺失用户记录也先建立新的持久 fence；重置/注销后的迟到请求不能重新创建已清理内容。beginSync、applySync、readProject 和 detailTransaction 共用该验证与用户恢复边界。
3. active 项目先校验当前持久集合的 taskCount、edgeCount 与精确最大 updatedAt 是否等于 manifest，并验证行归属、类型和图结构。少一条独立任务也属于损坏；不能把更小集合重新计数后视为正常。校验失败中止本次应用，使基线 invalidated 后无 since 完整重建。校验通过后，delta 从**此刻的完整持久摘要集合**按 id 与业务 version 合并。更高版本替换整条摘要和完整属性对象，缺失键自然删除；相等版本保留原内容且全部自身字段及属性必须一致；较旧版本忽略，不能复活已删除键。同一 epoch 的 delta 中，Project 的 settings 与 ownership 分别按各自版本合并，迟到的旧设置或归属不得回退；相同 ownership.version 的 teamId 必须一致，矛盾字段使同步失败。合并保留两种关系各自最新的观察，不从 Task.version、updatedAt 或 access 推算归属。
4. intrinsic 合并后，逐条状态仅在 taskVersion 等于当前所属 Task version 时采用；其他版本只跳过该条状态，delta 未出现的键保留原状态，snapshot 替换集合。按所属 Task 校验阻塞子集与 ready 基本关系，不用其他响应的前置状态交叉校验。状态变化即使自身版本不变也持久化并发布。从合并集合重新计算精确 maxUpdatedAt 和统计并完成图校验。只写真实改变的行、对应详情失效与确有变化的元数据；摘要与水位一起提交。snapshot 在生命周期仍匹配时完整替换 Project 与任务并更新 cacheGeneration，保留同 userFence 的人员内容供新清单校验。新 epoch 表示新的服务端历史，恢复后的 ownership/settings 版本可以更低，不能与旧历史合并。
5. 等 tx.done 后发布实际合并的快照。自身字段和状态均未变化的重复行不重写、不触发详情失效，不改变可见任务/索引/布局引用；仍能提供本页新的访问确认、完整人员版本清单与时钟样本。

仅比较 M 是否相等不足以保证内容 CAS：不同任务或任务版本可以共享时间戳。本方案在串行的 IDB 写事务内读取并合并当前集合，不增加另一套本地提交序号。事务内只等待 IDB 请求并做有界纯计算，不等待 fetch、timer 或异步 crypto。每轮可能读取和验证全部本地摘要及属性，其成本随实际任务、依赖和属性内容增长；这个成本实测，不声称本地工作量严格为变化量。网络、HTTP、解码和 IDB 配额/提交失败不安装部分摘要或推进水位，保持旧有效缓存与明确错误。

项目 manifest 不合法或完整摘要集合损坏时，先定向清除本项目摘要/详情、建立符合 null/零值约束的新 invalidated manifest 及 cacheGeneration，再无时间边界取 snapshot。相同 epoch 的空项目后续走 delta，不因重复空集合不断轮换 generation。

### 多标签页与广播

各挂载项目页面独立维持可见 15 秒、隐藏 5 分钟轮询，无选主。IDB 写事务排序与当前集合的 version 合并防止自身字段被较旧版本回退；同一版本的依赖状态不具备跨响应全序。只在任务自身内容、依赖状态、设置、归属或生命周期实际变化后广播轻量提示；重复结果、显示时钟、纯读取不广播，也不转发提示。

普通变更提示在提交后触发，接收方重读当前持久集合，不仅因提示再发网络。它不授予首次访问或提供可复用的时钟锚；已打开页沿用本页样本，下一正常周期重新同步。负向撤权提示在确认可信 not_found 后立即发送，不等待持久清理；其匹配、暂停期间处理和 CAS 清理见第 7 节。两类提示都不转发，不包含任务正文。

## 6. 投影、时钟与详情

sameSummary 对包括 assignedTo 和标签引用在内的全部自身字段进行比较，并复用 sameTaskProperties 比较全部属性键及 JSON 值；属性对象成员顺序不影响结果，属性数组顺序有意义，缺失、[] 与 null 不相等；标签按 ID 和名称的集合比较。summaryOf(detail) 保留 assignedTo、标签引用和完整属性，详情与摘要的同版本检查使用同一比较，不另用 JSON.stringify 判断键序差异。

projectSummaries 从全部 typed 摘要中选择普通 Task，以匹配版本的权威依赖状态物化 blockedBy 和 ready，并计算 summary，再由 buildGraphIndex 生成完整普通组件和独立任务分类。图节点剔除 version、properties 与 tags，完整摘要和包括 Goal 的版本 map 保留资源存在性。缺失前置的引用保留，仅连接可见端点；普通依赖决定可见链成员，不合成隐藏节点。重复 ID、环、状态关系及统计均须校验后一次发布，不能呈现半批图。

精确比较 UTC 秒部分、补齐到九位的小数及规范 ID，保留原字符串；不能以 Date.parse 毫秒或可变小数的原始字典序排序。时间水位也用相同精度计算。

仅本地摘要的 GraphSnapshot 没有成功接收时间或服务端时钟样本，revision 为 0；最近刷新标签、运行中耗时与可能卡住提醒等待实际响应，已完成耗时仍使用持久起止端点。概览的近期分类在此期间使用本机墙钟作为暂时当前时刻，首个成功响应后切换为服务端与单调时间；本地自然日边界继续使用浏览器时区，不把本机时间用于执行耗时或同步水位。每次成功实际响应的 observedAt 与 body 读取完成、解码前立即取得的本页 performance.now 接收值配对，独立推进 TaskExecutionClock；JSON/source 解码、校验和缓存等待沿用同一 receipt。observedAt 不参与 M。磁盘和跨页广播不能提供可复用的单调锚点；设置及自身字段和依赖状态均重复的摘要保持已发布图索引身份。`GraphSnapshot.revision` 的正值是本挂载每次成功同步的 receipt，不是任务版本、水位或持久提交序号。它提供当前挂载的访问准入和失败恢复机会，正常重复 receipt 不使匹配详情重新 GET。跨页读取沿用本页已取得的时钟 receipt。

### 详情内容、版本与读取

`TaskDetailSessions(scope)` 复用认证 scope 的 `beginSync` 和 `detailTransaction`，保持 status、allowAgents、paused 解除、requiredPlatform、assignedTo 与软删除写操作的同一所有者；状态写入仍使用 PUT /tasks/{taskId}/status，删除使用 DELETE task。当前历史的可信 `410 task_deleted` 只清除该任务正文并触发项目同步，不进入 `not_found` 的项目撤权分支；未知删除结果只经 GET 核对。删除终态绑定确认时的 cacheGeneration。后续已授权的新 generation 完整快照同时恢复活动节点与摘要时，解除该终态并强制 live GET，成功前禁写；状态、许可、暂停解除、平台、负责人和删除的所有结果统一检查当前操作所有者及历史准入；旧历史迟到结果不能修改恢复后的详情、覆盖较新操作反馈或解除其共享写锁。原有 principal 与项目撤权继续采用捕获 scope/ticket 的检查。`useTaskDetail(projectId,taskId,revision,observedTask)` 保留调用形式，从 scope 读取摘要业务版本和项目 generation。可显示内容同时要求本次挂载的 revision>0 和 scope 当前仍授权的项目 generation；其他页面的集合不能替代本次 receipt，旧 receipt 也不能绕过已经撤销的 scope 准入。revision=0 的本地摘要挂载只在 hook 中隐藏正文和阻止新操作，不改写共享详情会话的观察与准入，避免把同一仍有效历史中已经接受、尚在准备发送的操作误取消；本挂载收到正 receipt 后仍记录自己的 opening live GET 要求。撤权错误和 Retry 在正文清除后继续可见，直到新的成功项目同步重新准入。

每次已准入的详情打开先调用 `requireOpeningRead(projectId,taskId)` 记录这次 opening 的 live GET 要求，再判断 pending/unknown/reconciling 是否阻止读取；阻止期间要求仍保留，解除后合并执行必要 GET。openingGeneration/liveOpeningGeneration 只在内存中识别该要求，不是 DB、协议或项目水位。GET 捕获开始时的 opening，磁盘正文、写结果、同版本 no-op/拒绝响应以及重开前已开始的 reconciliation 均不能满足后一次 opening；重复周期 receipt 不创建新 opening。取得当前生命周期 ticket 后可以显示匹配摘要版本的持久自身正文，live GET 成功前 requiresFreshRead 保持，磁盘内容不启用写操作。网络在事务外进行，响应通过实际用户核对后，保存事务再次验证 ticket、当前摘要和已有详情。较旧结果不覆盖正文。较新的 GET 结果保留待安装并触发项目同步；已确认且通过目标/版本校验的较新写正文，在受保护生命周期检查后可暂时按原始服务端字段显示，同时保持 graphMismatch、requiresFreshRead 和禁写，不提前持久化。暂存结果高于摘要版本时继续等待，版本相等时按原有 ticket 校验采用本地派生并持久化，不额外 GET（新的 opening 要求仍独立保留）。若当前摘要已越过暂存版本，则丢弃过期 payload 和旧 liveVersion，在原队列中合并必要 GET，空闲时执行，活动读或写结束后再排空。队列和 pending 保留发起用途：普通详情读取仍按普通读取恢复，操作结果核对仍按 reconciliation 恢复；原操作意图、阶段和已确认版本下界不因此改变，旧 payload 不安装也不满足 opening。普通读取失败进入可见的 detail error/Retry，不写入隐藏的 mutation reconciliationError；成功 GET 清除该读的错误和新鲜度阻塞。核对 GET 失败、仍旧版本、精确 pending 准入异常或提交后摘要再次前进时，退出当前 reconciling 并保留 reconciliationError 与检查状态/Retry；成功核对清除对应阻塞，保留操作归属。失败结果只作用于当前 entry/ticket generation，旧失败不能覆盖新读。重复摘要不形成核对循环，显式 Retry 只 GET。以上过程不推进项目覆盖。snapshot 会轮换项目 generation，不能跨 generation 采用旧 ticket 或待安装正文；任何 generation 变化立即释放旧详情正文、PR 和 loadedRevision，取消旧读取/待安装结果，并重置 liveVersion、已确认版本下界、读取错误与新鲜度；相同 taskId/version/时间也不能证明属于同一历史。hook 在 observer effect 前也以 `hasCurrentGeneration` 阻止旧正文闪现，新 GET 挂起或失败时不能保留旧 generation 的内容。一般 generation 更替保留操作 confirmed/unknown 的意图和阶段，旧核对取消后 reconciling 复位，以便显式 GET 核对恢复。已删除任务在新历史重新出现时初始化新的 mutation 所有权并强制 live GET；旧操作意图不能占用或改写新历史的操作状态，迟到结果仍须通过所有者与历史准入检查。同 generation 的刷新失败继续保留当前成功正文。

摘要自身 version 变化使对应详情失效并读取新内容。相同 version 的权威依赖状态变化重新物化 ready/blockedBy，不下载所有后继。description 或任意属性变化由业务 version 被发现，包含 PR 和 worker；普通属性变化不轮换 server epoch，也不使用属性 tombstone。收到 live GET/写响应时，先以原始服务端派生字段检查 isTaskStale，再物化本地派生值；`graphMismatch` 保存差异证据并继续提示、禁写和触发项目同步，不能用覆盖后的相同值消除它。成功读取或本地图收敛后才解除对应限制。重复 receipt 仅在读取错误、缺失新鲜观察、原始差异或核对未完成时提供必要恢复机会。

### 图无关的实时详情

Task GET 在同一只读 repeatable-read 回调内校验项目权限并读取完整 Task 与 `TaskCacheEpoch`；事务完成后才发布原完整正文与 `Daynight-Task-Epoch`。Web 的 `getTaskObservation` 严格验证主体、身份及 epoch。`TaskObservationInput` 区分摘要和 direct；后者由 `TaskCacheScope` 建立 userFence、项目 revision、history generation、Task、opening 和请求 generation 围栏，不要求 manifest。成功观察只属于当前 opening，不能写入持久详情或推进同步水位。摘要来源保留原完整摘要校验和持久化规则。

图同步和 Task GET 使用同一 history 观察。有效 epoch 更替先退休旧投影、详情、Steps 与阅读子树并使旧 ticket 失效，再在新围栏下至多补读一次；缺失或 invalidated manifest 不是 epoch 更替证据。其他标签提交的 manifest 与当前实时 epoch 冲突时，先退休已有准入并触发实时补读；该持久结果可能来自更早的请求，不能单独证明历史先后或永久退休当前 epoch。重叠网络请求获得的不同 epoch 也不能按请求启动顺序判断快照先后，须在隔离旧投影后以新请求确认；不确定期间保守保留同历史可能存在的在途写锁，确认换代或撤权后退休。持久 manifest 与已知实时 epoch 不一致时不能作为项目预览发布，网络失败也不能恢复该旧投影。账户变化等待刷新时保留当前详情、关系、菜单、确认、Session 录像和本地输入，认证屏障阻止新的网络请求与写入；真实会话失效、项目或历史退休按各自规则撤回内容。已接受写入在关闭详情后由原操作所有者和审阅围栏继续准备或核对，重开后的观察只能使过期意图失效，不能替代原准入。已确认写保留 committedVersion，实时 GET 达到下界才能重新可写；unknown 和 conflict 只读核对。来源资格、父版本与写前审阅由详情会话统一检查。direct 的关系、人员目录和 Session 记录各自读取并受同一 opening 资格约束，不用伪造摘要授权；局部关系不承诺完整外部后续。具体准入和替代方案由 [direct 观察决策](../../.agents/notes/implemented/architecture/2026-11-06-task-direct-observation.md)记录。

### 详情存储与预算

`detail-cache.ts` 导出 `readCachedDetail`、`saveDetail`、`materializeDetail`、`validateDetailSummary` 和 `detailByteSize`。详情记录必须匹配所属用户/项目/任务、fence/generation、当前摘要业务版本和全部自身摘要字段；不能含 ready/blockedBy。精确正文 JSON 的 UTF-8 字节数必须与 byteSize 相同。单条与项目总量、记录数都验证，损坏不能作为成功命中。

`DETAIL_CACHE_LIMITS` 固定每项目最多 32 条、总量 8 MiB、单条 2 MiB，边界值可缓存。字节使用 `TextEncoder` 编码 `stringifyApiJson` 产生的自身内容，业务 bigint 保持精确。实际缓存读取更新 lastUsedAt；新增正文按 lastUsedAt、再 taskId 的顺序淘汰最旧详情，摘要及水位不参与淘汰。相同版本和内容的保存不重复写详情。超过单条预算的成功正文仍可在当前会话显示，按策略不持久化，与真实配额错误区分。

详情记录或详情集合损坏时，以同一个捕获生命周期的受保护事务清除本项目 details，提交后仍抛出原损坏错误以提供可见 Retry；摘要、manifest 和 M 不变。失败尝试不悄悄改为只联网；Retry 重读实际存储并重新 live GET。清理写入失败沿真实存储错误传播。普通配额/写入失败通过新的受保护事务再次核对当前摘要及生命周期后，可保留可验证且允许显示的当前正文，并保持错误和禁写限制。

### 响应身份与写操作结果

详情 GET 及全部任务写 API 必须接收 `TaskResponseAdmission`：明确 userId、onPrincipalMismatch，写入可提供 onWriteConfirmed。客户端在解析正文和资源错误前检查实际 `Daynight-User-ID`，401 继续既有会话失效流程。缺失/畸形头是协议错误，可信不同用户同步通知根账户 owner 并拒绝该响应；由根 owner 决定旧 scope 的清理策略。这些失败不能被当成本用户 404 撤权。

写入接受时同步捕获确认所审阅的 cacheGeneration 与 mutation 对象身份；每次异步准备完成后及网络派发前，都要求该 owner、审阅历史和当前准入仍匹配。`beginSync` 在等待期间取得的新历史 ticket 不能替换旧确认的历史，即使任务 ID、版本相同也不足以派发。失效准备零写入，只 GET 刷新当前历史，取得 fresh GET 后要求新确认；被取代的准备不改变较新 mutation 的反馈或共享写锁。详情关闭本身保留仍属于同一 owner 和历史的已接受意图。提交准备和普通结果处理在同用户身份暂停时先经现有 `scope.ready` 等待，恢复后复核身份生命周期、原审阅 generation 与 owner，再读取受保护的实时投影或同步改变阶段；若又暂停则重新等待，不能在异常处理里重复访问受阻 getter。未发送的过期准备转为本地冲突或拒绝并 GET 当前历史；已发送的旧历史结果进入 unknown 与 GET 核对，被新 owner 取代的处理不再修改 entry。身份结束丢弃旧操作。

同用户认证的 HTTP 200 或删除成功的 204 在解析正文前确认远端写响应，与正文是否可安装、是否持久化分开。正文无效仍要求 GET 核对，存储失败保留确认结果及错误，不重发操作。pending、unknown、reconciling、committed-version floor 与精确目标/版本检查继续归详情会话；关闭对话框不释放已提交写请求，身份失效仍使其结果无权发布。单任务 GET 或写结果只能触发项目同步，不能直接修改摘要或 M。附件目录与文件保持独立按需路径。

## 7. 身份、错误与本地生命周期

账户 owner 在观察到变化时暂停持久读取、网络和正向内容发布，直到真实刷新；健康前后台切换不建立身份 gate。暂停期间详情渲染 getter 只保留先前已观察的内存版本/generation，未观察资源无值。可信 Task 404 在身份暂停期间先撤回任务并安排项目访问重验；项目确认撤权的路径按捕获历史检查，不读取受 gate 保护的正向投影。已经确认的负向撤权立即记录并隐藏内容，允许 accessRevoked 事件和负向提示越过暂停；它们不读取新私有内容或授予访问，后续持久清理仍等待 gate。

实际用户在正文或资源错误前核对。缺失/畸形 principal 为协议错误，不能据其状态撤销项目；可信不同用户先同步通知根账户 owner，再拒绝响应。缓存 scope 不在通知前销毁投影，根 owner 同步进入等待刷新并保留旧 scope 和已呈现内容。若 owner 保留 scope，通知返回后身份错配围栏终止旧的准入等待和未提交事务，拒绝继续读取或发布迟到的成功和负向结果，也不重复通知；已确认的写入事实仍可记录。普通同账户暂停不设置该围栏，可信撤权仍按原规则处理；另一标签页已确认的项目撤权按 userFence 和代际撤回相应内存投影，不让旧 scope 重新访问持久数据。项目同步的同用户 `404 not_found` 使用捕获 ticket 撤权。可信 Task 404 先撤回该任务并触发项目访问重验；只有项目访问确认撤权才执行 scope 撤权，未知任务地址同样不能单独证明项目不可访问。

`canRevokeProject(ticket)` 在会话清正文前检查当前用户 fence、投影和待处理拒绝是否仍匹配 ticket；同 scope 的在线准入序号还拒绝已被新历史准入取代、前驱不可比较的旧 ticket。读取请求在派发前另捕获 Project 正向读取序号，`canRevokeProjectRead` 不允许旧读取 404 撤回更新的 Project 或权限观察；任务同步、人员读取、删除预览、已拒绝的删除请求与权限重验使用该规则；通过各自生命周期和身份围栏的预览、人员、Task 详情及搜索成功也记录正向读取。已确认删除或转移的写入回执仍按原 ticket 清理，不受后续读取序号影响。旧 E1 的 GET/写 404 因而不能清 E2。`revokeProject(ticket,signal,broadcast=true,reason?)` 接收可选的原始可信 ApiError，来源页立即撤权事件因而保留 requestId；没有本地 HTTP 响应的 peer 使用通用 not_found。该方法同步记住被拒绝的 cacheGeneration，移除内存投影/授权并发出 accessRevoked 事件。详情会话清除所属项目正文/loadedRevision，useTaskGraph 清除快照；旧 revision 不能重新准入。applySync 与 detailTransaction 在事务前后检查被拒绝 generation，readProject 在物化前检查；清理失败或已提交的旧结果不能重新发布这些内容。

访问撤回与持久清理归仍存活的 scope，超出详情 UI 和 `TaskDetailSessions` 的寿命。切换到 `/invitations` 等页面可以释放详情会话而保留认证 scope；已提交写入返回可信 not_found 时按原历史发起项目访问重验，只有确认项目撤权才执行 scope 撤权。已释放会话只保留操作拒绝意图/错误并清自身旧正文，不通知其 UI listener、不补 GET 或重发写入；scope 退出/账号替换仍优先使旧响应失效，旧 E1 仍不能撤 E2。共享缓存 RW 事务只在持久 userFence 和 manifest.cacheGeneration 仍等于捕获 ticket 时清除该项目 summaries/details/profiles/sessionHistory，并写新的 invalidated manifest；不同用户、项目或 generation 不在该 CAS 清理范围。清理失败保留内存拒绝与可见存储错误。beginSync 先重试待处理清理，再建立同步基线；撤权后的持久摘要预览须等新的在线项目同步成功。direct 详情须在清理、身份与历史围栏允许后，通过新的实时 Task 观察准入。摘要预览以 scope 的既有退役记录和在线授权判定：未观察过有效撤权时允许首次本地预览；观察后必须重新在线授权，不能因清理跳过了不同 generation 的较新持久集合就恢复预览。hook 在 readProject 前与异步读取后均检查 canPreviewProject；同 scope 的项目导航与重新挂载沿用该判断，普通提示与失败的 Retry/轮询不改变授权。成功 applySync 恢复授权但不清除旧 generation 的退役围栏。manifest 在 snapshot、失效与清理时同事务保存完整代际祖先，ticket 携带该链；它用于识别撤权影响的旧投影，不扩大持久清理的 CAS 范围。任何保留记录也不能代替在线准入。

负向 BroadcastChannel 提示携带 userId、projectId、userFence、revokedGeneration 及 ticket 的完整祖先。已确认删除的写入提示直接撤回相关 peer。其他带代次的负向提示沿用缓存代际及 direct 详情的撤回与复核规则；仅已读取 Project、尚无缓存 fence 或投影的 peer 无法比较代次时暂时隔离并独立核验，不据此推断代次或永久清理。可比较的负向提示同步封锁被撤代际及祖先，按投影读取时捕获的历史撤回内容；新代际的撤权也能覆盖其先前投影，旧提示不能撤回可证明的后继。清理以实际持久 generation 为 CAS，不转发提示。损坏使前驱不可证明时标记 unknownAncestors；接收方核对持久 generation 或刚完成的清理记录后隔离无法比较的旧投影并重新读取。账户准入暂停时立即暂时隔离无法比较的内容；核对进行中发生的后续暂停也立即触发隔离。若恢复后核对确认提示过期，则恢复原准入并重新读取。存储无法核对时保守隔离并显示错误，可证明的后继保持准入。独立目录和 Worker 投影及存储故障行为由 [Web 设计](daynight-web.md#我的-worker-列表与详情)拥有，相关代际决策见 [投影撤回记录](../../.agents/notes/implemented/architecture/2026-11-06-web-project-projection-withdrawal.md)。

项目页面的独立 Project GET 若在发出前捕获可用的项目历史 ticket，可信当前 404 使用该 ticket 按上述代际规则撤权。没有可证明代际时，来源 scope 先本地隔离并广播同账号、同项目的无代次负向提示；接收 scope 独立核验 Project 访问。peer 暂时隔离相关图和 direct 内容并独立核验，失败显示可恢复错误并周期重试；direct 内容在核验成功后重新读取，项目页同样等待 direct 核验结束。核验前最多等待 5 秒准备持久 generation ticket，无法取得时仍执行访问读取；自身读取确认 404 且捕获 ticket 仍匹配时才按该 ticket 撤权和清理，没有 ticket 则本地隔离。Project、准入或读取事实变化时重验，旧观察不能撤销更新的准入；无代次提示本身不能永久撤销一个推测的代际。该提示是内存广播，不持久化；所有 scope 关闭且未完成可信代际清理时，后续 scope 沿用既有持久摘要预览与服务端核验规则。

direct 详情的在线观察不持有项目快照代际，不能仅凭祖先链判断负向提示发生在观察之前。提示到达时先隔离对应 direct 内容并保留已派发写入的互斥所有权，再核验当前 Project 访问；确认仍可访问后重新读取 direct Task 和 Session，失败或离线保持隐藏。独立目录及 Worker 仍按各自代际接收撤回，Project 权威撤权和持久清理不因 direct 重验而跳过。历史清理不能覆盖已提交的访问撤权记录；未观察到的跨服务撤权与重新授权顺序仍遵循 direct 观察的服务端合同。

持久数据不保存在线授权；身份通过核验且生命周期仍有效时，本地摘要允许先行显示，普通可恢复故障保留允许展示的同 generation 摘要及仍获准的详情。真实退出或当前有效 401 通过 invalidateScope 同步中止 scope、释放内存；观察到账户变化时保留内存并停止远程准入，直到真实刷新；持久事务只在已绑定 fence 与当前有效 fence 相同、尚未绑定或当前 fence 缺失/损坏时轮换 userFence、清除该用户内容并保留失效 manifest。已绑定 scope 不能清除其他生命周期的较新 fence 和内容；dispose 仅关闭当前 scope，保留可重用持久记录。

同项目缓存事件可以重新发布最新已授权快照，但不证明 task-sync 失败已经恢复；异步发布在实际状态更新时保留该项目和身份作用域当前的同步错误及手动刷新状态，只有成功同步清除同步错误。历史或访问退休继续优先撤回内容。IDB 打开、blocked、异常 close、读取、配额和写入失败进入现有失败/保留快照错误区及 Retry。blocked 5,000ms 后报告错误，迟到打开的连接关闭。重试先重开必要连接并读取真实存储；结构损坏记录原因并完整重建，失败不无限重试。用户记录缺失、归属错误或 userFence 畸形时，不再次依赖该损坏 fence 做项目失效。一个独立的共享缓存修复事务直接写新用户 fence、清除该用户摘要/详情/人员和 Session 目录内容，并把其可识别项目基线重建为失效记录；无法识别的项目键被清除。其他用户保持。修复提交前不修改内存绑定、退役 scope 或发送提示；修复失败原子回滚，检测它的 scope 保持可重试并显示存储错误。提交后，尚未绑定的冷 scope 绑定新 fence 再继续原读取；已经绑定旧 fence 的 scope 同步通知根 owner 并拒绝操作，不关闭 scope 或采用替代 fence。根 owner 决定清理，当前根回调保留 scope 并进入等待刷新。其他标签页的旧 ticket 在后续事务中被新 fence 拒绝，已完成事务也须通过提交后的 scope 检查才可发布。不引入静默网络模式或新的产品布局。

schema 升级时关闭旧连接；不兼容升级在事务中清除可重建缓存并轮换生命周期 fence，兼容升级保留已有内容。组件/身份释放关闭句柄、通道、timer 并取消读请求；已提交修改继续由身份级详情会话核对。保留现有筛选、焦点、视口、全屏、滚动和附件 frame，以及对话框、独立任务详情页、独立附件工作区的读取与操作。TaskDetailPage 的完整详情使用 direct 观察，关系与项目图读取独立；图失败不能阻塞详情。

## 8. 历史替换与约束

只保留一个项目 cache epoch，避免数据库恢复后要求每个浏览器人工清缓存。支持的恢复/导入/原始替换流程停止全部写入，完成操作后、开放服务前执行受影响项目的 `UPDATE projects SET task_cache_epoch=gen_random_uuid()`。备份本身会恢复旧 UUID，维护流程必须显式轮换。

窗口不会自动识别时钟倒退或绕过正式写路径的修改。运行环境保持数据库时间正常；异常回拨或离线历史维护应恢复时间并轮换 epoch 触发完整重建。维护验收须确认任务时间假设已恢复；导入的未来任务时间不能仅靠 epoch 修正。普通重启保持 epoch。[Task 软删除](daynight-task-deletion.md)在标记删除的同一事务内轮换项目 epoch，旧客户端基线因而获得不含该任务的完整 snapshot。delta 继续只表示当前未删除任务，不增加墓碑字段。显式 removeDepends=true 的删除同时更新每个实际引用源的 version/updatedAt；同一 epoch 替换原子发布源任务关系、ready 和目标消失，不引入逐源同步提交。

摘要同步最初以服务端先行、浏览器随后切换的顺序交付，原完整图为当时的读取路径。
当前浏览器只通过 task-sync 建立和更新项目摘要，不保留完整图 API fallback。CLI 的
任务链查询使用独立的 taskId 选择规则；缓存不能把该局部结果作为完整基线。
新增索引/epoch 不改变正式 updatedAt 写路径，不存在需修复的同步序号遗漏。

## 9. 责任与可观测性

| 所有者 | 职责 |
|---|---|
| server config、README、部署配置 | 正 duration、默认10s及环境文档 |
| store、service/task/task_sync | epoch/index、同快照窗口读取、完整 Session source 及容量/权限 |
| core/session | 已提交 live 标量读取、可靠执行绑定和既有 Session 状态投影 |
| server task_sync/auth | 严格 DTO/query、实际用户头与错误 |
| web api/task-sync、project-json | 精确时间/version、严格四态 map、body receipt、网络和身份 gate |
| task-cache/database、project-cache | 六个 store、生命周期、当前集合合并、人员与 Session 目录持久化、重复去重及发布 |
| task-cache/projection | 完整事实到既有图模型的纯函数 |
| useTaskGraph、TaskDetailSession、AuthenticatedApp | 唯一项目同步与页面 Session 生产者、版本驱动详情读取、会话与浏览状态 |
| task-session-summary | 内存状态绑定接纳、30 秒期限、整链聚合与原有入口 |
| task-detail/detail-cache | 自身正文验证、物化、受保护持久读写与 LRU |

服务端沿用 slog JSON、request_id/user_id/project_id，记录 phase、mode、since、window、returned_tasks、duration。客户端按周期 UUID 记录 received/changed/duplicate 数、cache_hit、apply_ms 和 error_category；duplicate 包含相等版本与被忽略的旧版本。失败通过 `task-cache/diagnostics` 输出受限深度的清洗 cause：只保留固定错误名称、分类和允许的 API code，不输出原始 message、stack 或任意正文。存储错误仍保留原 cause 错误链供本地处理；不记录 Cookie、令牌或任务正文，不新增遥测上传。

每个 timer、fetch、IDB 事务、提示与详情操作都由当前 scope/coordinator/session 拥有；携带请求 ID、项目和身份 generation，失败回到对应周期，释放后不发布。没有服务端后台清理或日志消费任务。

具体排查：用浏览器响应 X-Request-ID 查询服务标准输出：`jq 'select(.component == "task_sync" and .project_id == "<project-id>" and .request_id == "<request-id>")'`，核对 since、window 与 returned_tasks；浏览器用相同请求及 cycle_id 对照去重/提交。既有请求 ID 验证限制 1–64 字符，首位字母/数字，其余允许点/下划线/横线。

## 10. 验证、效率与设计取舍

数据库测试证明查询边界、精度、配置、快照与项目写锁顺序；不再验证已移除的同步序号。默认10s、其他正值、配置增减及非法配置均有验收。在数据稳定的夹具中，用完整公开任务事实对照本地图投影；可使用完整 task-sync snapshot 或任务列表/详情，不能用 CLI 的局部任务链图替代。

Session source 测试验证全项目查询独立于窗口、规范 Worker 和 Session 的普通解码、无大字段以及相同只读事务。Engine 测试覆盖已提交状态、实际 binding/fence 比较、状态顺序、期限边界、admission/Stop、取消与 registry/cell 锁顺序。HTTP 测试验证完整 `sessions`、合法空 map 和自然失败传播；CLI/Web 消费完整响应时不再按存储节点、边或 Session 项数拒绝。

真实 IDB 验证同时间戳不同任务/版本、迟到响应、当前集合合并、失败原子性、重复零写入、账号/项目清理与升级。双标签页重复结果不广播，不形成请求反馈环；详情不能推进项目覆盖水位。Session 所属测试补充同事务请求绑定、snapshot/delta 实际观察、旧值与旧缺席、body 后处理延迟及期限、失败/暂停/恢复和其它来源不发布状态。Session-only 变化必须证明不写 Task 缓存、不失效正文、不增加普通通知或额外图构建；组件守住整链、pending 与原入口。

保留既有四容量图各五次的交互预算。传输测试比较返回 ID 与 SQL 窗口选择的集合，记录重复率及实际字节；不再要求无变化零任务或单根修改只返回一条。窗口中集中修改可能反复返回较多记录，重复传输与无历史同步序号是已确认取舍。

完整属性会增加响应、解析、全量本地校验及持久化成本。写请求的 1 MiB 外壳限制不等于累计任务属性上限；仅适用于 details 的 8 MiB 缓存预算不限制 summaries 的总字节。协议不截断属性、不隐加条数或大小限制，也不承诺任意合法最大数据量均可缓存。实际项目样本、接近请求上限的 PR 值与较大属性多任务样本应记录响应字节、解析时间和 IDB 提交时间。网络限制或 QuotaExceededError 明确失败，摘要、详情失效与水位保持同一事务结果。分页、流式 staging 和项目字节预算需要独立的同步合同。

曾比较完整图条件请求、事务修订号、变更日志。完整图变化后仍传全部；变更日志带来历史保留和重放；修订号可避免末尾重复并独立于墙钟，但需要新的每写修订字段。当前选择现有 updatedAt 加配置窗口，并接受重复；不存在固定 requestAt 水位或事后更新时间写入。

## 11. 实施与验证边界

服务端窗口同步接口及历史失效字段、浏览器 typed 持久摘要和普通 Task 图投影已经接入；task-graph 为 CLI 等调用者提供指定任务链及一层外部前置。详情会话已使用按需持久缓存、匹配版本复用、变更驱动刷新和 LRU。六个 store、详情事务、精确摘要版本和人员内容接口由缓存 scope 拥有；详情、人员与 Session 目录模块复用 schema、身份、失效和发布所有者。完整链路验收仍以对应源码和真实运行证据为准。

切换浏览器传输时，同时调整现有 fixture、route、waiter 和请求来源统计，使相应阶段的已有检查能够真实通过。完整链路的独立验收使用正式服务、CLI 和生产浏览器，对照窗口集合、重复率、恢复和既有交互预算，不代替实现阶段的测试。

本架构不新增 Agent、CLI 或 MCP 工具。数据读取协议与缓存行为的运行时交付，仍需各自真实数据库、原生 IndexedDB 和浏览器证据。
