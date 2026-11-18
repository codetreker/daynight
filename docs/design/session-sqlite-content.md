# Session SQLite 当前正文

## 范围与所有者

Controller journal 的唯一编号序列为 `001`–`015`，当前格式为 v15。标准化 timeline 的权威是原 `journal.sqlite` 的当前行。`execution.history_content_policy` 持久区分 `legacy` 与 `task_body`；正文策略把消息与在线详情分别保存，在线读取合并两者，同步及归档只消费正文。旧正文文件仅作为编号迁移源及待退休材料存在。[Controller 协议](task-session-protocol.md#controller-与原生会话)继续拥有执行身份、启动、停止和投递语义，[SQLite 设计](cli-sqlite-migrations.md)拥有通用连接与迁移事务及编号数据转换。

| 模块 | 责任 |
|---|---|
| `content/timeline-store.ts` | 正文与在线详情各自的当前行、分页、遍历、统计与容量准入 |
| `content/resource-files.ts` | 原路径下的资源 descriptor、blob、pin、lease 与文件预算 |
| `content/session-content.ts` | 持久策略、合并在线读取、资源引用保护与归档确认后的在线内容退休 |
| `content/migration.ts` | 按已提交来源执行必要文件映射与 canonical 010 的原子导入 |
| `content/maintenance.ts` | 旧读者屏障、正文退休、压缩与普通准入复核 |
| `storage-preparation.ts` | 原 permit 下的纯格式升级、stopped-maintenance 与 writer 角色准备 |
| `storage-metrics.ts` | 真实 SQLite 文件占用观测与压缩核对 |

`sqlite/journal/010-timeline-content.sql` 是正文表、统计表、cleanup 标记与旧索引删除的唯一完整 DDL。`loadSqliteSequence` 从同一 canonical 目录发现全部步骤；journal 格式拥有者据此生成完整 schema snapshots、验证版本并执行转换。构建按原 SQL 目录复制到相同的 dist 相对路径，没有暂存副本、隔离格式工厂或运行时版本选择开关。已发布 `009-message-origins.sql` 及其来源关系保持原样。

`015-online-content.sql` 新建 `online_entries`、`online_totals`，并给 execution 增加默认 `legacy` 的策略列。升级不搬移或过滤已有条目。runtime 仅在首次创建 claim 绑定的 Task execution 时选择 `task_body`；重新打开和恢复沿用已持久策略，不根据新配置重解释旧数据。普通 Test 与 Bot execution 保持兼容策略，不能从二者共用的 `testExecutionId` 推断 Bot 策略。

## 当前行与事务

`timeline_entries` 每个 entry 只保存当前行。`value` 为经过 `parseTimelineEntry(JSON.parse(JSON.stringify(input)))` 验证的完整 JSON；`content_hash` 使用 `controllerPayloadHash`，`byte_length` 是该 JSON 的 UTF-8 字节数。序号和 revision 以有符号 64 位正整数绑定 `BigInt`，对外 JSON 仍用规范十进制字符串。整数读取仅在相应 statement 使用精确整数，数据库全局返回模式不变。

`openTimelineStore` 不保留正文 Map。`get`、`has`、`nextSequence`、`page`、`hasBefore`、`hasAfter` 和 `totals` 直接查询 SQL。`page` 使用严格的序号游标：before 选择 `< pivot` 的倒序有界页后恢复升序，after 使用 `> pivot` 的升序页，tail 返回最后一页的升序结果。`nextSequence` 保留 `MAX(entry_seq)+1` 的分配语义，并拒绝溢出。

`save` 要求调用者的原写事务仍有效，同时执行构造时传入的写权限断言；store 不开始第二套事务。已有 entry 不得改变序号、回退 revision，或在相同 revision 下改变内容。正文写入与 `timeline_totals` 的增减属于同一事务。逻辑 timeline 大小精确为 `length('{"entries":[]}') + SUM(byte_length) + max(entry_count-1, 0)`；普通新增写入的上限为 128 MiB 和 100000 条，替换扣除旧长度，历史修订不累计计费。存量读取和历史导入不按这些上限拒绝数据。

保存入口接受显式 `TimelineContentPolicy`：`task_body` 仅保留 `user_message` 与 `assistant_message`，`bot_detail` 和兼容默认 `legacy` 保留全部合法类型。结果为 `{contentPolicy,status}`，其中 `status` 为 `saved`、`unchanged` 或 `excluded`。这些是当前事务内的结果；调用者的外层事务仍可能回滚。被排除条目仍须满足存量条目结构及身份校验，但不进行正文 JSON 序列化、hash 或新增正文容量准入，也不写正文、统计或编号。已有同 ID 保留行不能用被排除条目覆盖，否则拒绝写入，保留原证据。此入口不迁移或清除旧历史，不通过消息文本判断工具内容。

生命周期的 `saveTimelineHistory(entry, policy)` 在原 journal 写事务内调用该入口，要求调用者已分配稳定的 `entryId`、`entrySeq` 和 `revision`；它不追加 outbox、不推进 source 序号或 ACK，也不修改 `operations` 中的待确认操作。持久 `task_body` execution 拒绝改用另一保存策略。

普通 `projectTimeline` 从 `onlineTimeline` 读取旧条目并分配序号、修订。`task_body` 下该组合把用户与助手消息写入 `timeline_entries`，其余合法条目写入 `online_entries`；`legacy` 下仍使用原全量正文表。两表之间的 ID、entrySeq 必须唯一，既有条目不能改变 kind；全局下一序号取两表各自下一序号的较大值。重新打开时检查表内统计、内容校验和跨表所有权冲突，错误不会自动修复。

在线详情独立限制为 512 MiB 和 100000 个当前条目；正文仍为 128 MiB 和 100000 条。两者各自按完整 JSON 包络、当前行长度和逗号计费，替换只计当前版本。超额拒绝本次事务，不通过截断工具原文或驱逐待审批条目腾出容量。正文策略下 Markdown source store 使用独立的 512 MiB 限额，不能把这个限额解释成整个 journal 或媒体文件的物理空间上限。激活取舍见[Controller 正文历史决策](../../.agents/notes/implemented/architecture/2026-11-19-controller-task-body-history.md)。

存量正文和资源读取复用协议的结构校验，但不套用新增输入的容量限制；普通发布仍执行完整新增写入准入。每次读取验证 JSON、id、kind、序号、revision、长度与 hash。重新打开时核对实际 COUNT/SUM 与统计；损坏暴露为错误，不重建或覆盖统计。`iterate(visitor)` 在调用者的同步读事务内耗尽 SQLite statement，不返回活跃 iterator，也不允许跨 await 保留快照。

普通发布在原 immediate 写事务中规范化输入、采用已提交的 user/daynight 来源、比较当前内容、分配或保留 entrySeq、递增 revision、保存正文和 totals，并追加原 outbox；相同内容保持 no-op。Markdown projection state、原生图片接收证据、原图槽/出现位置/关联及不可变 publication receipt 与正文同事务提交。迟到回执、`patchNativeImagePart` 和 Markdown rebase 都重新读取当前行；原 operation/native 身份、unknown quarantine 与不重放原生输入的规则保持。

页面、资源描述、pending interactions 与 inspection coverage 在同一短同步读事务中取得。在线页面、条目块、重连快照和待审批读取使用合并的 `onlineTimeline`；两表按全局 entrySeq 排序，分页保持原 before/after/tail 语义。coverage 通过 `iterate(visitor)` 检查全部在线内容的既有截断、投影错误和资源缺口，不建立正文 Map。完整条目使用现有 `canonicalHistoryJSON`、SHA-256、UTF-8 边界和 32 KiB 分块；每次请求重读当前行，revision/hash/长度改变返回 `content_changed`，不使用 SQL substr 切公开字节。

资源仍由原文件拥有者管理。`openSessionContent` 的组合层在同一同步读快照中检查合并在线内容和 `native_input_publication_images`，并要求资源拥有者的 lease/pin 检查通过才允许释放。媒体导入后的清理也使用这一受保护的资源接口。`metadataBytes()` 查询两表合并的当前 SQL totals 并加 descriptor 字节，只表示逻辑元数据，不代替实际 DB/WAL/SHM 物理计量。

资源删除的恢复备份由同一 `index.json` 的可选 `cleanup` 清单持久登记，路径仅允许资源 descriptor 或 blob 的具名 `.delete` 备份。资源拥有者将不再需要恢复的确切备份路径与当前资源清单一起发布；重开后按清单重试，不扫描目录猜测文件归属。`retryCleanup()` 核对写权限、目录与 Session 身份，只删除登记的普通文件，允许已删除项缺失，拒绝 symlink 或其他文件类型；资源和 blob 目录刷盘成功后才发布移除 `cleanup` 的索引。删除、刷盘或索引发布失败明确报错，重入按实际索引继续处理尚存登记，已删除项可幂等确认；最后索引发布若在 rename 后刷盘失败，不能断言清单仍在。若原资源恢复失败，仍用于恢复的备份与原错误链保留，不能当作普通待清理文件。普通 `releaseResource` 逻辑提交后尝试清理备份，清理失败发出警告，不把已提交的资源释放报告为回滚。

资源释放在删除原文件并刷盘相关目录后，以发布新资源索引作为最后的逻辑提交动作。发布抛错时先读回实际索引：完整匹配新清单则保留已删除状态与清理责任，不恢复原文件；确认仍为旧清单才尝试回滚；无法确认或出现其他清单时保留备份并报告需要恢复。可见新索引只证明逻辑发布，不能代替严格清理最终索引发布与根目录刷盘的成功证据。

`retryCleanup()` 读取并验证实际索引后，必须先成功刷盘 Session 内容根目录，才能删除任何已登记备份。仅观察到新索引可见不授权销毁恢复备份；根目录刷盘失败保留备份并报告错误。即使实际索引没有待清理项，也必须执行这次根目录刷盘，确保此前清除 `cleanup` 的索引 rename 已持久化。严格退休不能以空清单绕过这一成功条件；有待清理项时，删除后的目录刷盘与最终索引耐久发布仍不可省略。

严格清理还检查 `resources` 与 `blobs` 目录中的残留 `.delete` 项，即使索引没有 `cleanup` 清单也不能跳过。回滚后备份登记若在 rename 前失败，未登记备份仍会在重开后阻止退休完成。检测残留仅用于报告需要恢复，不赋予未知文件删除权限；不得从文件名推断归属、补登记或自动删除。普通资源释放与预算准入对这一清理错误仍只警告，保留各自已提交状态和原有准入检查。

## 旧格式导入

canonical 010 沿原迁移链处理 v1–9。旧 writer 准入继续由 `assertJournalMigrationAllowed` 和原存储 permit 负责。原 execution、Session、claim、generation、native 身份、未决 operation、outbox、图片关联、`input_message_origins` 和原停止证据均保留。upgrade-only 可保留 stopping、paused 或 `nativeStopped=false`；导入不制造 stopped。

v2–5 的 SQL projection 和资源按原键导出：projection 使用 rowid 作为 entrySeq，按目标字段序列生成正文及其 hash；资源 bytes 直接复制。必要文件先耐久发布，再删除旧 SQL 容器。v6–7 只按旧索引读取文件，v8 复制已索引 bytes 并从实际输出生成指针的 hash 和长度；未引用文件不参与转换。v1 保留历史不完整标记。

v10 在删除旧索引前捕获已提交指针，读取对应文件，仅从正文取得必填 kind，按指针携带 id、seq、revision 和 hash 写入目标 SQL。新 totals 来自实际写入的行和 UTF-8 bytes。无法构造目标的最小项跳过；不校验消息内容或关联，不修复外部 descriptor、manifest、pins 或原文件。必要文件缺失只影响相应项，实际 SQL、权限、设备、写入和提交错误继续传播。SQL 回滚后从保留的旧来源重试，输出使用既有耐久、可重入发布规则。

旧索引删除、实际目标行与 totals、`legacy_timeline_cleanup_pending=1`、后续编号步骤及最终 `user_version` 处于同一个 immediate 事务。导入后旧正文文件由独立的停止维护阶段退休；升级不保证原有坏值能被普通业务读者接受。

## 存储准备与停止维护

原 `ControllerStoragePermit` 贯穿本机格式转换和维护。编号步骤及历史文件导出、导入复用真实 SQL 和文件发布操作，不申请预算、估算峰值或按普通条数、字节与剩余空间规则拒绝存量数据。纯 `upgradeControllerJournal` 只返回实际版本和 cleanup 标记，不读取业务 snapshot，也不执行维护空间检查或普通准入；实际 SQL 和文件错误仍然传播。停止观察可先完成纯升级，再按原身份读取状态。

Controller 不设覆盖全部本地媒体或元数据的累计额度，不查询卷剩余空间，也不估算未来写入或 VACUUM 峰值。正文、在线详情与 Markdown source 的各自逻辑限额仍在普通写入时生效。准备、冻结副本和维护由真实文件系统与 SQLite 操作决定结果；维护持原 permit 执行，重入保留实际已提交阶段。单条内容和协议限制仍生效。

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

正文策略的 relay 在 WebSocket 握手请求中发送 `Daynight-Task-Body-History-Version: 1`，并核对 upgrade 响应同值；不支持时在发送 hello 前关闭连接并报告 `upgrade_required`，不回退到全量历史。活动同步和停止归档的 HTTP 请求也声明并逐次检查此能力。兼容 execution 不发送正文策略声明。

活动同步只在原 source 序列已全部 ACK、无 projection gap 且 history epoch 已知时准备。它在原短同步 SQL 事务内取得 epoch、完整 source 截止点、有序正文条目和正文引用资源，物化同步文件并持久提交原 intent 后结束事务，再等待网络。正文策略额外携带 `contentPolicy=task_body` 与最多 4096 个累积的 `onlineImageOccurrences`，供在线工具图片捕获校验，不携带工具文本；工具修订移除图片也保留原位置至最终结算。重试保留 syncId 和冻结字节；同步文件是传输材料，不是第二份会话权威。source 水位覆盖所有事件，不能用筛选后的正文序号替代。

停止归档在精确原 stopped 身份下物化正文 timeline、descriptor 和引用；兼容 execution 保留全量内容。正文最终 history 的在线位置集合为空，schema3 manifest 显式携带 `contentPolicy=task_body`，物理文件布局不变。资源 hash、路径及 source-tail/旧 ready receipt 对账继续沿原规则。`assertFrozen()` 新开短只读连接，核对原身份、当前 SQL 正文和 source 截止点；后续本机写阶段重新取得 permit 和角色准入。wire 字段与旧读者兼容由[历史读取设计](task-session-history.md#归档与权限生命周期)拥有。

原资源拥有者在冻结 SQL 快照内逐项验证 available blob；冻结对象复制 descriptor，只保留物化条目与 `Pick<ResourceFiles, "acquireResource">` 文件读取能力。每次传输一个资源时才取得 lease，通过同一 FD 比较原冻结 descriptor、完整长度及 SHA-256，然后持有该 FD 完成本资源的 status、重试和块读取，在 finally 关闭。`acquireResource` 和 lease 的 `read`/`close` 不访问 SQL；这种后续文件取得不代表新的 SQL 快照，原 pin/生命周期及新连接的 `assertFrozen()` 仍保护冻结来源。

冻结对象不能保留完整可变资源组合。SQL 连接关闭后不得调用 `timeline.*`、`metadataBytes()`，也不得调用组合覆写的 `releaseResource`/`assertResourceReleasable`，这些操作均依赖当前 SQL 与引用保护。文件写入和 pin 变更不属于可跨网络等待的读取 facade。

## 归档确认后的在线内容退休

只有正文策略执行本地在线退休。上传方先验证服务端 `ready`、schema3、manifest SHA-256、字节数和 completeness，重新核对冻结来源，再耐久保存原 generation 的 archive receipt。已有 receipt 的重入先读取服务端现状并核对同一表示，不能仅凭本地文件存在删除在线内容。

退休持原 stopped storage permit 并重新核对 execution 身份；要求 `nativeStopped=true`、`lifecycle=stopped`、`owner_pid=null` 和 `last_sequence=last_acknowledged`。清理函数还核对 Session、generation 及本地 receipt 的 ready/schema3/摘要/长度字段。正文图片与 `native_input_publication_images` 引用形成保留集合，其余资源必须先通过文件 lease/pin 准入。

在线条目、online totals、非正文图片位置以及所属 Markdown projection/source/context 在同一个 immediate 事务中清理，临时启用 `secure_delete` 并在 finally 恢复原值。随后通过受保护资源接口逐项删除独占资源；共享正文和原生输入图片保持可读。严格调用资源拥有者的 `retryCleanup()` 完成持久清单中的备份删除后，有 freelist 时执行 VACUUM，再执行 `wal_checkpoint(TRUNCATE)`；备份清理失败或 checkpoint busy 均明确报错，不能声称物理退休完成。

SQL 与资源文件删除不是一个原子事务。资源删除、备份清理或压缩失败保留已提交阶段、journal 和剩余文件；重入从剩余资源重新枚举，并继续消费持久备份清单，不因在线行已清空或资源已逻辑释放而跳过失败清理。确认的 archive receipt 不因本地清理失败而变为未提交；清理成功也不提供服务端七天期限或本机原生恢复材料淘汰能力。

## 可观察结果与验证

组件复用 SQLite migration reporter，通用编号迁移阶段为 `journal-migration`，原 SQLite 具体阶段保留在 `storage.sqlitePhase`；维护的实际阶段为 `legacy-timeline-retirement`、`journal-compaction`、`storage-admission`。目标版本来自 canonical 格式；停止结算在连接成功准入前保留真实来源版本，之后报告实际已准入版本。指标包含条目与字节数、真实文件占用、checkpoint busy/frames 和实际事务结果，不记录正文或凭据。诊断失败保留真实存储操作结果。

真实 SQLite 测试拥有当前行替换、BigInt、UTF-8、游标、统计回滚、历史来源与文件身份、资源引用及停止维护故障。held WAL reader 验证退休屏障，空闲打开连接验证 VACUUM 后置 checkpoint。100000 条、128 MiB 和大量历史修订探针独立于普通 CI；生成数据只能证明其明示的内容、顺序、outbox/ACK 和 reader 条件，不能替代未取得的原事故数据。
