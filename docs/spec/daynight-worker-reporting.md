# Worker 运行快照上报

本文定义 `daynight worker run` 作为运行快照生产者的行为。[整体需求](daynight-worker.md)拥有执行与资源生命周期，[快照接口](daynight-worker-snapshots.md)拥有报告格式及服务端时间规则，[采集与调度设计](../design/daynight-worker-reporting.md)拥有客户端机制。[云端配置协议](daynight-worker-configuration.md)定义显式报告扩展，机器采集、任务引用和本页默认快照回执口径保持。

## 身份、范围与时机

Worker 复用已持久化的稳定 workerId、实例锁及启动时固定的认证账号。本地身份、认证和配置交换就绪后立即触发报告，随后每 30 秒独立触发；成功取得完整自有 claim 清单和确认新 claim 也触发报告。报告先于仓库与业务执行 backend 准备，不等待任务清单成功、候选查询、执行 tick 或原生任务结束。空项目、空闲、满并发、较大的 pollIntervalMs 和应用长操作均不停止定时报告。

报告在 Herdr 和 Web 执行模式中使用同一机制。采集 Herdr 版本只观察私有端点，不能启动 daemon、调用 ensureInstance、修复 integration 或初始化延迟的 Herdr 执行 backend。纯 Web Worker 无须安装或启动 Herdr。

CLI 将当前运行包的 version 及启动时捕获一次的绝对 workingDirectory 显式交给 runtime。磁盘只表示该目录所在文件系统；不使用任务 worktree、repositoryRoot、home 或系统根目录代替。上报没有独立公开命令或配置开关，也不修改任务、claim、凭据或执行资格。

当前调度与活动监控使用独立发送器，不改变本页的机器快照、配置交换或在线判定。其内容、30 秒周期、未知结果和停止语义由[运行监控合同](daynight-worker-monitoring.md)定义。

## 调度、期限与关停

同一进程最多进行一次报告尝试，并合并最多一个待执行触发。进行中的尝试结束后，待执行尝试重新采集；多个触发不积压报告正文。单次尝试总预算 15 秒，其中采集最多 5 秒、HTTP 最多 10 秒。探测命令的终止、进程树清理及输出流关闭等待计入采集预算。

配置协议报告的 UTF-8 JSON 正文最多 9 MiB，普通报告最多 1 MiB；可选工具和来源观测按所选额度裁剪，必需清单和配置结果不截断。编码超限在派发前失败。部署时须先让服务端及入口支持 9 MiB，再升级 Worker；旧服务或入口返回 413 表示容量或版本不匹配，不能视为配置成功。

报告遵循[快照](daynight-worker-snapshots.md#上报结构)和[配置](daynight-worker-configuration.md#应用观测)的字段、集合及完整资源预算。任务清单保持完整；配置模块保留本机全部当前与历史责任，按本批条数、存储和请求预算发送完整项的有界投影，不能删掉未确认事实或截断实际值来制造成功。投影预算与发送使用同一份实际机器采样及最新任务引用；游标和失败确认只依据匹配的接纳回执。失败后等待后续触发，以新的观测发送完整报告。HTTP 写入结果未知时不重放旧请求。服务端 active 名额拒绝 `409 active_worker_limit_exceeded` 是本次报告失败，不停止或驱逐本机执行；[快照协议](daynight-worker-snapshots.md#最新快照与时间)定义准入与时间边界。单个字段失败仍可上报其余字段；采集整体失败、传输失败、响应格式或 principal 校验失败使该次报告失败，不改变任务执行。

配置存储未就绪时，单轮报告在读取、采样和捕获之前先等待共享 readiness，不为同一阻塞继续排入新的读取或接收。十五秒 Operation 到期只取消该轮等待；manager 仍拥有已经收到的可信回执、冻结检查点及应用/停止结果。存储恢复后下一次触发使用当前事实；未持久化结果不报 applied，等待者结束不将已知远端成功改为未知，也不授权重放 POST。

退出分为取消与收尾两个阶段：根取消信号同步停止报告触发和 coordinator 调度，并中止全部运行中的 job，包括终止清理 job；这些动作必须在等待报告收尾之前完成。配置 manager 须在任何报告、初始化移除和完成结果的 join 之前进入 drain，再等待进行中的报告尝试、原 job 和 manager-owned 检查点，随后直接停止执行资源，最后关闭日志并释放实例锁。五秒窗口只停止后续存储重试调度，已开始的文件 I/O 必须真正结束；未保存结果携带原错与记录身份失败，不宣称五秒内或干净退出。等待报告期间，已选中的终止清理不能继续删除 worktree 或把未完成行置 done；未完成 claim、worktree、原生 session ID 及 active/pending 行保持既有退出保留语义。超时本身不能证明原生进程已退出；命令清理尚未确认期间保留原始错误，并禁止为该探测启动替代进程。确认与恢复遵守下述原生只读探测规则，其他字段及后续部分报告继续工作。

## 原生只读探测的清理与恢复

本节适用于 `assistantHost` 的 Provider 预检与 `versions` 的原生版本采集。历史上发生清理失败与当前清理是否仍未确认是两个独立事实：`HerdrCommandCleanupError` 等历史错误类别不能单独证明当前仍有清理责任，也不能因时间经过自动失效。每次清理确认必须关联原探测、原 child 及其输出流，只能解除该次探测留下的阻塞。

| 原探测的清理事实 | 必须保持的结果 |
|---|---|
| 仅等待 `close` 超时，终止操作未失败，原 child 及输出流尚未确认关闭 | 保持清理未确认；后续采集返回对应不可用结果，不启动替代探测 |
| 上述原 child 及输出流后来可靠地确认关闭 | 该次清理转为已确认；下一轮正常采集允许重新探测 |
| 只有 `exit`、仅进程 leader 消失，或没有原 child 及输出流关闭确认 | 仍未确认，不推断进程树及流已完成清理 |
| 终止调用失败，即使后来收到 `close` | 仍按清理未确认保守处理；晚到关闭不能消除终止失败 |
| 旧清理错误缺少可关联原探测的确认句柄 | 仍按未确认处理；不能用重建句柄或其它成功观测补证 |

确认前不得用超时重试、缓存过期或重新构造 collector 绕过原探测的清理责任。新 collector 探测成功、其它 Provider 成功、已有 Bot 的持久 `startupResult=ready` 和页面刷新均不能确认旧探测已清理。此规则只恢复只读探测，不重放用户输入、不替换 Session、不切换默认 Provider，也不改变任务或 Bot 的执行恢复规则。

`assistantHost` 与 `versions` 分别绑定各自的原探测。不同 Provider、不同采集轮次以及不同采集器的确认不能相互清除；旧轮次的晚到确认不能解除新轮次的阻塞。嵌套 `cause` 和 `AggregateError` 中的各项清理责任须独立判断，只要对应聚合中仍有未确认项，该探测就保持阻塞。一般聚合错误本身不等同于清理未确认；确认清理也不能吞掉聚合中其它错误。

显式组合 `versions` 与 `assistantHost` 时，相同 Codex PATH 调用共享替代探测屏障，并串行执行普通版本和助手完整版本/帮助链。共享范围是 executable 名称 `codex`、相同原始启动目录及实际交给 launcher 的 PATH（Windows 还含 PATHEXT）搜索输入；不同 executable、搜索输入、目录和其他 Provider 保持独立，不推断绝对路径或别名的文件身份。任一匹配链清理未确认时，后续普通版本不能复用旧成功或在缓存到期后重启，助手不能开始版本/帮助或声明可用。原清理可靠确认后，共享屏障只恢复重采资格；普通成功缓存自匹配清理失败时失效，不能因确认先于下轮采集而复用失败前的成功。

Windows bare Codex 探测先按 Node 字母序选择第一个大小写不敏感 PATH/PATHEXT 键，移除重复别名，以唯一大写键将同一选定环境交给 launcher 和 owner。native executable 保留 Node 原有搜索选择；shebang wrapper 不能因重复 PATH/Path 选择与清理匹配分离。其他 Provider、显式 executable 及非搜索环境键保留原值。

可靠确认只恢复重采资格，不发布成功结果。下一轮正常采集须绕过因该次清理未确认而保留的旧 `unavailable` 或失败缓存，实际执行探测；无需等待该缓存的剩余有效期。新探测成功后才能发布对应 `available` 或版本，并使用本次真实观测时间；失败则发布按实际错误映射的失败结果，不能回退到旧成功。助手结果仍须匹配当前有效配置，不能以旧配置探测结果或普通机器报告刷新 `assistantHost.observedAt`。

恢复遵守既有报告单飞、触发合并、采集预算、取消、配置时效与凭据隔离规则。晚到确认不直接触发后台探测，不延长采集或退出预算；根取消或 `reporter.stop()` 开始后，即使收到确认也不得再启动探测。取消路径必须等待已经启动的探测完成有界收尾，保留各自实际错误，不能因其中一项恢复而提前返回成功。

`reporter.stop()` 在完成既有报告与探测收尾后，按当时可确认的清理事实决定退出结果：仍未确认的清理责任及其它应传播的错误继续导致退出失败；已经可靠确认的历史清理等待超时不再单独构成当前清理未完成。混合聚合中的终止失败、无确认句柄的清理错误及其它独立错误仍须保留，不能因为一项确认就丢弃整个聚合。退出不为等待未来确认而无限延长，也不把尚未取得的确认写成成功。

确认状态与原始错误只留在进程内；公开 DTO、服务端创建准入和前端按钮判定保持既有契约。报告与诊断继续只输出规定的状态、有限错误码及清洗后的类别，不暴露确认句柄、命令、stdout/stderr、环境变量或凭据。

## 采集口径

每份报告包含 sampledAt；每项 Probe 包含 checkedAt。字段状态使用快照接口规定的 `ok`、`error`、`not_installed` 和 `not_running`，错误携带闭合 code，不用空值或旧成功伪装新结果。

| 字段 | 必须报告的事实 |
|---|---|
| OS | Node OS API 的 type、release、version、arch；系统及内核文本不推断为发行版名称 |
| CPU | 实际型号、逻辑处理器数及所有逻辑处理器累计计数的差分使用率；首次同样经过约 200 毫秒的两次真实采样，不伪造为 0，不推断物理核心数 |
| 内存 | totalmem 与 totalmem-freemem，单位为 bytes |
| 磁盘 | 启动目录文件系统的 `blocks*bsize` 总量和 `bavail*bsize` 可用量，单位为 bytes；可用量表示调用身份可用空间 |
| Daynight | 当前运行 CLI 包注入的版本 |
| Herdr | 当前 Worker 与服务所属私有 daemon 的只读 ping 版本；macOS 使用原始 run 身份验证后的端点，多个存活 daemon 必须版本一致；不确定或混合版本为 error/unavailable，确证无存活 daemon 为 not_running |
| Codex、Copilot | Worker 原生环境中纯 `--version` 的版本；仅确证 executable 不存在为 not_installed，权限、命令、输出或超时故障为 error |

资源计数必须是非负安全整数，容量关系和 CPU 差分必须有效。越界、未推进或不一致的采样明确失败，不使用截断值。磁盘计算先使用 bigint，再验证可精确表示范围。底层 statfs 无法取消；某次超时后最多保留一个未完成调用，之后的磁盘探测在其完成前报告 timeout，不继续排队 I/O 或追加等待监听。

Codex/Copilot 的成功、缺失及失败结果在进程内最多缓存 60 秒，并保留原 checkedAt；到期探测失败替换旧成功。清理未确认期间的替代探测禁令不随缓存到期解除；取得可靠清理确认后，按原生只读探测恢复规则绕过对应旧失败缓存。版本展示不执行启动 preflight 的最低版本或功能要求，已安装但版本较旧的 CLI 仍报告实际版本。Herdr 每次报告重新观察，不复用旧实例版本。

macOS 存在 durable journal 时，只读其原有格式，按当前 workerId 和 serverOrigin 选择执行记录；不迁移、恢复或修改 journal、claim 与控制状态，也不回退到遗留共享端点。忽略 stopped_confirmed run 与已确认退出的原始 daemon；stop_unknown 仍可报告经过验证的存活 daemon 版本，但不因此改变执行或停止结论。准备阶段已记录 daemon 身份时也观察它；已请求启动而尚无身份、进程身份未知或变化、端点被替换或仍存活进程的端点缺失均为 error/unavailable。每次 ping 前后核对端点的原始进程与 audit 身份；所有存活 daemon 的版本一致才为 ok。journal 读取、权限及协议错误保留字段错误。

非 macOS 平台以及尚无 durable journal 的遗留 macOS 安装保持原有共享端点探测：确证端点不存在或拒绝连接为 not_running，权限和协议错误为 error。无执行记录的纯 Web Worker 不创建 journal 或执行资源，也不加载原生进程观察器。所有等待沿用采集预算与取消；取消后不得继续后续身份或 RPC 观察。报告正文不包含 run 目录、claim 或进程身份、journal 内容及原始错误。

## 任务观测

报告复用 coordinator 的成功完整自有清单，不增加 inventory 请求或 SQLite 字段。清单只传不可变的 `{projectId,taskId,claimId}` 引用与原 observedAt，服务端提供权威标题、项目名、状态、阶段和 agent。

首次完整清单成功前为 `taskInventory:null`；成功观察到无任务为 `{observedAt,claims:[]}`。清单同步错误或项目不可用造成覆盖不完整时清除完整清单，继续报告 telemetry 和 `taskInventory:null`，不把失败解释为空闲；恢复全部项目覆盖后才再次发布完整清单。恢复清单不按 maxConcurrent 截断。

确认新 claim 后立即触发；已有完整观测时，按 taskId 将确认的引用加入该观测，并保留完整清单原 observedAt。完整观测尚未知时仍保持 null，新 claim 不构造未经完整同步的清单。

## 传输与诊断

客户端使用现有 typed ApiClient 和认证准入向 `POST /api/v1/me/workers/{workerId}/report` 发送完整报告，只接受 `200` 并验证既定账号。普通报告接受精确的 `{observedAt,lastReportedAt}`；配置客户端仅在该请求携带 `Daynight-Worker-Configuration: 1` 并使用完整扩展正文与回执，不能把能力标记加入 Task 或其他请求。在线状态由服务端最后有效机器报告时间决定，客户端 sampledAt、配置读取或定时器触发不能续活。

## 配置交换

配置报告共用“持久化就绪→权威/候选准备→新采样→不可变捕获→generation 检查→发送一次→接收并持久化回执”的顺序，foreground 与实际配置管理路径一致。prepare 完成后才采样，代次改变时丢弃旧样本并等待后续触发；正常已同步周期不增加 GET，未知结果、400/协议失败及能力重发现先认证读取。回执包含当前目标、观测 CAS 及是否接纳该份观测。接收目标和处理确认通过配置模块的同一提交 owner，实际应用在心跳之外运行，不能在报告内等待 preflight、仓库或停止操作。目标、实际值与应用观测的完整语义由[Worker 配置需求](daynight-worker.md#w-01前台运行配置与平台)与[配置协议](daynight-worker-configuration.md)持有。

捕获绑定本机 reportId、generation、精确基线、实际观察及 recordId/failureId。只有当前 generation 的匹配接纳确认该份已发送失败与游标；发送期间新增的失败以及被拒绝观测中的失败继续保留，报告前已恢复时仍携带 lastFailure。当前捕获被拒绝时采用回执完整规范状态，再生成最新报告；observation:null 对应的 false 是正常未提交观察。旧代回执不能改变当前目标、基线、失败或游标；响应未知不能确认失败或重放旧报告。配置读取、缓存与报告不依赖 taskInventory 已知或业务执行准备成功。

配置诊断区分 authority-read、bootstrap-prepare、telemetry-collect、observation-capture、report-send、receipt-accept、cache-persist，以及应用 validate、prepare、apply、stop。每轮 syncId 关联真实配置 key、本机 generation、reportId、recordId、原项 targetRevision、当前权威目标与观测基线，以及已取得的 HTTP requestId。请求关联仅来自实际 ApiError，优先保留合法 X-Request-ID；只有头缺席时才采用合法错误正文 ID，正文损坏不抹去已取得的头关联。不合法头与伪造对象均不进入关联字段，所选值遵守既有 64 字符安全格式。权威未读取、已读取但未初始化、有效初始观测基线 "0" 分别表达；不能用伪造的 0 或当前目标改写原项来源。

诊断只从实际 ToolSelectionError、OperationError、本地来源校验及受控文件边界取得固定原因和允许的 tool/context/stage/code；云端应用观测、运行监控及本地日志各自使用所属闭合词汇。缺工具、权限、超时、不兼容配置、无效输出和持久化错误保持可区分，非法 YAML、顶层结构或本地字段明确归为 invalid_configuration。取消与清理未确认保留原语义。任意对象的 .code、消息或未经验证的 cause 不能成为分类证据；不记录原生命令、stdout/stderr、环境变量、完整遥测或凭据，包括候选文件中刚修改的凭据。身份认证的 401/403 必须留下 authority-read 的终止失败及已有请求关联，本地原因分别为 authentication_required/permission_denied，保持原拒绝与重试规则。

远端请求尚未派发为 remote=not_sent，可信响应确认结果为 confirmed，明确拒绝为 rejected，派发后未获可信响应为 unknown。配置 POST 在 ApiClient 排队期间取消、尚未调用传输时保持 not_sent；GET 不能仅从没有未确认变更标记推断未派发。source 保留操作捕获的本机状态，received 单独保留可信 GET/回执已返回的目标与观测基线；不能在本机落盘前把较低的服务版本冒充已提交本机状态。observationAccepted 保留实际布尔值，可信 HTTP 200 的 false 仍为报告结果已确认，不能解释为应用确认。cache-persist 的 storagePhase 区分 read、directory、persist。已确认远端但检查点仍等待持久化时保留 remote=confirmed/local=pending，旧代回执被忽略时记录 local=ignored；不能把本地等待超时、formatter 或通知失败改写成远端未知、重放依据或 lastFailure 确认。持久化成功后才能记录 local=persisted。

首次失败、原因或相关目标变化，以及真实恢复立即记录。同因故障在现有周期中每五分钟最多输出一次摘要，包含本次运行中实际发生次数；退避档位单列为 backoffStep，不能冒充次数。分组按组件、实际阶段、key、固定原因和相关目标判断；原生相关目标包含当次 native 元组、实际模式与相关工具的配置选择，同规范版本的模式/选择变化仍须区分，只有匹配配方的成功才能记录恢复。requestId、syncId、generation、selectionKey、时间、次数与 nextAttemptAt 不使同因故障分裂，内部比较配方不进入日志正文。采集字段和普通传输继续分别报告故障及恢复。诊断失败保留独立错误链，不改变应用、确认、重试或恢复职责；日志不参与跨进程恢复。

## 工具路径事实

可选工具快照只消费运行管理器给出的同一份目标、actual、candidate 和 activeSelections，遵守[工具路径观察](daynight-worker-snapshots.md#工具路径观察)的严格结构、能力与预算。未接入事实来源时省略扩展，不能从裸命令版本或已保存目标制造 applied。工具采集不得在普通心跳内重新解析文件或另起探测；超限必须明确 report_budget_exceeded 或运行集合不完整，并保持普通心跳可发送。实际工具失败、原执行身份未知和报告不完整分别表达。

## 验证

调度验证覆盖即时报告、独立周期、空项目、长 tick、空闲与满并发、合并触发、单飞、取消和关停。配置交换验证覆盖发送快照与回执关联、观测 CAS 拒绝、报告前恢复、飞行期间新失败、迟到目标与应用结果，以及项目长操作和任务清单失败时的持续报告。

配置应用、报告发送与 coordinator 初始化分别以自身完成事件验证。延后执行 backend 初始化时，仍须观察三个数值标量与 preferPlatformSpecificTasks 布尔标量的实际应用结果、不可用 native 元组的清洗后错误，以及持续的配置报告；释放初始化等待后，再观察唯一 coordinator 使用已应用标量并保持不可用的 native 配置。同一目标的 native 重试成功后，验证原 coordinator 接收恢复值，随后报告真实应用结果。重试使用受控时间推进既有退避期限，异步断言只等待观测，不能在断言重试中反复推进报告定时器。

关停验证须延后报告的 join，确认根取消已同步停止调度并中止全部 job，终止清理不能在此等待期间删除 worktree 或完成本机行。清单验证覆盖初始未知、真实空清单、部分读取失败、超并发恢复及新 claim。采集验证覆盖首次 CPU、单位与安全整数、启动目录磁盘、未完成 statfs、版本缓存和过旧已安装版本。

原生只读探测验证须观察同一采集器跨轮次的实际命令调用次数、结果与时间，而非仅检查错误类别：

- 原探测清理未确认时，连续触发与缓存到期均不增加对应替代进程；其它字段和 Provider 仍可报告。
- 终止未失败且仅等待 `close` 超时的原探测，晚到 child 与输出流关闭确认后，在下一轮正常采集恢复一次探测；即使旧失败缓存尚未到期也须重采。分别验证成功发布新可用性或版本、失败发布实际错误，以及不复用旧成功。
- 仅 `exit`、仅 leader 消失、终止失败后晚到 `close`、无原确认句柄的旧错误均不解除阻塞；时间经过、新 collector 成功、其它 Provider 成功与旧 Bot ready 不能补证。
- 分别验证 `assistantHost` 与 `versions`、不同 Provider 和不同轮次的隔离，以及嵌套 `cause`、多个清理错误与混合 `AggregateError`：局部确认保留其余阻塞，全部清理确认不吞掉独立错误。
- 覆盖确认与取消、`reporter.stop()` 的交错；取消后不产生新进程，已启动探测完成有界收尾。只有已确认历史清理超时时，stop 不再因此失败；存在未确认清理、终止失败或其它应传播错误时，stop 仍保留真实失败。
- 恢复期间验证预算、单飞、配置变更与结果时效、凭据隔离和诊断清洗；报告不泄漏原始错误或确认句柄。

组合验证经实际 Bot host 包装与 telemetry 采集，覆盖双向清理失败、助手版本/帮助阶段、普通成功缓存失效及过期、可靠确认先于下一轮采集、整条匹配链串行、queued cancellation 和关停 join；原始错误对象保持，可靠 late-close 只解除自己的阻塞。不同搜索输入、目录、显式 executable 和其它 Provider 保持独立。Windows 验证用锁定 launcher 源码及全 fake filesystem/process，覆盖 PATH/Path、PATHEXT/Pathext 的 native 与 shebang 选择，并检查生产组合实际传递一致捕获环境。

受控命令或内存复现只证明上述分支与清理确认规则，不证明真实 Worker 已恢复或助手创建、启动成功。现场首次超时原因与原进程实际退出时刻须有各自证据；新采集器成功不能补足旧进程证据，也不能据此承诺刷新页面恢复旧 Worker。

Herdr 验证覆盖实际 per-run 路径、零存活 run、多 run 同版本与混合版本、原始身份退出和替换、已确认停止、stop_unknown、准备阶段、损坏或旧 journal、端点身份变化、权限与协议故障，以及采集期限和取消；同时证明原始控制记录未变、旧平台和纯 Web 保持只读延迟边界，私有证据不进入报告。

实际平台采集验证使用真实 OS、CPU、内存、statfs 及原生版本命令，分别记录 Linux、macOS ARM64、Windows 的环境与状态。fixture 证明分支行为，不能代替实际平台结果；完整原生执行、恢复与业务交付仍遵守整体 Worker 验收边界。
