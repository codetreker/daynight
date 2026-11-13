# CLI SQLite 数据库格式升级设计

## 结构与责任

[升级需求](../spec/cli-sqlite-migrations.md)定义自动重置、升级和数据保留结果。各业务 store 明确选择自己的 SQL 目录和准入规则，目录内的文件名给出本库格式版本与执行序列；公共模块复用加载、执行与连接生命周期，不扫描数据库来选择 store，也不维护全局版本或数据库内的迁移账本。

| 责任 | 所属模块 |
|---|---|
| 版本定义、来源检查、迁移顺序和当前版本断言 | `platform/sqlite-format.ts` |
| 明确缺失判定、只读快照与重开、同步写事务和连接关闭 | `platform/sqlite-access.ts` |
| 有限的访问错误与安全诊断表示 | `platform/sqlite-error.ts` |
| 所属目录的文件名迁移链加载及本库参考结构元数据 | `platform/sqlite-sql.ts` |
| 原实例锁和严格不接管的同步维护 permit | `platform/instance-lock.ts` |
| 本库基线 DDL、已交付转换、业务准入和必要结构检查 | 各 store 的 format 模块 |

格式定义包含基线版本及建库函数、连续的后续迁移和按版本验证函数，不包含无版本来源验证或接入 callback。SQL 主链在格式模块初始化时从所属目录加载并按文件名排序；建库和迁移 callbacks 在传入 Database 上执行已经加载的 SQL 或本库 JSON 转换，返回类型为 `undefined`，拒绝误传 async callback。每步迁移同时接收本次事务初始识别的 `SqliteSource`；该来源不随中间 `user_version` 推进改变，领域转换可以据此保留旧格式的完整性限制。版本由执行器统一推进，迁移不自行提交或开始事务，也不操作 Git、网络或原生进程。Controller journal v6 的领域迁移还须先把旧正文可靠导出到本执行的待归档文件，再执行正文表删除及索引转换；SQLite 回滚不能撤销已落盘文件，重试须核对并复用它们，不能提前清除唯一正文源。v8 进一步把经原 SQL 索引精确验证的旧文件转换为不可变候选，提交指针决定可见性；不接纳超前、未登记或不一致的旧文件。候选落盘但 SQL 回滚时保持不可见，并保留原迁移源。该例外由 [Session 归档设计](task-session-protocol.md#完成后的文件归档)拥有，公共执行器不承担文件迁移。

## SQL 资源与参考结构

每个 owner 明确提供自己的 SQL 目录。`loadSqliteSequence` 只发现顶层名称以大小写不敏感的 `.sql` 结尾的候选，再要求候选为命名合规的普通文件，并按名称字典序排序。无关非 SQL 文件和普通辅助目录被忽略，不递归发现迁移。文件名前缀直接给出版本；首文件作为基线，其余文件成为后续迁移。TypeScript 不保存逐步文件清单或另一份排序，增加合规编号文件便自动进入序列。

| Owner | SQL 主链目录 | 当前文件 |
|---|---|---|
| Review | `commands/review/sqlite/` | `001-baseline.sql`、`002-publications.sql` |
| Worker 主索引与清理调度 | `commands/worker/sqlite/` | `005-baseline.sql`、`006-cleanup-schedules.sql`、`007-resource-cleanup-intent.sql` |
| Web 执行状态 | `commands/worker/backends/sqlite/` | `001-baseline.sql`、`002-resource-observations.sql`、`003-orchestration-blockers.sql` |
| Controller journal | `commands/controller/sqlite/journal/` | `001-baseline.sql`、`002-projection.sql`、`003-operation-acknowledgements.sql`、`004-projection-gap.sql`、`005-resources.sql`、`006-pending-content.sql`、`007-image-input.sql`、`008-publication.sql`、`009-message-origins.sql`、`010-timeline-content.sql`、`011-outbox-accounting.sql` |
| Native resume lease | `commands/controller/sqlite/resume-lease/` | `001-baseline.sql` |

文件名遵守 `NNN-description.sql`：数字前缀至少三位，同一目录使用相同宽度的补零；版本数值为 1–2147483647；后缀是以小写 ASCII 字母开头、由小写字母或数字组成且可用单个 `-` 分段的名称，扩展名必须为小写 `.sql`。首版本可以大于 1，之后必须连续。顶层 SQL 候选中的非法名称、非普通文件、重复版本、宽度不一致、空 SQL 链和中间缺号都在用户库打开前失败；例如大写 `.SQL` 和名称以 `.sql` 结尾的目录会进入候选检查并被拒绝，而 `README.txt`、`.DS_Store` 及普通非 SQL 目录不进入主链。

五个基线及各自连续编号的升级 SQL 资源；Worker 历史来源参考和条件接入资源已由统一版本 0 重置取代。SQL 文件不写 BEGIN/COMMIT 或 PRAGMA，事务、user_version、JSON 和 owner 逻辑仍由 TypeScript 边界控制。

`sqliteSchemaSnapshots` 在格式模块初始化时，把同一组按文件名发现的基线和升级 SQL 依次执行到短生命周期的内存 SQLite 中，按步骤缓存 SQLite 自己生成的 sqlite_schema 元数据，然后确认关闭连接。实际用户数据库尚未打开；后续来源检查只使用已缓存的本库参考，不为每次访问重新建参考库。这个过程不复制用户记录、不读取原生历史、不生成持久标记，也不维护另一套预期 DDL 或用 SQL parser 重建结构。

非零已交付来源仍是有限集合，不推导任意手改 SQL 的语义等价。版本 0 不读取来源参考或验证业务 JSON，其原 schema 和数据在准入后被重置。资源读取及参考结构构造发生在用户库打开前；SQL 的语法或执行错误在对应执行边界暴露。

目标版本由实际发现的主链末尾给出。没有清单或第二套期望序列时，连续链缺少原本末尾文件无法仅靠目录发现判定；不能把中间缺号检查宣传成任意文件缺失检测。构建和安装验证核对实际源码目录与产物中的完整文件及字节，已交付 SQL 文件的保留仍属于源码变更审阅要求。

构建在清理 dist、编译 TypeScript 后运行 `scripts/copy-resources.ts`，明确复制两个 skill bundle、上述五个 SQL 目录到相同的 dist 相对路径；SQL 目录递归复制 `.sql`。构建的目录 allowlist 只控制发布范围，不提供文件执行顺序。既有 `files: ["dist"]` 发布规则将资源带入安装包，目录 URL 在源码和编译产物中保持同一相对定位。资源复制和安装验收验证实际发布字节，不能仅凭源码中存在文件认定安装包完整。

SQL 资源、参考元数据和文件名执行顺序的取舍见[升级决策](../../.agents/notes/archived/architecture/2026-10-30-cli-sqlite-migrations.md)。

Controller 的 `010-timeline-content.sql` 通过同一编号序列启用 v10。原 journal 格式拥有者构造完整 schema snapshots 并执行同一版本校验；010 的领域 callback 先完整验证并捕获原已提交指针，再在同一迁移事务执行包含旧索引删除的完整 DDL、重新核对文件、导入正文并核对统计。DDL 只执行一次；失败回滚恢复原索引。普通正文读写统一消费当前 SQL 行，旧文件解码器仅供编号迁移。当前行、历史源验证、局部峰值预留与停止维护由 [SQL 正文设计](session-sqlite-content.md)拥有。011 在同一许可、预留和迁移事务中建立 `outbox_totals`，对旧 outbox 编码文本逐行计算 UTF-8 字节并一次初始化；版本和总量一起提交或回滚。正常重开不重复初始化。容量与 ACK 计量由 [Controller 协议](task-session-protocol.md)拥有。

## 独立版本与起点

| 库 | 基线及迁移 |
|---|---|
| Worker | 七列 tasks 为基线 5；版本 6 增加独立 cleanup_schedules；版本 7 删除 notified/submitted，保留项目、任务、清理身份、期限与重试策略；非零旧详细库 1–4 拒绝 |
| Review | 基线 1，原 1→2 增加 publication 并保留历史发布语义；当前仍为 2 |
| Web 执行状态 | 基线 1；版本 2 移除 cleanup 的重复操作回执及资源完成标记，保留意图、期限和操作身份；版本 3 新增独立编排阻塞表 |
| Controller journal | 基线 1，依次保留 ACK/projection、operation acknowledged、projection gap、source floor/resource 的 1→5 转换，以及正文导出到文件和内容索引的 5→6 转换；版本 7 增加图片意图、出现及采集账本，版本 8 增加不可变内容指针与原生输入关联提交，版本 9 保存输入消息来源及原消息关联，版本 10 将当前正文与统计迁回 SQL 并登记旧文件待退休；版本 11 建立 outbox UTF-8 字节累计值 |
| Native resume lease | 基线及当前版本 1；任何保留 lease 阻止重置或迁移 |

新库和版本 0 重置使用同一基线及后续步骤，避免另一套最新 DDL 漂移。版本 0 丢弃旧 schema 和数据；已有空版本 0 文件也通过这一路径初始化。文件创建许可 `allowCreate` 只作用于缺失文件，`inspectSqlite` 和 `upgradeSqlite` 没有空库许可参数。非零版本范围为正的 32 位有符号整数，负数、缺步、逆序、未知和较新版本均拒绝并保留原库。非零来源结构检查由本库维护，参考元数据来自上述实际 SQL 链，覆盖迁移需要的表、列、主键、必要索引、约束和 STRICT 属性，只接受有限的已交付布局。

已知非零迁移保留业务记录及原有转换语义。Web 版本 1→2 在 SQL 中移除重复的 cleanup 操作回执和资源完成字段，当前 parser 读取迁移后的清理意图，不在运行时代码兼容旧字段。Web 2→3 只新增 orchestration_blockers 表，不改写原执行 JSON；旧版本受版本守卫保护而拒绝新库。其他 Web 字段保留原有解析语义；未来收紧字段仍需新增版本转换。Journal 的非零升级保留原有 JSON 字符串、序列、ACK、原生身份和 BLOB，不把原类型断言当成已经增加全面运行时校验。

## 连接来源与所有权

`SqliteDatabaseSource` 接受绝对文件路径或已经打开的原生 `Database.Database`。生产入口继续提供文件路径，按 `allowCreate` 打开文件并保留 WAL、FULL 同步、缺失判定和维护锁行为。显式提供连接时，访问层复用该连接并通过 SQLite 的 `memory` 属性选择真实 journal mode：内存连接使用 MEMORY，文件连接仍要求 WAL；两者都执行相同的格式检查、迁移、业务准入和同步 startup 事务。迁移事件及错误使用连接的 `name` 标识来源，内存连接显示为 `:memory:`。

可写 opener 接管提供的连接；返回的 store 负责关闭，初始化失败按实际事务和关闭结果报告。只读入口借用连接，调用方继续负责迁移互斥与最终关闭。借用读取暂时启用 `query_only`，在同一个 DEFERRED 事务中检查格式并查询，随后恢复原设置；需要升级时在该连接上完成转换后再读。这个入口不检查文件缺失或申请文件系统维护 permit，失败也不代替连接所有者关闭数据库。文件路径入口继续采用下面的独立只读连接与维护重开流程。

Controller 的文件路径还标识原资源目录及历史迁移源，因此保留 `file` 参数，并通过 options 中的 `database` 接收显式连接。内存连接不对数据库文件执行 chmod；ticket/generation 校验、writer 认领和当前 SQL 正文核对仍处于原来的 startup 事务。Git、IPC 和正文文件各自保留真实资源生命周期。

## 事务与业务启动

`inspectSqlite` 不修改数据库；`upgradeSqlite` 要求已有 immediate 写事务，并在事务内重新检查来源，不接受等待写锁之前缓存的迁移计划。版本 0 在业务准入后重置用户 schema，再执行基线与全部后续迁移、验证目标并推进 `user_version`。非零受支持版本只执行未完成步骤。

重置、迁移及包含迁移的 startup 使用明确的同步 BEGIN IMMEDIATE、action、COMMIT 边界。访问层记录连接原有的 `foreign_keys` 设置，仅在非空版本 0 重置前于事务外临时关闭并核实；空版本 0 初始化和非零迁移保持原设置。低层 `upgradeSqlite` 要求非空版本 0 的调用者已在 BEGIN 前关闭外键。事务内先完成业务准入，再删除用户 trigger 和 view，随后删除全部虚拟表，让模块清理自身 shadow 表；通过 `writable_schema=RESET` 重新加载 schema（仍禁用 schema 写入），再重新枚举并删除全部残留用户表，包括最初被识别为 shadow 的 FTS5 外部内容表。基线、升级和 onReady 完成后，每次实际发生的非空版本 0 重置都执行 `foreign_key_check`，通过后才能提交，与连接原有外键设置无关。DROP、基线、升级、数据、版本和 startup 一并提交或回滚，不删除或替换数据库文件。action 或提交失败时，若仍有活动事务则尝试回滚；回滚也失败时保留两个错误。已有活动事务和 Promise/thenable 结果明确拒绝。该边界不嵌套现有普通业务 transaction/savepoint；已归属运行期事务只断言当前版本，不在业务回调里迁移。

Controller 在新 writer generation 提交前，以同一 permit 完成编号升级、待退休正文维护和正常物理准入。升级本身的 DDL、导入与版本使用同一 immediate 事务；停止维护在事务外完成 reader barrier、退休与 VACUUM。runtime 随后将 ticket/generation 校验、writer 认领、预先采集的 Controller proof 与新 generation 一次提交，原生副作用在该提交之后。纯升级不认领 writer 或推进 generation。Controller 的迁移工厂以实际迁移连接建立局部 `JournalMigrationContext`，通过原存储 permit 和预留写入能力准入，当前格式读取不调用 context provider。Lease 的建库/迁移、查重和首个 INSERT 同样在一笔事务内。原有异步的文件、账号和进程证明准备留在事务外，最终事务重查稳定身份与格式。

可写连接先在一个短 DEFERRED 读取事务内完成整个来源初检，使 user_version 和所有非零来源结构读取属于同一快照。版本 0 只识别重置，不执行历史 schema 或 JSON 来源验证。该读取事务结束后，才配置 writer 所需的 journal mode 和 FULL 同步；文件连接使用 WAL，显式内存连接使用 MEMORY；随后取得 IMMEDIATE 写事务并重新检查版本、结构及所需外键模式，不把初检结果当成迁移依据。如果并发 writer 已使来源改变、所需外键模式与连接不符，先结束这笔尚未运行准入或 startup 的纯读取事务，在事务外重配后重入；至多一次交接，再次模式变化明确失败。只有模式匹配才运行准入和迁移。这样并发连接提交升级时，初检仍看到完整的旧格式，后续写事务则使用实际已提交格式。事务原子性覆盖结构、记录和版本，不承诺 journal mode 或数据库/WAL 文件逐字节回到打开前。SQLite 的单 writer 和事务语义见[官方事务说明](https://sqlite.org/lang_transaction.html)；同步 callback 的约束见 [better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/docs/api.md)。

## 查询与维护连接

```text
明确缺失判定
  → readonly deferred 快照：版本检查与查询
  → 当前格式直接返回
  → 版本 0 或可升级非零来源：关闭读取连接
  → 所属领域的升级准入
  → fileMustExist 可写连接，immediate 事务内重查并迁移
  → 提交/回滚，确认关闭
  → 新 readonly 快照重查当前格式并查询
```

当前格式不取得实例锁、不打开写连接、不扫描全库 JSON。查询只执行必要的格式重置或升级，不启动监控、创建 Controller、认领 native writer 或恢复审查。最终快照拒绝较新/未知格式和额外退回旧格式；锁冲突后至多再读一次，允许并发调用已完成升级的情况，不循环重放操作。

只读打开失败需要结合文件系统重新确认缺失，不能仅凭 SQLITE_CANTOPEN 返回空结果。非目录父路径、权限错误和损坏文件均保留错误；已有空版本 0 文件经过维护准入后初始化。用于迁移的现有文件连接要求 fileMustExist，防止检查后消失却被重建。

## 领域准入与资源关闭

Review runtime 继续使用普通实例锁；旧格式 listing 的维护 permit 使用相同 gate 与锁文件位置，但拒绝接管任何已有锁。运行模式接管死 PID 会保留“前代进程未排除”的事实，纯迁移不能接管后删除它。Worker runtime 已持同一个 Worker 锁，分别升级主索引和 Web 库；两库任一失败时不启动 coordinator。

维护 permit 只在锁原本不存在时创建自己的 owner。取得 permit 前必须提交并确认 gate 连接关闭，随后才打开业务迁移连接；Worker gate 与业务库共用文件时尤其不能持有 gate 写事务再开第二个写连接。迁移连接关闭或事务结果未知时保留维护锁。释放先经 gate 核实 exact owner 并确认 gate 关闭，再核对并删除自己的锁；该同步过程中的 live owner 阻止遵守协议的 acquisition 替换它。普通 runtime 释放语义保持。

Journal 在任何 DDL 前执行 owner 准入：版本 0 没有 `execution` 表时可重置；若该表存在，必须读取 `id` 和 `owner_pid`，缺列或读取失败直接报错，活跃或不可确认 writer 阻止重置。非零版本继续按既有结构读取 owner。纯格式处理不执行 writer 认领或 generation 推进，也不产生停止证明；非零纯升级保留 owner_pid，版本 0 准入成功后的重置会丢弃旧 execution 数据，但不删除独立待归档文件。缺少 execution 身份记录时，后续启动拒绝采用非空待归档源，保留文件供处理；相同 Session ID 不能代替原 execution/ticket 身份证明。所有可写 journal opener 持有同一 execution 的存储 permit；writer 贯穿整个生命周期，停止记录、升级和归档本机阶段复用或显式取得它。只有明确 ESRCH 可接管原存储 owner，当前格式纯读取保持无锁，旧格式文件读取才取得 maintenance permit；借用旧格式连接须显式绑定原 permit。独立 stopped writer 在事务外验证进程树，最终事务比较当前格式、原 snapshot、ticket_hash 和 owner_pid 未变后写入 stopped。三角色准备、真实容量准入、同意图锁等待与资源收尾由 [Controller 存储设计](task-session-protocol.md#controller-与原生会话)拥有。Journal close 清除 owner_pid 也是持有原 permit 的写入口，失败时仍尝试关闭并保留真实事务结果和错误链。

Lease 的重置或迁移准入要求已有 lease 表没有任何保留行，版本 0 没有该表时可重置；陈旧、过期或 PID 缺失都不提供回收权限。已取得租约的 release 在同一事务内断言当前格式，按 native_key+nonce 删除并验证恰好一行，不进入自动升级路径。其业务释放仍要求原有“从未启动”或完整停止证据；未返回申请的已知提交清理由下面的独立边界约束。

首次建库或重置的事务也可能已经提交 onReady 中的本次 INSERT，却在完成 reporter 抛错后未将连接返回申请者。申请过程分别保留“已插入”和“已取得返回连接”的事实：只有提交明确成功、原连接关闭已确认且申请尚未返回、新原生执行尚不可能启动时，才用 fileMustExist 的新连接进入当前格式事务，核对本次 native_key 与 nonce 并删除这条租约。该行已不存在表示没有本次遗留；nonce 不同则拒绝删除。提交或关闭未知时不进入这条协调路径。原 reporter 错误仍是申请失败，协调或关闭再失败时聚合原始对象，不把清理成功报告成申请成功。

## 错误与诊断

格式、迁移和文件错误不能被归为无状态或 IPC 不可达。Web 的 IPC try/catch 只包含请求，随后的本地 store 更新失败直接传播。独立 Controller 的退出路径保留 journalFailure，同时继续停止自己已归属的进程；停止证明不完整时不归档、不伪造 nativeStopped，也不释放 resume lease。

连接适配层区分未开始、已提交、已回滚和未知事务结果。提交前失败按既有回滚、结果记录和私有连接关闭边界处理，保留原始错误；外键设置恢复只属于提交后的连接返回边界。COMMIT 成功后先记录已提交，再恢复并核实原 `foreign_keys` 设置，完成后才返回连接。恢复失败使用独立的 `restore-foreign-keys` 阶段，关闭连接后报告 `cleanup-failed` 和已提交结果，不重放已提交操作。提交成功后 close 失败同样仍报告已提交；操作和回滚/关闭双失败聚合原始对象，不自动重跑。实际原因修复后，再次打开按真实版本识别。当前五个目标 schema 及 onReady 不含外键；增加依赖外键动作的目标格式或 startup 必须重新审查此重置边界。

同步迁移事件复用 stderr 与现有 Worker JSONL。数据库名称、路径、阶段、源/目标版本、步骤、migrationId 和结果采用有限字段，版本 0 转换使用 `reset` 事件；原 cause 留在内存。文本及 JSONL 对访问错误使用安全表示，避免 JSON parser 的原 message 或 SQL 参数泄露业务内容。日志失败不改变数据库已知提交结果，也不覆盖已有迁移错误。

## 切换与验证边界

首次切换需退出完全没有格式检查的旧 Worker、Review、独立 launcher、Controller 和 resume 父进程，保留未知归属。新代码无法使旧二进制遵守格式 guard；不承诺与这些旧版本混跑或自动降级。

来源 fixture 独立于当前 opener。业务单测在独立的真实内存 SQLite 中验证建库、迁移、约束、状态转换和事务回滚。文件集成测试验证各库新建、空版本 0、任意版本 0 schema 与坏 JSON 重置、非零旧格式行/JSON/BLOB 保留，以及 DDL 和版本回滚；重置覆盖外键、trigger、view、虚拟表及其 shadow 表。独立进程验证并发与中断后重新读取。两类测试都进入常规 `pnpm test`，不通过缩小发现范围替代迁移。当前格式 WAL 快照、旧锁保留、lease 阻塞、提交/关闭双失败、IPC catch 与本地停止各有行为断言。SQLite 转换不替换原库文件、不删除 WAL/SHM、不创建跨库分布式事务或后台迁移任务。

内存单测与文件集成的取舍见[测试存储决策](../../.agents/notes/implemented/testing/2026-11-06-cli-memory-sqlite-tests.md)。版本 0 重置、独立版本、事务、所有权和 SQL 资源打包的决策依据及备选方案由[升级决策](../../.agents/notes/archived/architecture/2026-10-30-cli-sqlite-migrations.md)拥有。
