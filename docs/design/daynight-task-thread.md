# 任务持久讨论 Thread 设计

## 所有者与调用方向

[需求](../spec/daynight-task-thread.md)拥有服务端行为及消费者义务，[CLI设计](task-thread-cli.md)拥有终端解析、展示、预算与确认生命周期，[Web设计](task-thread-web.md)拥有Discussion面板、临时内存与连续读取。`api/task_threads.go`定义公开DTO；`internal/core/model/task_thread.go`定义消息、不可变作者、内部位置和页面；`internal/core/store/postgres/task/`拥有PostgreSQL消息读写，`internal/core/store/postgres/internal/project_access.go`拥有共同项目准入及强准入；`internal/core/task/thread` 拥有消息准入、来源及容量规则；`internal/service/task/task_thread.go` 编排授权和事务完成，`internal/server/task/task_threads.go` 注册路由、严格解码和输出。

`internal/core/task/codec` 拥有纯响应类型与编码，将 model 映射到响应并生成实际字节；API 通过类型别名复用这些类型。service 的消息/页文档同时携带 core 值和已验证 JSON；server 直接写入该缓冲，不再经过 Encoder 或追加 LF。createdAt 通过显式 UTC `2006-01-02T15:04:05.000Z` 格式化。store 不依赖 HTTP 或 API DTO。

`server.New` 复用现有 Store 构造 `NewTaskThreads`，不新建 pool 或后台服务。Task 资源解析与既有任务 handler 共用 canonical project/task 和 logger 字段。Thread 不挂进 Tasks.versionedWrite，不调用 Session 冻结或 worker 控制。

## 存储与消息身份

迁移 `029_task_threads.sql` 创建 `task_threads` 与 `task_thread_messages`。head 以 task_id 为主键，last_created_at/last_message_id 同时为空或非空。消息以 `(task_id,message_id)` 为复合主键，message_id 使用数据库默认 gen_random_uuid()，普通索引 `(task_id,created_at,message_id)` 支持分页。两表无 foreign key，不增加消息单列唯一键、提交序号或提交账本。

created_at 与 head 时间为 timestamptz(3)，INSERT 使用 `date_trunc('milliseconds',clock_timestamp())`。作者 userId、可空名称、Agent 及有限的 claim/worker/provider 在发言时快照保存。CHECK 约束要求普通作者无执行来源，Agent 作者具有完整来源且 provider 为 codex/claude/copilot。后续读取不依赖当前用户名称或 worker 状态，因此历史和已接纳的编码大小稳定。

## 专用写事务

`WriteThread(ctx, func(ThreadScope) error) (Completion, error)` 使用 ReadCommitted；作用域的 DAO 仅在回调期间有效，并为当前任务串行化：

1. 无锁预读目标的 Parent，按 UUID 顺序对目标和存在的 Parent 分别取得 `FOR SHARE`，以新语句复读并核对 Parent，保留 missing/有效删除信息。Parent 变化返回 `resource_conflict`，不补锁或重放。
2. 锁当前 credential `FOR SHARE`，再通过 `ThreadScope.ProjectDAO().LockProjectAuthorization` 调用 canonical `store.LockProjectAuthorization`，依次锁真实 ownership、当前 owner Team member 和 direct grant `FOR SHARE`。验证认证身份与访问权后才分类任务存在性。
3. 查询作者名称；仅提供 claimId 时读取当前 worker，复用 core/task 的 ActiveWorker 校验，另验 worker.UserID 与 principal 一致。
4. 先独立执行 lazy head INSERT ON CONFLICT DO NOTHING，再独立 SELECT FOR UPDATE。不能合成 CTE，否则 ReadCommitted 并发首写可看不到冲突赢家。
5. 校验同任务 reply，INSERT 省略 message_id，以 RETURNING 获取一次生成的 UUID 和实际数据库毫秒时间。
6. 准备前进位置，分别编码默认/详细资源并校验 64 KiB，最后用数据库实际时钟检查 credential expiry，再更新 head。
7. 只有 commit 确认后向调用方暴露资源。

锁顺序为按 UUID 排序的目标及 Parent share → credential share → ownership share → owner Team member share → direct grant share → head update，不取得 Project 行锁。普通删除已持 Project 锁并等待 Task 时，反向 Project 锁会导致死锁。ownership 是真实归属数据行，缺失时报告完整性错误；只锁实际存在的 Team member 与 grant，不制造来源或 gap lock。强准入从每个来源实际锁定后的当前值合并，至少一条实际锁定来源仍须提供访问；真实 DirectGrant 保留自己的角色与版本，只有继承访问时为 null。查询不读取人员资料，不采用等待前别名中的角色，也不追加非锁定查询让并发新来源成为唯一准入依据。ownership share 阻止并发归属变化越过这次读取，来源 share 阻止撤销跨过提交。普通 Task 与 Session 准入不借用这些长期 share 锁。Task 变更需 Task 排他锁，来源撤销与 credential 删除/修改需各自排他锁；共享锁持有至事务结束。锁不能阻止自然过期，所以等待和编码之后仍须重验 expiry。

没有 claimId 的普通发言不解析无关 worker 属性。Thread 不写 Task、task_properties、依赖、epoch 或 task-sync 的任何字段。

## 实际时钟与有界等待

持有 head 锁后得到候选 `(createdAt,id)`；严格大于 head 则直接接纳。否则保留 UUID，在最多 100ms 的子 context 中重复采样真实数据库时钟并短暂等待，取得可靠前进位置后，仅更新相同 task_id/message_id 的未提交行。时间不从 head+1ms 合成，UUID 不通过重插挑选。

子预算按 Go 单调时间计量，SQL sampler 和 timer 都使用该 context。预算本身到期而父操作仍有效时返回 ThreadClockError，保留 head、最后安全采样与原因；不能据此断言一定发生时钟回拨。更早父取消及其他 SQL 失败保留自身类别。

Post/List 从入口建立 10 秒 context，覆盖 pool、锁、查询和 commit，服从更短父 deadline。每次逐行处理和编码前后检查取消。清理通过 WithoutCancel 保留关联值，独立 5 秒 rollback 后释放或丢弃连接。handler 保留原 request context 输出服务超时错误。

## 阶段与错误优先级

ThreadTransactionError 仅保存在调用栈，记录 callback/rollback/commit、commit 是否已尝试、结果是否未知及 rollback 是否失败。callback 的每次拒绝都返回 error，不能捕获 Fault 后返回 nil，否则会提交已拒绝的候选及 lazy head。

callback 失败且 rollback 确认时保留原错误；rollback 失败合并原因链并强制 internal_error。pgx.ErrTxCommitRollback 是确认回滚；其他 COMMIT 传输/上下文失败保守分类为 message_outcome_unknown。defer Rollback 的 ErrTxClosed 不能证明失败 commit 已回滚。

ThreadResponseFault 先识别这些局部结果，再交给普通 HTTP 错误映射；不改变全局 ErrorKind 的取消、数据库和网络优先级。时钟预算与未知提交可向客户端返回 503，同时保留原安全 cause。响应写失败只记录 response 阶段，不追加第二份错误 JSON、不重新调用 Post。

## 同快照条数分页

List 使用现有只读 Repeatable Read，在同一快照重验 credential、RequireProjectRead 和 TaskPresence。Thread 的缺失项目成员明确映射 forbidden，不改变普通 Task 的存在性隐藏策略。带边界时通过 `(task_id,message_id)` 查出创建时间；候选查询使用内部 `(created_at,message_id)` 比较。

最新/before 页按降序选最近项，after/fromBeginning 按升序。候选最多 count+1 条，按条数选择后关闭 rows，再查询两侧 EXISTS；不存在同一连接的并行活跃 rows。降序页最后反转展示，首尾两侧标记来自真实返回边界，空页两个标记均 false。消息与页面使用纯字段投影及普通 JSON 编码，不重复结构、消息容量或响应字节准入；自然编码、取消与查询错误保留原链路。

同毫秒 UUID 排序和严格提交前进保证后续新增不会落到已发布增量边界之前。客户端仅用消息 Id 查询，服务器回查时间，不增加 token 或另一种消息身份。连续读取位置属于消费者独立状态，POST 回执不能跳过其他人的未读消息。

## 验证与可观测性

分层测试按 [测试编写规则](../writing_tests.md) 隔离被测职责之外的依赖。store 使用隔离真实 PostgreSQL，检验迁移与索引、复合身份、快照和锁、数据库 UUID 的一次生成、时钟/清理与 commit 应答丢失。service 通过可控 DAO、scope 和 transaction 结果验证准入、来源、名称快照、期限、条数分页、写入容量和 Task 不变量。server 使用直接 Thread service mock、真实路由与 credential middleware，检验严格 HTTP、身份/Origin、错误优先级，以及 service Document 字节的发送、短写和取消。Document 的自然编码与消息写入准入由 service/协议所有者验证。正常发帖、回复和读回由显式 API 集成入口验证完整组装链路。

时钟循环以私有逐调用 sampler/wait seam 确定性复现回拨、恢复及预算；生产 SQL 另以锁后采样集成证明。commit 测试在真实底层提交后注入返回错误，新连接确认持久记录，服务仍分类未知；它不模拟所有网络故障。锁观察按本测试 schema/连接定位，过期证明直接观察数据库消息与 head，而非只看过期主体读失败。

HTTP 日志使用既有 requestId，追加 project_id、task_id、message_id 和经过验证的有限执行来源。component=task_thread；失败保留 phase、安全 cause/code，未知提交记录 thread_error_code=message_outcome_unknown 与 write_outcome=unknown。正文、名称、token、DSN、SQL 和原始上游错误不进入日志。

[决策记录](../../.agents/notes/archived/architecture/2026-11-03-task-thread-storage.md)保存真实替代方案与范围成本；[普通读取决策](../../.agents/notes/implemented/simplification/2026-11-09-canonical-resource-pages.md)拥有消息读取容量与页面准入的撤销。命令和完整 gate 由[服务端指南](../../packages/daynight-server/README.md#validate)拥有。
