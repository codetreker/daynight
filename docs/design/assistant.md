# 助手定义、Session 绑定与准入

[需求规格](../spec/assistant.md)拥有当前支持的行为。管理定义由 `core.Bot`、PostgreSQL store、`service.Bots` 和 HTTP 投影负责；`sessionrelay` 在原有独立 Session 协议上负责绑定、grant 和同步结果准入，不借用项目或 Task 生命周期。

网页选择、详情与全屏组合由[助手管理页面设计](bot-management-web.md)拥有；[助手 Session 设计](bot-session-view.md)拥有共享视图绑定与缓存，不复制本文的服务端生命周期。

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

ready 依赖当前 relay 的 live 同步状态、当前连接及有效心跳，不能从 durable Snapshot 推导。报告事务还验证 `ConnectionParent` 对应的实际连接父 PAT；同代新 grant 可以更新 `Parent`，但尚未重新连接的 live 状态仍属于原 `ConnectionParent`，因此只验证报告者与最新 grant 的凭据不足以确认连接授权。durableSnapshot 不保存可被另一个实例误用的实时同步事实，因此没有本地同步证据的实例拒绝 ready。独立无首条输入的 Session 允许 native ID 尚未生成；报告中的 null 只在当前已同步快照同为 null 时成立，之后恢复仍需明确的原 native ID。

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

## CLI 管理与远端观测

Bot 命令拥有参数、业务请求身份、资源解析和显示；共享服务命令运行时拥有配置认证、请求预算、取消与输出。CLI 使用现有 `/api/v1/me/bots` 公开管理接口，不经过项目发现，不新增助手专用业务旁路。远端 Worker list/show 在命令分派时与 run、repo 和 claim 控制操作分开，不加载本地 Worker 库存或取得运行锁。

创建在请求前确定 Bot UUID，只向服务端发送名字及显式覆盖；省略字段保持省略，避免客户端默认值改变创建指纹。删除在请求前确定 deletionId，并将显式观察版本作为 ifVersion 字符串发送。Bot 的 int64 字段按十进制字符串校验、传输和输出，与普通 Task 的数字版 JSON 分开处理。成功响应必须与目标资源和请求身份匹配；响应结构不完整不能当作写入已确认。创建重放可以返回原资源的删除责任；服务端拥有原 owner 与请求指纹核对，CLI 对活跃定义比较名字及覆盖项，对最小删除责任只核验其公开身份与结构。两者都检查 principal、目标 Bot ID 和显式 Worker，删除责任不因缺少已清理的定义字段而被误报为未知结果。

已派发写入的传输失败、未知服务结果或无效成功响应保留原业务 ID 和未确认结果。错误投影仅公开操作、资源和请求身份、阶段、HTTP 状态、错误码和白名单内的可操作原因；不转储传输 cause、认证配置或服务端错误正文。显式 show 读取当前资源用于核对，CLI 本身不自动重发写入、更新版本或生成替代请求。创建的业务请求 ID 是 botId，删除的是 deletionId；HTTP 关联 ID 单独保留，避免把日志关联误作幂等依据。

列表按服务端不透明游标读完所有页面，检测重复游标和重复资源身份，之后才统一输出；后页失败时丢弃未完整的显示结果并保留错误。Bot 输出只包含公开 DTO，删除对象整体省略定义；删除完成取决于两个清理阶段，不能由 HTTP 200、列表隐藏或一个阶段完成推导。

Worker 列表保留服务端 observedAt 与完整 items，详情保留 observedAt 与 worker。人类显示从服务端时间计算 120 秒在线阈值，库存 observed/stale/unavailable 独立显示；null 库存不转为零，资源探测错误不转为可用。assistantHost 缺失表示没有托管观测。此读取与 Worker 运行、调度及能力广告无副作用联系，普通远端查询沿用服务端 72 小时窗口。

CLI 消费 [删除与清理事务](#删除与清理事务) 的真实阶段与最终 completed 结果；停证由绑定 Worker 提供，服务端拥有删除屏障与历史清理，命令自身不生成停证或清理历史。命令与错误用法见 [CLI 手册](../../packages/daynight/README.md#bot-management)，选择理由见 [CLI 观测决策](../../.agents/notes/implemented/architecture/2026-11-04-bot-cli-observation.md)。

## 删除与清理事务

公开 DELETE 由同一 `sessionrelay.Service` 处理。事务先通过共享凭据行锁验证 owner PAT 或登录 Session，再锁 Bot，核对 owner、原请求身份和当前版本，再按 `bot_id` 查询并锁定所有实际关联 Session，撤销 grant/连接授权，最后存入删除责任，并在事务完成前用新的当前时间再次验证凭据。精确重放在返回原结果前也执行该检查。凭据行共享锁阻止并发撤销，但不能阻止自然过期；最终检查覆盖 Bot、Session 行锁和写入等待，失效会回滚所有删除与授权变更，提交后才清除缓存。登记、归档上传和清理都使用 Bot → Session → archive metadata 锁序；已获准上传先完成，随后删除屏障生效。删除先提交时旧上传在文件写入前被拒绝。普通 Task 的历史归档流程不改变。

屏障事务单独提交，不与物理删除同生共死。提交后丢弃本实例的 live cache 和 pending content；其它实例在下一次权威读取观察 deletion 或 Session 已不存在时也丢弃对应内容。Controller 的 scope 预查询发生在共享 load 之前，因此该预查询确认 Session 不存在时也清除缓存与等待正文，覆盖只有 Poll 或 Disconnect 到达的旧连接；数据库查询失败本身不等于持久删除。异步正文返回前的二次准入阻止删除后交付迟到内容。进程缓存只服务当前连接，不能恢复持久删除记录。

Worker 完成接口要求有效 PAT、owner、绑定 Worker 和原 deletionId，直接核验原 Session 的 fence、Controller 身份及停证。已连接或曾提交 source/native 身份的执行不能声明 `never_started`。成功回执的规范化 SHA-256 存在 `deletion.receiptDigest` 中，与 Worker completed 结果一起提交。该内部字段不进入管理 DTO；Session 行清理后仍能精确核对重复回执。相同 failed state/code 在验证身份后返回原结果，不推进版本；错误码改变可记录新的失败。失败回执可由有效 completed 回执推进，但 completed 不能被不同回执覆盖。

服务端清理使用新事务，持有 Bot 和所有实际关联 Session 行锁。按 `bot_id` 查齐关联，而非仅相信 `bots.session_id`。逐行核对 owner、独立 scope 和 web backend，再由原 owner 与 Session 的规范化非零 UUID 构造 `sessionarchive.Namespace`，调用 `Storage.DeleteSessionArchives` 清理固定 `session-archives/users/<ownerUserId>/<sessionId[:2]>/<sessionId>/`。清理覆盖未提交 metadata 的孤立对象，不接受任意 bucket 或前缀；同用户、同分片下其它 Session 保留。逐级目录句柄、文件身份核对和符号链接拒绝保护其它命名空间。发现旧 `session-archives/<sessionId>/` 时先要求显式迁移，不能仅清理新目录就报告完成。部分删除、取消或同步失败保持错误，可按相同命名空间重试；不存在也执行目录持久化屏障。地址规则及存量转换见[共享归档设计](task-session-protocol.md#服务端归档布局与迁移)。

SQL 删除清单明确包含 `session_events`、`session_timeline`、`session_operations`、`session_resources`、`session_archives`、`session_recording_evidence`，最后删除 `task_sessions`。前四表没有级联，后两表没有 Session 外键，不能依赖父行删除隐式清理。完成后清空 Bot 的 Session 引用、角色、配置和名字等非责任数据，仅保留 owner/Worker、请求指纹、删除身份及两方结果。各实际阶段变化推进版本，int64 上限拒绝继续递增。

文件删除无法随 SQL 回滚。文件或 SQL 失败时数据库事务回滚，独立事务记录 `server_cleanup_failed`，保留已经提交的屏障与 Worker 回执。再次清理可接受文件已不存在；不得把失败状态覆盖到并发重试已提交的 completed。提交结果未知仍按原身份查询，不把网络失败当作失败确认或新请求授权。

该流程不读写 Task、用户普通目录或 native home。服务端 completed 仅与绑定 Worker 的 completed 回执共同证明可管理范围完成，不证明远端进程的独立观测或 Provider 全局历史擦除。实现取舍见[删除清理决策](../../.agents/notes/implemented/architecture/2026-11-04-bot-history-deletion.md)。

## 扩展约束

公开创建消费默认解析机制，Worker 生命周期消费稳定的 Session 绑定、grant 和报告接口。未组合托管能力前不启用完整助手 UI 入口。Worker 的[角色与 CLI 环境准备](bot-role-environment.md)提供单一版本化模板、持久角色选择和当前认证检查。Provider 实际启动与恢复、首次角色持久化与冻结接入、Worker 退出和私有资料清理仍由各自执行组件负责；服务端接受注册或报告不证明这些组件已完成端到端验收。删除消费者必须保留原停证、重复请求对账和两方阶段判定，公开创建返回 pending 不表示完整托管功能可用。

默认与偏好取舍见[默认解析决策](../../.agents/notes/implemented/architecture/2026-11-04-bot-default-resolution.md)。管理定义取舍见[管理定义决策](../../.agents/notes/implemented/architecture/2026-11-04-bot-definition-storage.md)。

Session 绑定、同步事实和准入取舍见[Session 准入决策](../../.agents/notes/implemented/architecture/2026-11-04-bot-session-admission.md)。
