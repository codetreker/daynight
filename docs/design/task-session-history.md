# Task Session 历史读取设计

## 职责与入口

本文的现有入口与原文读取机制保留原合同。服务端通过 `Daynight-Task-Body-History-Version: 1` 声明正文历史协议支持；生产方必须核对能力后使用正文格式。协议支持不改变旧 Controller 的保存策略。独立历史目录通过 `Daynight-Task-History-Directory-Version: 1` 声明[正文保存与期限规格](../spec/task-session-history.md)中的 `taskHistoryDirectoryVersion=1`。Bot 窗口使用独立的[近期历史能力](../spec/bot-session-view.md#近期历史窗口合同)，不复用 Task 的七天期限。

`core/session` 拥有当前关联、历史目录、读取授权、Controller 内容请求及归档验证。`service/session.History` 根据共享 `Inspection` 的明确 Session 身份协调 live 或 archive 读取，并返回持有归档句柄的 `ReadResult`。HTTP 与 MCP 只解析输入、传递真实 principal、预算包络和输出结果；CLI 通过 HTTP 读取，不能访问 Worker 的文件。

`GET /api/v1/projects/{projectId}/tasks/{taskId}/sessions/current?view=inspection` 返回当前关联；同目录的 `?view=inspection` 返回历史页。默认视图保持浏览器既有协议。`/{sessionId}/inspection` 返回指定身份、`currentBinding`、来源与本次连接的 `contentReadVersion`。`/{sessionId}/messages` 与 `/{sessionId}/message-content` 分别读取一页和一个正文块。

当前关联先取权威执行身份，再观察同一个 Session；关联在此期间改变时返回 `execution_changed`。目录在一个权限作用域内取得当前关联与历史页，不逐项重新观察。旧 Session 不因新 claim 改投另一执行。

## Controller 原文与来源屏障

`PendingContent` 保存的原始条目和 journal 是 live 原文来源。新建 claim 绑定的 Task execution 使用持久 `task_body` 策略，正文与在线工具分别存入 journal，两者合并提供 live 原文；旧 execution 的 `legacy` 策略不随格式升级改变。同步与归档只读正文投影，在线重连和待审批读取仍使用完整合并来源。表、预算及本地退休条件由[SQLite 内容设计](session-sqlite-content.md)拥有。

`inspect_page` 与 `entry_chunk` 使用独立读取投影，不经过 `sessionDisplayEntry`。现有 `sourceThrough` 顺序屏障保证返回内容与确认事件边界相符，响应仍绑定完整 Controller fence 和 history epoch。正文 Controller 核对 WebSocket upgrade 和同步 HTTP 响应的正文历史能力，服务不支持时明确拒绝，不降级重解释已持久策略。

Controller 每次连接发送 `X-Daynight-Content-Read-Version: 1`。服务端只把本次握手值绑定到成功 Connect 创建的 live connection；缺少声明为版本 0，不继承持久注册或旧连接。版本 0 只收到旧 timeline 请求；短条目可读取，显示预算占位返回 `upgrade_required`。重连的能力变化不修改 Web timeline 合同。

`inspect_page` 必须携带 `coverage`。Controller 从原始条目和资源集合计算已知缺口：工具原文的 `truncated=true` 对应 `entry_truncated`；没有此类缺口时，非 available 资源、缺失资源、明确不可用的图片或尚未解决的图片投影对应 `resource_unavailable`。资源闭包复用统一归档遍历，包含消息、工具、Markdown、reasoning 和 retained 绑定。覆盖事实先于条目分页、正文引用和 conversation 过滤确定；服务端按原值传递，空过滤页仍可为 partial。归档先通过格式、引用及完整性校验，合法内容的投影应用同一覆盖规则，并保留归档自己的完整性事实；悬空资源引用仍作为损坏拒绝。

## 页、引用与正文块

历史页默认取 20 条、最多 200 条，先按稳定序列选页，再应用 conversation 过滤。页内从旧到新排列，before 边界基于未过滤页。live cursor 绑定 Session、epoch 和边界序列；archive cursor 同时绑定归档 SHA256。来源或 epoch 改变须重置，不在续页时自动切换来源。

每项完整正文使用规范 JSON；超预算项返回有限元数据和 `contentRef`，其边界仍推进。资源描述符只包含标识、名称、类型、大小、摘要和可用性，预览数量有界且明确标记缺省；名称保留统一图片资源允许的最多 1024 UTF-8 字节。图片几何信息不进入这六字段元数据预览；原始资源引用保留在完整正文内。

正文引用固定 entryId、revision、epoch、来源版本、SHA256 和 UTF-8 字节数。块读取校验全部身份，从指定字节偏移返回最多 32 KiB，块尾退到完整 Unicode 码点。所有数字序列、大小和偏移以十进制字符串表示。原文重建后可用摘要和字节数校验；变化返回 `content_changed`，不拼接不同版本。

页与块生产方计入完整编码响应预算。HTTP 传入换行开销；MCP 计入实际请求 ID、协议版本、批次边界与 meta 等包络开销。此专用 256 KiB 预算不会恢复普通资源读取的通用预算。MCP 成功结果使用普通 JSON 编码；工具发现省略 `outputSchema`，协议测试直接断言实际结构化结果。

MCP 在 SDK 执行前拒绝包含历史读取的多调用 batch 和无法容纳的请求 ID，避免其他结果或 ID 回显突破历史响应预算。独立读取及单调用 legacy batch 使用最多 256 KiB 的专用响应缓冲；完整编码后才提交，分次写入或错误包络超限时统一返回有界 `resource_limit_exceeded`。其他工具保留既有编码路径。归档许可持续持有到缓冲结果最终写出或取消。

## 归档与权限生命周期

正文历史同步在原有四字段 `historyEpoch`、`sourceThrough`、`entries`、`resources` 之外显式携带 `contentPolicy=task_body` 和 `onlineImageOccurrences`。旧格式仍严格使用四字段；正文格式只允许 claim 绑定，条目仅限用户和助手消息。首次提交的策略归原 Session ledger 持有，后续同步不能改变。`sourceThrough` 继续覆盖完整源事件序列，条目序号允许因工具排除而不连续。

在线工具及 reasoning 图片使用最多 4096 个累积位置描述，不上传工具正文。位置集合保护同一 Session 的捕获身份，工具修订移除图片不会移除仍有引用的旧位置。最终 settling history 必须提交空位置集合；服务端在同一引用事务内解除在线图片引用，独占资源交给既有上传回收及读取租约机制处理，共享正文图片保持引用。

schema3 manifest 的文件与资源布局保持不变，正文变体新增 `contentPolicy=task_body`。读取方同时验证策略与实际 timeline 类型，不能把工具条目装入正文归档。原始 `/archive/content` 读取正文变体要求请求头 `Daynight-Task-Body-History-Version: 1`；旧读者收到明确 `upgrade_required`，旧 manifest 仍可无该头读取。新 Web 读者保留策略元数据，并说明归档只保留消息及其图片。历史页与正文块的旧 JSON 字段不变；协商请求可从 `Daynight-Session-Content-Policy` 响应头识别正文归档。live 原文仍供在线工具查看，不伪装成正文历史。取舍见[协议决策](../../.agents/notes/implemented/architecture/2026-11-19-task-body-history-protocol.md)。

正文保存能力的生产入口按条目类型形成持久投影，后续同步、容量统计和归档消费同一投影。消息正文及其资源闭包保留；独立工具详情继续供在线显示，但不进入正文归档。传输确认水位、待确认事件和执行控制由各自账本持有，不能因投影排除工具而丢失确认或后续正文。旧格式归档保留原工具内容与读取校验，策略有意排除的工具不作为正文覆盖缺口。

期限计算与持久化由 `core/session`、`core/store` 和 PostgreSQL 的 `session_archive_retention` 共同提供，规则见[七天期限合同](../spec/task-session-history.md#七天期限与任务链目录)。每份普通 Web Task 归档在原成功发布事务内通过 `RecordSessionArchiveSuccess` 写入服务端首次成功时间；重复成功和旧格式转换保留原记录。Bot、Test Session 与 Herdr 不进入此期限表。期限迁移对既有 ready 归档保存明确的 `grace_until`，历史首次时间保持 null，不能从 `updated_at` 推断。清理启用迁移对当时仍未过期的 ready 旧格式普通 Web Task 归档，将宽限下限一次性抬到启用时刻加 7×24 小时，保留已有更晚宽限及真实首次成功时间，清空旧候选期限并推进版本。该规则也覆盖期限迁移之后成功发布的旧格式归档；schema3 的正文策略由持久 bundle ledger 的 `ContentPolicy=task_body` 区分，不能单凭 schema3 排除旧格式。已过期记录不复活，重新启动或重跑迁移不刷新宽限。

目录与清理消费者对已有成功归档，必须在 `WriteArchiveRetention` 的 callback 内调用 `RefreshArchiveRetention`。该事务先以共享模式锁 Project，与任务状态及依赖写入的 Project 排他锁互斥，再锁指定 Session、归档和期限记录。DAO 读取当前双向普通依赖连通分量，排除外部依赖、Goal 成员关系及已删除成员；core 选择 done 的 `completed_at` 或 cancelled 的 `cancelled_at`，取所有成员的最大终态时间。期限为其与首次成功时间的较晚值加 7×24 小时，再受升级宽限下界约束。成员未结束时清空期限；必需终态时间未知时保持未知。旧首次成功时间未知但存在明确升级宽限时，以已知终态时间和宽限计算，同时保留未知事实。尚无首次成功记录的 pending／failed 归档由原状态读取入口表达，不因查询期限创建成功记录。

`SaveArchiveRetention` 按原期限版本保存候选期限、原因和全部成员版本，并在同一事务推进版本。每次使用前重新计算，因此重开、连链和拆链后不会沿用缓存期限。已标记过期的记录不复活。保存的成员版本是该次决策的证据，不是目录分页图版本，也不是事务外删除许可。目录仍须在自己的授权和一致图版本下组装链、成员与原 Session。`WriteArchiveCleanup` 在相同的 Project 到 Session 锁序下提供期限与资源 DAO；core 的 `ExpireArchive` 刷新期限后，DAO 按观察版本、到期时间与 ready 提交状态原子写入 `expired_at`。期限事务不能嵌入已经持有 Task／Session 锁的归档事务，以免反转 Project 到 Session 的锁顺序。

过期事务解除归档引用，以及通过 committed capture 的 image ID 和 resource ID 证明属于该历史的 message 引用。未知 message 引用、upload、operation 和 native_resume 引用继续保留；只有最后引用消失的资源进入 `gc_pending`。普通 Task 内容读取、图片读取、Controller 内容操作和归档上传在授权及 Session 锁定后检查过期屏障；摘要查询和操作回执保持独立读取用途。旧入口返回既有 `history_unavailable` 并说明历史已过期，不伪造空页，也不改变归档状态枚举。

service 的后台清理器在应用启动后扫描每页最多 32 个原 Session，按 UUID 推进游标，每分钟处理一页并在末页重置；没有缓存期限的归档也会重新计算。单个目标最多处理十秒，整页最多一分钟。长时间未结束的链不会阻挡游标后面的候选。事务确认过期后，清理器在数据库作用域之外取得原 owner 的归档驻留许可，并逐一取得持久化媒体租约对应的文件锁。许可仍占用时保留责任，下一轮继续。只有原读写退出后才删除 typed archive namespace 中的正文、暂存及迁移旧文件，并按可信 namespace 删除 `gc_pending` 图片的精确 blob；Task 附件和 Bot 目录不在这些地址范围内。

全部文件释放与资源记录回收确认后写入 `cleaned_at`，清除归档 bundle、文件、分块、迁移明细与旧内联时间线，保留原 Session、轻量归档和期限摘要及独立操作回执。物理删除失败或事务完成未知均保留过期屏障与未完成责任，重启后继续；已经过期的责任在 Task 或 Project 软删除后仍可完成。应用停止时先取消并排空清理器，再关闭其借用的文件存储与数据库。资源仍被独立引用时，其字节继续保留，不因归档过期删除。

归档文件 schema、正文策略能力和目录能力分别版本化，旧 `view=inspection` 响应保持原形状。期限摘要保存 `reason`、成员版本和时间，归档摘要保留原提交字节数；目录统计须区分逻辑内容量与实际文件占用。取舍见[期限持久化决策](../../.agents/notes/implemented/architecture/2026-11-19-task-archive-retention.md)及[清理决策](../../.agents/notes/implemented/architecture/2026-11-19-task-archive-cleanup.md)。

### 分组历史目录

以下独立 GET／HEAD 入口均返回 `version: 1`、精确十进制字符串 `graphVersion`、`items`、可空 `nextCursor` 和服务端 `observedAt`，并设置 `Cache-Control: no-store`。只接受 `limit`（默认 20，范围 1–200）与 `cursor`；新字段不加入旧 Session 目录。

| 入口 | 内容与排序 |
| --- | --- |
| `/api/v1/projects/{projectId}/history-directory` | 当前普通依赖链及独立 Task；`scopeEndedAt` 倒序、未知和未结束项置后，同时间按 `groupId` 升序。 |
| `/api/v1/projects/{projectId}/history-directory/{groupId}/members` | 组内成员，按 `taskId` 升序；无对应当前组时为空。 |
| `/api/v1/projects/{projectId}/history-directory/tasks/{taskId}/sessions` | 原 Task 历次 Session，按创建时间与 Session UUID 倒序；不存在或不可见的 Task 不返回历史。 |

组 ID 是当前普通依赖连通分量中的最小 UUID，不是持久资源；Goal、外部依赖、软删除成员不参与分组。组项保留 `kind=chain|task`、成员数及 `timeState=ended|unfinished|unknown`。成员项保留标题、状态、终态时间和时间状态。Session 项保留原 Session、claim、执行代次、内容类型、创建时间及 `currentBinding`；后继 claim 不改变原记录身份。Web Session 没有可靠的单次执行终止时间时，`endedAt` 保持 null。

`GroupDirectory` 在同一只读 repeatable-read 快照内复查凭据与项目权限，调用 core 目录规则及 PostgreSQL DAO。当前 Task 权限继承项目；有效删除视图进一步排除失效资源。每页游标绑定账号、项目、入口、目标与目录事实摘要。摘要包含项目任务版本、原 Session 身份及目录可见归档事实，排除心跳；后续页事实变化返回 `reset_required`，客户端重新读取首屏。`graphVersion` 是该摘要的精确十进制表示，不是递增计数。每种展开独立分页，成员和 Session 不内嵌在组页。

Session 页用同快照的当前完整链及首次归档、宽限和实际过期事实调用 `CalculateArchiveRetention`，不更新数据库或沿用缓存期限。`archiveState` 为 `pending|unavailable|failed|ready|partial|expired`，`completeness` 保留缺口标记。`retentionState` 为 `waiting|unknown|scheduled|expired`，`reason` 区分未结束、时间缺失、待归档及已过期。`scopeEndedAt`、`firstArchivedAt`、`legacyGraceStartedAt`、`expiresAt` 和 `expiredAt` 保留真实时间或 null；宽限起点由持久化宽限下限减七天得到。只有 `expired_at` 已提交才显示 expired，超过候选期限不伪造删除完成。Herdr 保留终端录像类型，不套用 Web TTL；没有归档记录时保持 `pending`，已持久化的不可用回执显示 `unavailable`，`reason` 优先保留回执的真实原因，缺少时兼容持久化 `error_code`（如 `recording_not_enabled`、`ended_before_first_sample`），缺少原因时为 `archive_unavailable`。其它 Herdr 状态的期限原因是 `not_applicable`。内容继续由原 Session 的既有读取入口授权并提供，此目录不搬运正文。

组查询计算当前连通分量；成员及期限查询只遍历目标链。Session 查询只投影执行代次和末次终止时间，不返回完整快照或终端运行记录。目录事实摘要需要扫描项目历史元数据，组计算的成本随项目图增长；页大小只限制返回条数，不代表图计算成本。机制取舍见[分组目录决策](../../.agents/notes/implemented/feature/2026-11-19-task-history-directory.md)。

CLI 的 `list --directory-version 1` 消费独立的 Task Session 页，GET 成功响应必须同时具有 `Daynight-Task-History-Directory-Version: 1` 与正文 `version: 1`。独立 DTO 解码器验证原 Task、Session 唯一性、模式与内容类型、分页上限及字段类型，并拒绝未知字段；`graphVersion` 保持十进制字符串。默认 `list` 仍消费旧 inspection 目录，不混入新增字段。版本化续页命令携带相同版本选项，失败保留服务端拒绝，不自动切换入口或重试。正文与 `show` 继续走原 Session 入口；正文 `history_unavailable` 的已知过期原因映射为固定诊断，其他不可用原因不被误判为过期。

首次读取通过 inspection 确定可用来源；带 cursor 的请求必须维持其来源。归档走 `ArchiveContentReserved` 的权限、预留、大小、摘要及格式检查，然后只投影请求页或块。schema3 在同一个归档操作中验证 manifest 并读取其独立 timeline，不生成 schema1 兼容副本；共享归档许可和 timeline 读取 lease 均随结果句柄保留到响应交付完成或取消。旧格式仍可能完整物化最多 64 MiB，因此 MCP read/entry 选择 `BudgetLarge`。预检与驻留许可随结果句柄保留到 HTTP 响应完成或取消；MCP 绑定请求交付作用域，不能在工具 callback 返回时提前释放。

Task 内容读取使用单独的授权目的，允许真实 PAT、browser Session 以及固定 API/MCP OAuth binding，并逐页、逐块重新检查。SessionDAO 在原事务中委托 family DAO；API 必须匹配配置 Origin 下的 API resource、daynight:api scope 和 societas-bot client，MCP 保留原 Task 读取子集。可读归档预检保留原 WriteSession 的 READ COMMITTED 事务作用域，其中 ReadOAuthCredential 使用无行锁查询；API 可进入既有用户可读归档，MCP 仅可进入原 Task ArchiveV1Read。实际 IO 准入再次使用原 scope、权限及锁序；独立 Session 保留 owner 与 parent PAT 检查。Controller 注册、生产 channel、归档上传与完成仍使用原生产者条件。网络内容等待后再次授权，并拒绝变化的 fence/epoch。pending、缺件、损坏、来源变化、空历史与可证明的覆盖缺口保留独立结果，不把无法判断的完整性当作已验证事实。

## 客户端与验证

CLI 的 current/list/show/read/entry 每次读取一页或一块，文本先按 LF 分行再执行 `terminalText`，JSON 保留完整 body 或显式引用。历史内容是被观察数据，不成为指令或新的授权。MCP 对应工具复用相同用例及身份字段，输入 schema 拒绝未知参数；正文不会经过 shell。

Controller 用真实 journal 验证分页与大条目，协议测试核对跨语言规范 JSON、Unicode 和版本错误。core 验证权限、来源与内容规则，service 用直接业务操作 mock 验证编排与句柄生命周期，HTTP/MCP 用直接用例 mock 验证协议、实际包络大小、取消与交付后释放。DAO 的真实锁和跨调用读取保留隔离 PostgreSQL 证明。

要求见[历史读取规格](../spec/task-session-history.md)，取舍见[决策记录](../../.agents/notes/implemented/feature/2026-11-10-task-session-history.md)。
