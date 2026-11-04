# Worker 需求

本文定义 `daynight worker run` 的行为与可观察验收条件。[整体架构](../design/daynight-worker.md)拥有运行机制，[认领架构](../design/daynight-worker-claims.md)拥有服务端归属协议。账号级运行快照的服务端契约由[快照需求](daynight-worker-snapshots.md)拥有，客户端采集与持续报告由[上报需求](daynight-worker-reporting.md)拥有；在线状态和近期可见性不参与 claim 资格、执行控制或本机恢复。命令可用性与组件验证不替代 Linux、macOS ARM64、Windows 的完整原生运行验收。

## 目标与范围

Worker 是前台常驻进程，通过进程内 typed ApiClient 和 REST API 领取配置仓库中允许 Agent 执行的 ready task，在系统管理的 Git worktree 中按冻结的 herdr/web 模式运行 Copilot、Codex 或 Claude。服务端拥有资格、权限、唯一 claim 和完成操作；worker 拥有调度、资源、对账和清理；agent 拥有业务交付、验收、证据及最后一次 claim-bound done。

Worker 必须采用状态驱动的 reconciliation。期望归属来自服务端完整自有 claim 清单，实际资源状态分别来自 Herdr、Controller journal、操作系统、Git 和文件系统；归档完成来自服务端回执。本机主索引只承担项目映射、认领、模式和原生会话身份，清理记录只保存资源身份、控制意图、期限和重试策略，不能用操作完成标记替代重新观察。Herdr 执行计时与业务输入观察保留在进程内；Web 保留执行配置、恢复预算和原生操作身份，并从 Controller 拥有的回执与进程实例证明读取原生事实，以满足[Task Session 需求](task-sessions.md)的未知结果不重放及单 writer 要求。

## 必须满足的行为

### W-01：前台运行、配置与平台

- `daynight worker run` 在前台运行，支持 Linux、Windows 和 Apple Silicon（ARM64）macOS，不支持 Intel macOS，遵守[客户端平台要求](daynight.md#c1-包与平台)。实际平台枚举仍为 windows/linux/macos；WSL Linux 计为 linux，未知平台明确拒绝。
- `daynight worker setup` 要求 stdin/stderr 为交互终端，先汇总环境缺项与修复指引，再单选 Copilot/Codex 并多选一个或多个既有可访问 Project。重复配置预选当前项目；最终确认前展示所选 agent、Project、目录、移除范围及不兼容参数重置。所选 agent 应用于全部选中 Project；匹配注册保留传输 URL/路径，同类型 model/args 保留，切换类型清除不兼容值。
- Setup 将 agent/model/args 与完整 Project 选择一次原子保存，相关字段或服务/凭据变动时拒绝旧选择；无关配置、原 root 拼写、注释和安全 alias 保留。取消、空选、认证/API/保存失败均无部分保存。已有 claim、worktree 和 native history 保留；重新启动的 native 进程使用当前适用配置。
- Setup 只做有界只读环境探测，不启动 daemon/native agent/worker，不 clone、打开 SQLite、claim、安装或登录。探测验证所选 agent 的固定 full access 参数能力；Codex 至少为 0.135。缺原生依赖允许保存并明确要求修复；只读版本、参数及 hook 检查不证明 provider 登录、真实 hook 执行、live 协议或完整任务验收。取消等待已启动探测收尾，未确认清理故障保留原错误链并使 setup 明确失败。
- 独立 worker mapping 支持 repositoryRoot、maxConcurrent、pollIntervalMs、recoveryLimit、agentControlMode、agent、model、args 和 repositories，默认值为 ~/daynights、1、60000、3、herdr、copilot、null、[] 和 []。省略配置文件、worker 或可选字段使用这些默认值；repositories 不从 review 推断。pollIntervalMs 单位为毫秒；每轮检查完成后再等待该间隔，默认等待 60 秒。显式合法间隔（包括 5000）保持原值，读取配置不重写。
- 配置读取不创建或重写文件。只有确实缺失的文件按缺省处理；已知非 nullable 字段显式 null、已知字段类型或值错误、YAML 结构和重复键、读取故障及取消均明确失败。根节点、review、worker 及其仓库条目的未知字段在运行时忽略，CLI 编辑保留其原节点。model:null 保留清除语义。仓库 remote/path 必填，可有 projectId 与 agent/model/args 覆盖；路径相对 config.yml 目录或为绝对路径，不展开 tilde，拒绝 drive-relative Windows 路径和重叠仓库/状态目录。
- 同 agent 类型逐字段继承；切换类型清除未显式给出的 model/args。Args 整体替换，不允许覆盖 worker 拥有的 cwd/session/model/mode 位置或固定 full access 策略；冲突参数在启动前明确拒绝。配置在启动/重启读取，不热重载；已认领执行保留 agent 和原生 session ID，重新启动使用当前适用的 model/args，不把另一工具的参数套到原工具。
- `worker repo list [--json]` 读取本地选择；add/remove 选择远端现存可访问 Project。省略 --project 时多选显示名称、完整 UUID、repoUrl，至少选一项；显式 --project 支持非交互。新增保存 projectId、原 repoUrl、绝对 path；匹配既有注册保留传输 URL、路径和覆盖，remote-only 项只补 projectId。Remove 只改变后续领取范围，保留 clone、claim、worktree 和原生历史。
- worker.repositoryRoot 独立于 review，只在新增注册时展开，改变根不移动已有路径。Repo 操作拥有 worker.repositories 及保留条目的 projectId；setup 另拥有全局 agent/model/args 及确认重置的仓库原生字段。所有写入锁内重读并拒绝相关服务/凭据、根和仓库变动，保护其他解码值及保留条目的未知字段；显式删除拥有整个所选条目。共享 alias 影响非归属值时拒绝保存，保持原文件；无关字段、注释和安全 alias 保留。网络与提示不持配置锁。
- 空配置的交互式 run 先引导选择，非交互给出 repo add --project 指引。选择使用同一份捕获的服务凭据及 worker 设置；取消、失败或不完整选择不能启动任务资源。持久恢复动作从本次成功项目映射及完整清单开始，不承诺离线延续上个进程的计时或操作意图。
- 首次启动随机生成稳定 workerId，复用配置锁与原子替换保存到配置根下的 config.yml（DN_CONFIG_DIR，缺省 ~/.daynight）。身份创建只拥有根字段 workerId；根循环 alias 等使未知或其他非归属解码值变化时拒绝保存并保留原文件。合法值只读复用，非法值拒绝，身份持久化后才可 claim。每个配置根只有一个 worker 实例，其 worker/ 保存 SQLite、实例锁、日志、Herdr 和临时资源；同根第二实例拒绝，端点路径不合法明确失败。DN_CONFIG_DIR 必须是绝对路径；未配置时保持原目录。根选择同时覆盖 Controller 与 Review 状态，不改变真实 HOME、Provider 登录及项目 worktree。不同根不得独立管理同一个任务 worktree。
- 一个状态目录用于当前配置的单一服务、账号和 workerId。切换前先结束旧执行，再重建本机状态；不提供跨服务或跨账号的旧执行自动接续。

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
- `compatiblePlatform` 包含 null 和与查询平台相同的任务要求。自动执行许可、ready 与平台条件须在有界候选排序和分页前按 AND 组合，并绑定游标范围，不能让较早的未开启许可或不兼容任务遮住后续合格任务。
- 平台字段、领域匹配与候选查询的验收独立于后续运行时。自动候选选择与连续调度由 worker 承担；worker daemon 的原生平台识别、自动 claim 事务重验、资源启动及历史执行平台须由对应能力提供运行证据。普通技能每次执行一个明确指定的任务。

### W-04：原子领取与执行归属

自动领取同时要求 assignedTo 等于当前认证账号的本地 userId、allowAgents=true、ready、平台兼容及没有 active claim。自己指登录账号，不是 workerId；未分配或分配给他人的任务不能自动领取。服务端在同一项目事务中重验成员、精确版本、负责人、许可、平台、依赖和归属，直接调用 claim 接口同样受此限制。同 task 跨机器和 worker 只有一个有效 claim，竞争失败方不得启动资源。既有 active claim 的恢复和完整库存仍按原执行归属核对，不因本规则自动撤回；显式人工 resume 保持原 owner/admin 权限。

- 每次取得新的执行使用 fresh claimId/worktreeId；稳定 workerId 和项目映射先保存，实际授予后登记本机 pending。请求标识和版本只留当前进程；未知响应记录 Warning，不创建资源、不重发原请求，通过后续完整自有清单找回实际授予。
- Task properties 保存受保护的最新 worker 归属、实际平台、agent 和已知会话摘要。普通 create/PATCH 拒绝写 worker，即使 null 或原值；PR 与 worker 更新相互保留。完整 DTO 中 worker 缺失表示没有保留归属，存在时为合法对象；读取不注入 null 默认值。
- 会话摘要、释放、撤回与完成核对当前 claim 和精确版本，旧执行不能覆盖新归属。服务端验证当前成员与 owner/admin 权限，不远程证明机器进程或 Git 内容。
- Worker 直接调用进程内 typed ApiClient，不启动 daynight 子进程。HTTP 独立有界；未知写入只读取核对，不自动重放。远端 phase、Herdr 和 nativeSessionId 是展示投影，不替代本机实际资源观察。

### W-05：调度与全局并发

- 配置仓库轮流获得领取机会；新候选保持服务端 ready 顺序。已有 pending 优先，项目内按稳定 task_id 顺序选择。Pending 和新领取都在每成功分配一个名额后轮转到下一个项目，持续繁忙的项目不能一次占满所有空闲名额。
- Active 从启动前资源预留到收尾完成占用名额。等待 CI/review、人工输入、恢复超限及清理仍占用。容量是 active 行、实际归属资源、已确认收尾责任及适配器待确认停止责任按 claim 去重的并集；没有本机行的孤立执行也须在全部清理完成后才释放名额和同 task 启动屏障。
- Pending 在没有实际运行资源时不占名额；同 task 旧执行停止、关闭 workspace 并删除 worktree 后，新 claim 才能 active。降低上限不抢占已有任务。并发上限约束本机 active 资源数，迟到授予可以留下等待名额的 pending。
- 空或不兼容仓库不占名额。同仓库不同 task 可以并发；各 task 的操作串行，不同任务的有界等待和清理互不阻塞。
- 本机已有 active 且仍归属的任务先排队恢复，在任务串行操作内读取当前 Herdr；其他工作区的全局 Git 发现错误不阻塞已有名额。新的 pending 启动和新 claim 分配继续要求完整全局资源发现成功。

### W-06：稳定的 task worktree

- 分支为 daynight/<taskId>，目录为 .worktrees/daynight/<taskId>。首次分支从仓库 HEAD 创建，保留分支从原 tip 使用；仍有效 claim 正常复用 dirty worktree，不 reset/clean。准备时允许通过检查及非递归 rmdir 清除 mkdir 后、Git add 前中断留下的无注册空预留目录，再正常创建；不采纳非空外来目录或别的 claim 的注册。普通退出、失败和崩溃保留其 worktree 与原生历史。
- 创建、复用和删除核对实际仓库、Git 注册、静态 projectId/taskId/claimId/worktreeId、分支及精确 .git 指针。资源身份仅含这四项 canonical UUID，Herdr 与 Git 标记一致；服务地址是连接配置，不进入本地资源身份。符号链接、外来路径、非空目录的缺失指针和歧义注册不能授权递归删除。Device/inode 仅为辅助，refs backend 通过 Git 核对，支持 reftable。
- 发现资源时，Git 注册的 marker 或 Herdr workspace label 不符合当前格式即静默跳过并保留，不阻塞其他资源；成功解析后的受管资源仍严格校验实际身份和完整性。Git 发现只枚举可识别的注册，不把保留目录中的无注册普通路径当作已识别 worktree，也不因此使整个资源快照失败。针对明确目标清理时，无法归属的非空目录仍保留并报告。
- 原生会话已知而原 worktree 意外丢失时报告错误并保留 active；尚无原会话的新执行可以按规则准备工作区。异常既有路径保留并报告，不用空目录掩盖旧成果丢失。
- Git 静态标记没有 workerId，须关联本机行、专用 Herdr 或当前自有 claim 才能证明属于本 worker。没有这种关联的 Git-only 遗留资源报告并保留，不因自有清单缺席删除。
- 终止删除前确认当前受管进程停止、workspace 关闭。Worktree 目录与 Git 管理注册是分别观察和清理的资源；目录已不存在就完成该目录的清理，仍存在的原注册独立移除。保留 .git 指针至内容移除完成，最后删除目录和注册。中断后留下的空目录可在身份检查后通过非递归 rmdir 移除；不带注册的空预留目录同样可移除，非空且缺少归属证明的路径保留错误。结束后保留分支、提交历史和交付引用，新 claim 使用新工作区身份及原生会话。
- 已确认归属的 worktree 内，POSIX 普通目录具有当前有效用户所有权、与 worktree 相同设备及 owner 读取/搜索权限时，可以仅补充缺失的 owner 写权限，以清理 Go module cache 的嵌套 0555 目录与 0444 文件。权限修改必须绑定已核验的目录句柄；普通文件、硬链接文件与符号链接目标的权限不变。不使用 sudo、全局 chmod 或共享缓存清空。无法安全处理的权限、所有者、设备或 I/O 错误保留并返回。
- 内容删除逐项核验归属和目录身份；发现替换后停止，不继续修改未知目标。部分失败保留 .git 和剩余内容供重新核验后重试；取消或超时必须等待已提交的文件系统操作收尾，不允许未结束的删除与重试并发。只有目录及 Git 注册均已删除才完成清理和释放 W-05 的名额。该机制要求原执行的写入进程已停止，不提供针对仍在并发改写路径的外部进程的原子文件系统隔离。
- 清理和资源扫描可交错，过期快照或本机 done 状态不能替代新观察。重复收尾与重启都重新核对原进程实例、backend endpoint、Git 注册和目录；已消失的资源不要求重做操作，仍存在且归属明确的资源继续清理，全部所需资源均达到目标状态才结束责任并释放名额。

### W-07：执行模式与 agent 执行

- 模式在服务端 claim 和本机索引中冻结。默认 herdr 经 Herdr 运行原生终端；web 直接启动 Controller，通过 Daynight relay 提供 Task Session，其执行不得探测或依赖 Herdr。独立运行快照只读观察私有端点，不启动 daemon 或初始化 Herdr backend。同一 claim 不切换模式，不因连接错误降级。两模式支持 Codex、Claude、Copilot。
- Web 的初始输入、恢复、原生能力与清理遵守 [Task Session 需求](task-sessions.md)。缺失原生 ID、journal 或停止证明不能套用 Herdr 的 NULL 新建分支。以下 Herdr 原生运行规则继续独立适用。

- Worker 自动管理专用 Herdr，每 task/claim 一个 workspace/pane/agent，不干扰人工实例。保持 resume_agents_on_restore=false，由 worker 唯一决定启动或恢复。
- Workspace 显示名称以当前 task title 开头，后接 ` | daynight:` 与 projectId/taskId/claimId/worktreeId 的完整 canonical JSON。标题只作展示，所有权匹配、恢复、停止、清理及 agent name 哈希只使用四项稳定身份。中文、emoji、长标题、同名标题及包含分隔符的标题均可处理；换行、终端和双向显示控制字符编码为可见转义，不截断身份 JSON。
- 下一轮成功完整自有清单提供最新 title，仅名称变化时调用 Herdr rename；已存在的活 workspace 与恢复超限任务也能同步。改名保留 claim、worktree、native session 和 agent name。命名 RPC 失败报告 `workspace-name-error`，不消耗执行恢复预算或中断健康执行；未知结果先重新观察。身份或 binding 冲突及取消继续按生命周期失败处理。名称同步与执行/清理共享 task 串行化，失去 claim 后不调度新的命名操作。
- Herdr 私有 XDG 与端点隔离；task native 环境保留调用方原 XDG set/unset 和认证目录。Bash/Zsh HISTFILE 使用私有文件；自定义 rc 和其他 shell 不在通用历史隔离保证内。
- 存活 agent 保持原连接；重新启动前停止并关闭已存在的 inactive workspace，以当前 native 环境重建，并清空该 pane 遗留的原生引用。会话选择只使用本机保存的 session_id；不把 inactive pane 的旧引用当作新 ID，不增加历史扫描或持久回执。
- 活 agent 直接连接并观察；需要启动且 session_id 有值则使用记录的 agent 和原生 ID resume；session_id=NULL 时记录 info 并启动全新原生会话，成功取得 ID 写回原行，沿用 task/claim/worktree。NULL 是新 claim 首次启动的正常状态，也覆盖启动成功但 ID 尚未保存的崩溃窗口，不增加历史反查、暂停或人工确认门槛。
- 本机 session_id 非空时，启动、重连和延后输入前观察到的原生引用必须与其一致；不同 ID 是可见错误，保留原记录并停止该次输入。session_id 为空时可采纳实际存活 agent 的真实 ID，仍不采纳 inactive pane 的旧引用；需要启动的 NULL 分支记录 info 后新建会话。
- 首次启动和明确恢复使用完整 prompt，显式声明 worker-managed、using-daynight、autopilot-managed-task，提供 project/task/claim/worktree 身份、实际路径/branch 和本次配置。Prompt 明确这是后台任务，任务范围及已有授权内的决定自行处理；只有完成任务确实需要用户提供 agent 无法在任务范围和已有授权内补足的信息、决策、授权或操作时，才按 managed 流程先将自己的 task 设为 paused=true 并核验后等待，问题解决且授权允许后解除暂停并核验再继续；等待 PR review、reviewer approval 或 CI，以及轮询超时，都不得作为设置 paused=true、请求用户介入、结束当前轮执行或退出的理由。Agent 自行等待、定期检查并继续交付，同时遵守用户独立发出的暂停、限制与撤销。适配层递交不透明 prompt；重连活 agent 不重发启动输入。普通技能不推断 managed 模式或加载其详细指令，缺失 assignment 保持等待。
- 定时巡查在原 claim 仍有效时读取当前 agent 状态。已就绪、未在启动的存活 agent 处于 idle 或 done 且当前任务未暂停周期输入时发送继续原任务的 ping；working、blocked、unknown、未就绪及尚有首次输入待递交时继续观察。Ping 完整正文使用字面量 `<system remider>` 与 `</system remider>` 标签包裹，保留原任务、claim、worktree 和授权，明确禁止因等待 PR review、reviewer approval、CI 或轮询超时设置 paused=true，要求自行等待并继续交付；不能把 agent 的 idle/done 当作业务完成。进程内保留上次输入对应的观察，观察未改变时不重复递交；未知输入结果先观察核对，不盲目重放。进入终止清理后不再发送业务 ping。
- task property paused:true 抑制周期 continuation ping，false 或缺席适用原策略。实际发送前，在 workspace 串行化及原生界面等待完成后重新读取服务端 task，核验原 active claim、worker 和 worktree 归属；读取失败、归属失效或暂停时均不发送。暂停跳过不记录为已递交、不改变输入基线，因此解除暂停后即使原生观察未改变也可正常 ping。标记不改变 Task 状态或 worker.phase、领取资格、原会话、观察、首次及待递交 assignment、恢复、人工输入或终止清理。
- Copilot 与 Codex 的每次 fresh/resume 启动固定使用 full access，并为本次任务目录启用信任，免除原生工具权限、目录信任及 hook trust 确认。Copilot 使用 `--allow-all --no-ask-user --no-sandbox`，并覆盖本次 workspace 环境为 `COPILOT_ALLOW_ALL=true`、`COPILOT_ASSISTED_APPROVAL=false`；Codex 使用 `--no-daemon`、`--dangerously-bypass-approvals-and-sandbox`、`--dangerously-bypass-hook-trust` 及当前真实任务路径的调用级 trusted 配置。该策略不是可选配置；不能通过 args 降低权限或恢复确认。
- Codex 每次 fresh/resume 启动在配置参数之后以两个独立 argv 传入 `-c`、`check_for_update_on_startup=false`，覆盖同名配置，关闭本次启动的更新检查和交互提示，使任务能够进入正常输入流程。该设置通过 Herdr 启动选项传递，任务 prompt 保持独立；Copilot 启动方式不变。
- 固定策略只作用于本次原生命令及任务 workspace，不改写全局 native 配置（包括用户 `config.toml`）、凭据或组织/操作系统策略。业务执行和交付仍遵循任务授权；缺失认证、集成或能力明确报错，不降级为等待权限确认。
- 保留官方 native/Herdr 集成、当前参数和 composer readiness 校验。原生历史可用性由原生命令报告，不扫描 provider 数据库或会话 manifest。已知 ID 恢复失败保持可见，不静默清除 ID。启动输入只提交到可用的业务 composer。
- 进程中的启动回执、输入提交和停止观察只保留内存，重启不承诺启动输入恰好一次。业务所需的人工输入通过原 worker attach 操作。

### W-08：人工介入与强制撤回

Web 人工输入通过 Task Session，Herdr 使用 attach。Retry/release/resume 的 runner 互斥、权限及版本规则相同；具体恢复与停止证据由原模式的 backend 提供。

- 等待人工时保留 claim、worktree、原会话和名额，显示 worker attach。Attach 只连接既有私有 Herdr，要求交互式终端，不读 Daynight 凭据/SQLite、不取 worker 锁、不启动 daemon 或 agent。Detach 保留执行；不可用或非零退出明确报错。
- retry/release/resume 先停止 runner，再取得同一实例锁同步处理指定 claim。锁占用时明确提示停止 runner；没有持久管理意图或后台管理队列。
- Retry 核验仍属于本 worker 的 active claim，尝试一次重连或恢复，保持 claim/agent/worktree。Pending 由 run 经正常名额与旧执行门槛启动。Herdr 的计数和额外尝试只在当前调用或进程内；Web 使用持久的单次 retry 授权，必须验证原 nativeSessionId、generation 与完整停止证明，缺失证据或 claim 失效时拒绝恢复，不能新建替代会话或重发初始 assignment。授权本身不表示恢复成功；就绪观察后恢复正常阶段，初始化期间仍显示等待；跨 tick 或重启不得把已换代的单次 retry 当成新授权，失败再次暂停。
- Release 先核验原 owner/admin、当前项目权限、原 claim 和指定版本。通知并停止 agent、关闭 workspace 后提交远端变更，确认源归属结束后才删 worktree 和置本机 done。远端拒绝时保留工作区供原执行恢复。Release 回到 todo、清空任务计时，保留 released 历史。
- Web 详情显示当前 active claim 的用户、机器、agent 和阶段，released 明确标识；completed 不表示当前认领。成员资料缺失时保留真实 userId，读取失败显示错误。原 owner/admin 可确认“强制撤回”：提交 active/released 的 claimId 和精确版本，同一事务清除 worker、返回 todo、清空任务起止时间、设置 allowAgents=false，其他资料保持。completed 或缺失 worker 不提供该操作。
- 撤回确认说明所有重置结果以及远端 agent 不保证立即停止，取消不写入，冲突重新审阅，未知结果只读核对。撤回无需 stoppedConfirmed 或源机器在线，不撤销外部凭据；原 worker 下次成功完整自有清单发现原 claim 缺席后进入既有终止清理。自动再次领取需要明确重新开启许可。
- Resume 核验 released previousClaimId、ready、原 owner/admin 和精确版本，保留明确人工安排的自动许可/平台例外，取得 fresh claimId/worktreeId 后登记 pending、session_id=NULL。普通 daemon 跳过 released 并继续分页。
- 用户给定 --if-version 不替换。请求前生成并输出 fresh ID；未知结果只 GET 核对、不重放。仍未知或命令中断时，操作者先核对远端结果，再启动 runner。命令不承诺跨进程续接原管理意图。
- Transfer API、typed operation、CLI 命令及 target descriptor 已移除；没有目标执行移交。服务端继续保留 release 的 stoppedConfirmed、resume 的资格检查、唯一归属、权限及旧 claim fencing。

### W-09：SQLite、对账、退出与恢复

- 主索引表精确为 projects(project_id,repo_url,local_path) 与 tasks(project_id,task_id,claim_id,status,agent,session_id,agent_control_mode)。Task 主键为 project/task/claim；status 为 pending/active/done，agent 为 copilot/codex/claude，session_id nullable；agent_control_mode 为 herdr/web，来自实际 claim。同 project/task 至多一个 active；结束行保留。
- 项目映射在 claim 前保存。首次与空库启动先解析并登记配置项目，再查询配置与持久映射并集的自有 claim。映射有未结束任务或实际受管资源时不能改变；移出配置只停止新领取，原映射继续对账。
- 完整 workerId-only 查询穷尽相关项目及分页，固定当前认证 principal。失败、部分查询或未查询项目不能授权缺席清理。Herdr/Git 读取失败不作为空资源；未知项目的遗留资源保留并报告。
- 远端实际 claim 缺少本机行时补 pending；确认可以启动先提交 active 后建资源；成功完整清单缺少原 claim 时统一进入该 task 串行且独立退避的清理 job，即使全局快照没有找到资源也不能直接把本机行置 done。只有 claim 身份而没有 worktreeId 时，重新读取原模式和 Git 的权威资源；发现实际归属后使用其完整身份，否则仅移除经检查的无注册空预留目录，并在原资源确已不存在后结束本机记录。同 task 路径已有可识别的其他 claim 资源时，旧 claim 不删除该资源。资源发现覆盖历史 done 行及遗留受管资源，旧资源未收尾前同 task 新 claim 等待。清理或退出关闭已验证归属的 Herdr workspace 前，缺失本机行的 claim 必须以实际观察的 agent 类型登记 pending，存活 agent 的已知原生会话 ID 一并保存；重启后继续清理保留的 worktree，再允许同 task 后继执行。无法确认原 agent 类型时保留 workspace 并报告错误，不从当前配置猜测。未证明归属的 Git-only 资源不得据此登记。
- Herdr 的配置、业务启动/输入回执、PID 观察、执行恢复次数和管理意图不持久保存或转存其他台账。具备完整资源身份的终态清理独立持久保存原 claim/worktree 身份、首个期限及失败重试调度，不保存 notified/submitted 或资源完成标记；只有 claim 身份时不捏造 worktreeId 或建立替代台账，失败退避仅在进程内保留，重启通过仍未完成的本机行重新发现资源。实际状态必须从资源自己的 source of truth 读取。日志不作为恢复输入。业务恢复使用当前适用设置；执行恢复计数和超限等待只在当前进程内，重启清零。
- Web 自动恢复预算耗尽或既有失败门槛阻止执行时，必须持久保存可诊断的暂停原因，保留恢复次数、原 claim 和原生身份。暂停门禁先于 worktree 准备、执行初始化、Controller 准备与启动和原生输入；多轮 tick、普通重启及 shutdown/clearShutdown 均不能绕过。最后一次合法恢复仍健康时，不能仅因次数达到上限而暂停；健康执行的正常关停恢复仍允许。
- 升级前次数已耗尽、缺少暂停原因且没有正常关停来源的 Web 停止记录，必须在启动前根据原 journal 和完整停止证明识别并补齐暂停，不能先启动旧 generation。停止证明不足时保留责任并显示可诊断等待，不启动替代运行。
- Web 执行被阻止后仍对账远端摘要，发布 waiting、原 nativeSessionId 和 herdr:null，保留 active claim。发布失败不消耗原生恢复预算、不清除本地暂停；后续轮次读取新 task 版本后重试，摘要一致后不重复写。暂停不释放名额、不删除资源、不写业务 done，也不改变 task.properties.paused 的 Herdr 周期 ping 语义。
- Ctrl+C 的根取消信号同步停止报告触发、新领取和调度，并取消报告及所有运行中的 job（包括终止清理 job），在等待报告收尾前完成取消。等待报告期间终止清理不能继续删除 worktree 或把未完成行置 done；报告与 job 全部收尾后直接中断并停止受管 agent、关闭 workspace。进程退出不发送清理 prompt，也不等待 agent 清理轮；工作区外临时资源可能遗留。保留 claim、worktree、原生 session ID 与所有未完成 active/pending 行，包括归属已经结束的任务；退出不删除 worktree、不把未完成行置 done。重启恢复已有终态清理责任并核对实际资源，包括本机行已 done 而调度记录尚未删除的窗口；当前配置改为 Web 不能使原 Herdr 清理责任失去后端核验能力，也不能据此提前释放容量；该清理后端不可用时，其初始化与重试仍按原 claim 退避，不得阻塞无关的健康 Web 执行。新的归属结束判断仍要求成功完整清单。待确认的停止操作收尾后才停止私有实例；停止错误保持可见，无法确认停止时保留私有 Herdr 与相关资源。正常完成、release、强制撤回和人工管理按 W-10 的通知与资源清理规则执行。
- 主索引与独立清理调度表共同使用 `user_version=7`，版本 6→7 删除清理通知步骤字段并保留身份、期限及重试调度；版本 5 原索引升级时保留项目和任务行。Web 执行状态库独立使用版本 2，版本 1→2 删除重复的 cleanup 输入、结果和资源完成字段，保留控制意图、期限和操作身份。Controller journal 使用版本 6。五个业务库的版本 0 均在既有准入后丢弃原 schema 和数据，并通过基线与编号升级重建；已有空文件和查询访问同样适用。有效非零迁移保留数据，旧详细状态库 1–4 明确拒绝并保留原库；操作者停止旧 worker 后自行移除该旧库再启动。各库分别保证单库原子性，任何所需库打开失败都不启动协调业务。[SQLite 升级需求](cli-sqlite-migrations.md)定义共同的版本、查询、准入和错误约束。原生历史与 workerId 保留原有位置。

### W-10：Agent 完成与资源清理

Web 与 Herdr 共用 claim 结束和工作区删除门槛。两种模式保留首个期限和资源身份，每次从权威来源观察剩余资源；清理完成必须由本次实际观察证明。Herdr 的 idle 仅决定何时开始停止，Web 的清理回执从 Controller journal 读取；两者均须确认原生停止后才能删除 worktree。进程退出直接停止所拥有执行，不派发清理 prompt。

- Agent 完成全部要求、验收和证据后，最后使用原 claimId 与观察版本通过 task set-status done 提交已有完成操作。必要 PR、授权合并和人工验收未完成时保持任务未完成；worker 不重复解释或提交业务 done。
- 正常对账发现原 claim 不在成功完整清单时通知 agent 清理可归属的工作区外临时资源，最多等待首个清理期限内的 10 分钟，再停止进程、关闭 workspace、删除 worktree，最后本机 done。清理资源观察、通知、停止/关闭及 worktree 核验与删除的单次操作预算统一为 5 分钟，内部 RPC、Controller 清理请求与 Git 命令受同一预算约束；通知还受原 10 分钟期限的剩余时间限制。普通执行操作的预算保持各自语义。Web 模式在确认停止后上传只读 Session 文件归档，ready 前保留 worktree 与待归档源；上传失败只重试归档，不重启 Agent 或重跑任务。Done/release/强制撤回后的本地结束规则一致，分支与历史保留。
- Herdr 在一次有界清理调用内向仍存活的原 agent 发送一次建议性清理消息，随后重新读取 Herdr；通知后的新观察为 idle、资源已消失或原期限届满允许开始停止，不要求序列计数递增或 interactiveReady。通知失败或结果未知时保留错误并沿用原期限，在同一次调用内不重发。Herdr 没有可查询的逐输入操作身份，Worker 不另建通知台账，因此调用中断或重启后，下一次尝试可能再次通知仍存活的原 agent。Idle 和递交回执都不证明资源已清理；停止后仍须实际确认进程和 workspace 消失。Worker 进程退出遵循 W-09 的直接停止规则。
- 终态清理保留首个期限；失败重试和重启不重新计时，不为清理新建 agent。Web 以同一 cleanupOperationId 查询 Controller 拥有的原生操作回执，未知结果通过该操作身份核对。Herdr 的建议性通知遵守前述重复边界。重启恢复原 claim 的清理责任并重新核对资源归属；已经确认结束的责任可在后续服务轮询失败时继续，不能恢复为业务执行。
- 清理失败按 claim 独立退避，连续失败等待 1、2、4、8、16、32 秒，随后每次最多 60 秒，到期后的正常对账才重试。同 claim 的操作严格串行，取消等待在途资源操作收尾，不留下与下次重试并发的后台删除；退避不消耗业务 recoveryLimit，不释放容量和同 task 旧 claim 屏障。持续失败项不阻塞其他可清理项；有余量时健康任务仍可领取和推进，已运行任务继续执行。
- 每次实际失败记录原错误、清理阶段和下一次重试时间，区分停止未确认、Agent 已停但后端资源关闭未确认、Agent 已停但归档待完成、Agent 已停但 worktree 删除失败；调度错误与 Controller 拥有的原生操作结果分别报告。满槽且存在失败清理时，阻塞责任集合变化才输出容量诊断，说明保留的槽位、错误原因及解除原因后的自动重试方式。普通 tick 不重复刷屏。调度持久化失败保留原清理错误与存储错误，当前进程继续独立退避，不让未处理的 job rejection 跳过退出停止证明；持久写成功前，不把该次 retry 决策描述为已跨重启保存，已有持久清理责任保持。
- 失败保留错误与收尾责任；每次重试从 source of truth 读取剩余资源，已不存在的资源即满足对应清理目标。删除、停止等操作的响应丢失后重新观察结果，不因缺少成功回执判定资源仍在。读取失败或无法确认停止时不能删除工作区或标 done，清理不影响其他任务与人工 Herdr。
- 已知目标的清理按对应执行推进，删除仅验证该目标的 Git 工作区。退出立即取消运行中的等待，进行原执行停止证明，不等待失败退避、不归档、不删除 worktree，也不以 Git 发现成功作为停止门槛。已经停止 Agent 的结果不能被文件删除错误覆盖；停止未确认与后端关闭未确认分别诊断，任一无法确认时退出仍须失败并保留责任。Web 已写 done 而调度责任尚未删除时，退出仍从原进程实例和 endpoint 重新确认停止与关闭，不操作 Git；正常对账则重新观察并清理剩余 Git 资源后才结束责任。原有终态清理责任留待正常恢复。

### W-11：可观察性与交付验收

- 身份与认证就绪后立即报告运行快照，独立 30 秒周期及成功完整清单、新 claim 触发不受 tick、候选查询或容量影响。最多一次进行中尝试与一个合并触发，采集含正常原生终止/join 最多 5 秒、HTTP 最多 10 秒、总预算 15 秒。退出先同步取消全部 job（包括终止清理）并停止调度，再等待报告收尾，最后释放既有资源与实例锁；未知写入不重放，监控失败不改变任务执行。
- 运行快照报告真实 OS、CPU 逻辑处理器及差分使用率、内存、启动目录文件系统容量和软件版本。初始未知清单为 null，真实空清单为 []，失败保留已有观测。字段失败、未安装及 Herdr 未运行各有明确状态；纯 Web 报告不启动 Herdr。详细采集口径、缓存、错误及清单规则由[上报需求](daynight-worker-reporting.md)拥有。
- stderr 和 JSONL 提供 workerId、实际平台、projectId/taskId/claimId、agent、已知 sessionId 及启动、恢复、等待、清理与错误事件。凭据脱敏后，终端输出将上下文、消息及错误链中的完整连字符 GUID 缩写为首段 8 位十六进制字符，保留大小写；其他文本不变。JSONL 的字段、消息和错误保留完整 ID，供精确检索；API、prompt 与持久化中的 ID 不变。相同 claim 的等待/执行阶段、终端和已知原生会话不变时，轮询不重复记录；阶段切换及会话或终端变化及时报告，不同 claim 独立判断。成功启动建立观察基线，下一轮相同观察不重复提示重连。资源保留警告在连续成功观察中只提示一次，警告消失后再次出现则重新提示。真实启动、恢复、清理、人工操作和失败尝试保留日志；NULL 新建路径记录普通 info。错误保留类型和 cause，凭据脱敏，不输出完整 prompt。
- 完整清单和私有实例就绪后显示 attach 提示；客户端只应用 attachment descriptor 的环境与移除项，原 task pane 保留自己的 native XDG/HISTFILE。
- 许可/平台 UI 的双语、键盘、焦点和响应式行为保持 W-02/W-03。真实 Herdr/native、受控故障、各平台和完整 Goal 验收分别记录来源，文档或模拟进程不替代真实运行证据。

## 可观察验收

| 范围 | 必须观察到的结果 |
|---|---|
| W-01、W-07 | 配置严格、省略值一致，项目选择明确；managed assignment 完整，正常与 managed 模式互斥；后台 prompt 明确范围内自主决定、必要介入前暂停自身任务、解决并获准后解除暂停，以及等待 PR review、reviewer approval、CI 或轮询超时时持续交付、不得因此设置 paused=true；恢复使用保存的 agent 和当前适用配置；两个 provider 的 fresh/resume 均带固定 full access、目录信任参数或环境，冲突参数和缺失能力明确拒绝；Codex 通过独立启动 argv 关闭更新检查，有新版时不等待更新选择，没有新版时正常进入任务，配置参数和含引号等字符的 prompt 保持各自原值与传递位置。 |
| W-02、W-03 | 默认许可、双向确认、平台清除、未知结果及候选组合过滤成立；assignedTo=me 贯穿全部候选页，他人和未分配任务不遮挡本人合格候选。 |
| W-04、W-05 | 本人可领取，他人和未分配任务的直接 claim 拒绝且保持数据；负责人变更与 claim 竞争遵循项目锁及精确版本；既有库存和人工 resume 保留原执行权限；同 task 竞争单赢家；未知 claim 不启动资源或重放；多项目公平调度，等待与收尾占容量，同 task 旧资源形成启动屏障；撤回只允许原 owner/admin，原子重置归属/状态/计时并关闭许可。 |
| W-06 | Dirty worktree 复用，静态归属、注册、指针与删除核对成立；普通恢复中的缺失原成果和外来路径保持可见错误；清理中的目录已缺失、Git 注册残留、最终 unlink 后空目录及无注册空预留目录均能收敛，无关非空目录保持不变且不阻断其他资源发现。 |
| W-07、W-09（Herdr） | 活进程重连不重发启动 prompt；idle/done 且就绪、未暂停时 ping；暂停期间多轮零 ping，改为 false 或移除后同一观察恢复 ping；排队或界面等待期间设置暂停时，最终递交边界使用当前服务端值；读取失败及原 claim 换代不递交；首次和待递交 assignment、观察、恢复及清理不受标记拦截。working/blocked/unknown 保持观察，未改变观察和未知回执不触发重复输入；已知原生 ID resume；首次启动与恢复中的 NULL 分支记录 info 后新建并保存 ID；空库先建项目映射再找回已有 claim。标题首先可见，改名按需同步且不改变执行身份，含控制字符/分隔符/长标题；命名故障和未知回执不消耗恢复预算。 |
| W-08 | 人工操作与 run 互斥；远端拒绝保留 worktree；成功后本机删除失败可由下次对账收尾；未知结果不重放；Web 强制撤回不声明远端已停，原 worker 下次对账收尾。 |
| W-07、W-08、W-09（Web） | SQLite 重开保留暂停原因、次数、claim 与原生身份；暂停后多轮 tick、Worker restart、shutdown/clearShutdown 均不准备或启动原生执行、不递交初始输入；旧耗尽停止记录与健康最后一代、健康 orderly restart 成对验证；waiting 首次发布失败后以新版本对账成功且稳定后不重复写；retry 成功与失败均保留原身份，claim 失效、停止证明不足或缺失原生 ID 时安全拒绝；暂停继续占用容量并保留资源。 |
| W-09 | 主索引字段及冻结模式正确，三态/唯一 active；退出取消并等待所有 job 收尾，含正在等待通知、清理轮或停止确认的终止清理 job，随后直接停止并关闭 workspace，不发送清理 prompt、不等待清理轮、不删除 worktree、不把未完成行置 done；归属已结束及原本缺失本机行的任务也保留 worktree、有效 session ID 与未完成行，重启恢复原清理责任、原期限和资源身份，核对实际资源后完成清理并解除同 task 后继的启动屏障；停止错误可见，停止不确定时私有 Herdr 保留。 |
| W-10 | 正常完整清单缺席统一清理，正常完成、release、强制撤回及人工管理均按同一资源目标清理；通知后的新观察为 idle 时允许开始停止，缺失或不变计数不阻塞，清理完成仍要求实际资源消失；完整资源身份的首个十分钟期限和每 claim 退避跨重启保持，身份尚不完整时通过未完成索引行重新发现并重新建立进程内退避；Herdr 的建议性通知在调用中断后允许重复，Web 操作由 Controller 原生回执核对；可控时钟与故障注入覆盖持续失败、上限、串行、公平推进和解除原因后的收敛；归档失败保源、有余量健康任务推进、满槽准确诊断及旧 claim 屏障成立；持久化写失败时进程内退避保留原错误且不妨碍 shutdown；shutdown 不等待退避、不重复归档/删除，原停止证明与 backend-close 失败保持独立；Web done 与调度删除之间中断后的退出重新核验原进程和 endpoint，正常 tick 继续收敛实际 Git 资源；旧资源完成标记及丢失的操作响应不能代替当前观察。 |
| W-11 | 独立报告覆盖空闲、满并发与长操作，清单未知/空/旧及部分字段错误保持区分；采集、单飞、期限、取消与关停满足[上报需求](daynight-worker-reporting.md#验证)。关联日志、Warning、原错误链和脱敏成立；终端上下文、消息及错误链中的完整连字符 GUID 在脱敏后显示首段 8 位，保留大小写且不改变非 GUID 文本，JSONL 各字段、消息与错误仍含完整 ID；attach 只连接并保持既有执行；验证关联实际源码、平台和环境。 |

完整平台运行验收要求其实际门禁与端到端结果，组件检查和 schema 验证不能替代。
