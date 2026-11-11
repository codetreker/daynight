# Daynight 手册与仓库开发流程设计

[需求](../spec/daynight-agent-skill.md)拥有公开行为，
[入口隔离决策](../../.agents/notes/archived/architecture/2026-10-26-managed-task-skill.md)记录普通与 managed 执行分工的历史取舍；[原模式决策](../../.agents/notes/archived/architecture/2026-10-21-using-daynight-modes.md)
保留单一入口的原始理由；[内容与移交决策](../../.agents/notes/archived/process/2026-10-25-task-content-handoff.md)
拥有内容单一所有权和审查后启用许可的取舍；[原分发决策](../../.agents/notes/archived/architecture/2026-10-21-public-agent-skill-design.md)
保留安装机制的原始理由。[Project/Task CLI](daynight-project-task.md)与
[附件设计](daynight-task-attachments.md)继续拥有服务访问、版本、依赖和文件操作。

[Goal 流程设计](daynight-goal-workflow.md)拥有需求讨论、方案讨论、确认后实际拆分、
实施和整体验收的阶段协议。普通任务与
Goal 阶段使用同一自足正文与资料所有权规则，需求讨论负责交付 Goal 所有的完整 `spec.md` 必需附件。
共享输入按生产 task ID、资料拥有者 Goal ID 与明确的
description 全文/适用章节、真实附件完整路径或已核验不可变仓库引用读取；阶段结果不能
成为开始其生产阶段的前提。

## 一个入口与按需加载

公开 `using-daynight` 由短 `SKILL.md` 与九份独立主题引用组成。入口按操作目的直接导航
相关文件，并明确写操作需同时读取通用写安全规则和对应资源的前提与例外；它不选择任务
工作流。主题分别拥有连接与项目、任务、Steps、资料、写入安全、Session 读取、Session
消息、Webhook 与 Worker 操作，通用解释保持单一归属。

`commands/skill/manual.ts` 的 `manualTopicFiles` 固定主题清单和顺序；
`manual-assembly.ts` 的 `assembleManual` 从这些唯一内容源生成
`dist/commands/skill/usage.md`。每份主题以单一一级标题开始，章节使用普通 Markdown
标题；内容、围栏代码和内联链接按当前主题格式处理。汇总将标题下降一级，为主题和章节
生成带主题前缀的显式锚点，并将相对文件及章节链接改为汇总内链接。缺少主题、非法
UTF-8、空白内容、标题冲突、未关闭代码围栏或无效内部引用使构建失败；资源复制前先完成
校验。该机制只承担固定主题的组合，不解析任意文档格式。

安装 bundle 保留每份主题的原字节；离线汇总是构建产物，不维护第二套手写正文。
`--skill` reader 只读取该产物，保留完整离线输出与原有错误边界，不依赖配置、Git、登录
或安装后的引用文件。[主题手册决策](../../.agents/notes/implemented/architecture/2026-11-11-daynight-topic-manual.md)
记录独立读取与构建转换的取舍。

本仓库的 [development-workflow](../../.agents/skills/development-workflow/SKILL.md) 按需导航
任务内容、创建、Goal、依赖、handoff、执行、交付与终验收。Worker 的编译运行约束独立于
公共手册和仓库流程，包含 assignment 身份、暂停恢复和原 claim 完成；目标仓库规则和实际
授权决定交付策略。三者的取舍由[职责分离决策](../../.agents/notes/implemented/architecture/2026-11-10-daynight-manual-workflow-separation.md)记录。

## 文档职责与任务资料

产品手册说明对象、操作及失败；仓库流程的 [task-content](../../.agents/skills/development-workflow/references/task-content.md)
拥有任务定义、成果与 Session 的边界和资料充分性。需求、设计、输入、实施步骤与验收保存在
所属任务；讨论方法、执行安排与操作授权留在 Session。Goal 持有共享需求、设计和整体验收；阶段 task 保留生产责任与 Goal ID、完整路径。普通任务创建默认 `proposed`；Goal 内需求讨论、已确认的方案后继和交付子任务新建时显式使用 `--status todo`，登记不启动执行。

## 终验收与开发交付

规范源的 [Final acceptance](../../.agents/skills/development-workflow/references/final-acceptance.md)
统一拥有终验收规则。create-task 在登记时明确整体验收对象、需求来源和结论与证据
交付；goal 在拆分与整体完成时引用同一规则；task-execution 在选择验证方法前区分
终验收与开发交付，并判断无需代码或 PR 的完成准备。普通和 managed 入口分别执行
自身最终状态写入，共用验收准备条件，不维护第二套验收协议。

终验收对整个已确认任务或 Goal 及其已确认变更给出需求对照结论，成果包含缺陷、
未验证项、必要对象版本、支持结论所需的关键观察及重要限制。Goal 的整体验收结论保存在 Goal，验收 task 保留责任和来源；其他成果保存在所属任务。
不要求增加机器回执 schema 或证据平台，managed 验收仍须上传证据附件。Goal 中的验收任务同样提供具体检查方法作为自身实施方案，说明如何核对需求与实际组合成果；执行命令历史、临时工具安排和排障过程留在 session。用户明确要求交付的验证方案按其成果职责保存。人工、已有检查和临时辅助脚本按实际
需要组合，临时脚本遵守项目临时目录和资源清理规则。

临时辅助脚本不进入仓库交付或形成 PR 门槛，因此辅助工具的维护和评审不能改变
终验收目的。正常实现、授权修复及明确要求的长期自动化仍保留其开发交付和测试。
发现缺陷时记录未满足项，按已有权限修复和复验；未满足或未验证的整体结果保留在
验收结论中，具体行为遵守[终验收要求](../spec/daynight-agent-skill.md#终验收任务)。

## 移交审查与许可

`handoff.md` 只接受明确指定的移交对象。proposed 不属于自动执行候选，审查不改变其状态或许可；改为 todo 需要使用方明确决定，不能由开启 allowAgents 隐含确认。先读完整 task 和 worker 信息，再按共享内容标准读取真正必要的资料、来源任务和上下游契约，检查当前阶段的内容充分性。每个交付任务必须已定义问题、选定方案、详细设计、实施步骤和验收；缺任一要素或仍需调研以确定方案时不通过。Goal 交付任务另按 Goal 协议复查四项内容、拆分边界及与 Goal 和方案的一致性。它能依据已有确认信息整理尚未启用的 todo，并在许可更新前补齐、读回和重审；需要的实质决定按已有确认要求解决。没有来源的要求或决定、责任重叠和交付衔接缺口作为具体问题返回，不能隐含地交给执行者决定。Goal 移交按 Parent 枚举直接普通孩子，跨 Goal 依赖不扩大移交范围，Goal 负责人不赋予代改他人任务的权限；逐项审核负责人、许可、proposed、平台和依赖。任务群逐项审核；这不重新证明整个 Goal 覆盖，不发现额外工作，也不授权重分任务或修改依赖。

资料更新和内容核验先于许可更新。最终审查所依据的 task version 传给现有
`task update --allow-agents true`；可在同一更新提交最终 description，不携带无关字段。
负责人检查只读取显式目标的 `task show <task-id> --project <project-id> --json`，不枚举项目或账号任务集合。done/cancelled在归属检查前直接报告实际终态、无需移交；取消不可恢复且不证明交付。其他状态将目标 assignedTo 与 setup 或当前 session 已独立确认的当前认证账号本地 user UUID 比较；未知身份、空值、不符或目标不可读时报告阻塞，不查询其他任务或改派。名称、邮箱、目标负责人和历史 worker 不是本人 UUID 的独立依据。目标版本变化须重读并重新判断，最终许可更新仍受精确版本保护。已启用任务检查失败保持只读并报告实际许可，既有 claim 恢复不重新执行本人候选资格检查。

blocked todo 在已确定的方案、详细设计、接口和集成步骤足以定义当前任务时可以预先移交，真实依赖继续阻止执行；前置仍要决定当前任务如何实现时不能通过内容审查。已有 true 的
任务只读复审，失败保留许可并报告调度风险；不会把复审假定为暂停。撤销或停止按
另外明确的授权及现有控制流程执行。in_progress的false不启用，done/cancelled按模式策略无需移交。Active worker 保留所有权和原资源；released 保留历史，由有权管理者显式 resume 开始新的 claim/worktree/native session，启用许可不代替该操作。

附件和跨任务文档不受目标 task version 保护。开启前核验所依赖的可变内容，执行时
再次读取；资料变化后重新审查受影响部分。此边界只提供尽力核对，不引入审查令牌、
服务端认证、不可变快照或原子引用冻结。flag 为 true 不构成永久内容认证。

冲突使原决定失效，需重读和重新判断。未知写入通过读取协调，不自动重放；读取失败
保留未确认状态和真实错误。调度器可在许可更新后立即认领，最终读取的更高版本或
in_progress 是合法观察。结果报告实际 assignedTo、本人负责人检查结论、flag、状态、worker、依赖阻塞与内容审查结论，
不强制读回版本等于更新响应，也不把并发者设置相同 flag 归因于自身写入。handoff
不启动当前会话执行，完整状态处置由[需求 AS11](../spec/daynight-agent-skill.md#as11-handoff-的移交审查)拥有。

## 指定执行与共同交付准备

`task-execution.md` 是中性的执行资料。它读取 task 正文、必需引用、已产生成果和真实共享
输入，按阶段核对前置与资料；适用原型已是输入时查看并操作。开始分析、提问或提案前
明确当前任务已确认的范围和验收，subagents 遵守同一边界。上层 Goal、共享架构及
兄弟任务只提供本任务必需输入、接口和约束；跨任务问题作为阻塞或后续建议，不扩大
当前交付。Goal 级讨论或整体验收按当前任务已确认范围覆盖整个 Goal。

共同资料拥有实现、验证、PR 属性、成果和完成准备，不发起普通开始/重开/done，也不
选择候选或后继。澄清与设计使用阶段 brief，当前阶段待产出的要求、UI 或架构不成为
其启动前提。缺关键输入、不可读引用或前置未完成时保持具体问题，不凭标题补造方案。

普通 run-task 以一个明确 ID 建立身份并读取共同资料。指定的 proposed 或 todo 在授权、全部前置与阶段
输入齐备后，以观察版本 set-status in_progress 并核验后开始。已有 in_progress 根据
实际工作与检查点恢复，清单不提供所有权。done仅在明确重开范围内按依赖保护重开；cancelled报告终态并返回，不能恢复。
指定任务不要求 allowAgents=true 或自动平台匹配；已有固定队列授权可作为当前指定
任务的范围来源，skill 不以此恢复连续调度或自动选择。

Worker 启动和恢复使用编译进 CLI 的运行约束与原 assignment；核验、暂停恢复和原 claim
完成由 [Worker 设计](daynight-worker.md)拥有。仓库 [delivery](../../.agents/skills/development-workflow/references/delivery.md)
只对托管任务附加按类型的成果要求，并拥有 PR 评审、有限重试和授权合并规则。
实际 assignment 和用户指令决定授权，不由任务状态或完成要求推断。

共同完成准备由 [Shared execution](../../.agents/skills/development-workflow/references/task-execution.md#completion-conditions)
拥有；Goal 讨论的必要后继登记由 [Goal protocol](../../.agents/skills/development-workflow/references/goal.md#register-the-next-discussion-before-completion)
拥有，在用户确认当前成果后先登记并读回必要后继，再完成当前阶段。终端任务无需
制造后继；登记不启动后继或增加权限。Managed 在已有创建授权覆盖的已确认范围内
完成阶段要求的登记，仍只完成原 assignment 与 claim 后返回 controller。缺少创建授权
或必需内容时保持未完成，沿既有介入流程补齐。
Goal 讨论还要求用户确认和自身阶段验收。独立代码、文档、原型交付以及
用户明确纳入讨论验收的 PR，仍须所有必要 PR 平台确认合并并满足验收。没有合并权限、
PR 未合并或人工/验收门槛未满足时保持未完成；CI、review 和合并等待留在当前任务。
PR URL/title 由 properties.pullRequests 拥有，任务材料保存真实成果及必要版本；
操作确认、CI/review/merge 经过留在 session。用户请求保留 PR 时
交付可审查结果并等待，完成规则不授予合并或 auto-merge 权限。

准备齐备后，普通入口重读任务，以观察版本执行普通 done 并核验服务结果；其未知写入
按版本和状态只读核对。Managed 入口重读完整任务并核对原 active claim，最后携显式
原 claimId 和观察版本 done，确认 task done、worker completed 与原 claimId；拒绝或
未知结果不重放，不改走普通 done，读取失败保持未确认。两条入口分别拥有最终写入，
共同资料不向普通任务添加 claim 要求。

普通完成或需要外部介入后返回；只有普通 Goal 中用户明确确认完整当前 spec 并要求指定方案
讨论时，才按阶段协议进行指定转场。Managed 完成或需要外部介入时交还 controller，
不选择、开始或执行后继。系统调度持续处理 ready task 的能力归 worker，公开 skill 没有
候选选择循环。

## 查询与状态背景

ready 默认最多 10 项，必要时使用 1..100 的 --limit。服务按创建时间和 ID 升序排序，
顺序不表达相关性；空页不证明 backlog 已完成。管理查询按实际范围读取清单、图与详情，
区分范围完成、依赖阻塞、其他工作进行中及候选不足，不据此启动任务。Graph 读取目标的完整双向普通依赖连通分量及其中任务的一层外部前置，包含全部状态，不递归展开外部任务；完整依赖引用可能指向图外。
读取按实际保存的图完整返回，不复查存储节点或边容量；传输、取消和自然解码失败不等于项目未关联。详情使用 show，但不能替代完整关系核验。task list 穷尽匹配分页，
默认排除done/cancelled，核对完整历史时显式包含已结束任务。状态/readiness 分组保留组内服务
顺序，不表示相关性；文本为摘要，JSON 列表仅省略 description，详情和写入保留完整资源。

在仓库内可省略 --project，由 CLI 按 Git origin URL 匹配；显式项目优先。project-management
解释项目定位，不展开本地绑定内部实现。无匹配不自动创建项目。服务 origin 缺省为
https://daynight.cc，缺凭据或服务 401 提示 daynight login，不自动登录；受控自动化配置
提供 origin 与匹配 PAT。网络、配置和歧义错误保留真实原因。

所有基于已读内容的修改绑定精确 --if-version，保持完整 int64 十进制。默认临提交读取
不保护较早决定；description、依赖与 PR 列表完整替换，冲突后重读并重新判断，不仅
更换版本。附件独立核验，不受 task version 原子保护。update 不改状态；set-status
是版本化状态设置，不提供独占锁、租约或新执行权。proposed、todo、in_progress、done、cancelled的同状态
请求 +0，实际改变 +1；未知结果先读实际事实，不自动提交重试。公开 --claim-id API
继续由既有 CLI 与服务契约保护，普通调用背景不加载 managed 执行规则。

allowAgents 和 requiredPlatform 仍由服务端、CLI、Web 与 worker 消费。自动候选在
分页前同时满足许可、ready 和真实平台，领取事务重验资格；worker 自身识别真实平台，
WSL Linux 仍为 Linux。普通指定任务保留人工路径，但不借此把自动选出的任务伪装为
人工指定。创建、拆分和执行不自行开启许可，只有明确授权的 handoff 审查后启用。
公开 skill 的查询背景不提供自动选择或 worker 调度实现。

## 安装命令与既有机制

`daynight-review` 仍是 review runtime 的内部审查资源，其 plugin wrapper、快照、哈希
和发现校验独立。公开 skill 由 `skill` 命令持有，只共享普通 bundle 捕获和校验。
根 `--skill` 与公开 bundle 使用同一手册源，reader 由[客户端架构](daynight.md#源码组织)拥有；Worker prompt 不读取 bundle。

| 机制 | 所在位置与职责 |
|---|---|
| 轻量命令登记 | [命令表](../../packages/daynight/src/cli/commands.ts)延迟加载运行时，帮助只访问元数据 |
| 交互输入 | [CliPrompt](../../packages/daynight/src/cli/prompts.ts)共享 ask/select/selectMany，选择器按需加载 |
| 取消生命周期 | [cancellation.ts](../../packages/daynight/src/cli/cancellation.ts)管理终端信号、取消与关闭 |
| 资源打包 | [copy-resources.ts](../../packages/daynight/scripts/copy-resources.ts)明确列举公开与 review 两个完整 bundle，并复制数据库 owner 的 SQL 目录；公共主题生成完整离线手册，不扫描仓库 skill |
| 物理路径 | [filesystem.ts](../../packages/daynight/src/platform/filesystem.ts)解析已有祖先和未创建部分 |
| worktree 定位 | [git.ts](../../packages/daynight/src/repository/git.ts)只定位根，安装不依赖 origin 或服务 |
| 打包验收 | [installed-cli.ts](../../packages/daynight/test/fixtures/installed-cli.ts)真实打包安装与 launcher fixture |

入口保持 `daynight skill install`，不增加非交互参数、卸载命令、注册中心或用户修改
检测。`agents.ts` 拥有 Codex/Copilot CLI/Claude Code 的命令、路径、重载说明；
`targets.ts` 规划物理目标；`install.ts` 捕获字节、发布和清理旧名称；
`platform/skill-bundle.ts` 校验资源树与入口。`CliContext.packageDirectory` 定位包内资源，
不依赖 cwd。`files: ["dist"]` 包含完整相对资源。

检测依固定顺序查找 codex、copilot、claude，通过直接依赖 `which` 的薄适配器遵守原生
PATH、POSIX 执行权限、Windows 当前目录/PATHEXT/npm `.cmd`/带引号 PATH；不运行
launcher、`--version`、认证或模型调用。
[固定源码](https://github.com/npm/node-which/blob/2009c9dce0e9b0dae024192731987df752c6b4f0/lib/index.js)
说明它只检查文件。仅展示检测到的选项，初始不勾选，Space 切换、方向键移动、Enter
提交且至少选一项；再单选 User/Project，默认 User。无可用 Agent 或终端不可用明确失败。

`@inquirer/prompts` 延迟加载 checkbox/select，review 首次引导使用 readline ask。类型化 value
不从显示文本反推标识。stdin 提供输入，stderr 负责 UI，stdout 提供结果。共享执行器
管理 AbortController、SIGINT/SIGTERM、Windows SIGBREAK 和 finally 关闭；readline
占用 stdin 时进入选择器前暂停、退出恢复。仅已知取消异常转为既有取消错误，其余保留
原因链。依据为
[信号与 readline 协作](https://github.com/SBoudrias/Inquirer.js/blob/92ef32f5b3d9633933bd20bb8ef6ff434c1316bb/packages/prompts/README.md#advanced-usage)
及[checkbox 必选约束](https://github.com/SBoudrias/Inquirer.js/blob/92ef32f5b3d9633933bd20bb8ef6ff434c1316bb/packages/checkbox/README.md#options)。

## 安装目录、所有权与迁移

| Agent | User | Project |
|---|---|---|
| Codex | `~/.agents/skills/using-daynight/` | `<worktree>/.agents/skills/using-daynight/` |
| Copilot CLI | `~/.agents/skills/using-daynight/` | `<worktree>/.agents/skills/using-daynight/` |
| Claude Code | `~/.claude/skills/using-daynight/` | `<worktree>/.claude/skills/using-daynight/` |

User 使用 Node 用户主目录发现，可在仓库外安装。Project 使用当前 Git worktree 根，
子目录、linked worktree、submodule 各定位自身根；非 Git/bare 明确失败。安装不读取
server/review 配置，不要求 origin 或项目关联。支持目录和重载说明按
[Codex](https://developers.openai.com/codex/skills/)、
[Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)、
[Claude Code](https://code.claude.com/docs/en/skills) 维护。

先解析父级 skill 根的物理位置，再拼接 using-daynight 和旧 daynight 叶节点。父级链接
保留，leaf 不 realpath 跟随；替换或清理 leaf 链接保留原指向对象。同一物理根只写一次
并保留逐 Agent 结果；涉及新名称和旧名称的拥有路径出现严格祖先/后代冲突时，在任何
目录或 stage 创建前拒绝，并列出对应目标。路径按分量比较，不能使用字符串前缀。
共享父根链接允许去重；清理不得越过所选物理根或删除另一安装目标。

选择 Agent 表达兼容目标，不承诺发现隔离。Codex 和 Copilot 共用路径；项目中的
`.claude/skills -> ../.agents/skills` 也可使三者共用一次写入。其他 scope 不被修改，
同名副本不合并，Claude personal 优先于 project。原设计的 Copilot 探针曾在特定版本
观察到独立 `.agents`/`.claude` 同名副本与共享父链接均选择 `.agents` 候选，该 receipt
随原设计 PR 保留，仅为历史观察，不是跨宿主版本的保证。

安装先捕获包内完整 bundle 一次，验证 SKILL.md UTF-8、固定 frontmatter 名称
`using-daynight`、非空 description 和仅目录/普通文件的树。固定主题清单中的每份引用都须
为有效 UTF-8 的非空白普通文件，并通过与构建相同的标题及内部链接校验；其他文件保持
原始字节。验证失败时尚未替换任何目标。所有目标使用相同捕获字节，安装与离线输出均
不依赖额外 Markdown 库。

预检后按 Agent 顺序串行处理唯一物理目标：

1. 首次写入前检查取消；创建并记录必要父目录，创建专属 stage，写入全部资源。
2. 再检查取消；取消则删除 stage，逆序清理本次新建且仍为空的父目录。
3. 删除 using-daynight leaf 并 rename stage 发布完整目录；两步之间不主动取消。
4. 发布成功后清理同一物理 skill 根内的旧 daynight leaf，再报告此目标完整成功。
5. 处理取消或继续下一目标。已经完成的目标保留，不跨目标回滚。

发布前不删除旧 daynight，避免重命名迁移先损失原入口。旧名称清理失败时新 bundle
保留，报告部分迁移及实际失败，停止后续目标并非零退出。完整替换不比较修改、不合并、
不备份；覆盖新名称时删除后 rename 失败仍可能使目标缺失。清理 stage 的错误保留
原因链，不能静默吞掉。重跑使用当前包完整恢复，安装不自动重试。

结果逐 Agent 给出 scope、路径、包版本和重载指引，共享目标标明同一次写入。Codex
通常自动发现，必要时重启会话；Copilot 使用 `/skills reload`、
`/skills info using-daynight`；Claude 已有根通常自动发现，新建顶层根时使用
`/reload-skills`。清理旧名称成功不表示其他 scope 的旧入口也被移除。

## CLI 更新时的自动同步

`commands/skill/refresh-installed.js` 是 npm 自更新调用的内部进程入口；公开命令仍为
`update` 与交互式 `skill install`。它从自身安装目录读取清单版本和完整 bundle，使用
现有 Agent catalog、物理路径规划、bundle 校验及顺序替换器，不引入安装 registry。
自更新先验证包和新 CLI，再调用该入口；当前或领先版本也调用，以修复落后的 skill。
独立进程保证模块及资源都来自已安装包，避免旧进程模块缓存与新包混用。
该内部进程的 POSIX Git 调用继承外层更新进程拥有的进程组；独立 Git 调用仍拥有自己的组。
外层在中断、超时和内部进程退出时清理所拥有的组，避免内部 Git 逃离清理范围。
Windows 子进程保留调用者的控制台连接，使继承的标准输入、输出和错误句柄可用；
中断和超时通过 `taskkill /PID /T /F` 处理其进程树。该结果不能证明逃逸后代已经结束，
repository Git 的执行与清理边界见[Git 定位与仓库身份](daynight-project-task.md#git-定位与仓库身份)。
POSIX 外层子进程单独建立进程组。强制终止不能承诺 stage 清理或原子回滚。

检测使用用户主目录和调用目录所属 Git worktree 根。先沿调用目录祖先检查 `.git`
标记，存在时通过既有有界 Git 能力解析自身根；无标记只检查 User，读取错误继续抛出。
检测目标是已有 `using-daynight` 目录或叶链接，入口丢失和悬空叶链接仍可修复；普通
文件或其他非目录节点报错，缺失位置不创建。Agent launcher 不参与判断。

跨 scope 的已安装目标统一解析物理父目录、合并共享目标并检查安装和旧名称清理的
祖先冲突，预检完成后才使用完整替换器。每个结果保留相关 Agent、scope、物理路径、
包版本和重载说明。失败停止后续目标并报告部分结果；父进程另外说明 npm 包已更新
或保留，再以非零退出。重试 `update` 能从当前已安装包重新同步。
[自动同步决策](../../.agents/notes/archived/feature/2026-10-24-update-installed-agent-skills.md)
记录范围和失败边界。

## 调用成本

常规选择读取一次有界 ready，再 show 必要任务及读取附件；已知任务直接 show。
只在语义检查点更新，不每轮完整 list/graph。有效绑定的读取仍涉及绑定验证；首次
发现可能读取多页 project。任务数量有界不代表输出字节或 token 固定，附件也会增加
实际读取成本。需要评估时记录真实命令、字节、耗时与总调用数；字符数/4 仅为英文
粗估，不是 tokenizer 计数或性能承诺。原设计对 graph/show/完整 ready 列表的测量不能
证明当前有界命令、附件读取或模型加载成本。

## 验证与诊断

安装验收运行实际 npm pack 和本地安装 CLI，隔离 User、Project、PATH 和全部临时
资源。模拟 codex/copilot/claude launcher 启动即写 sentinel 并失败，场景结束要求
sentinel 不存在。不安装真实 Agent、不读取账号、不调用模型、不启动任务服务或数据库。
[模拟验收决策](../../.agents/notes/archived/testing/2026-10-21-simulated-agent-installation-acceptance.md)
保留此边界。

开发依赖 `node-pty@1.1.0` 在 Linux/macOS 使用 PTY，Windows 使用 ConPTY。终端内
Node bridge 启动安装 launcher，stdin/stderr 继承终端，stdout 单独落结果文件，证明
真实 isTTY 与流分离。按键包含 Space、方向键、Enter、Ctrl+C；kill 只用于超时清理。
ConPTY 可能将尾随空白编码为光标移动，匹配稳定可见文本并保留原始终端流。pnpm 仅
允许固定 node-pty 的构建 hook，保留 SQLite 既有禁用选择；稳定包 Darwin helper 的
0755 修正使用版本限定 mode-only 补丁，测试不临时修复依赖。
[原生终端决策](../../.agents/notes/archived/testing/2026-10-21-native-skill-terminal-acceptance.md)
拥有这些平台理由和来源。

六种 Agent/scope 组合验证完整相对路径与每个文件字节、重装清除修改和旧文件、保留
sibling 与另一 scope。迁移增加旧名称存在、leaf 链接、清理失败后新 bundle 仍可读及
准确部分结果。单元测试覆盖预检、scope 后首次写入前信号、stage 取消、新建空目录、
parent/leaf 链接、安装/清理路径嵌套、部分失败、监听清理和 completion 回归。Windows
必须有原生结果；Linux 投影不能替代 `.cmd`、ConPTY 或平台链接证据。

静态打包检查验证入口 frontmatter、固定主题清单、打包 allowlist，以及全部实际本地链接的
存在和 bundle 内归属。主题组合另验证标题、章节锚点、代码围栏和完整离线输出的内部
链接；这些是资源结构检查，不以正文特定措辞证明指令有效。验证边界见
[skill 打包验证决策](../../.agents/notes/archived/testing/2026-10-30-skill-packaging-validation.md)。
围栏代码中的任务 Markdown 示例属于写作示例，不作为 bundle 资源链接；打包产物和安装
副本保留这些内容，并与源码完整字节比较。既有
project/task/attachment 套件验证命令语义，创建、更新和 JSON 读取包含中英文、CRLF、
围栏代码、GFM 与链接的描述，确认原始字符串及精确版本完整替换。独立情境演练另外核对
裸调用、缺少创建许可、已有范围内许可、普通指定执行与显式 managed 路由、
具体工作项与临时执行步骤的区分、空 Goal、Parent 归属、共享资料 owner、跨 Goal handoff、唯一初始需求任务、仅登记与明确开始讨论、正文完整
但缺 spec、上传失败、附件不可读或未确认时阻断、确认当前 spec 后先登记 todo 架构
再完成需求、后继登记失败保持前置 in_progress、已有后继复用、终端任务无后继、确认后覆盖
附件须重确认、方案正文直接索引需求来源且先读内容、确认后实际拆分、实质修订重确认、讨论与 PR 交付区分、部分登记恢复、Markdown
自足内容的正文/引用/混合组织、必需引用实际读取、任务定义与成果所有权、前端原型、禁止 merge、阻塞和单任务返回。
移交情境覆盖独立与 Goal 交付任务五项内容、缺详细设计或有序实施步骤、仅有方案方向或待调查根因、正常执行活动与未完成任务设计的区别、本人/未分配/他人负责人、归属查询失败和版本变化、授权启用、已有 true 的只读复审、失败保留许可并报告、blocked todo、运行锁、
done/cancelled终态策略、worker连续性、附件独立变化、冲突/未知写入及启用后立即被认领。Goal 拆分情境覆盖交付任务四项内容、缺实施方案或验收不能证明 Goal 贡献、精确来源引用通过与笼统架构链接失败、无关目标混装、机械碎分、范围过大或过碎、缺失或重叠责任、未定义契约，以及集成和整体验收归属；允许有明确结果的基础能力、迁移、独立验收和已定义契约的 blocked todo。所选 Goal 交付任务移交发现拆分缺口时按实际许可状态报告，不扩大为全组重分或关系修改。指定子任务
演练还核对执行与讨论的范围、跨任务阻塞和后续建议、必需共享输入读取，以及 Goal 级
讨论和整体验收按当前任务已确认范围处理全局内容；managed 情境覆盖原 assignment 与运行约束、普通任务适用范围、上下文缺失/不匹配、原 claim 恢复及最终完成和系统工作区边界。任务/session 分类另覆盖混合请求、无 session 执行安排、真实设计输入、详细设计与必要实施步骤和成果、操作授权、结果身份、
恢复、用户要求的操作手册以及正文/附件/引用的一致边界。每例保留输入、应保留/排除项、
允许/禁止操作、实际观察和结论，标明语义审查或 agent 演练及未验证行为；这些记录留在
实施 session。保留正确规则再追加矛盾指令须由独立语义情境判断。自动化打包检查不包含指令文本变异测试，也不验证指令语义。这些情境是独立指令语义审查，不是自动化文本契约或对模型理解与执行的保证。review bundle 的快照、原生 Copilot 加载与配置隔离继续独立验证。

普通原生 CI 运行 typecheck、test、build、acceptance，receipt 记录源码、平台、场景
和清理结果。文件证据证明安装结果，不能证明宿主发现或模型遵循。PR 是否合并由用户
授权及平台事实决定，不由 skill 测试通过决定。

逻辑操作范围是一个 skill install 或内部自动同步进程；共享上下文传递 Agent、scope、包版本、逻辑
路径和物理根。唯一目标串行 await，无后台队列、服务或 detached promise。诊断区分
检测、选择、规划、stage、替换、旧名称清理及收尾，保留错误链及部分结果，不记录
用户输入、token、配置全文或认证环境。单进程无需额外 operation ID 或 telemetry 后端。

具体人工核查可在隔离终端选择 Codex 与 Copilot/User，确认两条结果共用物理路径并
比较完整 bundle；通过不可写父目录或旧入口探针核对阶段、scope、Agent、目标、原因
和非零退出。重新发现与 scope 优先级随宿主规则维护。自动同步的真实 npm 验收比较
更新后 bundle 与已有目标的所有字节，验证当前版本重试、缺失目标保留和失败退出。
修改保护、跨目标原子性、全局任务互斥等独立能力需要各自需求。
