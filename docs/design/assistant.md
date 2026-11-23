# 助手组合、定义与 Session 准入

[需求规格](../spec/assistant.md)区分现行接口与须声明能力的新增要求。本文的管理、登记、grant、删除及独立恢复 v1 接口描述现行服务端机制；Worker 的 `botRecoveryVersion=1` 须在本地存储、进程互斥与 Provider 恢复验证完成后启用。管理定义由 `core/bot`、`service/bot` 和 `server/bot` 负责；`core/session` 与 `service/session` 在独立 Session 协议上负责绑定、grant 和同步结果准入，不借用项目或 Task 生命周期。

网页选择、详情与全屏组合由[助手管理页面设计](bot-management-web.md)拥有；[助手 Session 设计](bot-session-view.md)拥有共享视图绑定与缓存，不复制本文的服务端生命周期。

[助手任务服务端](assistant-task.md)拥有独立的用户工作登记、手册与协作材料；其认领不占用项目 Task 的 Worker 执行槽，也不改变本文的 Bot Session 生命周期。

## 产品组合

Server 的正式构造入口将同一事务能力、文件存储和共享 Session engine 注入 Bot 管理与 Worker 生命周期路由。`/bots` 与 `/bots/{botId}` 同时注册为 SPA 页面入口，使直接访问和刷新能加载应用；登录配置将 `/bots` 保留为产品路由，避免自定义认证端点覆盖它。Bot 继续使用原独立 Session 的传输身份与共享 renderer，任务 Session 和独立 Test 不转换成 Bot。

Worker 在实例锁保护下打开任务和 Bot stores，将 Bot 清单、执行、授权维护、恢复和删除组合为独立管理循环。它不等待项目准备，也不占用 Task coordinator 的执行槽。托管预检与当前有效的全局原生配置共同生成 `assistantHost`；旧 Worker 缺少该报告时，默认解析保留 unsupported。当前全局或项目选择 Copilot，或本 Worker 存在非删除的 Copilot Bot 定义时，后台准备 Copilot；定义包括 pending、failed 和可恢复的记录，删除后的清理责任不触发新探测。未使用时仍保留 Copilot 条目，但没有现成成功证明便报告 unavailable。助手采集器按 Web Provider 校验参数；不支持的参数使对应 Provider 报告 `unsupported_arguments`，不能阻断普通 Task 状态报告。新配置更新报告和后续首次意图，已有配置与角色按持久身份保持冻结。退出先停止管理循环并汇总所有执行停止结果，再关闭 stores 与释放实例锁；失败不能转成成功。

网页 `AuthenticatedApp` 与全局侧栏共同选择 `/bots` 或 `/bots/{id}`，复用既有身份 scope、`BotsPage`、`BotSessionHost` 和 `SessionView`。导航、关闭聊天、切换选择及详情只改变浏览器展示与连接，不进入 Worker 停止路径。三个 pane 的缓存、定向删除失效和共享阅读恢复继续由各自模块拥有。

组合不增加持久格式：服务端迁移随 Go embed 发布，Worker SQLite SQL 随 CLI 包发布。验证必须覆盖真实安装 CLI 与生产 HTTP、生产 Web 页面及共享 relay，并明确受控 Provider 与真实原生执行的证据边界。整体独立验收不能由模块单测替代。组合取舍见[助手组合决策](../../.agents/notes/implemented/architecture/2026-11-05-assistant-composition.md)。

## 数据拥有者

追加迁移 `033_bots.sql` 创建 `bots`。主键为调用方生成的 UUID；`owner_user_id` 引用用户，`(owner_user_id,worker_id)` 引用现有 Worker 组合主键。数据库 identity 生成独立 `creation_order`，它用于按服务端创建顺序提交偏好，不依赖用户时钟或请求结束时间。

`requested_overrides` 保留显式输入，`resolved_configuration` 保存解析后的固定启动配置。两者不合并：默认值变化不能修改原请求身份。`request_fingerprint` 为规范化请求的 SHA-256，不包含可变的解析结果。名字和覆盖项先验证，再形成指纹；原始空白不产生额外定义。

创建时 `role_configuration`、`session_id` 为空，启动结果初始化为 pending。首次登记由 relay 事务同时冻结角色和 Session 关联。删除责任独立于启动配置，保存原删除 ID、请求版本及 Worker/服务端两方清理状态。

迁移 `037_bot_session_binding.sql` 为 `task_sessions` 增加可空、唯一的 `bot_id`，仅允许 `scope=test` 且 `backend=web` 的记录关联 Bot。复合外键 `(bot_id,owner_user_id)` 引用 Bot 及其 owner，数据库同时约束一 Bot 一 Session 和相同归属。`bots.session_id` 保存稳定引用，`testExecutionId` 从实际关联的 Session 投影，不另外分配执行身份。该引用不以反向外键要求保留已清理的 Session 行，以便最小 Bot 删除责任独立存在。

## 创建事务

`service/bot.Bots.CreateResolved` 是公开创建使用的默认解析入口；`service/bot.Bots.Create` 保留已解析配置的内部入口，两者共享创建事务。验证当前 principal 和输入后，通过 `Store.WriteBot` 在 ReadCommitted 事务中校验凭据、既有 ID 和 Worker 归属。凭据共享锁保护写入期间的撤销交错，并在等待后检查自然过期。

首次读取前取得按规范化 Bot ID 命名的事务 advisory lock，串行化同一 ID 的查回与默认解析；否则两个初次读取都为空时，后到的环境失败可能掩盖另一请求已经提交的结果。锁也覆盖已解析内部创建入口，与后续 Bot 行锁保持一致顺序。哈希碰撞只会增加等待，不改变归属或请求身份。插入仍使用 `ON CONFLICT(id) DO NOTHING`。冲突后用独立 SQL 语句读取并锁定原行，才能观察另一个事务刚提交的结果；不能用同一语句的快照兜底假定一定可见。相同 owner/指纹返回原行；不同请求冲突，删除中的行不恢复。数据库错误保留 `store.Error` 和事务结果信息，不将未知提交解释成回滚。

原 ID 的持久结果优先于当前默认解析和能力请求。需要原生选择时，先在事务外读取默认与偏好并查询绑定 Worker，再在短创建事务内重读同一基线；Worker、Provider、cwd、有效配置或偏好改变时拒绝过期结果。原请求并发提交后，事务内仍先按原 ID 返回其冻结结果。网络等待不持有创建事务的凭据、Worker 或 Bot 锁。冻结配置的格式和组合归属在插入前再次校验。HTTP 创建只接受名字与显式覆盖，不开放已解析配置内核；内部已解析入口只检查格式和归属。

## 默认解析与偏好事务

`core/bot` 统一 defaults 预览与首次创建的解析规则，`service/bot` 选择读取快照或创建事务。`BotReader.BotDefaults` 为预览读取完整 Owner Worker 目录与偏好，保持历史项及其原因。创建使用独立窄读合同：显式目标只读取该 Owner 的目标配置与偏好；自动选择先评估偏好目标，必要时读取按 `(created_at,worker_id)` 排序的 active 候选小投影，并以第 101 项检测超额。核心复用相同解析规则选择后，才读取目标的完整原生配置及偏好，并在创建事务中重新选择和验证。候选投影不解码任务快照或其他 Worker 的完整遥测。默认解析的时效判断时间在相关 Worker 与偏好读取后由数据库取得，避免 ReadCommitted 的新心跳晚于先前时间而被误判为未来；该时间只用于时效判断，不代表跨多次 SQL 的快照边界。完整目录不套用普通 Worker 列表的 72 小时隐藏，因此过期的显式 Worker 仍能返回具体不可用原因。

解析先处理显式 Worker；没有显式 Worker 时尝试成功 Worker 偏好，再按稳定顺序选择可用配置。每个候选先经过 `WorkerAssistantHostState` 的托管版本、在线及观测时效检查，再为该机器选择目录与 Provider。每项使用显式值、该 Worker 偏好、报告默认的顺序。模型与 effort 使用单助手显式值和按 Worker/Provider/模型绑定的成功偏好，其后读取目标 Provider 的有效默认。基础 args 只读取目标 Provider 的报告。失败目标保留原因，不在同一 Worker 上另猜一个 Provider。目录按 Worker 平台验证；真实文件系统与启动预检由绑定 Worker 负责。

Worker 的历史清理超时只能在原探测可靠确认后解除阻塞，并经下一轮只读预检成功生成新的可用报告；具体责任由[Worker 采集设计](daynight-worker-reporting.md#助手托管预检接入)拥有。默认解析不读取本机清理句柄，不以其它 Provider 的成功、已有 Bot 的持久 ready 或网页刷新代替当前目标的有效观测。预检成功仍不保证后续认证、模型访问或原生 Session 启动成功。

迁移 `036_bot_defaults.sql` 增加 `bot_worker_preferences` 和 `bot_configuration_preferences`。前者按用户保存最近成功显式 Worker；后者按用户与 Worker 保存目录和 Provider，各字段独立记录 creation_order。只选择 Provider 的新成功创建不能阻止另一请求的目录偏好首次提交；同时旧 Provider 选择也不能覆盖新成功 Provider。每个字段使用条件 upsert，不依赖 HTTP 完成时间或 Worker 时钟。

`store.BotWriteDAO.CommitBotPreferences` 加入调用方已有事务，不自行开启或提交。它重新读取持久 Bot，要求未删除、已绑定 Session 且 startupResult 为 ready，只提交持久显式项对应的冻结值。生命周期调用方必须先按 Bot → Session 锁序验证凭据、绑定 Worker、当前 native fence 与同步事实，再同事务持久化 ready 并调用该方法。Session 的 `ReportBot` 用例 在验证当前 live 同步后调用它；该内部方法的 ready 检查不替代 native 同步验证。数据库故障回滚整个事务，不留部分偏好。重放以原 creation_order 为条件，无额外写入效果。

默认查询无写入副作用；创建只写 pending Bot。迁移 `045_bot_native_preferences.sql` 增加独立模型和 effort 偏好表。model 偏好按 owner/Worker/Provider 保存，reasoningEffort 偏好再按有效模型隔离，各自使用 creation_order 水位。只有显式选择的字段在 ready 事务内提交；未知模型不能生成 effort 偏好。report 将偏好提交留在同一生命周期事务中，无需独立的客户端确认请求，也不能在 spawn 回执或表单提交后提前调用成功方法。

## 原生选择与冻结

`BotOverrides` 的 model/reasoningEffort 保留省略状态，不包含预览结果。`BotConfiguration` 保留原 model/args，并以可选 reasoningEffort 和 selection 表达新冻结合同。selection.schemaVersion 固定为 1，modelSource/reasoningEffortSource 分别标识 explicit、preference、local、cloud、native 或 unknown；经原生发现的配置保存 configurationGeneration 与 catalogGeneration。旧记录没有 selection 时维持原 JSON 形状。

Worker 的 assistantHost.creationConfigurationVersion=1 是支持新冻结格式的能力声明；单独支持 model.list 不足以证明能够消费新配置。旧 Worker 仍能按原合同进行名字创建，新增明确 model/effort 则拒绝。

`service/bot` 使用共享 workerreadonly broker 获取绑定 Worker 的 model.list。能力响应按 Provider、配置和目录代次聚合有界分页，隐藏模型仍参与支持性校验。无 model/effort 覆写和成功偏好的名字创建沿用报告，不增加全量探测。失效模型偏好回到有效 Worker 默认；失效 effort 偏好回到当前有效 effort。没有单助手 effort 覆写时，当前明确 Worker effort 不兼容必须保留错误，不能以旧成功偏好掩盖。

发现位于创建事务外；结果保存偏好解析后的配置、该 Worker/Provider 的原生偏好集合及移除原生偏好后的 Worker 基线。事务先核对原 ID，再重算并比较这三项输入，以识别被退役模型偏好遮住的 Worker 默认变化。发现与入库使用同一发现条件：明确或偏好来源需要发现，新格式下非空的模型维度 effort 历史也需要发现，即使当前报告没有可见模型。缺少所需发现结果或输入变化时返回 `resource_conflict`，不在事务中探测或自动重放创建。

Worker 保存完整冻结配置并使用它核对登记请求与执行身份。执行配置通过统一原生参数适配器生成，单助手值覆盖、去重原 args 中的 model/effort，保留其它已准入参数。首次原生启动复核最终组合；恢复沿用原 Session 和冻结意图，不借当前默认重配置，也不重写原生文件。Session 内临时切模型不进入 Bot 成功偏好写入路径。

字段及失败语义由[助手规格](../spec/assistant.md)拥有；[原生选择决策](../../.agents/notes/implemented/architecture/2026-11-06-bot-native-selection.md)记录隔离能力查询与创建事务的原因。

## Bot 独立存储与接管能力

`botRecoveryVersion=1` 的[数据归属、迁移和接管要求](../spec/assistant.md#bot-本地存储与恢复合同)由 Bot 存储、Worker 对账和服务端生命周期共同实现。Bot 本机目录持有 SQLite、执行意图、票据、journal、业务认领凭据及 Provider 恢复材料；公共 Worker 库存只保留可重建索引。服务端继续使用现有数据库与资源存储，按 owner、Bot 和 Session 隔离。未登记恢复身份的 Bot 继续使用既有 Worker 绑定和父 PAT 校验；登记后的 Bot 使用独立恢复接口，旧 register、grant、report 返回 `upgrade_required`。

迁移协调器在原 Worker、Bot 与 Controller 存储锁下核验原执行已停止，再复制一致 SQLite 快照及已提交 WAL，核对身份和资源摘要后切换唯一写入位置。原 Worker 库事务将源行移除与迁移摘要回执一起提交；原票据和 journal 停证保持不变，由独立映射定位副本。持久迁移阶段区分本地切换、恢复身份登记和远端回执确认，任一阶段未知都不能由下一阶段的现象推定成功。本地提交后的 `registration_pending` 阻止旧路径执行，机制与只读历史入口由 [Worker 执行层设计](worker-bot-runtime.md#bot-专属位置与迁移责任)拥有。Provider 适配器分别拥有最小恢复文件集、版本兼容和原线程恢复证据；时间线缓存不能替代原生恢复材料。

新 Worker 的对账入口先发现本地 Bot，再核对服务、当前账号和恢复身份；按新 Worker 过滤的远端清单不能遮蔽旧绑定。接管在服务端事务内核对 `expectedHostingGeneration`、Bot 未删除及访问权，原子推进承载 Worker 和授权，并拒绝旧承载代次写入。`hostingGeneration` 与 Controller 的 `executionGeneration` 分开：接回存活 Controller 不制造新原生执行；启动新进程仍需原 writer 停证和已知 native ID。新账号认证只用于重新核验并签发当前授权，不延长已失效父 PAT 的权限。

接管请求、恢复身份与观察字段使用独立版本化合同，不向现有严格管理 DTO 或 `/grant` 静默增加字段。原请求身份及结果查询由接管用例持久保存，结果未知不重发业务输入。当前机器、状态及新鲜度来自版本化观测；数据库中的 ready 或可读缓存不授予发送资格。上述机制不声明跨机接管或真实 Provider 验收已完成。

### 服务端恢复 v1 协议

入口为 `/api/v1/me/workers/{workerId}/bots/{botId}/recovery/v1/`。`register`、`takeover`、`grant`、`report` 和 `operations/{operationId}` 均使用 POST；最后一项只查询原回执，不重发操作。恢复证明仅放在请求正文，错误与回执不回显秘密。Go API DTO 与 TypeScript 独立解析器保留十进制 int64 字符串，旧管理 DTO 和旧 grant 形状保持不变。

所有请求包含 `botRecoveryVersion=1`、与配置 PublicOrigin 完全一致的 `serviceOrigin`、32 字节无填充 canonical base64url `recoveryIdentity`，且使用当前有效 PAT。`register` 另含 `operationId`、`botVersion`、`sessionId`、`testExecutionId`、必填可空 `nativeSessionId`。首次登记要求原 Worker、已绑定 Session 和当前 Bot 版本，将承载代次设为 1，并保存已锁定 Worker 报告的机器身份；不会新建 Session，也不延续旧 PAT 权限。已经登记的证明不能被另一登记覆盖。

`takeover` 和 `grant` 另含持久原 `operationId`、`expectedHostingGeneration`、完整原 Session/native 绑定、既有 `grant` 参数和预先生成并落盘的 `controllerToken`。token 为 `dncontroller_` 加 32 字节 canonical base64url，每个新操作使用新 token；服务端在 Bot 锁内检查全部历史回执中的摘要，拒绝重用任何旧 token。服务端仅保存摘要；调用方凭自身保留的 token 和回执恢复授权。接管核对同机身份，原子推进 `bot_recovery.worker_id`、Bot version 和 hosting generation，重置启动状态；`bots.worker_id`、原始 `resolvedConfiguration.workerId`、显式 overrides、创建指纹和角色保持冻结，旧管理 DTO 仍表示创建时绑定。当前承载身份由恢复回执提供，不能用旧 Worker inventory 发现或授权恢复执行。普通恢复 grant 只允许当前 Worker 与当前承载代次，不推进承载代次。

`service/bot/runtime.Recovery` 协调当前凭据、Bot、Session 和机器报告锁，`core/bot` 判断归属、恢复证明与承载代次，`core/session` 核验原会话及 Controller stopProof。`bot_recovery` 保存当前 Worker、服务域、机器、证明摘要和代次；`bot_recovery_operations` 保存原请求摘要和无秘密回执。它们与既有 Session 使用同一数据库事务。每次恢复 grant 都清除旧连接租约及同步资格。浏览器权限投影与命令准入共同要求当前持久连接租约有效；同 fence 的 relay 缓存只能提供阅读内容，不能覆盖租约撤销或过期。因此其它 relay 的旧缓存，以及提交成功但调用方只收到 unknown 的情况，都不能在新连接同步完成前恢复发送资格。连接失效不证明本机命令已停止。

回执包含原 `operationId`、kind、Worker、承载代次、Bot version、平台和原生身份，以及可空的 grant 到期时间与 token SHA-256。`current` 表示该回执仍对应当前承载；含 grant 时还要求未过期、摘要仍被选中、Controller 身份相同，且父 PAT 就是本次认证的 PAT。新 PAT 可以读取旧回执，但旧授权不因此恢复。相同操作 ID 与相同请求只返回原回执，不重新签发；不同请求冲突。未知提交保留 `outcome_unknown`，查询不存在不能证明先前未提交。客户端须保留原请求，不能把历史成功或当前可读状态当作新授权。

`report` 包含 `hostingGeneration` 和原 `report` 对象，先检查恢复证明、当前 Worker 与承载代次，再执行既有版本、fence、native ID 和 ready 同步检查。新恢复接口不参与普通 Task claim 或助手业务 claim 的流转。Worker 目录发现、独占锁、旧进程停证以及真实 Provider resume 仍由对应模块验收；服务端接口存在不自动启用这些能力。

携带 `previousGeneration` 的 `TakeoverBot` 和 `GrantBotRecovery` 在 grant 事务开始前，先经 `service/session` 的既有生命周期包装执行媒体租约恢复。存储 gate 已释放的孤儿租约会被清理，避免崩溃残留阻止 active history 退役；仍被占用的 gate 保留真实活动租约。清理错误阻止 grant，等待文件系统 gate 时不持有数据库 scope。未推进执行代次的恢复授权不增加这一步。

### 服务端观测 v1 协议

`GET /api/v1/me/bots/{botId}/observation` 独立返回 `schemaVersion=1` 的 Bot 观测，支持 HEAD，不扩展旧管理 DTO。`server/bot` 解析路径与编码公开字段；`service/bot` 协调当前账号授权、数据库快照与 Session 采样；`core/bot.Observe` 拥有状态优先级和时效计算。应用组装注入同一个 Session engine，读取不经过启动、grant 或浏览器 Session 生命周期。

第一次只读快照验证当前凭据和 Bot owner，读取 Bot、当前承载 Worker 与绑定 Session 的轻量元数据。`bot_recovery.worker_id` 优先于创建时 `bots.worker_id`；DAO 直接读取持久 Worker 行，不应用普通 inventory 的 72 小时过滤，也不读取其它 Task 的活动。恢复记录保存机器 ID 和最后登记名；同 ID 的当前 Worker 上报可更新显示名。未登记恢复身份的 Bot 从原 Worker 持久报告取得定位。Provider 来自冻结定义；平台 Session、test execution 和已知 native ID 来自现有绑定，不复制为另一套权威数据。

释放快照后，`Engine.ObserveBotSession` 仅复制本 relay 对应 live cell 的已提交标量；它核对 server instance、execution generation 和 connection epoch，不加载正文、原凭据、controls 或操作能力，也不执行 `TestSnapshot` 的归档与授权生命周期。第二次只读快照重新授权并取得当前 Bot、Session 和连接租约。版本或 relay 发生变化时丢弃第一次 live 结果，精确 fence 及持久 lease 再决定能否报告活动。同 fence 的恢复授权清除了 lease 时，旧同步缓存也只能产生 recovering。

状态先判断 Worker 失联，再判断当前机器身份、已确认启动失败与新鲜 Provider 失败。未绑定或首次缺 native ID 为 connecting；已有 native ID 但启动、连接或同步未完成为 recovering。只有当前同步来源才能产生 idle／working，`waiting_input` 表示 idle 并保留对应 reason。已停止、失败或非 active Session 为 abnormal。Worker 截止为最后报告加 120 秒；Session 截止为心跳加 30 秒、live 采样时间加 30 秒与持久 lease 截止的最早者；采用 Provider 失败时还受其预检时效约束。离线返回最后事实和 null `freshUntil`，不返回实时轮次。

输出省略所有恢复证明与 token，不含 send 权限。它证明某次读取的定位与状态，不能证明原机器进程已停止、Provider 备份完整或用户下一次输入已获准。具体公开字段与消费者要求见[助手规格](../spec/assistant.md#字段版本与失败语义)。取舍见[Bot 观测决策](../../.agents/notes/implemented/architecture/2026-11-20-bot-availability-observation.md)。

## 登记与恢复事务

Session 的 `RegisterBot` 用例 验证 PAT、Bot owner、绑定 Worker 和请求结构，按 Bot → Session 顺序取得锁。首次登记要求当前版本与请求相等、角色和 Session 尚未绑定、输入 configuration 与持久配置一致，并要求独立 registration 使用 `initialInput=none` 和相同 Provider。角色全文、revision、digest 随请求提交；服务端校验全文及摘要，但不拥有角色模板。

Session 行保存完整原 Bot 登记请求，包含原 botVersion、registration、configuration 和 roleConfiguration。响应丢失后的精确重放依据该记录核对，返回同一个 Session 和当前 Bot；不能以已经递增的 Bot version 拒绝原请求，也不能仅凭 registrationId 接受不同角色。删除校验先于重放。`store.BotWriteDAO.BindBotSession` 加入原事务，以版本、未删除、空角色及空 Session 为条件执行 CAS；首次绑定写入完成后，`RegisterBot` 使用当前 `s.now()` 再次调用 `credential`，才允许事务提交。凭据共享锁只能阻止撤销，不能阻止等待期间的自然过期。插入 Session、冻结角色、推进 Bot 版本或最终凭据核验任一失败均一起回滚。

Bot grant 在锁住 Bot 和 Session 后检查版本、Worker、独立执行身份、Controller 和 native ID，随后使用现有 grant 内核。普通 Test 入口遇到 Bot 关联直接拒绝。Bot 专用解码器允许独立身份携带 previousGeneration/stopProof；普通 Test 解码器继续禁止这些恢复参数，wire 不新增 claim 或 Worker 身份字段。

恢复新 generation 复用原 Session/native ID，验证 previousGeneration 恰好连续、原停证和新 Controller instance。已推进 generation 的重放还须匹配持久 stopProof，避免使用另一份停证刷新同一代授权。缺失 native ID 或 never_started 不构成恢复依据。相同 generation 的 grant 与续期不修改冻结角色或配置。

## 启动报告与偏好提交

`ReportBot` 先锁 Bot 并验证当前版本、Worker 与凭据。尚未绑定时仅允许没有 Session/Controller 身份的预检失败。绑定后读取原 Session，并比对完整 ControllerFence、controllerId、controllerInstanceId 和 nativeSessionId；failed 报告同样不能来自旧连接或旧代。

ready 依赖当前 relay 的 live 同步状态、当前连接及有效心跳，不能从 durable Snapshot 推导。报告事务还验证 `ConnectionParent` 对应的实际连接父 PAT；同代新 grant 可以更新 `Parent`，但尚未重新连接的 live 状态仍属于原 `ConnectionParent`，因此只验证报告者与最新 grant 的凭据不足以确认连接授权。durableSnapshot 不保存可被另一个实例误用的实时同步事实，因此没有本地同步证据的实例拒绝 ready。独立无首条输入的 Session 允许 native ID 尚未生成；报告中的 null 只在当前已同步快照同为 null 时成立，之后恢复仍需明确的原 native ID。

报告先校验版本、身份和适用的同步条件；结果与持久值相同则返回原 Bot。结果变化时，`store.BotWriteDAO.SetBotStartup` 以当前版本及未删除状态更新结果并推进版本；ready 随后在同一事务调用 `CommitBotPreferences`。未绑定 Session 的失败报告在写入完成后、或相同结果返回前，以当前 `s.now()` 调用 `credential` 重验 PAT；等待期间自然过期会拒绝成功响应并回滚写入。绑定后的报告继续使用 `scopePermission` 和适用的连接父 PAT 校验。成功结果与偏好不可分别提交，数据库或最终凭据核验失败必须一起回滚。持久 ready 只记录已确认的启动结果；在线状态继续由 Session Snapshot 和新鲜观测拥有。

## Session 锁序与持久准入

带锁的 Bot 读取先单独取得行锁，再以新 SQL 语句投影完整定义及关联的 testExecutionId。这样，等待并发注册提交后，Bot 行与 Session 子查询都能看到已提交的关联；不能在同一 SELECT FOR UPDATE 内依赖子查询的旧语句快照。

Session 加载先无锁读取 Session 的不可变 Bot 归属，再锁定 Bot，最后锁定 Session 并重新核验双方引用与 owner。持久删除状态的校验发生在 attachLive 之前，缓存中的旧同步或授权不能覆盖删除事实。普通 Task 保持 task-before-session 顺序；无 Bot 的普通 Test 保持独立规则。

browser、controllerGrant、controller 和 archiveAccess 共用该加载路径，使 Snapshot、channel、command、timeline、operation、resource 请求及回传、Controller event/ack 和 archive 都遵守 Bot → Session → archive metadata 顺序。异步内容返回前原有二次 browser 准入仍执行，防止等待期间删除或身份变化后泄露内容。禁止先锁 Session 再在 scopePermission 中反向取得 Bot 锁。

Bot 生命周期验证 Worker PAT；共享 Session 继续验证 owner 的当前凭据与 Controller 父 PAT。普通 Test 注册命中 Bot 记录时拒绝，grant/stop 也拒绝 Bot 关联；Test 列表在 SQL 层排除 bot_id 非空记录。浏览器继续消费真实独立 Session 身份，不能通过普通 Test 生命周期接口改变 Bot 关联或 generation。

## 查询与授权

查询使用现有 snapshot 和分页游标，范围包含当前用户及可选 Worker ID。REST 分别调用 `List` 或 `ListWorker`，MCP 列表调用同一 `List`；每次列表在该快照中核验凭据及作用域后，由 `BotReader.Bots` 一次读取 `limit+1` 项。普通列表过滤所有删除意图；Worker 清单保留任一清理阶段尚未完成的行。排序为 `(created_at,id)`；`creation_order` 另用于比较创建先后，不用作当前分页游标。

`Get` 先确定资源是否存在，再验证 owner。Worker 清单检查组合身份，不以 Worker UUID 推导跨用户权限。服务层在一次列表用例内核对持久凭据，不为每个候选重复授权；HTTP 外层继续使用现有 Authentication middleware，保留浏览器 Origin 检查和 PAT 生命周期。

HTTP DTO 将版本及创建序号编码为字符串，并投影实际关联的 sessionId/testExecutionId；尚未登记时两者为 null。删除后整体省略 `BotDefinition`，仅保留最小责任，避免单独漏删某个配置或角色字段。内部数据库对象不直接序列化为管理响应。DAO 通过 `scanBot` 和普通 `json.Unmarshal` 读取保存的 JSON；结构、字段、规范化和现有容量规则由写入入口拥有，不在读取时复查，也不在 SQL 中解释完整 JSON。列表按条数产生 cursor，不使用读侧 measurement callback 或字节准入。正常扫描、解码和输出错误保留原错误链。共享 MCP 入口的读取结果不执行输出 schema 或字节准入；输入、并发和期限规则继续适用。[读取简化决策](../../.agents/notes/implemented/simplification/2026-11-09-worker-bot-canonical-reads.md)记录这些职责。

## CLI 管理与远端观测

Bot 命令拥有参数、业务请求身份、资源解析和显示；共享服务命令运行时拥有配置认证、请求预算、取消与输出。CLI 使用现有 `/api/v1/me/bots` 公开管理接口，不经过项目发现，不新增助手专用业务旁路。远端 Worker list/show 在命令分派时与 run、repo 和 claim 控制操作分开，不加载本地 Worker 库存或取得运行锁。

创建在请求前确定 Bot UUID，只向服务端发送名字及显式覆盖；省略字段保持省略，避免客户端默认值改变创建指纹。删除在请求前确定 deletionId，并将显式观察版本作为 ifVersion 字符串发送。Bot 的 int64 字段按十进制字符串校验、传输和输出，与普通 Task 的数字版 JSON 分开处理。成功响应必须与目标资源和请求身份匹配；响应结构不完整不能当作写入已确认。创建重放可以返回原资源的删除责任；服务端拥有原 owner 与请求指纹核对，CLI 对活跃定义比较名字及覆盖项，对最小删除责任只核验其公开身份与结构。两者都检查 principal、目标 Bot ID 和显式 Worker，删除责任不因缺少已清理的定义字段而被误报为未知结果。

已派发写入的传输失败、未知服务结果或无效成功响应保留原业务 ID 和未确认结果。错误投影仅公开操作、资源和请求身份、阶段、HTTP 状态、错误码和白名单内的可操作原因；不转储传输 cause、认证配置或服务端错误正文。显式 show 读取当前资源用于核对，CLI 本身不自动重发写入、更新版本或生成替代请求。创建的业务请求 ID 是 botId，删除的是 deletionId；HTTP 关联 ID 单独保留，避免把日志关联误作幂等依据。

列表以每页 100 项按服务端不透明游标读完所有页面，检测重复游标和重复资源身份，之后才统一输出；后页失败时丢弃未完整的显示结果并保留错误。`runBotCommand` 仅为 `list` 向共享 runtime 传入 `operationLimits.responseBytes=DEFAULT_OPERATION_LIMITS.totalBytes`，即 256 MiB；累计 `totalBytes` 仍为 256 MiB。这样一个普通条数页可使用剩余累计传输预算，全部分页继续共同计量。`show/create/delete` 保留默认 128 MiB 单响应上限，所有命令沿用原累计额度、总期限、请求期限和取消规则。[共享客户端设计](daynight-project-task.md#服务地址与-http-客户端)拥有默认计量机制，[Worker 库存设计](worker-bot-inventory.md#权威读取与对账)拥有托管清单的独立 64 MiB 传输额度。普通 Bot 输出只包含公开 DTO，删除对象整体省略定义；正常删除完成取决于两个清理阶段，不能由 HTTP 200、列表隐藏或一个阶段完成推导。删除恢复命令另外消费独立决定，明确区分服务端已收尾与本机已核实。

Worker 列表保留服务端 observedAt 与完整 items，详情保留 observedAt 与 worker。人类显示从服务端时间计算 120 秒在线阈值，库存 observed/stale/unavailable 独立显示；null 库存不转为零，资源探测错误不转为可用。assistantHost 缺失表示没有托管观测。此读取与 Worker 运行、调度及能力广告无副作用联系，普通远端查询沿用服务端 72 小时窗口。

CLI 消费[删除与清理事务](#删除与清理事务)的真实阶段。普通 `bot delete` 只提交删除意图；`bot deletion inspect` 组合服务端独立恢复读取与原配置目录的本机检查，`--server-only` 不打开本地 Worker 存储；`bot deletion recover` 在取得原机器的必要锁后调用既有 Worker 删除机制，停证仍由原执行身份和实际停止校验生成。`resolve` 与 `retry-cleanup` 只通过公开恢复接口提交明确决定，服务端拥有历史清理。命令用法由[删除恢复手册](../../packages/daynight/src/commands/skill/skills/using-daynight/references/bot-deletion.md)拥有；普通管理选择理由见[CLI 观测决策](../../.agents/notes/archived/architecture/2026-11-04-bot-cli-observation.md)。

## 删除与清理事务

公开 DELETE 由 `service/bot` 协调共享 Session engine 和事务能力处理。事务先通过共享凭据行锁验证 owner PAT 或登录 Session，再锁 Bot，核对 owner、原请求身份和当前版本，再按 `bot_id` 查询并锁定所有实际关联 Session，撤销 grant/连接授权，最后存入删除责任，并在事务完成前用新的当前时间再次验证凭据。精确重放在返回原结果前也执行该检查。凭据行共享锁阻止并发撤销，但不能阻止自然过期；最终检查覆盖 Bot、Session 行锁和写入等待，失效会回滚所有删除与授权变更，提交后才清除缓存。登记、归档上传和清理都使用 Bot → Session → archive metadata 锁序；已获准上传先完成，随后删除屏障生效。删除先提交时旧上传在文件写入前被拒绝。普通 Task 的历史归档流程不改变。

屏障事务单独提交，不与物理删除同生共死。提交后丢弃本实例的 live cache 和 pending content；其它实例在下一次权威读取观察 deletion 或 Session 已不存在时也丢弃对应内容。Controller 的 scope 预查询发生在共享 load 之前，因此该预查询确认 Session 不存在时也清除缓存与等待正文，覆盖只有 Poll 或 Disconnect 到达的旧连接；数据库查询失败本身不等于持久删除。异步正文返回前的二次准入阻止删除后交付迟到内容。进程缓存只服务当前连接，不能恢复持久删除记录。

Worker 完成接口要求有效 PAT、owner、绑定 Worker 和原 deletionId，直接核验原 Session 的 fence、Controller 身份及停证。已连接或曾提交 source/native 身份的执行不能声明 `never_started`。成功回执的规范化 SHA-256 存在 `deletion.receiptDigest` 中，与 Worker completed 结果一起提交。该内部字段不进入管理 DTO；Session 行清理后仍能精确核对重复回执。未形成独立收尾决定时，相同 failed state/code 在验证身份后返回原结果，不推进版本；错误码改变可记录新的失败。失败回执可由有效 completed 回执推进，但 completed 不能被不同回执覆盖。独立收尾决定的检查先于原 Session 是否存在的判断，防止清理后的迟到空停证被当作未绑定执行接受。

服务端清理使用新事务，持有 Bot 和所有实际关联 Session 行锁。按 `bot_id` 查齐关联，而非仅相信 `bots.session_id`。逐行核对 owner、独立 scope 和 web backend，再由原 owner 与 Session 的规范化非零 UUID 构造 `sessionarchive.Namespace`，调用 `Storage.DeleteSessionArchives` 清理固定 `session-archives/users/<ownerUserId>/<sessionId[:2]>/<sessionId>/`。清理覆盖当前目录中未提交 metadata 的孤立对象，不接受任意 bucket 或前缀；同用户、同分片下其它 Session 保留。逐级目录句柄、文件身份核对和符号链接拒绝保护其它命名空间。既有旧布局归档不转换，也不在当前命名空间的物理清理范围内；旧目录存在不阻止当前清理完成。部分删除、取消或同步失败保持错误，可按相同命名空间重试；不存在也执行目录持久化屏障。地址及清理范围见[共享归档设计](task-session-protocol.md#服务端归档布局)。

SQL 删除清单明确包含 `session_events`、`session_timeline`、`session_operations`、`session_resources`、`session_archives`、`session_recording_evidence`，最后删除 `task_sessions`。前四表没有级联，后两表没有 Session 外键，不能依赖父行删除隐式清理。完成后清空 Bot 的 Session 引用、角色、配置和名字等非责任数据，仅保留 owner/Worker、请求指纹、删除身份、两方结果及存在的独立收尾决定与原绑定。各实际阶段变化推进版本，int64 上限拒绝继续递增。

文件删除无法随 SQL 回滚。文件或 SQL 失败时数据库事务回滚，独立事务记录 `server_cleanup_failed`，保留已经提交的屏障与 Worker 回执。再次清理可接受文件已不存在；不得把失败状态覆盖到并发重试已提交的 completed。提交结果未知仍按原身份查询，不把网络失败当作失败确认或新请求授权。

该流程不读写 Task、用户普通目录或 native home。服务端 completed 仅与绑定 Worker 的 completed 回执共同证明可管理范围正常完成；独立收尾只证明服务端清理已完成，本地仍未核实。两者均不提供服务端对远端进程的独立测量或 Provider 全局历史擦除。普通删除的取舍见[删除清理决策](../../.agents/notes/archived/architecture/2026-11-04-bot-history-deletion.md)。

### 独立删除恢复资源

`api/bot_deletion_recovery.go` 与 `/api/v1/me/bots/{botId}/deletion-recovery` 拥有独立 `schemaVersion=1` 投影，既有 Bot DTO、cleanup 三态和严格旧 reader 保持兼容。GET 在同一读取快照核验 owner、当前凭据与 `bot:read`，从原 Session 取得最小绑定，或在 Session 清理后使用持久决定保留的绑定。绑定字段为 `sessionId`、`testExecutionId`、字符串 `executionGeneration`、`controllerId`、`controllerInstanceId`；它们只标识需验证的执行，不构成停证。

响应另外包含 `botId`、当前字符串 `version`、`deletionId`、原字符串 `requestedVersion`、原 `workerId`、当前承载 `hostingWorkerId`、`requiresStopProof`、`recoveryRequired`、`workerCleanup`、`serverCleanup` 与可空的 `decision`。原 Worker 保持与普通 DTO 及本地记录一致，当前承载 Worker 从 Bot 恢复身份或已保存删除决定取得。`requiresStopProof` 根据原绑定产生；`recoveryRequired` 仅在 Worker 为 `failed/execution_evidence_missing`、尚无决定且服务端未完成时成立。未删除的 Bot 返回资源冲突，不把活跃状态投影成待恢复删除。

恢复仅使用按 Bot ID 的独立资源，不建立账号级恢复集合。CLI 拥有本机检查、正常证据恢复及明确收尾写入；Web 仅对已有删除记录或已知 Bot ID 读取该资源并显示原机器指引。普通 Bot 列表继续隐藏删除定义，新设备没有已知 Bot ID 或保留记录时不自动发现删除历史。单项读取需要 `bot:read`，明确收尾写入同时需要 `bot:read`、`bot:delete` 及原所有者身份。

`model.BotDeletion.Recovery` 是保存在现有 deletion JSON 中的可选内部责任，包含决定时的托管 Worker、原绑定及决定。决定保留 `operationId`、确认依据的 `requestedVersion`、`actorUserId`、UTC `acknowledgedAt`、原 `reason` 和固定 `localDisposition="unverified"`。它不进入旧管理投影，也不含会话正文或凭据；原绑定在 SQL 清理后仍用于解释义务和拒绝迟到回执。

`ResolveDeletion` 先验证输入，再按凭据 → Bot → Session 锁序核验当前 owner、读取与删除作用域、原 deletionId 和版本；在原 Session 锁下固定绑定。`accept_unverified` 要求明确 acknowledgement 和 1–1000 个 Unicode 字符的理由，不能用空白、NUL 或非法 Unicode。核验、决定和版本推进同事务保存，事务结束前再次核验凭据；之后才进入既有 `clean`。有效决定为服务端清理提供独立准入，但保留 Worker 原失败，不生成完成回执或 receipt digest。

`accept_unverified` 精确重放仅返回已保存决定，不再次执行文件清理；不同 operationId、原版本或理由均不能覆盖它。`retry_cleanup` 引用已有决定的 operationId，要求当前 Bot 版本且服务端未完成，先持久化 pending 并推进版本，再执行同一清理流程。未知提交通过 GET 核对原决定与真实阶段，不自动重发；文件或 SQL 失败继续使用原失败记录机制，不能覆盖并发已经完成的结果。普通 Worker 回执和明确决定共用 Bot 锁，正常完成先提交后会拒绝过期确认；决定先提交后则拒绝迟到回执，不能因 Session 引用清空而制造虚假本地完成。

机制取舍见[删除证据恢复决策](../../.agents/notes/implemented/bug-fix/2026-11-23-bot-deletion-evidence-recovery.md)。

## 扩展约束

独立于项目 Task 的助手任务，其待实现的[认领凭据与转交合同](assistant-task-claims.md)规定跨 Worker 接收、原操作恢复和验证职责。该设计不改变本页已有 Bot 生命周期，也不表示助手任务 API 已交付。

公开创建消费默认解析机制，Worker 生命周期消费稳定的 Session 绑定、grant 和报告接口。助手导航与正式 Worker 托管在同一产品组合中启用。Worker 的[角色与 CLI 环境准备](bot-role-environment.md)提供单一版本化模板、持久角色选择和当前认证检查。Provider 实际启动与恢复、首次角色持久化与冻结接入、Worker 退出和私有资料清理仍由各自执行组件负责；服务端接受注册或报告不证明这些组件已完成端到端验收。删除消费者必须保留原停证、重复请求对账和两方阶段判定，公开创建返回 pending 不表示完整托管功能可用。

默认与偏好取舍见[默认解析决策](../../.agents/notes/archived/architecture/2026-11-04-bot-default-resolution.md)及[有界创建选择决策](../../.agents/notes/implemented/architecture/2026-11-07-bounded-bot-creation-selection.md)。管理定义取舍见[管理定义决策](../../.agents/notes/archived/architecture/2026-11-04-bot-definition-storage.md)。

Session 绑定、同步事实和准入取舍见[Session 准入决策](../../.agents/notes/archived/architecture/2026-11-04-bot-session-admission.md)。
