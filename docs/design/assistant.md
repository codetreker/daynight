# 助手定义、Session 绑定与准入

[需求规格](../spec/assistant.md)拥有当前支持的行为。管理定义由 `core.Bot`、PostgreSQL store、`service.Bots` 和 HTTP 投影负责；`sessionrelay` 在原有独立 Session 协议上负责绑定、grant 和同步结果准入，不借用项目或 Task 生命周期。

## 数据拥有者

追加迁移 `033_bots.sql` 创建 `bots`。主键为调用方生成的 UUID；`owner_user_id` 引用用户，`(owner_user_id,worker_id)` 引用现有 Worker 组合主键。数据库 identity 生成独立 `creation_order`，它用于按服务端创建顺序提交偏好，不依赖用户时钟或请求结束时间。

`requested_overrides` 保留显式输入，`resolved_configuration` 保存解析后的固定启动配置。两者不合并：默认值变化不能修改原请求身份。`request_fingerprint` 为规范化请求的 SHA-256，不包含可变的解析结果。名字和覆盖项先验证，再形成指纹；原始空白不产生额外定义。

创建时 `role_configuration`、`session_id` 为空，启动结果初始化为 pending。首次登记由 relay 事务同时冻结角色和 Session 关联。删除责任独立于启动配置，保存原删除 ID、请求版本及 Worker/服务端两方清理状态。

迁移 `037_bot_session_binding.sql` 为 `task_sessions` 增加可空、唯一的 `bot_id`，仅允许 `scope=test` 且 `backend=web` 的记录关联 Bot。复合外键 `(bot_id,owner_user_id)` 引用 Bot 及其 owner，数据库同时约束一 Bot 一 Session 和相同归属。`bots.session_id` 保存稳定引用，`testExecutionId` 从实际关联的 Session 投影，不另外分配执行身份。该引用不以反向外键要求保留已清理的 Session 行，以便最小 Bot 删除责任独立存在。

## 创建事务

`service.Bots.CreateResolved` 是公开创建使用的默认解析入口；`service.Bots.Create` 保留已解析配置的内部入口，两者共享创建事务。验证当前 principal 和输入后，通过 `Store.WriteBot` 在 ReadCommitted 事务中校验凭据、既有 ID 和 Worker 归属。凭据共享锁保护写入期间的撤销交错，并在等待后检查自然过期。

首次读取前取得按规范化 Bot ID 命名的事务 advisory lock，串行化同一 ID 的查回与默认解析；否则两个初次读取都为空时，后到的环境失败可能掩盖另一请求已经提交的结果。锁也覆盖已解析内部创建入口，与后续 Bot 行锁保持一致顺序。哈希碰撞只会增加等待，不改变归属或请求身份。插入仍使用 `ON CONFLICT(id) DO NOTHING`。冲突后用独立 SQL 语句读取并锁定原行，才能观察另一个事务刚提交的结果；不能用同一语句的快照兜底假定一定可见。相同 owner/指纹返回原行；不同请求冲突，删除中的行不恢复。数据库错误保留 `store.Error` 和事务结果信息，不将未知提交解释成回滚。

默认解析在事务确认 ID 尚不存在后执行；原请求重放直接返回冻结结果，不依赖当前 Worker 可用性。冻结配置的格式和组合归属在插入前再次校验。HTTP 创建只接受名字与显式覆盖，不开放已解析配置内核；内部已解析入口只检查格式和归属。

## 默认解析与偏好事务

`service/bot_defaults.go` 统一 defaults 预览与首次创建的解析规则。`Snapshot.BotDefaults` 在读取快照中提供服务端时间、Owner Worker 列表与偏好；`BotTx.BotDefaults` 在原创建事务中读取同样的数据。默认解析的时效判断时间在 Worker 与偏好读取后由数据库取得，避免 ReadCommitted 的新心跳晚于先前时间而被误判为未来；该时间只用于时效判断，不代表跨多次 SQL 的快照边界。列表按 `(created_at,worker_id)` 排序，不套用普通 Worker 列表的 72 小时隐藏或 Task 库存投影，因此过期的显式 Worker 仍能返回具体不可用原因。

解析先处理显式 Worker；没有显式 Worker 时尝试成功 Worker 偏好，再按稳定顺序选择可用配置。每个候选先经过 `WorkerAssistantHostState` 的托管版本、在线及观测时效检查，再为该机器选择目录与 Provider。每项使用显式值、该 Worker 偏好、报告默认的顺序。只读取目标 Provider 的 model/args。失败目标保留原因，不在同一 Worker 上另猜一个 Provider。目录按 Worker 平台验证；真实文件系统与启动预检由绑定 Worker 负责。

迁移 `036_bot_defaults.sql` 增加 `bot_worker_preferences` 和 `bot_configuration_preferences`。前者按用户保存最近成功显式 Worker；后者按用户与 Worker 保存目录和 Provider，各字段独立记录 creation_order。只选择 Provider 的新成功创建不能阻止另一请求的目录偏好首次提交；同时旧 Provider 选择也不能覆盖新成功 Provider。每个字段使用条件 upsert，不依赖 HTTP 完成时间或 Worker 时钟。

`store.CommitBotPreferences(ctx, pgx.Tx, botID)` 加入调用方已有事务，不自行开启或提交。它重新读取持久 Bot，要求未删除、已绑定 Session 且 startupResult 为 ready，只提交持久显式项对应的冻结值。生命周期调用方必须先按 Bot → Session 锁序验证凭据、绑定 Worker、当前 native fence 与同步事实，再同事务持久化 ready 并调用该方法。`sessionrelay.ReportBot` 在验证当前 live 同步后调用它；该内部方法的 ready 检查不替代 native 同步验证。数据库故障回滚整个事务，不留部分偏好。重放以原 creation_order 为条件，无额外写入效果。

默认查询无写入副作用；创建只写 pending Bot。report 将偏好提交留在同一生命周期事务中，无需独立的客户端确认请求，也不能在 spawn 回执或表单提交后提前调用成功方法。

## 登记与恢复事务

`sessionrelay.RegisterBot` 验证 PAT、Bot owner、绑定 Worker 和请求结构，按 Bot → Session 顺序取得锁。首次登记要求当前版本与请求相等、角色和 Session 尚未绑定、输入 configuration 与持久配置一致，并要求独立 registration 使用 `initialInput=none` 和相同 Provider。角色全文、revision、digest 随请求提交；服务端校验全文及摘要，但不拥有角色模板。

Session 行保存完整原 Bot 登记请求，包含原 botVersion、registration、configuration 和 roleConfiguration。响应丢失后的精确重放依据该记录核对，返回同一个 Session 和当前 Bot；不能以已经递增的 Bot version 拒绝原请求，也不能仅凭 registrationId 接受不同角色。删除校验先于重放。`store.BindBotSession` 加入原事务，以版本、未删除、空角色及空 Session 为条件执行 CAS；插入 Session、冻结角色和推进 Bot 版本任一失败均一起回滚。

Bot grant 在锁住 Bot 和 Session 后检查版本、Worker、独立执行身份、Controller 和 native ID，随后使用现有 grant 内核。普通 Test 入口遇到 Bot 关联直接拒绝。Bot 专用解码器允许独立身份携带 previousGeneration/stopProof；普通 Test 解码器继续禁止这些恢复参数，wire 不新增 claim 或 Worker 身份字段。

恢复新 generation 复用原 Session/native ID，验证 previousGeneration 恰好连续、原停证和新 Controller instance。已推进 generation 的重放还须匹配持久 stopProof，避免使用另一份停证刷新同一代授权。缺失 native ID 或 never_started 不构成恢复依据。相同 generation 的 grant 与续期不修改冻结角色或配置。

## 启动报告与偏好提交

`ReportBot` 先锁 Bot 并验证当前版本、Worker 与凭据。尚未绑定时仅允许没有 Session/Controller 身份的预检失败。绑定后读取原 Session，并比对完整 ControllerFence、controllerId、controllerInstanceId 和 nativeSessionId；failed 报告同样不能来自旧连接或旧代。

ready 依赖当前 relay 的 live 同步状态、当前连接及有效心跳，不能从 durable Snapshot 推导。durableSnapshot 不保存可被另一个实例误用的实时同步事实，因此没有本地同步证据的实例拒绝 ready。独立无首条输入的 Session 允许 native ID 尚未生成；报告中的 null 只在当前已同步快照同为 null 时成立，之后恢复仍需明确的原 native ID。

报告先校验版本、身份和适用的同步条件；结果与持久值相同则返回原 Bot。结果变化时，`store.SetBotStartup` 以当前版本及未删除状态更新结果并推进版本；ready 随后在同一事务调用 `CommitBotPreferences`。成功结果与偏好不可分别提交，数据库失败必须一起回滚。持久 ready 只记录已确认的启动结果；在线状态继续由 Session Snapshot 和新鲜观测拥有。

## Session 锁序与持久准入

带锁的 Bot 读取先单独取得行锁，再以新 SQL 语句投影完整定义及关联的 testExecutionId。这样，等待并发注册提交后，Bot 行与 Session 子查询都能看到已提交的关联；不能在同一 SELECT FOR UPDATE 内依赖子查询的旧语句快照。

`sessionrelay.load` 先无锁读取 Session 的不可变 Bot 归属，再锁定 Bot，最后锁定 Session 并重新核验双方引用与 owner。持久删除状态的校验发生在 attachLive 之前，缓存中的旧同步或授权不能覆盖删除事实。普通 Task 保持 task-before-session 顺序；无 Bot 的普通 Test 保持独立规则。

browser、controllerGrant、controller 和 archiveAccess 共用该加载路径，使 Snapshot、channel、command、timeline、operation、resource 请求及回传、Controller event/ack 和 archive 都遵守 Bot → Session → archive metadata 顺序。异步内容返回前原有二次 browser 准入仍执行，防止等待期间删除或身份变化后泄露内容。禁止先锁 Session 再在 scopePermission 中反向取得 Bot 锁。

Bot 生命周期验证 Worker PAT；共享 Session 继续验证 owner 的当前凭据与 Controller 父 PAT。普通 Test 注册命中 Bot 记录时拒绝，grant/stop 也拒绝 Bot 关联；Test 列表在 SQL 层排除 bot_id 非空记录。浏览器继续消费真实独立 Session 身份，不能通过普通 Test 生命周期接口改变 Bot 关联或 generation。

## 查询与授权

查询使用现有 snapshot 和分页游标，范围包含当前用户及可选 Worker ID。普通列表过滤所有删除意图；Worker 清单保留任一清理阶段尚未完成的行。排序为 `(created_at,id)`；`creation_order` 另用于比较创建先后，不用作当前分页游标。

`Get` 先确定资源是否存在，再验证 owner。Worker 清单检查组合身份，不以 Worker UUID 推导跨用户权限。服务层重新核对持久凭据；HTTP 外层继续使用现有 Authentication middleware，保留浏览器 Origin 检查和 PAT 生命周期。

HTTP DTO 将版本及创建序号编码为字符串，并投影实际关联的 sessionId/testExecutionId；尚未登记时两者为 null。删除后整体省略 `BotDefinition`，仅保留最小责任，避免单独漏删某个配置或角色字段。内部数据库对象不直接序列化为管理响应。

## 删除边界

删除事务先锁 Bot，核对 owner、原请求身份和当前版本，再存入删除责任。精确重复请求返回原结果；新的删除请求不能覆盖已有责任。达到 int64 上限时拒绝版本递增。

当前管理接口仅支持未绑定 Session 的删除意图，两个清理阶段均保持 pending。已绑定 Session 的公开删除仍被拒绝；已有持久删除准入检查提供共享入口所需的锁序与拒绝语义，但没有承担进程停证、SQL/归档删除或 Worker 私有资料清理。完整删除须按 Bot → Session → archive metadata 顺序记录责任、冻结新读写并清理实际关联资源，不能由列表隐藏推断完成。

Bot 表不保存 Task 关系，删除操作没有 Task 更新 SQL。普通目录、共享 native home、Task worktree 和其它任务均不属于定义删除的副作用。

## 扩展约束

公开创建消费默认解析机制，Worker 生命周期消费稳定的 Session 绑定、grant 和报告接口。未组合托管能力前不启用完整助手 UI 入口。Provider 实际启动与恢复、角色模板、Worker 退出和私有资料清理仍由各自执行组件负责；服务端接受注册或报告不证明这些组件已完成端到端验收。历史清理必须扩展删除事务并保留重复请求对账能力，公开创建返回 pending 不表示完整托管功能可用。

默认与偏好取舍见[默认解析决策](../../.agents/notes/implemented/architecture/2026-11-04-bot-default-resolution.md)。管理定义取舍见[管理定义决策](../../.agents/notes/implemented/architecture/2026-11-04-bot-definition-storage.md)。

Session 绑定、同步事实和准入取舍见[Session 准入决策](../../.agents/notes/implemented/architecture/2026-11-04-bot-session-admission.md)。
