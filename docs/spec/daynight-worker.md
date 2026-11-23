# Worker 需求

本文定义 `daynight worker run` 的行为与可观察验收条件。[整体架构](../design/daynight-worker.md)拥有运行机制，[认领架构](../design/daynight-worker-claims.md)拥有服务端归属协议。账号级运行快照的服务端契约由[快照需求](daynight-worker-snapshots.md)拥有，客户端采集与持续报告由[上报需求](daynight-worker-reporting.md)拥有；在线状态和近期可见性不参与 claim 资格、执行控制或本机恢复。命令可用性与组件验证不替代 Linux、macOS ARM64、Windows 的完整原生运行验收。

## 目标与范围

Worker 是前台常驻进程，通过进程内 typed ApiClient 和 REST API 领取配置仓库中允许 Agent 执行的 ready task，在系统管理的 Git worktree 中按冻结的 Web 执行配置运行 Copilot、Codex 或 Claude。服务端拥有资格、权限、唯一 claim 和完成操作；worker 拥有调度、资源、对账和清理；agent 拥有业务交付、验收、证据及最后一次 claim-bound done。

Worker 必须采用状态驱动的 reconciliation。期望归属来自服务端完整自有 claim 清单，实际资源状态来自 Controller journal、操作系统、Git 和文件系统；归档完成来自服务端回执。本机主索引保存项目映射、认领、原生会话身份和新 claim 的原生配置冻结。清理记录只保存资源身份、控制意图、期限和重试策略，不能用操作完成标记替代重新观察。Web 保留执行配置、恢复预算和原生操作身份，并从 Controller 拥有的回执与进程实例证明读取原生事实，以满足 [Task Session 需求](task-sessions.md)的未知结果不重放及单 writer 要求。旧 Herdr 资源由用户处理。

独立 Bot 的本地库存与启动意图由[Bot 库存需求](worker-bot-inventory.md)拥有，使用相同 Worker 锁和 SQLite 格式，不参与 Task 容量计算。[Bot 运行需求](worker-bot-runtime.md)拥有原会话恢复和退出停证：取消管理工作后逐项停止并汇总错误，保留 Bot、原 Session 和私有恢复资料，不调用 StopTest 或归档作为退出前置。正式 `runWorker` Bot 调度与能力广告尚未启用。

## Worker Reviewer

Worker 在账号和 Worker 身份核验后，独立轮询服务端分配给该 Worker 的待审 PR。只有完整分页成功才能采用名单；明确停用立即撤销资格并停止准备或运行中的审查。读取失败不视为 PR 关闭或归属撤销，不取消已开始的审查；开发 Task 和心跳继续。GitHub 状态、CI、反馈和发布结果仍由 reviewer 核对，旧独立 reviewer 的初始化编号下限不适用于服务端候选。重复候选不得重复同一轮发布，目标变化和反馈解决沿用复审规则。

Reviewer 在预留前取得 user、project、worker 三层独立 prompt；首次未知或明确失权时等待，临时读取失败可复用最近确认的值。启动意图和实际 Copilot spawn 前复核候选来源与捕获的有效代际。已持久化的未知发布必须先排除原进程并只读核对，停用和重启不消除这项责任。Reviewer 不注册 Daynight Session。Worker 退出前结束 reviewer；无法确认进程停止时保留锁与证据。

Worker reviewer 使用 `~/.daynight/reviewer/`，`DN_CONFIG_DIR` 重定向时使用其 `reviewer/` 子目录。旧独立 reviewer 的状态和 worktree 不读取、不迁移、不清理。详细机制见 [Worker Reviewer 设计](../design/worker-reviewer.md)。

## 本地模型与推理强度覆盖

`worker.agentModel` 与 `worker.agentReasoningEffort` 独立可选，仅接受非空且不含控制字符的字符串，长度分别最多 256、64 个 UTF-8 字节。null、空串与错误类型明确拒绝，并指导删除字段恢复继承。旧 `worker.model` 保留首次导入语义；同层旧非空值与 agentModel 相同可用、不同拒绝，旧 model:null 不阻止新值。

每项优先级为本地新字段明确值、当前云端有效同项值、Agent 原生配置。已登记云端目标仍应用本地覆盖；移除字段后重新启动 Worker 恢复下层有效值。其它云端托管项的权威保持。新字段不能导入或回写到云端 desired，来源报告必须与云端目标分开。

规范化现有模型和 effort 参数后只生成一个最终值：本地字段优先，云端 model 字段优先于同项 args，重复参数按原参数顺序取得最后值再规范化。按当前有效 Provider 使用对应 SDK/RPC 校验；不改 Agent 配置文件。设置任一本地新字段时，最终明确设置的模型/effort 必须在实际首次启动上下文核验；未知、无能力或不支持组合明确失败，不能猜测或静默降级。Daynight 未配置的项保持原生默认。

新 claim 的原生 Agent/model/args 在首次登记或旧无会话记录的首次启动前持久冻结，重启恢复不能以当前默认覆盖。历史记录没有已知冻结配置时不能伪造旧值；已有原生 Session 的恢复省略 model/effort 覆盖，保留原生会话状态。既有助手使用原冻结配置，后续本地变化只影响新执行。

机器遥测 `runtimeConfiguration` schemaVersion=1 独立报告全局 native 和逐 Project native 的 model/effort 值及 local/cloud/native 来源。null 与 native 来源表示交由原生解析，不证明实际原生模型。不可用配置用 native:null 表示；移除本地覆盖后的新报告必须更新来源。旧客户端省略该对象仍合法，新对象要求支持其格式的服务端。

## 本地工具路径解析

`worker.toolPaths` 是可省略的 mapping，仅允许 `codex`、`copilot` 两项。省略整个 mapping、缺少某项或某项为 YAML null 时，该项选择自动；空串、纯空白、错误类型、未知工具名及整个 mapping 为 null 均拒绝。两个本地配置入口必须输出完整两项 `ToolPathChoice`，每项为 `{kind:"auto"}` 或 `{kind:"path",path:string}`。

显式值必须是 Worker 所在平台的绝对文件路径，每项最多 4096 个 UTF-8 字节，必须是合法 Unicode，且不含 NUL 或其它控制字符。Windows 路径必须带盘符或完整 UNC share，不能依赖当前盘符。路径中的合法空格、Unicode 和标点逐字保留，不 trim、不规范化、不展开 `~` 或环境变量、不拆分参数、不执行 shell。整个字符串作为一个文件路径，原生参数继续由既有参数配置拥有；文件存在性、可执行性、入口格式和解释器属于工具解析器的检查。

本地配置识别和共享解析器是独立的基础能力。云端配置通过独立工具能力协商交换三态目标和逐项首次导入，合同由[配置协议](daynight-worker-configuration.md#工具路径三态)拥有。Task、Bot 的 Web Codex/Copilot 运行入口和版本/能力探测消费同一冻结选择；保存或解析成功不得报告为路径已应用，不改变既有执行的工具选择。独立 Controller、Claude 和 Agent 内部 CLI aliases 保持各自既有配置归属。

共享解析器只解析给定选择，显式路径失败不回退其它安装。自动 Codex 从捕获的 Worker PATH 查找；自动 Copilot 选择随包 native。Node 脚本固定使用 Worker Node，不能因入口位于 nvm 目录便切换解释器。npm shim 从有界快照提取 Node 目标，不执行 shell 文本；注释和无害格式变化不得仅因内容未登记而拒绝。Codex JavaScript loader 作为普通 Node 入口运行，由 loader 选择 native，不按发行摘要或固定 native 布局准入。

解析结果保留入口、真实路径、工具程序、解释器、结构化命令和参与文件的内容身份。冻结 recipe 按其记录核验，不重新读取当前配置或搜索 PATH；记录的入口映射或文件内容改变时明确失败。新执行候选校验发现身份改变时，同次调用先确认旧探针清理，再按当前选择重新解析和探测；清理未确认时不得启动新探针。已有执行仍使用原冻结 recipe 和进程身份。命令构建返回 `file` 和独立 `args`，不能交给 shell。解析、核验和刷新受 operation 预算及取消约束；版本、协议、认证和真实会话可用性需要运行消费者独立验证。

## 必须满足的行为

### W-01：前台运行、配置与平台

- `daynight worker run` 在前台运行，支持 Linux、Windows 和 Apple Silicon（ARM64）macOS，不支持 Intel macOS，遵守[客户端平台要求](daynight.md#c1-包与平台)。实际平台枚举仍为 windows/linux/macos；WSL Linux 计为 linux，未知平台明确拒绝。
- 云端目标管理 maxConcurrent、pollIntervalMs、recoveryLimit、preferPlatformSpecificTasks、enableSudoCleanup、enableWindowsProcessCleanup、archiveSessions、taskTagFilter、项目选择及全局/项目级 Agent、model、args；repositoryRoot、本机路径、服务连接与凭据、workerId 以及可选 agentModel/agentReasoningEffort 留在本地。内部配置只应用可用的 Web 目标；执行资格依赖同步后真实采用并持久化的配置，保存目标、迁移与在线心跳不能代替应用证据。schema 1–11 自动迁移至 schema 12。含旧模式或第三工具的原始目标保留但不可应用，不自动转换；未采纳的必需工具不能取得执行资格。[配置协议](daynight-worker-configuration.md)拥有目标版本、逐项观测及服务端权限。配置同步不要求 active claim；标签筛选通过候选身份和已应用摘要约束后续新认领，原 claim 的恢复、执行与清理继续保持。
- 启动先读取同一份服务、身份、repositoryRoot、mode、本地工具选择及新原生覆盖字段快照，取得原实例锁并认证，再查询云端目标。身份读取遇到临时网络故障时，在原锁下按 5、10、20、40、60 秒封顶退避恢复；确认认证账号前不读取跨账号缓存或授予执行。首次配置 GET 的临时故障保持“未读取”，由报告周期重试；认证、协议、格式和确定不兼容错误明确失败。已有云端值时不解析本地托管字段作为运行权威，不执行项目选择引导；旧本地托管值不能覆盖云端，agentModel/agentReasoningEffort 按本地覆盖规则组合。配置和报告不提交旧模式 bootstrap 或模式 observation。`projects:[]` 是合法配置，正常 run 不因项目为空失败或弹出选择流程，也不创建虚假 Project、Task 或 worktree。空项目不消除原 Task 库存和清理责任。
- 当前 service origin、认证账号和 workerId 验证通过的配置 GET 完整安装服务端 desired 与 observationRevision，包括较低计数与 desired:null；同 revision 的双方可见目标语义不同仍为协议错误，既有能力投影的比较例外由[配置协议](daynight-worker-configuration.md#worker-响应的未知内容保留)规定。匹配本机捕获的合法报告回执更新目标与观测基线，迟到的较低 desired revision 不回退已收到的目标，只结算其原捕获的观测；回执暴露较低计数时重新认证读取，确认服务是否回退。已知目标变化或权威回退建立新的本机 generation；仅未知字段、updatedAt 或更高 revision 变化保留 applicationRevision、generation、记录身份和应用 job。旧本地意图不能压过认证权威。结构合法但超过本机支持限制的目标仍保留为准确权威，关闭新准入并等待后续合法状态。
- 服务端首次未初始化或从已有目标变为 desired:null 时，Worker 自动按同一首次导入合同准备当前本地文件候选。每轮候选读取一个一致 source 快照，完整候选及工具采纳字段来自该候选；项目覆盖保留省略、model:null 与 args:[]。没有完整候选时，工具采纳使用启动时本地选择。运行中的 origin、凭据、workerId 及本地执行覆盖保持启动归属；文件改指其他 origin/Worker 时明确拒绝，不热切换。候选由 root 生命周期拥有，每 pass 最多 60 秒，报告 Operation 只取消等待者；失败后按后续报告周期重试，相同 source hash 与认证范围可复用成功的项目解析。明确候选拒绝使解析缓存失效，服务端仍执行最终权限校验。准备期间继续读取服务端，已有目标优先并取消、等待旧候选结束；未知导入结果先 GET，不重放旧请求。并发导入仍只建立一次初值，候选不承诺还原服务端丢失的旧配置。
- 未接入前，独立 worker mapping 支持 repositoryRoot、maxConcurrent、pollIntervalMs、recoveryLimit、archiveSessions、preferPlatformSpecificTasks、agentControlMode、agent、model、args 和 repositories，首次候选默认值依次为 ~/daynights、1、60000、3、true、false、web、copilot、null、[] 和 []；显式本地 herdr 候选明确拒绝并提示改为 web 或删除该字段；repositories 不从 review 推断。本地候选和运行项目集合最多 128 个不同 Project；标量与 native 的容量遵循[配置协议](daynight-worker-configuration.md#目标配置)。缺失文件或省略可选字段使用这些默认值。只有确实缺失的文件按缺省处理；YAML 结构、重复键、本地字段、首次候选的已知字段、读取故障及取消均严格校验。未知根、review、worker 和仓库字段在投影时忽略，CLI 编辑保留其节点，读取不重写配置。
- 首次候选中的仓库提供 remote，可有 projectId 与逐字段 native 覆盖；导入只投影 Project 身份及覆盖意图。本机绑定实际使用时校验 path：相对 config.yml 目录或为绝对路径，不展开 tilde，拒绝 drive-relative Windows 路径和重叠仓库/状态目录。相同 Agent 类型逐字段继承；切换类型清除未显式给出的 model/args。Args 整体替换，模型与 effort 参数按规范化规则合并；其它参数不允许覆盖 worker 拥有的 cwd/session/mode 或固定 full access 策略，冲突在本机应用前明确拒绝。
- Worker 在自己的状态目录保存 schemaVersion=12 的 configuration.json，严格校验 service origin/userId/workerId。authority 以完整 desiredJson 为唯一目标事实，known 只作为派生视图；applicationRevision 锚定最近已安装的已知目标，observationRevision 与本机 generation 分别保留。schema 12 的必需布尔值 pendingApplication 表示当前 raw 目标尚未建立可应用账本：未初始化或不支持目标为 true，已完成 Web 目标协调为 false；false 不代表各项副作用已成功。重启后保持该区分，后续可用 Web 目标即使恢复为先前内容也须重新协调，并保留原移除与失败责任。可选的 hiddenCapabilitySources 保存同版本能力投影隐藏的已收字段源事实，不进入当前目标或应用；早期没有该字段的 schema 6 经迁移后仍可读取。remoteObservation 单独保存最后显式 GET 的完整远端观测及版本，可落后当前观测基线，服务回退或 null 重置后也保留原快照，不与当前计数混作同一时间线；它不进入本机执行或上报账本。currentItems 记录当前已知应用与核验，retainedItems 保留原工作、停止、未知结果、未确认失败及必要实际值。recordId 全局唯一，origin 不可改写；复用实际值保留 actualSource。待停止引用必须指向同项目的移除记录且无环。
- 已部署版本 1–11 按各自原结构严格解码，再转换为 schema 12。1–4 沿旧入口进入 schema 5，再保存 desiredJson 和 applicationRevision；无旧远端快照时 remoteObservation 为 null。版本 1 补平台优先字段，schema 4 无法确定的原成功版本保持未知。schemas 1–8 转换删除 nativeMode；只有能够证明为 Web 的历史 native 实际值与来源可保留，仍须本进程重验，其余历史 native 值、来源及相关失败失效。schema 9、10 的其他 Web 账本项不受该历史模式转换影响，schema 10 的历史模式记录保留。历史模式项不能证明当前采用，迁移不再生成模式应用项。schema 12 重启恢复其余持久项，但重新同步可应用目标前不授予执行资格；旧模式或第三工具成员作为未知原文保留；当前已知设置合法时，首次收到同一权威目标也必须协调原先 pendingApplication:true 的目标并持久保存结果。恢复的历史应用值不能代替本进程的原生核验。保留 raw desiredJson、remoteObservation、hidden sources、sudo provenance、recordId、origin、失败编号、started 移除及其 blocker；generation 更新、游标归零。旧格式此前未知的 enableSudoCleanup 或 archiveSessions 在目标可见且对应记录不存在时重新建立核验，有可复用的已确认实际值时保留其来源，否则补 pending/null。schema 12 之前的格式都不认识 enableWindowsProcessCleanup：schema 11 在目标可见且对应记录不存在时建立 pending/null，更早的格式把该成员保留为未知原文，宣称已应用该项的旧账本被拒绝。旧 opaque 目标中的 taskTagFilter 新识别后先建立 pending/null，不从目标伪造已应用摘要；原 pendingApplication、项目事实和真实目标版本保留。applying 沿原重启规则恢复。必需字段缺失、未知格式、损坏及身份不符明确失败，不猜测默认配置。迁移冻结并原子保存后才 ready，失败保留原文件和错误。
- 缓存以分块方式读取和原子写入，容器总大小不受单个 JSON 字符串上限限制；读取必须在真实 EOF、严格 UTF-8/JSON、完整结构及身份校验后才发布。历史合法结构不因当前单项业务容量限制而拒绝。单 token 仍受运行时表示上限约束，本机全部事实仍占用相应内存与磁盘。
- 缓存中的 native 成功历史不能直接供新进程执行。全局和项目 native 在真实 Web 上下文验证，并绑定本进程、recordId、native 元组及相关工具选择和 selectionKey；只有 Provider 实际需要的 Codex/Copilot 必需项可阻止验证，第三工具不用于配置准备。目标优先验证，目标失败后可重新验证已证明属于 Web 的历史元组；历史恢复不把失败目标标为 applied。缺少证明或验证失败时保持 unavailable。相关工具选择或 selectionKey 变化撤销对应证明，无关健康证明及原执行身份保留；新目标和重选项目只能沿用仍由原记录拥有、与真实选择匹配的本进程证明，actualSource 不授予资格。等待重验的当前项保持 pending，持久提交后才发布验证结果。
- 云端响应中未知成员和未知 observation kind 作为合法 JSON 原始文本保留，覆盖对象、数组、null、负数、小数、指数及超安全整数；网络解码、缓存和重启不得经 number 舍入或丢字段。只从已知路径派生严格类型、必填、范围、身份与 revision 校验；重复解码键、深度和既有字节边界保持。未知项不产生 pending/applied 或执行；报告仅包含本实例已知结果。应用侧工具目标、native 证明、项目准备确认与新增移除记录使用 applicationRevision；报告 envelope 使用最新 desiredRevision，各 item 保留真实 targetRevision。
- 单一串行提交 owner 合并目标接收、应用完成与报告确认，从最后已提交状态计算并冻结下一状态；原子替换成功后才发布不可变实际视图，不能互相覆盖更新结果。已知目标变化为当前核验建立新 recordId，仍有责任的原记录继续保留；未知-only 更新不重复应用、不重启 Agent、不重新准备未变项目。原停止真实结束后，当前目标的独立停止核验通过原适配器重新观察资源；重新选中的项目在该核验完成前不能准备或声明 ready。启动本机映射的停止核验须在可用认证目标下被 manager 实际接纳后才算覆盖；未读取、null 或不支持目标不能提前消耗这次核验，后续恢复须重新检查，缓存成功不代替当前 coordinator 的资源观察。本机责任登记和目标安装不依赖所有历史记录同时进入一次网络报告。
- 初始化读取、目录创建、迁移保存及运行期检查点发生真实文件 I/O 故障时，Worker 按 5、10、20、40、60 秒封顶退避自动恢复。格式、身份及其它确定错误仍明确拒绝，不把损坏文件或未读取状态变为空缓存。运行期保留最后已提交的目标、实际值、项目视图及原资源责任；存储未就绪时关闭新配置工作及新执行准入，未保存结果不能声明 applied。
- 每个队首只从最后已提交状态计算并冻结一次下一检查点。写重试使用同一状态、同一编码计划和新的 iterator/临时文件，不重跑已完成 apply/stop 或再次生成身份。普通读取与接收在共享 readiness 等待，有限原 job 的完成结果及可信报告回执仍由 manager 保存。调用者的 Operation 取消或超时只移除等待者，不撤销已拥有的结果、改称远端未知或重放旧报告；存储恢复后顺序发布并唤醒后续同步。
- Task 的 configurationComplete 和 Bot 的真实新执行门禁须同时核对存储就绪、已认证的非空目标与当前有效配置；异步准备后、首次持久意图/注册/派发前再次检查。desired:null 恢复、权威未读取、不支持目标及临时不就绪期间关闭新准入，保留原协调器的资源核验视图，不能发布“项目全部移除”的假目标或从本地候选取得执行资格。冷启动原执行恢复继续使用真实本机项目映射、冻结原生元组和已保留的真实 recoveryLimit 应用值；无已知策略时保持未知，不能从本地候选或默认值补造，也不能把恢复视图当作新准入配置。已有提交、未知提交和原生会话恢复保持原生命周期；原冻结执行的恢复、输入、停止与清理仍服从其原身份、权限和资源证明。
- 配置随独立心跳交换，在心跳之外逐项应用。foreground 和实际使用配置交换的管理路径共用“持久化就绪→权威读取/候选准备→新采样→捕获→generation 检查→发送一次→接收并持久化回执”的顺序；准备或采样期间权威变化时丢弃旧样本，后续周期重采。正常已同步周期不增加 GET；启动、未知结果、400/协议失败及能力重发现先做认证 GET。维持 30 秒单飞、触发合并及原有限 prompt 批次规则。已成功的普通标量、全局 native 和各项目 native 独立生效，一项失败不回滚其他成功项；从未成功的项为 unavailable，不能以目标值或默认值冒充实际值。原生校验、仓库或停止等外部操作不占用缓存提交队列，也不阻塞后续报告。旧目标结果提交时必须重新核验记录绑定、目标内容及真实证明。
- 配置诊断使用真实阶段和可信固定原因，关联 Worker、key、原项 targetRevision、当前权威/观测基线、generation、recordId/reportId、syncId 及可用 requestId。未读取、未初始化与有效 "0" 基线分别表达；可信远端回执后的本地落盘等待保留 confirmed/pending，不因等待超时或日志失败变成远端未知。首次失败、原因/相关目标变化和真实恢复立即记录，同因持续失败在现有周期每五分钟最多一条摘要，实际发生次数与封顶退避档位分别记录。原始输出和凭据不进入配置诊断，formatter/通知失败保留独立错误链，不改变应用、确认、lastFailure 或重放规则；[报告需求](daynight-worker-reporting.md#配置交换)拥有详细词汇与验证条件。
- 失败项按 5、10、20、40、60 秒退避，仅重试失败项，新目标替代旧应用重试；已开始的项目移除保留原版本工作及结果直至确认。报告捕获绑定本机 reportId、generation、精确 baseRevision、实际 observation、recordId/failureId 与轮转游标。只有当前 generation 的 observationAccepted=true 回执确认实际发送且仍匹配的失败与游标；飞行期间的新失败继续保留。当前捕获被拒绝时采用回执的完整规范状态，不重发旧包；observation:null 对应的 false 是未提交观察的正常回执。旧 generation 的任何回执不能改变当前目标、基线、失败或游标，已知远端结果仍保留其原含义。诊断使用闭合 code/category/phase，不上传命令、原始输出或凭据。
- 同一个 coordinator 消费最近成功配置。提高并发供后续调度使用；降低上限不抢占已有任务，占用低于上限后再启动其他任务。pollIntervalMs 作用于完整轮次后的下一次等待，单位毫秒，缺省为 60000；合法显式值（包括 5000）保持其含义。recoveryLimit 供既有恢复逻辑读取。preferPlatformSpecificTasks 只影响后续新任务领取，其 false 应用值与尚未应用的 null 分开。参数更新不重启健康原生进程；新 claim 使用已采纳 Web 的实际 native。旧 Herdr claim 和资源由用户处理，不因配置切换而恢复、迁移或自动收尾。
- 项目选择与本机项目映射分别管理。云端新增项目复用已有映射，否则在本机 repositoryRoot 生成路径并准备仓库；只有确认准备成功的项目进入有效集合。独立项目的准备失败不得阻断健康项目，native 验证成功本身不证明仓库已准备。
- 移除项目先排除调度，再停止该 Worker 在项目中的 Web 执行，保留任务状态、认领、工作区和会话历史；旧 Herdr 资源不进入此操作。有效集合约束 active、pending、新领取及在途领取完成后的启动；项目仍被排除时，普通轮询与重启不能自动推进。停止未确认的资源继续占用容量，已确认停止而仅保留现场的资源不永久占用执行槽。失败按项目报告并重试，已开始的移除保留原目标版本直至确认；重新加入后的任务行为遵循既有恢复和人工操作规则。移除不能删除用于归属清单、资源发现和人工处置的本机映射。
- 运行中断网继续使用最近成功值；重启先核对云端再开始正常调度，本机副本不取得权威。配置接收、缓存与报告不依赖任务清单同步或业务后端初始化成功。空项目、业务准备失败及长操作期间继续心跳；任务执行仍服从原有归属与恢复准入。
- `daynight worker setup` 在云端目标尚未建立时要求 stdin/stderr 为交互终端，先汇总环境缺项与修复指引，再单选 Copilot/Codex/Claude 并多选既有可访问 Project。重复配置预选当前项目；最终确认前展示 agent、Project、目录、移除范围及不兼容参数重置。所选 Agent 应用于全部选中 Project；匹配注册保留传输 URL/路径，同类型 model/args 保留，切换类型清除不兼容值。最终把 native 字段与完整选择一次原子保存；取消、空选、认证/API/保存失败均无部分保存。
- Setup 只做有界只读环境探测，检查操作系统、Node.js 和 Git，不启动 native agent/worker，不 clone、打开 SQLite、claim、安装或登录。缺失的通用依赖允许保存并明确要求修复；Controller 在递交任务输入前验证原生认证、能力和工作目录身份。Git 传输与任务专用工具在实际使用时检查。取消等待已启动探测收尾，未确认清理故障保留原错误链并使 setup 明确失败。
- `worker repo list [--json]` 读取本地注册；未接入时 add/remove 选择远端现存可访问 Project。省略 --project 时多选显示名称、完整 UUID、repoUrl，至少选一项；显式 --project 支持非交互。新增保存 projectId、原 repoUrl、绝对 path；匹配既有注册保留传输 URL、路径和覆盖，remote-only 项只补 projectId。删除本地候选注册保留 clone、claim、worktree 和原生历史。云端目标已建立后，setup 和本地托管字段写入明确指向云端修改；缓存缺失不代表未接入，写入前核对云端归属。
- worker.repositoryRoot 独立于 review，只在新增本机路径时展开，改变根不移动已有路径。本地 repo 操作拥有 worker.repositories 及保留条目的 projectId；setup 另拥有全局 agent/model/args 及确认重置的仓库原生字段。最终云端归属检查紧邻取得本地锁之前；锁内重读并拒绝相关身份、服务/凭据、根和仓库变动，保护其他解码值及保留条目的未知字段；显式删除拥有整个所选条目。共享 alias 影响非归属值时拒绝保存，无关字段、注释和安全 alias 保留。网络与提示不持配置锁。
- 首次启动随机生成稳定 workerId，复用配置锁与原子替换保存到配置根下的 config.yml（DN_CONFIG_DIR，缺省 ~/.daynight）。身份创建只拥有根字段 workerId；根循环 alias 等使未知或其他非归属解码值变化时拒绝保存并保留原文件。合法值只读复用，非法值拒绝，身份持久化后才可 claim。每个配置根只有一个 worker 实例，其 worker/ 保存配置副本、SQLite、实例锁、日志和临时资源；同根第二实例拒绝，端点路径不合法明确失败。DN_CONFIG_DIR 必须是绝对路径；根选择同时覆盖 Controller 与 Review 状态，不改变真实 HOME、Provider 登录及项目 worktree。不同根不得独立管理同一个任务 worktree。
- 一个状态目录用于当前配置的单一服务、账号和 workerId。切换前先结束旧执行，再重建本机状态；不提供跨服务或跨账号的旧执行自动接续。原终态清理期限、重试调度及 macOS 原运行的持久停止责任保持原有语义。

### W-02：Agent 自动执行许可

- Task 具有独立的布尔字段 `allowAgents`，表示是否允许 worker 自动领取并交给 Agent 处理。它与用户身份、项目权限、实际执行者及 agent 类型独立。
- 旧任务通过数据库迁移设为 `true`，保留其余业务数据、版本与时间；新任务始终默认为 `false`，创建输入不能直接启用。负责人未变的普通字段更新未提供此字段时保留原值，显式 `false` 表示关闭。顶层 assignedTo 实际变化则按[负责人契约](daynight-task-assignment.md)原子关闭许可，状态和 worker 生命周期写入保留负责人。
- 服务端、CLI 和 Web 一致支持许可的查询、展示与明确操作。完整 task 与图节点必填布尔 allowAgents，严格拒绝缺失、null 或非布尔响应。CLI 的 update/list/ready 使用 `--allow-agents true|false`。Worker 的自动候选查询组合 allowAgents=true、assignedTo=me 与实际平台兼容筛选，并在后续候选页中保留全部条件；实际平台由执行运行时识别，未知或不支持时等待。自动认领在服务端事务中重验负责人等于认证账号 userId、许可、ready、平台、精确版本和唯一归属，自动选出的 ID 不构成人工指定。普通技能不提供自动候选选择或连续调度；worker 和 agent 不得自行启用许可。
- Web 在任务详情标题下的状态行右侧提供单一“自动执行” / “Automatic execution”标签与开关组合，左侧保留状态、ready 与可选平台信息。详情不重复展示独立自动执行状态 badge 或下方 Overview 开关；列表中的状态标记可保留。长标题与窄屏不得重叠或横向溢出；普通 Task 的 `todo` 详情中，ready/blocked 徽标与自动执行标签共用随根字号缩放的 `xs` 字号；同一实际行上的徽标、状态与平台控件和自动执行组合垂直居中。平台等左侧信息与完整的自动执行组合按实际内容宽度换行，右侧组合控件保持右对齐，不夹在多行左组之间；600px 及以下继续由状态行统一换行。锁定原因由该控件的 tooltip 提供鼠标悬停与键盘聚焦访问；错误、未知结果和等待人工输入的说明遵循[Web 提示规则](daynight-web.md#必须交付的行为)，使用不挤压阅读区的限时气泡，保留恢复操作。当前详情观察到自动执行设置提交成功时显示浮动气泡，3 秒后自动消失且不占正文高度；后台刷新、语言切换和重开已确认的详情不重复提示。
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

自动领取同时要求 assignedTo 等于当前认证账号的本地 userId、allowAgents=true、ready、平台兼容及没有 active claim。自己指登录账号，不是 workerId；未分配或分配给他人的任务不能自动领取。服务端在同一项目事务中重验成员、精确版本、负责人、许可、平台、依赖和归属，直接调用 claim 接口同样受此限制。新 claim 必须显式指定 web，缺失或 herdr 均拒绝；执行摘要只允许更新 Web claim；新 claim 和更新请求均拒绝 `herdr` 成员，包括 null。新 Web 归属省略该字段，读取兼容旧 Web 的 null。历史 Herdr 记录仍可读取，active Herdr 不接受 claim-bound 完成，人工 release/withdraw 不受影响。同 task 跨机器和 worker 只有一个有效 claim，竞争失败方不得启动资源。既有 active claim 的恢复和完整库存仍按原执行归属核对，不因本规则自动撤回；已释放任务通过普通资格认领。

- 自动领取必须在远端写入前跳过仍有同 task 旧资源的候选。每次取得新的执行使用 fresh claimId/worktreeId；稳定 workerId 和项目映射先保存，实际授予后登记本机 pending。未知响应记录 Warning，不创建资源、不重发原请求，通过完整自有清单及原 Task 读回核对实际授予；同版本或仅清单缺席不能排除迟到授予。旧 Herdr claim 和资源交由用户处理，不进入新执行准入或管理。
- Task properties 保存受保护的最新 worker 归属、实际平台、agent 和已知会话摘要。普通 create/PATCH 拒绝写 worker，即使 null 或原值；PR 与 worker 更新相互保留。完整 DTO 中 worker 缺失表示没有保留归属，存在时为合法对象；读取不注入 null 默认值。
- 会话摘要、释放、撤回与完成核对当前 claim 和精确版本，旧执行不能覆盖新归属。服务端验证当前成员与 owner/admin 权限，不远程证明机器进程或 Git 内容。
- Worker 直接调用进程内 typed ApiClient，不启动 daynight 子进程。HTTP 独立有界；未知写入只读取核对，不自动重放。远端 phase 和 nativeSessionId 是展示投影，历史 Herdr 属性只读，不替代本机实际资源观察。

### W-05：调度与全局并发

- 每轮调度在所有配置仓库中合计最多领取一个新任务；确认授予后结束本轮领取，即使任务暂留 pending 或仍有空闲名额。后续新领取等待下一轮，普通轮询在本轮完成后等待 pollIntervalMs，配置或有效容量变化可提前唤醒，再从下一项目继续轮转；空项目可以跳过。preferPlatformSpecificTasks 默认 false，候选按既有项目轮转与项目内 createdAt、id 升序选择。为 true 时先在全部可领取项目中查找 requiredPlatform 等于实际运行平台的任务；该类别没有可领取项时才进入 requiredPlatform=null 类别。两个类别各自保留项目轮转及项目内 createdAt、id 顺序；一个类别的扫描、跳过或成功领取不得改变另一个类别的项目轮转位置，优先级跨项目和全部候选页生效。例如项目 A 的较早不限平台任务不能排在项目 B 的较晚当前平台专用任务前面。配置更新对后续新领取生效，已取得的 claim 继续原生命周期。
- 已有 pending 优先启动，项目内按稳定 task_id 顺序选择，每成功分配一个名额后轮转到下一项目，同轮可按容量启动多个已领取的 pending；平台优先不改变该规则或抢占已有执行。
- Active 从启动或恢复前预留执行名额；等待 CI/review、人工输入及恢复超限仍占用。终态清理确认精确原执行已停止或权威来源确认未启动后释放执行槽；停止未知或仍运行继续占用。容量按 claim 去重，包含没有本机行的孤立执行。文件、归档及隔离责任各自保留；同 task 旧 claim 屏障不随执行槽释放，Web 的纯归档责任不构成该屏障；已排队恢复先占名额，旧停止观察不能豁免新运行。
- Pending 在没有实际运行资源时不占名额；同 task 旧执行停止、关闭 workspace 并删除 worktree 后，新 claim 才能 active。降低上限不抢占已有任务。并发上限约束本机 active 资源数，迟到授予可以留下等待名额的 pending。
- 空或不兼容仓库不占名额。同仓库不同 task 可以并发；各 task 的操作串行，不同任务的有界等待和清理互不阻塞。
- 本机已有 active 且仍归属的任务先排队恢复，在任务串行操作内读取当前执行；其他工作区的全局 Git 发现错误不阻塞已有名额。新的 pending 启动和新 claim 分配要求完整自有清单、目标仓库资源枚举和可证明的执行容量；可定位的其他仓库格式准备失败只关闭其文件 gate。无法界定的来源或执行责任不能假定为空。
- 完整枚举中的单项受管资源校验失败，可以隔离并继续调度健康资源，但必须由本机持久执行或当前自有 claim 等独立证据确认完整 projectId/taskId/claimId/worktreeId，且仓库及唯一固定注册位置无冲突。隔离项保留资源责任；原执行停止未知时仍占容量，精确确认停止后不再占执行槽。隔离项仍阻止相同 task 的其他 claim 和该隔离 claim 自身的 pending 启动。隔离不证明资源可恢复、可写入、可删除或已经消失。
- 不完整枚举、不可定位的受管注册、owner 或 worktreeId 矛盾、未知数量无可靠上界时，保留全局新领取门禁，容量报告未知或过期；不能用历史快照数量或固定一个槽位估计未知责任。局部失败恢复后，正常下一轮观察重新验证并解除隔离，无需重启或修改任务依赖。

### W-06：稳定的 task worktree

- 分支为 `daynight/<taskId>`，新目录为 `.worktrees/daynight/<worktreeId>`；转换的旧执行保留原 taskId 目录和冻结 cwd。首次创建分支前刷新 origin 的远端默认分支，并以本次取得的 commit 创建分支；首次 clone 也遵守此规则。远端 HEAD 无法获取或不是可用 commit，或刷新失败、超时、取消时报告错误，不从本地旧基线创建分支或 worktree。主 checkout 的分支、HEAD、工作区内容及本地主线保持不变。
- 保留分支从原 tip 使用；仍有效 claim 正常复用 dirty worktree，不 reset/clean。复用已有分支或有效 worktree 不要求 origin 可用。准备时允许通过检查及非递归 rmdir 清除 mkdir 后、Git add 前中断留下的无注册空预留目录，再正常创建；不采纳非空外来目录或别的 claim 的注册。普通退出、失败和崩溃保留其 worktree 与原生历史。
- 清单以 projectId/taskId/claimId/worktreeId 和实际目录名定位资源；创建、复用和删除核对实际仓库、唯一 Git 注册及双向 .git 指针，准备和恢复另核对任务分支。common-directory 与 origin 的只读 Git 查询使用 leaf 之外的稳定仓库 cwd，同时显式绑定已验证的绝对 admin 和清单 leaf，避免自身的 cwd 阻止并发删除；Git 的 linked worktree 配置与 origin 校验保持有效，`core.worktree` 重定向不能改变物理资源归属。符号链接、外来路径、非空目录的缺失指针和歧义注册不能授权递归删除；实际操作期间仍检查局部目录身份。
- 仓库准备先完成旧格式转换，收集并校对具有 Web 执行证据的旧 Git 标记、清理调度和原绑定；全部清单可靠发布并读回后才解除自有旧锁和清理已知 sidecar，最后发布格式标记。失败或未知格式保留原资源并关闭该仓库文件 gate；其他仓库和原执行停止观察独立推进。转换只处理已有资源记录、清单或 Worker Git 注册关联的 worktree；未关联目录直接跳过，保留其内容，不阻断仓库准备。转换不移动旧目录或修改冻结 cwd、ticket、lifecycle。
- 新分配先独占预留目录，再可靠发布清单，最后执行 unlocked Git add。有效 claim 恢复时，原 checkout 缺失可以在原绑定位置从保留分支重建，不要求证明历史上从未启动；缺失目录内未提交内容可能已经丢失。重建仍须核对原归属、仓库、目录和 Git 注册，等待原 Git mutation 收尾，并遵守原 backend 的运行、停止与恢复准入；Web 原生执行的身份及未知结果限制不因此放宽。非空无有效 Git 关联的目录不得仅凭清单删除。无法关联本 worker 的资源保持可见并保留，不因自有清单缺席而删除。
- 终止删除前确认原受管进程停止、workspace 关闭及 backend 必需的其他条件；Web 归档结果不阻挡删除。Worktree 目录与 Git 管理注册是分别观察和清理的资源；目录已不存在就完成该目录的清理，仍存在的原注册独立移除。保留 .git 指针至内容移除完成，最后删除目录和注册。中断后留下的空目录可在身份检查后通过非递归 rmdir 移除；不带注册的空预留目录同样可移除，非空且缺少归属证明的路径保留错误。结束后保留分支、提交历史和交付引用，新 claim 使用新工作区身份及原生会话。
- 已确认归属的 worktree 内，POSIX 普通目录具有当前有效用户所有权、与 worktree 相同设备及 owner 读取/搜索权限时，可以仅补充缺失的 owner 写权限，以清理 Go module cache 的嵌套 0555 目录与 0444 文件。权限修改必须绑定已核验的目录句柄；普通文件、硬链接文件与符号链接目标的权限不变。不使用全局 chmod 或共享缓存清空。自动清理可在已应用的 enableSudoCleanup 为 true 时，对已核验原目标的权限障碍执行额外 shell 删除；有效 uid 为 0 时直接执行 rm，否则使用非交互 sudo。每次尝试固定已提交实际值及来源版本，字段缺席或无已应用值时只执行普通清理；Windows 不执行 sudo，人工清理入口不使用该策略。重新核验原归属后才删除，设备、身份、Git 关联和普通 I/O 故障不授予额外删除资格。shell 收尾后由普通 Git 清除原登记，再以新观察确认目录及登记均消失。失败保留普通错误与命令错误；取消和超时保留责任并等待本实例命令收尾。保留分支、其他 worktree 和外部链接目标，不提供跨强制重启的新增互斥保证。
- Windows 上普通删除耗尽忙碌重试仍以 EBUSY 失败时，若已应用的 enableWindowsProcessCleanup 为 true，清理可列出工作目录位于已核验 worktree 子树内的进程，连同 Windows 能归属为其子进程的那些进程一并终止，再重跑同一套删除流程；父进程已退出的孙进程可能不再可归属而存活，此时重试遇到同一障碍并保留原始 EBUSY 与清理责任。清单按分隔符边界匹配，仅前缀相同的兄弟路径不算持有者；打不开或读不到的进程跳过，不算失败；每个持有者的进程句柄从检视保持到终止，以此钉住进程标识，避免标识被回收后终止到无关进程。清单不含 Worker 自身及其祖先进程：终止会波及目标的后代，终止任一祖先即会连同本次清理一并结束，且发生在删除进行中、无从留下诊断；祖先链按快照记录的父进程回溯，父标识被回收时回溯可能提前终止或成环，遇重复即停止，两种偏差都只会少终止而非误终止。决定终止对象前与重试改动前都重新证明归属。被检视进程按其自身位数读取工作目录，32 位 WOW64 进程走其 32 位结构，不按 Worker 自身位数一概而论。指针已被中断的清理移除、从而处于已登记且空的 worktree，以及有目录但无 Git 登记的未发布保留目录，同样接入该恢复，一次失败不会永久绕过它；该情形下终止前后的归属证明与主路径同等，包含 owner manifest、归属目录身份与 registration 的 gitdir/commondir 关联，仅凭 leaf 身份与指针缺失不足以授权终止进程。只恢复工作目录持有；进程内打开的文件句柄不在清单内，当此类句柄确实阻塞删除时保留原始 EBUSY 与清理责任。该边界比字面窄：实测 Windows 上由 Node 进程打开的文件不阻塞删除（其句柄允许删除），文件与其所在目录在持有者仍运行时即可移除；真正拒绝删除的是工作目录持有，也正是清单所查。本次清理尝试失败时，诊断给出已终止持有者的总数并列出其中至多八个（映像名与进程标识，其余仅计数，避免在错误消息中嵌入无界列表；总数始终为真实值，逐个持有者另由上报事件完整给出），未被终止的持有者不计入；终止不可逆且可能波及并非由 Worker 启动的进程，该诊断是操作者唯一的记录。记录归属于整个清理尝试而非执行终止的那一步：每终止一个持有者即刻记入，取消与超时打断终止循环、后置观测与完备性检查失败、以及以 effect error 形式随「资源已不存在」返回的情形，都在持有者已消失之后结束本次尝试，均须带上该记录；嵌套的保留目录清理与外层共用同一记录，一次尝试只汇总上报一次。恢复自身的失败仅说明「未终止任何持有者」，与上述记录不重复。恢复成功时没有失败可承载该记录，故每次终止在发生时另行上报一条 Worker 事件，含被终止进程、其启动时间与其持有的目录——进程标识仅在进程存活期间指代该进程，Windows 事后会回收它，而该记录是在钉住标识的句柄早已关闭之后才被读取，故需启动时间方能定位；创建时间不晚于 Windows 纪元时报为不可读而非显示为 1601 年；该上报失败不改变其所描述的清理结果，诊断汇收端另行上报自身不可用。该目标默认 false，缺席或未应用时不终止任何进程。取舍与被实测否决的方案见[进程清理决策](../../.agents/notes/implemented/feature/2026-11-22-windows-worktree-process-cleanup.md)。
- 内容删除逐项核验归属和目录身份；发现替换后停止，不继续修改未知目标。部分失败保留 .git 和剩余内容供重新核验后重试；取消或超时必须等待已提交的文件系统操作收尾，不允许未结束的删除与重试并发。对于需要删除 worktree 才结束责任的 backend，只有目录及 Git 注册均已删除才完成文件清理；执行槽按 W-05 的原执行停止事实独立管理。该机制要求确认原受管执行的停止；Git local-closed 只证明原子进程、已创建流与已启动停止 helper/管道关闭，不证明逃逸或脱离 stdio 的后代停止，后者可能在交接后继续写入。它不提供针对并发改写路径的外部进程的原子文件系统隔离。
- 原 backend 所需义务、本地责任和清理调度结算后退休清单。已独立确认后继绑定时只退休旧清单，不访问后继 cwd。仅剩元数据的重试不重新停止或删除、不恢复执行槽或同 task 屏障。Web 的原停止、归档及持久义务仍独立核验。
- 清理和资源扫描可交错，过期快照或本机 done 状态不能替代新观察。重复收尾与重启都重新核对原进程实例、backend endpoint、Git 注册和目录；已消失的资源不要求重做操作，仍存在且归属明确的资源继续清理，全部所需资源均达到目标状态才结束文件与归档责任；执行名额按原执行停止事实独立释放。

### W-07：执行模式与 agent 执行

- 模式在服务端 claim 和本机索引中冻结。可用配置只为新执行提供已采纳的 web：通过 Controller 与 Daynight relay 提供 Task Session，执行不得探测或依赖 Herdr。运行快照不探测 Herdr。同一 claim 不切换模式，不因连接错误降级；旧 Herdr claim 及其资源由用户处理。
- Web 新任务和恢复均先递交完整 assignment，再在现有巡查中按当前输入资格发送周期 ping。首次 assignment 使用原冻结正文及操作身份；恢复使用当前任务、原冻结配置、已核实的 native Session 和当前附加 prompts 重建正文。首次递交当轮不再发送 ping，之后每个符合条件的轮次最多发送一次，持续 idle、没有新回合或未观察到 working 均不抑制提醒。暂停、不可输入或输入准备未知时等待，任务完成由服务端确认，不由 Agent 空闲或取消回合推断。
- Web Controller 的 Worker 首次 assignment 和私有后续文本输入在原生派发前检查当前 Task、原 active claim、Worker、worktree、Agent 和 Web 模式；暂停、不可输入或期限到期时不递交。人工输入与自动输入共享普通原生队列，未知结果按原操作身份核对，不盲目重放；未受理的 assignment 优先于 ping。Worker 重启或实际 Controller 换代重新递交恢复 assignment，单纯 relay 重连不重置该进度。旧 Controller 须先结算原首次输入、核实 native Session 和完整停止证明，才能保留原 claim、Session 与 worktree 换代；停止未确认时不得启动替代代次。
- Web 的初始输入、恢复、原生能力与清理遵守 [Task Session 需求](task-sessions.md)。缺失原生 ID、journal 或停止证明时不得新建替代会话。
- 首次启动和恢复使用完整 prompt，提供自包含运行约束和 project/task/claim/worktree 身份、实际路径/branch 和本次配置。启动、延续和周期 ping 共用执行规则：保留原身份与授权，遇到问题先调查并在已确认目标、范围、验收、外部承诺及授权内调整，记录重大调整；普通信息缺口、工具暂不可用、失败方案、可恢复错误或过时步骤本身不构成暂停理由。原 assignment 有效且满足自动继续条件时，外层 watchdog 可在回合结束后再次唤醒。每次启动、恢复、唤醒或等待后按当前状态行动：检查当前 HEAD 的 CI、review 反馈、讨论和审批，先读取已有失败日志并在范围内修复和验证，待审批不阻止处理失败；只有无可执行工作且仍需结果时才有界等待并定期检查。真实阻塞无法自主解除、继续需要外部输入、权限、资源或决定时，记录原因、证据、尝试和下一步，设置 blocked=true 并读回确认，保持 in_progress 后交还调度；恢复前核验原 assignment、问题解决与当前授权，获准后解除自己设置的暂停并确认。用户独立暂停、限制与撤权、allowAgents=false 及身份变化仍约束执行和写入。完成交付和验收后核验合并、删除远端源分支、清理任务资源并以原 claim 和准确版本完成；未知写入先观察。缺失或不匹配 assignment 时停止受影响工作，不改用其他身份。

### W-08：人工介入与强制撤回

Web backend 的人工输入通过 Task Session。Retry/release 均与 runner 互斥并核验权限；release 使用精确版本，恢复与停止证据由 Web backend 提供。

- 等待人工时保留 claim、worktree、原会话和名额。
- retry/release 先停止 runner，再取得同一实例锁同步处理指定 claim。锁占用时明确提示停止 runner；没有持久管理意图或后台管理队列。
- Retry 核验仍属于本 worker 的 active claim，尝试一次重连或恢复，保持 claim/agent/worktree。Pending 由 run 经正常名额与旧执行门槛启动。Web 使用持久的单次 retry 授权，必须验证原 nativeSessionId、generation 与完整停止证明，缺失证据或 claim 失效时拒绝恢复，不能新建替代会话或重发初始 assignment。授权本身不表示恢复成功；就绪观察后恢复正常阶段，初始化期间仍显示等待；跨 tick 或重启不得把已换代的单次 retry 当成新授权，失败再次暂停。
- Release 先核验原 owner/admin、当前项目权限、原 claim 和指定版本。停止原 Web 运行并再次检查取消后提交一次远端变更；仅有效 200 后完成原资源收尾。归档失败仍继续安全删除和本机结算；退休失败报告已确认释放及原因，保留元数据供后续重试。远端拒绝时保留工作区供原执行恢复。Release 回到 todo、清空任务计时并删除 worker 和 sessionStartup；原 Session/archive 保存历史。
- Web 详情显示当前 active claim 的用户、机器、agent 和阶段，completed 不表示当前认领。成员资料缺失时保留真实 userId，读取失败显示错误。原 owner/admin 可确认“强制撤回”：提交 active 的 claimId 和精确版本，同一事务清除 worker、返回 todo、清空任务起止时间、设置 allowAgents=false，其他资料保持。completed 或缺失 worker 不提供该操作。
- 撤回确认说明所有重置结果以及远端 agent 不保证立即停止，取消不写入，冲突重新审阅，未知结果只读核对。撤回无需 stoppedConfirmed 或源机器在线，不撤销外部凭据；原 worker 下次成功完整自有清单发现原 claim 缺席后进入既有终止清理。自动再次领取需要明确重新开启许可。
- 释放后符合普通资格的任务与其他候选按服务端顺序参与调度；原 Worker 仍受本机旧资源屏障约束；Web 的纯归档责任不阻挡后继 claim。专用 Worker resume 不提供，也不提供绕过普通认领资格的替代入口。
- 用户给定 --if-version 不替换。Release 的未知结果保留原错误和资源责任，不通过 GET 推断请求成功、不重放；确认后收尾失败明确报告释放已确认并保留原因。命令不承诺跨进程续接原管理意图。
- Transfer API、typed operation、CLI 命令及 target descriptor 已移除；没有目标执行移交。服务端继续保留 release 的 stoppedConfirmed、普通认领资格、唯一归属、权限及旧 claim fencing。

### W-09：SQLite、对账、退出与恢复

- 主索引表精确为 projects(project_id,repo_url,local_path) 与 tasks(project_id,task_id,claim_id,status,agent,session_id,agent_control_mode)。Task 主键为 project/task/claim；status 为 pending/active/done，agent 为 copilot/codex/claude，session_id nullable；agent_control_mode 为 herdr/web，来自实际 claim。同 project/task 至多一个 active；结束行保留。
- 项目映射在 claim 前保存。首次与空库启动先尝试解析并登记可确认的配置项目；未能登记的项目在后续轮次处理，不得据未查询结果清理其资源。映射有未结束任务或实际受管资源时不能改变；移出配置后原映射继续对账并保留现场。
- workerId-only 查询分别穷尽各项目分页，固定当前认证 principal。只有目标项目成功完整查询才能授权其缺席清理；项目 404 明确标为不可用，不阻断有完整清单和资源观察的健康项目。其他认证、协议和网络错误保持真实分类。Git 读取失败不作为空资源；未知项目的遗留资源保留并报告。显式旧 Project ID 不按仓库地址重绑，仍可从配置移除。
- 远端实际 claim 缺少本机行时补 pending；确认可以启动先提交 active 后建资源；成功完整清单缺少原 claim 时统一进入该 task 串行且独立退避的清理 job，即使全局快照没有找到资源也不能直接把本机行置 done。只有 claim 身份而没有 worktreeId 时，重新读取原模式和 Git 的权威资源；发现实际归属后使用其完整身份，否则不猜测目录，确认原资源不存在后结束本机记录。同 task 路径已有可识别的其他 claim 资源时，旧 claim 不删除该资源。资源发现覆盖历史 done 行及遗留受管资源，旧资源未收尾前同 task 新 claim 等待。未证明归属的 Git-only 资源不得据此登记。
- 具备完整资源身份的终态清理独立持久保存原 claim/worktree 身份、首个期限及失败重试调度，不保存 notified/submitted 或资源完成标记；只有 claim 身份时不捏造 worktreeId 或建立替代台账，失败退避仅在进程内保留，重启通过仍未完成的本机行重新发现资源。实际状态必须从资源自己的 source of truth 读取。日志不作为恢复输入。业务恢复保留原 claim 的原生模型与参数。
- Web 真实原生恢复预算耗尽或原生恢复安全检查阻止执行时，必须持久保存可诊断的暂停原因，保留恢复次数、原 claim 和原生身份。暂停门禁先于 worktree 准备、执行初始化、Controller 准备与启动和原生输入；多轮 tick、普通重启及 shutdown/clearShutdown 均不能绕过。最后一次合法恢复仍健康时，不能仅因次数达到上限而暂停；健康执行的正常关停恢复仍允许。
- Web 普通编排失败与原生恢复预算必须分开。工作树异常保存可追踪的编排原因，不得把连续失败误报为 recovery_limit；恢复成功不能因旧普通失败累计而再次锁存。异常期间保留分支、Git pointer、repository/origin 和全部执行归属守卫，拒绝危险推进、替换和清理，保持可信只读观察及既有授权续期。
- 明确可恢复的编排条件恢复后，须重验全部原归属和同 generation 的健康观察，再清除对应阻塞并发布更高 revision 的准确报告。保持原 claim、native ID、generation、controller instance 与进程，不启动新 conversation、不重发初始 assignment、不重放用户输入或清零真正原生预算。该分类与恢复条件跨 Worker 重启保持一致。首次启动尚未递交 assignment 时，须在证明原 Controller 与运行归属后继续同一次启动和原幂等首次提交；未知投递不得重放，缺失归属证据不得新建替代执行。已经分配替换代的显式 retry 经同代健康验证后完成，不再要求停止该健康代或消耗第二次尝试。
- 旧分支异常误锁的纠正须同时证明已知旧错误来源、原报告身份、完整工作树归属及当前原生健康状态；count=0、connected 或错误文本不能单独清除阻塞。真实耗尽、身份缺失、归属冲突、停止状态不明及陈旧 generation/revision 保留原保护，来源不充分时保留明确原因。
- 升级前次数已耗尽、缺少暂停原因且没有正常关停来源的 Web 停止记录，必须在启动前根据原 journal 和完整停止证明识别并补齐暂停，不能先启动旧 generation。停止证明不足时保留责任并显示可诊断等待，不启动替代运行。
- Web 执行被阻止后仍对账远端摘要，发布 waiting 和原 nativeSessionId，保留 active claim。发布失败不消耗原生恢复预算、不清除本地暂停；后续轮次读取新 task 版本后重试，摘要一致后不重复写。暂停不释放名额、不删除资源、不写业务 done。
- Ctrl+C 的根取消信号同步停止报告触发、新领取和调度，并取消报告及所有运行中的 job（包括终止清理 job），在等待报告收尾前完成取消。配置 manager 同时先进入 drain，再 join 报告、初始化移除与其它依赖检查点的工作；五秒只限制继续调度存储重试，已经开始的 read/write/rename 必须真正结束后才能释放实例锁。未保存检查点须携带原错误与记录身份明确失败，不能宣称干净退出或推断未落盘副作用没有发生；重启从已保存的 started 及原执行资料重新核验。等待报告期间已取消的终态 job 不继续删除 worktree 或把未完成行置 done。退出停止不发送清理 prompt，也不等待 agent 清理轮。对成功观察已失去当前归属且具有可用 Web 状态的原 claim，报告与原 Task job 收尾后在同 Task 串行入口执行 W-10 的立即终态清理，删除原 worktree 并结清本机记录；仍归本 Worker 或归属未知的执行保留 claim、worktree、原生 session ID 与未完成 active/pending 行，直接停止原进程及关闭 workspace。Web 状态不足时保留原停止与失败处理。首轮巡查前及仅管理模式按原 project/task 有界读取当前 Task，首次读取前用同一 WorkerRemote 核对原账号；候选包含原 pending claim reservation，同 Task 先等待自己的在途 claim 对账并接住迟到保存的 pending，失败保留该 Task 的责任，其他 Task 独立处理。仅管理模式先按原执行证据停止进程，再在终态文件清理中确认原保留仓库目录存在、核验仓库及工作树格式，完成当前 Git manager 的准备后核对和删除原工作树；准备失败保留该 Task 的可重试责任，不能当作资源已清除或执行已可恢复。此准备不启动业务执行，也不补建缺失仓库。新的归属结束判断依赖成功完整清单或该当前 Task 读取，调度记录不提供归属证明。原生停止超过退出等待期时保留同一 owner，后续只 join 或重试原工作。repository owner 必须等待同一 Task 停止确认后才关闭 Git manager；Task 停止未确认时 Git manager 保持可用，后续核对完成原停止与终态文件清理后才关闭。运行中原 Task 的终态 job 可在业务准入关闭后创建精确 claim 的清理命令，但须先持久保存责任并核验原 Worker、实例和作用域及当前生命周期权威，不得重新开放业务命令。原命令证明和终态保存均确认后才结清生命周期资源；退出核对覆盖 Task 停止期间产生的迟到清理命令。重启恢复剩余终态责任并核对实际资源，包括本机行已 done 而调度记录尚未删除的窗口。停止错误保持可见，无法确认停止时保留相关责任；工作区外临时资源可能遗留。业务取消沿用已 release 归属的既有终态清理，不新增本地 cancelled 状态或归档绕过。
- 主索引、独立清理调度及 Bot 库存/执行表共同使用 `user_version=18`；版本 8 增加 Bot 库存，版本 9 增加 Bot 执行证据，版本 10 保存当前 Controller instance 与跨代恢复来源和停证，版本 12 增加 claim 原生配置冻结表；版本 15 对双 launch 冻结字段建立旧 reader/writer 格式门禁，版本 16 增加独立认领工具预留表，保持授予前请求责任与已授予任务索引分离；版本 17 增加 Markdown 投影修复分类；版本 18 扩展独立补归档记录以保存旧 Web 清理归档错误并保留已保存的身份与调度；运行时对账时将旧清理记录的错误和修复分类转入该记录。版本 6→7 删除清理通知步骤字段并保留身份、期限及重试调度；版本 5 原索引升级时保留项目和任务行。Web 执行状态库独立使用版本 5，版本 1→2 删除重复的 cleanup 输入、结果和资源完成字段，保留控制意图、期限和操作身份；版本 5 为既有 cleanup 补充默认 false 的 discardRecording。Controller journal 使用版本 15，保留版本 14 引入的独立用量队列、来源和元数据表，并持久保存历史策略及独立在线详情表。升级已有 execution 时保持 legacy 策略与原条目，不因格式升级筛除历史；新建 claim 绑定的 Task execution 才选择正文策略。在线读取、正文同步与各自预算遵循[Session SQLite 内容设计](../design/session-sqlite-content.md)，不能将在线工具详情计入正文归档。五个业务库的版本 0 均在既有准入后丢弃原 schema 和数据，并通过基线与编号升级重建；已有空文件和查询访问同样适用。有效非零迁移保留数据，旧详细状态库 1–4 明确拒绝并保留原库；操作者停止旧 worker 后自行移除该旧库再启动。旧 Herdr lifecycle 数据不由 Worker 打开、迁移或重置。各库分别保证单库原子性，任何所需库打开失败都不启动协调业务。[SQLite 升级需求](cli-sqlite-migrations.md)定义共同的版本、查询、准入和错误约束。原生历史与 workerId 保留原有位置。

### W-10：Agent 完成与资源清理

仅有 Git 标记而没有独立原执行归属证据的遗留 worktree 继续占用名额，并在[当前监控](daynight-worker-monitoring.md)中按原 Project、Task、claim 持续报告归属未确认、相对 worktree 位置及恢复指导。轮询和重启必须重新发现异常；扫描或权限读取失败不能解除异常。活动任务占用与保留资源占用按完整原 claim 去重并分解，总和与实际准入一致；详情过滤或截断不能改变总数，旧 Worker 未报告分解时明确保持未知。

`worker resources recover <task-id> --project <project-id> --claim-id <claim-id>` 在原机器、原 Worker 已停止且持有独占实例锁时核验指定遗留资源。默认只预检，`--confirm` 才请求回收。恢复要求保留的已完成 Web 执行 journal、同服务和当前登录 owner、原 Worker 与终态 claim、完整原 Git 绑定、原 Controller 与原生进程停止证明，以及原 ready 归档回执与服务端当前归档一致。现存目录必须干净，包含 ignored 文件在内的内容均不得丢失，HEAD 必须保留在原分支且有远端引用可达。实际删除不使用 `--force`；保留分支、原执行记录和归档。缺失证据、另一 Worker、后继 claim、归档未确认或文件未保全均拒绝并保留资源，不能合成停止证明。完全丢失原 journal 时须从备份恢复证据；任务已完成、静态标记及未注册 Session 均不能替代它。未完成执行仍由正常对账恢复。

Web 清理保留首个期限和资源身份，每次从权威来源观察剩余资源。清理回执和原生停止证明从原 Controller 来源读取。进程退出直接停止所拥有执行，不派发清理 prompt。旧 Herdr claim 和资源由用户处理。

- Agent 完成全部要求、验收和证据后，最后使用原 claimId 与观察版本通过 task set-status done 提交已有完成操作。必要 PR、授权合并和人工验收未完成时保持任务未完成；worker不重复解释或提交业务done。取消是非交付终态；已取消的任务不能认领或 withdraw 恢复。
- Web 正常对账发现原 claim 不在成功完整清单时，对具有可用 Web 状态的原执行立即停止进程、关闭 workspace、删除 worktree，最后本机 done；不通知 Agent 清理或等待十分钟清理轮。退出与仅管理模式成功读取当前 Task 并确认原 claim 已失去归属时复用同一终态执行器。旧 Session 是否登记和后继 Session 的状态不参与该类清理判定；同 Task 的后继资源保持不变。Web 状态不足时继续保留原失败与责任。清理资源观察、停止/关闭及 worktree 核验与删除的单次操作预算统一为 5 分钟，内部 RPC、Controller 清理请求与 Git 命令受同一预算约束。普通执行操作的预算保持各自语义。Web 模式在确认停止和关闭后按当前已应用的 archiveSessions 决定是否尝试上传只读 Session 文件归档；无论归档成功、失败或无法执行，均继续安全删除 worktree 和本机结算。开启时独立 Controller execution 目录中的归档源保留，失败由后台补归档按原身份重试，不重启 Agent 或重跑任务。取消已准入的文件操作时仍须 join 原操作；同一 Task 的停止和删除不重复并发执行。终态 job 沿用原失败记录和退避，job Promise 结束后仍须确认原清理目标已结清，失败保留责任供重试。Done/release/强制撤回后的本地结束规则一致，分支与历史保留。

- 终态清理保留首个期限；失败重试和重启不重新计时，不为清理新建 agent。Web 以同一 cleanupOperationId 查询 Controller 拥有的原生操作回执，未知结果通过该操作身份核对。重启恢复原 claim 的清理责任并重新核对资源归属；已经确认结束的责任可在后续服务轮询失败时继续，不能恢复为业务执行。
- Worker 初次终态归档与历史补归档共用上传器：仅有界识别的 HTTP 429 `resource_busy` 且请求允许重放时自动退避，保留原身份、意图和字节。等待基准从 1 秒指数增长至 10 秒，每次独立施加 ±20% 均匀抖动；有效 `Retry-After` 为最短等待，超过 12 秒或剩余预算时返回最终容量错误。保留整轮 60 秒、单次 15 秒、每请求最多 8 次重试和父取消；成功后下一个请求重置计数。旧 Server 的早期精确拒绝缺少 Task body 版本头不阻止退避，成功及其他原需校验的响应仍要求版本。未知写入结果继续核对原回执，归档请求退避不改变安全工作树清理条件。具体机制由[Worker 设计](../design/daynight-worker.md#结束清理与退出)拥有。
- 临时或未分类的清理失败按 claim 独立退避，连续失败等待 1、2、4、8、16、32 秒，随后每次最多 60 秒，到期后的正常对账才重试。同 claim 的操作严格串行，取消等待在途资源操作收尾，不留下与下次重试并发的后台删除；退避不消耗业务 recoveryLimit，不解除文件责任和同 task 旧 claim 屏障；执行容量按独立停止观察计算。持续失败项不阻塞其他可清理项；有余量时健康任务仍可领取和推进，已运行任务继续执行。
- `archiveSessions` 默认 true。false 时停止后的 Web Session 归档跳过上传并持久选择本机删除；已完成的 Web 归档源按当前有效值选择，运行中的执行继续。删除等待原停止、工作树及本机结算和在途源操作退出；重启或重新开启不能撤销已选删除。真实云端 ready 内容与 receipt 保留。配置实际值未知时不上传也不选择新的删除；已选删除继续。已启动 Worker 在远端库存失败或上传让路时仍推进已知安全的本机删除，错误及原因保留并重试。
- Web 归档的持久 `archive_incomplete`、不可通过全量重同步解除的 `projection_gap` 与非空 `imageProjectionError` 分别标记为明确的待修复原因。Markdown 图片投影失败必须指出需要修复，并提供 `daynight worker repair-markdown --help` 操作入口；错误类别和下次探测时间跨重启保留。原件和独立归档责任继续保留，但不因归档原因保留清理责任或同 task 屏障；原执行停止未知时容量及清理责任继续保留。不得清零标记、丢弃未确认事件、伪造确认或重跑 Agent。首次归档在图片资源读取和上传前检查；进入待修复后，每 15 分钟只读核对原停止 generation、SQL 投影错误标记和修复条件，不重复完整归档。阻塞原因与下一次探测时间跨 Worker 重启保持，探测失败不解除责任，重复相同阻塞不增加完整归档失败计数。
- 首次及后续轻量探测均保留原 generation 的 receipt 对账机会：发现 receipt 后进入既有远端摘要、长度及旧 receipt 迁移验证，即使本地仍有不完整标记也不得永久跳过；receipt 存在不等于归档成功。其他修复条件允许尝试时重新执行完整归档校验，只有实际归档成功才恢复归档告警。历史归档补传同样遵守低频待修复规则，旧清理调度不得等待归档探测或退避才能进入文件清理。自动重建缺失历史、接受带缺口归档及放弃原件不属于该恢复机制。
- 每次实际失败记录原错误、清理阶段和下一次重试时间，区分停止未确认、Agent 已停但后端资源关闭未确认和 worktree 删除失败；归档失败由独立归档维护报告，调度错误与 Controller 拥有的原生操作结果分别报告。满槽且存在失败清理时，阻塞责任集合变化才输出容量诊断，说明保留的槽位、错误原因及解除原因后的自动重试方式。普通 tick 不重复刷屏。调度持久化失败保留原清理错误与存储错误，当前进程继续独立退避，不让未处理的 job rejection 跳过退出停止证明；持久写成功前，不把该次 retry 决策描述为已跨重启保存，已有持久清理责任保持。
- 失败保留错误与收尾责任；每次重试从 source of truth 读取剩余资源，已不存在的资源即满足对应清理目标。删除、停止等操作的响应丢失后重新观察结果，不因缺少成功回执判定资源仍在。读取失败或无法确认停止时不能删除工作区或标 done。清理不影响其他任务。
- 已知目标的清理按对应执行推进，删除仅验证该目标的 Git 工作区。退出不等待失败退避，也不以 Git 发现成功作为停止门槛。已确认失去归属且具有可用 Web 状态的原 claim 进入同一终态清理，重新核验原进程、endpoint 和 Git 资源后结清；仍归本 Worker 或归属未知时只停止和关闭，保留文件与未完成记录。已经停止 Agent 的结果不能被文件删除错误覆盖；停止未确认与后端关闭未确认分别诊断，任一无法确认时退出失败并保留责任。Web 已写 done 而调度责任尚未删除时仍核对当前实际资源，剩余终态责任在重启后继续。

### W-11：可观察性与交付验收

- Worker 独立报告当前调度、并行活动、实际容量、准入原因、故障及最近恢复；未知和不完整观察不得冒充空闲或零容量。运行监控与机器快照分别发送，失败不改变心跳、领取、执行或清理。[运行监控合同](daynight-worker-monitoring.md)定义数据、权限与时间边界。
- 身份与认证就绪后立即报告运行快照，独立 30 秒周期及成功完整清单、新 claim 触发不受 tick、候选查询或容量影响。最多一次进行中尝试与一个合并触发，采集含正常原生终止/join 最多 5 秒、HTTP 最多 10 秒、总预算 15 秒。配置存储阻塞时先等待共享 readiness，Operation 结束只移除本轮等待者，后续触发仍可在恢复后推进。退出先同步取消全部 job（包括终止清理）并停止调度，再等待报告收尾，最后释放既有资源与实例锁；未知写入不重放，监控失败不改变任务执行。
- 运行快照报告真实 OS、CPU 逻辑处理器及差分使用率、内存、启动目录文件系统容量和软件版本。初始未知清单为 null，真实空清单为 []；清单同步失败或项目不可用造成覆盖不完整时清除旧清单并报告 null。字段失败和未安装各有明确状态；报告不探测 Herdr。详细采集口径、缓存、错误及清单规则由[上报需求](daynight-worker-reporting.md)拥有。
- 诊断文件 sink 发生临时目录、文件或 append I/O 故障时，通过 stderr 与可用运行监控明确报告，并自动退避恢复。每次运行及恢复使用同一 Worker/启动日期日志族中的新唯一 segment，旧文件与不完整尾行保留，不把未知 append 重放到新段。尚未派发的省略记录与已派发但结果未知的 append 次数分别计量；恢复摘要关联先前失败路径、当前路径及计数，不冒充精确丢失数量。排队有界，日志不作恢复输入；格式化、stdout/stderr 或独立通知错误仍保留错误链。退出在所有事件生产者和存储结束后 close sink，取消重试调度并 join 活动写入。
- stderr 和 JSONL 提供 workerId、实际平台、projectId/taskId/claimId、agent、已知 sessionId 及启动、恢复、等待、清理与错误事件。凭据脱敏后，终端输出将上下文、消息及错误链中的完整连字符 GUID 缩写为首段 8 位十六进制字符，保留大小写；其他文本不变。JSONL 的字段、消息和错误保留完整 ID，供精确检索；API、prompt 与持久化中的 ID 不变。相同 claim 的等待/执行阶段、终端和已知原生会话不变时，轮询不重复记录；阶段切换及会话或终端变化及时报告，不同 claim 独立判断。成功启动建立观察基线，下一轮相同观察不重复提示重连。资源保留警告在连续成功观察中只提示一次，警告消失后再次出现则重新提示。真实启动、恢复、清理、人工操作和失败尝试保留日志。错误保留类型和 cause，凭据脱敏，不输出完整 prompt。
- 许可/平台 UI 的双语、键盘、焦点和响应式行为保持 W-02/W-03。真实 native、受控故障、各平台和完整 Goal 验收分别记录来源，文档或模拟进程不替代真实运行证据。

## 可观察验收

| 范围 | 必须观察到的结果 |
|---|---|
| W-01、W-07 | cloud-first、首次原始候选与空项目启动成立，本地托管值不能覆盖云端；缓存身份/损坏/持久化错误明确，receive/apply/ACK 串行合并保留新目标和未确认失败；当前 mode 重新验证 native 历史，部分成功、退避、快恢复及飞行期间新失败正确，实际并发/轮询/恢复/native 消费且健康进程不重启；本地字段与首次候选严格、省略值一致，项目选择明确；assignment 与运行约束完整，且不依赖仓库流程文件；新会话和已知原生会话的完整启动文本符合确定的 assignment 文案；启动、恢复/延续和周期 ping 一致要求依据事实自主调整、先处理已有失败并有界等待；普通缺口和等待不单独触发暂停，无法自主解除且需要外部介入的真实阻塞触发记录与暂停流程；身份、权限撤回和独立暂停仍受尊重，解决并获准后解除暂停；恢复使用保存的 agent 和当前适用配置；原生执行使用 Web 适配器的受管访问与参数校验，冲突参数和缺失能力明确拒绝；配置参数和含引号等字符的 prompt 保持各自原值与传递位置。 |
| W-02、W-03 | 默认许可、双向确认、平台清除、未知结果及候选组合过滤成立；assignedTo=me 贯穿全部候选页，他人和未分配任务不遮挡本人合格候选。 |
| W-04、W-05 | 本人可领取，他人和未分配任务的直接 claim 拒绝且保持数据；负责人变更与 claim 竞争遵循项目锁及精确版本；既有库存保留原执行权限；同 task 竞争单赢家；未知 claim 不启动资源或重放；单项目和多项目空闲容量大于一时，每轮合计最多一个新 claim，暂留 pending 也结束本轮领取，下一轮延续项目轮转与候选顺序，候选迭代器正常关闭；已有 pending 同轮仍可按容量启动多个；等待与收尾占容量，同 task 旧资源形成启动屏障；撤回只允许原 owner/admin，原子重置归属/状态/计时并关闭许可。 |
| W-06 | 首次分支使用本次刷新取得的远端默认分支 commit，主 checkout 保持不变；远端不可用或刷新失败、取消、超时不创建新分支或 worktree，既有 dirty worktree 和保留分支在 origin 不可用时仍可复用；不同任务并发创建互不串扰。静态归属、注册、指针与删除核对成立；有效 claim 的缺失 checkout 按原绑定和保留分支重建，未提交内容不承诺恢复，外来路径及身份冲突保持可见错误；原 Git mutation 收尾和 backend 准入仍成立。清理中的目录已缺失、Git 注册残留、最终 unlink 后空目录及无注册空预留目录均能收敛，无关非空目录保持不变且不阻断其他资源发现。操作报错但新观察确认目录及登记均不存在时保留错误并继续结算；资源仍在或观察失败不得冒充清理成功。外层取消不发起新的观察，已准入 mutation 的本地责任仍须收尾。 |

| W-08 | 人工操作与 run 互斥；远端拒绝保留 worktree；成功后本机删除失败可由下次对账收尾；未知结果不重放；Web 强制撤回不声明远端已停，原 worker 下次对账收尾。 |
| W-07、W-08、W-09（Web） | 新任务与恢复先 assignment，同轮不 ping，后续相同 idle 的连续巡查各发送一次；busy、暂停、人工输入竞争、断线和终止清理保持输入门禁。未知回执按原操作核对，普通 ping 的终态 unknown 不永久抑制后续轮次。旧 Controller 的首次输入、身份发现、暂停、停止失败及中断恢复均保留原身份，停止证明后最多一次换代；非法能力声明报错。SQLite 重开保留暂停原因、次数、claim 与原生身份；暂停后多轮 tick、Worker restart、shutdown/clearShutdown 均不准备或启动原生执行、不递交初始输入；旧耗尽停止记录与健康最后一代、健康 orderly restart 成对验证；waiting 首次发布失败后以新版本对账成功且稳定后不重复写；retry 成功与失败均保留原身份，claim 失效、停止证明不足或缺失原生 ID 时安全拒绝；暂停继续占用容量并保留资源。 |
| W-09 | 主索引字段及冻结模式正确，三态/唯一 active；退出取消并 join 原 job，不发送清理 prompt 或等待清理轮。具有可用 Web 状态的已退役 claim 在同 Task 串行入口立即终态停止、删除原 worktree 并结清记录；首轮前与仅管理模式的当前 Task 查询先核对同一 remote 账号，候选包含 pending claim reservation，每个 Task 先 join 自己的原 claim 对账再分类，独立 Task 不等待彼此；仅管理模式在原进程停止后用真实保留仓库完成 Git manager 准备并删除原工作树，原目录缺失、格式或仓库核验失败保留该 Task 责任且不启动业务；原 Controller 生命周期核对位于 Task 停止尝试之后，对账未解决的 Task 保留责任。当前归属仍有效、读取失败和 Web 状态不足时保留相应原责任；原停止晚到不重复派发；Task 停止未确认时 repository 保持 unknown 且 Git manager 可用，后续核对完整闭合后才关闭。重启恢复剩余责任、原期限和资源身份，同 Task 后继保持可用。 |
| W-10 | 正常完整清单缺席统一清理，具有可用 Web 状态的退役 claim 立即停止，不等待 Agent 清理轮，退出与仅管理模式复用同一终态结果；旧 Session 与后继 Session 不参与判定，同 Task 后继资源保持可用。正常完成、release、强制撤回及人工管理均按所属 backend 的资源目标清理。独立 release 正常返回前退休清单；失败保留元数据，重试不访问已确认的后继 cwd。完整资源身份的首个十分钟期限和每 claim 退避跨重启保持，身份尚不完整时通过未完成索引行重新发现并重新建立进程内退避；Web 操作由 Controller 原生回执核对；可控时钟与故障注入覆盖持续失败、上限、串行、公平推进和解除原因后的收敛；Web 归档失败保源并继续安全删除、后继 claim 可启动；真实清理失败仍保留旧 claim 屏障，有余量健康任务推进、满槽准确诊断；持久化写失败时进程内退避保留原错误且不妨碍 shutdown；shutdown 不等待退避；已退役的完整 Web 执行立即终态清理，当前或未知归属保留现场，原停止证明与 backend-close 失败保持独立；Web done 与调度删除之间中断后重新核验原进程、endpoint 和剩余 Git 资源，只有当前资源满足目标才能结清；旧资源完成标记及丢失的操作响应不能代替当前观察。 |
| W-11 | 独立报告覆盖空闲、满并发与长操作，清单未知/空/旧及部分字段错误保持区分；采集、单飞、期限、取消与关停满足[上报需求](daynight-worker-reporting.md#验证)。关联日志、Warning、原错误链和脱敏成立；终端上下文、消息及错误链中的完整连字符 GUID 在脱敏后显示首段 8 位，保留大小写且不改变非 GUID 文本，JSONL 各字段、消息与错误仍含完整 ID；验证关联实际源码、平台和环境。 |
| W-05、W-06、W-10（恢复与隔离） | 真实隔离 Git/文件系统和 SQLite 验证清单持久发布、旧格式转换的中断恢复、原 cwd 与 dirty/index/merge 保留；归属、指针、分支冲突及未知格式仍拒绝。已知隔离项计占并允许安全的健康任务领取，同 task 与自身 pending 屏障成立；真实 runtime 遗留映射入场覆盖同项目隔离、外项目候选、无效 Project ID 和无归属证明。归档待修复跨重启保持、后台只到期探测、不读取 pending/blob、不上传，旧清理调度不等待探测；探测失败不误报恢复，receipt 对账、旧 schema、网络退避与条件变化回归。平台和重启证据分别报告。 |


完整平台运行验收要求其实际门禁与端到端结果，组件检查和 schema 验证不能替代。
