# Web 任务缓存与时间窗口增量同步架构

状态：服务端时间窗口接口、10s 配置、项目 epoch 和认证响应归属，以及浏览器 IndexedDB 摘要、本地图投影、五秒增量读取和按需详情缓存已实现。详情会话复用任务写操作与未知结果核对，以摘要业务版本驱动内容读取。

[需求](../spec/daynight-task-sync.md)拥有已确认行为。方案使用任务最大更新时间与默认 10 秒重叠窗口，沿用已有业务 version 去重。[服务端决策](../../.agents/notes/implemented/architecture/2026-10-24-task-summary-window-api.md)和[浏览器摘要决策](../../.agents/notes/implemented/architecture/2026-10-24-persistent-task-summary-cache.md)分别保存协议与本地存储的取舍。

## 1. 总体方案

服务端实现入口为 `internal/service/task_sync.go` 的 `TaskSync.Get`、
`internal/core/store/task_sync.go` 及 `internal/server/task_sync.go`；配置在 composition
显式传给 `NewTaskSync`。`015_task_sync.sql` 提供 epoch 和更新时间索引。
浏览器 `api/task-sync.ts` 严格解码摘要，`task-cache/{database,project-cache,projection}` 拥有存储、生命周期和投影，`useTaskGraph` 保留页面读取接口及调度。详情缓存 `task-detail/detail-cache.ts` 使用相同四 store 与身份边界，现有 `TaskDetailSessions` 拥有读取、新鲜度和写结果安装。

```text
首次完整任务摘要 → IndexedDB → 本地图 / 列表 / 统计
                       ↑
客户端摘要最大 updatedAt → 服务端减去配置窗口 → 返回匹配任务摘要
```

客户端只把已成功合并的项目同步摘要用于计算水位。服务端读取当前任务事实，不保存历史变更流，也不承诺依次返回每个业务版本；一次同步可以从 v5 直接读到 v7。重复行是协议正常部分；前端借助任务已有 version 判断是否替换内容。

| 现有机制 | 用途及证据 |
|---|---|
| 项目行锁与同事务写入 | [project_tx.go](https://github.com/codetreker/daynight/blob/c418168859a6ebf23fda95ed150767a72e3956ea/packages/daynight-server/internal/core/store/project_tx.go#L32-L124)在锁后写 version/updatedAt 与依赖，继续使用 |
| REPEATABLE READ | [snapshot.go](https://github.com/codetreker/daynight/blob/c418168859a6ebf23fda95ed150767a72e3956ea/packages/daynight-server/internal/core/store/snapshot.go#L14-L31)提供一次响应的一致集合 |
| 五秒调度与稳定引用 | [useTaskGraph.ts](https://github.com/codetreker/daynight/blob/c418168859a6ebf23fda95ed150767a72e3956ea/packages/daynight-web/src/features/projects/useTaskGraph.ts#L27-L111)保留刷新优先级、取消与视图接口 |
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
  titlePreview: string;
  titleTruncated: boolean;
  status: TaskStatus;
  dependsOn: string[];
  externalDependsOn: string[];
  allowAgents: boolean;
  requiredPlatform: "windows" | "linux" | "macos" | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};
type TaskSync = {
  mode: "snapshot" | "delta";
  epoch: string;
  project: Project;
  observedAt: string;
  tasks: TaskViewRecord[];
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
| 图超过 1,000 节点或 5,000 边 | 409 graph_limit_exceeded，保留现有计数详情 |
| 数据库/取消/完成失败 | 真实错误，不降格为空数据 |

在一次现有只读快照中验证成员资格、读取 Project/epoch、精确容量检查、匹配摘要和 observedAt。全部状态都参与同步。响应规模不超过完整有界图，因此不引入分页或中间发布。每次检查容量，不能保留旧修订号方案的“序号相等即跳过计数”优化。

TaskStatus 沿用当前共享的 todo/in_progress/done 三状态。摘要必须保留当前 GraphTask 已有的 requiredPlatform（明确可空）及 allowAgents；缺失字段作为协议错误，不能补默认值。返回排序为 (createdAt,id)，依赖数组按 ID。新 version 字符串严格解码为 bigint；Project.settings.version 沿用现有无损解码。缓存字段不得缺省。GET/HEAD、no-store、错误信封、请求取消及现有完整 task-graph 合同保持。

认证边界为实际认证后的响应写 `Daynight-User-ID`，覆盖同步、详情、写结果及认证后资源错误。缓存发布前与当前身份核对；401 沿用会话失效流程。该头来自 core.Principal，不能回显客户端输入。

## 5. IndexedDB 与去重

采用固定的 `idb@8.0.4` 薄包装，数据库 schema 为 1，保留显式事务所有权。[固定上游 README](https://github.com/jakearchibald/idb/blob/654c746bef13f9fe7f5871e03ac58015cebace5a/README.md)说明事务 active 生命周期与 tx.done；不引入 Dexie live query 或第二个 UI 状态所有者。原生 API 需要自行包装事务完成，idb 复用原生模型且提供类型化 Promise。

同源数据库 `daynight-task-cache`：

| store / key | 内容 |
|---|---|
| userScopes / userId | 持久 fence UUID，退出/换号后轮换并保留 |
| projects / [userId,projectId] | active/invalidated、invalidatedBy、userFence、cacheGeneration、epoch、Project、maxUpdatedAt/null、taskCount、edgeCount |
| summaries / [userId,projectId,taskId] | 已接受的任务自身摘要及业务 version |
| details / [userId,projectId,taskId] | userFence、cacheGeneration、完整任务自身内容及业务 version、byteSize、lastUsedAt |

`lifecycle.ts` 统一验证用户记录与两类 manifest：userId/projectId 必须匹配请求归属，userFence 和 cacheGeneration 必须是规范 UUID，计数必须是容量上限内的非负安全整数。active manifest 要求 invalidatedBy=null、合法 epoch/Project，且 taskCount 为零当且仅当 maxUpdatedAt=null；invalidated manifest 要求明确的 access/corrupt/user 原因、epoch/project/maxUpdatedAt 全为 null、taskCount/edgeCount 全为零。失效状态不能保留可用于增量请求的旧 epoch。

不存派生 ready/blockedBy，不把 bigint 当作 IDB 键，也不 JSON.stringify bigint。`projects` 的 `by-user` 索引支持用户清理；`summaries`、`details` 的 `by-user` 与 `by-project` 索引支持定向读取和清理。`TaskIntrinsicDetail = Omit<TaskDetail, "ready" | "blockedBy">` 固定详情存储边界，保留 description、完整 properties（含 pullRequests 和 nullable worker）及精确业务 version。

`TaskCacheProvider` 在认证分支内、`TaskDetailSessionProvider` 外提供同一个 `TaskCacheScope`，同时覆盖项目页、独立任务页和附件路径页。scope 以用户与会话 generation 隔离；普通同用户核验保留它。`beginSync` 返回 epoch、水位和生命周期 ticket，`applySync` 原子应用响应，`readProject` 读取实际持久集合，`canPreviewProject` 根据既有 revokedGenerations 与 authorizedProjects 判断是否允许本地摘要预览，`getAuthorizedProject` 只返回本 scope 已获在线准入的内存投影。`getSummaryVersion` 和 `subscribe` 提供精确业务版本与变更通知；`detailTransaction` 在相同 fence/generation 校验后开放四 store 内的详情事务。

### 每轮应用

1. 当前身份通过核验后读取本项目 M/epoch 及生命周期 fence。首次本地集合有效时，在网络响应前发布完整摘要供概览、列表和图浏览，随后后台同步；有效空项目也发布，没有有效集合时保持加载态。仅本地摘要不增加 scope 的在线准入，也不获得详情正文或写权限。解码、身份验证与网络等待在 IDB 事务之外。
2. 开一个跨四 store 的 readwrite 事务，验证用户记录及项目 manifest，重读 userFence 与项目 cacheGeneration，要求仍与请求时的生命周期相符。初次缺失用户记录也先建立新的持久 fence；重置/注销后的迟到请求不能重新创建已清理内容。beginSync、applySync、readProject 和 detailTransaction 共用该验证与用户恢复边界。
3. active 项目先校验当前持久集合的 taskCount、edgeCount 与精确最大 updatedAt 是否等于 manifest，并验证行归属、类型和图结构。少一条独立任务也属于损坏；不能把更小集合重新计数后视为正常。校验失败中止本次应用，使基线 invalidated 后无 since 完整重建。校验通过后，delta 从**此刻的完整持久摘要集合**按 id 与业务 version 合并。更高版本替换；相等版本保留原内容且自身字段必须一致；较旧版本忽略。Project 按已有 settings.version 合并，迟到旧设置不得回退。
4. 从合并集合重新计算精确 maxUpdatedAt、依赖与统计并完成图校验。只写真实改变的行、对应详情失效与确有变化的元数据；摘要与水位一起提交。snapshot 在生命周期仍匹配时完整替换并更新 cacheGeneration。
5. 等 tx.done 后发布实际合并的快照。重复行不重写、不触发详情失效，不改变可见任务/索引/布局引用；仍能提供本页新的访问确认与时钟样本。

仅比较 M 是否相等不足以保证内容 CAS：不同任务或任务版本可以共享时间戳。本方案在串行的 IDB 写事务内读取并合并当前集合，不增加另一套本地提交序号。事务内只等待 IDB 请求并做有界纯计算，不等待 fetch、timer 或异步 crypto。1,000/5,000 上限限制全集合校验成本；每轮可能读取全部本地摘要，这个成本实测，不声称本地工作量严格为变化量。

项目 manifest 不合法或完整摘要集合损坏时，先定向清除本项目摘要/详情、建立符合 null/零值约束的新 invalidated manifest 及 cacheGeneration，再无时间边界取 snapshot。相同 epoch 的空项目后续走 delta，不因重复空集合不断轮换 generation。

### 多标签页与广播

各页独立维持约五秒轮询，无选主。IDB 写事务排序与当前集合的 version 合并防止乱序网络结果回退数据。只在任务自身内容、设置或生命周期实际变化后广播轻量提示；重复结果、显示时钟、纯读取不广播，也不转发提示。

普通变更提示在提交后触发，接收方重读当前持久集合，不仅因提示再发网络。它不授予首次访问或提供可复用的时钟锚；已打开页沿用本页样本，下一正常周期重新同步。负向撤权提示在确认可信 not_found 后立即发送，不等待持久清理；其匹配、暂停期间处理和 CAS 清理见第 7 节。两类提示都不转发，不包含任务正文。

## 6. 投影、时钟与详情

用完整摘要在本地计算 blockedBy、ready、summary，再复用现有 buildGraphIndex 生成链与独立任务分类。所有依赖都参与阻塞，普通依赖决定链成员。验证重复 ID、缺失前置、环、容量及统计后一次发布，不能呈现半批图。

精确比较 UTC 秒部分、补齐到九位的小数及规范 ID，保留原字符串；不能以 Date.parse 毫秒或可变小数的原始字典序排序。时间水位也用相同精度计算。

仅本地摘要的 GraphSnapshot 没有成功接收时间或服务端时钟样本，revision 为 0；最近刷新标签、运行中耗时与可能卡住提醒等待实际响应，已完成耗时仍使用持久起止端点。概览与任务列表的近期分类在此期间使用本机墙钟作为暂时当前时刻，首个成功响应后切换为服务端与单调时间；本地自然日边界继续使用浏览器时区，不把本机时间用于执行耗时或同步水位。每次成功实际响应的 observedAt 与解码后立即取得的本页 performance.now 接收值配对，独立推进 TaskExecutionClock。observedAt 不参与 M。磁盘和跨页广播不能提供可复用的单调锚点；设置与重复摘要保持已发布图索引身份。`GraphSnapshot.revision` 的正值是本挂载每次成功同步的 receipt，不是任务版本、水位或持久提交序号。它提供当前挂载的访问准入和失败恢复机会，正常重复 receipt 不使匹配详情重新 GET。跨页读取沿用本页已取得的时钟 receipt。

### 详情内容、版本与读取

`TaskDetailSessions(scope)` 复用认证 scope 的 `beginSync` 和 `detailTransaction`，保持 status、allowAgents、requiredPlatform 与软删除写操作的同一所有者；状态写入仍使用 PUT /tasks/{taskId}/status，删除使用 DELETE task。当前历史的可信 `410 task_deleted` 只清除该任务正文并触发项目同步，不进入 `not_found` 的项目撤权分支；未知删除结果只经 GET 核对。删除终态绑定确认时的 cacheGeneration。后续已授权的新 generation 完整快照同时恢复活动节点与摘要时，解除该终态并强制 live GET，成功前禁写；状态、许可、平台和删除的所有结果统一检查当前操作所有者及历史准入；旧历史迟到结果不能修改恢复后的详情、覆盖较新操作反馈或解除其共享写锁。原有 principal 与项目撤权继续采用捕获 scope/ticket 的检查。`useTaskDetail(projectId,taskId,revision,observedTask)` 保留调用形式，从 scope 读取摘要业务版本和项目 generation。可显示内容同时要求本次挂载的 revision>0 和 scope 当前仍授权的项目 generation；其他页面的集合不能替代本次 receipt，旧 receipt 也不能绕过已经撤销的 scope 准入。revision=0 的本地摘要挂载只在 hook 中隐藏正文和阻止新操作，不改写共享详情会话的观察与准入，避免把同一仍有效历史中已经接受、尚在准备发送的操作误取消；本挂载收到正 receipt 后仍记录自己的 opening live GET 要求。撤权错误和 Retry 在正文清除后继续可见，直到新的成功项目同步重新准入。

每次已准入的详情打开先调用 `requireOpeningRead(projectId,taskId)` 记录这次 opening 的 live GET 要求，再判断 pending/unknown/reconciling 是否阻止读取；阻止期间要求仍保留，解除后合并执行必要 GET。openingGeneration/liveOpeningGeneration 只在内存中识别该要求，不是 DB、协议或项目水位。GET 捕获开始时的 opening，磁盘正文、写结果、同版本 no-op/拒绝响应以及重开前已开始的 reconciliation 均不能满足后一次 opening；重复五秒 receipt 不创建新 opening。取得当前生命周期 ticket 后可以显示匹配摘要版本的持久自身正文，live GET 成功前 requiresFreshRead 保持，磁盘内容不启用写操作。网络在事务外进行，响应通过实际用户核对后，保存事务再次验证 ticket、当前摘要和已有详情。较旧结果不覆盖正文。较新的 GET 结果保留待安装并触发项目同步；已确认且通过目标/版本校验的较新写正文，在受保护生命周期检查后可暂时按原始服务端字段显示，同时保持 graphMismatch、requiresFreshRead 和禁写，不提前持久化。暂存结果高于摘要版本时继续等待，版本相等时按原有 ticket 校验采用本地派生并持久化，不额外 GET（新的 opening 要求仍独立保留）。若当前摘要已越过暂存版本，则丢弃过期 payload 和旧 liveVersion，在原队列中合并必要 GET，空闲时执行，活动读或写结束后再排空。队列和 pending 保留发起用途：普通详情读取仍按普通读取恢复，操作结果核对仍按 reconciliation 恢复；原操作意图、阶段和已确认版本下界不因此改变，旧 payload 不安装也不满足 opening。普通读取失败进入可见的 detail error/Retry，不写入隐藏的 mutation reconciliationError；成功 GET 清除该读的错误和新鲜度阻塞。核对 GET 失败、仍旧版本、精确 pending 准入异常或提交后摘要再次前进时，退出当前 reconciling 并保留 reconciliationError 与检查状态/Retry；成功核对清除对应阻塞，保留操作归属。失败结果只作用于当前 entry/ticket generation，旧失败不能覆盖新读。重复摘要不形成核对循环，显式 Retry 只 GET。以上过程不推进项目覆盖。snapshot 会轮换项目 generation，不能跨 generation 采用旧 ticket 或待安装正文；任何 generation 变化立即释放旧详情正文、PR 和 loadedRevision，取消旧读取/待安装结果，并重置 liveVersion、已确认版本下界、读取错误与新鲜度；相同 taskId/version/时间也不能证明属于同一历史。hook 在 observer effect 前也以 `hasCurrentGeneration` 阻止旧正文闪现，新 GET 挂起或失败时不能保留旧 generation 的内容。一般 generation 更替保留操作 confirmed/unknown 的意图和阶段，旧核对取消后 reconciling 复位，以便显式 GET 核对恢复。已删除任务在新历史重新出现时初始化新的 mutation 所有权并强制 live GET；旧操作意图不能占用或改写新历史的操作状态，迟到结果仍须通过所有者与历史准入检查。同 generation 的刷新失败继续保留当前成功正文。

摘要自身 version 变化使对应详情失效并读取新内容。相同 version 的前置变化直接从完整本地图重新物化 ready/blockedBy，不下载所有后继。description、PR 或 worker 属性变化由业务 version 被发现。收到 live GET/写响应时，先以原始服务端派生字段检查 isTaskStale，再物化本地派生值；`graphMismatch` 保存差异证据并继续提示、禁写和触发项目同步，不能用覆盖后的相同值消除它。成功读取或本地图收敛后才解除对应限制。重复 receipt 仅在读取错误、缺失新鲜观察、原始差异或核对未完成时提供必要恢复机会。

### 详情存储与预算

`detail-cache.ts` 导出 `readCachedDetail`、`saveDetail`、`materializeDetail`、`validateDetailSummary` 和 `detailByteSize`。详情记录必须匹配所属用户/项目/任务、fence/generation、当前摘要业务版本和全部自身摘要字段；不能含 ready/blockedBy。精确正文 JSON 的 UTF-8 字节数必须与 byteSize 相同。单条与项目总量、记录数都验证，损坏不能作为成功命中。

`DETAIL_CACHE_LIMITS` 固定每项目最多 32 条、总量 8 MiB、单条 2 MiB，边界值可缓存。字节使用 `TextEncoder` 编码 `stringifyApiJson` 产生的自身内容，业务 bigint 保持精确。实际缓存读取更新 lastUsedAt；新增正文按 lastUsedAt、再 taskId 的顺序淘汰最旧详情，摘要及水位不参与淘汰。相同版本和内容的保存不重复写详情。超过单条预算的成功正文仍可在当前会话显示，按策略不持久化，与真实配额错误区分。

详情记录或详情集合损坏时，以同一个捕获生命周期的受保护事务清除本项目 details，提交后仍抛出原损坏错误以提供可见 Retry；摘要、manifest 和 M 不变。失败尝试不悄悄改为只联网；Retry 重读实际存储并重新 live GET。清理写入失败沿真实存储错误传播。普通配额/写入失败通过新的受保护事务再次核对当前摘要及生命周期后，可保留可验证且允许显示的当前正文，并保持错误和禁写限制。

### 响应身份与写操作结果

详情 GET 及全部任务写 API 必须接收 `TaskResponseAdmission`：明确 userId、onPrincipalMismatch，写入可提供 onWriteConfirmed。客户端在解析正文和资源错误前检查实际 `Daynight-User-ID`，401 继续既有会话失效流程。缺失/畸形头是协议错误，可信不同用户同步失效旧 scope；这些失败不能被当成本用户 404 撤权。

写入接受时同步捕获确认所审阅的 cacheGeneration 与 mutation 对象身份；每次异步准备完成后及网络派发前，都要求该 owner、审阅历史和当前准入仍匹配。`beginSync` 在等待期间取得的新历史 ticket 不能替换旧确认的历史，即使任务 ID、版本相同也不足以派发。失效准备零写入，只 GET 刷新当前历史，取得 fresh GET 后要求新确认；被取代的准备不改变较新 mutation 的反馈或共享写锁。详情关闭本身保留仍属于同一 owner 和历史的已接受意图。提交准备和普通结果处理在同用户身份暂停时先经现有 `scope.ready` 等待，恢复后复核身份生命周期、原审阅 generation 与 owner，再读取受保护的实时投影或同步改变阶段；若又暂停则重新等待，不能在异常处理里重复访问受阻 getter。未发送的过期准备转为本地冲突或拒绝并 GET 当前历史；已发送的旧历史结果进入 unknown 与 GET 核对，被新 owner 取代的处理不再修改 entry。身份结束丢弃旧操作。

同用户认证的 HTTP 200 或删除成功的 204 在解析正文前确认远端写响应，与正文是否可安装、是否持久化分开。正文无效仍要求 GET 核对，存储失败保留确认结果及错误，不重发操作。pending、unknown、reconciling、committed-version floor 与精确目标/版本检查继续归详情会话；关闭对话框不释放已提交写请求，身份失效仍使其结果无权发布。单任务 GET 或写结果只能触发项目同步，不能直接修改摘要或 M。附件目录与文件保持独立按需路径。

## 7. 身份、错误与本地生命周期

沿用 AuthenticatedApp 的 foreground /me gate，持久读取、网络和正向内容发布等待身份核验。暂停期间详情渲染 getter 只保留先前已观察的内存版本/generation，未观察资源无值。可信已提交 404 的 scope 所有撤权路径先于普通 mutation 准入的暂停等待，按 `canRevokeProject(ticket)` 检查捕获历史，不读取受 gate 保护的正向投影。已经确认的负向撤权立即记录并隐藏内容，允许 accessRevoked 事件和负向提示越过暂停；它们不读取新私有内容或授予访问，后续持久清理仍等待 gate。

实际用户在正文或资源错误前核对。缺失/畸形 principal 为协议错误，不能据其状态撤销项目；可信不同用户使旧 scope 同步失效，再核验身份。项目同步的同用户 `404 not_found` 使用捕获 ticket 撤权。详情 GET 仅在发起时摘要中已有该任务才把可信 not_found 视为项目访问撤回；任务写入的可信 not_found 使用同一撤权入口。未知任务地址的 404 保持任务局部错误，不触发项目重建循环。

`canRevokeProject(ticket)` 在会话清正文前检查当前用户 fence、投影和待处理拒绝是否仍匹配 ticket，旧 E1 的 GET/写 404 因而不能清 E2。`revokeProject(ticket,signal,broadcast=true,reason?)` 接收可选的原始可信 ApiError，来源页立即撤权事件因而保留 requestId；没有本地 HTTP 响应的 peer 使用通用 not_found。该方法同步记住被拒绝的 cacheGeneration，移除内存投影/授权并发出 accessRevoked 事件。详情会话清除所属项目正文/loadedRevision，useTaskGraph 清除快照；旧 revision 不能重新准入。applySync 与 detailTransaction 在事务前后检查被拒绝 generation，readProject 在物化前检查；清理失败或已提交的旧结果不能重新发布这些内容。

访问撤回与持久清理归仍存活的 scope，超出详情 UI 和 `TaskDetailSessions` 的寿命。切换到 `/invitations` 等页面可以释放详情会话而保留认证 scope；已提交写入返回可信 not_found 时，先按原 ticket 执行 scope 撤权，再结束 disposed 会话的 UI 处理。已释放会话只保留操作拒绝意图/错误并清自身旧正文，不通知其 UI listener、不补 GET 或重发写入；scope 退出/账号替换仍优先使旧响应失效，旧 E1 仍不能撤 E2。现有四 store RW 事务只在持久 userFence 和 manifest.cacheGeneration 仍等于捕获 ticket 时清除该项目 summaries/details，并写新的 invalidated manifest；不同用户、项目或 generation 不在该 CAS 清理范围。清理失败保留内存拒绝与可见存储错误。beginSync 先重试待处理清理，再建立同步基线；只有新的在线项目同步成功才重新显示私有内容。摘要预览以 scope 的既有退役记录和在线授权判定：未观察过有效撤权时允许首次本地预览；观察后必须重新在线授权，不能因清理跳过了不同 generation 的较新持久集合就恢复预览。hook 在 readProject 前与异步读取后均检查 canPreviewProject；同 scope 的项目导航与重新挂载沿用该判断，普通提示与失败的 Retry/轮询不改变授权。成功 applySync 恢复授权但不清除旧 generation 的退役围栏。该机制不追踪 snapshot 后代或保证删除不同 generation 的磁盘记录，任何保留记录也不能代替在线准入。

负向 BroadcastChannel 提示包含 `{userId,projectId,userFence,revokedGeneration}`。已绑定相同用户 fence 的冷标签页即使尚无投影也记录拒绝；已有投影必须匹配 generation。旧提示不能覆盖较新的投影或待处理拒绝，不转发提示。提示立即撤销复用权限，不等待发送方清理成功；接收方按相同 CAS 范围清理，不能把它当作内容或访问授予。

持久数据不保存在线授权；身份通过核验且生命周期仍有效时，本地摘要允许先行显示，普通可恢复故障保留允许展示的同 generation 摘要及仍获准的详情。退出/换号/401 通过 invalidateScope 同步中止 scope、释放内存，再事务轮换 userFence、清除该用户内容并保留失效 manifest；dispose 仅关闭当前 scope，保留可重用持久记录。

IDB 打开、blocked、异常 close、读取、配额和写入失败进入现有失败/保留快照错误区及 Retry。blocked 5,000ms 后报告错误，迟到打开的连接关闭。重试先重开必要连接并读取真实存储；结构损坏记录原因并完整重建，失败不无限重试。用户记录缺失、归属错误或 userFence 畸形时，不再次依赖该损坏 fence 做项目失效。一个独立的四 store 修复事务直接写新用户 fence、清除该用户摘要/详情，并把其可识别项目基线重建为失效记录；无法识别的项目键被清除。其他用户保持。修复提交前不修改内存绑定、退役 scope 或发送提示；修复失败原子回滚，检测它的 scope 保持可重试并显示存储错误。提交后，尚未绑定的冷 scope 绑定新 fence 再继续原读取；已经绑定旧 fence 的 scope 关闭并发起身份核验，不能采用替代 fence。其他标签页的旧 ticket 在后续事务中被新 fence 拒绝，已完成事务也须通过提交后的 scope 检查才可发布。不引入静默网络模式或新的产品布局。

schema 升级时关闭旧连接，在升级事务清除可重建缓存并轮换生命周期 fence。组件/身份释放关闭句柄、通道、timer 并取消读请求；已提交修改继续由身份级详情会话核对。保留现有筛选、焦点、视口、全屏、滚动和附件 frame，以及对话框、独立任务详情页、独立附件工作区的读取与操作。TaskDetailPage 也使用 useTaskGraph，必须接入相同缓存合同。

## 8. 历史替换与约束

只保留一个项目 cache epoch，避免数据库恢复后要求每个浏览器人工清缓存。支持的恢复/导入/原始替换流程停止全部写入，完成操作后、开放服务前执行受影响项目的 `UPDATE projects SET task_cache_epoch=gen_random_uuid()`。备份本身会恢复旧 UUID，维护流程必须显式轮换。

窗口不会自动识别时钟倒退或绕过正式写路径的修改。运行环境保持数据库时间正常；异常回拨或离线历史维护应恢复时间并轮换 epoch 触发完整重建。维护验收须确认任务时间假设已恢复；导入的未来任务时间不能仅靠 epoch 修正。普通重启保持 epoch。[Task 软删除](daynight-task-deletion.md)在标记删除的同一事务内轮换项目 epoch，旧客户端基线因而获得不含该任务的完整 snapshot。delta 继续只表示当前未删除任务，不增加墓碑字段。显式 removeDepends=true 的删除同时更新每个实际引用源的 version/updatedAt；同一 epoch 替换原子发布源任务关系、ready 和目标消失，不引入逐源同步提交。

服务端先提供新接口，旧 Web/CLI 可继续完整图；随后 Web 切换新路径，建立新的本地 schema。无运行时双协议 fallback。回退旧 Web 后新增索引/epoch 可保留，正式 updatedAt 写路径保持原样，不存在需修复的同步序号遗漏。

## 9. 责任与可观测性

| 所有者 | 职责 |
|---|---|
| server config、README、部署配置 | 正 duration、默认10s及环境文档 |
| store/service/task_sync | epoch/index、同快照窗口读取及容量/权限 |
| server task_sync/auth | 严格 DTO/query、实际用户头与错误 |
| web api/task-sync | 精确时间/version、网络和身份 gate |
| task-cache/database、project-cache | 四 store、生命周期、当前集合合并、重复去重及发布 |
| task-cache/projection | 完整事实到既有图模型的纯函数 |
| useTaskGraph、TaskDetailSession、AuthenticatedApp | 摘要调度、版本驱动详情读取、会话与浏览状态 |
| task-detail/detail-cache | 自身正文验证、物化、受保护持久读写与 LRU |

服务端沿用 slog JSON、request_id/user_id/project_id，记录 phase、mode、since、window、returned_tasks、duration。客户端按周期 UUID 记录 received/changed/duplicate 数、cache_hit、apply_ms 和 error_category；duplicate 包含相等版本与被忽略的旧版本。失败通过 `task-cache/diagnostics` 输出受限深度的清洗 cause：只保留固定错误名称、分类和允许的 API code，不输出原始 message、stack 或任意正文。存储错误仍保留原 cause 错误链供本地处理；不记录 Cookie、令牌或任务正文，不新增遥测上传。

每个 timer、fetch、IDB 事务、提示与详情操作都由当前 scope/coordinator/session 拥有；携带请求 ID、项目和身份 generation，失败回到对应周期，释放后不发布。没有服务端后台清理或日志消费任务。

具体排查：用浏览器响应 X-Request-ID 查询服务标准输出：`jq 'select(.component == "task_sync" and .project_id == "<project-id>" and .request_id == "<request-id>")'`，核对 since、window 与 returned_tasks；浏览器用相同请求及 cycle_id 对照去重/提交。既有请求 ID 验证限制 1–64 字符，首位字母/数字，其余允许点/下划线/横线。

## 10. 验证、效率与设计取舍

数据库测试证明查询边界、精度、配置、快照与项目写锁顺序；不再验证已移除的同步序号。默认10s、其他正值、配置增减及非法配置均有验收。完整图作为投影权威对照。

真实 IDB 验证同时间戳不同任务/版本、迟到响应、当前集合合并、失败原子性、重复零写入、账号/项目清理与升级。双标签页重复结果不广播，不形成请求反馈环；详情不能推进项目覆盖水位。

保留既有四容量图各五次的交互预算。传输测试比较返回 ID 与 SQL 窗口选择的集合，记录重复率及实际字节；不再要求无变化零任务或单根修改只返回一条。窗口中集中修改可能反复返回较多记录，重复传输与无历史同步序号是已确认取舍。

曾比较完整图条件请求、事务修订号、变更日志。完整图变化后仍传全部；变更日志带来历史保留和重放；修订号可避免末尾重复并独立于墙钟，但需要新的每写修订字段。当前选择现有 updatedAt 加配置窗口，并接受重复；不存在固定 requestAt 水位或事后更新时间写入。

## 11. 实施与验证边界

服务端窗口同步接口及历史失效字段、浏览器持久摘要和本地图投影已经接入；完整图仍供其他调用者及对照验收使用。详情会话已使用按需持久缓存、匹配版本复用、变更驱动刷新和 LRU。四 store、详情事务和精确摘要版本接口由摘要缓存拥有；详情模块复用它们，共享 schema、身份、失效和发布所有者。完整链路验收仍以对应源码和真实运行证据为准。

切换浏览器传输时，同时调整现有 fixture、route、waiter 和请求来源统计，使相应阶段的已有检查能够真实通过。完整链路的独立验收使用正式服务、CLI 和生产浏览器，对照窗口集合、重复率、恢复和既有交互预算，不代替实现阶段的测试。

本架构不新增 Agent、CLI 或 MCP 工具。数据读取协议与缓存行为的运行时交付，仍需各自真实数据库、原生 IndexedDB 和浏览器证据。
