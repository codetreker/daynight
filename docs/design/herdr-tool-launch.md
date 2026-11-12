# Herdr 冻结工具启动与实例切换

本文拥有 Herdr 模式的工具映射、启动证明和共享实例切换。[Worker 架构](daynight-worker.md#本地工具路径选择)拥有工具解析、候选验证和配置准入，[macOS 生命周期](herdr-worker-lifecycle.md)拥有独占运行、持久输入与停止证明；两者分别消费本机制，不改变各自的 Session 或 claim 身份。

## 冻结选择与实例归属

新执行在创建资源前保存 Agent 与 Herdr 的完整 `ResolvedToolLaunch`，以及各自实际探测所得的 `{version,checkedAt}`。Task 配置、macOS preparation/run 和共享实例 journal 保持原选择；目标 revision、PATH 或当前 CLI 安装变化不能替换原 claim 的 recipe。新的 spawn 重新校验原文件及依赖；活进程的输入、停止和归档继续依赖原 endpoint 与进程证明，不要求重新启动旧 executable。

`HerdrInstanceManager` 将 daemon、版本查询和 attach client 绑定到同一 Herdr launch。实例握手确认实际 version/protocol，不能把当前目标路径与旧实例版本拼在一起。实例元数据还保留受控 shell 使用的原 Node 与 helper 入口，重连不能把后来安装的 helper 当成旧实例的启动代码。`worker attach` 只读原实例记录并核验原 launch；文件缺失或变化时明确失败，不使用新 client。

macOS 每个实际运行代次继续拥有独占实例。新 execution 可以选择新 Herdr，旧执行仍使用自己的实例；原 claim 恢复创建下一代 run 时仍使用原冻结选择。Linux/Windows 使用共享私有实例，其切换需要先清空旧责任，不能用独占实例的准入规则代替。

旧记录没有 launch 时保留未知事实。原 endpoint 的观察、输入、停止与归档保持既有身份检查；需要新工具或 client spawn 时拒绝缺失的历史工具身份，不能从当前 PATH 补造。

## 每执行映射

`herdr/tool-launch.ts` 在实例私有目录的 `tool-launch/` 下维护 owner 与 selectionKey 对应的 generation。manifest 保存 canonical owner、随机 nonce、冻结 Agent launch、native 原 PATH、Node/helper 绝对路径与平台。当前 generation 索引只指向完整发布的 manifest；旧 generation 仅在全部原进程确认停止并写入 retirement 证明后才能替换。重连只读原 manifest，缺失、损坏、错 owner 或改变选择均拒绝。

`tool-launch-protocol.ts` 通过有界普通文件读取、独占临时文件、同步及 create-only 发布保存证据；POSIX 同时要求 owner-only 权限。manifest、启动 intent、receipt、初始输入 intent 和进程 journal 分别承担自己的事实，不能用某个文件存在推断其它步骤完成。

Herdr 的 `agent.start` 仍接收原 kind 与逻辑参数，回执必须精确等于 `[kind,...args]`，没有新增 executable RPC。只有受控 pane 的裸命令经过映射；版本、模型、help、能力与配置探测直接消费 `toolCommand`，不依赖 shell 发现。

### macOS 与 Linux

新受控实例使用不读取用户启动文件的 Bash。rc 定义不 export 的 `codex`、`copilot` 函数，调用原绝对 Node/helper 并以独立 argv 传递 manifest 和参数。函数不 `exec` 替换审计 shell，native child 不继承函数或映射 PATH。原 shell 通过 nonce/PID readiness 文件报告初始化完成；捕获该 shell 的原进程身份后才允许 Agent 启动。

### Windows

仅对本次新建、尚无 Agent 或输入的 owned tab，使用 `layout.apply.root.command` 的结构化 argv 创建系统 PowerShell 5 `-NoProfile -NoLogo -NoExit -File` 根进程。bootstrap 在该进程完成初始化并保留交互提示符，不另起常驻 shell。布局 intent 在 RPC 前保存；未知回执只观察原布局、nonce、binding 和初始进程关闭情况，不重新提交布局。

bootstrap 将私有映射目录置于父 pane 的 PATH，并验证 `Get-Command` 命中原 `ExternalScript`。`codex.ps1`、`copilot.ps1` 将参数数组编码为 JSON/base64，再由 Node 解码后 `spawn(..., shell:false)`，避免 PowerShell 5 的 native 参数拼接改变空字符串、引号和反斜线。调用 helper 前恢复 native 原 PATH，Codex 内部 CLI 环境同样使用原 PATH。执行策略、系统 PowerShell、脚本发现或 readiness 验证失败均明确拒绝；不改用任意 shell，不宣称 PowerShell 7 支持。

根进程 readiness 使用 Windows 原生进程接口独立核验 bootstrap 报告：在同一个原进程句柄上读取 Win32 executable 路径和 `GetProcessTimes` 出生时间，并在读取前后确认进程未退出。FILETIME 转换为 `.NET Ticks` 时保留全部 100ns 精度，与原 `startToken` 精确匹配；不得复用为旧 CIM 记录兼容而截断到微秒的 journal 时间格式。

进程清单使用 Toolhelp32 的完整进程快照，只提供候选 PID 与 parent PID；归属仍由原完整 command hash、出生身份及父子链核验决定，快照本身没有终止授权。空清单、重复或非法条目、未完成枚举和句柄关闭失败都保留未知。采集继续受 `min(10s, requestMs, totalRemaining)` 限制，在原生调用前后及库载入后检查预算；已进入的同步系统调用须等待返回，再拒绝过期结果并关闭句柄，不声称能够强行取消内核调用。该观察路径不启动额外 PowerShell，不改变 native 环境或 Herdr daemon 的启动方式。

官方 hook 的运行时探测仍在原 native 环境与 cwd 中执行裸 `powershell`，验证 hook 真正使用的 PATH 命令。只有 Windows 的该探测采用非 detached 子进程，以保留 PowerShell 输出；原命令执行器继续拥有预算、进程树终止与 child/output streams 关闭确认。原生元数据观察不能替代这项运行时可用性检查。

## 启动、输入与 Session 确认

manager 在 `agent.start` RPC 前持久保存原 request、binding、逻辑 argv 摘要及 attempt；未知结果跨调用与重启禁止再次 RPC。只有当前调用取得明确未启动的拒绝并持久确认后，才能在原初始化重试规则内推进下一 attempt。helper 核验原 manifest 和 recipe，先 create-only 保存 intent，再启动冻结命令并保存 child receipt。intent/receipt 关联 owner、nonce、selectionKey、逻辑 argv 摘要、实际 file/prefixArgs 及 helper/native PID。未知启动结果保留原 intent，不重发 `agent.start`。

输入前必须同时核实原 workspace/pane/terminal、Herdr kind/readiness、逻辑 argv 回执、manifest/nonce、实际 launch receipt、原 shell 和完整 shell→helper→loader/native 归属。`tool-launch-lifecycle.ts` 保存原进程证明并沿已证实的父子关系追加后代。helper 名称不伪装成原生工具，不设置假的进程名，不调用 `pane.report_agent` 补造识别结果；Herdr 必须识别真正 native。

Windows 的 `ParentProcessId` 可能保留已退出父进程的编号，并指向后来复用该编号的无关进程。因此新后代登记同时核验原父进程实例和父子出生顺序；调用方直接提供的 PID 与清单发现的 PID 使用同一规则。子进程的精确出生时间必须严格晚于原父进程；相同时间不能证明先后，保持未知。登记前后父进程必须仍匹配原出生证明，候选按父子顺序建立完整链。显式 mapping 清理和恢复必须先核验原 journal 的出生链，才可终止 Job 或进程；缺证或矛盾不能靠删除旧记录、重新采样或改认新根进程消除。清理阶段缺少原 journal 时，不得从当前 foreground PID 新建根进程归属。

新会话的官方 integration 可能直到首次输入触发 SessionStart 才报告 ID。因此初始输入最多提交一次，递交前持久保存原 intent；macOS 继续使用原输入 journal 与仲裁器。启动成功必须等待同 pane 的官方 integration 报告符合原 kind 的合法 native Session UUID，并再次核验原进程归属。已知 ID 必须精确相同。缺失事件、不同 Session、进程变化及未知输入结果均保持未确认，不重放初始输入、不换会话、不人工补报。普通自动输入不能越过 frozen 执行的未知 native Session。

退出与清理包含 helper、loader、native 和已登记后代。helper 退出但 native 仍活着不能证明关闭，也不能授权 mapping 换代或共享 daemon 切换。macOS 的 audit/birth 身份及停止顺序继续由独占生命周期维护；共享路径保留各代进程 journal，缺损或未解释资源阻止新 spawn。启动 intent/receipt 声明的 helper 与 native 都必须有原出生证明；只有 shell 的 journal 不能证明尚未登记的 native 已停止。已严格确认的 retirement 是该代的终态停证，后续 PID 复用不重新开启旧责任。

Windows helper 在 native spawn 前创建唯一命名 Job、配置 kill-on-close 并加入自身，使后续子进程继承同一 Job；全部成功后才持久发布绑定原 owner、nonce、selection 和 helper 的边界记录。helper 的原句柄保留到 OS 处理其自然或异常退出，不在 JavaScript 清理中关闭并误杀自身，从而保留 native 的退出码。Job 成员引用可以保留对象本体，却不能在最后命名句柄关闭后保留名称；按名称查询失败不能解释为空 Job。

kill-on-close 及原句柄观察器是启动前建立的自动退出策略，其职责是终止原 Job，独立于之后的 journal 登记。它们不发布 retirement，也不能从缺失 journal 推导显式清理或恢复的权限。

Worker 核验原边界、helper 出生身份及 Job 成员关系后，保留第二个原 Job 句柄和原 helper 进程句柄，供同代 mapping 重连复用。第二句柄会抑制最后句柄关闭时的自动终止，因此保留后立即建立轻量观察器，在原 helper 句柄已 signaled 后终止原 Job 的剩余成员；之后的首次成员枚举失败不能取消该退出观察。观察器不发布 retirement；失败保留句柄、未知状态和清理责任，不反复高速重试。完整停止仍须通过原句柄确认 Job active count 为零、已观察成员的原进程句柄全部 signaled，以及原 journal 的退出核验，再持久保存 retirement 并释放句柄。若 Worker 与 helper 均丢失句柄，kill-on-close 的触发也不能替代全部退出证据；没有已确认停证的 Job 名称缺失、旧记录缺边界或身份不匹配均保持未知。

历史观察错误阻止输入，却不能提前阻断使用原句柄的有界停止与重新核验。清理先验证完整 journal 和 receipt，再终止原 Job；只有曾由原 Job 成员关系确认、原进程句柄已 signaled 且 PID 未被复用的成员，才可跳过已消失父进程的重新登记。未知前台进程仍保留原出生链要求。retirement 已精确匹配该 generation 时，后续清理只重试本地仍保留的句柄释放，不重开 Job 或查询历史 PID；已经成功关闭的句柄不得再次关闭。

首次绑定尚未证明 Job 与 helper 共同归属时，关闭失败只保留原句柄的释放责任，不授予终止权；并发接入不得覆盖这份未完成责任。

## 共享实例切换与恢复

`shared-instance-store.ts` 在 `tool-instance.json` 保存 current launch、握手观察、原 daemon proof、阶段和 pending launch。文件严格校验、原子替换、同步并读回。Worker 实例锁和 adapter 串行队列共同拥有转换；配置目标本身没有停止或替换原实例的权限。

`shared.ts` 的新目标准入依序核验候选、保留切换 intent、停止原实例、确认 API/client 两个 endpoint 关闭及原 daemon 和全部 mapping 进程树停止，再核验并启动新 launch。已验证的文件 recipe 不能证明 daemon 仍存活；新 Herdr 准入仍重入实例检查。运行循环只在配置选择 Herdr 时定期刷新该候选，并唤醒对账，使无旧 claim 的空闲实例退出后也能按同一规则恢复，纯 Web 不因此启动 Herdr。spawn 前保存 starting，取得原 daemon proof 后才接受实际握手并提交 ready/applied。旧执行、未确认 probe、启动/停止未知和遗留 native 都使新目标保持 pending；原执行的 RPC 和健康 Web 执行继续可用。首次迁移旧非受控实例也遵守这些规则，缺原 daemon 身份不能用 RPC 回执冒充完整停止证明。

原 claim 的 `ensureExecution` 只读该 claim 的冻结配置，要求与 journal 的 current selectionKey 相同。原 daemon 仍活时重连；只有原 daemon、两个 endpoint 和全部旧 native 树均已确认关闭，才可用同一冻结 launch 重启。该入口不允许把新目标 B 变成旧 claim A 的恢复工具。协调器在调用前重新读取任务，核对 active claim、Worker、worktree、模式、Agent、许可和暂停状态；普通清理仅重连，不因清理启动新 daemon。

## 观察与验证边界

工具遥测按 selectionKey 聚合原实例与执行事实，允许同时出现多个实际选择。版本来自对应冻结观察或实际实例握手；无完整证据时计数和版本保持未知并保留 unconfirmed，不能由 task.status 推导进程存活。采样只读，不启动或探测工具。

单测与受控故障覆盖映射损坏、未知输入、旧 claim 恢复、A/B pending、替代进程、legacy endpoint 和旧 attach。`herdr-tool-platform.integration.test.ts` 在对应真实 OS 使用固定官方发行工具验证 shell、argv、TTY/console、官方 Session 回报及完整进程回收；Windows 验证真实系统 PowerShell 5 和 ExternalScript。独立清理检查不能以测试通过代替。CI 的三平台 job 必须实际成功，跳过不算通过；这些真实 native 隔离证据仍不等同于真实账号 Provider、完整 Worker 或网页组合验收。

Windows 的独立 CIM/console 观察脚本使用观察器自己的执行环境：仅继承测试运行器的明确系统变量，用户目录与临时目录归属测试根目录，模块路径限定系统 PowerShell 5 的模块。查询子进程非 detached，且不通过 `windowsHide` 设置 `CREATE_NO_WINDOW`；输入流处理保持不变。它们继续查询原 shell/helper/native 的实际 PID，保留原查询逻辑、10 秒预算和进程树及输出流关闭要求；关闭未知时保留目录并使独立清理检查失败。固定阶段标记只辅助定位查询停点，不能代替查询结果或关闭证明。ExternalScript 发现和官方 hook 探测仍使用被测环境，native 与 daemon 的环境不因观察器而改变。
