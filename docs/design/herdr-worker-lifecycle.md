# macOS Herdr Worker 持久运行生命周期

本文拥有 macOS `herdr` 模式的运行身份、输入准入、停止证明和恢复机制；[输入仲裁设计](herdr-input-arbitration.md)拥有持久操作、人工控制和严格终端传输。[Worker 需求](../spec/daynight-worker.md)定义必须满足的结果，[Worker 架构](daynight-worker.md)定义调度、claim 与 Git 工作区。[Herdr 工具启动设计](herdr-tool-launch.md)拥有三平台冻结 launch、pane 映射和 Linux/Windows 共享私有实例切换；Web Controller 的 ticket、journal 与恢复契约由 [Task Session 设计](task-session-protocol.md)拥有，不能充当 Herdr 的执行证据。

## 隔离与能力范围

每个实际运行代次使用一个独占的现有 Herdr daemon，目录位于 `worker/h/r/<instance-id 的紧凑编码>/`。每代保留自己的配置、端点、workspace、pane 和 terminal。Worker 不修改或替换 Herdr，不让普通 Herdr restore 自动恢复 agent；`resume_agents_on_restore=false`，独占实例关闭更新检查。

独占 daemon 是停止范围的一部分。Herdr 的普通 workspace 关闭会触发上游自行发现进程并发送信号，不能替代客户端对原进程实例的校验。受控停止先验证并冻结原运行，在确认资源范围后先停止独占 daemon，再停止原 shell、native agent 与已证明归属的后代，避免 daemon 收尾再次使用变化后的 PID。

Session v2 注册使用原 Worker 的 PAT 和 owner，不使用 Web Controller ticket。macOS Worker 组合持续录制、严格输入与归档消费者后声明 observe/control/archive 能力；源、checkpoint、最终回执及资源处置由[录制设计](herdr-recording.md)拥有。协议能力不替代原生与页面组合验收，也不将其他平台提升为同等支持。

## 身份与存储

主索引 `worker/state.sqlite` 继续保存 Project、claim、模式和原生会话 ID。独立的 `worker/herdr-executions.sqlite` 保存不可替换的原始证据，通过 SQLite 事务、版本比较与严格状态校验更新；日志不能替代该库。现存无版本或不兼容的 lifecycle 库拒绝打开并保留，不按主索引的空库重置规则丢弃证据。

| 记录 | 拥有的事实 |
|---|---|
| `HerdrLifecycleRecord.owner`、`claimId`、`cwd` | server/project/task/claim/worker/worktree、owner user、provider 与原工作目录 |
| `sessionId`、`registrationId` | 同一 claim 的 Session v2 身份与注册标识 |
| `connectionEpoch`、`registrationRequest` | 已确认连接代次与尚待观察的原注册请求 |
| `controlEpoch`、`admission` | 本地控制失效边界和单次自动输入准入 |
| `preparation` | 尚未建立完整运行绑定时的实例目录、启动意图、冻结 Agent/Herdr launch 与原 daemon 证明 |
| `runs` | 每代 binding、运行阶段、冻结双 launch/观察、由提交结果与观察校验的 `nativeLaunch` 事实、原 daemon/shell/helper/native 身份、停止操作与停止证明 |
| `segments` | 段序号、所属 generation/binding、起止边界及显式 restart gap |
| `initialAssignment`、`initialPrompt`、`automationBlocked` | 原首次输入、提交结果及未知结果造成的自动输入阻断 |
| `ledgerRequest` | 发送前保存的完整 ledger 消息及原 connection epoch；未知结果必须先观察，不重放 |
| `publishedLedgerHash` | 服务端已确认的完整运行 ledger 摘要；本地停止不等于已完成同步 |

进程身份包含 boot identity、PID、微秒出生标识、audit token、父进程、进程组与 session。PID 或命令行相同不能代替出生身份；同一出生进程的 exec 也可能改变 audit identity。原始证明不可被后来观察的 foreground 进程覆盖，只能按已验证的连续父子关系追加证据。

lifecycle SQLite 格式 4 保留 preparation/run 的冻结双 launch 与实际观察，旧缺失字段保持缺失，禁止从当前目标补造历史身份。该格式延续格式 3 为每代保留的 `nativeLaunch`：`not_submitted`、`requested`、`observed` 或 `unknown`。关闭阶段不覆盖该事实；普通 patch、取消或准入等待不能将 requested、observed 或 unknown 回退为 not_submitted。唯一的明确拒绝转换来自实际 `agent.start` 返回被识别的 `agent_pane_busy`：发送者先同步调用 `onRejected`，由 `confirmNativeLaunchRejected` 核对同一代、同一 binding、最新版本/CAS，以及该代没有 agent、采集段、输入/admission 或停止事实，才把原未启动运行恢复为 prepared/not_submitted；此前代的首次 assignment 与输入历史保持不变。此确认先于下一次准入等待，存储恢复后仍使用原 run；observed、unknown 或证据不足不能使用该转换。迁移先严格校验旧行的字段、身份和版本。旧 prepared 只有原 daemon 和唯一 shell 完整、没有 agent、segment、admission 或停止意图时才确认为 not_submitted；旧 launch_requested 保留 requested，已捕获 agent 的记录为 observed。缺原 agent 的旧关闭或 unknown 记录，以及证据不完整的旧 prepared，保持 unknown，不从空 native ID、空画面或进程消失补出未启动事实。迁移不改原停止证明、待确认 ledger、版本与哈希；损坏数据拒绝迁移并保留原库。旧二进制不能读取新格式，attach 仍只读且不执行迁移。

只有本次明确成功取得的新 claim 能通过 `lifecycle.registerClaim` 创建空运行记录。顺序为主索引 pending、持久启动来源、active、资源创建。完整库存只能找回 claim，远端摘要为空不能证明该 claim 从未启动；缺少 lifecycle 记录的旧 claim 保持未知，不自动补建运行。

## 启动与首次输入

首次启动先确认原 claim，并在原 Task 配置中冻结 Agent 与 Herdr launch，再保存带相同选择的 preparation，记录 daemon 启动意图并捕获实际 daemon 身份。建立 workspace 后读取原 shell 的真实进程身份，将完整绑定与 `nativeLaunch=not_submitted` 同一事务提交为 `prepared`。Session 注册与运行 ledger 同步失败时，保留已经产生的资源和责任，不以新实例代替。

具有 not_submitted 事实的 `prepared` 运行可以重新接入。`HerdrAgentManager.launch` 先完成 preflight、调用者 `beforeStart` 的异步前提及 `readOwned`/`realpath` 对原 daemon、端点、shell 出生身份与 cwd 的核对；每次真实 `agent.start`（包括明确 shell busy 后的重试）都重做这些新鲜前提，变化时不发出下一次请求。全部 await 完成后重查动态准入，再由同步 `onSubmitting` 将 `launch_requested` 与 `nativeLaunch=requested` 同一事务持久化，紧接着派发 RPC；准入检查、意图记录与请求调用之间没有新的 await。该调用只启动原生进程，不发送 assignment，也不以 `nativeSessionId` 出现作为启动成功前提。受控 mapping receipt 必须关联原 owner、nonce、selectionKey 与逻辑 argv；捕获原 shell→helper→loader/native 的完整连续父子链，不用 helper 名称代替 Herdr 对 native 的 kind 识别。取得这些进程的原身份时，将追加身份、`active` 与 `nativeLaunch=observed` 同一事务保存，建立采集段后才进入输入阶段。启动结果尚未持久确认的崩溃恢复为 `stop_unknown`，不能再次启动。普通前提检查失败、准入关闭或某次 not-submitted 异常都不能证明完整启动历史从未提交，已经写入的 requested 仍保留。只有上述实际明确拒绝经专用同步 CAS 确认后，才能在等待下一次准入时保留原 prepared/not_submitted 运行；再次启动仍核对原身份和新鲜准入，不能泛化为回滚未知请求。

首次 assignment 保存为 `pending`，递交前写 `dispatching` 和本次 admission。`submitInitialPrompt`、后续 `submitPrompt`、网页输入和 cleanup 进入同一持久仲裁器；`durable.ts` 不使用 legacy `agent.prompt` 递交正文。严格 terminal 输入每帧之前再次核对原 claim、运行身份、服务端控制状态和 admission，并按输入用途检查 paused：自动输入受暂停约束，人工输入仍须通过原有身份、lease 和 fence 校验。明确未发送可回到 pending；任务暂停、合法人工控制或挂起以及已知菜单/禁用输入的零写入等待须保留明确的内部类型。仲裁器已登记时输入 journal 先登记 rejected，生命周期再清除本次 admission 并为首次 assignment 保留 pending，不能因跨层序列化而计作执行失败。成功传输保存为 `transport_completed`；一旦可能已写，任何失败仍保存为 unknown 并阻断重放。独立人工处置可以授权继续，但不会改写原始 unknown。这里的成功仅表示输入传输完成，不证明业务完成或模型已处理正文。

`nativeSessionId` 可以在最多一次首次输入之后补齐，但启动成功必须等待原官方 integration 向同一 pane 报告符合原 kind 的合法 UUID，并复核原进程身份。错误来源、缺失事件、进程变化及未知输入均保持未确认，不重发、不换会话、不人工补报；已知值不可更换。输入后的观察与普通轮询负责同步补齐后的完整 ledger，未确认请求继续读回对账；确认后恢复同段缓存画面的投递。快照的 ledger hash 与 fence 校验始终保留，已传输输入不因 ledger 同步失败而重发。重连不重发 assignment；恢复已确认停止的运行时仍使用原 native conversation；只有原自动状态安全、身份有效且 `resume` 用途的输入检查通过时才恢复自动 continuation，人工状态继续 suspended。恢复自动执行的真实空字段证明与日常 automatic/cleanup 的已知阻塞排除不同；后者报告 composer unavailable，不能被用于把未知布局或草稿推断为空。自动输入未知、原生 ID 未知或原运行未确认停止，都不能通过新开对话规避。

## Session 连接与采集段

首次 Herdr Session 注册沿准备/启动的 publish、connect 传递同一动态准入回调。`connectHerdrSession` 在 await `verifySupport` 与 `current` 等最后前置读取完成后，紧邻首次 `mode=register` 意图登记和真实请求派发重查该回调；进入 helper 时的一次检查不能覆盖后续等待。期间失去准入时不产生新的注册意图或请求。已有或结果未知的原注册仍按原 registrationRequest/Session fence 核对，reconciliation 与 reconnect 不被当作新的分配，保持原运行与控制归属。

普通 Worker 重启接入仍存活的原运行时，重新确认 Session 连接并增加 `connectionEpoch`，保持 `sessionId` 与 `executionGeneration`。只有原运行具有普通 shell+agent 停止证明、原 claim 仍有效且原 native ID 与首次输入结果可用于恢复，才创建下一代实际运行。准备资源停止证明不授予下一代运行或自动恢复，即使该代继承了前代非空 nativeSessionId。

仅 relay 连接断开、Worker 与原生运行仍存活时，普通 observe 也会核对连接是否缺失，不依赖 nativeSessionId、账本或画面发生变化。重连前再次验证原 claim、allowAgents 与原 daemon/socket peer/shell/agent 身份，并沿用持久注册和未知请求只读对账路径。重连只提高 connectionEpoch，保持原 Session、运行代次和录制段；先前断线造成的 suspended、未知输入回执和草稿责任不解除，不触发原始输入或 continuation。任务 paused 仍可恢复只读观察连接，但不由此获得自动输入或自动恢复权限；合法人工控制仍按独立协议准入。claim 已失效、执行权限被撤销或原进程身份不能确认时不创建新连接。浏览器隐藏、租约撤销或过期只暂停输入，仍在线的原 relay 连接保持已确认状态；不能据此重注册或提高 connectionEpoch。只有输入通道实际关闭后才清除连接标记。

注册请求先落盘再发送。请求或响应未知时读取原 Session 状态核对，不自动重放或生成替代注册。服务端历史可以落后于本地停止或 native ID 补齐，但不能替换原 owner、binding、已确认停止记录或段前缀。准备好下一代但尚未发布 ledger 时，先按服务端仍注册的代次 reconnect，再提交新运行。

实际运行启动或恢复采集时产生新段；断点通过 `gap` 明确连接前后段。重启只承认录制 journal 的最后 durable checkpoint，不能推算连续观察；正常停采使用单调时钟边界。停止证明、封段和 ledger 确认分别可恢复。nativeSessionId 的单向补齐可同步已关闭段，但不能改变其观察边界。

终态 claim 的同代停止 ledger 使用原 `connectionEpoch` 收尾，不要求再注册 active claim。完整消息与 epoch 先写入 `ledgerRequest`，发送失败或重启遇到未确认请求时先读回，不再次 POST。只有服务端确认的相同内容才清除请求并更新 `publishedLedgerHash`。任务已删除且 GET 返回 404 时，可以用原 epoch 首次提交全部已确认停止的 ledger；若发送结果丢失且读回仍为 404，则保留 pending 请求和责任，不将缺席认作确认。这里的 Session 状态缺席不构成任务终态或资源删除许可；任务读取的权限隐藏 404 必须单独拒绝，不能当作明确的 task_deleted。最终冻结及 ready/unavailable 回执由独立归档消费者确认。

## 停止 journal 与原进程证明

运行阶段为 `prepared`、`launch_requested`、`active`、`stop_intent`、`close_requested`、`stopped_confirmed` 或 `stop_unknown`。

1. 保存 `stop_intent`、稳定的停止 operation ID 和原因，保留原 `nativeLaunch` 并撤销 admission；关闭前再保存 `close_requested`。
2. 核对原 daemon 与原进程出生身份，使用 macOS audit token 发送信号并确认冻结；发现后代必须先持久登记其连续归属。
3. 原范围稳定后，先停止独占 daemon，再停止已证明的原进程；核对原实例退出及范围内没有未解释资源。
4. 可靠提交 `stopped_confirmed` 与引用原 binding/出生身份的 stop proof，再封闭段并同步 ledger。

停止证明分为两种，具体 wire 形状由 [Session v2 协议](session-v2-contract.md)拥有。已捕获 agent 的运行仍要求原 shell+agent 的普通证明。已登记但确认未提交 native launch 的运行，只有本代无 agent、segment 或 admission，且原 daemon 与唯一 shell 的实际停止得到确认，才能生成显式 `nativeLaunch=not_submitted` 的准备资源证明；该证明保存原 daemon/shell 身份，不把 shell 标成 agent。launch_requested 或旧 unknown 缺 agent 时不能使用此分支。

进程替代、身份读取失败、未证明的资源、普通运行缺失原 shell/native 证明、准备运行缺失原 daemon/shell 或未提交事实，以及停止未确认时保持 `stop_unknown`。不向替代实例发信号，不删除工作区，不启动替代运行。boot 变化通过独立的 boot 证明判定原进程不再存活，不能写成同一 boot 内 PID 消失的结论。

重开遇到 `close_requested` 时保留已提交的停止 operation ID 和原因；正常恢复仍提高控制 fence，但停止重试不再次递增 controlEpoch、不回退到 `stop_intent`，也不把该阶段视为停止证明；继续对原 daemon、shell 和已登记 agent 执行完整身份验证与独占停止，再提交原代次证明。实际停止已完成但证明尚未落盘的运行由同一路径收敛；原身份变化或不可读仍保持 `stop_unknown`。

journal 无法落盘时只依据已有证明尝试受控停止，并报告结果未确认；不能写成功状态。没有持久停止意图而原 daemon 在同一 boot 已消失时，重启不能补写意图来追认完整停止。pane 消失、内存 Map 为空或进程命令行变化也不是停止证明。已持久确认停止但封段或同步中断时，重试只补收尾，不重新停止或启动 agent。

准备停止确认后仍封闭实际录制责任并同步原 ledger。纯准备且零帧的终态执行使用实际零计数和无 captureError 的 unavailable/ended_before_first_sample，不生成 ready 空归档；前代有录制时保留其原帧和该代 unavailableRuns。服务端在 ledger 与 recording evidence/snapshot 的两个到达顺序上均拒绝准备证明关联非零 selected/registered 或已观察内容。新 proof 变体要求支持它的 server/Web reader；旧 reader 拒绝时，未确认的同步、归档与 worktree 责任继续保留。

证明范围受可核验的原进程、session 和连续父子关系约束。无法证明的后台、脱离 session 或其他外部服务没有通用停止保证；未知责任必须保留，不能宣称覆盖任意后台后代。

## 调度、退出与人工接入

Coordinator 将持久责任并入资源发现、同 task 启动屏障及 shutdown。终态清理的原执行 stop proof 已提交后可释放执行槽，不等待封段或网络确认；保留的 worktree 仍阻止同 task 新 claim 覆盖。已排队恢复的 job 继续占槽，不能因旧代已停止而超配。自动领取在远端写入前检查同 task 旧资源，尚未完成的 Herdr archive/worktree 责任阻止同一 Worker 申请新 claim。

终态清理由共享 `cleanup_schedules` 保存原资源身份、首个期限和每 claim 重试策略，不能用 schedule 中的步骤标记替代 lifecycle 原身份、停止证明或服务端 ledger 确认。失败按 1、2、4、8、16、32 秒及最多 60 秒退避，到期后的正常对账才重试；不会消耗业务恢复预算，也不能清除尚未确认的停止责任。调度写失败保留原错误与 SQLite 错误，进程内继续有界退避，不能宣称本次调度已持久保存。

共享清理操作的单次预算为 5 分钟，内部 RPC、HTTP 和原生停止继续受外层取消与期限约束；原生停止的信号升级间隔保持自身语义。Session HTTP 使用当前 `Operation.limits.requestMs`：普通操作为 30 秒，清理操作为 5 分钟，外层 `Operation.signal` 仍可提前取消。macOS 终态 cleanup 先持久撤销旧输入；仅此前安全 automation、任务未暂停、结构化状态就绪且没有已知菜单或禁用输入时，通过同一仲裁器发送一次有界 cleanup prompt；cleanup 不要求正向空 composer，读取结果仍为 unavailable。人工草稿或未知输入时跳过提示并受控停止，不以通知回执或 native idle 代替原进程停止证明。封段或 ledger 失败只补对应收尾，不重新停止已确认的原运行、不启动新业务执行。未确认的 ledger 请求仍只允许读回，退避到期不会赋予重发权限。Linux/Windows legacy Herdr 的建议性通知、原十分钟期限和 Git 删除规则由 [Worker 架构](daynight-worker.md#结束清理与退出)拥有。

Ctrl+C 先取消并等待调度、报告和 job，再停止原运行并封段。保留 active claim、同一 Session、原 native ID、未完成本机行和工作区，不发布最终 ready。终态 claim 的普通收尾同样使用停止 journal；建议性提示受持久输入仲裁约束，停止不等待 lease 释放。终态停止证明提交后释放执行槽，本地封段及 ledger 确认后可以结束本机执行行；独立归档队列继续保存源、冻结最终 ledger、核对不可变回执后才删除原 worktree。失败保留资源责任。正常归档删除和显式 delete 都必须从原持久删除记录收敛对应本机任务与清理计划；崩溃在删除确认与 SQLite 更新之间时，调度恢复继续该收敛，不将已删除资源变成永久占槽或缺失原始证据。

`worker attach` 在 macOS 有 lifecycle journal 时只读校验当前 schema 并读取未停止的原运行；多个候选交互显示 task、claim 和 provider。连接前后核对原 daemon 以及 API/client 两个端点，再校验并使用原实例目录及冻结 Herdr launch 打开 client。缺少原工具身份或文件变化时拒绝新 client，不使用当前目标替代；已有 endpoint 的停止和归档不依赖 executable 仍可启动。不恢复数据库、不迁移、不增加 epoch、不请求服务端放行，也不需要解除任务暂停。journal 不可读或没有候选时拒绝，不转接未知旧 daemon；没有 lifecycle journal 时只读共享实例的原 launch 和 daemon 证明；缺历史工具身份时拒绝新 client。

## 实现接口与验证

- `herdr/durable.ts` 组合 lifecycle store、Session 客户端、原生进程控制与现有 Herdr adapter；`WorkerHerdrLifecycle` 向协调器提供登记、准入、责任查询、条件 cleanup、停止和停止确认；`WorkerHerdrInput` 提供控制状态、授权控制请求及输入操作入口。
- `herdr/agents.ts` 提供分离的 `launch`、`processInfo`、`submitInitialPrompt` 和 `submitPrompt`；共享路径的 `start` 同样消费冻结 mapping，并在单次初始输入后确认官方 Session。
- `herdr/lifecycle-store.ts` 校验不可变身份、状态迁移和追加历史，并提供 attach 专用只读读取；`session-connection.ts` 拥有注册、读回和 ledger 确认。
- `herdr/native-macos.ts` 拥有原进程身份与独占停止；`execution.ts`、`cleanup.ts`、`coordinator.ts` 消费持久准入和停止结果。

验证应覆盖旧 prepared 的保守迁移、准备停止与零帧收尾、准备证明不授予恢复、两类停止证明独立校验、先记录身份后输入、注册与 ledger 丢响应、准备/启动/停止/封段崩溃、未知输入不重放、重连与运行换代、替代实例保护、终态同步、归档前工作区保留、只读 attach，以及 Web/legacy 回归。模拟故障证明状态机与拒绝语义；macOS 真实 daemon、socket 与进程身份实验分别证明支持范围。二者不能互相替代，也不等同于 provider 登录或完整业务交付验收。
