# Worker 需求

本文定义 `daynight worker run` 的目标行为与可观察验收条件。自动执行许可和平台的服务端/CLI/Web 控制、候选筛选、唯一认领的服务端/typed client 基础、Agent 显式完成入口，以及本机身份/实例锁/SQLite 记录、Git 工作区管理和 Herdr 适配操作已实现；前台 worker run、attach 与 retry/release/resume 人工管理命令已组合这些模块；终止后新执行的服务端协议已接入，完整平台验收仍须独立核验。[整体架构](../design/daynight-worker.md)说明职责，[认领架构](../design/daynight-worker-claims.md)拥有已交付的归属协议。

## 目标与范围

Worker 作为前台常驻进程，通过 Daynight HTTP REST API 领取配置仓库中可由 Agent 执行的 ready task，使用专用 Herdr 服务运行 Copilot 或 Codex，持续完成任务交付。同一有效 claim 保留自己的 worktree，进程或机器重启后继续原工作；原 claim 结束后统一清理，新 claim 使用新工作区与原生会话。

服务端拥有任务资格、身份权限及唯一 claim；worker 拥有调度、执行资源、恢复和按自有 claim 清单对账清理；agent 完成任务要求的交付、验收并最后提交 claim-bound done；Herdr 拥有 agent 终端和会话。认证与三状态设置是独立前置，不由 worker 再实现一套。

## 必须满足的行为

### W-01：前台运行、配置与平台

- `daynight worker run` 与现有 `review run` 一样在前台运行，支持 Linux、macOS 和 Windows。
- `daynight worker setup` 要求 stdin/stderr 为交互终端，先汇总环境缺项及修复指引，再单选 Copilot/Codex 并多选一个或多个既有可访问 Project。重复配置预选当前项目；最终确认前展示所选 agent、Project、目录、移除范围及不兼容参数重置。所选 agent 应用于全部选中 Project；匹配注册保留原传输 URL 和路径，同类型 model/args 保留，切换类型清除不兼容值。
- setup 将 agent/model/args 与完整 Project 选择一次性原子保存，相关字段或服务/凭据变动时拒绝旧选择；无关配置、原 root 拼写、注释和安全 alias 保留。取消、空选、认证/API/保存失败均无部分保存。已有 claim、worktree、native history 和冻结配置按原协议保留。
- setup 只做有界只读环境探测，不启动 daemon、native agent 或 worker，不 clone、打开 SQLite、claim、安装或登录。缺原生依赖允许保存并明确要求修复；只读版本及 hook 检查不证明 provider 登录、未来 task 目录信任、真实 hook 执行、live 协议能力或完整任务验收。取消须等待已启动探测收尾，未确认的进程清理故障保留原错误链并使 setup 明确失败。
- 配置支持多个仓库的地址与本地路径；路径不存在时由系统克隆准备，已存在路径须核对仓库身份并保留已有工作。冲突或身份不明确时显示错误。
- worker mapping 使用 repositoryRoot、maxConcurrent、pollIntervalMs、recoveryLimit、agent、model、args 和 repositories；运行参数默认值分别为 1、5000、3、copilot、null、[]。配置文件、worker mapping 或可选字段省略时采用同样默认值；repositories 省略时为空数组，不隐式发现仓库或沿用 review 仓库。每个仓库的 remote/path 必填，可给 projectId 和 agent/model/args 覆盖。
- 只有配置文件确实不存在才按文件缺省处理；非 nullable 字段的显式 null、未知字段、错误类型、读取故障和取消均明确失败，model:null 保留清除模型设置的语义。配置读取不创建或重写配置文件。重复/重叠仓库与状态路径拒绝；相对路径以 config.yml 目录解析，不展开 tilde。
- `worker repo list [--json]` 读取本地注册；`worker repo add/remove [--project <UUID>]` 仅选择远端现存且有权访问的 Project。省略 project 参数时显示名称、完整 UUID、repoUrl 的多选，至少选择一项；显式 UUID 可非交互执行。新增保存 projectId、原 repoUrl 和绝对 path；匹配已有注册时保留原传输 URL、路径与覆盖，remote-only 注册只补 projectId。Remove 只移除选择，不删除 clone、claim、worktree、native history 或冻结配置。
- `worker.repositoryRoot` 默认 ~/daynights，独立于 review 的仓库根设置。原字符串通过严格路径校验，只在新增注册时用实际用户 home 和配置目录展开；根设置改变不移动已有注册。repo 命令写入只修改 worker.repositories，锁内重读并拒绝相关根、仓库或服务/凭据变动，保留无关字段、注释和合法 alias。共享 YAML alias 会改变本次操作不拥有的有效值时拒绝保存，保持原文件。
- 空仓库的交互式 `worker run` 在启动新任务前引导选择远端 Project。首次无持久状态时，保存选择先于身份、SQLite、Git 和 Herdr；已有状态时先建立原清理控制器，在项目读取或选择等待期间继续原截止。网络和交互不持配置锁；失败或取消不产生部分选择或新任务资源。非交互空配置给出 repo add --project 指引。选择结束后从同一份配置核对服务/认证上下文并载入 worker 设置，不得将原服务凭据与另一份来源的仓库或 agent 参数组合；新设置作用于本次后续启动。
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
- `in_progress` 期间拒绝实际切换，完成或合法人工解除 claim 后才允许改变。精确版本的同值更新不修改版本或时间；旧版本同值请求仍拒绝。等待人工输入保留许可，关闭许可不隐式停止或撤回执行。

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
- 同一 task 跨用户、机器和 worker 只有一个有效 agent claim。竞争失败方不得启动执行。自动初次认领生成新的 claimId；稳定 workerId、origin/project/repo/path 及该项目的具体 claimAttempt 先持久保存，记录原 task/claim/worktree 标识、版本和决定配置。实际 claim 确认后才登记 pending，不预建 task 行或新增表。未知请求不重放，也不以暂时缺席清除；成功完整的自己 claim 清单找到同一归属后登记并解除未决请求。所有新 claimId 均不复用；归属记录保留期间服务端拒绝其 ID 再次使用，强制撤回会清除这条服务端记录。
- 任务使用受保护的 properties 保存当前执行用户、稳定机器 ID 与名称、实际平台、worker/claim 标识、agent 类型、Herdr session/workspace/pane 及原生 agent session ID。尚未取得的会话信息与已取得信息区分，取得后补全。
- 初始认领/人工接续用户以服务端认证身份为准。完整 properties 必须包含 worker:null 或 active/released/completed 的归属记录；普通 create/PATCH 即使原样或以 null 提供 worker 也拒绝，PR 等其他属性更新保留 worker。
- 会话补全、执行更新、释放、撤回与完成均核验当前 claim 与精确任务版本，旧执行方不能覆盖新归属或完成新执行方的任务。普通状态修改不能释放 active claim，或开始/完成 released 的未完成成果；显式人工 resume 保留原 owner/admin、previousClaimId 与版本核对，人工执行不受自动许可/平台过滤。终止后的 resume 使用新执行身份，具体管理规则见 W-08。
- Worker 的任务查询、认领、归属更新、完成及管理操作直接调用 CLI 进程内 typed ApiClient，不启动 daynight 子进程；每次 HTTP 操作独立有界，未知结果读取核对而不自动重发。

### W-05：调度与全局并发

- 有空闲名额时，配置仓库之间轮流获得领取机会，同一仓库内遵守服务端合格 ready 候选顺序。
- 空仓库或没有本平台合格候选的仓库不占名额；持续繁忙的仓库不能让其他仓库长期得不到领取机会。
- Active 执行从准备资源到完整交付持续占一个名额，等待 CI/review、人工输入和恢复超限暂停期间均占用。严格未启动的 pending 等待启动条件，不因正常退出提升 active；降低上限不抢占已有执行。
- 同一仓库的不同 task 可由不同用户、机器或 worker 同时执行。

### W-06：稳定的 task worktree

- Worktree 由系统创建和销毁，每 task 一个，分支为 `daynight/<taskId>`，目录为 `.worktrees/daynight/<taskId>`。首次分支从仓库当前 HEAD 创建，保留分支从原 tip 使用，不 reset；同一仍有效 claim 的继续、重试和恢复始终使用原 worktreeId、分支与未提交成果。
- 普通退出、失败和崩溃保留仍归属执行的 worktree/native history/config；资源缺失或身份不一致时保留现场并报告，不能新建空目录掩盖恢复失败。
- 原 claim 终止后统一删除本次 worktree，保留分支、执行历史和交付引用。新 claim 使用新 worktreeId 和原生会话；规范路径仍被旧 claim 占用时等待或报告冲突。创建/删除均核对实际仓库、分支、claim/worktreeId 标记及目录物理身份，只操作本次执行资源。
- 创建成功但绑定结果未保存时，只接回匹配原标记和精确 `.git` 指针的资源；已知原成果缺失、无标记预留目录或路径替换均保留现场并报错。Device/inode 只作辅助核对，仍存在的目录缺精确原指针时必须拒绝破坏性操作。分支通过 Git 的 refs backend 核对，支持 reftable，不假设 HEAD 为 loose 文件。
- 终止删除需原 agent 停止和 workspace 关闭；保留原标记及 `.git` 指针删除其余内容，失败可重新核对后续清理，最后删除指针并非递归移除空目录。若中断留下仍存在但缺指针的目录，即使为空且 inode 匹配也保留 active/错误，等待人工检查；目录经核实移除后再完成注册清理。删除成功结果未保存可据实际目录/注册缺席核对，不能误删同路径无原指针的新目录。

### W-07：专用 Herdr 与 agent 执行

- 每个 worker 自动启动和管理一个专用 Herdr 实例，每 task 使用其中独立的 workspace/pane/agent，通过 Herdr API 启动、输入和观察 Copilot / Codex；不干扰人工或其他 worker 的实例。私有 `[session] resume_agents_on_restore=false`，worker 是原生 agent 唯一启动/恢复者。
- Herdr 与原生 agent 的会话关联可持久化，重启时核对并继续原执行，不要求人工重复输入已取得的标识。Daemon 的 XDG 与 endpoint 私有；native/workspace 保留调用方原 XDG 的 set/unset 语义及认证目录，仅传所需两字段环境覆盖。遵守 HISTFILE 的 Bash/Zsh 历史写私有文件，自定义 rc 和其他 shell 不在通用隔离保证内。
- 协调循环组装首次启动及同 claim 确需重新启动的完整 prompt，先确认所需技能可用，显式指定 `worker-managed` 环境、`using-daynight` 技能和 `execute-task-in-managed` 模式，传入原 projectId/taskId/claimId/worktreeId、实际工作区路径/branch、原会话关联及冻结配置。Herdr 适配层按原内容递交不透明文本，返回受理、拒绝或未知结果，不选择任务/模式或组装业务指令；仅重连存活 agent 不重发启动输入，未知结果先观察原资源。
- 单一 `using-daynight` 技能按显式模式选择指令：普通指定任务读取 run-task，managed 执行读取 references/execute-task-in-managed.md，SKILL.md 只保留简短路由。普通执行不加载 managed 详细指令；不能从 properties.worker、cwd 或环境变量推断模式。显式 managed 上下文缺失或不匹配时等待，不回落普通执行。两种入口共享任务输入、范围、交付、验收和证据规则，各自拥有普通或原 claim 的生命周期动作。
- 启动和恢复前以 task cwd 校验官方 Herdr/native agent 集成及所需原生历史，feature/config 检查保留冻结的相关配置、feature 与 profile 参数及顺序。当前 Codex 0.164.0 的只读 features 命令无法检查 profile 时明确拒绝并保留原因，不能丢弃参数后查默认值。不满足时显示修正方法并暂停；不自动全局安装/修改集成，也不另建配置解析、MCP 或 SDK 引擎。
- 新 workspace 只有核验的创建 ACK 能取得绑定当前 terminal、owner 和确切 XDG 的环境 receipt；adoption/丢失 ACK 为 null。冷恢复不保留 workspace.env，旧 terminal 的 receipt 不能授权新 native 启动，即使 pane 为空且从未取得 native ID；缺失或不匹配时先返回 rebind-required，不预检、启动或输入。已存活 agent 重连不修改环境。
- 首条输入不能依赖尚需首个 turn 才产生的官方 native ID。新启动核对原目标、冻结 argv/config 及当前业务 composer 可输入 surface 后只提交一次原 prompt；resume 还核对持久原 ID、必要 history 和确切 resume argv，输入后须取得并核对官方 ID。Codex 的 idle/interactiveReady 不足以独立证明正文可输入；当前 same binding 识别到的 Folder access、信任或授权/选择 blocking 不允许自动输入或 Enter，明确保持 not-submitted 和原 launchEvidence。未识别界面在原 Operation 内有界观察，不把超时或空 composer 外观当成已提交/未消费的证明。
- 已确认原 native 启动、首 prompt 明确未提交且原 worktree/binding/receipt、冻结 argv 与原 native 进程证据匹配的执行，在普通 missing-ID 恢复/rebind 之前保留原会话接续路径。操作者通过原 attach 明确处理原生信任/授权，使业务 composer 可输入后可用 worker retry 授权一次接续；只读核对同 shell 和所有原 native 关键 PID 后，发送前消费一次许可、累计 count 加一而不清零。普通 children 变化不要求覆盖原证明；不重新 agent.start、不更换 conversation 或冻结配置，控制/终止意图仍优先。旧 submitted/unknown 或来源不明的缺 ID 状态仍禁止重放。
- 对 native 从未提交的准备窗口，协调循环必须在任何可能启动前为具体 claim/workspace 持久记录 never 事实，并在调用启动前持久转为已尝试/未知。结合唯一启动者和实际 owned 普通空 shell、无 pending/native/前台工作，可确认没有原 agent 后关闭/rebind；null 引用或本次 not-submitted 不产生该事实。先前未知 launch 必须取得原停止证明或暂停。
- 未活动的恢复 pane 若保留旧 native reference，应先确认旧停止/关闭再换新 pane，保留 worktree/native ID/config；不能把旧引用冒充新报告。冷恢复若改变 terminal/shell，原停止观察保持不可变，须分别核对实际 restored 资源、原 native PIDs/旧 shell 已不执行及当前没有原生/前台工作；新空 shell 本身不构成原 agent 停止证明。
- 开发 task 的 agent 负责实现、验证、提交、工作分支推送、PR、CI/review 反馈、授权合并和合并后验收，并遵守仓库权限、门禁与授权要求。其他允许 Agent 自动执行的 task 遵守其阶段和验收条件。
- Worker 使用 Herdr 最新状态观察运行、等待和结束，不需要公开 report 命令、结构化报告协议或结果文件。Herdr idle/done 或 agent 一轮结束不等于 task 完成。

### W-08：人工介入与强制撤回

- 需要人工输入或授权时保留自动执行许可、平台、claim、worktree、原会话和并发名额，前台显示等待原因及 `daynight worker attach` 入口；人工在另一交互式终端连接原会话处理后继续。Attach 只连接已有私有 Herdr 会话，不启动 worker、daemon 或 agent；会话不可用时明确提示先运行 `daynight worker run`。该入口不要求 Daynight 登录，不查询服务端、SQLite 或取得 worker 锁。正常 detach 只断开客户端，原执行继续；启动失败和客户端非零退出保持可见。
- 原执行用户或项目管理员可显式 release 或强制撤回，并受当前项目成员权限约束。Web 详情显示 active claim 的用户、机器、agent 和阶段，released 明确标识；completed 不表示当前认领。原用户已退出项目时保留真实 userId，成员资料失败显示错误，不隐藏实际 claim。
- `daynight worker retry/release/resume` 提供显式人工入口。Release 在破坏性清理前核验当前项目访问及原 owner/admin 权限；原执行账号与当前管理员分别处理，不以当前登录身份推断管理权限。
- Release 先在 source 行持久保存具体意图，抑制普通恢复，由前台唯一 coordinator 串行完成原 agent 临时资源清理、真实停止、workspace 关闭和 worktree 删除后，才绑定用户决定的精确版本提交远端。没有前台时先取得相同实例锁并执行同一处理函数。单任务管理不停止共享 Herdr 或其他 task。失败保留原责任；未知远端结果先核对，不重放、不重建旧业务资源。Release 返回 todo 并清空执行时间，保留 released 历史。
- Web “强制撤回”针对 active/released 归属，提交当前 claimId 与精确 version，无需 stoppedConfirmed；同一事务清除 worker、返回 todo、清空任务起止时间并将 allowAgents 设为 false，其他任务资料保持。completed/null 不提供该操作。确认须明确说明这些结果及远端 agent 无法保证立即停止；取消不写入，冲突重新审阅，未知结果只读核对。旧 worker 下一次成功完整自有清单发现 claim 缺席后进入既有终止清理，撤回操作自身不远程停止进程或撤销外部凭据。
- Released task 的显式 resume 使用新 claimId/worktreeId、该次冻结配置和新原生会话，不依赖源 worktree/native history 连续。普通 daemon 不立即重领 released task，由显式 resume 再启动。
- 服务端与 typed client 严格拒绝已废弃的 `continuityConfirmed` 输入。新执行要求新的 claimId/worktreeId，允许明确更换 agent；旧归属保存的资源字段仅是历史，不要求已删除 source worktree 或原生会话存在。权限、精确版本、release 的 stoppedConfirmed、resume 的依赖检查与旧 claim fencing 保持。
- 用户显式 `--if-version` 不替换。只有 release 提交被明确拒绝后，才可重新读取 task 并作新的明确管理决定，所给精确版本须匹配本次观察；拒绝未改变 task 时，版本数值可以与原决定相同。未知提交即使读到旧值也不解除 fence。核对管理写入可按 taskId 读取实际 task/claim，这不改变自动缺席清理的完整自有清单规则。
- Retry 只授权同一有效 claim 的一次额外恢复尝试，不清零累计预算、不更换原资源或冻结配置；并发和重复请求不累积授权或双启动。终止后的执行使用 resume，不能借 retry 重建源工作区。

### W-09：SQLite、退出与恢复

- 固定状态根仅有一份 SQLite，业务表仅为 projects 与 tasks。Projects 保存 origin/project/repo/path 与单个未决 claimAttempt；tasks 每行对应一个实际 claim，保存 pending/active/done、冻结配置、实际资源绑定、nativeExecution 启动/输入/停止事实、恢复次数/暂停/授权、原清理截止与输入/结果、source 管理意图及远端提交结果。schema 4 显式迁移旧记录。旧 stopObservation 的 nativeProcessIds 填 null，不推测原 native 角色；原 scope、配置、停止证明与预算保持。Cleanup 的 claimEnded 记录已确认归属结束；旧无 control 的 terminal 或已 confirmed control 迁移为 true，其余为 false。已删除 transfer 的旧 control 被清除，未结束源执行保留既有 terminal cleanup，缺少时以原 requestedAt 和最多十分钟原截止建立终止清理，暂停普通恢复并清除 retry 授权；未知远端结果不重放，原 claim 仍有效时等待 Web 强制撤回，已结束时按完整清单继续收尾。结束行保留，不另建任务台账或通用动作引擎。
- 每条实际 claim 保留原认证 userId，claimAttempt 同时保存该 userId；已知账号值不可替换。项目映射在远端 claim 前保存；取得实际 claim 后先 pending，确认启动条件并提交 active 后才创建资源。同一 origin/project/task 至多一条 active，未收尾执行期间项目绑定不变；服务范围与当次仓库路径随任务保留，不能因换服或改映射而误认资源。
- 启动和持续对账通过既有 task list 的 workerId 筛选，成功汇总当前认证用户/worker 全部项目与分页的有效 active claim；不附加候选资格条件，不把失败或部分清单当成空集合。原 claimId 不在完整清单就触发相同本地清理，不按 task 状态或单 task GET 分类原因。同 task 新 claim 不保护旧 claim，完成本轮对账后才登记新领取。
- Worker 复用既有 GET /api/v1/me 核验启动凭据的 UID，项目和清单请求前固定该 principal，并对后续成功响应（包括空页）核对 Daynight-User-ID。新缺席清理和恢复必须属于原 userId；同 OS 换成另一个账号的空清单不能结束旧账号工作，须保留/暂停。旧范围未知的 terminal/control 意图不可由当前登录补授权；ordinary/shutdown 只可由完整身份匹配的实际自有 claim 学得未知 UID。
- 原生启动、初始 prompt 和远端摘要更新在外部调用前持久记录可能提交的责任。确定未派发的同一次尝试可以恢复其未提交事实以便后续明确决定；实际未知结果只观察，不自动重放，也不覆盖成 never。
- 服务清单、新缺席判断、普通恢复和认领只使用当前 origin；已提交 cleanup/source control 与正常退出则覆盖同 workerId 各原 origin 的本地责任。切换 serverUrl 不抛弃旧截止，不请求旧服务或向新服务查询旧记录，不增加多服务凭据/认领注册。
- 同一仍归属执行的恢复核对 SQLite、Git 和 Herdr 的原资源与冻结配置；新发现 claim 先登记 pending。有 cleanup 的 pending 找回实际原 worktree 时，原子保存经归属核验的 binding 并提升 active，随后核对原 Herdr/native 资源完成清理；冲突时两者一起回滚，原清理责任、截止、进度及 claimEnded 不变，不重新启动 agent。无资源 pending cleanup 不预占 active。显式写入的版本和未知结果仍可按 taskId 读取核对，不确定的外部动作不能按“未发生”重做。
- 已持久保存的 cleanup/source control 意图由前台轻量发现循环交给每完整 claim 至多一个瞬时异步 job。各 job 按自己的原截止独立推进，定时等待最多 1000ms，并受最近原截止缩短；一个 task 的 RPC 等待不能阻塞其他 task 的下一次推进。同 task 仍串行，且与 /me、服务轮询和启动仓库请求分离；只有原账号范围已知的已提交意图可继续，未知范围保留。它只续原责任，不因读取失败新增缺席或终止决定；新的自动终止和认领仍要求成功完整的自有 claim 清单，不增加持久队列或 OS daemon。
- 跨 origin 的规范路径冲突仅以只读 Git 原所有权核对前驱；当前服务实际新 claim 冻结新配置，在同 worker 任一 origin 的同 task UUID active 前驱结束前保持 pending，不采纳旧 native 会话。完整 origin/project/task/claim scope 仍分开。
- Worker 崩溃或机器失联不自动释放 claim，由原 worker 恢复或操作者选择 release/强制撤回。Worker 死亡不证明 agent 或工具已停止；普通恢复或 release 无法确认停止时暂停，强制撤回允许先清除远端归属，须明确告知其不保证进程立即停止。
- Ctrl+C 停止新领取和普通输入，先取消并等待常规收尾发现循环及全部 per-claim job，再以独立且受原截止约束的清理范围记录 shutdown 并给原 agent 清理外部资源的机会，确认 agent 停止和 workspace 关闭后关闭专用实例，保留 claim/worktree/native/config。正常重启不消耗故障恢复预算，不清除原暂停或重试授权；旧 shutdown 的停止确认不能应用于新启动的 agent。
- 消费中断的 shutdown 后，普通执行前必须刷新 Herdr 实际资源。若 native 可能已启动但未报告确切原 ID，完成停止/关闭也不允许清空原绑定及启动/PID 证据后开启首次会话；保留并暂停，等待恢复原身份。已证明未启动或已知原 ID 的正常路径继续保留原成果和预算。
- 严格证明资源与 native 均从未启动的 pending 后继在正常退出时保持 pending，不提升 active 或制造清理意图。它的原 userId 与成功完整清单 principal 匹配且原 claim 缺席时，可直接 pending→done，不扫描/删除旧固定路径。其余任务的退出初始化故障分别隔离；无法确认的资源或账号范围使私有实例保留。
- 沿当前 worker 取消原因或其 cause 链确认的正常中断向退出传播，不制造新故障暂停；已有真实暂停、预算和未知动作记录不被覆盖。仅 signal 已取消不足以把任意错误解释为正常取消。
- 异常退出或基础设施故障在原 worktree/会话上按配置上限恢复；计数、原因及暂停状态持久化，重启不清零。超限保留资源与名额，等待人工处理或明确恢复操作。已存在 cleanup/control 意图时只推进其收尾，不进行普通恢复。

### W-10：Agent 完成与资源清理

- Managed 指令核对启动 prompt 中显式提供的 assignment，复用原已认领执行；普通开始/重开/done 与 managed 原 claim 执行/完成分别归各自入口。共享任务输入、范围、交付、验收和证据规则保持统一所有者。Agent 完成全部任务交付、验收与证据后，最后使用 CLI set-status done 的显式 --claim-id 与观察版本提交既有 PUT status。开发任务仍满足必要 PR、检查/审查、授权合并和验收；等待人工、必要 PR 未合并或验收未满足时保持未完成。Worker 不独立解释业务验收或再次提交 done，只按成功完整自有 claim 清单对账。
- Agent 负责执行并记录任务验收；其验收文字是执行方声明，不是任意自然语言条件的独立证明。证据缺失、相互冲突或任务明确要求人工验收时保持 task 未完成，在原会话请求处理；不要求通用 Markdown 验收解析器或形式化证明。
- 原 claim 从自己成功完整清单退出后，统一持久保存最多十分钟的固定截止，通知原 agent 清理 worktree 外明确归属的临时文件/进程；清理结束或原截止到达后，确认 agent 停止、关闭任务 workspace/pane、删除 worktree，最后置本机 done。Done/release/强制撤回后的终止清理不保留源 worktree。历史、分支、task 交付引用及 claim/session 标识保留。
- 清理请求和 /exit 也经过相同自动输入边界，不能以 Enter 默认接受原生信任/授权。Blocking 或无法证明可输入时保留真实未提交/不可用结果，按原截止及原进程证明安全停止资源，不为清理新建 agent 或自动配置 trust。
- 清理重启沿用原截止和提交结果，不重发未知输入，不创建新清理 agent；pollIntervalMs 只控制服务对账/认领轮询，不延后原清理截止。清理期间继续占并发名额。本机 done 要求持久确认原 claim 已结束；完整原账号清单缺席或已确认 release 可以提供该事实，确认后离线继续清理不丢失它。完成后修改自动执行许可或平台不能改写历史归属和实际平台。
- 删除失败记录具体错误和待清理状态，重启后只继续清理，不能重新执行已完成任务。清理不能影响其他任务或人工 Herdr。

### W-11：可观察性与交付验收

- 前台与 JSONL 能够区分 project/task/claim、worker、agent、实际平台、执行/等待/恢复/暂停/清理状态和具体错误。启动时输出 `daynight worker attach` 提示；该命令按私有 Herdr attachment descriptor 仅为客户端应用 environment/unsetEnvironment，已有 task pane 保留自己的原 native XDG 和私有 HISTFILE。日志不携带凭据或完整 prompt。
- 自动执行许可和平台的 Web 交互遵循对应最终样式原型，保留双语、键盘、焦点和响应式规则，覆盖保存中、禁用、失败、版本冲突和不确定结果核对。
- 三平台运行、真实 Herdr/agent 行为、受控故障注入和生产端到端结果分别保留来源与验证边界；文档、模拟进程或正常退出不能替代真实会话恢复证明。

## 可观察验收

| 范围 | 必须观察到的结果 |
|---|---|
| W-01、W-07 | Linux/macOS/Windows 的安装入口可启动前台 worker；分别运行 Copilot/Codex；实际首次/重新启动 prompt 明确环境、技能、managed 模式和原 assignment，普通执行不加载 managed 详细规则；仓库缺失自动准备；原有仓库错误与配置错误可见；领取后的配置修改不影响原执行。 |
| W-02、W-03 | 验证旧任务迁移、新任务默认值、开关双向确认及取消/失败/未知结果、平台清除；覆盖自动执行许可、ready 与全部要求平台/worker 平台组合；不合格任务不会遮住后续合格候选或启动资源。 |
| W-04 | 多用户/机器/worker 竞争只出现一个有效 claim；覆盖查询后资格变化、旧版本、未知结果及旧 claim 更新；任务属性保留 PR 和实际会话关联。撤回只允许原 owner/admin，同事务关闭许可并重置状态/归属/计时，旧 claim 不能继续更新或完成。 |
| W-05 | 多仓库持续有任务时轮流获得机会；空与不兼容仓库被跳过；CI/review、人工等待及超限暂停均计入全局上限。 |
| W-06、W-08 | 继续和恢复使用原 worktree；人工进入原会话后继续；显式结束统一删除旧 worktree，新 claim 创建新工作区；越权、平台不合格或有效 claim 的资源缺失保持拒绝或暂停。 |
| W-09 | Ctrl+C、强制结束 worker、Herdr 重启及机器重启后不产生第二个执行 agent；在外部动作结果落库前后注入中断，正确核对实际结果；恢复预算和暂停跨重启保持。 |
| W-10 | 已核验的开发任务合并并完成合并后验收，原 claim 退出自己清单后删除 worktree 且历史仍在；agent 交付证据不足时不完成；清理失败跨重启只重试清理。 |
| W-11 | 前台、归属展示、强制撤回和自动执行许可/平台 UI 展示与真实状态一致；`worker attach` 在交互式终端连接原私有会话，detach 保留原执行，会话缺席不启动新服务且错误可见；错误、未知结果和人工处理入口可观察；各验收结果能关联到实际源代码、平台与运行环境。 |

完整运行时验收要求实际门禁及端到端验收通过，文档不能替代运行时证据。
