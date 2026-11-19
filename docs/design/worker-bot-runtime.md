# Worker Bot 执行层设计

[需求](../spec/worker-bot-runtime.md)定义启动、维护、恢复和删除保证，[执行决策](../../.agents/notes/implemented/architecture/2026-11-05-worker-bot-runtime.md)说明共享机制与停证取舍，[存储决策](../../.agents/notes/implemented/architecture/2026-11-19-bot-owned-storage.md)说明新 Bot 的专属数据归属。`botRecoveryVersion=1` 的完整要求由[助手本地存储合同](../spec/assistant.md#bot-本地存储与恢复合同)拥有；专属存储不单独证明 Provider 原生恢复或新 Worker 接管能力。

## 数据与句柄

`bots/local-store.ts` 为新 Bot 在配置根下建立 `bots/<botId>/store.sqlite`。专属格式包含 `bot_identity`、`bots` 和 `bot_executions`；身份与初始 schema 在同一事务提交。格式 2 保留迁移责任，拒绝会丢弃该字段的旧 reader/writer；从格式 1 升级不改原记录。身份固定服务域、账号和 Bot，目录打开时拒绝不匹配、符号链接及未知格式。每个 Bot 的 `instance.lock` 与 `ownership.sqlite` 排除另一持有者，锁保留到两份数据库连接及其执行使用者关闭。

`bots/store.ts` 保持冻结定义和首次注册意图；`bots/execution-store.ts` 在同一个 Bot SQLite 中维护执行证据。恢复代际切换的 intent 与 execution 行仍在单一事务提交。发现扫描专属目录，不依赖公共 Worker 库保存新 Bot 行；不同服务或账号的目录不进入当前库存，已有不同 Worker 绑定须经独立接管流程处理。

未迁移 Bot 继续使用原 Worker SQLite 与公共 Controller 路径。旧库的 `009-bot-executions.sql` 引入执行证据；`010-bot-recovery.sql` 为旧意图补充当前 `controllerInstanceId`、恢复计数、正常关停来源、阻止原因、前代停证及保留路径。旧 Worker 拒绝打开不理解的格式。工厂拒绝同时存在旧行与专属库的双权威，也拒绝为已绑定 Session 但没有原本地记录的 Bot 新建空白来源。

执行行按服务、账号、Worker、Bot 隔离。首次 `registration` 保持不变，`intent.controllerInstanceId` 表示当前代 Controller；换代只改变当前 generation、launchId、Controller instance 和对应 ticket 路径。Session、testExecutionId、initialOperationId、已知 native ID、角色及冻结配置延续原身份。

Web Codex/Copilot 的 intent 同时冻结完整 `toolLaunch` 和同 recipe 的 `toolObservation`；Worker SQLite 格式 14 与 Web 库格式 4 阻止旧进程丢弃这些字段。启动、原身份恢复与 never-submitted 侧文件规则由[工具冻结设计](daynight-worker.md#本地工具路径选择)拥有。观察和停止原活 Controller 不因当前工具文件变化而失效。

执行写入在即时事务中重新核对库存中的当前 intent。未知提交不能回退为未提交；同代已知 native ID 与进程出生证明不能更换或丢弃。`beginRecovery` 同时更新库存意图与执行证据，避免崩溃后出现新 intent 配旧代提交状态。它要求原代完整 stopped snapshot、native ID、Controller process proof 与允许的恢复预算，保存前代停证及原 launch/别名路径后，产生一个未提交的新目标。普通 patch 不能修改恢复计数或关停来源。

删除进度保存在既有 `bots.record` JSON 的可选 `cleanup` 中，固定原 `deletionId`、请求版本、stopProof、清理目标和完成状态；缺省表示尚未准备清理。`011-bot-deletion.sql` 将 Worker 格式升为 11，不新增表，但阻止旧 Worker 打开或继续使用数据库：旧版 observe 会重写 JSON 并丢弃不认识的清理字段，仅依赖 deletion marker 拒绝启动无法保住 journal 删除后的唯一回执。本地清理完成时，在同一事务中清空定义和 intent、删除 `bot_executions` 行并裁剪目标列表，保留原停证与完成回执身份。

删除投影保留停止与精确清理所需的原责任，只有本地私有清理完成后才裁剪定义和执行资料。Task 表、maxConcurrent、收尾期限和容量计算不读取 Bot 执行行；保留的私有路径也不授予删除普通 cwd 或共享 native home 的权限。

## 启动与授权

`createBotProcess` 按 Bot 串行化启动、续期、停止和删除。Host 将独立 `canAdmitNewExecution()` 传给 runtime/process，Worker 依据 manager 存储 readiness 与已生效 native/recovery 配置实现它；`configuration()` 仍只用于能力和配置采样。首次预检先验证参数及目标配置环境，在每个 awaited preparation 后以及持久 intent、初次 register 与 launch submission 前重查门禁，再持久化身份和 `selectBotRole` 选择的角色。这样预检失败报告导致的 Bot 版本递增不会提前固定一个失效的注册版本。

`BotAdmissionBlockedError` 表示新执行仍需等待，发现循环不将它报告为环境启动失败。已冻结但从未派发的初次 launch 仍检查门禁；已经提交、未知提交或带有原 native identity 的恢复继续核对原 ticket、journal 和 frozen configuration，不因为新的准入状态创建空白替代执行或撤销输入/停止权限。准备资源释放与未知清理沿原 handle 归属处理。

`bots/session-api.ts` 用 Worker 正常 PAT 调用 Bot register/grant/report 和 deletion-complete；响应必须携带相同账号，字节数与请求时间有界。注册传递首次 `botVersion`，之后的 grant/report 使用当前观察版本。HTTP 客户端不自动重复 POST；运行时先 GET 原 Bot，再核对或继续原请求。ready 报告前读取服务端 Session，核对完整 fence、同步状态和 native identity。删除回执使用固定 `deletionId` 和原执行 stopProof，不读取已被删除屏障禁止访问的 Session 历史。

ticket 复用 Controller 的私有不可变 launch 文件和原路径规则，为独立 Session，不含 Task/claim/worktree，角色与初始输入分别编码。Controller 自身仍负责 Provider 适配与原生权限。准备出的环境和别名责任保留到原执行停止；提交前失败可以释放当前准备资源，提交后未知结果不能清理仍可能使用的目录。

`backends/controller-process.ts` 被 Task 与 Bot 实际共享：日志准备、持久提交回调、detached spawn、process proof、认证 IPC 观察和按执行串行化。Task 的 worktree、claim、cleanup prompt、归档及回收仍由原 backend 持有。明确 OS 启动拒绝先持久化，再报告服务端；Provider 快速拒绝后 IPC 可能已关闭，此时只允许读取同 fence 的 journal 失败证据，旧 ready 记录不能作为当前在线证明。启动时的 Windows 进程证明通过本进程内的同一原 process handle 采集出生时间、父进程身份及完整命令行，保持证明字段结构与出生时间精度，完整 Unicode 命令行不再经过 PowerShell console 编码，并使用共享 15 秒预算；native 调用之间检查预算，已开始的调用仍须等待返回。POSIX 采集和日常身份复核仍为 5 秒；完整证明、认证 IPC 和资源责任由[Session 设计](task-session-protocol.md)拥有。

## Bot 专属位置与迁移责任

`bots/paths.ts` 统一派生新 Bot 的 SQLite、锁、CLI 私有状态与 Controller 存储根。Controller 接受显式存储根，将票据放在 `bots/<botId>/controller/launches/`，journal、媒体和同步材料放在 `bots/<botId>/controller/executions/<executionId>/`。Worker 与 Controller 的临时 CLI 别名也位于该 Bot 目录。子进程通过内部 `DAYNIGHT_CONTROLLER_STORAGE_DIR` 接收位置，Provider 环境移除该变量；`DN_CONFIG_DIR`、正常账号认证与冻结 `nativeHome` 保持各自原用途。普通 Task/Test 未传专属根时继续使用公共位置。

清除公共 Worker/Controller 目录不会删除新 Bot 的这些文件。Provider 原生恢复材料的隔离、旧数据迁移和新 Worker 接管仍由各自机制负责；目录发现不等于已取得服务端执行权，不授权创建替代会话。

未迁移格式仍使用本文描述的公共位置。`worker migrate-bot` 是离线迁移入口：取得原 Worker 实例锁、Bot 独占锁与 Controller 存储许可，核验原执行已经停止，不主动终止存活助手。未知提交、缺失进程证明或仍持有的锁阻止切换；文件可读或心跳过期不能替代停证。

迁移复制包含已提交 WAL 的一致 SQLite 快照与所属资源。Bot 专属库只接收目标 Bot 的库存及执行行，不复制普通 Task 库存。原始 intent、ticket、Session、native ID、操作 ID 与未确认操作保留；manifest 单独记录物理副本位置及摘要。旧 Bot 恢复时可能保留公共 Controller 路径，却在 Bot 专属根创建新一代别名，因此迁移同时接受执行记录中的公共与该 Bot 专属别名目录，并分别存放副本，防止两根下同名目录相互覆盖。journal 的 ticket hash 和 Windows 停证继续使用原票据，不能通过重写路径后重算摘要制造新的原执行证据。

复制和校验阶段持久化后，原 Worker SQLite 在同一事务内删除目标两行并写入绑定 manifest 摘要的迁移回执，作为唯一权威切换点。`019-bot-migration.sql` 引入回执表和源格式门槛。中断后按持久阶段与该回执核对，不能仅凭原行消失推断提交成功。源 schema 升级阻止旧 Worker 再次打开旧格式写入；未完成的迁移由本地存储路由拒绝，避免部分副本进入正常执行。

本地提交保留独立的 `registration_pending` 状态。启动、观察、续期、停止和删除入口不再依据原 intent 访问旧目录；接管模块完成跨端恢复身份登记与回执核对后才能建立后续执行。`worker migrated-bot-history` 通过副本映射和原 ticket 校验读取保留历史，不启动 Provider，也不声明新增浏览器离线历史服务。Provider 原生数据的最小文件集与版本由适配器实测确定，只有公共目录路径或时间线副本不构成恢复材料。迁移取舍由[决策记录](../../.agents/notes/implemented/architecture/2026-11-19-bot-storage-migration.md)说明。

新位置的精确删除使用同一归属解析器，Bot 私有原生副本随其私有资料处理，共享 native home 和 cwd 保留。最小删除责任必须在执行 journal 删除后仍可读取，直至两端确认；不能通过先删整个 Bot 目录丢弃原回执和未完成责任。存储、迁移、接管和 Provider 验证分别完成前，不声明该能力或同机恢复验收成功。

## Codex 原生恢复点

新建 Codex Bot 的 ticket 以 `codexBotRecovery` 固定 Bot ID 与 `bots/<botId>/native/codex/`。Worker 核对路径由原配置根和 Bot 派生，Controller 将服务、owner、Bot、Session 与真实 cwd 交给恢复存储。已有 ticket 不自动改造，迁移后的 Bot 仍遵守原登记与接管屏障。普通 Task/Test 不启用这一存储。

适配器保留冻结 `nativeHome`、`CODEX_HOME` 与当前配置、认证及工具发现来源，不复制凭据或整个用户 home。已验证版本为 Codex 0.169.0；新线程显式请求 `historyMode=legacy`，并仅在首次创建后以 `thread/name/set` 命名为 `Daynight assistant`，使空 rollout 落盘而不发送业务输入；恢复保留原名字，拒绝 paginated 历史及未验证版本。单 rollout 保存原线程与 compact 上下文；子线程、fork、外部媒体或未知记录依赖不属于已验证闭包，发现后报告具体原因并保留旧点，不能标记完整保护。内嵌图片字节随原文件校验。

启动、resume、输入、steer、compact 和设置变更在原生派发前持久标记 `dirty`。完成轮次后暂停新派发，以流式复制检查完整 UTF-8/JSONL、原线程与 cwd、CLI 版本、目标 `task_complete` 或已确认中断的 `turn_aborted` 及复制前后的文件身份和大小。半写或尚未落盘的完成记录在有界时间内等待；非法身份或格式立即失败。副本同步到磁盘后，以原子 manifest 发布摘要、字节数、`recoveryFormatVersion=1` 与 `protectedThroughTurn`。确认空闲设置还须覆盖本次派发之后的 `thread_settings_applied`；RPC 成功本身不替代落盘证据。原生设置确认与恢复保护是两个独立结果：已确认的设置不因副本发布失败而回滚；保护失败须独立上报致命错误并停止 Provider，保留 dirty 屏障，不能被先前的设置成功回执掩盖。只有空线程使用 null 水位。

manifest 完成发布（包括支持平台上的目录同步）后才进入内存中的持久状态缓存。发布失败会冻结该恢复实例，后续派发前标记、恢复和保护操作均拒绝，不能将已可见但未确认持久化的 `dirty` 当作下次派发的屏障。失败时磁盘 manifest 可能已被替换，因此不宣称回滚，也不删除归属尚未确认的快照。

恢复先要求原执行停证与 Controller 存储归属，再核对完整点及相同原生 ID。适配器将不可变快照复制成独立活动文件，向 `thread/resume` 传原 ID 和活动路径，并核对返回 ID、真实 cwd 与实际路径。恢复本身也追加原生材料，不能直接改写唯一快照。结果未知或仍为 `dirty` 时报告 `outcome_unknown`，禁止自动退回旧点或重发旧输入。恢复成功后继续保护活动文件；已发布新点后释放前一点，旧活动文件仅在原 writer 已停止的恢复阶段释放。

Bot 删除在停证之后将同一派生恢复目录纳入既有精确删除计划，保留删除回执和共享 native home。该机制不单独启用完整 `botRecoveryVersion=1`，不证明跨版本、跨机、独立 Worker 接管或所有 Provider 功能恢复。历史越长，复制成本越高；单记录超过 32 MiB 明确失败，不截断恢复材料。取舍见[恢复点决策](../../.agents/notes/implemented/architecture/2026-11-19-codex-bot-recovery-points.md)。

## Claude 原生恢复点

新建专属存储的 Claude Bot 通过 `claudeBotRecovery` 绑定 Bot ID 与 `bots/<botId>/native/claude/`，其中 `recovery.sqlite` 保存原生镜像、身份、摘要和受保护轮次。已有 ticket、普通 Task/Test 不自动启用该模式。Worker 校验由原配置根派生的位置，Controller 保留原服务、owner、Bot、Session、cwd 和 `nativeHome`。删除 Bot 时回收私有镜像，共享 Claude 配置与工作区保留。

已验证组合是 SDK 0.3.247 与其默认 CLI 2.1.247。SDK 的 `sessionStore.append` 接收本地写入成功后的原生记录，成功 result 发布前等待镜像 flush。存储通过 SQLite 事务、DELETE 日志的 EXTRA 同步、UUID 更新和内容摘要保留镜像；EXTRA 在提交删除日志后同步目录，防止断电使已派发操作之前的 dirty 提交回退；第一次写入失败锁存错误，SDK 重试或后续 result 不能清除失败。跨 helper 的镜像传输按有界分片传递，单批上限 32 MiB，超限明确失败。

启动、恢复、输入和设置派发前持久标记 dirty；成功轮次须有原输入 UUID 与后续助手记录，镜像保护完成后才报告轮次完成和空闲。错误、中断、镜像失败和未知结果保留 dirty，禁止从旧点自动重放。设置超时或其它未确认失败会锁存错误，禁止后续原生派发和保护，即使底层设置随后返回也不能解除；空闲设置确认仍需下一成功轮次保护；启动或恢复后尚无成功轮次时仍保留 dirty；没有保护轮次的空会话不能用新会话代替恢复。为避免一个结果误清除另一轮次的未完成状态，该模式不接收运行中追加输入；图片在派发前拒绝。compact、子 Agent 和根 transcript 以外的原生资源没有已验证恢复闭包，遇到对应记录时明确拒绝保护。账号的工具配置继续按原来源解析。

恢复先核对原执行停证及专属存储归属，再检查格式、版本、原生 ID、cwd 和镜像摘要。原 transcript 缺失时，同步临时文件并通过不覆盖目标的原子发布重建原路径；已有文件须与镜像一致，否则保留文件并报错。`CLAUDE_CONFIG_DIR` 保持原目录，SDK 通过 `extraArgs.resume` 传入原 ID，避免 SDK 自带的 store load 将配置改到临时目录；意外调用 load 明确拒绝。此版本相关行为由真实 SDK 参数和 flush 回归验证，实际 runtime profile 不匹配时拒绝后续业务输入。

该机制不恢复一般 Claude 支持承诺；初始化断连清理仍受现有暂停声明约束。方案取舍和扩展条件见 [Claude 恢复决策](../../.agents/notes/implemented/architecture/2026-11-19-claude-bot-recovery-points.md)。

## Copilot 原生恢复点

新建专属存储的 Copilot Bot 使用 `copilotBotRecovery` 绑定 `bots/<botId>/native/copilot/`。`recovery.sqlite` 保存服务域、账号、Bot、平台 Session、原生 ID、真实 cwd、原生配置根、版本、dirty 屏障和最后受保护轮次；`snapshots/<id>/` 保存独立的原生目录快照。旧 ticket、普通 Task/Test 保留原行为。Bot 删除计划包含该私有目录，共享 `COPILOT_HOME` 和工作区不在删除集合中。

适配组合限定为 SDK 1.0.11 与实际 CLI 1.0.105。Provider 保持原配置目录及 hooks，核对 `metadata.snapshot().workspacePath` 与原生 Session 目录一致。启动、恢复、输入和设置派发之前，通过 DELETE 日志与 EXTRA 同步持久提交 dirty。成功轮次等待完整会话的 `session.idle`，不以仍可有后台工作的 `assistant.idle` 作为保护信号；随后确认原生输入 ID，检查 processing、activity、后台任务和输入队列，再调用 `sessions.save` 等待原生待写数据落盘并重查空闲。保护期间保留当前轮次，禁止新的输入、设置和取消；快照提交后才报告完成并开放下一轮。发送、设置或保护结果未知时断开执行并保留证据，不以迟到结果自动恢复准入。

快照复制前后对整个目标目录枚举并校验摘要，SQLite 使用在线 backup 包含已提交 WAL；原生执行锁不属于恢复数据。快照须包含原输入、助手完成记录及全部工具结果，提交前再次核对当前执行仍有效；发生变化、材料损坏或未验证的 compact、子 Agent、autopilot 等记录时拒绝保护。新快照同步完成后才原子提交 manifest；旧点清理失败单独报告已提交结果。运行中追加输入被拒绝，避免一个完成事件替另一项未完成输入清除 dirty。空闲设置变更仍需后续成功轮次提供保护边界。

恢复要求原执行已停止且 Bot 归属仍匹配，再验证版本、文件摘要和事件闭包。原目录存在时不覆盖，只接受与快照一致的内容及已识别的 `session.shutdown` 尾部；任何其它更新均保留并明确拒绝。原目录缺失时独占创建目录并逐文件不覆盖发布，完整校验之后才启动原生 resume。该发布不是跨平台单次目录 rename；中断留下的部分目录会阻止启动，并保留私有快照供核对。该能力不单独启用完整 `botRecoveryVersion=1`，不证明跨机恢复、独立 Worker 接管或工作区备份。取舍及扩展条件见 [Copilot 恢复决策](../../.agents/notes/implemented/architecture/2026-11-19-copilot-bot-recovery-points.md)。

## 原会话恢复

对已提交执行，先用原 ticket 观察 Controller。可观察且仍在 starting、ready 或 working 的执行继续复用，并撤销先前未完成停机的来源标记，避免后来异常退出获得正常重启豁免；无法观察时读取同一 journal 和持久进程证据。恢复路径不为了获得停证主动杀死一个可能存活的 writer。`confirmControllerProcessesStopped` 核对原进程实例及所属进程组或 Windows Job Object，随后通过 journal 的停证写入和 snapshot CAS 固定原 generation 已停止。Windows 复核以出生身份绑定的原进程句柄完成状态为依据；未 signaled 的退出过渡仍不能确认 stopped，ESRCH 和变化的退出码均不能代替完成观察。仍运行的同出生实例若命令行哈希、父 PID 或 process group 冲突，先报告身份不确定并保留原责任，停止确认不能以 Job 查询代替该实例的完整停证。缺失证明或 native ID 时保留责任并报告，不能新建空白会话。

`beginRecovery` 将正常关停与异常恢复区分。`markShutdown` 只从停止前新鲜、健康的认证观察建立 `restartAfterShutdown`，既有阻止原因不允许该标记覆盖。异常换代递增 `recoveryCount`，正常来源且 stopped snapshot 没有 error 时不递增；两条路径均不重置此前异常次数。达到预算的健康执行仍可正常停止和恢复，异常停止则持久阻止继续恢复。

新目标写入后重新验证 CLI owner/server 和运行环境，恢复 ticket 沿用前代 native home，固定 `resumeNativeSessionId`，保持 `initialInput: "none"`。同一 journal 继续持有旧操作及回执；不会因重启再调用旧用户操作。旧 ticket 和各代别名目录保留为精确清理输入。

grant 接收持久前代的 generation、Controller instance、recordId 和 stoppedAt。客户端先检查直接相邻代、不同 instance、已知 native ID 和完整停证，再读取服务端原 Session。服务端仍是精确前代时，提交 `previousGeneration` 和 stopProof；已是目标代时，只提交目标 fence 的 reconnect grant。未知响应不改变目标身份；其它代、instance 或 native ID 一律拒绝，服务端仍执行版本、权限和 fence 检查。

## 发现、授权维护与退出

`createManagedAssistantRuntime` 提供单轮 `tick`、持续 `run` 和显式 `shutdown`，构造时必须传入 `deletion: BotDeletionManager`。持续发现为每个 Bot 调度一项独立工作：活动定义进入执行管理，删除投影进入 `deletion.advance`；同 Bot 已有在途工作时不重复调度。发现循环不等待慢启动或清理完成，因此其它 Bot 仍可被发现。删除失败经 `onError` 返回并保留责任，下次权威对账后继续推进；它不转成启动失败报告。每次启动及结果报告读取权威单项；清单失败保持旧库存但不启动陈旧定义或执行删除。

通用 `maintainControllerGrants` 同时供 Task 和 Bot 使用，按执行隔离错误并抑制重复诊断；每个执行最多一个在途刷新，慢执行不延迟其它执行下一轮调度。Bot 的维护循环与发现循环并行运行，续期前检查当前绑定和凭据有效期，在相同 generation 下更新私有凭据文件。

取消 `run` 或显式 `shutdown` 先关闭调度并取消在途管理操作，等待发现、续期和启动 job 全部结束，再对本地责任清单中每个 Bot 进行有界停止。停止不依赖远端可用性，按原 ticket 尝试 IPC stop，并通过原进程证明停止进程树；IPC 回执或 timeout 单独不决定结果。恢复子进程可能已提交，而共享 journal 尚未替换前代 snapshot；此时不把前代 snapshot 当作当前原生进程证据，仍依据父进程已保存的当前子进程出生证明尝试停止。当前代 journal 停证缺失仍报告失败并保留责任，不能借前代已停止状态宣称完成。OS 确认与 journal 停证完成后才返回成功，不调用 StopTest、归档、cleanup prompt 或删除接口。每个 Bot 独立完成停止尝试，全部错误一并交给调用方；stores 与 Worker 实例锁必须保留到这些尝试完成。

Windows Job 终止是异步的。`stopControllerProcesses` 在原 Job lease 下先固定全部已知原 Controller/native 出生实例的进程句柄，再请求 Job 终止；同一 Job 成员清单为空且这些原句柄已 signaled，才能完成停止。成员先消失、退出码变化或 ESRCH 均不足以证明完成。已在退出的原实例继续沿同一句柄等待，不重新要求退出中的命令行；不同出生实例不会收到信号，未知状态或运行中的完整身份冲突继续失败。所有操作和等待共享调用方的原绝对 deadline，不按句柄或轮询重算；已开始的 native 调用须结束，因此不承诺 kernel 抢占式的总 wall-clock 上界。到期、未确认的权限、查询、wait 或关闭错误均保留失败、执行资料与删除责任，逐一释放已取得的进程句柄并保留同时发生的主要和关闭错误。完整机制由[Session 设计](task-session-protocol.md#关闭与清理)及[原进程退出决策](../../.agents/notes/implemented/bug-fix/2026-11-13-windows-controller-exit-completion.md)拥有。

`shutdownWorkerExecutions` 汇总 Task 和 Bot 的执行所有者，等待每项停止尝试并保留失败。Task 退出仍由 coordinator 和原 backend 完成，不把 Bot 停机规则注入 Task 归档及容量逻辑。正式 `runWorker` 接入 Bot 执行所有者和 `assistantHost` 广告，保持 stores 与实例锁直到管理循环和所有停止尝试结束。

## 精确删除与失败保留

`bots/delete.ts` 的 `createBotDeletion.advance` 先读取原 Bot 的权威删除投影，再通过 `createBotProcess.withDeletion` 与同 Bot 的启动、续期和停止共用串行化。删除意图先阻止新的生命周期动作；已提交 child 的 process proof、当前代 snapshot 和失败证据仍可写回，以便删除能停止已经存在的 writer。回调只有在取得原 Bot 删除身份后执行，不能用陈旧记录跨过新的执行意图。

首次清理调用同锁内的停止函数，复用原 ticket、认证 IPC 和 OS 进程树停证。已提交执行的当前代 journal 停证提供 receipt 所需的 sessionId、testExecutionId、generation、Controller identity、recordId 和 stoppedAt；IPC 已回执但进程仍活时不进入文件删除。已经确认 sessionId、未提交或被 OS 明确拒绝且没有进程或 snapshot 证据的首次执行可以使用 `never_started`。存在持久 intent 但 sessionId 未确认时，注册可能已经提交，删除保留原注册身份并报错；恢复目标尚未提交而远端可能仍在前代或已换代时同样保留责任，不猜测远端 fence。

停止完成后，`prepareDeletion` 在该 Bot 的权威 SQLite 中保存停证、文件计划、清理进度和固定完成回执所需的身份。专属 `store.sqlite` 与锁位于待删 Controller 执行目录之外，删除后保留最小责任；未迁移记录继续使用 Worker SQLite。重试优先读取该责任，不要求已删除的 journal 再次生成 stopProof。`delete-files.ts` 根据原 intent、执行记录保存的历史 launch/别名归属和配置根捕获文件计划，不接收远端提供的任意删除路径。执行目录只能是原存储根下的 `controller/executions/<executionId>`，ticket 由各 `launchId` 重新推导；存在的正式 ticket 还须解析并核对账号、服务、独立执行、Session、Controller 和代际归属。当前与保留 launch 的 `<launchId>.json.<uuid>.tmp` 也进入计划，其中临时 UUID 必须规范，不能据此扩大到 launch 目录的其它文件。IPC 使用原端点规则处理长路径下的 Unix socket；Windows pipe 不当作磁盘目录递归删除。

目录清理复用受限物理目录遍历和 inode 校验，拒绝符号链接、Git 元数据和替换后的目标。计划同时检查冻结 cwd、各正式 ticket 的 cwd 与 native home，拒绝把这些目录本身或包含它们的目录作为删除目标；检查包括原路径与物理解析路径。单个 ticket、临时文件与 socket 按原文件身份删除。POSIX execution 目录删除后，核对并同步原捕获的父目录，成功后才允许 `completeDeletionTarget` 持久保存该项目进度；重试时原 execution 已不存在也须完成该同步。此耐久性屏障独立于已撤销的媒体账本，打开、同步或关闭失败均保留原删除责任。再次处理同一 `deletionId` 时跳过已经完成的目标，不能因为旧路径被新文件占用而重复清理。journal 所在执行目录排在其它私有目标之后。文件或权限错误保留未完成目标和停证，不删除普通 cwd、native home、Task 或 worktree，也不调用 cleanup prompt、StopTest 或归档上传。

无持久 intent 时仍可由配置根和 Bot ID 精确定位 `bots/<botId>/state`，其认领与通知状态进入删除计划；其他执行文件没有可供跨重启定位的计划。当前进程仍持有的 preflight 清理句柄可以重试释放探针与别名；Worker 崩溃前未登记的孤立 preflight 别名目录不保证被发现。该边界不影响已持久登记的执行资料按原身份完成删除，也不把共享别名根扫描变成 Bot 清理权限。

所有本地目标完成后，`finishDeletion` 原子裁剪库存定义、角色和执行资料，只留下删除投影及不含对话正文的责任。`completeDeletion` 提交原 `{deletionId, stop, result}`；本地现存 intent 可校验完整 fence，裁剪后使用持久 receipt 保持完全相同的请求。停止失败报告 `execution_stop_unproven`，文件清理失败报告 `private_cleanup_failed`，失败报告自身不确定时一并保留原错误。服务端响应必须确认相同删除身份和 workerCleanup 结果，serverCleanup 仍可为 pending 或 failed。客户端不把传输失败解释为拒绝，也不自动重复 POST；下一轮先读取原删除状态，再决定是否提交相同回执。服务端的 admission barrier、回执 digest 与历史清理机制由[助手设计](assistant.md)拥有。

## 助手任务维护

`createWorkerBotHost` 装配 `assistant-tasks.ts`，由 `createManagedAssistantRuntime` 同时启动和停止。助手及其助手任务不计入项目 Task 的 `maxConcurrent`。四个独立循环每 60 秒启动一轮，使用可注入的时钟；同一循环不重入，各 Bot 独立处理失败。网络请求有单次和操作预算；事件分页每页使用独立预算，避免合法历史累计超过一次操作的字节上限。慢请求不通过重叠执行追赶周期。它不包含 Watchdog 评估器。

每个助手的 `DAYNIGHT_BOT_ID` 为自身 ID，`DAYNIGHT_BOT_STATE_DIR` 固定为 Worker 配置根下 `bots/<botId>/state`。目录沿用私有文件机制的归属、权限及符号链接检查；普通停止和恢复保留状态。认领与 CLI 共用[私有状态和锁](assistant-task-cli.md)，不另外保存或轮换令牌。同一进程内按 Bot 和任务串行协调各循环的认领读写，避免固定同拍的续约与触发反复争抢非阻塞文件锁；跨进程仍由原文件锁保护。应用启动、停止及其业务动作不持有这个本进程队列，避免取消与凭据读取互相等待。每轮先查询原待核对操作，再根据权威任务决定续约。原回执缺失不会直接清除意图或重发：共享认领状态机重新读取权威代次，只有旧操作可能产生的代次已被超越或失效，才允许退役旧意图；同代有效认领仍保留未知结果。转交的 pending 认领先绑定本地生成的凭据，再续约。只有原 Controller 的新鲜认证观察显示 ready/working、启动成功且未停止或出错，才维护租约。暂停任务继续续约，但不启动应用或定时事件。

自动接手只选择健康的本机助手，对 `takeover=auto`、active 且 unowned/expired 的任务重读版本和代次后认领。服务端条件写入决定并发竞争结果。旧 holder 恢复时不会抢夺有效认领；服务端在过期接手或转交事务中生成新旧 holder 的通知，Worker 不重复创建系统事件。首次认领无人负责的任务没有历史空档，不产生接手事件。

`registerApplication(name, factory)` 在 runtime 启动前注册应用。factory 接收任务、Bot ID、取消 signal 和 `withClaim`；每项有外部影响的动作必须经 `withClaim` 重查健康状态、active 状态、原代次与私有凭据。续约确认后启动或保持应用，暂停、丢失认领、健康检查失败、租约期限或 Worker 停止会取消应用。异步续约、健康检查与 guard 绑定原 Bot、认领代次及应用实例；迟到失败只能取消该实例，不能按任务 ID 取消后继持有者的应用；迟到成功快照的认领代次低于当前应用时，不替换当前应用。等待旧应用退出后重新比较当前实例及代次，避免等待期间的新持有者被覆盖。factory 必须响应取消并等待其自有工作结束；停止会等待 factory 返回，不宣称忽略取消的应用已经退出。

删除路径先 `stopBot`，禁止该 Bot 新的维护工作，取消应用并等待已开始的维护写入结束，再进入原 Controller 停止和文件删除。这样私有状态被删除后不会被后台循环重新创建。Worker 总退出先停止助手任务维护，再停止 Controllers；前一步失败仍继续其余停止尝试并聚合错误。

## 通知与定时事件

事件循环按目标 Bot 和 pending 状态过滤，每页最多读取一个完整事件。任务和事件分页的单响应预算为 32 MiB：事件覆盖合法 1 MiB 输入的 JSON HTML 转义，任务还覆盖分次更新后多个大字段的组合。每页使用独立操作预算；单任务认领动作的累计预算为 256 MiB，覆盖同一动作中至多五次完整任务读取及精简认领回执，不随任务或事件历史总量累计。只有同步、在线、active、idle、没有当前回合且允许发送时，才将事件合为一条 `payload.origin=daynight` 的输入；提交前再次检查 Session fence 和空闲状态，不能 steer 正在工作的助手。通知包含事件类型、任务与事件 ID、事件时间、关键事实及读取手册和记录的 CLI 指引。接手通知要求助手说明从 `previousLeaseUntil` 到事件时间的租约空档；前者不早于后者时没有过期租约空档。历史事件时间不由当前认领时间替代，也不据租约推断助手实际停止工作的时间。大 payload 使用明确标识的摘要并保留完整事件读取指引；一批文本最多 512 KiB，积压超限时停止继续分页并保留后续事件，下一个空闲轮次继续。

`inbound` 事件与其他事件在同一批次中选择与确认，按[助手任务收件箱设计](assistant-task-inbox.md#worker-通知渲染)渲染：负载严格解码，无法解读时只给出读取原事件的命令；同一项目 Task 的 `daynight` 事件合并为一段，`external` 正文只投递围栏内的 4 KiB 预览；入站正文每批最多 32 KiB，超出的 `inbound` 事件按原顺序留在 pending，不阻塞同批其他事件。每批末尾按助手任务给出读取当前手册和附录的命令。

每批先持久化完整 Session 命令、固定 operation ID 和事件集合，再发送一次。accepted/offered/dispatching、unknown、运输中断及重启后都只查询原操作。只有 provider_accepted/confirmed 才确认事件；确认按意图中记录的任务与事件 ID 逐项直接 ACK，统一使用该批固定 operation ID，不分页读取 pending 事件，因此其他任务的待投递积压或投递后暂停的任务不会阻塞恢复；每次 ACK 使用独立有界操作。意图保留到全部事件结清，重试以原 operation ID 重放，服务端对已确认事件幂等返回；服务端明确答复事件已不在 pending、已删除或已由其他操作确认时视为结清。部分 ACK 成功或响应丢失不会再次发送 Session 输入。仅当没有 providerResult，且回执为服务端派发前的 rejected/permission_or_state_changed，或没有 error 的 expired 时，才清除该批意图并在下一空闲轮重新选择事件；该固定拒绝证明仅由服务端派发前的授权检查持久生成，普通 Controller 错误仍不落库；历史拒绝缺少证明时不补造证明。原生错误、failed 及其他未证明没有派发的终态保留原操作供核对。历史 generation 的结果仍沿原 Session 和操作身份读取。

通知与触发 journal 位于 Bot 私有状态内，按 origin 和 owner 隔离。manifest 以原子替换指向带 SHA-256 校验的分块内容；两组交替写入的分块各自最多 4 MiB，只有新组完整落盘后才切换。中途失败保留原完整意图，每个 journal 的内容存储上限为两组，不随每轮替换无限增长。Bot 删除时连同其他私有状态精确清理。

定时配置遵循[助手任务服务端](assistant-task.md)：interval 从任务创建时间按分钟计算，daily 使用 IANA 时区的本地日期与 HH:MM，每个本地日期最多一次，夏令时重复小时不重复触发。每轮只选择最近到期的一次，不回放离线期间的全部积压；暂停时不触发。事件 ID 由任务、配置和到期标识确定，跨重启或接手保持相同。本地 journal 已确认当前到期事件时不再扫描历史；否则逐页查找已存在的事件，找到即停止，再保存待核对意图；未知响应只读核对该事件，不重复 POST。同一到期事件已存在时，新的 holder 不重复生成它。

实现取舍见[维护循环决策](../../.agents/notes/implemented/architecture/2026-11-13-assistant-task-worker-runtime.md)。
