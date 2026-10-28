# Task Session 需求

## 目标与模式

任务执行采用 `herdr` 或 `web` 中的一种控制方式。两者复用现有任务资格、认领、worktree、managed assignment、进度及完成规则。模式在执行开始前确定，同一 claim 不热切换、不双启动，也不因连接失败自动降级。

- `herdr`：worker 通过 Herdr 启动原生终端会话，Task 不显示 Session。Herdr 承载终端通道。
- `web`：worker 直接启动 Daynight controller，由 controller 持有私有原生会话，经 Daynight server 将结构化事件和操作连接到 Task Session。整个生命周期不依赖 Herdr 安装或服务。

配置复用 `~/.daynight/config.yml` 的 `worker.agentControlMode`，缺省为 `herdr`，不提供 repository 级模式覆盖。Codex、Claude、Copilot 均属于两模式的支持范围。Codex Web 使用私有 app-server stdio；Claude Web 使用 Agent SDK；Copilot Web 使用 SDK 连接 Controller 自己启动的私有 headless runtime，不连接 shared runtime 或原生 TUI。

本文件定义要求，不以字段或协议存在宣称运行时已完成。各组件的实际可用性与拒绝行为由[实现设计](../design/task-session-protocol.md)说明。

独立 `daynight controller <provider>` 测试入口复用 Web 会话实现，其用户行为由[独立测试会话需求](controller-test-sessions.md)定义。Test 会话具有独立创建者和执行身份，不属于另一种 Task 模式，也不能替代下述 claim 与 worker 生命周期验收。

## 执行身份与页面入口

服务端保存 claim 的实际模式；新响应显式返回它，旧数据缺字段按 `herdr` 读取。模式与 Provider、worktree、worker、claim 一起冻结，普通摘要或属性 PATCH 不允许改写。新 claim 才能选择新模式；released task 的人工 resume 创建新 claim，强制撤回沿用归属清除规则。Web 同 claim 的原生恢复保留已冻结配置与停止证明，Herdr 原生重启使用其当前适用设置。

页面只根据服务端当前执行决定 Session 入口。Herdr、尚未认领和旧记录不显示 Session；Web 正在初始化或离线时显示真实状态，不因此改回 Herdr。重新领取为另一模式后，旧页面不能继续写入原会话。已有同步历史应保持执行归属，不将不同 claim 混成一段。

## 基础会话交互

Session 与 Task Overview、Attachments 并列，弹窗和独立详情页共享内容。基础能力包括消息、Markdown、reasoning 展开、工具参数/结果/错误、长输出、历史分页、流式合并、滚动跟随、文本草稿及输入法处理。

消息与 reasoning 保留普通换行并安全渲染 Markdown；没有公开正文的 reasoning 不显示空折叠条目，不从加密内容推断正文。工具文本保持原始字符、缩进和换行，不将日志重新解释为 Markdown。折叠工具摘要保持单行，显示展开入口、可读工具名、超长省略的输入摘要和状态；完整输入与输出保留在展开区。工具状态使用可辨识的文字，长输入与输出支持局部滚动和键盘阅读，折叠后不挂载重内容。工具完成状态遵守原生字段，不能从自由文本推测成功；原生结果中的不同内容保留，相同摘要与详细输出不重复显示。

自动跟随尊重阅读意图：触屏轻点不能暂停跟随，向上阅读、键盘阅读旧内容和脚注跳转应暂停。消息重排、窗口缩放与历史加载保持可见阅读位置，提供返回最新入口。脚注在各条消息间隔离，表格可以用键盘进入滚动区域。

文本草稿在同一浏览器 tab 的刷新与页面切换后可恢复，并按账号、会话归属和执行代次隔离；存储失败不能阻止内存编辑。明确受理回执只清除对应提交版本，不能覆盖提交后的编辑；不确定结果保留草稿且不得自动重发。退出账号、切换身份、执行换代或重新访问被拒绝的会话时清理对应草稿。离开页面后的草稿不承诺即时远程擦除。输入框随内容和宽度变化伸缩并限高，发送完成后的焦点恢复不得抢占审批、其他控件或隐藏页面。

Chatbox 提供文本发送、按原生能力追加、停止当前 turn，以及当前有效审批、问题和表单的响应。原生未提供的能力不显示为可用；不能用排队或中断后重发冒充 steer。停止 turn 不等于完成 task 或停止整个 controller。

初始 managed prompt 获得原生受理且快照同步完成前，普通网页发送保持禁用，避免用户输入抢先改变任务。初始化期间真实存在的原生审批可单独响应。旧交互、已解决的请求以及换代前的请求不可再次提交。

图片/文件输入、历史编辑、fork、Team 和跨本机原生历史会话发现不属于基础交付。Daynight 已登记的独立 Test Session 列表由 [Controller 需求](controller-test-sessions.md#session-view)定义。消息内容保留 typed parts 的扩展位置；Timeline 中已有资源按会话权限安全展示，不能将任意本机路径暴露为下载入口。

Copilot 的 model 或 effort 未指定时保留原生默认值，不补造模型或推理档位；Web args 只接受 `--effort low|medium|high|xhigh`。计划审批通过已有 form 提供 `exit_only`、`interactive`、`reject` 与可选 feedback，不启动 autopilot。URL elicitation 与不能投影的二进制资源必须明确报错，不能伪装成完整的可交互内容。

## Chatbox 设置、命令与运行状态

Chatbox 按 Provider 发现的真实能力提供模型、reasoning effort 和权限选择。默认值保留原生语义；没有可读实际值时显示未知，不猜测默认模型或权限。选择后区分待确认目标与已生效值，只有原生确认或回读才能更新实际状态。显示生效范围；不支持运行中生效的设置不能伪装改变当前推理。失败和未知结果可见，不能自动重复设置操作。

权限设置保留 Provider 的独立含义。Codex 的 approval policy 与 sandbox 分开并遵守配置约束；Claude 保留原生 permissionMode；Copilot 的工具审批不代表路径或网络授权。只有用户明确选择才改变权限，不因恢复或打开设置面板提高权限。

斜杠菜单提供目录、前缀过滤、键盘导航和参数输入。model/permissions 入口打开设置，原生命令必须来自当前可执行目录；未知或歧义命令不能静默退化为普通 prompt。目录加载失败保留错误和重试入口。命令受理只清除对应草稿版本，不覆盖期间的新编辑或无关草稿。

工作状态与 Chatbox 放在一起，区分工作、等待输入、中断申请中及已确认结束。计时依据 Controller 观测到的原生 turn 开始证据，未知时不伪造。工作中发送按 Provider 支持执行 steer；中断保留独立入口并绑定当前 turn。Claude 的追加必须具备输入生命周期与取消排队能力，不能只打开按钮；停止后不能留下未显示的排队输入继续执行。

设置、命令和普通输入共享当前执行与权限约束，多个网页同时操作须拒绝旧目录版本。中断和审批不能被等待中的设置阻塞。账号核验、失焦连接保留、断线与恢复继续遵守下述可靠性要求。

## 生命周期与可靠性

浏览器打开、刷新、翻页和重连不创建 Agent，也不重发任务正文。浏览器或 relay 断线不停止 Agent loop。Controller 持久记录原生身份、输入结果与事件，恢复先对账；不确定结果保持 unknown，不自动重放。

切换应用、窗口焦点或浏览器可见性时，已同步的 Session 应在短暂身份复核期间保留连接、时间线和草稿，不因复核本身显示恢复提示。复核完成前不得发布新会话内容或发送控制操作；确认同一账号后按顺序继续。身份改变、权限撤销或执行失效须立即隔离原会话。保留时间和事件缓存必须有界；超限、真实断线或服务要求重置时按原游标恢复，不能丢弃未消费事件后假装同步完成。

同一执行只有一个原生 writer。连接代次与原生执行代次分离，网络租约过期不能证明旧进程已停。Controller 崩溃后恢复须确认旧进程停止并使用确切原生 ID；没有恢复证据时明确暂停，不新建会话冒充连续执行。

操作受项目权限、claim、执行代次、当前 turn/interaction 约束。服务器接受命令不等于原生受理，原生受理不等于任务完成。高频事件独立于 Task version，断线按持久游标补齐，缺口明确呈现。

清理前必须确认对应 backend 的真实原生进程停止，再释放资源及删除 worktree。网页关闭不能触发清理。任务完成沿用原 managed skill 和 claim-bound done，不以 native idle 替代验收。

## 验收

验证模式冻结、旧记录迁移、非法组合、当前执行页面入口、首次输入门控、跨浏览器并发、审批失效、断线恢复、未知结果及进程清理。Web 须在没有 Herdr 的环境运行；Herdr 须在没有 Session relay 的环境保持原行为。

Codex、Claude、Copilot 的原生执行、恢复与交互必须分别提供真实证据。Copilot 的发送、原生 steer、取消、审批、问题、表单、计划审批及精确恢复都需要独立实测；其他 provider 的历史验收不能替代这些证据。纯前端原型、协议 fixtures、编译成功及单元测试不能代替跨层验收。既有 Copilot Herdr 需要回归，平台支持只在对应平台验证后声明。
