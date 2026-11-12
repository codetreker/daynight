# Session SQL 正文组件

## 范围与所有者

Controller 的生产 journal 编号序列当前止于 `009-message-origins.sql`，普通运行仍通过已提交的 `content_index` 指针读取候选文件。本文描述可独立调用的 SQL 正文、转换和停止维护组件；这些组件不改变生产格式选择、writer 或读取入口。[Controller 协议](task-session-protocol.md#controller-与原生会话)继续拥有执行身份、启动、停止和投递语义，[SQLite 设计](cli-sqlite-migrations.md)拥有通用连接与迁移事务。

| 模块 | 责任 |
|---|---|
| `content/timeline-store.ts` | 当前正文、序号、分页、完整同步遍历与当前统计 |
| `content/resource-files.ts` | 原路径下的资源 descriptor、blob、pin、lease 与文件预算 |
| `content/session-content.ts` | SQL 正文与资源组合；释放前核对正文与原生输入图片引用 |
| `content/migration.ts` | 唯一编号序列与暂存 DDL 的隔离格式组合、历史来源验证和导入 |
| `content/maintenance.ts` | 停止准入、旧读者屏障、正文退休、压缩与实际预留结算 |
| `storage-capacity.ts`、`media/metadata-budget.ts` | 真实占用、共享账本绝对预留、普通准入与迁移峰值 |

`content/timeline-schema.sql` 是正文表、统计表、cleanup 标记与旧索引删除的唯一完整 DDL 资源，构建显式复制到相同的 dist 相对路径。隔离格式复用 journal 格式拥有者、原 `001`–`009` SQL 和完整 schema snapshots。暂存资源不在编号目录中，不存在普通运行的版本选择开关。

## 当前行与事务

`timeline_entries` 每个 entry 只保存当前行。`value` 为经过 `parseTimelineEntry(JSON.parse(JSON.stringify(input)))` 验证的完整 JSON；`content_hash` 使用 `controllerPayloadHash`，`byte_length` 是该 JSON 的 UTF-8 字节数。序号和 revision 以有符号 64 位正整数绑定 `BigInt`，对外 JSON 仍用规范十进制字符串。整数读取仅在相应 statement 使用精确整数，数据库全局返回模式不变。

`openTimelineStore` 不保留正文 Map。`get`、`has`、`nextSequence`、`page`、`hasBefore`、`hasAfter` 和 `totals` 直接查询 SQL。`page` 使用严格的序号游标：before 选择 `< pivot` 的倒序有界页后恢复升序，after 使用 `> pivot` 的升序页，tail 返回最后一页的升序结果。`nextSequence` 保留 `MAX(entry_seq)+1` 的分配语义，并拒绝溢出。

`save` 要求调用者的原写事务仍有效，同时执行构造时传入的写权限断言；store 不开始第二套事务。已有 entry 不得改变序号、回退 revision，或在相同 revision 下改变内容。正文写入与 `timeline_totals` 的增减属于同一事务。逻辑 timeline 大小精确为 `length('{"entries":[]}') + SUM(byte_length) + max(entry_count-1, 0)`，上限为 64 MiB 和 100000 条；替换扣除旧长度，历史修订不累计计费。

每次读取验证 JSON、id、kind、序号、revision、长度与 hash。重新打开时核对实际 COUNT/SUM 与统计；损坏暴露为错误，不重建或覆盖统计。`iterate(visitor)` 在调用者的同步读事务内耗尽 SQLite statement，不返回活跃 iterator，也不允许跨 await 保留快照。

资源仍由原文件拥有者管理。SQL 组合层在同一同步读快照中检查当前正文和 `native_input_publication_images`，再允许资源拥有者检查 lease/pin 并释放。媒体导入后的清理也使用这一受保护的资源接口。

## 旧格式导入

隔离 v10 格式沿原迁移链处理 v1–9。旧 writer 准入继续由 `assertJournalMigrationAllowed` 和原存储 permit 负责。原 execution、Session、claim、generation、native 身份、未决 operation、outbox、图片关联、`input_message_origins` 和原停止证据均保留。upgrade-only 可保留 stopping、paused 或 `nativeStopped=false`；导入不制造 stopped。

v2–5 的 SQL 正文和资源先按原合同耐久导出；v6–7 仍核对文件与索引完全一致；v1 保留历史不完整标记。v8–9 只读取已提交 `content_index` 指针，不从目录选择更新候选。打开源前后检查私有普通文件身份，并核对长度、SHA-256、entry id、seq、revision 和内容 hash。没有原 execution 的非空 pending 源拒绝导入。

先在原事务中完整核对并捕获有界的已提交指针元数据，不缓存正文；再执行包含旧索引删除的完整 DDL，按捕获指针重新核对原文件并逐项保存。DDL、总量核对、设置 `legacy_timeline_cleanup_pending=1` 与 `user_version=10` 处于同一个 immediate 事务。任何导入或提交失败均保留真实事务结果与原文件；SQL 回滚不会提前删除唯一文件源。导入后可以读取 SQL 正文，旧正文文件由独立的停止维护阶段退休。

## 峰值预留与停止维护

原 `ControllerStoragePermit` 贯穿本机导入和维护。局部 context 绑定实际迁移连接与已预留峰值，步骤 6/8 使用同一许可导出，不因历史候选垃圾超过普通 128 MiB 水位而提前拒绝转换。逻辑正文、资源、2200 MiB/execution、8 GiB/stateDirectory 和 512 MiB 卷空闲限制继续有效。账本 `reserve(bytes)` 替换原 execution 的绝对预留；重入按实际残留和剩余工作重算，不累计退款。

停止维护要求原 ticket、generation、instance、持久 stopped/nativeStopped 证据及无活跃 writer。顺序为：

1. 读回当前 SQL 正文与 totals，在事务外执行有界 `wal_checkpoint(TRUNCATE)`。
2. 只有 checkpoint 明确成功后，退休已识别的旧正文并持久化相应目录。
3. 完成 VACUUM 前 TRUNCATE，执行事务外的原地 VACUUM，再完成后置有界 TRUNCATE。
4. 核对真实 DB/WAL/SHM、旧正文残留、当前正文与 totals，提交清除 pending，并读回实际提交状态。
5. 按真实占用结算维护预留，恢复普通物理准入，全部成功才返回 pending=false。

退休仅覆盖私有 Session-bound 根下识别出的 UUID 候选、旧 timeline 与已确认迁移备份中的 timeline。资源、blob、pin 和原生资料保留。未知文件、symlink 或身份冲突会暴露错误并保留现场；已退休文件的缺失可在重入时确认。

`deadline` 在阶段前后检查，SQLite busy timeout 约束锁等待；同步原生 VACUUM 不能被 JavaScript timer 强制中断。VACUUM 返回后若期限已过，保留真实已提交阶段、pending 与后续维护所需预留，再由同一入口重入。

checkpoint busy 返回 `waiting/reader_busy`，保留 pending、原文件与必要预留。只有明确 checkpoint busy 或容量拥有者的类型化拒绝可转成 waiting；I/O、身份、格式、未知提交和清理错误继续传播。VACUUM 成功、page_count 下降、空闲连接存在或关闭一个连接均不能证明主库已经缩小，后置 checkpoint 与真实文件核对不可省略。

预留包含实际保留源、中间导出、SQL 导入以及 VACUUM 最多原 DB 两倍额外空间。VACUUM 在原连接同步执行；执行期间将 `SQLITE_TMPDIR`、`TMPDIR`、`TEMP`、`TMP` 临时指向同卷私有维护目录，返回或失败后在 finally 精确恢复每个变量原先的存在性与值。目录先核对身份、权限、可写性和同卷关系，临时文件按峰值与卷空闲条件计费。内置 Unix/Windows VFS 每次生成临时文件名时重新读取相应目录；本机 SQLite 调用都在同一 JavaScript 线程同步执行，现有 Markdown worker 不使用 SQLite。此边界不适用于未来并行 SQLite 线程，依据与备选机制由 [维护决策](../../.agents/notes/implemented/architecture/2026-11-12-session-sqlite-content-components.md)记录。维护失败不把已提交的导入或压缩报告为回滚；清 pending 提交结果未知时，持锁读取真实数据库与文件后再决定收尾。普通停止结算保留 128 MiB 加 8 MiB settlement；下一 writer 仍须满足普通准入。

## 可观察结果与验证

组件复用 SQLite migration reporter，阶段为 `timeline-import`、`legacy-timeline-retirement`、`journal-compaction`、`storage-admission`。指标包含条目与字节数、真实文件占用、checkpoint busy/frames、回收字节和实际事务结果，不记录正文或凭据。诊断失败保留真实存储操作结果。

真实 SQLite 测试拥有当前行替换、BigInt、UTF-8、游标、统计回滚、历史来源与文件身份、资源引用及停止维护故障。held WAL reader 验证退休屏障，空闲打开连接验证 VACUUM 后置 checkpoint。100000 条、64 MiB 和大量历史修订探针独立于普通 CI；生成数据只能证明其明示的内容、顺序、outbox/ACK 和 reader 条件，不能替代未取得的原事故数据。
