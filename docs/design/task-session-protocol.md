# Task Session 模式与共享契约

## 组件与实现边界

[需求](../spec/task-sessions.md)定义两种互斥执行方式。认领服务保存实际模式，CLI 冻结执行配置，Web 读取同一字段。共享纯 TypeScript 协议位于 `packages/daynight/src/session/`；CLI 发布时随包编译，Web 从同一源码消费类型与解析，避免产生独立发布包或重复协议副本。模块不得依赖 Node 进程、文件系统或认证配置。

Herdr 终端内容的[显式 v2 契约](session-v2-contract.md)使用独立严格解析器、运行代次账本和完整帧归档；其页面与控制由 [Herdr Session Web 设计](herdr-session-web.md)说明。Web producer、relay 路由与 v1 文件行为保持本页所述；v2 类型可用本身不代表运行端具备对应能力。

worker 根据冻结模式选择 backend。Herdr backend 负责 Codex、Claude、Copilot 的原生终端执行；Web backend 支持 Codex、Claude、Copilot，并启动独立的 `daynight controller <provider> --launch-id <id>`。服务端 Session relay 与 Task Session 页面承载 Web 模式的历史和控制，纯 Web 执行不初始化、启动或探测 Herdr。独立[运行快照上报](daynight-worker-reporting.md)只读私有端点版本，不初始化 Herdr 执行 backend。非法组合在认领前拒绝；已有执行的恢复与清理仍由其原 backend 负责。

公开的 `daynight controller <provider> [options] [prompt]` 在当前目录创建独立 Test Session，前台 launcher 承担注册、凭据续签与停止证明；它不运行 worker 调度或创建 Task。其[用户需求](../spec/controller-test-sessions.md)与 Task 生命周期分开，底层 Provider、在线 relay 与 Session View 共用。

## 配置与持久身份

`worker.agentControlMode` 只接受 `herdr|web`，省略为 `herdr`。repository 继承根模式但不可覆盖；`agent/model/args` 保持原继承规则。Codex、Claude、Copilot 均支持两种模式。

有效模式进入服务端 WorkerClaim 和本机认领索引，Web 另将配置冻结到独立执行记录和 launch ticket。服务端旧记录缺字段按 Herdr 迁移；本机最小索引按明确 schema 升级补充模式，旧详细 worker 数据库继续明确拒绝，不静默转换。没有执行证据不能补造进程、会话或已停止事实。请求显式 null、未知值或 Web 非空 Herdr binding 均拒绝。

worker 主索引保存 project/task/claim、status、agent、session_id 和 agent_control_mode。Herdr 延续当前资源对账及进程内计时；Web 的配置、恢复预算、初始输入回执、清理期限及进程证据保存在独立 web-executions.sqlite 中，由 Web backend 负责解释，不成为 Herdr 的恢复来源。Controller 自身 journal 仍是原生调用与 outbox 的所有者。强制撤回清除 claim 的同时使对应 Session 失去普通写能力；不宣称已停止远端进程，也不提供 transfer。

Web 清理首次落盘时，以 backend 读取的时间为 startedAt；如果调用方的 deadline 已经过期，将其规范为 startedAt，表示剩余预算为零。该规则覆盖立即停止时两次取时之间的毫秒差，不授予额外执行时间。已有清理记录始终保留原 startedAt、deadline 和操作身份；worker 直接退出跳过清理 prompt，仍须独立证明原生进程停止。

Web 的每次 waiting_input/working 变化只写 Session 事件，不切换 Task 的 worker.phase。Task summary 保留 preparing/executing/paused 等执行阶段，避免审批期间的高频版本更新使 Agent 刚读到的 task version 立即失效。模式不可通过 worker summary 或普通 properties 更新。服务端当前 claim 是页面模式的唯一依据，nativeSessionId、是否在线或用户 YAML 均不能替代它。[认领设计](daynight-worker-claims.md)拥有实际 HTTP 路径和事务约束。

## Wire 身份与操作

协议主版本为 `daynight.session.v1`。sessionId 与严格互斥的绑定字段标识持久归属：Task 使用 claimId，Test 使用 testExecutionId。Test identity 使用 ownerUserId，不携带 projectId、taskId、workerId、worktreeId；Task identity 保持这些真实字段。缺失绑定、两种绑定混合及身份与绑定不符均拒绝。executionGeneration 标识原生运行实例，connectionEpoch 标识当前网络连接。代次用规范正 int64 十进制字符串，避免 JavaScript number 舍入和不同编码的等价值。重连不改变执行代次。

浏览器操作包含 requestId、operationId、sessionId、对应绑定、executionGeneration、kind 和 payload。浏览器操作不绑定某次 Controller 网络连接；实际投递和回执由服务端连接代次约束。操作包括：

- `send_message`：typed text content 与 expectedTurnId，空闲发送或受原生能力限制的 steer。
- `cancel`：精确的活动 expectedTurnId。
- `interaction_response`：当前交互身份、修订、submissionId 及 typed response。
- `update_setting`、`execute_command`、`refresh_controls`：原生设置修改、命令执行和能力目录刷新；目录修订与活动 turn 的绑定见[会话设置与原生命令](#会话设置与原生命令)。

解析拒绝错误版本、未知字段、缺字段、不合法身份及超限内容，不能把未知操作降级为文本。typed content 为资源扩展保留位置，当前输入不接受附件。Timeline、operation receipt、资源描述与状态使用相同会话归属，不信任任意 URL 或本地路径作为资源授权。

快照包含 initialInputState。普通发送同时要求当前绑定、完成同步、写权限和首次任务 provider_accepted/confirmed；初始化审批只处理实际原生请求。原生开始、输入受理、turn 结束和任务完成是独立事实。

Test 创建时显式声明有无首条 prompt。无 prompt 使用 not_required，不伪造一次 confirmed 输入。该分支只在 Controller 取得 Provider handle、Provider ready 且 relay 同步后允许首次网页发送；Claude 此时可尚无已确认原生 ID，收到真实原生证据后才填入。Task 不能使用 not_required，有 prompt 的 Test 仍遵守原首次输入受理门控。未知输入按原 operation 查询，不能借空会话状态重发。

共享 JSON fixtures 是 Go/TypeScript 对协议表示和拒绝行为的共同输入；验证必须经过各自的真实 codec，不能仅将 JSON 解析到通用 map 后回写。

## 在线测试会话目录

Web 目录固定请求 `GET /api/v1/test-sessions?online=true`。服务在排序和 LIMIT 之前过滤 active、connected/synchronizing、有效 last_seen 与 connection_expires_at，以及当前连接和原注册所属凭据；未消费的新 grant 不影响仍有效的旧连接。分页 cursor 绑定 online 过滤模式，不能跨模式复用。省略过滤参数或使用 online=false 仍可读取完整的有权访问列表，单会话历史和本地 resume 不依赖页面筛选。

## 独立 Controller 手动恢复

`controller <provider> resume [test-session-id]` 从私有 launch ticket 与 journal 建立来源绑定，核对 provider、native ID、native home、真实 cwd、server origin、owner 与停止证据。候选选择后再次核验服务端归档身份，并取得以 provider、规范 native home 和 native ID 为键的本机跨执行锁；加锁后重新检查同原生会话的全部已登记执行，防止选择期间状态变化。

本机 native resume lease 库独立使用版本 1。申请在同一同步事务中检查格式、必要时重置或升级、查重并写入 lease；已有 `leases` 表的任何保留行都阻止重置或迁移，版本 0 没有该表时可重置。版本 0 重置丢弃原 schema 和数据，并执行基线与编号升级。释放先在事务内确认当前格式，再按原 native_key 与 nonce 删除，不进入自动升级或过期回收。格式和关闭失败保留错误与原归属。共同机制见 [SQLite 升级设计](cli-sqlite-migrations.md)。

恢复注册新的 Test Session 和 execution，使用新的凭据、journal 和操作身份，ticket 的 resumeNativeSessionId 指向原生历史且 initialInput 固定为 none。新 URL 从原生历史投影 timeline，旧 Session 的归档和回执保持不变。已有 Provider 原生恢复负责准确身份与历史加载，不重发旧操作。锁贯穿 launcher 的执行和清理；未启动或完整停止证明允许释放，未知结果保留租约。该流程不放宽服务端 archived grant 拒绝，也不承担外部原生 TUI 的抢占。

## Test Session 注册与权限

Test 使用独立 `/api/v1/test-session-capabilities` 预检及 `/api/v1/test-sessions` 注册入口，避免改变旧 Task 客户端的严格能力响应。创建者来自已验证的 PAT principal；客户端提供持久 registrationId 与 testExecutionId，对账不能改换 ID。Controller grant 与 Task 共用格式和连接入口，但绑定 Test 身份及父凭据，续签不改变原执行。

Test 快照、历史、操作、资源和浏览器 channel 位于 `/api/v1/test-sessions/{sessionId}` 下。访问时检查当前凭据与创建者，而 Task 路径继续检查项目权限及当前 claim。两类授权策略进入同一在线内容转发、操作去重与投递实现，不以空 task 参数代表跳过校验。会话身份表名 task_sessions 保留，scope 与 test_execution_id 的数据库约束区分归属；Task 归属校验不变，Test 不制造占位 Task。

`GET /api/v1/test-sessions` 提供账号范围内的列表读取，与同路径的 `POST` 注册分开。返回 `{ items, nextCursor }`，每项包含 `sessionId`、`provider`、`lifecycle`、`connectionState`、`createdAt`、`updatedAt`。`updatedAt` 使用会话创建时间与最新连接心跳时间的较大值，表示服务最近观察到该连接，不推断本机文件或 Agent 的实际工作时间。列表按该时间和 Session ID 降序分页；`limit` 默认 50、最大 100，cursor 绑定当前用户。数据库在分页前过滤 Test scope、创建者和原父凭据有效性；状态读取沿用现有连接时效规则。

前端 `/test-sessions` 与 `/test-sessions/{sessionId}` 均受现有登录机制保护，登录 return path 仅接受合法站内路径。列表复用账号范围和请求身份校验，刷新从第一页开始，追加页按完整 Session ID 合并。列表不维持跨请求快照，因此会话活动可能改变后续分页位置；刷新用于重新发现移到前面的记录。列表链接进入原 Session View，由单会话接口再次授权，不把列表中出现过视为持续访问许可。Test 容器提供身份与 API 适配，复用 Task 的 SessionView/client。URL 不含 token；账号失效、变更或退出触发客户端清理，服务端对读写及持续订阅独立校验。

前台 launcher 使用私有 ticket、凭据、journal 与进程证据，Ctrl+C 先停止本机拥有的执行，再向 `/stop` 提交当前绑定及停止记录归档。POSIX 进程身份探测仅为 `ps` 子进程设置 `LC_ALL=C`，使启动时间解析和再次核验不受终端 locale 影响；Controller 和原生 Agent 仍继承用户原环境。该处理不放松 PID、启动时间、命令指纹与进程组的匹配要求。服务端验证凭据、执行身份与记录格式，不宣称远程执行过本机 OS 检查。服务不可达时本机停止继续执行，保留未确认归档事实。用户当前目录不属于 launcher 清理资源。独立入口不自动恢复或采用任意原生会话。

原生执行启动后的凭据续签将 HTTP 408、429、5xx 和传输失败留在监督循环内，按 1、2、4、8、16、30 秒递增并封顶退避，失败诊断不替代执行事实。成功后在原执行身份下写入新凭据并复位退避；不重新注册、不替换进程、不重放初始输入。明确的授权拒绝或协议/身份错误仍进入有界停止，Ctrl+C 能中止在途请求和等待。凭据过期时既有 relay 关闭失效连接，服务端在 Poll 和 operation_begin 事务中检查当前 grant 与父凭据，拒绝新的原生调用授权；浏览器显示或请求受理的短时延迟不改变这项执行约束。

本机 IPC 在收到完整且通过身份验证的请求后结束 30 秒 admission 超时，并释放请求缓冲。初始输入响应最多等待 65 秒，清理响应最多等待 30 秒且不超过清理 deadline；这些等待只控制调用者连接，不取消已经 dispatch 的原生操作。每个本机 IPC dispatch 共享一次完成通知，连接断开或响应截止时移除对应等待者。未完成的本机 IPC dispatch 和操作等待者分别最多 32 个；observe 与 stop 不占操作等待配额，保持观察与显式停止可达。

IPC 传输失败、EOF 或响应超时使用明确的 outcome-unknown 错误，与服务明确拒绝、错误身份或无效协议响应分开。独立 launcher 在已启动执行的观察失败时继续监督和续签；初始输入响应未知后只观察原执行，不再提交初始输入，即使后续快照仍为 not_submitted。该快照不能证明先前请求未到达。带 prompt 的执行若后续观察到 initialInputState 为 failed，即使 lifecycle 仍为 ready，也按直接收到初始输入失败的路径报告错误并清理原执行；不带 prompt 的会话不适用该判断。未知、派发中与成功状态继续监督；显式取消和真实执行失败仍保留停止路径。

注册后尚未尝试 spawn 的失败可提交 `kind: never_started` 停止记录。服务端只在 grant 未消费、connectionEpoch 为零且没有 sourceEpoch 或 nativeSessionId 时接受；曾经连接再断开不满足条件。尝试过 spawn 却无法证明进程停止时保留未确认状态，不能冒称从未启动。

## Controller 与原生会话

worker 将冻结配置、managed prompt、初始 operationId、原生目录和 IPC 身份写入私有、不可覆写的 launch ticket；命令行只携带 launchId。Controller 使用单写者 SQLite journal 保存执行身份、输入结果、投影修订索引及有界 outbox，timeline 和资源正文写入相邻的待归档文件。本机 IPC 用 ticket 中的随机 secret 鉴权，worker 以此观察、提交首次输入和请求清理。Controller 与 worker 分离，使 worker 重启无需重启仍在运行的 Agent。

`captureProcessProof` 统一拥有新进程证明采集的默认预算：Windows 为 15 秒，POSIX 为 5 秒；显式调用预算仍优先。父 launcher、Controller 自身以及 native spawn 共用该机制，`inspectProcessProof` 的日常身份复核仍显式使用 5 秒。Windows 通过已有 Koffi 依赖在本进程内打开原 PID 的 process handle，保持该句柄直到出生时间、父进程身份和完整 UTF-16 命令行采集及校验完成。全部字段来自同一进程实例，PID 复用不能把多次查询拼成另一实例的证明；证明字段结构与出生时间的既有 UTC 表示、CIM 微秒精度保持不变，命令行按完整 Unicode 文本计算哈希，不经过 PowerShell console 编码，也不用 executable path 代替。旧查询曾因 console code page 丢失字符，其错误文本的哈希与完整 Unicode 哈希不保证相同；不接受旧哈希 fallback，也不重算或替换原证明。Windows 复核只有出生时间、命令行哈希和 process group 均相同时返回 running；出生时间不同才返回 replaced。出生时间仍相同而命令行哈希或 process group 不同时，原进程实例尚未证明停止，复核抛出身份不确定错误，停止确认在查询 Job 成员前传播该错误并保留执行资料与资源责任，不能据此恢复或删除资源。POSIX 的比较行为保持不变。Windows 在 native 调用之间检查预算并等待已开始的调用返回，JavaScript 计时器不能抢占 kernel 调用。Controller 先保存自身证明及 Windows Job 边界，再绑定认证 IPC。权限、native 查询或结果格式错误继续失败并保留原错误和未确认责任，缺失管道不能证明启动未提交或进程已停止。机制与依赖限制见[Windows 原生进程证明决策](../../.agents/notes/implemented/bug-fix/2026-11-05-windows-native-process-proof.md)，预算依据见[启动证明预算决策](../../.agents/notes/implemented/bug-fix/2026-11-05-windows-startup-process-proof-budget.md)。

Journal 的 1→6 非零迁移由本库定义持有并保留原数据；版本 0 在准入后丢弃原 schema 和数据，从基线与编号升级重建。已有空版本 0 文件也在查询访问时初始化。启动在同一事务中先检查旧 owner，再重置或升级及执行原 ticket/generation 认领；版本 0 没有 `execution` 表时可重置，已有该表时必须能读取 `id` 和 `owner_pid`，缺列或活跃、未知 owner 均在 DDL 前失败。纯读取只完成格式重置或升级，不启动 Controller 或认领 writer。当前格式在同一只读快照内检查并读取，不创建或重建待归档文件。版本 0 重置不删除独立待归档源；若启动时已没有 execution 身份记录而待归档 timeline 或资源非空，必须拒绝采用，不能只凭相同 Session ID 把历史归入新 ticket。空 manifest 可以用于尚未写入内容的初始化重试。独立 stopped writer 在事务外验证进程树，最终事务重查格式及 snapshot 后写停止状态；close 清除 owner_pid 也是受格式检查的写入口。

本地数据库更新与 IPC 请求使用不同的错误边界，更新失败不能被解释成不可达而创建新 generation 或重放输入。独立 launcher 的退出保留 journal 错误，同时继续尝试停止已归属 child；完整停止及 journal 证明缺失时保留 native lease 和未确认结果。

Codex adapter 通过私有 `codex app-server --stdio` 建立 thread，恢复时要求精确 thread ID 和 cwd，并分页读取原生 items。Claude adapter 使用 Agent SDK Query，SessionStart 确认精确会话身份；SDK 配套 CLI 是默认执行程序。Claude SDK 空输入初始化不保证产生原生 session ID，因而初始化成功后只允许提交唯一的首次任务输入；收到实际 SessionStart 或原生消息中的 ID 后才记录身份。恢复历史通过带私有 `CLAUDE_CONFIG_DIR` 的只读 SDK 子进程读取，避免读到 Controller 父进程的全局会话目录。独立 Test Session 的原生设置和认证继承现有配置。Task Worker 新建原生会话沿用后台任务的 full access 策略；恢复会话保留已经确认的原生设置，不覆盖网页选择。网页权限操作必须经过当前 capability 和原生确认。

### Codex 重试与错误详情

Codex adapter 在通知边界解释 `ErrorNotification.willRetry`，并保留 thread/turn 归属。匹配当前原生身份且严格为 `true` 时映射 `native_retry`；明确终止映射 `native_turn_error`，缺失、非法或不可可靠关联的信息映射 `native_error`。明确属于其他 thread 的通知不进入本 Session。通知本身不改变 `activity` 或结算等待者；原生 `turn/completed` 仍独立拥有轮次结果，失败终止即使没有先行 error 通知也须保留诊断。

表示复用已有 `kind: error`、有界字符串 `code` 与 `message`。`message` 保存 JSON envelope，包含可读 `message` 和有界原文 `details`，先限制内容再序列化，避免切断 JSON。Controller、Go 解析器、Web 和归档沿用现有严格字段集合，不增加 severity 或重试状态字段。每条重试保留为历史通知，不推测网络恢复；最终错误按同轮次身份合并，保留先行通知诊断。原生协议依据与取舍见[重试通知决策](../../.agents/notes/implemented/bug-fix/2026-11-05-codex-retry-diagnostics.md)。

Web 的共享 Timeline 用中性重试通知、终止告警和未知告警区分语义，摘要与原文详情分开。原生 `<details>` 默认折叠，详情保留传输中的完整有界 message 及 code。旧 JSON 只提取可读摘要，不能根据 `Reconnecting` 或断流错误类型降低严重度；不可解析内容显示安全摘要并保留原文。此呈现同时用于实时事件、重连历史读取与归档，不更改条目身份、修订、草稿或读取游标。

Codex 投影将原生 `sleep` 映射为已有 `tool_call`，名称为 `clock.sleep`，实时开始与完成分别使用 `running`、`completed`，历史读取复用完成路径。条目 ID 由原生会话和 item ID 生成。有限正数 `durationMs` 转换为秒并标注请求时长，其余值使用普通等待说明；不生成工具输出，也不从请求时长推断实际耗时。该处理复用现有工具行与归档格式，取舍见[等待投影决策](../../.agents/notes/implemented/bug-fix/2026-11-03-codex-sleep-timeline.md)。

Codex/Claude 原生 user message 的 clientId 或 UUID 可证明某条持久输入已被接收。仅匹配已记录的输入 operationId 时，才把 dispatching/unknown 提升为 provider_accepted；空闲、文件出现或连接成功均不能证明输入受理。恢复不重放结果未知的操作。原生 turn 结果、Task 完成和 cleanup 完成具有各自独立的确认条件。

Codex 原生进程意外退出、Claude SDK 意外 EOF 和 Copilot runtime 失联均进入 fatal 路径：撤销写能力，保留未确认操作，通知 Controller 清理 provider、relay 与 IPC 后退出。Task worker 独立确认旧进程停止后才按预算恢复原生 ID；独立 Test launcher 则停止并保留失败事实，不创建替代会话。

Codex 和 Copilot 仅在活动 turn 匹配且原生能力允许时执行 steer；Copilot 使用 SDK `send({mode: "immediate"})`，不能改用 queue 冒充当前 turn 追加。Claude 仅在原生协商支持 msg_lifecycle_v1 与 interrupt_cancel_queued_v1 时提供 steer，以输入 UUID 跟踪 queued、started、completed、cancelled；中断请求包含 cancelQueued 并核验被取消输入。缺少协商能力时运行中普通发送保持禁用。审批、问题和 form 的响应携带 interactionId、revision 和原生请求身份。Codex 等待原生请求 resolved 通知；Claude 等待 matching tool result，elicitation 等待相应 turn 成功结束。SDK callback 返回仅表示响应已交给 SDK，不能立即标记原生 confirmed。超过等待期限的响应保持 unknown；随后原生 resolved 证据仍可按原交互身份将对应 journal 操作补记 confirmed 并发送迟到回执，不再次响应原生请求。

### 角色指令的共享传递

launch ticket 与 `ProviderOptions` 使用同名可选 `instructions`，共享要求见[角色指令契约](../spec/controller-role-instructions.md)。严格解析器只在字段实际存在时允许该键，并检查非空白、良构 Unicode 与 64 KiB UTF-8 上限；返回原对象，不为旧 ticket 注入默认值。既有 canonical payload hash 自然包含提供的角色文本，省略字段的旧 hash 不变；私有 ticket 的不可覆盖写入继续绑定整份启动内容。读写共用 6 MiB 序列化预算：保留原 5 MiB 空间并容纳角色的 JSON 转义。writer 在落盘前检查实际编码字节数并写入同一串内容，reader 在读取前检查文件大小，避免角色与初始输入单独合法但组合文件不可读。

runtime 从已读回 ticket 条件构造 `ProviderOptions.instructions`，新建和恢复共用此路径。无角色时完全省略该 options 键，model、args、native home、CLI 环境与 unattended 选择沿用原规则。`initialPrompt` 仍是唯一初始化发送来源；独立 `initialInput='none'` 使用空 prompt 和 `not_required`，IPC 拒绝提交初始化操作。

生成新 generation 的生产者负责携带已冻结的原文。journal 保存整份 ticket hash 和原执行/停止/native 身份，不增加角色副本或角色变更机制；它不能独立判断生产者是否在两代间换了模板。Bot 的版本化模板、首次准备与服务端冻结不由这个共享层承担。三种 Provider 的原生追加映射也有各自实现与运行验收；共享透传不宣称原生追加或完整 Bot 托管已经可用。取舍见[角色传递决策](../../.agents/notes/implemented/architecture/2026-11-04-controller-role-instructions.md)。

### Codex 原生角色映射

Codex 适配器在 `thread/start` 与 `thread/resume` 共用的参数构造中，仅当 `ProviderOptions.instructions` 存在时设置 `developerInstructions`，不改写原文，不设置 `baseInstructions`。使用独立的 developer 层可保留原生基础提示；Codex 会以提供的文本覆盖该层配置，并不会自动拼接已有的 `developer_instructions`。新建仍按既有条件选择 model、sandbox、approvalPolicy，恢复仍使用原 threadId 与 excludeTurns；CLI alias 和 native PATH override 保持在原 config 合并路径中。角色本身不调用 send，也不改变首个真实用户请求的 effort 选择。

角色拒绝沿现有初始化错误路径处理：等待 close 关闭 owned child 和 RPC 后传播原生错误，不重试无角色启动。stdio 夹具记录真实管道请求，检查 start/resume 参数、缺省语义和用户 turn 边界，并通过子进程 close 与标准流销毁验证拒绝后的清理。该夹具不证明真实 Codex 已接受或执行角色；运行验收另需固定原生版本与真实会话证据。取舍和固定参考见[Codex 角色映射决策](../../.agents/notes/implemented/feature/2026-11-04-codex-role-instructions.md)。

### Claude 角色追加

Claude adapter 在新建和 resume 共用的 `query` options 中，将存在的 `instructions` 映射为 `systemPrompt: { type: "preset", preset: "claude_code", append: instructions }`。preset 保留 Claude Code 原生基础提示，append 接收完整原文；没有角色时不设置 `systemPrompt`。角色不进入 `InputStream`，因此初始化无需构造用户需求或创建 turn。

此映射独立于 `sessionId`/`resume` 选择及新建时的 model、effort、permissionMode、sandbox 配置。恢复前仍验证历史的原 native identity 与 cwd，恢复时不覆盖已保存设置。审批仍等待 matching native tool result，初始化异常继续关闭 query，流丢失继续使未确认操作保持未知。适配器不拥有角色冻结存储；调用者负责提供同一冻结文本。选择依据见 [Claude 追加角色决策](../../.agents/notes/implemented/architecture/2026-11-04-claude-role-append.md)。

### Copilot SDK 与私有 runtime

Copilot adapter 固定使用 `@github/copilot-sdk` 1.0.11 与随包安装的 `@github/copilot` 1.0.105。Controller 直接 spawn CLI 对应平台 binary 的 `--headless --no-auto-update`，避免 npm launcher 的同步包装进程遮蔽真实 PID。随机连接 token 通过私有子进程环境传入，SDK 以 `RuntimeConnection.forUri` 连接该进程的 loopback TCP endpoint；这条连接既不共享其他 runtime，也不承载 TUI。真实 child 经 `onSpawn` 登记进程身份，继承 Controller 的 POSIX 进程组或 Windows Job 约束，沿用统一停止证明。

角色通过 create/resume 共用的 `SessionConfig` 传递：仅当 `ProviderOptions.instructions` 存在时加入 `systemMessage: { mode: "append", content: instructions }`。SDK 的 append 保留 CLI 基础提示，角色不进入 `native.send`。省略角色时不设置该键；字符串校验与冻结由[共享角色契约](../spec/controller-role-instructions.md)拥有，适配器不裁剪或重新渲染文本。新建仍只传显式 model/effort，恢复仍先核对原生身份、目录与占用，再按原 ID 打开，不覆盖既有原生设置。角色配置失败沿既有启动异常路径关闭 owned runtime 并传播错误。取舍见[Copilot 角色追加决策](../../.agents/notes/implemented/architecture/2026-11-04-copilot-role-instructions.md)。

Copilot runtime 的 `--allow-all` 与 Session 的工具审批开关不能证明 SDK Session 已获得完整路径和 URL 权限。新建无人值守 Worker 会话调用原生 `permissions.configure`，明确设置 `approveAllToolPermissionRequests`、`approveAllReadPermissionRequests`、`paths.unrestricted`、`urls.unrestricted` 为 true，并要求成功确认后才能就绪；失败保持显式错误。独立 Test 新建与所有 resume 不调用该完整策略配置。当前 Chatbox 的工具审批设置不代表路径或 URL 权限，也不声称能读取完整全局授权模式；SDK 类型中存在的方法不能替代运行时能力验证。权限 callback 继续走原生交互，不逐项自动批准来弥补初始化错误。

`COPILOT_HOME` 在 launch ticket 中冻结并传给原生进程。未指定 model/effort 时不传对应 SDK 字段；显式 effort 仅接受 `low|medium|high|xhigh`。创建会话后核对 snapshot 的 session ID、working directory、remote 与占用状态；恢复还先核对 metadata 的精确 ID/cwd 和 `checkInUse`，拒绝来源不匹配或已有 writer 的会话。历史与实时事件复用稳定原生条目身份投影，初始化期间缓冲实时事件，避免历史覆盖新内容。

发送只有 SDK 返回有效 native message ID 才取得原生 ACK。同一活跃 provider 内，超时调用的原 Promise 迟到返回该 ID，可通过它捕获的 operationId 精确补记受理。SDK 不支持把 caller operationId 写入可用于恢复对账的原生输入：ACK 永久丢失或原进程已丢失时，历史中的相同正文、idle 或新连接均不能消除 unknown，也不能跨 generation 用迟到结果确认或自动重发。foreground cancel 使用 `interruptMainTurn`，等待原生活动结束证据，不将整个 session 的销毁冒充停止 turn。

审批、问题、MCP form 和计划审批共用现有 typed interaction。callback 返回不等于请求完成；响应保持原生请求身份并等待 matching completed 事件。计划审批 form 保留 `exit_only`、`interactive`、`reject` 及可选 feedback，禁用 autopilot；未知 schema、URL elicitation 和不支持的二进制资源投影为明确错误。原生 `immediate` steer 和这些交互的真实运行效果须分别验收，协议可解析不构成验收结果。

`forUri` 对 SDK 表示外部 runtime，因此仅调用 SDK transport stop 不能履行 Controller 的进程清理责任。关闭先向自己拥有的 runtime 发送 `client.rpc.runtime.shutdown`，再有界关闭连接；超时执行 TERM/KILL，并等待真实进程退出。无法证明停止时继续保留执行责任。 原生进程退出或 transport 健康检查失败时，Copilot 先将未完成操作保留为 unknown，再通知 Controller 关闭 provider、relay 与 IPC 并退出；worker 独立确认旧进程边界停止后，按恢复预算用原生 ID 进入下一代。初始化期间的失联先记录失败，取得 provider handle 后再清理，避免 startup 与 shutdown 互等。

依赖声明的窄修补由锁文件和 `patches/` 固定：SDK 的 `SessionDeletedEvent.metadata` 使用 `metadata?: never` 表示该事件不带 metadata；`vscode-jsonrpc` 的 `LinkedMap` 删除与现代 `Map` 接口不符的 `implements Map` 声明。修补不改变运行时代码，也不启用 `skipLibCheck`。`koffi` 固定 3.3.4，使用已发布的平台预编译包并设置 `allowBuilds: false`；不依赖安装脚本另行下载或编译。选择原因与升级条件见[Copilot SDK 决策](../../.agents/notes/implemented/architecture/2026-10-28-copilot-web-sdk-runtime.md)。

### 会话设置与原生命令

可选 controls 随 Controller state 进入本机持久快照和服务端有界内存状态，包含 revision、setting descriptors、命令目录和目录错误。setting 的 value 是原生确认值，category 区分 model/reasoning/permission，scope 区分 session/next_turn。描述内容变化递增 revision；同版本不同内容和倒退版本被服务端拒绝。执行换代清除旧 controls 与 turnStartedAt；新 Controller 从本机持久 snapshot 与未发送 outbox 的最大版本延续 controls revision，避免旧状态重放后将新目录误判为倒退。

update_setting、execute_command、refresh_controls 复用现有操作持久化、Submit/Poll/begin 授权与回执。前两者绑定 expectedControlsRevision；命令还绑定 expectedTurnId。Controller 在实际 native 调用前再次重验目录、参数和状态，并串行处理设置/命令/发送；中断和交互响应绕过该队列。等待原生 ACK、设置事件或回读期间保留原值，超时 unknown 不重放；明确关联 operationId 的迟到确认可补记原回执。

Codex 动态读取 model/list、configRequirements/read，以 thread/settings/update 和设置通知确认会话设置；当前 turn 模型变化还取决于原生 live setting 支持。命令映射 compact、已发现的 skills 和受限读取的自定义 prompts。Claude 读取 supportedModels/commands，经 setModel、setPermissionMode 和可用的 effort 设置/回读确认；完整模型 ID 只有与原生 catalog 的 resolvedModel 匹配时才映射回别名，default 保留原生默认语义。Copilot 使用 model RPC 与 setApproveAll，model deferred 等待实际当前值；tool approval 不扩大为路径/网络策略。Copilot 启动时按工作目录查询原生 getDiscoveryPaths 并传入 skillDirectories，只展示 enabled 且 userInvocable 的命令；启动目录发现失败单独显示 commandsError，普通聊天仍可用；目录由创建原生会话时传入，当前实例的 refresh_controls 不能补传启动目录，需要重新创建 Controller 后恢复发现。恢复时不使用旧启动参数覆盖当前原生设置，无法核实的值保持未知。

Web 将 setting intent 按用户、执行与 operationId 保存，展示 pending 目标和原生实际值；确认前不乐观替换实际值。命令目录在 / 菜单中提供过滤、键盘选择和参数，model/permissions 为本地打开设置面板的保留入口。SessionComposer 对提交和发送按钮采用同一完整名称分类：零匹配使用 sessionSendGate 与 send_message，一个匹配进入命令路径，多个同名匹配保留歧义错误。前缀过滤只提供候选，不决定操作类型；client.send 不因正文以 slash 开头而拒绝，既有身份、执行、能力和待确认操作校验保持不变。

设置与内置命令文案由 Web 的 Session 消息目录按当前语言呈现。设置名和说明以 Provider 与稳定 setting ID 定位，权限选项以该设置内的 value 定位；模型与原生 effort 标签原样展示，Claude 的 `default` effort 选项使用内置原生默认值文案。未知项回退下发原文。pending 提示中的已确认值使用同一选项映射。翻译只在渲染时应用，不改写 controls、revision、setting intent 或命令目录签名，因此语言切换不清除命令选择与草稿。旧格式不带命令说明来源；内置说明及缺省说明按 Provider、已知命令身份和精确英文文案识别，其他文本保持原样。兼容限制及取舍见[设置文案本地化决策](../../.agents/notes/implemented/bug-fix/2026-11-06-session-controls-localization.md)。

菜单的默认高亮与明确候选选择分离，直接 Enter 不消费仅前缀匹配的默认项。临时候选随输入、目录和菜单生命周期变化重置；目录按 revision、错误及命令字段的稳定签名比较，等值快照重建 controls 对象不清除明确选择。显式选择带参数命令产生独立的 commandId 与命令头意图，参数编辑、目录刷新和菜单关闭保留它，修改命令头、清空草稿或切换 Session 才清除。提交使用当前 controls revision 验证同一 ID 与完整名称，不能冻结旧 revision，也不能在移除、替换、不可用或歧义后退回普通消息。原生命令草稿仍沿用 revision 与受理回执绑定；execute_command 的拒绝、失败或 unknown 不调用普通发送路径。运行中目录查询错误通过 refresh_controls 重新读取；只读与失效投影深拷贝后关闭 mutable/available，不能改写持久能力。没有命令目录时，普通消息仍由原有发送权限决定。

已核实的排队取消使用 input_cancelled，主动中断只有在成功原生 ACK、输入 UUID 匹配且 terminal_reason 为 aborted_streaming/aborted_tools 时使用 turn_interrupted。Web 将这两个终止诊断显示为中性状态；其他诊断仍是错误提示，不能仅凭用户点击中断或错误文本掩盖原生故障。

新 server/Web 能读取没有 controls 的既有 Controller；这些会话不提供新控制目录。旧严格客户端不保证识别新增字段，更新顺序为 server/Web 在先，新 Controller 在后，不强制重启用户现有原生会话。

## Relay 与恢复

Task Session 的 current/history、归档、capability、Controller grant、排队命令和浏览器 channel 共用项目准入：先核验当前凭据，再在调用方的 `store.SessionScope` 中通过 `SessionDAO` 读取项目权限。canonical 单语句合并当前 owner Team role 与 direct grant role，读取最大有效角色和真实可空 direct grant，不读取用户展示资料。无准入返回既有 forbidden，其他数据库错误保留错误链。项目准入不持有跨到事务提交的授权来源行 share 锁，也不引入 Thread 的长期 ownership 锁；Task、Session 和凭据的原有锁序保持。admin 或 Session owner 的控制资格、Controller owner 限制和独立 Test Session 的本人边界仍分别检查。

派发前按原始 requester 重新准入，不借用 Controller 的角色。在线内容在网络等待前后重验；浏览器 channel 每 250ms 重新检查项目准入与执行身份，失权后关闭连接。准入不缓存到 capability、Session 身份或归档索引中。

Controller 以短期 grant 建立 WebSocket，浏览器通过项目会话权限建立另一条 WebSocket；命令和历史也有 HTTP 接口。bootstrap grant 有效期 120 秒，reconnect grant 为 15 分钟；launcher 在首次 spawn 前将 bootstrap 换成可复连凭据，避免首次连接后短暂断网必须等待续签；grant 冻结签发凭据归属，撤销父凭据会使现有连接失效。服务端每次操作核验项目权限、claim、executionGeneration 和连接 fencing，不将浏览器传入的 native ID 当作授权。Controller 在 WebSocket 升级前先验证 grant、父凭据与 active scope，收到 hello 后在 Connect 事务中重复验证并消费凭据；握手预检不能替代原子 fence 校验。连接配额包含正在升级的请求，失败升级释放预留名额，伪造或失效 token 不能先占用 WebSocket。

Task Worker 的 grant 维护每 30 秒独立扫描当前服务的未完成 Web 执行，在凭据剩余不超过 120 秒时续签，不受 claim 发现的 pollIntervalMs 影响。维护过程验证 launch ticket 与原 claim、Controller、execution generation 一致；prepare、launch 和续签按执行串行，读取最新执行记录后才写入凭据。退出先取消并等待维护结束，再关闭执行存储，避免后台续签访问已关闭的数据库。续签失败保留原执行和凭据事实，并通过 worker diagnostic 暴露。

原生调用前，Controller 先持久记录操作，再请求服务端 operation_begin 授权，获准后写 dispatching 并调用原生。数据库仅保存 operation 身份、类型、正文哈希、操作者、执行约束和无正文的回执摘要；完整命令、原生结果和错误详情由 Controller 本地保存。服务端只在当前在线连接的有界内存中暂存命令。accepted 表示 relay 暂收，不保证持久排队；网页保留草稿，直到原生明确受理或确认。尚未送达 Controller 的正文在服务重启后不可从哈希重建，原操作按实际证据拒绝、过期或保持 unknown。已 offered 但尚未 dispatch 的操作如果因状态或权限变化失去授权，服务端持久化 rejected 并返回 receipt_ack，只拒绝该操作，保留当前连接。Controller 记录拒绝并拒绝对应 authorization 等待，不调用原生；迟到回执与重连对账仍按同 operation 身份收敛。已 dispatching 的不确定结果、内部错误或失效 Controller fence 不走这个拒绝捷径。重连以最多 100 条一批对账，最后一批带 final；整个对账完成后还需同步当前本机状态，才能启用新命令。重复 operationId 必须保持相同内容，断线或超时不能触发自动重发原生输入。

### 启动观察的独立上报

Controller journal 的可选 `startup` 保存 typed state/reasonCode。Provider 边界将 NativeRpc、Copilot SDK 的远端 RPC 拒绝及 Claude SDK 的结构化 initialize 拒绝规范化为明确拒绝；SDK 本地产生的写失败、连接关闭与超时仍保持 unknown，不能只凭 Error 类型或错误文本推断失败。运行时只有在 Provider 打开、进程证明及初始化错误检查完成后才记 ready。Copilot 启动失败时使用 SDK 公开 forceStop 先释放传输，不再向失败连接发送 session.disconnect 或 runtime.shutdown；自有进程仍执行原有终止与退出确认，正常关闭保留 graceful 流程。初始化后的清理失败只增加本机诊断，不覆盖原始启动分类，也不构成停止证明；已完成启动后的失联不重写启动历史。旧 journal 缺字段时保持 unknown，不从 native ID 或 activity 推断结果。

Worker Web 执行 JSON 保存可选 `startupReport`，包含 `schemaVersion:1`、`source:worker`、sessionId、claimId、executionGeneration、controllerInstanceId、revision、observedAt、startup 和 recovery。完整本机身份校验先于观察；同代际语义变化递增持久 revision，观察不变时保留原时间，换代清除前代报告。独立编排阻塞经完整原归属和实时健康验证解除时，清除与新的报告 revision 原子提交，即使原生 startup/recovery 组合未变也留下此次确认。普通 Git 或编排等待不写为 native recovery blocked；既有 waiting phase 和本机编排原因承担其诊断。recovery 的 none/null 与 blocked/稳定原因码分离表达。JSON 新字段是可选向前读取扩展；旧严格二进制不支持读取新增字段，不能用删除本机记录绕过降级限制。

既有 `session-capabilities` 的 `startupReportVersion:1` 确认上报支持。Worker 在独立摘要阶段通过 PATCH worker-claim 的可选 startupReport 写入，只读 task property `sessionStartup` 保存其结果。原任务 CAS 和 owner 校验后，以 task→Session 锁序检查当前 Session、generation、Controller instance、Worker、worktree 与 active 生命周期。相同 revision 同内容幂等，较小 revision 或同 revision 异内容拒绝。新 claim 清除旧属性，普通属性修改不能伪造或清除报告。

current 请求显式发送 `X-Daynight-Startup-Version: 1` 时，registered 响应附加顶层 startupReport；无当前匹配报告为 null。无该 header、未注册及不适用响应保持原形，Session snapshot、Controller 消息、事件和归档不扩展。旧 CLI/Web Task parser 可忽略独立 property，严格 properties.worker 形状不变。新 parser 校验报告与同响应 Session 的四项身份；旧服务缺字段按 unknown 消费。全部 Go 服务实例必须先升级再启用新 Worker；旧 Go 属性白名单不能读取新增持久属性，不支持混跑或直接降级读取。下游从公共纯模块 `session/startup.ts` 获取严格类型、解析器和安全摘要映射。

状态组合限定为 starting/initializing、ready/ready、failed/native_rejected 或 controller_launch_failed；其余 evidence_missing、native_timeout、native_transport_unknown、controller_start_unknown 均为 unknown。blocked 的原因是 native_identity_missing、recovery_limit 或 recovery_blocked。无自由文本错误进入报告，私有原始诊断继续由 Controller/Worker 本机保存。

observedAt 是观测发生时间，不是心跳。读到未来时间或超过 90 秒的 starting 时，消费者显示待确认；该保守降级不改变已保存事实或恢复授权。ready、failed 及具体 unknown 是本代历史结果，当前在线状态仍由 Session 与既有 Worker 新鲜度表示。服务端按 revision 排序，时钟回退不允许旧结果覆盖新修订。独立摘要失败不计入原生恢复预算，下轮完整库存读取实际任务版本后重新判定是否写入。

### 本机内容与在线读取

活跃 Session 的内容归属于 Agent 执行环境，要求对应 Controller 在线且本地数据存在才能加载历史。这里的执行环境可由容器或 sandbox 承载；普通 worktree 本身不具有安全隔离能力。Controller journal 保存原生身份、完整操作记录、投影修订索引和有界 outbox。标准化 timeline 与资源保存在 journal.sqlite.pending-content/，每个条目使用独立原子文件，替换前 flush 文件、替换后同步目录；内存索引提供在线分页。Timeline entryId 源于原生条目身份，entrySeq 首次插入时分配，revision 单调维护；ACK 只清除传输 outbox，不清除待归档源。原生 transcript 可以辅助恢复，但不能补齐所有实时审批、错误或 Provider 临时事件，不能替代标准化事件录制。

sourceEpoch 和整数 sourceSeq 标识传输顺序。outbox 的 64 MiB 上限只限制等待发送的数据；内容文件先可靠写入，再提交 SQL 索引与投递事务；超限时压缩传输积压并记录 sourceFloor。新连接以该下界跳过已舍弃的传输事件，重置展示 historyEpoch 并重新同步。网络积压不再暂停原生输入或停止健康 Agent；本机持久化失败仍须暴露，并停止无法可靠记录的执行。操作日志不参与 outbox 压缩，不确定输入不得因此重放。

Controller 每次连接先分批 reconcile，排空剩余 outbox，再发送 sync_state，内容为当前状态及最多 100 个待处理交互。服务端收到后返回 sync_ack，完成前禁止网页控制。executionGeneration 隔离原生实例，connectionEpoch 隔离连接；historyEpoch 标识可用展示缓存，改变时网页重新读取本机内容，不创建或恢复另一段原生执行。

历史 HTTP 请求经过权限校验后，经 Controller WebSocket 转发 content_request。Controller 按本机稳定条目序列分页，返回内容捕获时的 sourceThrough；该点之前的事件先获 ACK，随后发送 content_response，再发送较新的事件。服务端在处理响应的同一有序事务中捕获 lastEventSeq，不能改用等待结束后的较晚水位。分页游标绑定 Session 与 historyEpoch。每页最多 200 条，并按 WS 帧大小进一步截断，前后游标表示实际返回边界。

Session 的 HTTP、WebSocket、嵌套 timeline/content 编码与展示缓存统一使用不转义 HTML 字符的 JSON 表示。内容只作为 JSON 或 WebSocket 文本提供，不嵌入 HTML。Controller 预算还计入 Go 对 U+2028/U+2029 的转义；持久操作和源事件的哈希仍保留原编码，避免重试同一操作时改变内容指纹。

Poll 使用相同的 MarshalWire 编码计算 operation_offer 的完整封装字节数。单个 offer 超过 2 MiB 时，以 payload_too_large 终态拒绝原操作，释放暂存正文并继续后续队列；若仅当前批次累计超限，则将该操作留到下一次 Poll。HTTP 请求体通过入站上限不代表增加 offer 封装后仍可发送；不得截断输入或让永远无法发送的单个 offer 阻塞后续操作。

单条非交互展示投影的传输预算为 1,400,000 字节，给分页及帧封装留出空间。超过预算时，本机待归档文件保留完整投影，实时发送与历史读取统一返回 display_budget_exceeded 错误条目，保留原 entryId、entrySeq 和 revision。旧 outbox 也在发送前执行同一投影，并保留 sourceSeq，使源水位可以继续确认；不是跳过事件后宣称完整回放。带权限语义的 interaction 不采用此替换，完整交互和 controls 仍受总帧及内存容量约束，超限明确失败，不通过截断审批内容或自动批准获得同步。

资源以登记的 resourceId 读取，不能把任意本机路径转换为下载地址。每块最多 512 KiB，单资源最多 8 MiB；完整读取检查长度、SHA-256 及相同 Controller 连接身份。每个内容请求最多等待 15 秒，全服务最多 32 个、单 Session 最多 4 个在途请求。等待前后都检查访问权限，取消或迟到的响应不能污染另一请求或断开健康 Controller。当前 Provider 的图片/文件输入与不支持的原生二进制内容仍遵守基础交付边界。

### 完成后的文件归档

Controller journal v6 将旧 projection/resources 表导出到待归档文件，再在 SQL 事务中建立 content_index、删除正文表并升级版本。停止后的归档上传器先只读核对受支持版本和原停止身份，再使用与正常 opener 共用的格式定义，在同一 immediate 事务内完成 v2–v5 的结构升级和 v6 文件导出；迁移前拒绝活跃或不可确认的旧 writer，不获取 writer lease、不推进执行代次，也不启动原生进程。所有迁移入口向各步传递同一次事务的原始来源；若原来源为 v1 且存在旧执行，v6 持久设置 `archive_incomplete=1`。v1 没有完整 projection，outbox 可能已确认并裁剪；中间步骤新建的空 projection 不能证明历史为空。停止对账、快照或操作读取以及 writer 打开均保留该限制，上传器不能仅因当前版本已变成 v6 就接受不完整归档；正常空库初始化不被标为不完整。内容导出失败时 SQL 回滚到原版本，已可靠落盘的文件保留供核验重试；`006-pending-content.sql` 的结构转换、正文表删除、索引和 v6 版本在文件可靠写入后同一事务提交。迁移失败保留原表；文件先于 SQL 提交的更新在重启时核验并触发完整 relay 重同步。缺文件、回退的 revision 或内容 hash 不匹配须明确失败，不把损坏源解释为空历史。索引和传输积压的裁剪不能删除归档内容。

确认原生进程停止后，上传器从同一执行的待归档文件生成 schemaVersion=1 的 SessionArchive：包含 Session fence、Controller 身份、Provider/nativeSessionId、有序最终 entries 和资源描述及 base64 数据。它保留最终阅读内容而非逐 token 事件录像。Task 结束由 Worker 收尾上传；Test launcher 先确认服务端 /stop，再上传。独立上传失败可运行 controller <provider> archive <test-session-id>，以原私有 ticket 和停止证明对账后重试；该路径不启动或 resume 原生会话。上传不启动 Provider，不要求已删除的工作目录存在。Worker 每轮最多尝试一个旧 completed 执行补归档，进程内按上次尝试的执行 ID 轮转库存，成功或失败后都从下一项继续；各执行独立退避，单个损坏源不能阻塞其他历史。正常收尾只有 ready 才能删除 worktree；退出停止路径以本次 shutdown 调用意图为准，确认停止后不执行归档或删除，即使持久状态已是 terminal。原 terminal 状态仍保留，重启后的正常对账继续履行归档与删除责任。

Task 路径为 /api/v1/projects/P/tasks/T/sessions/S/archive，Test 路径为 /api/v1/test-sessions/S/archive。GET 返回 pending/ready/failed/unavailable；POST 记录 pending 或 failed；PUT 上传完整 JSON；GET /archive/content 读取正文。ready 回执含 SHA-256 和十进制 byteLength。上传按原始请求字节计算哈希，相同正文重试幂等，ready 后拒绝不同正文覆盖。写入要求原 owner 的有效 PAT、原执行 fence 与 Controller 身份，以及终态执行；若断网导致服务端尚未记录 nativeSessionId，可在提交 ready 的同一事务中从归档建立该身份，已有非空 ID 必须相同。加载 Session 时，持久化 Identity 与生命周期、initialInputState 一样优先于实例内 live cache；其他实例的旧缓存不能覆盖归档建立的原生身份，draining 到期保存也不能将其回退。读取要求对应项目成员或 Test owner 的有效访问权，不能用旧 claim 归档获得新执行的控制权。

Task 软删除保留原 Session 的归档收尾能力：仅原 owner 的有效 PAT 且仍为项目成员时，可查询归档状态、更新状态和上传；POST/PUT 仍验证完整 fence 和 Controller 身份，PUT 仍要求终态及原生身份一致。GET 状态不携带请求 fence，不授予执行权限。归档事务先锁定 task，再验证凭据和成员，最后锁定 Session；删除事务锁定同一 task 并冻结 Session，双方按此顺序串行。普通任务、Session 控制和归档正文读取继续拒绝软删除对象，浏览器及其他成员不能使用收尾例外。凭据失效或成员资格撤销仍明确拒绝，Worker 不能将拒绝当作上传成功后清理源。

完整 JSON 最多 64 MiB、100000 个条目、1000 个资源，单资源最多 8 MiB。条目身份唯一且 entrySeq 严格递增；资源引用必须存在，available 数据须符合长度及哈希，pending 资源不能封存成完整归档。超限和缺失明确失败，保留本机源；不裁剪后宣称完整。归档源及上传回执位于原 execution 目录，上传失败只重试文件传输，不重放业务输入。

网页在 draining/archived 时停止 live 通道与所有操作，按归档状态展示等待、失败或只读 timeline。ready 内容通过原 Session View 渲染，资源从校验后的归档读取；不显示 chatbox，不允许历史审批、中断或设置操作。服务端独立拒绝终态网页写命令，Worker 内部已授权 cleanup 通道保持独立。活跃断线继续原 live 恢复。正常终止上传不提供容器突然销毁前的远端备份，也不从原生历史猜补遗漏内容。

### 服务端归档布局

服务端复用 filestorage 保存新归档正文，`internal/core/model/sessionarchive.Namespace` 统一派生新归档写入与 Session 清理使用的物理地址：

| Session 归属 | `session-archives` 内的对象路径 |
|---|---|
| Task Web、Task Herdr | `projects/<projectId>/<sessionId[:2]>/<sessionId>/<sha256>.json` |
| 独立 Test、Bot | `users/<ownerUserId>/<sessionId[:2]>/<sessionId>/<sha256>.json` |

归属和 Session ID 必须是规范化非零 UUID；分片为完整 Session ID 的前两个十六进制字符，每个归属最多 256 个分片目录。`projects` 与 `users` 区分已有项目和用户的 UUID 域，完整 Session UUID 继续拥有归档目录，不随任务重新领取改变。目录组织不改变访问权限。PostgreSQL 的 `session_archives` 继续保存归档状态、对象位置、大小、哈希与枚举错误；读取沿用已保存的 `object_path`，不重新派生位置，也不根据目录布局拒绝对象。相同 hash 的 ready 上传沿用原幂等结果，正文读取仍验证大小、SHA-256 和归档结构。

既有 `session-archives/<sessionId>/` 文件及其元数据保持原状，现有对象继续按其登记位置读取。新路径只用于新归档写入和当前 Session 命名空间清理，不改变启动、读取、上传重试或控制逻辑，也不转换或修复存量数据。受限清理覆盖派生目录中没有 SQL metadata 的孤立对象，保留同 owner、同分片的其它 Session；旧布局对象不在该物理清理范围内，也不阻止当前目录清理完成。正文、SHA-256、长度、终态 receipt 和公开 URL 沿用原语义。取舍见[布局决策](../../.agents/notes/implemented/architecture/2026-11-05-session-archive-layout.md)。

本地文件存储在重命名前同步文件，发布后同步父目录。初始化存储根时，先打开父目录，再创建并同步新目录及其父目录条目；不能在不可读父目录下创建未同步条目。创建父目录时保留原路径组件的次序；相对路径只前置对应当前目录而不清理原始组件，然后解析符号链接，得到同步与 OpenRoot 共用的真实绝对路径。这样即使当前目录通过符号链接进入，也不会提前消掉链接后的 `..` 而改变存储位置。每次初始化在返回可写存储前同步实际根目录及所有可读祖先，即使目录已经存在，也不能依赖其他初始化者已经完成同步。仅非根祖先的打开权限错误可以跳过，跳过后继续向上同步；根目录打开错误、实际同步错误及其他 I/O 错误均明确失败。初始化失败保留已创建目录，包括空目录：另一个实例可能已打开它但尚未写入，创建者没有独占删除权。再次初始化仍须完成祖先同步屏障，不能将目录存在视为持久化完成。文件可靠写入后才提交 ready，数据库事务失败可重试同对象；读取时重新验证对象大小、SHA-256 和归档结构。PostgreSQL 不保存消息正文。正文及数据库元信息需要一起备份；多实例读取要求共享文件存储。

### 服务端存储与容量

PostgreSQL 保存 Session 归属、注册身份、授权、原生与连接代次、生命周期、水位和最小操作账本。不写入时间线、消息、工具输出、资源、动态 controls、待审批正文或自由文本错误；操作正文也不藏在 command 或 snapshot 中。既有内容表和历史行不自动删除，当前实现停止向其中新增内容；既有备份或历史行的清理由运维单独决定，迁移不会宣称已擦除旧数据。

服务端的每 Session 内存状态最多 4 MiB，其中最近事件缓存最多 2 MiB、1000 条。缓存丢失返回 reset_required，从在线本机重新加载；活跃执行不使用终态归档替代同步。最多 64 个 live Session，超额明确拒绝接入，不代表实测并发能力。每 Session 最多保留 4096 条持久操作摘要，达到上限拒绝新操作；不能简单 TTL 删除 unknown 或去重记录后重新执行旧请求。Session 身份仍随创建数增长。

在线状态由持有 Controller 连接的 relay 实例维护。另一实例不能凭共享数据库假装拥有会话内容，也不能抢占仍有效的连接租约；请求需要路由到持有连接的实例，未满足时明确失败。服务端重启后 Agent 继续在本机执行，重新连接、授权和状态对账后恢复网页操作。数据库事务成功后才发布对应内存状态；失败事务不能先向浏览器确认尚未提交的控制结果。

活跃 Controller 离线时，新页面只能读取有权限的身份与离线状态，不能加载历史或操作。已打开网页保留当前离线画面；重新同步成功后替换过期内容。终态页面按下述文件归档协议读取。独立 resume 在新的在线执行中从原生本地历史恢复，与旧页面的只读归档分离。

响应操作按 interactionId 与 interactionRevision 限制同一交互的重复提交，不能按整个 turn 或 interaction_response 类型互斥。工具审批等待 tool_result 确认期间，同一工具提出的新 MCP form 必须可独立响应。浏览器只持久保存 operation 与交互身份的关联，不保存答案；缺少旧缓存时，服务端当前在线交互校验和 Controller 原生校验仍决定能否响应。

Chatbox 的只读兜底提示与发送门禁分开：`waiting_input` 中存在 pending 且通过 `sessionRespondGate` 的交互时，不因 `sessionSendGate` 为 false 显示只读。同步、待确认操作和首次输入提示仍先判断。`SessionTimeline` 从当前可显示条目中筛选可回答请求，`usePendingInteractionLocator` 观察卡片与时间线的几何交集、滚动、尺寸和本地回答状态；部分可见的大卡片不要求完整容纳在视口中。定位入口与“最新”共用底部导航区域，标题保留原生内容，入口前缀随页面语言变化。定位暂停跟随、更新阅读锚点并聚焦卡片，不发送回答；卡片本地提交或完成后，即使远端 pending 快照尚未更新，也不保留定位入口。实现取舍见[等待交互定位决策](../../.agents/notes/implemented/bug-fix/2026-11-06-pending-interaction-navigation.md)。

## 原生正文的显示转换

Controller 的 `ProviderOptions.onTimeline` 在调用 `journal.projectTimeline` 前通过 `providerDisplayEntry` 生成显示副本。Codex、Claude、Copilot 的实时事件和原生历史重放均经过这个入口；转换位于 `parseSourceEvent` 之前，既有 `sessionDisplayEntry` 整条 wire 预算降级继续位于持久化投影之后。

转换仅遍历非交互正文的明确字段：user/assistant `content[].text`、`reasoning.text`、`tool_call.input` 与 `output[].text`、`error.message`、`compaction.summary`、`todo.items[].text`。条目、text part 和 todo item 按需复制，资源、身份、名称、状态、错误 code 和整个 interaction 保留原值。原生发送与响应参数不经过该转换。正常良构且无 NUL 的正文原样返回；异常段标注转义说明，将 NUL 与孤立 surrogate 写为字面 `\u0000` / `\uXXXX`，同段反斜线也转义，保留合法 Unicode pair、中文、换行和 tab。消息与 reasoning 的异常正文置于 fenced code block 内，确保 Markdown 消费者按字面渲染；正常正文继续使用原有 Markdown。围栏字符与长度根据保留内容中的 backtick/tilde 连续段选择，不能被正文提前闭合。

转义说明、转换正文和所需 Markdown 围栏合计最多 200,000 个 UTF-16 code units；无法容纳下一个完整 token 时追加既有 `[Output truncated at 200000 characters]` 提示，不能切断 escape token 或 Unicode pair；`tool.truncated` 合并原截断状态和新增截断。显示仍满足协议单文本 1 MiB 字节/字符约束，整条事件沿用 1,400,000 serialized bytes 的 wire fallback。显示转换不把成功工具改为失败；只有既有整条 wire 超限降级可以替换展示条目。

Provider 增量缓存保留未经此次转义的累计值，因此一个孤立高 surrogate 可暂时显示为 escape，后续低 surrogate 到达后重新从累计原值产生合法字符。转换后的副本落入 journal 和待归档文件，原生完整历史不变；恢复时可重新投影原先在持久化前被拒绝的条目，无需修改生产 journal。协议版本与存储格式不变，旧合法 journal 和 archive 沿用原读取路径。决策取舍见[原生显示文本决策](../../.agents/notes/implemented/bug-fix/2026-11-04-native-display-text.md)。

## Session View 的启动状态选择

共享 `presentation.ts` 在同一输入中组合当前快照、身份匹配的 startupReport、浏览器同步情况及请求错误。终态优先使用归档；无法验证当前状态的请求错误保留自身说明；恢复受阻组合保留原始启动分类，明确失败与 unknown 不互相覆盖。starting 的 90 秒新鲜度只影响呈现，界面在期限到达时重新计算，不将计时结果转为失败或恢复操作。正常原生活动保留英文标签，启动与连接诊断按 locale 显示。

Task client 为 current 请求协商 `X-Daynight-Startup-Version: 1`，使用共享严格解析器校验四项身份。独立观察定时器读取报告，保留同代最高 revision，不借更新报告重建健康 WebSocket。请求完成前再次验证账号、连接代次与执行身份；旧执行迟到的结果不能更新新执行。报告新鲜度不是在线证明；客户端只记录本页面亲见的同代连接，不以跨代不归零的 connectionEpoch 推断连接历史。Test 与 Bot 的共享视图允许没有 Worker 报告的健康快照。

历史请求使用 `liveHistoryAllowed`，要求 active、Controller connected 与 synchronized，且当前报告没有明确失败或恢复阻断。它不要求 startup=ready，因为原生初始化可能等待 timeline 内的合法审批。live tail 遭遇 controller_offline 时保留已读内容，并记住快照与历史身份，阻止同一证据下的重复请求；新证据或显式刷新才允许再核对。恢复可用后继续尾页和分页，归档始终使用原有独立路径。页头主状态、Composer 动作和空态使用相同选择结果；输入仍叠加原有发送、响应、设置和取消门禁。

安全原因使用稳定 reasonCode 的中英文固定映射，通过原生 details/summary 控件按需展开。真实权限或协议错误不会被状态归并吞掉。时间、HTTP 轮询与 UI 状态都不能授权原生重启、重新发送 assignment 或创建替代会话。决策和取舍见[启动状态呈现](../../.agents/notes/implemented/bug-fix/2026-11-05-session-startup-presentation.md)。

## Session View 的阅读与输入状态

浏览器将 scope/current 失效与 auth 暂停分开。身份待复核时最多保留 WebSocket 60 秒；新帧保存在最多 1000 条、合计 4 MiB 的内存缓冲中，不推进已消费 cursor 或发布新内容。HTTP 在途结果也等待复核，负面授权结果仍立即失效。确认同一身份后按原序消费缓冲，并继续原连接与历史；到期、缓存超限或真实断线则关闭连接，使用最后已消费 cursor 恢复。scope 撤销、principal 不符和执行失效不享受此宽限。Chatbox 与审批暂时禁用操作，但保留输入、阅读位置和连接呈现；只有实际失去同步才显示同步或连接提示。该策略继承[前台身份核验](daynight-auth.md)的账号隔离规则，不停止或重新创建原生 Agent。

Claude SDK 不保证实时回显提交的 user message。Controller 在本地派发时按 `operationId:0` 投影用户文本，与以后原生 echo/history 的稳定 ID 相同，避免重复行。这条本地展示不调用 `onInputObserved`、不验证原生身份、不确认回执；原生受理及恢复对账仍必须有真实输入或响应证据。unknown 状态下可查看提交原文，不能因该行存在重发或消除 unknown。

Task 与 Test 共用 `SessionView`、Session client、timeline 和 composer。`SessionMarkdown` 对消息和 reasoning 使用安全 Markdown，保留软换行，为每个实例生成脚注命名空间；只允许该实例生成的脚注内部链接，外链保留协议限制。工具文本用原始文本区域显示，参数和输出限高、可聚焦滚动，展开后才挂载内容。工具摘要从已有参数提取，不向模型补发请求。Copilot 投影去除相同的结果字段，保留不同结果与失败附带的错误/输出；工具状态取原生 `success`，不解释 shell 日志中的自由文本退出码。

`SessionView` 顶部及 `SessionActivity` 底部状态、composer 的权限入口和主发送/中断按钮、timeline 内建工具类型只读取消息模块导出的英语标签子集，固定文本局部标为 `lang="en"`。同一消息键在其他位置仍可本地化，例如操作回执中的 unknown、归档正文和交互卡 pending。组件不替换整份消息目录或重建语言 Provider，状态选择及操作 gating 沿用既有逻辑。具体语言取舍见[Session 英语操作标签决策](../../.agents/notes/implemented/bug-fix/2026-11-04-english-session-operation-labels.md)。

Codex 的 `subAgentActivity` 投影为 `tool_call`，以启动、交互、中断的操作名称和子代理路径呈现，保留原生 item 身份与子代理 thread ID。状态跟随父会话 item 生命周期，不表示子代理任务结果。浏览器通过共享纯函数 `legacySubagentActivity` 对旧 `unsupported_native_item` 条目验证精确前缀与 JSON 中的类型、非空 item ID 后，以相同操作名称和折叠元数据显示；旧错误没有完整 item 生命周期，因此不显示推断状态。解析失败或缺少必要字段的条目仍作为原始错误呈现。该兼容仅影响显示分类与渲染，不改写日志、归档或游标，也不读取子代理会话。选择理由见[子代理活动决策](../../.agents/notes/implemented/bug-fix/2026-11-03-codex-subagent-activity.md)。

`task-agent-session/display-mode.ts` 提供独立的 `SessionDisplayMode`（`standard | conversation`）、`DEFAULT_SESSION_DISPLAY_MODE`（`conversation`）和 `selectSessionDisplayEntries(entries, mode)`。selector 接受只读条目数组，按原顺序返回原条目引用，不修改消息 parts、修订、资源或 Session 状态，也不触发资源读取、网络及 Provider 操作。Standard 仅排除正文为空或全空白的 reasoning。Conversation 保留用户/助手消息的完整 parts、todo、所有状态的 interaction、真实 error（包括取消和中断）及计划工具；隐藏 reasoning、compaction、普通工具和被共享函数确认为合法旧格式子代理活动的 error。失败的普通工具仍按工具分类。

计划工具只按名称最后一个 `.` 分段精确匹配 `update_plan`、`TodoWrite`、`todo_write`、`EnterPlanMode`、`ExitPlanMode`、`enter_plan_mode`、`exit_plan_mode`、`TaskCreate`、`TaskUpdate`、`TaskList`、`TaskGet`；不忽略大小写、不去除空白，也不从参数或输出推断类型。所有 timeline kind 均显式分类，新增 kind 必须补充分类决定。分类理由见[显示分类决策](../../.agents/notes/implemented/architecture/2026-11-04-session-display-classification.md)。

`SessionTimeline` 的可选 `displayMode` 使用该 selector 派生可见列表；省略时保持 Standard 内部兼容行为。共享 `SessionView` 总是显式传入当前偏好，Task、Test 和可读归档的产品默认均为 Conversation，已有有效保存值优先。渲染仅挂载可见条目，隐藏工具及其输出资源组件卸载；保留消息、计划和交互使用稳定 entry key，资源索引、响应 gating、pendingResponse 与完整 SessionState 不变。切回 Standard 从已有条目恢复显示，不派发工具操作；资源仍按既有读取规则加载。

会话可用或归档已读且 Conversation 无可见条目时显示“当前对话模式下暂无内容”或“No content in conversation mode.”，Standard 保留原空态。`hasOlder`、加载中和历史错误独立于可见列表；可见条目不足视口时按历史加载策略补屏，连续隐藏页不表示历史耗尽。selector 不改写 cursor 或实时归并位置。

`SessionTimeline` 通过 `useSessionHistoryPagination` 使用实际 timeline viewport，结合用户上读意图与顶部预取区判断 `client.loadOlder` 的需求。预取区为距顶部不超过 `min(240, clientHeight / 2)` CSS px。控制器等待两个 `requestAnimationFrame`，让初始尾页定位、React 提交和锚定完成；`scrollHeight <= clientHeight + 1` 时允许不改变 following 意图的补屏。已经填满时，挂载、模式切换和程序化锚定不建立上读需求。顶部预取复用 `useTimelineScroll.pause/capture` 保存文字锚点，prepend 后由同一滚动所有者恢复，不叠加 scrollHeight 差值补偿。加载指示和错误/重试独立于条目列表，正常态与历史结束均不保留额外按钮或提示。

分页串行执行。client 发布 `historyReady` 表示当前在线尾页已准备完成，`historyRevision` 在成功发布尾页或更早页时递增，即使可见条目没有增加；`connectionGeneration` 标识客户端连接代次。控制器观察这些状态及实际 loading/error，在 React 提交与锚定后让出渲染，再检查视口是否仍需要下一页。`loadOlder` 捕获错误后也可能正常 resolve，因此 Promise 完成不是成功依据；全过滤页和只更新已有修订的页即使未改变高度，成功页状态仍驱动重新判断，不依赖新的 IntersectionObserver 交叉事件。

自动继续意图受 active、页面可见性、当前身份、认证、在线可读及历史就绪约束；失活、隐藏、鉴权暂停、断线、离开顶部阅读区和返回最新停止顶部续读。Session/history 身份、连接代次与卸载使旧的继续意图失效。client 对每个更早页请求保留所属身份、代次和独立 token，只有当前请求可以发布结果、错误或结束 loading；旧请求的迟到错误与 finally 不得清除新代状态。同一连接收到不同 historyEpoch、执行身份或 connectionEpoch 时也取消旧请求。重新连接并完成当前历史准备后，新的视口需求可以再次分页。

client 将 `beforeCursor` 视为不透明值。尾页与更早页在 `hasMoreBefore=true` 时均须提供非空游标；更早页的新游标还须不同于请求游标，且不回到本段分页已见的游标，否则发布历史读取错误并停止。成功尾页重新建立进展记录，Session 或历史重置清理旧记录。成功页按原规则合并资源索引和最新修订，合法空页不单独构成错误。`reset_required`、鉴权失效及归档完整读取沿用既有语义，不改变服务端分页协议。自动分页只由 Session 接入，共享 `useTimelineScroll` 不负责其他时间线的网络读取。取舍见[自动历史加载决策](../../.agents/notes/implemented/bug-fix/2026-11-04-session-history-autoload.md)。

滚动状态区分跟随和阅读。触摸起点仅用于检测上读方向，轻点不改变模式；非编辑控件的上读按键、旧内容焦点和脚注跳转可暂停跟随。宽度变化后优先按可见文本位置恢复，找不到该文本时退回稳定条目锚点。`SessionTimeline` 向共享 `useTimelineScroll` 提供 Session/history 身份、active、完整条目修订，以及独立的原始 key 顺序、可见 key 顺序和 mode。mode 不属于重置身份；切换保留跟随或暂停意图。锚点记录捕获时的原始顺序，条目被过滤后按原始时间顺序找最近前一可见项，无前项则找后一项，并定位其顶部；仍可见时优先恢复文字及相对位置。无可见项时保留暂停锚点，inactive 时不操作 viewport，恢复 active 后按当前可见顺序恢复。分页、ResizeObserver、流式内容和返回最新沿用同一滚动状态，不能用布局变化推断用户恢复跟随。共享 hook 的显示顺序参数可选，其他时间线调用方沿用既有接口。理由与限制见[显示过滤与阅读位置决策](../../.agents/notes/implemented/architecture/2026-11-04-session-display-reading.md)。

Session View 在选择最近 12 条可见回执前过滤无错误的成功操作：`confirmed`，以及 `send_message` / `execute_command` 的 `provider_accepted`。其他类型的 `provider_accepted` 仍等待最终确认，保留展示；任何携带 error 的回执均保留。没有可见回执时不挂载回执区域。过滤仅作用于渲染，client 的操作账本、原操作核对和草稿受理逻辑保持独立。展示取舍见[成功回执展示决策](../../.agents/notes/implemented/bug-fix/2026-11-03-quiet-session-receipts.md)。

client 持有 `{text, revision, submission}` 草稿，`submission` 关联 operationId 和提交 revision。sessionStorage 键由 principal、Task 的 project/task 或 Test ID，以及完整执行 fence 组成；相同文本不能替代操作身份。只有相同 operation 的明确受理且 revision 未改变时才清空文本。unknown 继续查询原 operation，不重放；存储失败时保持内存编辑。账号退出或变更清 principal 草稿，换代清旧 fence；访问403即使没有快照也清归属范围。离开页面后不维持全局撤权监听，下一次访问重新授权。

composer 通过实际 scrollHeight 与宽度变化调整输入的期望高度并遵守最大高度；空间不足时 textarea 可收缩至可编辑的最小高度，额外草稿内容在输入内滚动。发送过程中记录焦点是否仍属于该输入操作，仅在页面可见、组件 active 且未转移到其他控件时恢复焦点。IME、Shift+Enter 和原生 capability gating 继续独立生效。

composer 的表单保留提交、快捷键和设置面板的所有权；内部共同容器提供输入区、设置入口、活动状态、操作按钮的统一边框；快捷键说明作为发送操作的可访问提示，不占常驻布局行。textarea 使用透明背景且不单独绘制边框，焦点样式由共同容器与各可聚焦控件承担。设置面板继续由 composer 持有展开状态，命令菜单与输入共用同一表单。共同边界的选择理由见[统一 Chatbox 分组决策](../../.agents/notes/implemented/bug-fix/2026-11-04-unified-session-chatbox.md)。

默认 footer 使用 Grid 排列设置、状态、主操作三组；主操作中的 Interrupt 与 submit 使用不换行的 flex 容器，长发送标签在按钮内部换行。`.session-composer-surface` 是独立的 inline-size 查询容器，使阈值使用实际 footer 内容宽度。阈值按该内框中设置入口、按钮和间距的实际预算选取，不能把包含外部 padding 的原型容器宽度直接套入。状态和 Interrupt 均不可见且主操作仅为普通 Send 时，234px 以下两行、达到 234px 后一行；无可见状态时，若 Interrupt 仍可见或主操作为 Awaiting provider confirmation、Executing command 或 Add to current turn 等长标签，不足 516px 保持第二行，达到 516px 后才与设置同排。有可见状态时，346px 以下三行，346px 至不足 516px 两行，达到 516px 后三组同一行。状态与主操作同排时，Grid 为两者分别分配受限宽度，避免长操作标签挤没状态；三组同排时还保留设置组的最小宽度。组内文字换行只增加本组高度，不能重新拆开操作组、覆盖相邻控件或横向溢出。DOM 按设置、状态、Interrupt、submit 排列，不通过 CSS order 或重复控件改变键盘顺序。模型按钮中的文字 span 可收缩并省略，caret 独立且不收缩；按钮最小宽度 52px。粗指针下底部按钮最小高度和命令入口最小宽度均为 36px。

`SessionActivity` 继续拥有计时、状态选择与 Interrupt 的可见性和门禁；可选的 `render(status, interrupt)` 只让默认 composer 分别安放已生成的节点。即使状态由 Session 主提示代为显示，中断仍按独立条件保留。没有可见状态或中断时仍调用该 render，以保留默认主操作中的 submit。未提供 render 时仍返回原有状态与 Interrupt 的组合。`presentation.renderFooter({ settings, activity, submit })` 继续收到这一组合 activity 与原 submit，保持自定义布局契约；默认 Grid 仅应用于默认 footer。快捷键提示仍由 submit 自己的操作容器持有，Interrupt 的 hover 或 focus 不获得发送提示。此分组不改变 Session header、外层布局或发送、追加、中断、设置、命令的协议。取舍和后续入口的约束见[响应式底部操作区决策](../../.agents/notes/implemented/bug-fix/2026-11-06-responsive-session-footer.md)。

命令菜单保持在 composer 的文档流内。Session、composer、输入共同容器与菜单形成 flex 收缩链，timeline 不再用固定最小高度挤占输入与操作的空间。菜单标题、刷新和关闭按钮位于滚动内容之外；标题行允许换行，标题本身不收缩，窄面板中操作组整体移到下一行，避免标题被挤成逐字换行。目录、错误与空态在内部 body 滚动。组件按标题的实际高度及其 margin、目录 body 的 CSS 最小高度、菜单 padding 与 border 计算菜单最小高度；body 至少保留 36px，避免仅保留标题时目录被压成零高度而失去可点击区域。输入共同容器的最小高度包含 textarea 的 CSS 最小高度、底部操作的实际高度与间距、边框、内边距及当前错误。ResizeObserver 跟随换行后的标题、操作区和容器尺寸更新约束。textarea 可以在期望高度与最小高度之间收缩，底部操作不收缩；菜单的最大高度只约束宽裕空间下的大小。键盘浏览期间，选中项变化或目录可视区调整时，使用定位在目录 body 内的 offsetTop/offsetHeight 直接设置 scrollTop，保持同一未缩放坐标系，避免整数尺寸比例换算产生累计偏移，也不滚动祖先容器。

条目共用 `aria-selected` 高亮状态。描述保留完整 DOM 文本，由 CSS 将非高亮项限制为两行，高亮项解除截断；`argumentHint` 仅在高亮项挂载。名称与描述允许在窄列中换行，不将完整文本复制到额外提示层。Controller 继续提供原始 `argumentHint`，因为选择带参数命令时它还决定先补齐命令头、保留输入焦点，而非立即执行；减少提示重复不能改变这个命令选择条件。

鼠标或笔的 `pointermove` 更新高亮，触屏移动不走悬停路径。组件在切换前记录目标相对目录 body 的顶部位置，在布局提交后清除上一次临时列表 padding，再通过目标新 `offsetTop` 计算所需的 `scrollTop`，抵消前面条目收起造成的位移。所需位置为负数时补充等量 `paddingTop`，超过 body 可达到的最大滚动位置时补充缺少的 `paddingBottom`，使目录首尾也能保持目标位置；只保留当前指针锚点所需的空白。键盘 reveal 前，以及输入、目录或菜单生命周期重置后清除临时 padding。body 禁用浏览器滚动锚定，避免和显式补偿重复。相同指针坐标不重复切换，防止展开后的布局将另一项移到静止指针下而连续改变高亮。指针移动到已高亮项也切换为指针浏览，使 ResizeObserver 不再强制执行键盘 reveal；手动滚动可以继续阅读长描述，箭头导航则恢复键盘 reveal。悬停只改变高亮来源与索引，不设置 `candidateExplicit`，普通 Enter 的完整名称分类和明确箭头选择后的候选确认继续由既有分支决定。取舍见[命令条目信息密度决策](../../.agents/notes/implemented/bug-fix/2026-11-06-session-command-density.md)。

嵌入任务详情时，composer 将上述最小尺寸、表单 padding 与其他子项、Session 中除 timeline 外的兄弟区域以及 Tabs 的实际外部高度相加，写入所属 `.task-detail-body` 的 `--session-composer-space`。只有 Session tab 可见时，CSS 才根据 body 剩余高度收缩任务元数据区域的 max-height；元数据保留内部滚动。这个测量替代对所有 tab 一律预留 120px 的假设，避免长任务标题与状态区域把 Session 必要控件裁掉。

独立 Test Session 使用所属 `.test-session-shell .content` 保存同名预留变量。预算包括表单最小空间、Session header 与其他非 timeline 区域、TestSessionPage 返回链接和标题的外部高度、content 上下 padding 与 Session 边框。`.auth-shell.test-session-shell .content` 以 `min(100%, var(--session-composer-space))` 约束最小高度；topbar 允许 flex 收缩并内部滚动，使其控件仍可访问。独立页用明确的 18px 底部 padding 覆盖认证应用通用内容区的额外底部留白，避免与 Session 自身布局重复占用空间。任务详情仍使用自己的 body 与 metadata 预算；没有这两类宿主时仅使用共享 flex 布局。相关内容和尺寸变化重新计算所属宿主的预留值，失活与卸载清理观察器及 CSS 变量。

viewport 高度不超过 500px 时，composer、菜单与 Session header 减少纵向留白，独立页同时收紧 topbar、内容区与页标题的留白，其中认证独立页 content 的底部 padding 为 8px，给基本控件和可点击目录区域让出空间。这个密度调整不替代实际容器的 flex 约束与最小尺寸测量。

刷新按钮沿用 `refreshCommands` 的 `refreshing` 生命周期和 `onRefreshControls` 调用：刷新中优先显示专用本地化忙碌文案，设置 `aria-busy` 并沿用既有 disabled 条件；非刷新中以菜单实际渲染错误的 `controls.commandsError` 选择重新加载或正常刷新文案。普通发送、命令执行或刷新请求自身的 composer 错误不冒充目录加载错误。

关闭菜单不经过控制权限或原生操作 gate，也不改写草稿。 textarea 的非 IME Shift+Tab 在命令确认分支之前处理，使用 `flushSync` 同步收起候选 DOM，然后保留事件默认行为和传播。浏览器与外层焦点边界依据收起后的控件计算反向顺序，不会进入刚隐藏的候选；这个路径不调用恢复输入焦点的关闭回调，也不依赖连接、候选数量或执行 gate。普通 Tab、Enter 分类和 IME 保护仍由原有分支处理。关闭按钮、命令开关与普通 Escape 收起目录；显式关闭恢复 textarea 焦点并使用 `preventScroll`。菜单在 active 时向最近的 `.task-agent-session` 注册原生冒泡 keydown 监听，没有 Session 容器时使用 form，使标题栏焦点也先经过命令菜单的 Escape 处理。监听尊重已消费的事件；IME Escape 只停止传播而不阻止默认行为，普通 Escape 才阻止默认行为并关闭菜单。Display 打开时让出该监听，快捷键提示的既有 capture 监听保持更高优先级；表单处理仍覆盖自身的设置面板与命令关闭。外部 pointer 只收起目录，不恢复输入焦点、不阻止事件默认行为，使被点击控件继续获得焦点并执行自身操作。失活、关闭或卸载移除菜单拥有的监听。布局与关闭机制的取舍见[命令菜单空间与关闭决策](../../.agents/notes/implemented/bug-fix/2026-11-04-session-command-menu.md)。

阅读与草稿决策的替代方案和限制见[Session 阅读与草稿决策](../../.agents/notes/implemented/bug-fix/2026-10-28-session-reading-and-draft-ownership.md)。

### 可导出的阅读书签

`useTimelineScroll` 的可选第六参数为 `{historyEpoch, historyComplete}`，返回 `captureBookmark()`、`restoreBookmark(bookmark)` 与 `getRestoreStatus()`。省略该参数时不导出书签，原跟随、显示过滤和分页调用保持原语义。`TimelineReadingBookmark` 只含 `identity`、`historyEpoch`、`following` 和可空 `anchor`；anchor 保存条目 key、相对 viewport 顶部的 CSS px、可选文本 offset/最多 32 字符的 quote/相对顶部，以及最多一个前邻和一个后邻 key。导出复制这些字段，不保留 DOM、Range、完整条目或资源，也不复制内部原始 key 数组。文字位置沿用已捕获的 offset，导出时不因宽度变化重新选取更早的同一行文字。

`SessionTimeline` 的可选 `reading={scope, ref}` 将这些方法暴露给同页容器。调用方的 `scope` 必须包含已认证账号及视图归属；组件将它与实际 `sessionFenceKey(snapshot)` 合成 identity，并独立使用 snapshot.historyEpoch。没有真实 snapshot 时不能导出。在线视图把已就绪、无更早页、未加载且无历史错误同时成立视为 `historyComplete`；经过完整读取与校验的 ready 归档也确认历史边界，但不开放在线分页。尚未同步或加载失败不证明历史边界。书签只在完全相同的 identity 和 historyEpoch 下接受，拒绝不改变当前阅读位置或跟随意图。组件卸载前由容器捕获，重新挂载并取得对应 ref 后恢复；容器不应在每次渲染重放已经应用的书签。

恢复返回 `restored`、`pending` 或 `rejected`；`getRestoreStatus()` 读取当前状态，尚未请求恢复或明确返回最新后为 `idle`。`pending` 同时覆盖 inactive/零高度、无可见行和目标尚未加载，调用方结合当前 active、历史就绪与原始条目判断是否需要加载历史。恢复方法和 getter 通过一次 Timeline 挂载内稳定的控制句柄代理最新滚动状态，调用方在新的提交后读取当前 ref。Timeline 被替换时句柄随实例改变；跨替换只转交原实例仍为 `pending` 的书签，旧实例的 `idle`、`restored` 或 `rejected` 都不得重放。目标不在原始条目中且历史边界未知时，保留原书签，普通分页的 pause/capture 和滚动事件不能把它覆盖成尾页位置。新页或布局到达后自动再次定位；网络读取、进度判定、错误及重试仍归 Session 容器，hook 不调用网络，也不把缺少锚点解释为加载完成。

锚点已在原始数据中但被模式过滤时，按当前原始顺序找最近可见前项，无前项则找后项，定位替代项顶部。只有确认历史边界且原 key 仍不存在时，才尝试书签保存的前邻、后邻，再退到当前第一可见项顶部；这是一种有界降级，不承诺删除大量相邻行后仍能还原原始完整顺序。无可见项继续保留书签与暂停意图。没有可用文字位置时沿用条目相对位置，包括 quote 失效或原视口仅含图片而未捕获文字的书签；冷恢复后若条目因折叠等原因缩短，原负偏移已使整个条目处于 viewport 上方，则退到该条目顶部，避免把阅读位置转移到后续消息。following 书签按新布局跟尾。该接口不新增跨页面数据库，也不管理 pane 淘汰、连接或草稿；其消费者须按账号、删除与撤权清理自己保存的书签。

助手容器通过 `SessionView` 的可选 `reading` 透传使用此接口；其三 pane 淘汰、冷恢复分页和账号清理由[助手 Session 设计](bot-session-view.md)拥有。

书签导出与原始顺序保留的取舍见[显示过滤与阅读位置决策](../../.agents/notes/implemented/architecture/2026-11-04-session-display-reading.md)。

### Session 显示偏好模块

`task-agent-session/display-preference.ts` 的 `createSessionDisplayPreferenceStore(getStorage?)` 创建页面级共享缓存，`get(binding)` 返回具有 `getSnapshot`、`subscribe`、`setMode` 和 `retrySave` 的独立偏好。`useSessionDisplayPreference(binding, preferences?)` 默认使用同一页面缓存，返回 `{ mode, issue, setMode, retrySave }`，由共享 `SessionView` 消费。第二个参数用于注入独立 store；调用方应保持该 store 实例稳定。

`binding` 为 `{ userId, sessionId } | null`，必须来自已认证账号与匹配的已验证 Session 快照。hook 在 render 中按身份选择 store，再使用 `useSyncExternalStore` 订阅，因此身份变化的首帧不会使用上一身份的值。`null` 返回 Conversation 和空 issue，订阅、设置、重试均无操作，连 Storage getter 也不调用。claim、fence、historyEpoch、连接或归档状态不参与身份；同一账号和 Session 的多个消费者共享选择。

存储键为 `daynight.web.session.display.v1:` 加 `JSON.stringify([userId, sessionId])`，值只能是 JSON 字符串 `"standard"` 或 `"conversation"`。JSON 数组编码避免身份分隔符歧义，浏览器 origin 提供站点隔离。首次缺省返回 Conversation，不写默认值；已有有效值立即生效。getter/getItem 抛错返回 `{ kind: 'read' }`，无效 JSON 或枚举返回 `{ kind: 'invalid' }`，均使用 Conversation。issue 只保留错误类别，不缓存异常 payload 或凭据。

`setMode` 在保存前更新内存；保存失败保留新 mode，issue 为 `{ kind: 'write' }`。成功保存清除 issue。同值选择不写入、不通知、不更换 snapshot，调用方无需重置阅读位置。`retrySave` 仅在有 issue 时保存当前内存值，不回读旧值；重复失败保持稳定 snapshot，成功清除 issue，无错误时是无操作。

解绑会移除订阅回调；页面缓存保留身份键、mode 和错误类别，使保存失败后的重新挂载仍能恢复当前选择。缓存生命周期是页面生命周期，刷新时重新读取持久值；不监听跨标签变更，也不提供跨设备同步。缓存不持有 Session client、原文、草稿或操作账本。存储与 React hook 使用可注入的 Storage/getStorage 验证失败路径，测试不接触真实用户偏好。取舍见[显示偏好决策](../../.agents/notes/implemented/architecture/2026-11-04-session-display-preferences.md)。

### Session 显示菜单与入口绑定

`TaskAgentSession` 与 `TestSessionPage` 向 `SessionView` 传递已认证 scope 的 `userId`；只有属于当前 scope 和目标的 client 才能进入共享视图。入口保存 client 的创建身份，并在 render 时核对 scope 和 Task 的 project/task/claim 或 Test 的 sessionId。切换账号或目标后、effect 创建替代 client 前显示加载状态，避免把新账号与旧快照拼成偏好键。`SessionView` 使用匹配的已验证 `snapshot.sessionId` 绑定偏好；缺少快照、不可用或身份未确定时绑定 null，不读取另一身份的偏好。

`SessionDisplayMenu` 位于顶部 Session 全屏按钮左侧，刷新按钮位于全屏按钮右侧。菜单接收当前 mode、issue、选择和保存重试操作，仅提供两个 `menuitemradio`：Standard/标准、Conversation/对话；`aria-checked` 由共享 store 的当前值决定。打开状态独立于 client 和 timeline identity；切换偏好只更新可见列表，不参与 client effect 依赖、Composer 的执行 key 或条目 key。

菜单在顶层浮层中定位，按触发器定位，并以 Session 容器与 viewport 的水平交集约束宽度和横向位置；纵向位置受 viewport 限制。浮层不被容器裁剪，也不向窄 Session 两侧越界；监听容器尺寸变化，标题区按实际容器宽度换行。键盘可进入选项并导航，Escape 阻止向外传播、关闭菜单并恢复触发器焦点；外部 pointer 或焦点离开关闭。Display 打开时协调 Chatbox 快捷键提示的可见状态与 Escape 监听，防止提示抢先消费关闭菜单的按键。保存重试后的焦点保留在仍存在的控件上，不落到已移除的重试按钮。

read、invalid、write issue 只在打开的菜单内按当前语言映射说明和重试。选择失败后 mode 保留，菜单仍能展示未保存状态；重试调用同一偏好的 `retrySave`，成功去掉错误而不改写模式。正常状态不增加说明行。菜单文案使用 `useSessionMessages` 的本地化目录，不读取原生操作的固定英语标签子集；语言切换保持 client、输入、操作和偏好身份。入口、菜单与提示层的选择理由见[显示菜单集成决策](../../.agents/notes/implemented/architecture/2026-11-04-session-display-integration.md)。

### Session 全屏与任务容器协作

`SessionView` 保持同一个 section 和 header，加载、未注册、不可用及错误状态只改变正文，不以另一棵空态子树替换会话外壳。全屏图标与刷新入口因此不依赖可读取的快照；可读取时同一工具栏保留 Display。全屏文案使用本地化消息目录，按钮的图标、可访问名称、提示和 pressed 状态表达当前动作。

`useSessionFullscreen` 持有视图内临时状态，绑定 client、已认证 userId 和已知实际 Session 身份；`active=false`、身份替换或卸载释放所有权。同一 client 和账号首次取得 Session 身份时补齐绑定并保留全屏，后续已知身份替换才退出；已知身份的快照暂时缺失不构成身份变更。状态不进入 client 的 effect 依赖、执行 fence、Composer key、URL 或任何存储，也不触发读取或业务操作。`SessionTimeline` 实例和 `useTimelineScroll` 的 viewport/content 观察器持续存在，按尺寸变化恢复文字锚点及跟随意图；全屏不另存原始 scrollTop，也不调用返回最新。暂停阅读时，布局重排保留仍可定位的原文字 offset，不因宽屏把更早文字排入同一行而重新采集锚点；用户阅读动作或锚点失效才更新该位置。

`SessionView` 可接收包含原 section 的 `fullscreenBoundary` ref，供[助手详情布局](bot-management-web.md#详情与全屏边界)将标题、会话和详情纳入同一全屏根。该模式将注册、隔离、焦点和视口样式应用于既有祖先，键盘在 document 冒泡阶段处理，允许内层抽屉先消费按键。缺省根仍为下述 Session section；不移动或重挂会话。

`SessionFullscreenContext` 允许共享视图向 `TaskDetailSurface` 登记 owner、原 section 和退出操作。登记期间 Surface 使用独立 Session 全屏样式占满 viewport，隐藏任务 chrome、Tabs 和通知；原 `DetailFullscreen.active` 不变。取消登记按 owner 核对，旧视图清理不能撤销新视图的登记。Surface 禁止自身 Escape/Tab 与 Session 的键盘边界竞争。Test 入口直接使用共享视图的 viewport 样式，不需要任务容器或另一份 Session。既有 section、portal、key 和 DOM 层级不变；任务容器同时展开并取消入场 transform，避免固定定位被祖先 containing block 或裁剪边界限制。首次进入 Session 全屏后，同一 Surface 挂载周期不再重播入场 transform 动画，防止退出时的动画几何污染阅读位置。

全屏 hook 沿 Session 到 body 的祖先链将旁支设为 `inert`，记录并恢复原值，且覆盖全屏期间新增的背景节点；不能使包含 Session 的共同祖先 inert。背景隔离和 `useBodyScrollLock` 均有所有权计数，退出仅释放当前视图的计数，不提前解除外层 modal 的背景锁。Tab 在 Session 内按实际可聚焦控件循环，无可用控件时聚焦 section；外部焦点被限制回会话。内层菜单先在自己的冒泡处理器消费 Escape，Session 再消费尚未处理的 Escape 并退出，外层任务不处理同一次按键。显式退出使用 `preventScroll` 恢复仍连接且未隐藏或 inert 的入口；失效身份清理不将焦点抢回旧视图。

共享全屏样式使用 CSS viewport，不调用原生 Fullscreen API。`visualViewport` 存在时监听尺寸和偏移变化，以 `--session-viewport-width/height/top/left` 使全屏布局跟随可见区域；否则使用窗口 viewport。退出恢复原样式值并移除监听。输入框宽度观察回调将高度调整合并到下一 animation frame，并在清理时取消待执行帧，避免在 ResizeObserver 交付期间改变被观察尺寸；首次布局及文本变化仍同步调整。工具栏保持独立可见空间，内容保留各自滚动所有权；长文本、窄容器和较短可见高度不能把退出按钮推到不可达区域。布局与生命周期选择理由见[Session 全屏决策](../../.agents/notes/implemented/feature/2026-11-04-session-fullscreen.md)。

## 关闭与清理

网页关闭或网络断线不停止 Agent loop。worker 请求 cleanup 时，Controller 禁止新的普通发送，保留 cleanup 所需审批；先取消原活动 turn，再提交唯一 cleanup prompt，并等待该 turn 的原生结束。旧 generation 的 cleanup 记录不能禁用恢复后的新 generation。claim 进入清理时 relay 有最多 60 秒的 draining 窗口，普通发送和取消被禁止，尚未投递的 accepted 操作在同一事务内拒绝。

Controller 用 `cleanupInteractionIds` 标识清理阶段实际产生的交互。服务端冻结时保存 Timeline 序号边界，拒绝将冻结前的 pending 交互重新标为 cleanup；只有边界后且属于当前白名单的交互响应可以提交。浏览器按相同白名单启用控件，服务端在接受、Poll 投递和 operation_begin 时分别重验，避免排队期间权限变化绕过限制。

Controller 自身只能报告 stopping。worker 独立检查对应进程停止后才写入 stopped/nativeStopped，并据此清理 worktree 或创建下一代恢复 ticket。POSIX 检查 Controller 进程组及已记录原生进程身份；主动脱离进程组的后台服务仍须由任务 cleanup 停止，此证明不覆盖任意逃逸 daemon。Windows 使用不允许 breakaway 的 Job Object；Controller 的创建、成员查询与终止通过已有 Koffi 依赖调用 Win32 API，保留原有命名、权限与逐次句柄释放方式。每次操作保留 15 秒预算，在 native 调用之间及句柄释放后检查；已开始的 kernel 调用必须等待返回，不能由 JavaScript timer 抢占。只有打开 Job 时的 `ERROR_FILE_NOT_FOUND` 表示名称不存在，权限、查询、终止和释放失败均保留错误；空 Job 清单仍不能代替原进程实例的停止证明。句柄生命周期与验证边界由[原生 Job API 决策](../../.agents/notes/implemented/testing/2026-11-05-native-controller-job-api.md)说明；跨平台支持声明仍以对应平台真实验收为准。

## 升级与安全失败

Task API 通过 `Daynight-Worker-Protocol: 2` 显式协商扩展 WorkerClaim。新 CLI 与 Web 发送此请求头，响应包含 `agentControlMode`。未发送或不能识别的版本按旧协议投影：Herdr Codex/Copilot 保留原 WorkerClaim 字段并省略 mode；Web 或 Claude claim 的 worker 键被省略，任务本身的状态、版本、依赖和资格不变。该投影仅表示客户端没有可用的 worker 摘要，持久 claim 与实际控制归属不受影响。

普通列表和详情不因项目混用执行方式而失败。带 `workerId` 的旧 worker 清单一旦含有不支持的 claim，整页明确拒绝，不能通过过滤或省略 worker 摘要把正在运行的执行伪装成缺失。无 `workerId`、同时指定 `ready=true`、`allowAgents=true` 和 `compatiblePlatform` 的旧 worker 候选查询过滤不可执行的历史 claim；保留原有排序和游标，连续全过滤页继续扫描到可见结果或末尾，每页不超过请求 limit，也不返回带后续游标的空页。其他普通列表不应用候选过滤。

未协商扩展协议的写请求携带旧 worker 限制。服务层保留原有输入校验顺序，在项目写锁内核对版本及实际 claim，然后决定是否允许更新、状态改变、删除或 worker 操作；claim/resume 还检查新 descriptor。旧客户端看不到的执行不能被当作无主任务重新认领或操作。兼容投影不作为写入依据，也不代替项目权限。

服务端可在保留既有 CLI/Herdr worker 的情况下升级；只有使用 Web 或新增 Provider 的调用方需要支持对应能力的客户端。新客户端仍将旧服务端响应中缺失的 mode 规范化为 Herdr，Herdr claim/resume 不添加旧服务端无法识别的 mode 字段。Web 新执行必须确认服务端支持相应协议，失败时不省略 mode 重试为 Herdr。选择及其成本见[Worker 协议协商决策](../../.agents/notes/implemented/architecture/2026-10-28-worker-protocol-negotiation.md)。

协议解析不授予项目权限，也不能证明原生进程停止。鉴权、持久操作去重、连接代次校验、初始化输入门控和停止证明仍必须在实际调用边界实施。故障不得通过换 ID、重建会话或提升连接代次绕过。
