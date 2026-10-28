# Worker 需求

本文定义 `daynight worker run` 的行为与可观察验收条件。[整体架构](../design/daynight-worker.md)拥有运行机制，[认领架构](../design/daynight-worker-claims.md)拥有服务端归属协议。命令可用性与组件验证不替代 Linux、macOS、Windows 的完整原生运行验收。

## 目标与范围

Worker 是前台常驻进程，通过进程内 typed ApiClient 和 REST API 领取配置仓库中允许 Agent 执行的 ready task，在专用 Herdr 和系统管理的 Git worktree 中运行 Copilot 或 Codex。服务端拥有资格、权限、唯一 claim 和完成操作；worker 拥有调度、资源、对账和清理；agent 拥有业务交付、验收、证据及最后一次 claim-bound done。

本机持久业务数据只承担项目映射、认领和原生会话索引。重启通过服务端、SQLite、Git、Herdr 的当前事实重新对账，执行过程中的计时、计数、提交与管理进度只存在内存中。

## 必须满足的行为

### W-01：前台运行、配置与平台

- `daynight worker run` 在前台运行，支持 Linux、macOS 和 Windows。实际平台为 windows/linux/macos；WSL Linux 计为 linux，未知平台明确拒绝。
- `daynight worker setup` 要求 stdin/stderr 为交互终端，先汇总环境缺项与修复指引，再单选 Copilot/Codex 并多选一个或多个既有可访问 Project。重复配置预选当前项目；最终确认前展示所选 agent、Project、目录、移除范围及不兼容参数重置。所选 agent 应用于全部选中 Project；匹配注册保留传输 URL/路径，同类型 model/args 保留，切换类型清除不兼容值。
- Setup 将 agent/model/args 与完整 Project 选择一次原子保存，相关字段或服务/凭据变动时拒绝旧选择；无关配置、原 root 拼写、注释和安全 alias 保留。取消、空选、认证/API/保存失败均无部分保存。已有 claim、worktree 和 native history 保留；重新启动的 native 进程使用当前适用配置。
- Setup 只做有界只读环境探测，不启动 daemon/native agent/worker，不 clone、打开 SQLite、claim、安装或登录。探测验证所选 agent 的固定 full access 参数能力；Codex 至少为 0.135。缺原生依赖允许保存并明确要求修复；只读版本、参数及 hook 检查不证明 provider 登录、真实 hook 执行、live 协议或完整任务验收。取消等待已启动探测收尾，未确认清理故障保留原错误链并使 setup 明确失败。
- 独立 worker mapping 支持 repositoryRoot、maxConcurrent、pollIntervalMs、recoveryLimit、agent、model、args 和 repositories，默认值为 ~/daynights、1、5000、3、copilot、null、[] 和 []。省略配置文件、worker 或可选字段使用这些默认值；repositories 不从 review 推断。
- 配置读取不创建或重写文件。只有确实缺失的文件按缺省处理；已知非 nullable 字段显式 null、已知字段类型或值错误、YAML 结构和重复键、读取故障及取消均明确失败。根节点、review、worker 及其仓库条目的未知字段在运行时忽略，CLI 编辑保留其原节点。model:null 保留清除语义。仓库 remote/path 必填，可有 projectId 与 agent/model/args 覆盖；路径相对 config.yml 目录或为绝对路径，不展开 tilde，拒绝 drive-relative Windows 路径和重叠仓库/状态目录。
- 同 agent 类型逐字段继承；切换类型清除未显式给出的 model/args。Args 整体替换，不允许覆盖 worker 拥有的 cwd/session/model/mode 位置或固定 full access 策略；冲突参数在启动前明确拒绝。配置在启动/重启读取，不热重载；已认领执行保留 agent 和原生 session ID，重新启动使用当前适用的 model/args，不把另一工具的参数套到原工具。
- `worker repo list [--json]` 读取本地选择；add/remove 选择远端现存可访问 Project。省略 --project 时多选显示名称、完整 UUID、repoUrl，至少选一项；显式 --project 支持非交互。新增保存 projectId、原 repoUrl、绝对 path；匹配既有注册保留传输 URL、路径和覆盖，remote-only 项只补 projectId。Remove 只改变后续领取范围，保留 clone、claim、worktree 和原生历史。
- worker.repositoryRoot 独立于 review，只在新增注册时展开，改变根不移动已有路径。Repo 操作拥有 worker.repositories 及保留条目的 projectId；setup 另拥有全局 agent/model/args 及确认重置的仓库原生字段。所有写入锁内重读并拒绝相关服务/凭据、根和仓库变动，保护其他解码值及保留条目的未知字段；显式删除拥有整个所选条目。共享 alias 影响非归属值时拒绝保存，保持原文件；无关字段、注释和安全 alias 保留。网络与提示不持配置锁。
- 空配置的交互式 run 先引导选择，非交互给出 repo add --project 指引。选择使用同一份捕获的服务凭据及 worker 设置；取消、失败或不完整选择不能启动任务资源。持久恢复动作从本次成功项目映射及完整清单开始，不承诺离线延续上个进程的计时或操作意图。
- 首次启动随机生成稳定 workerId，复用配置锁与原子替换保存到 ~/.daynight/config.yml。身份创建只拥有根字段 workerId；根循环 alias 等使未知或其他非归属解码值变化时拒绝保存并保留原文件。合法值只读复用，非法值拒绝，身份持久化后才可 claim。每用户环境只有一个 worker 实例，固定 ~/.daynight/worker/ 保存 SQLite、实例锁、日志、Herdr 和临时资源；第二实例拒绝，端点路径不合法明确失败。
- 一个状态目录用于当前配置的单一服务、账号和 workerId。切换前先结束旧执行，再重建本机状态；不提供跨服务或跨账号的旧执行自动接续。

### W-02：Agent 自动执行许可

- Task 具有独立的布尔字段 `allowAgents`，表示是否允许 worker 自动领取并交给 Agent 处理。它与用户身份、项目权限、实际执行者及 agent 类型独立。
- 旧任务通过数据库迁移设为 `true`，保留其余业务数据、版本与时间；新任务始终默认为 `false`，创建输入不能直接启用。普通字段更新未提供此字段时保留原值，显式 `false` 表示关闭。
- 服务端、CLI 和 Web 一致支持许可的查询、展示与明确操作。完整 task 与图节点必填布尔 allowAgents，严格拒绝缺失、null 或非布尔响应。CLI 的 update/list/ready 使用 `--allow-agents true|false`。Worker 的自动候选查询同时使用 true 与实际平台兼容筛选，并在后续候选页中保留两者；实际平台由执行运行时识别，未知或不支持时等待。自动认领在服务端事务中重验许可、ready、平台、精确版本和唯一归属，自动选出的 ID 不构成人工指定。普通技能不提供自动候选选择或连续调度；worker 和 agent 不得自行启用许可。
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

自动领取同时要求 allowAgents=true、ready、平台兼容及没有 active claim。服务端在同一项目事务中重验成员、精确版本、许可、平台、依赖和归属。同 task 跨用户、机器和 worker 只有一个有效 claim，竞争失败方不得启动资源。

- 每次取得新的执行使用 fresh claimId/worktreeId；稳定 workerId 和项目映射先保存，实际授予后登记本机 pending。请求标识和版本只留当前进程；未知响应记录 Warning，不创建资源、不重发原请求，通过后续完整自有清单找回实际授予。
- Task properties 保存受保护的最新 worker 归属、实际平台、agent 和已知会话摘要。普通 create/PATCH 拒绝写 worker，即使 null 或原值；PR 与 worker 更新相互保留。完整 DTO 显式包含 worker:null 或归属记录。
- 会话摘要、释放、撤回与完成核对当前 claim 和精确版本，旧执行不能覆盖新归属。服务端验证当前成员与 owner/admin 权限，不远程证明机器进程或 Git 内容。
- Worker 直接调用进程内 typed ApiClient，不启动 daynight 子进程。HTTP 独立有界；未知写入只读取核对，不自动重放。远端 phase、Herdr 和 nativeSessionId 是展示投影，不替代本机实际资源观察。

### W-05：调度与全局并发

- 配置仓库轮流获得领取机会；新候选保持服务端 ready 顺序。已有 pending 优先，项目内按稳定 task_id 顺序选择。Pending 和新领取都在每成功分配一个名额后轮转到下一个项目，持续繁忙的项目不能一次占满所有空闲名额。
- Active 从启动前资源预留到收尾完成占用名额。等待 CI/review、人工输入、恢复超限及清理仍占用。容量是 active 行、实际归属资源、已确认收尾责任及适配器待确认停止责任按 claim 去重的并集；没有本机行的孤立执行也须在全部清理完成后才释放名额和同 task 启动屏障。
- Pending 在没有实际运行资源时不占名额；同 task 旧执行停止、关闭 workspace 并删除 worktree 后，新 claim 才能 active。降低上限不抢占已有任务。并发上限约束本机 active 资源数，迟到授予可以留下等待名额的 pending。
- 空或不兼容仓库不占名额。同仓库不同 task 可以并发；各 task 的操作串行，不同任务的有界等待和清理互不阻塞。
- 本机已有 active 且仍归属的任务先排队恢复，在任务串行操作内读取当前 Herdr；其他工作区的全局 Git 发现错误不阻塞已有名额。新的 pending 启动和新 claim 分配继续要求完整全局资源发现成功。

### W-06：稳定的 task worktree

- 分支为 daynight/<taskId>，目录为 .worktrees/daynight/<taskId>。首次分支从仓库 HEAD 创建，保留分支从原 tip 使用；仍有效 claim 正常复用 dirty worktree，不 reset/clean。普通退出、失败和崩溃保留其 worktree 与原生历史。
- 创建、复用和删除核对实际仓库、Git 注册、静态 claim/worktree 身份、分支及精确 .git 指针。符号链接、外来路径、缺指针和歧义注册不能授权破坏性动作。Device/inode 仅为辅助，refs backend 通过 Git 核对，支持 reftable。
- 原生会话已知而原 worktree 意外丢失时报告错误并保留 active；尚无原会话的新执行可以按规则准备工作区。异常既有路径保留并报告，不用空目录掩盖旧成果丢失。
- Git 静态标记没有 workerId，须关联本机行、专用 Herdr 或当前自有 claim 才能证明属于本 worker。没有这种关联的 Git-only 遗留资源报告并保留，不因自有清单缺席删除。
- 终止删除前确认当前受管进程停止、workspace 关闭。保留 .git 指针至内容移除完成，最后删除目录和注册；中断后仍存在但缺指针的路径保留错误。结束后保留分支、提交历史和交付引用，新 claim 使用新工作区身份及原生会话。

### W-07：专用 Herdr 与 agent 执行

- Worker 自动管理专用 Herdr，每 task/claim 一个 workspace/pane/agent，不干扰人工实例。保持 resume_agents_on_restore=false，由 worker 唯一决定启动或恢复。
- Herdr 私有 XDG 与端点隔离；task native 环境保留调用方原 XDG set/unset 和认证目录。Bash/Zsh HISTFILE 使用私有文件；自定义 rc 和其他 shell 不在通用历史隔离保证内。
- 存活 agent 保持原连接；重新启动前停止并关闭已存在的 inactive workspace，以当前 native 环境重建，并清空该 pane 遗留的原生引用。会话选择只使用本机保存的 session_id；不把 inactive pane 的旧引用当作新 ID，不增加历史扫描或持久回执。
- 活 agent 直接连接并观察；需要启动且 session_id 有值则使用记录的 agent 和原生 ID resume；session_id=NULL 时 Warning 后启动全新原生会话，成功取得 ID 写回原行，沿用 task/claim/worktree。该 NULL 规则包括启动成功但 ID 尚未保存的崩溃窗口，不增加历史反查、暂停或人工确认门槛。
- 本机 session_id 非空时，启动、重连和延后输入前观察到的原生引用必须与其一致；不同 ID 是可见错误，保留原记录并停止该次输入。session_id 为空时可采纳实际存活 agent 的真实 ID，仍不采纳 inactive pane 的旧引用；需要启动的 NULL 分支保持 Warning 后全新会话。
- 首次启动和明确恢复使用完整 prompt，显式声明 worker-managed、using-daynight、execute-task-in-managed，提供 project/task/claim/worktree 身份、实际路径/branch 和本次配置。Prompt 明确这是后台任务，不向用户提问，任务范围及已有授权内的决定自行处理；等待 review 或 CI 时自行等待、定期检查并继续交付，不因此结束当前轮执行或退出。适配层递交不透明 prompt；重连活 agent 不重发启动输入。普通技能不推断 managed 模式或加载其详细指令，缺失 assignment 保持等待。
- 定时巡查在原 claim 仍有效时读取当前 agent 状态。已就绪、未在启动的存活 agent 处于 idle 或 done 时发送继续原任务的 ping；working、blocked、unknown、未就绪及尚有首次输入待递交时继续观察。Ping 保留原任务、claim、worktree 和授权，提醒自行等待 review/CI，不能把 agent 的 idle/done 当作业务完成。进程内保留上次输入对应的观察，观察未改变时不重复递交；未知输入结果先观察核对，不盲目重放。进入终止清理后不再发送业务 ping。
- Copilot 与 Codex 的每次 fresh/resume 启动固定使用 full access，并为本次任务目录启用信任，免除原生工具权限、目录信任及 hook trust 确认。Copilot 使用 `--allow-all --no-ask-user --no-sandbox`，并覆盖本次 workspace 环境为 `COPILOT_ALLOW_ALL=true`、`COPILOT_ASSISTED_APPROVAL=false`；Codex 使用 `--no-daemon`、`--dangerously-bypass-approvals-and-sandbox`、`--dangerously-bypass-hook-trust` 及当前真实任务路径的调用级 trusted 配置。该策略不是可选配置；不能通过 args 降低权限或恢复确认。
- 固定策略只作用于本次原生命令及任务 workspace，不改写全局 native 配置、凭据或组织/操作系统策略。业务执行和交付仍遵循任务授权；缺失认证、集成或能力明确报错，不降级为等待权限确认。
- 保留官方 native/Herdr 集成、当前参数和 composer readiness 校验。原生历史可用性由原生命令报告，不扫描 provider 数据库或会话 manifest。已知 ID 恢复失败保持可见，不静默清除 ID。启动输入只提交到可用的业务 composer。
- 进程中的启动回执、输入提交和停止观察只保留内存，重启不承诺启动输入恰好一次。业务所需的人工输入通过原 worker attach 操作。

### W-08：人工介入与强制撤回

- 等待人工时保留 claim、worktree、原会话和名额，显示 worker attach。Attach 只连接既有私有 Herdr，要求交互式终端，不读 Daynight 凭据/SQLite、不取 worker 锁、不启动 daemon 或 agent。Detach 保留执行；不可用或非零退出明确报错。
- retry/release/resume 先停止 runner，再取得同一实例锁同步处理指定 claim。锁占用时明确提示停止 runner；没有持久管理意图或后台管理队列。
- Retry 核验仍属于本 worker 的 active claim，尝试一次重连或恢复，保持 claim/agent/worktree。Pending 由 run 经正常名额与旧执行门槛启动。计数和额外尝试只在当前调用或进程内，重启不保留累计预算。
- Release 先核验原 owner/admin、当前项目权限、原 claim 和指定版本。通知并停止 agent、关闭 workspace 后提交远端变更，确认源归属结束后才删 worktree 和置本机 done。远端拒绝时保留工作区供原执行恢复。Release 回到 todo、清空任务计时，保留 released 历史。
- Web 详情显示当前 active claim 的用户、机器、agent 和阶段，released 明确标识；completed 不表示当前认领。成员资料缺失时保留真实 userId，读取失败显示错误。原 owner/admin 可确认“强制撤回”：提交 active/released 的 claimId 和精确版本，同一事务清除 worker、返回 todo、清空任务起止时间、设置 allowAgents=false，其他资料保持。completed/null 不提供该操作。
- 撤回确认说明所有重置结果以及远端 agent 不保证立即停止，取消不写入，冲突重新审阅，未知结果只读核对。撤回无需 stoppedConfirmed 或源机器在线，不撤销外部凭据；原 worker 下次成功完整自有清单发现原 claim 缺席后进入既有终止清理。自动再次领取需要明确重新开启许可。
- Resume 核验 released previousClaimId、ready、原 owner/admin 和精确版本，保留明确人工安排的自动许可/平台例外，取得 fresh claimId/worktreeId 后登记 pending、session_id=NULL。普通 daemon 跳过 released 并继续分页。
- 用户给定 --if-version 不替换。请求前生成并输出 fresh ID；未知结果只 GET 核对、不重放。仍未知或命令中断时，操作者先核对远端结果，再启动 runner。命令不承诺跨进程续接原管理意图。
- Transfer API、typed operation、CLI 命令及 target descriptor 已移除；没有目标执行移交。服务端继续保留 release 的 stoppedConfirmed、resume 的资格检查、唯一归属、权限及旧 claim fencing。

### W-09：SQLite、对账、退出与恢复

- 业务表精确为 projects(project_id,repo_url,local_path) 与 tasks(project_id,task_id,claim_id,status,agent,session_id)。Task 主键为 project/task/claim；status 为 pending/active/done，agent 为 copilot/codex，session_id nullable。同 project/task 至多一个 active；结束行保留。
- 项目映射在 claim 前保存。首次与空库启动先解析并登记配置项目，再查询配置与持久映射并集的自有 claim。映射有未结束任务或实际受管资源时不能改变；移出配置只停止新领取，原映射继续对账。
- 完整 workerId-only 查询穷尽相关项目及分页，固定当前认证 principal。失败、部分查询或未查询项目不能授权缺席清理。Herdr/Git 读取失败不作为空资源；未知项目的遗留资源保留并报告。
- 远端实际 claim 缺少本机行时补 pending；确认可以启动先提交 active 后建资源；成功完整清单缺少原 claim 时统一清理。资源发现覆盖历史 done 行及遗留受管资源，旧资源未收尾前同 task 新 claim 等待。
- 配置、启动/输入回执、PID 观察、恢复次数、清理进度、原期限和管理意图不持久保存或转存其他台账。日志不作为恢复输入。恢复使用当前适用设置；计数和超限等待只在当前进程内，重启清零。
- Ctrl+C 停止新领取和调度，取消所有运行中的 job（包括终止清理 job），等待它们全部收尾后直接中断并停止受管 agent、关闭 workspace。进程退出不发送清理 prompt，也不等待 agent 清理轮；工作区外临时资源可能遗留。保留 claim、worktree、原生 session ID 与所有未完成 active/pending 行，包括归属已经结束的任务；退出不删除 worktree、不把未完成行置 done。重启后按正常完整清单对账，为已结束归属的剩余资源重新进入终止清理。待确认的停止操作收尾后才停止私有实例；停止错误保持可见，无法确认停止时保留私有 Herdr 与相关资源。正常完成、release、强制撤回和人工管理的清理语义不变。
- 仅新 schema 建库；不迁移旧详细状态库，不自动删除真实数据库。操作者停止旧 worker 后删除旧 SQLite，再启动重建。原生历史与 workerId 保留原有位置。

### W-10：Agent 完成与资源清理

- Agent 完成全部要求、验收和证据后，最后使用原 claimId 与观察版本通过 task set-status done 提交已有完成操作。必要 PR、授权合并和人工验收未完成时保持任务未完成；worker 不重复解释或提交业务 done。
- 正常对账发现原 claim 不在成功完整清单时通知 agent 清理可归属的工作区外临时资源，最多等待本次尝试的 10 分钟，再停止进程、关闭 workspace、删除 worktree，最后本机 done。Done/release/强制撤回后的本地结束规则一致，分支与历史保留。
- 清理消息成功递交后，由后续巡查读取 agent 状态；观察到 idle 即视为该清理轮完成，可以停止 agent 并关闭 workspace，不要求序列计数递增或 interactiveReady。通知前的 idle 和递交回执本身不替代后续巡查；消息失败或结果未知时保留错误，按本次既定期限等待，不自动重发。该 idle 只表示终止清理轮完成，不提交业务 done；worker 进程退出遵循 W-09 的直接停止规则。
- 同进程内的清理 job 保留自己的期限，轮询不重置。重启后按剩余实际资源重新进入清理并重新计时，通知可重复；不为清理新建 agent。已确认归属结束的内存 job 可在后续服务轮询失败时继续；各任务独立有界。
- 失败保留错误与收尾责任，已不存在的资源可完成对应步骤。读取失败或无法确认停止时不能删除工作区或标 done，清理不影响其他任务与人工 Herdr。
- 已知目标的清理或退出按对应 Herdr 执行推进，删除仅验证该目标的 Git 工作区。其他仓库或同项目其他 worktree 的注册错误单独报告，不阻塞健康 agent 停止或正常退出。

### W-11：可观察性与交付验收

- stderr 和 JSONL 提供 workerId、实际平台、projectId/taskId/claimId、agent、已知 sessionId 及启动、恢复、等待、清理与错误事件。相同 claim 的等待/执行阶段、终端和已知原生会话不变时，轮询不重复记录；阶段切换及会话或终端变化及时报告，不同 claim 独立判断。成功启动建立观察基线，下一轮相同观察不重复提示重连。资源保留警告在连续成功观察中只提示一次，警告消失后再次出现则重新提示。真实启动、恢复、清理、人工操作和失败尝试保留日志；NULL 新建路径有 Warning。错误保留类型和 cause，凭据脱敏，不输出完整 prompt。
- 完整清单和私有实例就绪后显示 attach 提示；客户端只应用 attachment descriptor 的环境与移除项，原 task pane 保留自己的 native XDG/HISTFILE。
- 许可/平台 UI 的双语、键盘、焦点和响应式行为保持 W-02/W-03。真实 Herdr/native、受控故障、各平台和完整 Goal 验收分别记录来源，文档或模拟进程不替代真实运行证据。

## 可观察验收

| 范围 | 必须观察到的结果 |
|---|---|
| W-01、W-07 | 配置严格、省略值一致，项目选择明确；managed assignment 完整，正常与 managed 模式互斥；后台 prompt 明确不提问、自主决定及自行等待 review/CI；恢复使用保存的 agent 和当前适用配置；两个 provider 的 fresh/resume 均带固定 full access、目录信任参数或环境，冲突参数和缺失能力明确拒绝。 |
| W-02、W-03 | 默认许可、双向确认、平台清除、未知结果及候选组合过滤成立，不合格任务不遮挡合格候选。 |
| W-04、W-05 | 同 task 竞争单赢家；未知 claim 不启动资源或重放；多项目公平调度，等待与收尾占容量，同 task 旧资源形成启动屏障；撤回只允许原 owner/admin，原子重置归属/状态/计时并关闭许可。 |
| W-06 | Dirty worktree 复用，静态归属、注册、指针与删除核对成立；缺失原成果和外来路径保持可见错误。 |
| W-07、W-09 | 活进程重连不重发启动 prompt；idle/done 且就绪时 ping，working/blocked/unknown 保持观察，未改变观察和未知回执不触发重复输入；已知原生 ID resume；NULL Warning 后新建并保存 ID；空库先建项目映射再找回已有 claim。 |
| W-08 | 人工操作与 run 互斥；远端拒绝保留 worktree；成功后本机删除失败可由下次对账收尾；未知结果不重放；Web 强制撤回不声明远端已停，原 worker 下次对账收尾。 |
| W-09 | 精确两表与列数，三态/唯一 active；退出取消并等待所有 job 收尾，含正在等待通知、清理轮或停止确认的终止清理 job，随后直接停止并关闭 workspace，不发送清理 prompt、不等待清理轮、不删除 worktree、不把未完成行置 done；归属已结束的任务也保留 worktree、session ID 与未完成行，重启按完整清单重新进入终止清理；停止错误可见，停止不确定时私有 Herdr 保留。 |
| W-10 | 正常完整清单缺席统一清理，正常完成、release、强制撤回及人工管理的清理语义不变；清理消息成功递交后的巡查观察到 idle 即推进关闭，缺失或不变计数不阻塞；本次十分钟上限、失败保留责任及重启重新计时成立。 |
| W-11 | 关联日志、Warning、原错误链和脱敏成立；attach 只连接并保持既有执行；验证关联实际源码、平台和环境。 |

完整平台运行验收要求其实际门禁与端到端结果，组件检查和 schema 验证不能替代。
