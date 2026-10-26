# Worker 需求

本文定义 `daynight worker run` 的目标行为与可观察验收条件。自动执行许可和平台的服务端/CLI/Web 控制、候选筛选、唯一认领的服务端/typed client 基础、Agent 显式完成入口，以及本机身份/实例锁/SQLite 记录、Git 工作区管理和 Herdr 适配操作已实现；前台运行、人工管理命令和完整交付仍须运行时验收。[整体架构](../design/daynight-worker.md)说明职责，[认领架构](../design/daynight-worker-claims.md)拥有已交付的归属协议。

## 目标与范围

Worker 作为前台常驻进程，通过 Daynight HTTP REST API 领取配置仓库中可由 Agent 执行的 ready task，使用专用 Herdr 服务运行 Copilot 或 Codex，持续完成任务交付。同一有效 claim 保留自己的 worktree，进程或机器重启后继续原工作；原 claim 结束后统一清理，新 claim 使用新工作区与原生会话。

服务端拥有任务资格、身份权限及唯一 claim；worker 拥有调度、执行资源、恢复和按自有 claim 清单对账清理；agent 完成任务要求的交付、验收并最后提交 claim-bound done；Herdr 拥有 agent 终端和会话。认证与三状态设置是独立前置，不由 worker 再实现一套。

## 必须满足的行为

### W-01：前台运行、配置与平台

- `daynight worker run` 与现有 `review run` 一样在前台运行，支持 Linux、macOS 和 Windows。
- 配置支持多个仓库的地址与本地路径；路径不存在时由系统克隆准备，已存在路径须核对仓库身份并保留已有工作。冲突或身份不明确时显示错误。
- 配置包含覆盖全部仓库的最大并发，以及全局默认 agent、模型、参数和仓库覆盖值。Worker 在启动或重启时加载配置，不进行热重载。实际取得 claim 后，首次 pending 物化时持久冻结有效执行配置；继续、重试及重启恢复沿用该配置，重新加载的配置作用于后续新 claim。已开始执行却缺原配置时暂停核对，不替换为新默认值。
- 首次启动随机生成稳定 `workerId`，使用共享配置锁与原子替换保存至 `~/.daynight/config.yml`；已有合法身份重启复用，非法值明确拒绝。身份持久化后才允许 claim。
- 每个用户环境一个 worker，固定 `~/.daynight/worker/` 保存独立 SQLite、实例锁、日志、Herdr 数据和临时资源，不提供状态根覆盖入口。存活的第二实例明确拒绝；失效 worker 锁不证明原生 agent 已停。启动前校验实际 Herdr 端点，路径等条件不满足时明确报告。
- 实际平台使用 `windows`、`linux`、`macos`。WSL 中的 Linux worker、Herdr 和 agent 属于 `linux`，不允许通过配置冒充其他平台。

### W-02：Agent 自动执行许可

- Task 具有独立的布尔字段 `allowAgents`，表示是否允许 worker 自动领取并交给 Agent 处理。它与用户身份、项目权限、实际执行者及 agent 类型独立。
- 旧任务通过数据库迁移设为 `true`，保留其余业务数据、版本与时间；新任务始终默认为 `false`，创建输入不能直接启用。普通字段更新未提供此字段时保留原值，显式 `false` 表示关闭。
- 服务端、CLI 和 Web 一致支持许可的查询、展示与明确操作。完整 task 与图节点必填布尔 allowAgents，严格拒绝缺失、null 或非布尔响应。CLI 的 update/list/ready 使用 `--allow-agents true|false`。Worker 的自动候选查询同时使用 true 与实际平台兼容筛选，并在后续候选页中保留两者；实际平台由执行运行时识别，未知或不支持时等待。自动认领在服务端事务中重验许可、ready、平台、精确版本和唯一归属，自动选出的 ID 不构成人工指定。普通技能不提供自动候选选择或连续调度；worker 和 agent 不得自行启用许可。
- Web 在任务详情标题下的状态行右侧提供单一“自动执行” / “Automatic execution”标签与开关组合，左侧保留状态、ready 与可选平台信息。详情不重复展示独立自动执行状态 badge 或下方 Overview 开关；列表中的状态标记可保留。长标题与窄屏不得重叠或横向溢出；平台等左侧信息可在左组内换行，右侧组合控件保持右对齐并与第一行状态顶部对齐。锁定原因由该控件的 tooltip 提供鼠标悬停与键盘聚焦访问；错误、未知结果和等待人工输入的说明遵循[Web 提示规则](daynight-web.md#必须交付的行为)，使用不挤压阅读区的限时气泡，保留恢复操作。当前详情观察到自动执行设置提交成功时显示浮动气泡，3 秒后自动消失且不占正文高度；后台刷新、语言切换和重开已确认的详情不重复提示。
- 开启和关闭都先弹确认框，确认按钮直接提交修改；取消、Escape 或关闭弹框均不提交。提交期间阻止重复操作，服务端确认成功后才更新开关；明确失败保留原值，未知结果先读取核对，不自动重发。
- 修改沿用已认证用户的项目成员写权限、精确版本与普通 task PATCH。确认表达明确操作意图，session 或 PAT 不能证明操作者是物理人工；不另设处理角色操作或重复确认字段。
- `allowAgents` 与状态、ready 和依赖独立；状态设置保留许可。未开启许可的任务仍可由人工明确安排，通过 set-status in_progress 执行。任务登记不启动执行，不增加任务审批字段。
- `in_progress` 期间拒绝实际切换，完成或合法人工解除 claim 后才允许改变。精确版本的同值更新不修改版本或时间；旧版本同值请求仍拒绝。等待人工输入保留许可，关闭许可不隐式停止或移交执行。

### W-03：可选执行平台

- Task 的必填 `requiredPlatform` 值为 `null`、`windows`、`linux` 或 `macos`；null 表示任意支持平台，新旧 task 默认均不限制。创建可省略或显式提供 null/枚举；更新省略保持，显式 null 清除，非法类型和枚举拒绝。
- 服务端、CLI 和 Web 一致支持设置、清除、展示及兼容筛选。CLI create/update 使用 `--required-platform windows|linux|macos`，update 使用互斥的 `--clear-required-platform` 清除，list/ready 使用 `--compatible-platform windows|linux|macos`；查询平台不充当运行环境配置。Web 详情状态行使用单一平台下拉框展示已确认值，提供不限平台/Any platform、Windows、Linux、macOS。选择不同值后弹窗展示当前与目标平台，确认才提交；选择当前值或取消、Escape、关闭、遮罩关闭均不提交，取消后恢复下拉框焦点。概览没有独立平台编辑区或保存按钮，成功前保持已确认值。
- in_progress 与自动执行许可一并锁定实际变化，完成或合法人工解除后才可修改；精确版本同值更新保留版本与时间，旧版本仍冲突。明确人工设置状态不受平台要求限制。平台确认、许可和状态设置共享每任务写入控制，未知结果先核对，迟到响应保持原 task 归属。
- 平台条件不改变 task 的 ready 语义，不匹配的候选不占名额、不创建资源、不消耗恢复次数。
- `compatiblePlatform` 包含 null 和与查询平台相同的任务要求。自动执行许可、ready 与平台条件须在有界候选排序和分页前按 AND 组合，并绑定游标范围，不能让较早的未开启许可或不兼容任务遮住后续合格任务。
- 平台字段、领域匹配与候选查询的验收独立于后续运行时。自动候选选择与连续调度由 worker 承担；worker daemon 的原生平台识别、自动 claim 事务重验、资源启动及历史执行平台须由对应能力提供运行证据。普通技能每次执行一个明确指定的任务。

### W-04：原子领取与执行归属

自动领取必须同时满足：

```text
allowAgents = true
AND ready
AND (requiredPlatform is unset OR requiredPlatform = worker platform)
AND no active claim
```

- 服务端在同一事务中重新核验当前自动执行许可、平台、状态、依赖、精确版本与归属，覆盖查询和领取之间的变化。
- 同一 task 跨用户、机器和 worker 只有一个有效 agent claim。竞争失败方不得启动执行。自动初次认领在请求内存中生成新的 claimId；稳定 workerId 与 origin/project/repo/path 先持久保存，实际 claim 确认后才登记 pending，不预建任务行或领取台账。未知认领不重放；成功完整的自己 claim 清单找回实际归属后再登记。Transfer 的新 targetClaimId 在 source 管理意图中先持久保存。所有新 claimId 均不复用，服务端保存最后归属并拒绝其 ID 再次使用。
- 任务使用受保护的 properties 保存当前执行用户、稳定机器 ID 与名称、实际平台、worker/claim 标识、agent 类型、Herdr session/workspace/pane 及原生 agent session ID。尚未取得的会话信息与已取得信息区分，取得后补全。
- 初始认领/人工接续用户以服务端认证身份为准，移交目标由服务端验证为当前项目成员。完整 properties 必须包含 worker:null 或 active/released/completed 的归属记录；普通 create/PATCH 即使原样或以 null 提供 worker 也拒绝，PR 等其他属性更新保留 worker。
- 会话补全、执行更新、移交与完成均核验当前 claim 与精确任务版本，旧执行方不能覆盖新归属或完成新执行方的任务。普通状态修改不能释放 active claim，或开始/完成 released 的未完成成果；显式人工 resume 保留原 owner/admin、previousClaimId 与版本核对，人工执行不受自动许可/平台过滤。现有服务的连续性约束及目标修订见 W-08。
- Worker 的任务查询、认领、归属更新、完成及管理操作直接调用 CLI 进程内 typed ApiClient，不启动 daynight 子进程；每次 HTTP 操作独立有界，未知结果读取核对而不自动重发。

### W-05：调度与全局并发

- 有空闲名额时，配置仓库之间轮流获得领取机会，同一仓库内遵守服务端合格 ready 候选顺序。
- 空仓库或没有本平台合格候选的仓库不占名额；持续繁忙的仓库不能让其他仓库长期得不到领取机会。
- Task 从领取后准备执行到完整交付持续占一个名额，等待 CI/review、人工输入和恢复超限暂停期间均占用。降低上限不抢占已有任务。
- 同一仓库的不同 task 可由不同用户、机器或 worker 同时执行。

### W-06：稳定的 task worktree

- Worktree 由系统创建和销毁，每 task 一个，分支为 `daynight/<taskId>`，目录为 `.worktrees/daynight/<taskId>`。首次分支从仓库当前 HEAD 创建，保留分支从原 tip 使用，不 reset；同一仍有效 claim 的继续、重试和恢复始终使用原 worktreeId、分支与未提交成果。
- 普通退出、失败和崩溃保留仍归属执行的 worktree/native history/config；资源缺失或身份不一致时保留现场并报告，不能新建空目录掩盖恢复失败。
- 原 claim 终止后统一删除本次 worktree，保留分支、执行历史和交付引用。新 claim 使用新 worktreeId 和原生会话；规范路径仍被旧 claim 占用时等待或报告冲突。创建/删除均核对实际仓库、分支、claim/worktreeId 标记及目录物理身份，只操作本次执行资源。
- 创建成功但绑定结果未保存时，只接回匹配原标记和精确 `.git` 指针的资源；已知原成果缺失、无标记预留目录或路径替换均保留现场并报错。Device/inode 只作辅助核对，仍存在的目录缺精确原指针时必须拒绝破坏性操作。分支通过 Git 的 refs backend 核对，支持 reftable，不假设 HEAD 为 loose 文件。
- 终止删除需原 agent 停止和 workspace 关闭；保留原标记及 `.git` 指针删除其余内容，失败可重新核对后续清理，最后删除指针并非递归移除空目录。若中断留下仍存在但缺指针的目录，即使为空且 inode 匹配也保留 active/错误，等待人工检查；目录经核实移除后再完成注册清理。删除成功结果未保存可据实际目录/注册缺席核对，不能误删同路径无原指针的新目录。

### W-07：专用 Herdr 与 agent 执行

- 每个 worker 自动启动和管理一个专用 Herdr 实例，每 task 使用其中独立的 workspace/pane/agent，通过 Herdr API 启动、输入和观察 Copilot / Codex；不干扰人工或其他 worker 的实例。私有 `[session] resume_agents_on_restore=false`，worker 是原生 agent 唯一启动/恢复者。
- Herdr 与原生 agent 的会话关联可持久化，重启时核对并继续原执行，不要求人工重复输入已取得的标识。
- 协调循环组装首次启动及同 claim 确需重新启动的完整 prompt，先确认所需技能可用，显式指定 `worker-managed` 环境、`using-daynight` 技能和 `execute-task-in-managed` 模式，传入原 projectId/taskId/claimId/worktreeId、实际工作区路径/branch、原会话关联及冻结配置。Herdr 适配层按原内容递交不透明文本，返回受理、拒绝或未知结果，不选择任务/模式或组装业务指令；仅重连存活 agent 不重发启动输入，未知结果先观察原资源。
- 单一 `using-daynight` 技能按显式模式选择指令：普通指定任务读取 run-task，managed 执行读取 references/execute-task-in-managed.md，SKILL.md 只保留简短路由。普通执行不加载 managed 详细指令；不能从 properties.worker、cwd 或环境变量推断模式。显式 managed 上下文缺失或不匹配时等待，不回落普通执行。两种入口共享任务输入、范围、交付、验收和证据规则，各自拥有普通或原 claim 的生命周期动作。
- 启动和恢复前校验官方 Herdr/native agent 会话集成及恢复所需的原生历史；不满足时显示具体问题和修正方法并暂停。Worker 不自动全局安装集成或修改全局 agent 配置。
- 首条输入不能依赖尚需首个 turn 才产生的官方 native ID。新启动核对原目标、readiness、冻结 argv/config 后只提交一次原 prompt；resume 还核对持久原 ID、必要 history 和确切 resume argv，输入后须取得并核对官方 ID。Blocked 后续输入需要持久的 `initialPromptNotSubmitted:true` 和从空 native-reference 基线取得的匹配 launchEvidence，重连或未知结果不授权重发；后续身份观察失败仍保留已知 promptSubmission 与 launchEvidence。
- 未活动的恢复 pane 若保留旧 native reference，应先确认旧停止/关闭再换新 pane，保留 worktree/native ID/config；不能把旧引用冒充新报告。冷恢复若改变 terminal/shell，原停止观察保持不可变，须分别核对实际 restored 资源、原 native PIDs/旧 shell 已不执行及当前没有原生/前台工作；新空 shell 本身不构成原 agent 停止证明。
- 开发 task 的 agent 负责实现、验证、提交、工作分支推送、PR、CI/review 反馈、授权合并和合并后验收，并遵守仓库权限、门禁与授权要求。其他允许 Agent 自动执行的 task 遵守其阶段和验收条件。
- Worker 使用 Herdr 最新状态观察运行、等待和结束，不需要公开 report 命令、结构化报告协议或结果文件。Herdr idle/done 或 agent 一轮结束不等于 task 完成。

### W-08：人工介入与显式移交

- 需要人工输入或授权时保留自动执行许可、平台、claim、worktree、原会话和并发名额，前台显示等待原因及原会话入口；人工通过 Herdr 处理后继续。
- 原执行用户或项目管理员可显式 release/transfer，并受项目访问权限约束。授权提交者与目标分别校验，目标必须是当前项目成员；接收者身份不自动授予替换原归属的权限。
- 主动管理先持久保存具体意图，抑制普通恢复，完成原 agent 停止、workspace 关闭和 worktree 删除后，才绑定用户决定的精确版本提交远端变更。停止或删除失败保留原责任；未知远端结果先核对，不重放、不重建旧业务资源。
- Transfer 保持唯一有效 claim，使旧 claim 失去更新能力；保留任务 in_progress 与执行计时，重新记录目标认领时间。Release 返回 todo 并清空执行时间。两者的本地退出与 done 使用相同终止清理。
- Transfer target 与 released task 的显式 resume 都使用新 claimId/worktreeId、自己的冻结配置和新原生会话，不依赖源 worktree/native history 连续，不使用 SQLite 快照传输或未授予的目标 pending。普通 daemon 不立即重领 released task，由显式 resume 再启动。
- 既有服务端 continuityConfirmed、同 worktreeId/agent 的原成果接续约束仍由[归属架构](../design/daynight-worker-claims.md)描述；人工管理协议交付须修订这些约束，保留权限、精确版本、停止确认与 fencing。本机存储交付不代表这些服务修订已完成。

### W-09：SQLite、退出与恢复

- 固定状态根仅有一份 SQLite，业务表仅为 projects 与 tasks。Projects 保存 origin/project/repo/path；tasks 每行对应一个实际 claim，保存 pending/active/done、冻结配置、实际资源绑定、恢复次数/暂停/授权、原清理截止与输入/结果、source 管理意图及远端提交结果。结束行保留，不另建任务台账或通用动作引擎。
- 项目映射在远端 claim 前保存；取得实际 claim 后先 pending，确认启动条件并提交 active 后才创建资源。同一 origin/project/task 至多一条 active，未收尾执行期间项目绑定不变；服务范围与当次仓库路径随任务保留，不能因换服或改映射而误认资源。
- 启动和持续对账通过既有 task list 的 workerId 筛选，成功汇总当前认证用户/worker 全部项目与分页的有效 active claim；不附加候选资格条件，不把失败或部分清单当成空集合。原 claimId 不在完整清单就触发相同本地清理，不按 task 状态或单 task GET 分类原因。同 task 新 claim 不保护旧 claim，完成本轮对账后才登记新领取。
- 同一仍归属执行的恢复核对 SQLite、Git 和 Herdr 的原资源与冻结配置；新发现 claim 先登记 pending。显式写入的版本和未知结果仍可按 taskId 读取核对，不确定的外部动作不能按“未发生”重做。
- Worker 崩溃或机器失联不自动释放 claim，由原 worker 恢复或人工结束/移交。Worker 死亡不证明 agent 或工具已停止；无法确认原执行是否停止时暂停，避免重复 agent。
- Ctrl+C 停止新领取，以独立且受原截止约束的清理取消范围记录 shutdown 并给原 agent 清理外部资源的机会，确认 agent 停止和 workspace 关闭后关闭专用实例，保留 claim/worktree/native/config。正常重启不消耗故障恢复预算，不清除原暂停或重试授权；旧 shutdown 的停止确认不能应用于新启动的 agent。
- 异常退出或基础设施故障在原 worktree/会话上按配置上限恢复；计数、原因及暂停状态持久化，重启不清零。超限保留资源与名额，等待人工处理或明确恢复操作。已存在 cleanup/control 意图时只推进其收尾，不进行普通恢复。

### W-10：Agent 完成与资源清理

- Managed 指令核对启动 prompt 中显式提供的 assignment，复用原已认领执行；普通开始/重开/done 与 managed 原 claim 执行/完成分别归各自入口。共享任务输入、范围、交付、验收和证据规则保持统一所有者。Agent 完成全部任务交付、验收与证据后，最后使用 CLI set-status done 的显式 --claim-id 与观察版本提交既有 PUT status。开发任务仍满足必要 PR、检查/审查、授权合并和验收；等待人工、必要 PR 未合并或验收未满足时保持未完成。Worker 不独立解释业务验收或再次提交 done，只按成功完整自有 claim 清单对账。
- Agent 负责执行并记录任务验收；其验收文字是执行方声明，不是任意自然语言条件的独立证明。证据缺失、相互冲突或任务明确要求人工验收时保持 task 未完成，在原会话请求处理；不要求通用 Markdown 验收解析器或形式化证明。
- 原 claim 从自己成功完整清单退出后，统一持久保存最多十分钟的固定截止，通知原 agent 清理 worktree 外明确归属的临时文件/进程；清理结束或原截止到达后，确认 agent 停止、关闭任务 workspace/pane、删除 worktree，最后置本机 done。Done/release/transfer 不保留源 worktree。历史、分支、task 交付引用及 claim/session 标识保留。
- 清理重启沿用原截止和提交结果，不重发未知输入，不创建新清理 agent；清理期间继续占并发名额。完成后修改自动执行许可或平台不能改写历史归属和实际平台。
- 删除失败记录具体错误和待清理状态，重启后只继续清理，不能重新执行已完成任务。清理不能影响其他任务或人工 Herdr。

### W-11：可观察性与交付验收

- 前台能够区分仓库、task、agent、平台、执行/等待/恢复/暂停/清理状态，显示实际错误与人工原会话入口。
- 自动执行许可和平台的 Web 交互遵循对应最终样式原型，保留双语、键盘、焦点和响应式规则，覆盖保存中、禁用、失败、版本冲突和不确定结果核对。
- 三平台运行、真实 Herdr/agent 行为、受控故障注入和生产端到端结果分别保留来源与验证边界；文档、模拟进程或正常退出不能替代真实会话恢复证明。

## 可观察验收

| 范围 | 必须观察到的结果 |
|---|---|
| W-01、W-07 | Linux/macOS/Windows 的安装入口可启动前台 worker；分别运行 Copilot/Codex；实际首次/重新启动 prompt 明确环境、技能、managed 模式和原 assignment，普通执行不加载 managed 详细规则；仓库缺失自动准备；原有仓库错误与配置错误可见；领取后的配置修改不影响原执行。 |
| W-02、W-03 | 验证旧任务迁移、新任务默认值、开关双向确认及取消/失败/未知结果、平台清除；覆盖自动执行许可、ready 与全部要求平台/worker 平台组合；不合格任务不会遮住后续合格候选或启动资源。 |
| W-04 | 多用户/机器/worker 竞争只出现一个有效 claim；覆盖查询后资格变化、旧版本、未知结果及旧 claim 更新；任务属性保留 PR 和实际会话关联。 |
| W-05 | 多仓库持续有任务时轮流获得机会；空与不兼容仓库被跳过；CI/review、人工等待及超限暂停均计入全局上限。 |
| W-06、W-08 | 继续和恢复使用原 worktree；人工进入原会话后继续；显式结束统一删除旧 worktree，新 claim 创建新工作区；越权、平台不合格或有效 claim 的资源缺失保持拒绝或暂停。 |
| W-09 | Ctrl+C、强制结束 worker、Herdr 重启及机器重启后不产生第二个执行 agent；在外部动作结果落库前后注入中断，正确核对实际结果；恢复预算和暂停跨重启保持。 |
| W-10 | 已核验的开发任务合并并完成合并后验收，原 claim 退出自己清单后删除 worktree 且历史仍在；agent 交付证据不足时不完成；清理失败跨重启只重试清理。 |
| W-11 | 前台和自动执行许可/平台 UI 展示与真实状态一致；错误、未知结果和人工处理入口可观察；各验收结果能关联到实际源代码、平台与运行环境。 |

完整运行时验收要求实际门禁及端到端验收通过，文档不能替代运行时证据。
