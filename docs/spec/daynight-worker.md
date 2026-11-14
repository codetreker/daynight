# Worker 需求

本文定义 `daynight worker run` 的行为与可观察验收条件。[整体架构](../design/daynight-worker.md)拥有运行机制，[认领架构](../design/daynight-worker-claims.md)拥有服务端归属协议。账号级运行快照的服务端契约由[快照需求](daynight-worker-snapshots.md)拥有，客户端采集与持续报告由[上报需求](daynight-worker-reporting.md)拥有；在线状态和近期可见性不参与 claim 资格、执行控制或本机恢复。命令可用性与组件验证不替代 Linux、macOS ARM64、Windows 的完整原生运行验收。

## 目标与范围

Worker 是前台常驻进程，通过进程内 typed ApiClient 和 REST API 领取配置仓库中允许 Agent 执行的 ready task，在系统管理的 Git worktree 中按冻结的 herdr/web 模式运行 Copilot、Codex 或 Claude。服务端拥有资格、权限、唯一 claim 和完成操作；worker 拥有调度、资源、对账和清理；agent 拥有业务交付、验收、证据及最后一次 claim-bound done。

Worker 必须采用状态驱动的 reconciliation。期望归属来自服务端完整自有 claim 清单，实际资源状态分别来自 Herdr、Controller journal、操作系统、Git 和文件系统；归档完成来自服务端回执。本机主索引承担项目映射、认领、模式、原生会话身份和新 claim 的原生配置冻结，清理记录只保存资源身份、控制意图、期限和重试策略，不能用操作完成标记替代重新观察。macOS Herdr 另以独立持久 journal 保存原运行、输入准入、Session 连接与停止证据；[Herdr 生命周期设计](../design/herdr-worker-lifecycle.md)拥有该机制。Linux/Windows Herdr 的执行计时与业务输入观察保留在进程内；Web 保留执行配置、恢复预算和原生操作身份，并从 Controller 拥有的回执与进程实例证明读取原生事实，以满足[Task Session 需求](task-sessions.md)的未知结果不重放及单 writer 要求。

独立 Bot 的本地库存与启动意图由[Bot 库存需求](worker-bot-inventory.md)拥有，使用相同 Worker 锁和 SQLite 格式，不参与 Task 容量计算。[Bot 运行需求](worker-bot-runtime.md)拥有原会话恢复和退出停证：取消管理工作后逐项停止并汇总错误，保留 Bot、原 Session 和私有恢复资料，不调用 StopTest 或归档作为退出前置。正式 `runWorker` Bot 调度与能力广告尚未启用。

## 本地模型与推理强度覆盖

`worker.agentModel` 与 `worker.agentReasoningEffort` 独立可选，仅接受非空且不含控制字符的字符串，长度分别最多 256、64 个 UTF-8 字节。null、空串与错误类型明确拒绝，并指导删除字段恢复继承。旧 `worker.model` 保留首次导入语义；同层旧非空值与 agentModel 相同可用、不同拒绝，旧 model:null 不阻止新值。

每项优先级为本地新字段明确值、当前云端有效同项值、Agent 原生配置。已登记云端目标仍应用本地覆盖；移除字段后重新启动 Worker 恢复下层有效值。其它云端托管项的权威保持。新字段不能导入或回写到云端 desired，来源报告必须与云端目标分开。

规范化现有模型和 effort 参数后只生成一个最终值：本地字段优先，云端 model 字段优先于同项 args，重复参数按原参数顺序取得最后值再规范化。按当前有效 Provider 校验，Web 使用对应 SDK/RPC，Herdr 使用对应原生参数；不改 Agent 配置文件。设置任一本地新字段时，最终明确设置的模型/effort 必须在实际首次启动上下文核验；未知、无能力或不支持组合明确失败，不能猜测或静默降级。Daynight 未配置的项保持原生默认。

新 claim 的原生 Agent/model/args 在首次登记或旧无会话记录的首次启动前持久冻结，Web 与 Herdr 重启恢复不能以当前默认覆盖。历史记录没有已知冻结配置时不能伪造旧值；已有原生 Session 的恢复省略 model/effort 覆盖，保留原生会话状态。既有助手使用原冻结配置，后续本地变化只影响新执行。

机器遥测 `runtimeConfiguration` schemaVersion=1 独立报告全局 native 和逐 Project native 的 model/effort 值及 local/cloud/native 来源。null 与 native 来源表示交由原生解析，不证明实际原生模型。不可用配置用 native:null 表示；移除本地覆盖后的新报告必须更新来源。旧客户端省略该对象仍合法，新对象要求支持其格式的服务端。

## 本地工具路径解析

`worker.toolPaths` 是可省略的 mapping，仅允许 `codex`、`copilot`、`herdr` 三项。省略整个 mapping、缺少某项或某项为 YAML null 时，该项选择自动；空串、纯空白、错误类型、未知工具名及整个 mapping 为 null 均拒绝。两个本地配置入口必须输出完整三项 `ToolPathChoice`，每项为 `{kind:"auto"}` 或 `{kind:"path",path:string}`。

显式值必须是 Worker 所在平台的绝对文件路径，每项最多 4096 个 UTF-8 字节，必须是合法 Unicode，且不含 NUL 或其它控制字符。Windows 路径必须带盘符或完整 UNC share，不能依赖当前盘符。路径中的合法空格、Unicode 和标点逐字保留，不 trim、不规范化、不展开 `~` 或环境变量、不拆分参数、不执行 shell。整个字符串作为一个文件路径，原生参数继续由既有参数配置拥有；文件存在性、可执行性、入口格式和解释器属于工具解析器的检查。

本地配置识别和共享解析器是独立的基础能力。云端配置通过独立工具能力协商交换三态目标和逐项首次导入，合同由[配置协议](daynight-worker-configuration.md#工具路径三态)拥有。Task、Bot 的 Web Codex/Copilot 及 Herdr 模式的 Codex/Copilot/Herdr 运行入口和版本/能力探测消费同一冻结选择；保存或解析成功不得报告为路径已应用，不改变既有执行的工具选择。独立 Controller、Claude 和 Agent 内部 CLI aliases 保持各自既有配置归属。

共享解析器只解析给定选择，显式路径失败不回退其它安装。自动 Codex、Herdr 从捕获的 Worker PATH 查找；自动 Copilot 的 Web 上下文选择随包 native，Herdr 上下文从捕获的 PATH 查找。Herdr 工具仅接受 Herdr 上下文。Node 脚本固定使用 Worker Node，不能因入口位于 nvm 目录便切换解释器。npm shim 从有界快照提取 Node 目标，不执行 shell 文本；注释和无害格式变化不得仅因内容未登记而拒绝。Codex JavaScript loader 作为普通 Node 入口运行，由 loader 选择 native，不按发行摘要或固定 native 布局准入。

解析结果保留入口、真实路径、工具程序、解释器、结构化命令和参与文件的内容身份。冻结 recipe 按其记录核验，不重新读取当前配置或搜索 PATH；记录的入口映射或文件内容改变时明确失败。新执行候选校验发现身份改变时，同次调用先确认旧探针清理，再按当前选择重新解析和探测；清理未确认时不得启动新探针。已有执行仍使用原冻结 recipe 和进程身份。命令构建返回 `file` 和独立 `args`，不能交给 shell。解析、核验和刷新受 operation 预算及取消约束；版本、协议、认证和真实会话可用性需要运行消费者独立验证。

## 必须满足的行为

### W-01：前台运行、配置与平台

- `daynight worker run` 在前台运行，支持 Linux、Windows 和 Apple Silicon（ARM64）macOS，不支持 Intel macOS，遵守[客户端平台要求](daynight.md#c1-包与平台)。实际平台枚举仍为 windows/linux/macos；WSL Linux 计为 linux，未知平台明确拒绝。
- 云端目标管理 maxConcurrent、pollIntervalMs、recoveryLimit、preferPlatformSpecificTasks、agentControlMode、项目选择及全局/项目级 Agent、model、args；repositoryRoot、本机路径、服务连接与凭据、workerId 以及可选 agentModel/agentReasoningEffort 留在本地。mode 本地值仅用于首次采纳、未接入和旧服务兼容。[配置协议](daynight-worker-configuration.md)拥有目标版本、逐项观测及服务端权限。配置接入不查询或限制 active claim，不改变 Task/claim 的字段、认领和恢复规则。
- 启动先读取同一份服务、身份、repositoryRoot、mode、本地工具选择及新原生覆盖字段快照，取得原实例锁并认证，再查询云端目标。身份读取遇到临时网络故障时，在原锁下按 5、10、20、40、60 秒封顶退避恢复；确认认证账号前不读取跨账号缓存或授予执行。首次配置 GET 的临时故障保持“未读取”，由报告周期重试；认证、协议、格式和确定不兼容错误明确失败。已有云端值时不解析本地托管字段作为运行权威，不执行项目选择引导；旧本地托管值不能覆盖云端，agentModel/agentReasoningEffort 按本地覆盖规则组合。支持独立 mode 能力时，即使已有目标仍提交本机模式候选，仅供旧目标首次采纳；本地 web 不得被默认 herdr 覆盖。`projects:[]` 是合法配置，正常 run 不因项目为空失败或弹出选择流程，也不创建虚假 Project、Task 或 worktree。空项目不消除原 Task 库存和清理责任。
- 当前 service origin、认证账号和 workerId 验证通过的配置 GET 或匹配本机捕获的合法报告回执，完整安装服务端当前 desired 与 observationRevision。允许较低计数、同版本不同内容以及 desired:null；旧本地目标或待应用值不能压过新权威。每次权威接收更新本机 generation，目标不变时保留仍匹配的记录和应用 job；本机副本与版本大小都不能授予权威。结构合法但超过本机支持限制的目标仍保留为准确权威，关闭新准入并等待后续合法状态。
- 服务端首次未初始化或从已有目标变为 desired:null 时，Worker 自动按同一首次导入合同准备当前本地文件候选。每轮候选读取一个一致 source 快照，完整候选及其独立 mode/工具采纳字段都来自该候选；项目覆盖保留省略、model:null 与 args:[]。没有完整候选时，独立能力采纳保持启动时的本地选择合同。运行中的 origin、凭据、workerId 及本地执行覆盖保持启动归属；文件改指其他 origin/Worker 时明确拒绝，不热切换。候选由 root 生命周期拥有，每 pass 最多 60 秒，报告 Operation 只取消等待者；失败后按后续报告周期重试，相同 source hash 与认证范围可复用成功的项目解析。明确候选拒绝使解析缓存失效，服务端仍执行最终权限校验。准备期间继续读取服务端，已有目标优先并取消、等待旧候选结束；未知导入结果先 GET，不重放旧请求。并发导入仍只建立一次初值，候选不承诺还原服务端丢失的旧配置。
- 未接入前，独立 worker mapping 支持 repositoryRoot、maxConcurrent、pollIntervalMs、recoveryLimit、preferPlatformSpecificTasks、agentControlMode、agent、model、args 和 repositories，默认值依次为 ~/daynights、1、60000、3、false、herdr、copilot、null、[] 和 []；repositories 不从 review 推断。本地候选和运行项目集合最多 128 个不同 Project；标量与 native 的容量遵循[配置协议](daynight-worker-configuration.md#目标配置)。缺失文件或省略可选字段使用这些默认值。只有确实缺失的文件按缺省处理；YAML 结构、重复键、本地字段、首次候选的已知字段、读取故障及取消均严格校验。未知根、review、worker 和仓库字段在投影时忽略，CLI 编辑保留其节点，读取不重写配置。
- 首次候选中的仓库提供 remote，可有 projectId 与逐字段 native 覆盖；导入只投影 Project 身份及覆盖意图。本机绑定实际使用时校验 path：相对 config.yml 目录或为绝对路径，不展开 tilde，拒绝 drive-relative Windows 路径和重叠仓库/状态目录。相同 Agent 类型逐字段继承；切换类型清除未显式给出的 model/args。Args 整体替换，模型与 effort 参数按规范化规则合并；其它参数不允许覆盖 worker 拥有的 cwd/session/mode 或固定 full access 策略，冲突在本机应用前明确拒绝。
- Worker 在自己的状态目录保存 schemaVersion=5 的 configuration.json，严格校验 service origin/userId/workerId。authority 保留当前目标、观测版本和本机 generation；currentItems 记录当前应用与核验，retainedItems 保留原工作、停止、未知结果、未确认失败及必要实际值。recordId 全局唯一，origin 不可改写；复用实际值时保留其 actualSource，不能把旧成功改写为新目标的历史成功。待停止引用必须指向同项目的移除记录且无环。
- 版本 1–4 缓存沿原严格升级入口显式迁移为 schema 5。版本 1 的平台优先字段、原 nativeMode、失败身份、退避与期限、started 移除和观测事实完整保留；schema 4 无法确定的原成功版本明确为未知。正常运行只处理当前格式，字段缺失、未知格式、损坏及身份不符明确失败，不猜测默认配置。迁移结果一次计算、冻结并原子保存后才继续；真实文件 I/O 故障遵守存储就绪与自动恢复规则。
- 缓存以分块方式读取和原子写入，容器总大小不受单个 JSON 字符串上限限制；读取必须在真实 EOF、严格 UTF-8/JSON、完整结构及身份校验后才发布。历史合法结构不因当前单项业务容量限制而拒绝。单 token 仍受运行时表示上限约束，本机全部事实仍占用相应内存与磁盘。
- 缓存中的 native 成功历史不能直接供新进程执行。mode 与全局 native 在目标模式下成组验证，包括本地 model/effort 规范化，成功后一次持久化并发布，失败保留旧有效组合。项目 native 的验证资格绑定 {mode,native}，接入工具管理器后还须包含相关工具选择及 selectionKey；全局模式切换撤销旧项目资格、取消旧校验并逐项目重验，不丢失已完成仓库准备。全局与项目 native 项优先验证本次云端目标，成功后直接使用新元组，包括显式 model:null 与 args:[]。已采纳云端模式时，项目目标验证须等待全局有效模式在本进程取得证明且与目标模式一致；同模式的全局 native 目标失败不阻止项目独立验证自己的目标。全局模式切换失败而历史组合在本进程恢复成功时，必须允许项目历史元组在该有效模式下重新验证；只有验证成功且历史模式与全局有效模式一致的项目才可调度。历史缺失、模式不匹配或验证失败时仍不可用，不能把缓存成功当作当前进程资格，也不能将历史恢复标为新目标已应用。项目移除结果尚未确认时重新选中，或在报告确认回执中重新选中，都必须重新取得被模式变化撤销的资格；尚待重验的选中 native 项先归为 pending，首份新目标报告不得沿用 applied。已在当前运行时验证的成功值在后续目标应用期间继续有效，但相关工具选择或 selectionKey 变化会撤销该 native 的新执行资格；原执行身份及健康无关工具保留。运行时的 native 证明按 recordId 关联；新目标和重选项目可沿用仍有效的前代记录证明，历史实际值来源不授予资格，原记录退休或模式切换撤销后的资格不能由来源引用恢复。
- 单一串行提交 owner 合并目标接收、应用完成与报告确认，从最后已提交状态计算并冻结下一状态；原子替换成功后才发布不可变实际视图，不能互相覆盖更新结果。目标变化为当前核验建立新 recordId，仍有责任的原记录继续保留。原停止真实结束后，当前目标的独立停止核验通过原适配器重新观察资源；重新选中的项目在该核验完成前不能准备或声明 ready。启动本机映射的停止核验须在可用认证目标下被 manager 实际接纳后才算覆盖；未读取、null 或不支持目标不能提前消耗这次核验，后续恢复须重新检查，缓存成功不代替当前 coordinator 的资源观察。本机责任登记和目标安装不依赖所有历史记录同时进入一次网络报告。
- 初始化读取、目录创建、迁移保存及运行期检查点发生真实文件 I/O 故障时，Worker 按 5、10、20、40、60 秒封顶退避自动恢复。格式、身份及其它确定错误仍明确拒绝，不把损坏文件或未读取状态变为空缓存。运行期保留最后已提交的目标、实际值、项目视图及原资源责任；存储未就绪时关闭新配置工作及新执行准入，未保存结果不能声明 applied。
- 每个队首只从最后已提交状态计算并冻结一次下一检查点。写重试使用同一状态、同一编码计划和新的 iterator/临时文件，不重跑已完成 apply/stop 或再次生成身份。普通读取与接收在共享 readiness 等待，有限原 job 的完成结果及可信报告回执仍由 manager 保存。调用者的 Operation 取消或超时只移除等待者，不撤销已拥有的结果、改称远端未知或重放旧报告；存储恢复后顺序发布并唤醒后续同步。
- Task 的 configurationComplete 和 Bot 的真实新执行门禁须同时核对存储就绪、已认证的非空目标与当前有效配置；异步准备后、首次持久意图/注册/派发前再次检查。desired:null 恢复、权威未读取、不支持目标及临时不就绪期间关闭新准入，保留原协调器的资源核验视图，不能发布“项目全部移除”的假目标或从本地候选取得执行资格。冷启动原执行恢复继续使用真实本机项目映射、冻结原生元组和已保留的真实 recoveryLimit 应用值；无已知策略时保持未知，不能从本地候选或默认值补造，也不能把恢复视图当作新准入配置。已有提交、未知提交和原生会话恢复保持原生命周期；原冻结执行的恢复、输入、停止与清理仍服从其原身份、权限和资源证明。
- 配置随独立心跳交换，在心跳之外逐项应用。foreground 和实际使用配置交换的管理路径共用“持久化就绪→权威读取/候选准备→新采样→捕获→generation 检查→发送一次→接收并持久化回执”的顺序；准备或采样期间权威变化时丢弃旧样本，后续周期重采。正常已同步周期不增加 GET；启动、未知结果、400/协议失败及能力重发现先做认证 GET。维持 30 秒单飞、触发合并及原有限 prompt 批次规则。已成功的普通标量、mode 与全局 native 组合、各项目 native 独立生效，一组失败不回滚其他成功项；从未成功的项为 unavailable，不能以目标值或默认值冒充实际值。原生校验、仓库或停止等外部操作不占用缓存提交队列，也不阻塞后续报告。旧目标结果提交时必须重新核验记录绑定、目标内容及真实证明。
- 配置诊断使用真实阶段和可信固定原因，关联 Worker、key、原项 targetRevision、当前权威/观测基线、generation、recordId/reportId、syncId 及可用 requestId。未读取、未初始化与有效 "0" 基线分别表达；可信远端回执后的本地落盘等待保留 confirmed/pending，不因等待超时或日志失败变成远端未知。首次失败、原因/相关目标变化和真实恢复立即记录，同因持续失败在现有周期每五分钟最多一条摘要，实际发生次数与封顶退避档位分别记录。原始输出和凭据不进入配置诊断，formatter/通知失败保留独立错误链，不改变应用、确认、lastFailure 或重放规则；[报告需求](daynight-worker-reporting.md#配置交换)拥有详细词汇与验证条件。
- 失败项按 5、10、20、40、60 秒退避，仅重试失败项，新目标替代旧应用重试；已开始的项目移除保留原版本工作及结果直至确认。报告捕获绑定本机 reportId、generation、精确 baseRevision、实际 observation、recordId/failureId 与轮转游标。只有当前 generation 的 observationAccepted=true 回执确认实际发送且仍匹配的失败与游标；飞行期间的新失败继续保留。当前捕获被拒绝时采用回执的完整规范状态，不重发旧包；observation:null 对应的 false 是未提交观察的正常回执。旧 generation 的任何回执不能改变当前目标、基线、失败或游标，已知远端结果仍保留其原含义。诊断使用闭合 code/category/phase，不上传命令、原始输出或凭据。
- 同一个 coordinator 消费最近成功配置。提高并发供后续调度使用；降低上限不抢占已有任务，占用低于上限后再启动其他任务。pollIntervalMs 作用于完整轮次后的下一次等待，单位毫秒，缺省为 60000；合法显式值（包括 5000）保持其含义。recoveryLimit 供既有恢复逻辑读取。preferPlatformSpecificTasks 只影响后续新任务领取，其 false 应用值与尚未应用的 null 分开。参数更新不重启健康原生进程；新 claim 使用已应用模式及其 native。原 Web/Herdr claim 的推进、retry、recovery 和 cleanup 优先保留冻结 mode/native、会话及 worktree，不受新模式项目 native 重验阻塞，仍服从项目移除及权限门禁。旧无冻结快照且无法确认原模式适用配置时保持不可恢复或未知，不注入新模式参数。切换模式不关闭仍被旧 claim 使用的 backend，Web→Herdr 按需启动 Herdr。
- 项目选择与本机项目映射分别管理。云端新增项目复用已有映射，否则在本机 repositoryRoot 生成路径并准备仓库；只有确认准备成功的项目进入有效集合。独立项目的准备失败不得阻断健康项目，native 验证成功本身不证明仓库已准备。
- 移除项目先排除调度，再停止该 Worker 在项目中的执行，保留任务状态、认领、工作区和会话历史。有效集合约束 active、pending、新领取及在途领取完成后的启动；项目仍被排除时，普通轮询与重启不能自动推进。停止未确认的资源继续占用容量，已确认停止而仅保留现场的资源不永久占用执行槽。失败按项目报告并重试，已开始的移除保留原目标版本直至确认；重新加入后的任务行为遵循既有恢复和人工操作规则。移除不能删除用于归属清单、资源发现和人工处置的本机映射。
- 运行中断网继续使用最近成功值；重启先核对云端再开始正常调度，本机副本不取得权威。配置接收、缓存与报告不依赖任务清单同步或业务后端初始化成功。空项目、业务准备失败及长操作期间继续心跳；任务执行仍服从原有归属与恢复准入。
- `daynight worker setup` 在云端目标尚未建立时要求 stdin/stderr 为交互终端，先汇总环境缺项与修复指引，再单选 Copilot/Codex/Claude 并多选既有可访问 Project。重复配置预选当前项目；最终确认前展示 agent、Project、目录、移除范围及不兼容参数重置。所选 Agent 应用于全部选中 Project；匹配注册保留传输 URL/路径，同类型 model/args 保留，切换类型清除不兼容值。最终把 native 字段与完整选择一次原子保存；取消、空选、认证/API/保存失败均无部分保存。
- Setup 只做有界只读环境探测，不启动 daemon/native agent/worker，不 clone、打开 SQLite、claim、安装或登录。探测验证所选 Agent 的固定 full access 参数能力；Codex 至少为 0.135。缺原生依赖允许保存并明确要求修复；只读版本、参数及 hook 检查不证明 provider 登录、真实 hook 执行、live 协议或完整任务验收。取消等待已启动探测收尾，未确认清理故障保留原错误链并使 setup 明确失败。
- `worker repo list [--json]` 读取本地注册；未接入时 add/remove 选择远端现存可访问 Project。省略 --project 时多选显示名称、完整 UUID、repoUrl，至少选一项；显式 --project 支持非交互。新增保存 projectId、原 repoUrl、绝对 path；匹配既有注册保留传输 URL、路径和覆盖，remote-only 项只补 projectId。删除本地候选注册保留 clone、claim、worktree 和原生历史。云端目标已建立后，setup 和本地托管字段写入明确指向云端修改；缓存缺失不代表未接入，写入前核对云端归属。
- worker.repositoryRoot 独立于 review，只在新增本机路径时展开，改变根不移动已有路径。本地 repo 操作拥有 worker.repositories 及保留条目的 projectId；setup 另拥有全局 agent/model/args 及确认重置的仓库原生字段。最终云端归属检查紧邻取得本地锁之前；锁内重读并拒绝相关身份、服务/凭据、根和仓库变动，保护其他解码值及保留条目的未知字段；显式删除拥有整个所选条目。共享 alias 影响非归属值时拒绝保存，无关字段、注释和安全 alias 保留。网络与提示不持配置锁。
- 首次启动随机生成稳定 workerId，复用配置锁与原子替换保存到配置根下的 config.yml（DN_CONFIG_DIR，缺省 ~/.daynight）。身份创建只拥有根字段 workerId；根循环 alias 等使未知或其他非归属解码值变化时拒绝保存并保留原文件。合法值只读复用，非法值拒绝，身份持久化后才可 claim。每个配置根只有一个 worker 实例，其 worker/ 保存配置副本、SQLite、实例锁、日志、Herdr 和临时资源；同根第二实例拒绝，端点路径不合法明确失败。DN_CONFIG_DIR 必须是绝对路径；根选择同时覆盖 Controller 与 Review 状态，不改变真实 HOME、Provider 登录及项目 worktree。不同根不得独立管理同一个任务 worktree。
- 一个状态目录用于当前配置的单一服务、账号和 workerId。切换前先结束旧执行，再重建本机状态；不提供跨服务或跨账号的旧执行自动接续。原终态清理期限、重试调度及 macOS 原运行的持久停止责任保持原有语义。

### W-02：Agent 自动执行许可

- Task 具有独立的布尔字段 `allowAgents`，表示是否允许 worker 自动领取并交给 Agent 处理。它与用户身份、项目权限、实际执行者及 agent 类型独立。
- 旧任务通过数据库迁移设为 `true`，保留其余业务数据、版本与时间；新任务始终默认为 `false`，创建输入不能直接启用。负责人未变的普通字段更新未提供此字段时保留原值，显式 `false` 表示关闭。顶层 assignedTo 实际变化则按[负责人契约](daynight-task-assignment.md)原子关闭许可，状态和 worker 生命周期写入保留负责人。
- 服务端、CLI 和 Web 一致支持许可的查询、展示与明确操作。完整 task 与图节点必填布尔 allowAgents，严格拒绝缺失、null 或非布尔响应。CLI 的 update/list/ready 使用 `--allow-agents true|false`。Worker 的自动候选查询组合 allowAgents=true、assignedTo=me 与实际平台兼容筛选，并在后续候选页中保留全部条件；实际平台由执行运行时识别，未知或不支持时等待。自动认领在服务端事务中重验负责人等于认证账号 userId、许可、ready、平台、精确版本和唯一归属，自动选出的 ID 不构成人工指定。普通技能不提供自动候选选择或连续调度；worker 和 agent 不得自行启用许可。
- Web 在任务详情标题下的状态行右侧提供单一“自动执行” / “Automatic execution”标签与开关组合，左侧保留状态、ready 与可选平台信息。详情不重复展示独立自动执行状态 badge 或下方 Overview 开关；列表中的状态标记可保留。长标题与窄屏不得重叠或横向溢出；平台等左侧信息可在左组内换行，右侧组合控件保持右对齐并与第一行状态顶部对齐。锁定原因由该控件的 tooltip 提供鼠标悬停与键盘聚焦访问；错误、未知结果和等待人工输入的说明遵循[Web 提示规则](daynight-web.md#必须交付的行为)，使用不挤压阅读区的限时气泡，保留恢复操作。当前详情观察到自动执行设置提交成功时显示浮动气泡，3 秒后自动消失且不占正文高度；后台刷新、语言切换和重开已确认的详情不重复提示。
- 开启和关闭都先弹确认框，确认按钮直接提交修改；取消、Escape 或关闭弹框均不提交。提交期间阻止重复操作，服务端确认成功后才更新开关；明确失败保留原值，未知结果先读取核对，不自动重发。
- 修改沿用已认证用户的项目成员写权限、精确版本与普通 task PATCH。确认表达明确操作意图，session 或 PAT 不能证明操作者是物理人工；不另设处理角色操作或重复确认字段。
- `allowAgents` 与状态、ready 和依赖独立；状态设置保留许可。未开启许可的任务仍可由人工明确安排，通过 set-status in_progress 执行。任务登记不启动执行，不增加任务审批字段。
- `in_progress` 期间拒绝实际切换，完成或合法人工解除 claim 后才允许改变。精确版本的同值更新不修改版本或时间；旧版本同值请求仍拒绝。等待人工输入保留许可，关闭许可不隐式停止执行或撤回归属。

### W-03：可选执行平台

- Task 的必填 `requiredPlatform` 值为 `null`、`windows`、`linux` 或 `macos`；null 表示任意支持平台，新旧 task 默认均不限制。创建可省略或显式提供 null/枚举；更新省略保持，显式 null 清除，非法类型和枚举拒绝。
- 服务端、CLI 和 Web 一致支持设置、清除、展示及兼容筛选。CLI create/update 使用 `--required-platform windows|linux|macos`，update 使用互斥的 `--clear-required-platform` 清除，list/ready 使用 `--compatible-platform windows|linux|macos`；查询平台不充当运行环境配置。Web 详情状态行使用单一平台下拉框展示已确认值，提供不限平台/Any platform、Windows、Linux、macOS。选择不同值后弹窗展示当前与目标平台，确认才提交；选择当前值或取消、Escape、关闭、遮罩关闭均不提交，取消后恢复下拉框焦点。概览没有独立平台编辑区或保存按钮，成功前保持已确认值。
- in_progress 与自动执行许可一并锁定实际变化，完成或合法人工解除后才可修改；精确版本同值更新保留版本与时间，旧版本仍冲突。明确人工设置状态不受平台要求限制。平台确认、许可和状态设置共享每任务写入控制，未知结果先核对，迟到响应保持原 task 归属。
- 平台条件不改变 task 的 ready 语义，不匹配的候选不占名额、不创建资源、不消耗恢复次数。
- `compatiblePlatform` 包含 null 和与查询平台相同的任务要求。普通任务列表的可选布尔 `platformSpecific` 为 true 时仅含明确指定平台的任务，为 false 时仅含不限平台任务，省略时同时包含两类；与 compatiblePlatform 合用可以分别查询当前平台专用和不限平台候选。自动执行许可、ready 与平台条件须在有界候选排序和分页前按 AND 组合，并绑定游标范围，不能让较早的未开启许可、不兼容任务或另一类别遮住后续合格任务。
- 平台字段、领域匹配与候选查询的验收独立于后续运行时。自动候选选择与连续调度由 worker 承担；worker daemon 的原生平台识别、自动 claim 事务重验、资源启动及历史执行平台须由对应能力提供运行证据。普通技能每次执行一个明确指定的任务。

### W-04：原子领取与执行归属

自动领取同时要求 assignedTo 等于当前认证账号的本地 userId、allowAgents=true、ready、平台兼容及没有 active claim。自己指登录账号，不是 workerId；未分配或分配给他人的任务不能自动领取。服务端在同一项目事务中重验成员、精确版本、负责人、许可、平台、依赖和归属，直接调用 claim 接口同样受此限制。同 task 跨机器和 worker 只有一个有效 claim，竞争失败方不得启动资源。既有 active claim 的恢复和完整库存仍按原执行归属核对，不因本规则自动撤回；已释放任务通过普通资格认领。

- 自动领取必须在远端写入前跳过仍有同 task 旧资源的候选。每次取得新的执行使用 fresh claimId/worktreeId；稳定 workerId 和项目映射先保存，实际授予后登记本机 pending。冻结 Herdr 的请求发送前独立持久预留原 claimId/worktreeId、Worker、精确候选版本和工具配置；预留不代表授予，不提前登记 pending。共享实例切换必须保留这份责任。未知响应记录 Warning，不创建资源、不重发原请求，通过完整自有清单及原 Task 读回找回实际授予并原子转移冻结配置；同版本或仅清单缺席不得解除未知请求。macOS 仅在本次明确确认的新 grant 后登记 fresh launch provenance；旧库存和空摘要不能补建该证明。
- Task properties 保存受保护的最新 worker 归属、实际平台、agent 和已知会话摘要。普通 create/PATCH 拒绝写 worker，即使 null 或原值；PR 与 worker 更新相互保留。完整 DTO 中 worker 缺失表示没有保留归属，存在时为合法对象；读取不注入 null 默认值。
- 会话摘要、释放、撤回与完成核对当前 claim 和精确版本，旧执行不能覆盖新归属。服务端验证当前成员与 owner/admin 权限，不远程证明机器进程或 Git 内容。
- Worker 直接调用进程内 typed ApiClient，不启动 daynight 子进程。HTTP 独立有界；未知写入只读取核对，不自动重放。远端 phase、Herdr 和 nativeSessionId 是展示投影，不替代本机实际资源观察。

### W-05：调度与全局并发

- 每轮调度在所有配置仓库中合计最多领取一个新任务；确认授予后结束本轮领取，即使任务暂留 pending 或仍有空闲名额。后续新领取等待下一轮，普通轮询在本轮完成后等待 pollIntervalMs，配置或有效容量变化可提前唤醒，再从下一项目继续轮转；空项目可以跳过。preferPlatformSpecificTasks 默认 false，候选按既有项目轮转与项目内 createdAt、id 升序选择。为 true 时先在全部可领取项目中查找 requiredPlatform 等于实际运行平台的任务；该类别没有可领取项时才进入 requiredPlatform=null 类别。两个类别各自保留项目轮转及项目内 createdAt、id 顺序；一个类别的扫描、跳过或成功领取不得改变另一个类别的项目轮转位置，优先级跨项目和全部候选页生效。例如项目 A 的较早不限平台任务不能排在项目 B 的较晚当前平台专用任务前面。配置更新对后续新领取生效，已取得的 claim 继续原生命周期。
- 已有 pending 优先启动，项目内按稳定 task_id 顺序选择，每成功分配一个名额后轮转到下一项目，同轮可按容量启动多个已领取的 pending；平台优先不改变该规则或抢占已有执行。
- Active 从启动或恢复前预留执行名额；等待 CI/review、人工输入及恢复超限仍占用。终态清理确认精确原执行已停止或权威来源确认未启动后释放执行槽；停止未知或仍运行继续占用。容量按 claim 去重，包含没有本机行的孤立执行。文件、归档及隔离责任继续保留，同 task 旧 claim 屏障不随执行槽释放；已排队恢复先占名额，旧停止观察不能豁免新运行。
- Pending 在没有实际运行资源时不占名额；同 task 旧执行停止、关闭 workspace 并删除 worktree 后，新 claim 才能 active。降低上限不抢占已有任务。并发上限约束本机 active 资源数，迟到授予可以留下等待名额的 pending。
- 空或不兼容仓库不占名额。同仓库不同 task 可以并发；各 task 的操作串行，不同任务的有界等待和清理互不阻塞。
- 本机已有 active 且仍归属的任务先排队恢复，在任务串行操作内读取当前 Herdr；其他工作区的全局 Git 发现错误不阻塞已有名额。新的 pending 启动和新 claim 分配要求完整自有清单、目标仓库资源枚举和可证明的执行容量；可定位的其他仓库格式准备失败只关闭其文件 gate。无法界定的来源或执行责任不能假定为空。
- 完整枚举中的单项受管资源校验失败，可以隔离并继续调度健康资源，但必须由本机持久执行或当前自有 claim 等独立证据确认完整 projectId/taskId/claimId/worktreeId，且仓库及唯一固定注册位置无冲突。隔离项保留资源责任；原执行停止未知时仍占容量，精确确认停止后不再占执行槽。隔离项仍阻止相同 task 的其他 claim 和该隔离 claim 自身的 pending 启动。隔离不证明资源可恢复、可写入、可删除或已经消失。
- 不完整枚举、不可定位的受管注册、owner 或 worktreeId 矛盾、未知数量无可靠上界时，保留全局新领取门禁，容量报告未知或过期；不能用历史快照数量或固定一个槽位估计未知责任。局部失败恢复后，正常下一轮观察重新验证并解除隔离，无需重启或修改任务依赖。

### W-06：稳定的 task worktree

- 分支为 `daynight/<taskId>`，新目录为 `.worktrees/daynight/<worktreeId>`；转换的旧执行保留原 taskId 目录和冻结 cwd。首次创建分支前刷新 origin 的远端默认分支，并以本次取得的 commit 创建分支；首次 clone 也遵守此规则。远端 HEAD 无法获取或不是可用 commit，或刷新失败、超时、取消时报告错误，不从本地旧基线创建分支或 worktree。主 checkout 的分支、HEAD、工作区内容及本地主线保持不变。
- 保留分支从原 tip 使用；仍有效 claim 正常复用 dirty worktree，不 reset/clean。复用已有分支或有效 worktree 不要求 origin 可用。准备时允许通过检查及非递归 rmdir 清除 mkdir 后、Git add 前中断留下的无注册空预留目录，再正常创建；不采纳非空外来目录或别的 claim 的注册。普通退出、失败和崩溃保留其 worktree 与原生历史。
- 清单以 projectId/taskId/claimId/worktreeId 和实际目录名定位资源；创建、复用和删除核对实际仓库、唯一 Git 注册及双向 .git 指针，准备和恢复另核对任务分支。common-directory 与 origin 的只读 Git 查询使用 leaf 之外的稳定仓库 cwd，同时显式绑定已验证的绝对 admin 和清单 leaf，避免自身的 cwd 阻止并发删除；Git 的 linked worktree 配置与 origin 校验保持有效，`core.worktree` 重定向不能改变物理资源归属。macOS lifecycle 的完整 owner 另绑定 serverOrigin、workerId、ownerUserId 和 provider。符号链接、外来路径、非空目录的缺失指针和歧义注册不能授权递归删除；实际操作期间仍检查局部目录身份。
- 仓库准备先完成旧格式转换，收集并校对旧 Git 标记、清理调度和 Web/Herdr 原绑定；全部清单可靠发布并读回后才解除自有旧锁和清理已知 sidecar，最后发布格式标记。失败或未知格式保留原资源并关闭该仓库文件 gate；其他仓库和原执行停止观察独立推进。转换只处理已有资源记录、清单或 Worker Git 注册关联的 worktree；未关联目录直接跳过，保留其内容，不阻断仓库准备。转换不移动旧目录或修改冻结 cwd、ticket、lifecycle。
- 新分配先独占预留目录，再可靠发布清单，最后执行 unlocked Git add。有效 claim 恢复时，原 checkout 缺失可以在原绑定位置从保留分支重建，不要求证明历史上从未启动；缺失目录内未提交内容可能已经丢失。重建仍须核对原归属、仓库、目录和 Git 注册，等待原 Git mutation 收尾，并遵守原 backend 的运行、停止与恢复准入；Web 和 macOS 原生执行的身份及未知结果限制不因此放宽。非空无有效 Git 关联的目录不得仅凭清单删除。无法关联本 worker 的资源保持可见并保留，不因自有清单缺席而删除。
- 终止删除前确认原受管进程停止、workspace 关闭及 backend 必需的归档；macOS Herdr 在原录屏归档或明确处置条件成立前保留工作区。Worktree 目录与 Git 管理注册是分别观察和清理的资源；目录已不存在就完成该目录的清理，仍存在的原注册独立移除。保留 .git 指针至内容移除完成，最后删除目录和注册。中断后留下的空目录可在身份检查后通过非递归 rmdir 移除；不带注册的空预留目录同样可移除，非空且缺少归属证明的路径保留错误。结束后保留分支、提交历史和交付引用，新 claim 使用新工作区身份及原生会话。
- 已确认归属的 worktree 内，POSIX 普通目录具有当前有效用户所有权、与 worktree 相同设备及 owner 读取/搜索权限时，可以仅补充缺失的 owner 写权限，以清理 Go module cache 的嵌套 0555 目录与 0444 文件。权限修改必须绑定已核验的目录句柄；普通文件、硬链接文件与符号链接目标的权限不变。不使用 sudo、全局 chmod 或共享缓存清空。无法安全处理的权限、所有者、设备或 I/O 错误保留并返回。
- 内容删除逐项核验归属和目录身份；发现替换后停止，不继续修改未知目标。部分失败保留 .git 和剩余内容供重新核验后重试；取消或超时必须等待已提交的文件系统操作收尾，不允许未结束的删除与重试并发。对于需要删除 worktree 才结束责任的 backend，只有目录及 Git 注册均已删除才完成文件清理；执行槽按 W-05 的原执行停止事实独立管理。该机制要求确认原受管执行的停止；Git local-closed 只证明原子进程、已创建流与已启动停止 helper/管道关闭，不证明逃逸或脱离 stdio 的后代停止，后者可能在交接后继续写入。它不提供针对并发改写路径的外部进程的原子文件系统隔离。
- 原 backend 所需义务、本地责任和清理调度结算后退休清单。Legacy Herdr 没有持久归档义务；当前完整观察确认原 workspace、待停止责任、目录和精确 Git 注册均不存在，且本进程原操作已收尾时，可以结算孤立清单，不要求补造历史停止证明。已独立确认后继绑定时只退休旧清单，不访问后继 cwd。仅剩元数据的重试不重新停止或删除、不恢复执行槽或同 task 屏障。Web 和 macOS 的原停止、归档及持久义务仍独立核验。
- 清理和资源扫描可交错，过期快照或本机 done 状态不能替代新观察。重复收尾与重启都重新核对原进程实例、backend endpoint、Git 注册和目录；已消失的资源不要求重做操作，仍存在且归属明确的资源继续清理，全部所需资源均达到目标状态才结束文件与归档责任；执行名额按原执行停止事实独立释放。

### W-07：执行模式与 agent 执行

- 模式在服务端 claim 和本机索引中冻结。默认 herdr 经 Herdr 运行原生终端；web 直接启动 Controller，通过 Daynight relay 提供 Task Session，其执行不得探测或依赖 Herdr。独立运行快照只读观察私有端点，不启动 daemon 或初始化 Herdr backend。同一 claim 不切换模式，不因连接错误降级。两模式支持 Codex、Claude、Copilot。
- 混合模式中 Herdr 不可用时，已有且身份、许可及原执行证据仍有效的 active Web 必须能继续恢复；其显式 retry、清理和完成也不得依赖 Herdr。Herdr 观察失败仍保持容量未知，不能当作空资源或据此启动 pending、新领取任务。
- Web 的初始输入、恢复、原生能力与清理遵守 [Task Session 需求](task-sessions.md)。缺失原生 ID、journal 或停止证明不能套用 legacy Herdr 的 NULL 新建分支；macOS Herdr 同样禁止这种替代。以下 Herdr 原生运行规则继续独立适用。

- Worker 自动管理专用 Herdr，每 task/claim 一个 workspace/pane/agent，不干扰人工实例。macOS 每个实际运行代次独占现有 Herdr daemon，其他平台保留共享私有 daemon；不要求修改、发布或替换 Herdr。保持 resume_agents_on_restore=false，由 worker 唯一决定启动或恢复。
- Workspace 显示名称以当前 task title 开头，后接 ` | daynight:` 与 projectId/taskId/claimId/worktreeId 的完整 canonical JSON。标题只作展示，所有权匹配、恢复、停止、清理及 agent name 哈希只使用四项稳定身份。中文、emoji、长标题、同名标题及包含分隔符的标题均可处理；换行、终端和双向显示控制字符编码为可见转义，不截断身份 JSON。
- 下一轮成功完整自有清单提供最新 title，仅名称变化时调用 Herdr rename；已存在的活 workspace 与恢复超限任务也能同步。改名保留 claim、worktree、native session 和 agent name。命名 RPC 失败报告 `workspace-name-error`，不消耗执行恢复预算或中断健康执行；未知结果先重新观察。身份或 binding 冲突及取消继续按生命周期失败处理。名称同步与执行/清理共享 task 串行化，失去 claim 后不调度新的命名操作。
- Herdr 私有 XDG 与端点隔离；task native 环境保留调用方原 XDG set/unset 和认证目录。新建 macOS 独占实例与 Linux 受控共享实例使用不读取用户启动文件的受管 Bash，原生预检与实际启动使用同一有效命令环境；登记原 shell 身份前须由最终 shell 确认本次 workspace 启动完成，并继续核对完整原进程身份，不能仅凭延时或可执行映像推断就绪。旧存活实例保持原 shell，不通过重连改写其配置。Bash/Zsh HISTFILE 使用私有文件；legacy 实例的自定义 rc 和其他 shell 不在通用历史隔离保证内。
- Linux/Windows legacy 存活 agent 保持原连接；原生 Agent 意外退出且当前资源确认 inactive 时，正常巡查自动停止并关闭原 workspace，以当前 native 环境重建并清空该 pane 遗留的原生引用，再按本机保存的 session_id 恢复。新 shell 初始化期间明确拒绝的 agent_pane_busy，在原 workspace/pane/terminal 归属不变、没有 Agent 出现且进程观察证明 shell 正在初始化时，最多等待 2 秒重试；等待受原操作取消和期限约束，成功不消耗执行恢复次数。真正的前台程序占用、缺少初始化证据、身份变化及未知启动结果保留错误，不盲目重复启动。不把 inactive pane 的旧引用当作新 ID，旧无映射路径不增加历史扫描；新冻结映射持久保存启动 intent/receipt、首次输入 intent 和原进程归属，未知结果不得重放。
- Shell 初始化期间最多 2 秒的重试仅属于同一次原生 launch 调用，只接受明确未启动的 agent_pane_busy 拒绝及持续有效的原 shell 证据；不创建新 generation、不发送 assignment。每次新 agent.start 尝试均在调用方准入完成后、递交前，核对原 pane 的当前 cwd 与任务 worktree 的 canonical 路径一致；不一致时以明确未递交失败，不启动原生进程。已有活 agent 的重连直接返回，不执行此启动前检查。macOS 仍先保存 launch_requested，成功后持久登记原 native 进程证明再开放输入。未知响应或崩溃后的启动状态保持阻断，不重发启动或首次输入。
- 无冻结映射的 Legacy 活 agent 直接连接并观察；需要启动且 session_id 有值则使用记录的 agent 和原生 ID resume；session_id=NULL 时记录 info 并启动全新原生会话，成功取得 ID 写回原行，沿用 task/claim/worktree。NULL 是新 claim 首次启动的正常状态，也覆盖启动成功但 ID 尚未保存的崩溃窗口，不增加历史反查、暂停或人工确认门槛。
- 本机 session_id 非空时，启动、重连和延后输入前观察到的原生引用必须与其一致；不同 ID 是可见错误，保留原记录并停止该次输入。session_id 为空时可采纳实际存活 agent 的真实 ID，仍不采纳 inactive pane 的旧引用；只有具有新启动来源的首次执行或 legacy NULL 路径可以新建；macOS 可能已经启动的原运行缺 ID 时保持未知。
- 首次启动和 legacy 明确恢复使用完整 prompt，提供自包含运行约束和 project/task/claim/worktree 身份、实际路径/branch 和本次配置。完整 prompt 明确任务已获得完成所需的充分授权，要求 agent 不为 PR 合并是否获得授权等流程性事项再次请求授权；任务范围、独立暂停或撤权以及 CI、review 和合并门禁仍然有效。启动、macOS 延续或恢复输入及周期 ping 一致要求 agent 检查任务、仓库约束和证据，自主调整实现路径、步骤和任务内决定，在满足已确认的业务目标、范围、验收、外部承诺及授权时继续；初始方案失败时调查并选择可行替代方案，记录重大偏离及理由。普通信息缺口、工具不可用、方案失败、可恢复错误及不再适用的步骤不能单独触发暂停。
- 当证据确认存在严重设计冲突，即已确认的需求或架构约束无法同时满足、没有兼容的可行替代方案且解决必须变更已确认约束，时请求具体决定；必要操作确实缺少授权且核对已有授权、完成其他可做工作后仍无法推进时，也请求具体决定。公开回复受限不阻止已授权修复与验证，不重复索取已有权限。暂停前按实际原因记录冲突证据、受影响要求、考虑过的方案和待决定事项，或必要操作、权限限制来源和所需授权，按 managed 流程先将自己的 task 设为 paused=true 并核验后等待，问题解决且授权允许后解除暂停并核验再继续。
- 只有下一步确实属于外部方时才进入评审等待。进入或继续等待前，完整核对当前 HEAD、检查和未解决线程，包括旧意见；读取失败或分页不完整保持未知，过时线程仍须验证。可处理意见先修复、验证并按授权回复；不采纳时给出证据和待回应方，不能用修改 PR 描述替代线程处置。移除当前 PR 的无关改动与另行交付分别判断范围和权限。正常等待 PR review、reviewer approval 或 CI，以及轮询超时，都不得作为设置 paused=true、请求用户介入、结束当前轮执行或退出的理由；agent 自行等待、定期检查并继续交付。无变化时不重复发送同义进展，只在变化、行动或需要决定时更新，长等待可低频摘要。原生 Working 不作为 PR 业务进展证明。用户独立暂停、限制与撤销、allowAgents=false 及身份变化仍约束执行和写入。适配层递交不透明 prompt；重连活 agent 不重发启动输入。macOS 已确认首次传输后的恢复只继续原任务，不重放原 assignment。缺失或不匹配 assignment 时停止受影响工作，不改用其他身份。
- 定时巡查在原 claim 仍有效时读取当前 agent 状态。已就绪、未在启动的存活 agent 处于 idle 或 done 且当前任务未暂停周期输入时发送继续原任务的 ping；working、blocked、unknown、未就绪及尚有首次输入待递交时继续观察。Ping 完整正文使用字面量 `<system remider>` 与 `</system remider>` 标签包裹，保留原任务、claim、worktree 和授权，使用相同的自主处理和设计冲突或必要授权缺失的介入规则，要求自行等待 review、approval 和 CI 并继续交付；不能把 agent 的 idle/done 当作业务完成。进程内保留上次输入对应的观察，观察未改变时不重复递交；未知输入结果先观察核对，不盲目重放。进入终止清理后不再发送业务 ping。
- task property paused:true 抑制周期 continuation ping，false 或缺席适用原策略。实际发送前，在 workspace 串行化、结构化就绪及已知输入阻塞检查完成后重新读取服务端 task，核验原 active claim、worker 和 worktree 归属；读取失败、归属失效或暂停时均不发送。暂停时确定零写入属于等待，不记录为已递交、不改变输入基线或消耗执行失败预算，因此解除暂停后即使原生观察未改变也可正常 ping。标记不改变 Task 状态或 worker.phase、领取资格、原会话、观察、人工输入或原运行停止。Legacy 的首次、待递交和恢复输入不使用周期门禁；macOS 在首次、待递交及恢复后的自动输入和 cleanup 提示的最终递交边界检查暂停。确定未写的首次 assignment 保留正文及稳定身份、仍为 pending；可能已写的输入保持 unknown/suspended，不因解除暂停而重放。
- Copilot 与 Codex 的每次 fresh/resume 启动固定使用 full access，并为本次任务目录启用信任，免除原生工具权限、目录信任及 hook trust 确认。Copilot 使用 `--allow-all --no-ask-user --no-sandbox`，并覆盖本次 workspace 环境为 `COPILOT_ALLOW_ALL=true`、`COPILOT_ASSISTED_APPROVAL=false`；Codex 使用 `--no-daemon`、`--dangerously-bypass-approvals-and-sandbox`、`--dangerously-bypass-hook-trust` 及当前真实任务路径的调用级 trusted 配置。该策略不是可选配置；不能通过 args 降低权限或恢复确认。
- Codex 每次 fresh/resume 启动在配置参数之后以两个独立 argv 传入 `-c`、`check_for_update_on_startup=false`，覆盖同名配置，关闭本次启动的更新检查和交互提示，使任务能够进入正常输入流程。该设置通过 Herdr 启动选项传递，任务 prompt 保持独立；Copilot 启动方式不变。
- 固定策略只作用于本次原生命令及任务 workspace，不改写全局 native 配置（包括用户 `config.toml`）、凭据或组织/操作系统策略。业务执行和交付仍遵循任务授权；缺失认证、集成或能力明确报错，不降级为等待权限确认。
- 自动输入先核验 Herdr 的结构化 agent 身份、interactive_ready、launch_pending 和 blocked 状态。Codex/Claude 再读取原绑定 pane 的完整可见文本，仅拒绝明确识别的菜单或禁用输入；不要求正常 composer、状态栏、目录展示、占位文案或边框。自定义或未知正常布局立即继续，不等待匹配白名单。Codex Session picker 即使在窄宽度、重绑定下只保留 resume/fork/restore 主动作，也须在完整 Resume/Fork 标题及原生搜索或选中会话行（含展开态）仍可识别时拒绝输入；后续正常 prompt 排除历史菜单。读取后重新核对绑定与状态，随后执行适用的最终 claim/paused 授权检查再递交。明确菜单或禁用输入以未递交等待保留首次 assignment 或 continuation 机会，不推进提交基线、不消耗执行恢复次数；关闭后继续巡查。未识别布局不构成对所有未来界面的支持保证。Worker 创建 workspace 时指定任务 cwd；发现、输入观察及停止不因 pane 与 agent 的 cwd 元数据缺失、不同或变化而拒绝，也不因其他 workspace 使用相同 cwd 而拒绝创建。目录创建错误由实际 workspace.create 返回。workspace/pane/terminal 绑定、当前任务授权、进程停止证据和投递结果仍分别核验。原生历史可用性由原生命令报告，不扫描 provider 数据库或会话 manifest；已知 ID 恢复失败保持可见，不静默清除 ID。
- macOS 输入检查区分 automatic/cleanup、manual 与 resume：automatic/cleanup 仅排除已知阻塞并报告 composer unavailable，manual 允许 lease 持有人操作菜单；显式交还和干净正常退出后的自动恢复使用 resume，Codex/Claude 必须有保留 ANSI 属性的真实空字段证明：Codex 的 DIM 占位符和当前字段几何不能由相同字面的普通样式或多行草稿替代，RGB/indexed color 参数不能伪造 DIM；Claude 只接受真实空白的 bordered field，歧义 Try 文本拒绝。未知界面、样式或草稿不能写成 empty，也不要求可选 model、cwd、状态栏。Copilot 保留 unavailable 事实及显式交还责任。原 lease/fence、草稿处置、cleanup 优先级与输入 journal 的未知结果保护保持独立。
- macOS 必须将原生启动与首次输入分离，可靠保存原 daemon/shell/native agent 的 boot、出生标识及资源绑定后才开放输入。新冻结映射的首次输入前还须核实 manifest/nonce、逻辑 argv、launch receipt、原 binding、kind/readiness 和完整 helper/native 归属。nativeSessionId 可在最多一次首次输入后补齐；启动成功前必须取得原官方 integration 向同 pane 报告的正确 kind 与合法 UUID，并复核原进程身份。已知值不可更换；事件缺失或结果未知不重发、不换会话、不人工补报。首次输入 pending/dispatching/transport_completed/unknown 跨重启保存，未知结果阻断自动重放，传输成功不等于业务处理恰好一次。
- macOS 普通重连保持同一 Session 和 executionGeneration，只提升 connectionEpoch；只有原运行已确认停止、claim 有效、native ID 与首次输入结果可用于恢复，才增加实际运行 generation。每次启动或重连产生段边界并显式记录间断，不推算停机期间录制内容。
- 新冻结执行保留 Agent 与 Herdr 两份 launch；同 claim retry/resume 沿用原选择与原 Session。macOS 新 execution 可使用新独占实例；Linux/Windows 共享新目标等待全部旧执行、认领请求、probe、启动/停止和进程回收责任清空，确认原 daemon 与两个 endpoint 关闭后才可启动并以真实握手确认 applied。原 claim 只能在全部旧树关闭后用同一冻结选择恢复；已授予的 pending claim 可经当前许可与身份核验恢复原 daemon，Agent 启动仍须满足容量。Windows 新 owned tab 使用系统 PowerShell 5 root command 与 ExternalScript，不启动嵌套常驻 shell，不声明 PowerShell 7 支持；native 环境恢复原 PATH。缺文件、无权限、损坏 manifest 或身份不符均不 fallback，helper 退出不代表 native 已回收。
- Herdr Session v2 必须沿用原 Worker 身份，不使用 Web Controller ticket。Legacy 的 observe/control/archive 能力均为 false，不宣称网页控制、终端录制或最终归档可用；无冻结映射的启动回执和普通输入基线仍只在当前进程，新映射的持久首次输入 fence 不等于完整输入仲裁，人工输入通过 worker attach。macOS 的 Session 能力及持久输入遵循[输入仲裁设计](../design/herdr-input-arbitration.md)和[录制设计](../design/herdr-recording.md)。

### W-08：人工介入与强制撤回

Web backend 的人工输入通过 Task Session；macOS Herdr 支持 Task Session 人工终端及本地 attach，legacy Herdr 使用 attach。Retry/release 均与 runner 互斥并核验权限；release 使用精确版本。具体恢复与停止证据由原模式的 backend 提供。

macOS 任务暂停不禁止有效 owner 获取、续约和释放人工 lease，或按原 lease、epoch、目标与进程规则发送 paste/keys；首次未知结果的独立处置仍按原协议。manual 或释放后的 suspended 期间自动巡查正常等待，不消耗失败预算、不自动交还。`resume_automation` 须先解除任务暂停，并独立满足显式确认、草稿处置与原生 readiness；解除任务属性不会释放 lease、解决 unknown 或自行交还。

- 等待人工时保留 claim、worktree、原会话和名额，显示 worker attach。Attach 只连接既有私有 Herdr，要求交互式终端，不读 Daynight 凭据、不取 worker 锁、不启动 daemon 或 agent。macOS 有 lifecycle journal 时只读校验当前版本并选择未停止原运行，核对原 daemon 与两个端点；不迁移、恢复或提升 epoch，暂停任务仍可接入。冻结实例的 attach client 必须校验并使用原 Herdr launch，缺失历史身份或原文件变化时拒绝新 client，不替换为当前目标。不可读 journal 不回退未知实例；无 lifecycle journal 时只读共享实例原 launch 和 daemon 证明，缺历史身份时同样拒绝新 client。Detach 保留执行；不可用或非零退出明确报错。
- retry/release 先停止 runner，再取得同一实例锁同步处理指定 claim。锁占用时明确提示停止 runner；没有持久管理意图或后台管理队列。
- Retry 核验仍属于本 worker 的 active claim，尝试一次重连或恢复，保持 claim/agent/worktree。Pending 由 run 经正常名额与旧执行门槛启动。原冻结 Herdr 的显式 retry 可以在正常 shutdown 后恢复同一冻结 daemon，不依赖自动项目选择；仍受原身份、许可、暂停、在途项目停止和完整停止证明约束，不授权推进其它任务。macOS Herdr 不绕过持久 unknown 或缺失原 native ID；Linux/Windows legacy NULL 路径可以新建。Herdr 的计数和额外尝试只在当前调用或进程内；Web 使用持久的单次 retry 授权，必须验证原 nativeSessionId、generation 与完整停止证明，缺失证据或 claim 失效时拒绝恢复，不能新建替代会话或重发初始 assignment。授权本身不表示恢复成功；就绪观察后恢复正常阶段，初始化期间仍显示等待；跨 tick 或重启不得把已换代的单次 retry 当成新授权，失败再次暂停。
- Release 先核验原 owner/admin、当前项目权限、原 claim 和指定版本。按 backend 停止原运行并再次检查取消后提交一次远端变更；仅有效 200 后完成原资源收尾。Legacy 通知、关闭并删除，正常返回前退休原清单；退休失败报告已确认释放及原因，保留元数据供后续重试。Web 遵守归档门槛，macOS Herdr 不发送 cleanup prompt 且停止、封段及同步确认后可结束本机执行行，但归档条件满足前保留工作区与独立 archive 责任。远端拒绝时保留工作区供原执行恢复。Release 回到 todo、清空任务计时并删除 worker 和 sessionStartup；原 Session/archive 保存历史。
- Web 详情显示当前 active claim 的用户、机器、agent 和阶段，completed 不表示当前认领。成员资料缺失时保留真实 userId，读取失败显示错误。原 owner/admin 可确认“强制撤回”：提交 active 的 claimId 和精确版本，同一事务清除 worker、返回 todo、清空任务起止时间、设置 allowAgents=false，其他资料保持。completed 或缺失 worker 不提供该操作。
- 撤回确认说明所有重置结果以及远端 agent 不保证立即停止，取消不写入，冲突重新审阅，未知结果只读核对。撤回无需 stoppedConfirmed 或源机器在线，不撤销外部凭据；原 worker 下次成功完整自有清单发现原 claim 缺席后进入既有终止清理。自动再次领取需要明确重新开启许可。
- 释放后符合普通资格的任务与其他候选按服务端顺序参与调度；原 Worker 仍受本机旧资源和归档责任屏障约束。专用 Worker resume 不提供，也不提供绕过普通认领资格的替代入口。
- 用户给定 --if-version 不替换。Release 的未知结果保留原错误和资源责任，不通过 GET 推断请求成功、不重放；确认后收尾失败明确报告释放已确认并保留原因。命令不承诺跨进程续接原管理意图。
- Transfer API、typed operation、CLI 命令及 target descriptor 已移除；没有目标执行移交。服务端继续保留 release 的 stoppedConfirmed、普通认领资格、唯一归属、权限及旧 claim fencing。

### W-09：SQLite、对账、退出与恢复

- 主索引表精确为 projects(project_id,repo_url,local_path) 与 tasks(project_id,task_id,claim_id,status,agent,session_id,agent_control_mode)。Task 主键为 project/task/claim；status 为 pending/active/done，agent 为 copilot/codex/claude，session_id nullable；agent_control_mode 为 herdr/web，来自实际 claim。同 project/task 至多一个 active；结束行保留。
- 项目映射在 claim 前保存。首次与空库启动先尝试解析并登记可确认的配置项目；未能登记的项目在后续轮次处理，不得据未查询结果清理其资源。映射有未结束任务或实际受管资源时不能改变；移出配置后原映射继续对账并保留现场。
- workerId-only 查询分别穷尽各项目分页，固定当前认证 principal。只有目标项目成功完整查询才能授权其缺席清理；项目 404 明确标为不可用，不阻断有完整清单和资源观察的健康项目。其他认证、协议和网络错误保持真实分类。Herdr/Git 读取失败不作为空资源；未知项目的遗留资源保留并报告。显式旧 Project ID 不按仓库地址重绑，仍可从配置移除。
- 远端实际 claim 缺少本机行时补 pending；确认可以启动先提交 active 后建资源；成功完整清单缺少原 claim 时统一进入该 task 串行且独立退避的清理 job，即使全局快照没有找到资源也不能直接把本机行置 done。只有 claim 身份而没有 worktreeId 时，重新读取原模式和 Git 的权威资源；发现实际归属后使用其完整身份，否则不猜测目录，确认原资源不存在后结束本机记录。同 task 路径已有可识别的其他 claim 资源时，旧 claim 不删除该资源。资源发现覆盖历史 done 行及遗留受管资源，旧资源未收尾前同 task 新 claim 等待。清理或退出关闭已验证归属的 Herdr workspace 前，缺失本机行的 claim 必须以实际观察的 agent 类型登记 pending，存活 agent 的已知原生会话 ID 一并保存；重启后继续清理保留的 worktree，再允许同 task 后继执行。无法确认原 agent 类型时保留 workspace 并报告错误，不从当前配置猜测。未证明归属的 Git-only 资源不得据此登记。
- Linux/Windows 无冻结映射的 legacy Herdr 业务启动/输入回执和 PID 观察不持久保存。新受控映射持久保存原 manifest、启动 intent/receipt、首次输入 intent、进程证明及 retirement；共享实例另保存冻结 Herdr launch、实际握手、原 daemon proof 和切换阶段，缺证据或 unknown 不因重启而解除。累计执行恢复次数和通用人工管理意图仍不持久保存或转存其他台账；Worker 的全局配置副本不替代新 claim 的独立原生配置冻结记录。macOS Herdr 另保存原运行身份、输入准入、停止 journal、Session 连接及采集段，unknown 不因重启而清除；新 claim 原生配置选择持久冻结；累计业务恢复次数和通用人工管理意图仍是进程内语义。具备完整资源身份的终态清理独立持久保存原 claim/worktree 身份、首个期限及失败重试调度，不保存 notified/submitted 或资源完成标记；只有 claim 身份时不捏造 worktreeId 或建立替代台账，失败退避仅在进程内保留，重启通过仍未完成的本机行重新发现资源。实际状态必须从资源自己的 source of truth 读取。日志不作为恢复输入。业务恢复保留原 claim 的原生模型与参数；执行恢复计数和超限等待只在当前进程内，重启清零。
- Web 真实原生恢复预算耗尽或原生恢复安全检查阻止执行时，必须持久保存可诊断的暂停原因，保留恢复次数、原 claim 和原生身份。暂停门禁先于 worktree 准备、执行初始化、Controller 准备与启动和原生输入；多轮 tick、普通重启及 shutdown/clearShutdown 均不能绕过。最后一次合法恢复仍健康时，不能仅因次数达到上限而暂停；健康执行的正常关停恢复仍允许。
- Web 普通编排失败与原生恢复预算必须分开。工作树异常保存可追踪的编排原因，不得把连续失败误报为 recovery_limit；恢复成功不能因旧普通失败累计而再次锁存。异常期间保留分支、Git pointer、repository/origin 和全部执行归属守卫，拒绝危险推进、替换和清理，保持可信只读观察及既有授权续期。
- 明确可恢复的编排条件恢复后，须重验全部原归属和同 generation 的健康观察，再清除对应阻塞并发布更高 revision 的准确报告。保持原 claim、native ID、generation、controller instance 与进程，不启动新 conversation、不重发初始 assignment、不重放用户输入或清零真正原生预算。该分类与恢复条件跨 Worker 重启保持一致。首次启动尚未递交 assignment 时，须在证明原 Controller 与运行归属后继续同一次启动和原幂等首次提交；未知投递不得重放，缺失归属证据不得新建替代执行。已经分配替换代的显式 retry 经同代健康验证后完成，不再要求停止该健康代或消耗第二次尝试。
- 旧分支异常误锁的纠正须同时证明已知旧错误来源、原报告身份、完整工作树归属及当前原生健康状态；count=0、connected 或错误文本不能单独清除阻塞。真实耗尽、身份缺失、归属冲突、停止状态不明及陈旧 generation/revision 保留原保护，来源不充分时保留明确原因。
- 升级前次数已耗尽、缺少暂停原因且没有正常关停来源的 Web 停止记录，必须在启动前根据原 journal 和完整停止证明识别并补齐暂停，不能先启动旧 generation。停止证明不足时保留责任并显示可诊断等待，不启动替代运行。
- Web 执行被阻止后仍对账远端摘要，发布 waiting、原 nativeSessionId 和 herdr:null，保留 active claim。发布失败不消耗原生恢复预算、不清除本地暂停；后续轮次读取新 task 版本后重试，摘要一致后不重复写。暂停不释放名额、不删除资源、不写业务 done，也不改变 task.properties.paused 的 Herdr 周期 ping 语义。
- Ctrl+C 的根取消信号同步停止报告触发、新领取和调度，并取消报告及所有运行中的 job（包括终止清理 job），在等待报告收尾前完成取消。配置 manager 同时先进入 drain，再 join 报告、初始化移除与其它依赖检查点的工作；五秒只限制继续调度存储重试，已经开始的 read/write/rename 必须真正结束后才能释放实例锁。未保存检查点须携带原错误与记录身份明确失败，不能宣称干净退出或推断未落盘副作用没有发生；重启从已保存的 started 及原执行资料重新核验。等待报告期间终止清理不能继续删除 worktree 或把未完成行置 done；报告与 job 全部收尾后直接中断并停止受管 agent、关闭 workspace。进程退出不发送清理 prompt，也不等待 agent 清理轮；工作区外临时资源可能遗留。保留 claim、worktree、原生 session ID 与所有未完成 active/pending 行，包括归属已经结束的任务；退出不删除 worktree、不把未完成行置 done。重启恢复已有终态清理责任并核对实际资源，包括本机行已 done 而调度记录尚未删除的窗口；当前配置改为 Web 不能使原 Herdr 清理责任失去后端核验能力，也不能据此提前释放容量；该清理后端不可用时，其初始化与重试仍按原 claim 退避，不得阻塞无关的健康 Web 执行。新的归属结束判断仍要求成功完整清单。待确认的停止操作收尾后才停止私有实例；停止错误保持可见，无法确认停止时保留私有 Herdr 与相关资源。业务取消沿用已release归属的既有终态清理，不新增本地cancelled状态或归档绕过。正常完成、release、强制撤回和人工管理按W-10 的通知与资源清理规则执行。
- 主索引、独立清理调度及 Bot 库存/执行表共同使用 `user_version=16`；版本 8 增加 Bot 库存，版本 9 增加 Bot 执行证据，版本 10 保存当前 Controller instance 与跨代恢复来源和停证，版本 12 增加 claim 原生配置冻结表；版本 15 对双 launch 冻结字段建立旧 reader/writer 格式门禁，版本 16 增加独立认领工具预留表，保持授予前请求责任与已授予任务索引分离。版本 6→7 删除清理通知步骤字段并保留身份、期限及重试调度；版本 5 原索引升级时保留项目和任务行。Web 执行状态库独立使用版本 2，版本 1→2 删除重复的 cleanup 输入、结果和资源完成字段，保留控制意图、期限和操作身份。Controller journal 使用版本 6。五个业务库的版本 0 均在既有准入后丢弃原 schema 和数据，并通过基线与编号升级重建；已有空文件和查询访问同样适用。有效非零迁移保留数据，旧详细状态库 1–4 明确拒绝并保留原库；操作者停止旧 worker 后自行移除该旧库再启动。独立 Herdr lifecycle 库的现存无版本或不兼容数据必须保留并拒绝，不能按上述五库规则重置。各库分别保证单库原子性，任何所需库打开失败都不启动协调业务。[SQLite 升级需求](cli-sqlite-migrations.md)定义共同的版本、查询、准入和错误约束。原生历史与 workerId 保留原有位置。

### W-10：Agent 完成与资源清理

Web 与 Herdr 共用 claim 结束和工作区删除门槛。两种模式保留首个期限和资源身份，每次从权威来源观察剩余资源。Linux/Windows legacy Herdr 的 idle 仅决定何时开始停止；仍有原资源时须完成停止和关闭，同进程已开始的操作必须收尾。重启后当前完整观察确认原资源缺席时可以收敛，不要求恢复进程内历史停止回执，也不将缺席宣称为历史停止证明。Web 的清理回执和原生停止证明从原 Controller 来源读取。进程退出直接停止所拥有执行，不派发清理 prompt。

- Agent 完成全部要求、验收和证据后，最后使用原 claimId 与观察版本通过 task set-status done 提交已有完成操作。必要 PR、授权合并和人工验收未完成时保持任务未完成；worker不重复解释或提交业务done。取消是非交付终态；已取消的任务不能认领或 withdraw 恢复。
- Linux/Windows legacy Herdr 与 Web 正常对账发现原 claim 不在成功完整清单时，通知仍存活的 agent 清理可归属的工作区外临时资源，最多等待首个清理期限内的 10 分钟，再停止进程、关闭 workspace、删除 worktree，最后本机 done；已缺席的 legacy 资源按当前观察收敛。清理资源观察、通知、停止/关闭及 worktree 核验与删除的单次操作预算统一为 5 分钟，内部 RPC、Controller 清理请求与 Git 命令受同一预算约束；通知还受原 10 分钟期限的剩余时间限制。普通执行操作的预算保持各自语义。Web 模式在确认停止后上传只读 Session 文件归档，ready 前保留 worktree 与待归档源；上传失败只重试归档，不重启 Agent 或重跑任务。Done/release/强制撤回后的本地结束规则一致，分支与历史保留。
- Linux/Windows legacy Herdr 在一次有界清理调用内向仍存活的原 agent 发送一次建议性清理消息，随后重新读取 Herdr；通知后的新观察为 idle、资源已消失或原期限届满允许开始停止，不要求序列计数递增或 interactiveReady。通知失败或结果未知时保留错误并沿用原期限，在同一次调用内不重发。Herdr 没有可查询的逐输入操作身份，Worker 不另建通知台账，因此调用中断或重启后，下一次尝试可能再次通知仍存活的原 agent。Idle 和递交回执都不证明资源已清理；停止后仍须实际确认进程和 workspace 消失。Worker 进程退出遵循 W-09 的直接停止规则。
- 终态清理保留首个期限；失败重试和重启不重新计时，不为清理新建 agent。Web 以同一 cleanupOperationId 查询 Controller 拥有的原生操作回执，未知结果通过该操作身份核对。Legacy Herdr 的建议性通知遵守前述重复边界。重启恢复原 claim 的清理责任并重新核对资源归属；已经确认结束的责任可在后续服务轮询失败时继续，不能恢复为业务执行。
- 临时或未分类的清理失败按 claim 独立退避，连续失败等待 1、2、4、8、16、32 秒，随后每次最多 60 秒，到期后的正常对账才重试。同 claim 的操作严格串行，取消等待在途资源操作收尾，不留下与下次重试并发的后台删除；退避不消耗业务 recoveryLimit，不解除文件责任和同 task 旧 claim 屏障；执行容量按独立停止观察计算。持续失败项不阻塞其他可清理项；有余量时健康任务仍可领取和推进，已运行任务继续执行。
- Web 归档的持久 `archive_incomplete` 与不可通过全量重同步解除的 `projection_gap` 分别标记为明确的待修复原因。原件、claim、清理责任和同 task 屏障继续保留；原执行停止未知时容量也继续占用。不得清零标记、丢弃未确认事件、伪造确认或重跑 Agent。首次归档在昂贵内容读取前检查；进入待修复后，每 15 分钟只读核对原停止 generation 和修复条件，不重复完整归档。阻塞原因与下一次探测时间跨 Worker 重启保持，探测失败不解除责任，重复相同阻塞不增加完整归档失败计数。
- 首次及后续轻量探测均保留原 generation 的 receipt 对账机会：发现 receipt 后进入既有远端摘要、长度及旧 receipt 迁移验证，即使本地仍有不完整标记也不得永久跳过；receipt 存在不等于归档成功。其他修复条件允许尝试时仍重新执行完整清理与归档校验，只有实际所需资源全部达到目标状态才释放责任并报告恢复。历史归档补传同样遵守低频待修复规则。自动重建缺失历史、接受带缺口归档及放弃原件不属于该恢复机制。
- 每次实际失败记录原错误、清理阶段和下一次重试时间，区分停止未确认、Agent 已停但后端资源关闭未确认、Agent 已停但归档待完成、Agent 已停但 worktree 删除失败；调度错误与 Controller 拥有的原生操作结果分别报告。满槽且存在失败清理时，阻塞责任集合变化才输出容量诊断，说明保留的槽位、错误原因及解除原因后的自动重试方式。普通 tick 不重复刷屏。调度持久化失败保留原清理错误与存储错误，当前进程继续独立退避，不让未处理的 job rejection 跳过退出停止证明；持久写成功前，不把该次 retry 决策描述为已跨重启保存，已有持久清理责任保持。
- 失败保留错误与收尾责任；每次重试从 source of truth 读取剩余资源，已不存在的资源即满足对应清理目标。删除、停止等操作的响应丢失后重新观察结果，不因缺少成功回执判定资源仍在。读取失败或无法确认停止时不能删除工作区或标 done；macOS 必须持有原实例停止证明，单纯缺席不完成。清理不影响其他任务与人工 Herdr。
- 已知目标的清理按对应执行推进，删除仅验证该目标的 Git 工作区。退出立即取消运行中的等待，进行原执行停止证明，不等待失败退避、不归档、不删除 worktree，也不以 Git 发现成功作为停止门槛。已经停止 Agent 的结果不能被文件删除错误覆盖；停止未确认与后端关闭未确认分别诊断，任一无法确认时退出仍须失败并保留责任。Web 已写 done 而调度责任尚未删除时，退出仍从原进程实例和 endpoint 重新确认停止与关闭，不操作 Git；正常对账则重新观察并清理剩余 Git 资源后才结束责任。原有终态清理责任留待正常恢复。
- macOS Herdr 按原出生身份与 audit token 停止独占运行，关闭前保存 stop_intent/close_requested，停止后保存证明、封段并同步 ledger；终态 cleanup 先持久撤销输入，仅原 automation、无草稿/未知输入且原生界面安全时允许一次有界 cleanup prompt，否则跳过提示并受控停止，原进程替代、未知停止或未知写入保留责任，不启动替代运行。journal 写失败只允许依据已有证据尽力停止，不能在重启后补写意图来追认同一 boot 中已消失 daemon 的完整停止。停止、封段与 ledger 确认后可结束本机执行行；原执行停止证明提交后释放执行槽，隔离资源仍保留文件责任和同 task 屏障；当前 observe/control/archive 均为 false，未提供最终 archive，因此 worktree 与独立 archive 责任继续保留并阻止同 task 后继覆盖。shutdown 保留 active claim 与同一 Session，只结束原运行和段，不发布最终 ready。

### W-11：可观察性与交付验收

- Worker 独立报告当前调度、并行活动、实际容量、准入原因、故障及最近恢复；未知和不完整观察不得冒充空闲或零容量。运行监控与机器快照分别发送，失败不改变心跳、领取、执行或清理。[运行监控合同](daynight-worker-monitoring.md)定义数据、权限与时间边界。
- 身份与认证就绪后立即报告运行快照，独立 30 秒周期及成功完整清单、新 claim 触发不受 tick、候选查询或容量影响。最多一次进行中尝试与一个合并触发，采集含正常原生终止/join 最多 5 秒、HTTP 最多 10 秒、总预算 15 秒。配置存储阻塞时先等待共享 readiness，Operation 结束只移除本轮等待者，后续触发仍可在恢复后推进。退出先同步取消全部 job（包括终止清理）并停止调度，再等待报告收尾，最后释放既有资源与实例锁；未知写入不重放，监控失败不改变任务执行。
- 运行快照报告真实 OS、CPU 逻辑处理器及差分使用率、内存、启动目录文件系统容量和软件版本。初始未知清单为 null，真实空清单为 []；清单同步失败或项目不可用造成覆盖不完整时清除旧清单并报告 null。字段失败、未安装及 Herdr 未运行各有明确状态；纯 Web 报告不启动 Herdr。详细采集口径、缓存、错误及清单规则由[上报需求](daynight-worker-reporting.md)拥有。
- 诊断文件 sink 发生临时目录、文件或 append I/O 故障时，通过 stderr 与可用运行监控明确报告，并自动退避恢复。每次运行及恢复使用同一 Worker/启动日期日志族中的新唯一 segment，旧文件与不完整尾行保留，不把未知 append 重放到新段。尚未派发的省略记录与已派发但结果未知的 append 次数分别计量；恢复摘要关联先前失败路径、当前路径及计数，不冒充精确丢失数量。排队有界，日志不作恢复输入；格式化、stdout/stderr 或独立通知错误仍保留错误链。退出在所有事件生产者和存储结束后 close sink，取消重试调度并 join 活动写入。
- stderr 和 JSONL 提供 workerId、实际平台、projectId/taskId/claimId、agent、已知 sessionId 及启动、恢复、等待、清理与错误事件。凭据脱敏后，终端输出将上下文、消息及错误链中的完整连字符 GUID 缩写为首段 8 位十六进制字符，保留大小写；其他文本不变。JSONL 的字段、消息和错误保留完整 ID，供精确检索；API、prompt 与持久化中的 ID 不变。相同 claim 的等待/执行阶段、终端和已知原生会话不变时，轮询不重复记录；阶段切换及会话或终端变化及时报告，不同 claim 独立判断。成功启动建立观察基线，下一轮相同观察不重复提示重连。资源保留警告在连续成功观察中只提示一次，警告消失后再次出现则重新提示。真实启动、恢复、清理、人工操作和失败尝试保留日志；NULL 新建路径记录普通 info。错误保留类型和 cause，凭据脱敏，不输出完整 prompt。
- 完整清单和私有实例就绪后显示 attach 提示；客户端只应用 attachment descriptor 的环境与移除项，原 task pane 保留自己的 native XDG/HISTFILE。
- 许可/平台 UI 的双语、键盘、焦点和响应式行为保持 W-02/W-03。真实 Herdr/native、受控故障、各平台和完整 Goal 验收分别记录来源，文档或模拟进程不替代真实运行证据。

## 可观察验收

| 范围 | 必须观察到的结果 |
|---|---|
| W-01、W-07 | cloud-first、首次原始候选与空项目启动成立，本地托管值不能覆盖云端；缓存身份/损坏/持久化错误明确，receive/apply/ACK 串行合并保留新目标和未确认失败；当前 mode 重新验证 native 历史，部分成功、退避、快恢复及飞行期间新失败正确，实际并发/轮询/恢复/native 消费且健康进程不重启；本地字段与首次候选严格、省略值一致，项目选择明确；assignment 与运行约束完整，且不依赖仓库流程文件；新会话和已知原生会话的完整启动文本均明确充分授权，禁止为 PR 合并等流程性事项重复询问；启动、恢复/延续和周期 ping 一致要求依据事实自主调整并记录重大偏离；普通缺口、方案失败和 review/CI 等待不触发暂停，有证据且无兼容可行方案、须变更已确认约束的严重设计冲突，或核对已有授权并完成其他工作后仍存在的必要授权缺失，触发记录与暂停流程；已知意见优先处置，完整读取、下一行动方、独立权限和无变化去重通过场景评估验证；身份、权限撤回和独立暂停仍受尊重，解决并获准后解除暂停；恢复使用保存的 agent 和当前适用配置；两个 provider 的 fresh/resume 均带固定 full access、目录信任参数或环境，冲突参数和缺失能力明确拒绝；Codex 通过独立启动 argv 关闭更新检查，有新版时不等待更新选择，没有新版时正常进入任务，配置参数和含引号等字符的 prompt 保持各自原值与传递位置。 |
| W-02、W-03 | 默认许可、双向确认、平台清除、未知结果及候选组合过滤成立；assignedTo=me 贯穿全部候选页，他人和未分配任务不遮挡本人合格候选。 |
| W-04、W-05 | 本人可领取，他人和未分配任务的直接 claim 拒绝且保持数据；负责人变更与 claim 竞争遵循项目锁及精确版本；既有库存保留原执行权限；同 task 竞争单赢家；未知 claim 不启动资源或重放；单项目和多项目空闲容量大于一时，每轮合计最多一个新 claim，暂留 pending 也结束本轮领取，下一轮延续项目轮转与候选顺序，候选迭代器正常关闭；已有 pending 同轮仍可按容量启动多个；等待与收尾占容量，同 task 旧资源形成启动屏障；撤回只允许原 owner/admin，原子重置归属/状态/计时并关闭许可。 |
| W-06 | 首次分支使用本次刷新取得的远端默认分支 commit，主 checkout 保持不变；远端不可用或刷新失败、取消、超时不创建新分支或 worktree，既有 dirty worktree 和保留分支在 origin 不可用时仍可复用；不同任务并发创建互不串扰。静态归属、注册、指针与删除核对成立；有效 claim 的缺失 checkout 按原绑定和保留分支重建，未提交内容不承诺恢复，外来路径及身份冲突保持可见错误；原 Git mutation 收尾和 backend 准入仍成立。清理中的目录已缺失、Git 注册残留、最终 unlink 后空目录及无注册空预留目录均能收敛，无关非空目录保持不变且不阻断其他资源发现。操作报错但新观察确认目录及登记均不存在时保留错误并继续结算；资源仍在或观察失败不得冒充清理成功。外层取消不发起新的观察，已准入 mutation 的本地责任仍须收尾。 |
| W-07、W-09（Linux/Windows legacy Herdr） | 活进程重连不重发启动 prompt；意外退出后自动重建并 resume 原 session，替代 shell 初始化期间的明确 busy 拒绝有界恢复，健康 Agent、前台程序占用、身份变化、取消、超时及未知启动结果均不触发不安全重试；idle/done 且就绪、未暂停时 ping；暂停期间多轮零 ping，改为 false 或移除后同一观察恢复 ping；排队或界面等待期间设置暂停时，最终递交边界使用当前服务端值；读取失败及原 claim 换代不递交；首次和待递交 assignment、观察、恢复及清理不受标记拦截。Herdr working/blocked/unknown 保持观察；自定义状态栏及未知可见布局不等待正向识别；已知菜单/禁用输入未递交且不消耗恢复次数，关闭后保留首次与 continuation 机会；窄宽度、长 primary key binding 的 Resume/Fork/restore Session picker 只剩主动作时仍拒绝，展开会话且 inline error 替代搜索时仍拒绝，标题或搜索/列表证据缺失、正文中的动作说明及后续正常 prompt 不误作该菜单；读取后最终暂停/归属检查仍有效。未改变观察和未知回执不触发重复输入；已知原生 ID resume；首次启动与恢复中的 NULL 分支记录 info 后新建并保存 ID；空库先建项目映射再找回已有 claim。标题首先可见，改名按需同步且不改变执行身份，含控制字符/分隔符/长标题；命名故障和未知回执不消耗恢复预算。 |
| W-08 | 人工操作与 run 互斥；远端拒绝保留 worktree；成功后本机删除失败可由下次对账收尾；未知结果不重放；Web 强制撤回不声明远端已停，原 worker 下次对账收尾。 |
| W-07、W-08、W-09（Web） | SQLite 重开保留暂停原因、次数、claim 与原生身份；暂停后多轮 tick、Worker restart、shutdown/clearShutdown 均不准备或启动原生执行、不递交初始输入；旧耗尽停止记录与健康最后一代、健康 orderly restart 成对验证；waiting 首次发布失败后以新版本对账成功且稳定后不重复写；retry 成功与失败均保留原身份，claim 失效、停止证明不足或缺失原生 ID 时安全拒绝；暂停继续占用容量并保留资源。 |
| W-09 | 主索引字段及冻结模式正确，三态/唯一 active；退出取消并等待所有 job 收尾，含正在等待通知、清理轮或停止确认的终止清理 job，随后直接停止并关闭 workspace，不发送清理 prompt、不等待清理轮、不删除 worktree、不把未完成行置 done；归属已结束及原本缺失本机行的任务也保留 worktree、有效 session ID 与未完成行，重启恢复原清理责任、原期限和资源身份，核对实际资源后完成清理并解除同 task 后继的启动屏障；停止错误可见，停止不确定时私有 Herdr 保留。 |
| W-10 | 正常完整清单缺席统一清理，正常完成、release、强制撤回及人工管理均按所属 backend 的资源目标清理；legacy Herdr 通知后的新观察为 idle 时允许开始停止，缺失或不变计数不阻塞；现存资源停止和关闭、同进程在途操作收尾后，重启可按当前完整空资源观察收敛，不伪造历史证明。独立 release 正常返回前退休清单；失败保留元数据，重试不访问已确认的后继 cwd。完整资源身份的首个十分钟期限和每 claim 退避跨重启保持，身份尚不完整时通过未完成索引行重新发现并重新建立进程内退避；Legacy Herdr 的建议性通知在调用中断后允许重复，Web 操作由 Controller 原生回执核对；可控时钟与故障注入覆盖持续失败、上限、串行、公平推进和解除原因后的收敛；归档失败保源、有余量健康任务推进、满槽准确诊断及旧 claim 屏障成立；持久化写失败时进程内退避保留原错误且不妨碍 shutdown；shutdown 不等待退避、不重复归档/删除，原停止证明与 backend-close 失败保持独立；Web done 与调度删除之间中断后的退出重新核验原进程和 endpoint，正常 tick 继续收敛实际 Git 资源；旧资源完成标记及丢失的操作响应不能代替当前观察。 |
| W-11 | 独立报告覆盖空闲、满并发与长操作，清单未知/空/旧及部分字段错误保持区分；采集、单飞、期限、取消与关停满足[上报需求](daynight-worker-reporting.md#验证)。关联日志、Warning、原错误链和脱敏成立；终端上下文、消息及错误链中的完整连字符 GUID 在脱敏后显示首段 8 位，保留大小写且不改变非 GUID 文本，JSONL 各字段、消息与错误仍含完整 ID；attach 只连接并保持既有执行；macOS journal 只读、不迁移或升 epoch，替代端点与不可读证据必须拒绝；验证关联实际源码、平台和环境。 |
| W-05、W-06、W-10（恢复与隔离） | 真实隔离 Git/文件系统和 SQLite 验证清单持久发布、旧格式转换的中断恢复、原 cwd 与 dirty/index/merge 保留；归属、指针、分支冲突及未知格式仍拒绝。已知隔离项计占并允许安全的健康任务领取，同 task 与自身 pending 屏障成立；真实 runtime 遗留映射入场覆盖同项目隔离、外项目候选、无效 Project ID 和无归属证明。归档待修复跨重启保持、只到期探测、不读取 pending/blob、不上传；探测失败不误报恢复，receipt 对账、旧 schema、网络退避与条件变化回归。平台和重启证据分别报告。 |
| W-07、W-09、W-10（macOS Herdr） | 先持久原身份后输入；全部自动输入最终检查暂停与准入；暂停及 manual/suspended 多轮巡查不消耗失败预算，false 或移除后同一观察在满足控制条件时继续；首次及延后 assignment 的确定零写入保留 pending、正文与稳定身份，仅传输完成后建立基线；暂停期间合法 owner 能获取、续约、输入和释放，释放后保持 suspended，解除任务暂停不自动交还，暂停时显式交还拒绝；排队、readiness 和第一帧前暂停零写入，paste 后 Enter 前暂停保持 unknown/suspended 且不重放；非法身份、读取、存储和传输故障仍暴露；暂停抑制 cleanup 提示但不阻止受控停止；无启动来源、原 ID 未知、launch/input/stop unknown 不新开对话；重连只改 epoch，同 Session 换代先确认原停止并标记段间断；同次 launch 内只有明确 shell busy 拒绝及初始化证据允许最多两秒重试，未知响应或崩溃不重放；停止、封段与 ledger 丢响应均可恢复，未确认发布不重放；终态清理的原运行停止证明提交后释放执行槽，隔离资源仍保留文件责任与同 task 屏障；归档前保留工作区与同 task 屏障；cleanup 提示受持久仲裁约束，manual/unknown 时不发送。 |

完整平台运行验收要求其实际门禁与端到端结果，组件检查和 schema 验证不能替代。
