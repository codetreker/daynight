# Web 任务缓存与时间窗口增量同步架构

状态：服务端时间窗口接口、10s 配置、项目 epoch 和认证响应归属，以及浏览器 IndexedDB 摘要、原子合并、本地图投影和五秒增量读取已实现。详情持久缓存尚未接入；下文单列其已确认设计，当前详情继续沿用已有会话读取与写操作。

[需求](../spec/daynight-task-sync.md)拥有已确认行为。方案使用任务最大更新时间与默认 10 秒重叠窗口，沿用已有业务 version 去重。[服务端决策](../../.agents/notes/implemented/architecture/2026-10-24-task-summary-window-api.md)和[浏览器摘要决策](../../.agents/notes/implemented/architecture/2026-10-24-persistent-task-summary-cache.md)分别保存协议与本地存储的取舍。

## 1. 总体方案

服务端实现入口为 `internal/service/task_sync.go` 的 `TaskSync.Get`、
`internal/core/store/task_sync.go` 及 `internal/server/task_sync.go`；配置在 composition
显式传给 `NewTaskSync`。`015_task_sync.sql` 提供 epoch 和更新时间索引。
浏览器 `api/task-sync.ts` 严格解码摘要，`task-cache/{database,project-cache,projection}` 拥有存储、生命周期和投影，`useTaskGraph` 保留页面读取接口及调度。详情缓存使用这些共享存储与身份边界，内容复用和淘汰策略仍属于后续接入。

```text
首次完整任务摘要 → IndexedDB → 本地图 / 列表 / 统计
                       ↑
客户端摘要最大 updatedAt → 服务端减去配置窗口 → 返回匹配任务摘要
```

客户端只把已成功合并的项目同步摘要用于计算水位。服务端读取当前任务事实，不保存历史变更流。重复行是协议正常部分；前端借助任务已有 version 判断是否替换内容。

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

epoch 只标识数据历史替换，普通任务修改和服务重启不更新它；已有任务 updated_at、version 不增加另一组同步列。新建与旧项目由迁移/default 获得各自 epoch，不添加 foreign key。

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
| details / [userId,projectId,taskId] | 已建立的详情记录类型：userFence、cacheGeneration、完整自身内容、byteSize、lastUsedAt；内容读写策略尚未接入 |

不存派生 ready/blockedBy，不把 bigint 当作 IDB 键，也不 JSON.stringify bigint。`projects` 的 `by-user` 索引支持用户清理；`summaries`、`details` 的 `by-user` 与 `by-project` 索引支持定向读取和清理。`TaskIntrinsicDetail = Omit<TaskDetail, "ready" | "blockedBy">` 固定详情存储边界，尚不表示详情内容已经持久化。

`TaskCacheProvider` 在认证分支内、`TaskDetailSessionProvider` 外提供同一个 `TaskCacheScope`，同时覆盖项目页、独立任务页和附件路径页。scope 以用户与会话 generation 隔离；普通同用户核验保留它。`beginSync` 返回 epoch、水位和生命周期 ticket，`applySync` 原子应用响应，`readProject` 读取实际持久集合，`getAuthorizedProject` 只返回本 scope 已获在线准入的内存投影。`getSummaryVersion` 和 `subscribe` 提供精确业务版本与变更通知；`detailTransaction` 在相同 fence/generation 校验后开放四 store 内的详情事务。

### 每轮应用

1. 当前身份通过核验后读取本项目 M/epoch 及生命周期 fence，发起网络请求。解码、身份验证与网络等待在 IDB 事务之外。
2. 开一个跨四 store 的 readwrite 事务，重读 userFence 与项目 cacheGeneration，要求仍与请求时的生命周期相符；初次缺失基线也先建立用户 fence。重置/注销后的迟到请求不能重新创建已清理内容。
3. active 项目先校验当前持久集合的 taskCount、edgeCount 与精确最大 updatedAt 是否等于 manifest，并验证行归属、类型和图结构。少一条独立任务也属于损坏；不能把更小集合重新计数后视为正常。校验失败中止本次应用，使基线 invalidated 后无 since 完整重建。校验通过后，delta 从**此刻的完整持久摘要集合**按 id 与业务 version 合并。更高版本替换；相等版本保留原内容且自身字段必须一致；较旧版本忽略。Project 按已有 settings.version 合并，迟到旧设置不得回退。
4. 从合并集合重新计算精确 maxUpdatedAt、依赖与统计并完成图校验。只写真实改变的行、对应详情失效与确有变化的元数据；摘要与水位一起提交。snapshot 在生命周期仍匹配时完整替换并更新 cacheGeneration。
5. 等 tx.done 后发布实际合并的快照。重复行不重写、不触发详情失效，不改变可见任务/索引/布局引用；仍能提供本页新的访问确认与时钟样本。

仅比较 M 是否相等不足以保证内容 CAS：不同任务或任务版本可以共享时间戳。本方案在串行的 IDB 写事务内读取并合并当前集合，不增加另一套本地提交序号。事务内只等待 IDB 请求并做有界纯计算，不等待 fetch、timer 或异步 crypto。1,000/5,000 上限限制全集合校验成本；每轮可能读取全部本地摘要，这个成本实测，不声称本地工作量严格为变化量。

真正需要重建时先使项目基线 invalidated 并分配新 cacheGeneration，再无时间边界取 snapshot。相同 epoch 的空项目后续走 delta，不因重复空集合不断轮换 generation。

### 多标签页与广播

各页独立维持约五秒轮询，无选主。IDB 写事务排序与当前集合的 version 合并防止乱序网络结果回退数据。只在任务自身内容、设置或生命周期实际变化后广播轻量提示；重复结果、显示时钟、纯读取不广播，也不转发提示。

收到提示后读取当前持久集合并按当前身份/项目权限展示；无需仅因提示再发网络同步。首次项目访问仍须本页在线验证；已经打开的页沿用自身时钟锚点，下一正常周期取得新样本。提示不是授权信息，丢失提示时下次正常同步仍重读当前持久集合，保证收敛。

## 6. 投影、时钟与详情

用完整摘要在本地计算 blockedBy、ready、summary，再复用现有 buildGraphIndex 生成链与独立任务分类。所有依赖都参与阻塞，普通依赖决定链成员。验证重复 ID、缺失前置、环、容量及统计后一次发布，不能呈现半批图。

精确比较 UTC 秒部分、补齐到九位的小数及规范 ID，保留原字符串；不能以 Date.parse 毫秒或可变小数的原始字典序排序。时间水位也用相同精度计算。

每次成功实际响应的 observedAt 与解码后立即取得的本页 performance.now 接收值配对，独立推进 TaskExecutionClock。observedAt 不参与 M。磁盘和跨页广播不能提供可复用的单调锚点；设置与重复摘要保持图索引身份。`GraphSnapshot.revision` 当前仍是本挂载每次成功同步的 receipt，使现有详情会话继续工作；它不是任务版本、水位或持久提交序号。跨页读取沿用本页已取得的时钟 receipt。

### 详情缓存接入设计

以下内容复用、持久化与 LRU 尚未接入。当前详情继续在打开及每次成功项目同步后 GET，既有操作会话与未知结果核对保持。

保留 TaskDetailSessions 当前 status、allowAgents、requiredPlatform 三类写操作及其核对语义；状态写入使用 PUT /tasks/{taskId}/status。相同 summary.version 才复用详情内容；描述/PR 单独修改通过业务 version 使其失效。ready/blockedBy 按当前本地投影物化，覆盖前先检查原始服务端差异，保留 stale-graph 检测及修改限制。

打开详情可显示匹配缓存，同时做一次 live GET；成功之前磁盘内容不授予修改权限。重复摘要不周期性 GET 详情，前置派生变化不下载所有后继详情。迟到 GET/写结果核对 userFence/cacheGeneration 与当前业务版本，不能覆盖新内容。比摘要新的结果触发项目同步；确认远端操作与是否缓存 payload 分开，缓存失败不重发操作。单任务响应绝不推进项目 M。

详情预算保留每项目最多 32 条、总量 8 MiB、单条 2 MiB；按 UTF-8 字节和 lastUsedAt 淘汰。超过单条预算的成功读取仍在当前会话显示，按策略不持久化；真实配额/写错误明确显示。附件目录与文件维持现有独立路径。

## 7. 身份、错误与本地生命周期

沿用 AuthenticatedApp 的 foreground /me gate；本地读取与发布也等待该 gate。同步响应在正文、错误信封或破坏性项目失效之前核对 `Daynight-User-ID`。缺失或畸形头是协议错误，保留允许显示的旧视图与持久缓存；可信不同用户使旧 scope 同步失效，立即卸载旧认证内容，再核验身份。只有同用户认证通过的 `404 not_found` 才定向清理项目。

持久数据不保存授权，每次挂载的项目视图在本挂载成功同步前不显示磁盘私有内容；本地命中与广播不能授予首次访问。已打开视图在网络故障时保留并显示现有读取错误。权威 404 立即隐藏项目，保留 invalidated generation 并定向清除；账号退出/换号/失效通过 `invalidateScope` 同步中止 scope、释放内存，再事务轮换 userFence、清除该用户摘要和详情并保留失效 manifest，阻止迟到 bootstrap 恢复它。`dispose` 仅关闭当前 scope，保留可重用持久记录。

IDB 打开、blocked、异常 close、读取、配额和写入失败进入现有失败/保留快照错误区及 Retry。blocked 5,000ms 后报告错误，迟到打开的连接关闭。重试先重开必要连接并读取真实存储；结构损坏记录原因并完整重建，失败不无限重试。不引入静默网络模式或新的产品布局。

schema 升级时关闭旧连接，在升级事务清除可重建缓存并轮换生命周期 fence。组件/身份释放关闭句柄、通道、timer 并取消读请求；已提交修改继续由身份级详情会话核对。保留现有筛选、焦点、视口、全屏、滚动和附件 frame，以及对话框、独立任务详情页、独立附件工作区的读取与操作。TaskDetailPage 也使用 useTaskGraph，必须接入相同缓存合同。

## 8. 历史替换与约束

只保留一个项目 cache epoch，避免数据库恢复后要求每个浏览器人工清缓存。支持的恢复/导入/原始替换流程停止全部写入，完成操作后、开放服务前执行受影响项目的 `UPDATE projects SET task_cache_epoch=gen_random_uuid()`。备份本身会恢复旧 UUID，维护流程必须显式轮换。

窗口不会自动识别时钟倒退或绕过正式写路径的修改。运行环境保持数据库时间正常；异常回拨或离线历史维护应恢复时间并轮换 epoch 触发完整重建。维护验收须确认任务时间假设已恢复；导入的未来任务时间不能仅靠 epoch 修正。普通重启保持 epoch。未来物理删除任务须同时提供墓碑或 epoch 替换，当前不新增删除 API。

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
| useTaskGraph、TaskDetailSession、AuthenticatedApp | 保留现有调度、会话和浏览状态 |

服务端沿用 slog JSON、request_id/user_id/project_id，记录 phase、mode、since、window、returned_tasks、duration。客户端按周期 UUID 记录 received/changed/duplicate 数、cache_hit、apply_ms 和 error_category；duplicate 包含相等版本与被忽略的旧版本。存储错误保留 cause 错误链；不记录 Cookie、令牌或任务正文，不新增遥测上传。

每个 timer、fetch、IDB 事务、提示与详情操作都由当前 scope/coordinator/session 拥有；携带请求 ID、项目和身份 generation，失败回到对应周期，释放后不发布。没有服务端后台清理或日志消费任务。

具体排查：用浏览器响应 X-Request-ID 查询服务标准输出：`jq 'select(.component == "task_sync" and .project_id == "<project-id>" and .request_id == "<request-id>")'`，核对 since、window 与 returned_tasks；浏览器用相同请求及 cycle_id 对照去重/提交。既有请求 ID 验证限制 1–64 字符，首位字母/数字，其余允许点/下划线/横线。

## 10. 验证、效率与设计取舍

数据库测试证明查询边界、精度、配置、快照与项目写锁顺序；不再验证已移除的同步序号。默认10s、其他正值、配置增减及非法配置均有验收。完整图作为投影权威对照。

真实 IDB 验证同时间戳不同任务/版本、迟到响应、当前集合合并、失败原子性、重复零写入、账号/项目清理与升级。双标签页重复结果不广播，不形成请求反馈环；详情不能推进项目覆盖水位。

保留既有四容量图各五次的交互预算。传输测试比较返回 ID 与 SQL 窗口选择的集合，记录重复率及实际字节；不再要求无变化零任务或单根修改只返回一条。窗口中集中修改可能反复返回较多记录，重复传输与无历史同步序号是已确认取舍。

曾比较完整图条件请求、事务修订号、变更日志。完整图变化后仍传全部；变更日志带来历史保留和重放；修订号可避免末尾重复并独立于墙钟，但需要新的每写修订字段。当前选择现有 updatedAt 加配置窗口，并接受重复；不存在固定 requestAt 水位或事后更新时间写入。

## 11. 实施与验证边界

服务端窗口同步接口及历史失效字段、浏览器持久摘要和本地图投影已经接入；完整图仍供其他调用者及对照验收使用。详情会话当前继续已有 GET 策略，按需持久缓存、匹配版本复用、变更驱动刷新和 LRU 尚待接入。四 store、详情事务和精确摘要版本接口已由摘要缓存建立，共享 schema、身份、失效和发布所有者。

切换浏览器传输时，同时调整现有 fixture、route、waiter 和请求来源统计，使相应阶段的已有检查能够真实通过。完整链路的独立验收使用正式服务、CLI 和生产浏览器，对照窗口集合、重复率、恢复和既有交互预算，不代替实现阶段的测试。

本架构不新增 Agent、CLI 或 MCP 工具。数据读取协议与缓存行为的运行时交付，仍需各自真实数据库、原生 IndexedDB 和浏览器证据。
