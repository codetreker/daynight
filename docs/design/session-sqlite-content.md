# Session SQLite 当前正文

## 范围与所有者

Controller journal 的唯一编号序列为 `001`–`014`，当前格式为 v14。标准化 timeline 的唯一权威是原 `journal.sqlite` 的当前行；普通发布、分页、inspection、同步、归档和资源引用判断均消费同一个 SQL 正文所有者。旧正文文件仅作为编号迁移源及待退休材料存在。[Controller 协议](task-session-protocol.md#controller-与原生会话)继续拥有执行身份、启动、停止和投递语义，[SQLite 设计](cli-sqlite-migrations.md)拥有通用连接与迁移事务及编号数据转换。

| 模块 | 责任 |
|---|---|
| `content/timeline-store.ts` | 当前正文、序号、分页、完整同步遍历与当前统计 |
| `content/resource-files.ts` | 原路径下的资源 descriptor、blob、pin、lease 与文件预算 |
| `content/session-content.ts` | SQL 正文与资源组合；释放前核对正文与原生输入图片引用 |
| `content/migration.ts` | 按已提交来源执行必要文件映射与 canonical 010 的原子导入 |
| `content/maintenance.ts` | 旧读者屏障、正文退休、压缩与普通准入复核 |
| `storage-preparation.ts` | 原 permit 下的纯格式升级、stopped-maintenance 与 writer 角色准备 |
| `storage-metrics.ts` | 真实 SQLite 文件占用观测与压缩核对 |

`sqlite/journal/010-timeline-content.sql` 是正文表、统计表、cleanup 标记与旧索引删除的唯一完整 DDL。`loadSqliteSequence` 从同一 canonical 目录发现全部步骤；journal 格式拥有者据此生成完整 schema snapshots、验证版本并执行转换。构建按原 SQL 目录复制到相同的 dist 相对路径，没有暂存副本、隔离格式工厂或运行时版本选择开关。已发布 `009-message-origins.sql` 及其来源关系保持原样。

## 当前行与事务

`timeline_entries` 每个 entry 只保存当前行。`value` 为经过 `parseTimelineEntry(JSON.parse(JSON.stringify(input)))` 验证的完整 JSON；`content_hash` 使用 `controllerPayloadHash`，`byte_length` 是该 JSON 的 UTF-8 字节数。序号和 revision 以有符号 64 位正整数绑定 `BigInt`，对外 JSON 仍用规范十进制字符串。整数读取仅在相应 statement 使用精确整数，数据库全局返回模式不变。

`openTimelineStore` 不保留正文 Map。`get`、`has`、`nextSequence`、`page`、`hasBefore`、`hasAfter` 和 `totals` 直接查询 SQL。`page` 使用严格的序号游标：before 选择 `< pivot` 的倒序有界页后恢复升序，after 使用 `> pivot` 的升序页，tail 返回最后一页的升序结果。`nextSequence` 保留 `MAX(entry_seq)+1` 的分配语义，并拒绝溢出。

`save` 要求调用者的原写事务仍有效，同时执行构造时传入的写权限断言；store 不开始第二套事务。已有 entry 不得改变序号、回退 revision，或在相同 revision 下改变内容。正文写入与 `timeline_totals` 的增减属于同一事务。逻辑 timeline 大小精确为 `length('{"entries":[]}') + SUM(byte_length) + max(entry_count-1, 0)`；普通新增写入的上限为 128 MiB 和 100000 条，替换扣除旧长度，历史修订不累计计费。存量读取和历史导入不按这些上限拒绝数据。

保存入口接受显式 `TimelineContentPolicy`：`task_body` 仅保留 `user_message` 与 `assistant_message`，`bot_detail` 和兼容默认 `legacy` 保留全部合法类型。结果为 `{contentPolicy,status}`，其中 `status` 为 `saved`、`unchanged` 或 `excluded`。这些是当前事务内的结果；调用者的外层事务仍可能回滚。被排除条目仍须满足存量条目结构及身份校验，但不进行正文 JSON 序列化、hash 或新增正文容量准入，也不写正文、统计或编号。已有同 ID 保留行不能用被排除条目覆盖，否则拒绝写入，保留原证据。此入口不迁移或清除旧历史，不通过消息文本判断工具内容。

生命周期的 `saveTimelineHistory(entry, policy)` 在原 journal 写事务内调用该入口，要求调用者已分配稳定的 `entryId`、`entrySeq` 和 `revision`；它不追加 outbox、不推进 source 序号或 ACK，也不修改 `operations` 中的待确认操作。不能从筛选后的历史推导在线工具的身份或修订。现有 `projectTimeline` 经同一入口明确选择 `legacy`，因为在线重连、待审批读取、工具图片位置与资源闭包仍依赖完整 timeline。`testExecutionId` 同时用于 Bot 和普通 Test Session，不足以推断 Bot 策略。

此模块接口不声明生产方支持 `taskBodyHistoryVersion=1`。启用正文策略须同时完成独立在线状态、重连、审批、源水位、工具资源生命周期及版本化同步和归档适配；此前不能把旧全量来源标记为 `contentPolicy=task_body`。该激活边界与成本见[保存策略决策](../../.agents/notes/implemented/architecture/2026-11-18-timeline-history-policy.md)。

存量正文和资源读取复用协议的结构校验，但不套用新增输入的容量限制；普通发布仍执行完整新增写入准入。每次读取验证 JSON、id、kind、序号、revision、长度与 hash。重新打开时核对实际 COUNT/SUM 与统计；损坏暴露为错误，不重建或覆盖统计。`iterate(visitor)` 在调用者的同步读事务内耗尽 SQLite statement，不返回活跃 iterator，也不允许跨 await 保留快照。

普通发布在原 immediate 写事务中规范化输入、采用已提交的 user/daynight 来源、比较当前内容、分配或保留 entrySeq、递增 revision、保存正文和 totals，并追加原 outbox；相同内容保持 no-op。Markdown projection state、原生图片接收证据、原图槽/出现位置/关联及不可变 publication receipt 与正文同事务提交。迟到回执、`patchNativeImagePart` 和 Markdown rebase 都重新读取当前行；原 operation/native 身份、unknown quarantine 与不重放原生输入的规则保持。

页面、资源描述、pending interactions 与 inspection coverage 在同一短同步读事务中取得。coverage 通过 `iterate(visitor)` 检查全部历史的既有截断、投影错误和资源缺口，不建立正文 Map。完整条目使用现有 `canonicalHistoryJSON`、SHA-256、UTF-8 边界和 32 KiB 分块；每次请求重读当前行，revision/hash/长度改变返回 `content_changed`，不使用 SQL substr 切公开字节。

资源仍由原文件拥有者管理。`openSessionContent` 的组合层在同一同步读快照中检查当前正文和 `native_input_publication_images`，再允许资源拥有者检查 lease/pin 并释放。媒体导入后的清理也使用这一受保护的资源接口。`metadataBytes()` 查询当前 SQL totals 并加 descriptor 字节，只表示逻辑元数据，不代替实际 DB/WAL/SHM 物理计量。

## 旧格式导入

canonical 010 沿原迁移链处理 v1–9。旧 writer 准入继续由 `assertJournalMigrationAllowed` 和原存储 permit 负责。原 execution、Session、claim、generation、native 身份、未决 operation、outbox、图片关联、`input_message_origins` 和原停止证据均保留。upgrade-only 可保留 stopping、paused 或 `nativeStopped=false`；导入不制造 stopped。

v2–5 的 SQL projection 和资源按原键导出：projection 使用 rowid 作为 entrySeq，按目标字段序列生成正文及其 hash；资源 bytes 直接复制。必要文件先耐久发布，再删除旧 SQL 容器。v6–7 只按旧索引读取文件，v8 复制已索引 bytes 并从实际输出生成指针的 hash 和长度；未引用文件不参与转换。v1 保留历史不完整标记。

v10 在删除旧索引前捕获已提交指针，读取对应文件，仅从正文取得必填 kind，按指针携带 id、seq、revision 和 hash 写入目标 SQL。新 totals 来自实际写入的行和 UTF-8 bytes。无法构造目标的最小项跳过；不校验消息内容或关联，不修复外部 descriptor、manifest、pins 或原文件。必要文件缺失只影响相应项，实际 SQL、权限、设备、写入和提交错误继续传播。SQL 回滚后从保留的旧来源重试，输出使用既有耐久、可重入发布规则。

旧索引删除、实际目标行与 totals、`legacy_timeline_cleanup_pending=1`、后续编号步骤及最终 `user_version` 处于同一个 immediate 事务。导入后旧正文文件由独立的停止维护阶段退休；升级不保证原有坏值能被普通业务读者接受。

## 存储准备与停止维护

原 `ControllerStoragePermit` 贯穿本机格式转换和维护。编号步骤及历史文件导出、导入复用真实 SQL 和文件发布操作，不申请预算、估算峰值或按普通条数、字节与剩余空间规则拒绝存量数据。纯 `upgradeControllerJournal` 只返回实际版本和 cleanup 标记，不读取业务 snapshot，也不执行维护空间检查或普通准入；实际 SQL 和文件错误仍然传播。停止观察可先完成纯升级，再按原身份读取状态。

Controller 不设本地媒体或元数据累计额度，不查询卷剩余空间，也不估算未来写入或 VACUUM 峰值。准备、写入、冻结副本和维护由真实文件系统与 SQLite 操作决定结果；维护持原 permit 执行，重入保留实际已提交阶段。单条内容和协议限制仍生效。

停止维护要求原 ticket、generation、instance、持久 stopped/nativeStopped 证据及无活跃 writer。顺序为：

1. 读回当前 SQL 正文与 totals，在事务外执行有界 `wal_checkpoint(TRUNCATE)`。
2. 只有 checkpoint 明确成功后，由资源索引拥有者耐久发布 `index.json.entries=[]`，保留其完整 `resources` 清单，再退休已识别的旧正文并持久化相应目录。
3. 完成 VACUUM 前 TRUNCATE，执行事务外的原地 VACUUM，再完成后置有界 TRUNCATE。
4. 核对真实 DB/WAL/SHM、旧正文残留、当前正文与 totals，提交清除 pending，并读回实际提交状态。

退休仅覆盖私有 Session-bound 根下识别出的 UUID 候选、旧 timeline 与已确认迁移备份中的 timeline。旧导出中断留下的有效 `prepared` 备份及其 marker、无 marker 的空备份目录，以及文件发布中断留下的具名临时文件保留原样，不作为已完成备份退休。资源、blob、pin 和原生资料保留。未知文件、symlink 或身份冲突会暴露错误并保留现场；已退休文件的缺失可在重入时确认。共享 `index.json` 仍由 `resource-files.ts` 统一读写，Session 绑定、descriptor、blob、pin 和 lease 均不随正文索引退休而改变。索引发布失败时不删除正文；索引已发布而删除中断时，SQL 正文继续可读，重入仍重新耐久发布空旧正文清单，确认之前 rename 后的目录刷盘结果，再完成文件退休。

当前格式读者可能在屏障之后建立自己的 SQL 快照，并在构造资源拥有者时读到发布前的旧文件清单。若旧 timeline 引用的文件在检查时消失，仅允许在索引原始字节确实已改变时重读一次，并完整核对新清单仍引用的全部文件；未改变的索引、仍被引用的缺失文件或无效清单继续报错。资源清单不缓存旧正文引用；后续资源写入只发布空 `entries`，删除回滚读取当前已发布清单，不恢复构造时的旧引用。

`deadline` 在阶段前后检查，SQLite busy timeout 约束锁等待；同步原生 VACUUM 不能被 JavaScript timer 强制中断。VACUUM 返回后若期限已过，保留真实已提交阶段、pending 与后续维护材料，再由同一入口重入。

checkpoint busy 返回 `waiting/reader_busy`，保留 pending 与原文件。只有明确 checkpoint busy 可转成 waiting；I/O、身份、格式、未知提交和清理错误继续传播。VACUUM 成功、page_count 下降、空闲连接存在或关闭一个连接均不能证明主库已经缩小，后置 checkpoint 与真实文件核对不可省略。

VACUUM 在原连接同步执行；执行期间将 `SQLITE_TMPDIR`、`TMPDIR`、`TEMP`、`TMP` 临时指向同卷私有维护目录，返回或失败后在 finally 精确恢复每个变量原先的存在性与值。目录先核对身份、权限、可写性和同卷关系；实际临时文件写入错误继续传播。内置 Unix/Windows VFS 每次生成临时文件名时重新读取相应目录；本机 SQLite 调用都在同一 JavaScript 线程同步执行，现有 Markdown worker 不使用 SQLite。此边界不适用于未来并行 SQLite 线程，依据与备选机制由 [维护决策](../../.agents/notes/implemented/architecture/2026-11-12-session-sqlite-content-components.md)记录。维护失败不把已提交的导入或压缩报告为回滚；清 pending 提交结果未知时，持锁读取真实数据库与文件后再决定收尾。

## 同步、归档与连接关闭

活动同步在原短同步 SQL 事务内取得 epoch、source 截止点、有序完整条目和资源描述，物化同一同步文件并持久提交原 intent 后结束事务，再等待网络。重试保留 syncId 和冻结字节；同步文件是传输材料，不是第二份会话权威。

停止归档在精确原 stopped 身份下物化完整 timeline、descriptor 和引用。schema3 manifest/timeline、资源 hash、路径及 source-tail/旧 ready receipt 对账继续沿原格式。`assertFrozen()` 新开短只读连接，核对原身份、当前 SQL 正文和 source 截止点；后续本机写阶段重新取得 permit 和角色准入。

原资源拥有者在冻结 SQL 快照内逐项验证 available blob；冻结对象复制 descriptor，只保留物化条目与 `Pick<ResourceFiles, "acquireResource">` 文件读取能力。每次传输一个资源时才取得 lease，通过同一 FD 比较原冻结 descriptor、完整长度及 SHA-256，然后持有该 FD 完成本资源的 status、重试和块读取，在 finally 关闭。`acquireResource` 和 lease 的 `read`/`close` 不访问 SQL；这种后续文件取得不代表新的 SQL 快照，原 pin/生命周期及新连接的 `assertFrozen()` 仍保护冻结来源。

冻结对象不能保留完整可变资源组合。SQL 连接关闭后不得调用 `timeline.*`、`metadataBytes()`，也不得调用组合覆写的 `releaseResource`/`assertResourceReleasable`，这些操作均依赖当前 SQL 与引用保护。文件写入和 pin 变更不属于可跨网络等待的读取 facade。

## 可观察结果与验证

组件复用 SQLite migration reporter，通用编号迁移阶段为 `journal-migration`，原 SQLite 具体阶段保留在 `storage.sqlitePhase`；维护的实际阶段为 `legacy-timeline-retirement`、`journal-compaction`、`storage-admission`。目标版本来自 canonical 格式；停止结算在连接成功准入前保留真实来源版本，之后报告实际已准入版本。指标包含条目与字节数、真实文件占用、checkpoint busy/frames 和实际事务结果，不记录正文或凭据。诊断失败保留真实存储操作结果。

真实 SQLite 测试拥有当前行替换、BigInt、UTF-8、游标、统计回滚、历史来源与文件身份、资源引用及停止维护故障。held WAL reader 验证退休屏障，空闲打开连接验证 VACUUM 后置 checkpoint。100000 条、128 MiB 和大量历史修订探针独立于普通 CI；生成数据只能证明其明示的内容、顺序、outbox/ACK 和 reader 条件，不能替代未取得的原事故数据。
