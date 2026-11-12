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

独立进程清单查询只在自己的 PowerShell 5 子环境移除继承的 `PSModulePath`，由系统重建模块路径，避免经 Node 传入 PowerShell 7 的模块。查询将命令错误作为终止错误，必须返回有效的非空 JSON 数组；空白、空数组、损坏或不完整输出均保持进程归属未知。该环境处理不改变 native 子进程环境。

## 启动、输入与 Session 确认

manager 在 `agent.start` RPC 前持久保存原 request、binding、逻辑 argv 摘要及 attempt；未知结果跨调用与重启禁止再次 RPC。只有当前调用取得明确未启动的拒绝并持久确认后，才能在原初始化重试规则内推进下一 attempt。helper 核验原 manifest 和 recipe，先 create-only 保存 intent，再启动冻结命令并保存 child receipt。intent/receipt 关联 owner、nonce、selectionKey、逻辑 argv 摘要、实际 file/prefixArgs 及 helper/native PID。未知启动结果保留原 intent，不重发 `agent.start`。

输入前必须同时核实原 workspace/pane/terminal、Herdr kind/readiness、逻辑 argv 回执、manifest/nonce、实际 launch receipt、原 shell 和完整 shell→helper→loader/native 归属。`tool-launch-lifecycle.ts` 保存原进程证明并沿已证实的父子关系追加后代。helper 名称不伪装成原生工具，不设置假的进程名，不调用 `pane.report_agent` 补造识别结果；Herdr 必须识别真正 native。

新会话的官方 integration 可能直到首次输入触发 SessionStart 才报告 ID。因此初始输入最多提交一次，递交前持久保存原 intent；macOS 继续使用原输入 journal 与仲裁器。启动成功必须等待同 pane 的官方 integration 报告符合原 kind 的合法 native Session UUID，并再次核验原进程归属。已知 ID 必须精确相同。缺失事件、不同 Session、进程变化及未知输入结果均保持未确认，不重放初始输入、不换会话、不人工补报。普通自动输入不能越过 frozen 执行的未知 native Session。

退出与清理包含 helper、loader、native 和已登记后代。helper 退出但 native 仍活着不能证明关闭，也不能授权 mapping 换代或共享 daemon 切换。macOS 的 audit/birth 身份及停止顺序继续由独占生命周期维护；共享路径保留各代进程 journal，缺损或未解释资源阻止新 spawn。启动 intent/receipt 声明的 helper 与 native 都必须有原出生证明；只有 shell 的 journal 不能证明尚未登记的 native 已停止。已严格确认的 retirement 是该代的终态停证，后续 PID 复用不重新开启旧责任。

## 共享实例切换与恢复

`shared-instance-store.ts` 在 `tool-instance.json` 保存 current launch、握手观察、原 daemon proof、阶段和 pending launch。文件严格校验、原子替换、同步并读回。Worker 实例锁和 adapter 串行队列共同拥有转换；配置目标本身没有停止或替换原实例的权限。

`shared.ts` 的新目标准入依序核验候选、保留切换 intent、停止原实例、确认 API/client 两个 endpoint 关闭及原 daemon 和全部 mapping 进程树停止，再核验并启动新 launch。已验证的文件 recipe 不能证明 daemon 仍存活；新 Herdr 准入仍重入实例检查。运行循环只在配置选择 Herdr 时定期刷新该候选，并唤醒对账，使无旧 claim 的空闲实例退出后也能按同一规则恢复，纯 Web 不因此启动 Herdr。spawn 前保存 starting，取得原 daemon proof 后才接受实际握手并提交 ready/applied。旧执行、未确认 probe、启动/停止未知和遗留 native 都使新目标保持 pending；原执行的 RPC 和健康 Web 执行继续可用。首次迁移旧非受控实例也遵守这些规则，缺原 daemon 身份不能用 RPC 回执冒充完整停止证明。

原 claim 的 `ensureExecution` 只读该 claim 的冻结配置，要求与 journal 的 current selectionKey 相同。原 daemon 仍活时重连；只有原 daemon、两个 endpoint 和全部旧 native 树均已确认关闭，才可用同一冻结 launch 重启。该入口不允许把新目标 B 变成旧 claim A 的恢复工具。协调器在调用前重新读取任务，核对 active claim、Worker、worktree、模式、Agent、许可和暂停状态；普通清理仅重连，不因清理启动新 daemon。

## 观察与验证边界

工具遥测按 selectionKey 聚合原实例与执行事实，允许同时出现多个实际选择。版本来自对应冻结观察或实际实例握手；无完整证据时计数和版本保持未知并保留 unconfirmed，不能由 task.status 推导进程存活。采样只读，不启动或探测工具。

单测与受控故障覆盖映射损坏、未知输入、旧 claim 恢复、A/B pending、替代进程、legacy endpoint 和旧 attach。`herdr-tool-platform.integration.test.ts` 在对应真实 OS 使用固定官方发行工具验证 shell、argv、TTY/console、官方 Session 回报及完整进程回收；Windows 验证真实系统 PowerShell 5 和 ExternalScript。独立清理检查不能以测试通过代替。CI 的三平台 job 必须实际成功，跳过不算通过；这些真实 native 隔离证据仍不等同于真实账号 Provider、完整 Worker 或网页组合验收。
