# Task Session 模式与共享契约

## 组件与实现边界

[需求](../spec/task-sessions.md)定义两种互斥执行方式。认领服务保存实际模式，CLI 冻结执行配置，Web 读取同一字段。共享纯 TypeScript 协议位于 `packages/daynight/src/session/`；CLI 发布时随包编译，Web 从同一源码消费类型与解析，避免产生独立发布包或重复协议副本。模块不得依赖 Node 进程、文件系统或认证配置。

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

本机 native resume lease 库独立使用版本 1。申请在同一同步事务中检查格式、必要时接入、查重并写入 lease；存在任何保留记录时阻止迁移。释放先在事务内确认当前格式，再按原 native_key 与 nonce 删除，不进入自动升级或过期回收。格式和关闭失败保留错误与原归属。共同机制见 [SQLite 升级设计](cli-sqlite-migrations.md)。

恢复注册新的 Test Session 和 execution，使用新的凭据、journal 和操作身份，ticket 的 resumeNativeSessionId 指向原生历史且 initialInput 固定为 none。新 URL 从原生历史投影 timeline，旧 Session 的归档和回执保持不变。已有 Provider 原生恢复负责准确身份与历史加载，不重发旧操作。锁贯穿 launcher 的执行和清理；未启动或完整停止证明允许释放，未知结果保留租约。该流程不放宽服务端 archived grant 拒绝，也不承担外部原生 TUI 的抢占。

## Test Session 注册与权限

Test 使用独立 `/api/v1/test-session-capabilities` 预检及 `/api/v1/test-sessions` 注册入口，避免改变旧 Task 客户端的严格能力响应。创建者来自已验证的 PAT principal；客户端提供持久 registrationId 与 testExecutionId，对账不能改换 ID。Controller grant 与 Task 共用格式和连接入口，但绑定 Test 身份及父凭据，续签不改变原执行。

Test 快照、历史、操作、资源和浏览器 channel 位于 `/api/v1/test-sessions/{sessionId}` 下。访问时检查当前凭据与创建者，而 Task 路径继续检查项目权限及当前 claim。两类授权策略进入同一在线内容转发、操作去重与投递实现，不以空 task 参数代表跳过校验。会话身份表名 task_sessions 保留，scope 与 test_execution_id 的数据库约束区分归属；Task 外键不变，Test 不制造占位 Task。

`GET /api/v1/test-sessions` 提供账号范围内的列表读取，与同路径的 `POST` 注册分开。返回 `{ items, nextCursor }`，每项包含 `sessionId`、`provider`、`lifecycle`、`connectionState`、`createdAt`、`updatedAt`。`updatedAt` 使用会话创建时间与最新连接心跳时间的较大值，表示服务最近观察到该连接，不推断本机文件或 Agent 的实际工作时间。列表按该时间和 Session ID 降序分页；`limit` 默认 50、最大 100，cursor 绑定当前用户。数据库在分页前过滤 Test scope、创建者和原父凭据有效性；状态读取沿用现有连接时效规则。

前端 `/test-sessions` 与 `/test-sessions/{sessionId}` 均受现有登录机制保护，登录 return path 仅接受合法站内路径。列表复用账号范围和请求身份校验，刷新从第一页开始，追加页按完整 Session ID 合并。列表不维持跨请求快照，因此会话活动可能改变后续分页位置；刷新用于重新发现移到前面的记录。列表链接进入原 Session View，由单会话接口再次授权，不把列表中出现过视为持续访问许可。Test 容器提供身份与 API 适配，复用 Task 的 SessionView/client。URL 不含 token；账号失效、变更或退出触发客户端清理，服务端对读写及持续订阅独立校验。

前台 launcher 使用私有 ticket、凭据、journal 与进程证据，Ctrl+C 先停止本机拥有的执行，再向 `/stop` 提交当前绑定及停止记录归档。POSIX 进程身份探测仅为 `ps` 子进程设置 `LC_ALL=C`，使启动时间解析和再次核验不受终端 locale 影响；Controller 和原生 Agent 仍继承用户原环境。该处理不放松 PID、启动时间、命令指纹与进程组的匹配要求。服务端验证凭据、执行身份与记录格式，不宣称远程执行过本机 OS 检查。服务不可达时本机停止继续执行，保留未确认归档事实。用户当前目录不属于 launcher 清理资源。独立入口不自动恢复或采用任意原生会话。

原生执行启动后的凭据续签将 HTTP 408、429、5xx 和传输失败留在监督循环内，按 1、2、4、8、16、30 秒递增并封顶退避，失败诊断不替代执行事实。成功后在原执行身份下写入新凭据并复位退避；不重新注册、不替换进程、不重放初始输入。明确的授权拒绝或协议/身份错误仍进入有界停止，Ctrl+C 能中止在途请求和等待。凭据过期时既有 relay 关闭失效连接，服务端在 Poll 和 operation_begin 事务中检查当前 grant 与父凭据，拒绝新的原生调用授权；浏览器显示或请求受理的短时延迟不改变这项执行约束。

本机 IPC 在收到完整且通过身份验证的请求后结束 30 秒 admission 超时，并释放请求缓冲。初始输入响应最多等待 65 秒，清理响应最多等待 30 秒且不超过清理 deadline；这些等待只控制调用者连接，不取消已经 dispatch 的原生操作。每个本机 IPC dispatch 共享一次完成通知，连接断开或响应截止时移除对应等待者。未完成的本机 IPC dispatch 和操作等待者分别最多 32 个；observe 与 stop 不占操作等待配额，保持观察与显式停止可达。

IPC 传输失败、EOF 或响应超时使用明确的 outcome-unknown 错误，与服务明确拒绝、错误身份或无效协议响应分开。独立 launcher 在已启动执行的观察失败时继续监督和续签；初始输入响应未知后只观察原执行，不再提交初始输入，即使后续快照仍为 not_submitted。该快照不能证明先前请求未到达。带 prompt 的执行若后续观察到 initialInputState 为 failed，即使 lifecycle 仍为 ready，也按直接收到初始输入失败的路径报告错误并清理原执行；不带 prompt 的会话不适用该判断。未知、派发中与成功状态继续监督；显式取消和真实执行失败仍保留停止路径。

注册后尚未尝试 spawn 的失败可提交 `kind: never_started` 停止记录。服务端只在 grant 未消费、connectionEpoch 为零且没有 sourceEpoch 或 nativeSessionId 时接受；曾经连接再断开不满足条件。尝试过 spawn 却无法证明进程停止时保留未确认状态，不能冒称从未启动。

## Controller 与原生会话

worker 将冻结配置、managed prompt、初始 operationId、原生目录和 IPC 身份写入私有、不可覆写的 launch ticket；命令行只携带 launchId。Controller 使用独立版本 5 的单写者 SQLite journal 保存执行身份、输入结果、投影修订及 outbox。本机 IPC 用 ticket 中的随机 secret 鉴权，worker 以此观察、提交首次输入和请求清理。Controller 与 worker 分离，使 worker 重启无需重启仍在运行的 Agent。

Journal 的 1→5 迁移由本库定义持有。启动在同一事务中先检查旧 owner，再升级及执行原 ticket/generation 认领；纯读取需要迁移时只升级格式，不启动 Controller 或认领 writer。当前格式在同一只读快照内检查并读取。独立 stopped writer 在事务外验证进程树，最终事务重查格式及 snapshot 后写停止状态；close 清除 owner_pid 也是受格式检查的写入口。

本地数据库更新与 IPC 请求使用不同的错误边界，更新失败不能被解释成不可达而创建新 generation 或重放输入。独立 launcher 的退出保留 journal 错误，同时继续尝试停止已归属 child；完整停止及 journal 证明缺失时保留 native lease 和未确认结果。

Codex adapter 通过私有 `codex app-server --stdio` 建立 thread，恢复时要求精确 thread ID 和 cwd，并分页读取原生 items。Claude adapter 使用 Agent SDK Query，SessionStart 确认精确会话身份；SDK 配套 CLI 是默认执行程序。Claude SDK 空输入初始化不保证产生原生 session ID，因而初始化成功后只允许提交唯一的首次任务输入；收到实际 SessionStart 或原生消息中的 ID 后才记录身份。恢复历史通过带私有 `CLAUDE_CONFIG_DIR` 的只读 SDK 子进程读取，避免读到 Controller 父进程的全局会话目录。独立 Test Session 的原生设置和认证继承现有配置。Task Worker 新建原生会话沿用后台任务的 full access 策略；恢复会话保留已经确认的原生设置，不覆盖网页选择。网页权限操作必须经过当前 capability 和原生确认。

Codex/Claude 原生 user message 的 clientId 或 UUID 可证明某条持久输入已被接收。仅匹配已记录的输入 operationId 时，才把 dispatching/unknown 提升为 provider_accepted；空闲、文件出现或连接成功均不能证明输入受理。恢复不重放结果未知的操作。原生 turn 结果、Task 完成和 cleanup 完成具有各自独立的确认条件。

Codex 原生进程意外退出、Claude SDK 意外 EOF 和 Copilot runtime 失联均进入 fatal 路径：撤销写能力，保留未确认操作，通知 Controller 清理 provider、relay 与 IPC 后退出。Task worker 独立确认旧进程停止后才按预算恢复原生 ID；独立 Test launcher 则停止并保留失败事实，不创建替代会话。

Codex 和 Copilot 仅在活动 turn 匹配且原生能力允许时执行 steer；Copilot 使用 SDK `send({mode: "immediate"})`，不能改用 queue 冒充当前 turn 追加。Claude 仅在原生协商支持 msg_lifecycle_v1 与 interrupt_cancel_queued_v1 时提供 steer，以输入 UUID 跟踪 queued、started、completed、cancelled；中断请求包含 cancelQueued 并核验被取消输入。缺少协商能力时运行中普通发送保持禁用。审批、问题和 form 的响应携带 interactionId、revision 和原生请求身份。Codex 等待原生请求 resolved 通知；Claude 等待 matching tool result，elicitation 等待相应 turn 成功结束。SDK callback 返回仅表示响应已交给 SDK，不能立即标记原生 confirmed。超过等待期限的响应保持 unknown；随后原生 resolved 证据仍可按原交互身份将对应 journal 操作补记 confirmed 并发送迟到回执，不再次响应原生请求。

### Copilot SDK 与私有 runtime

Copilot adapter 固定使用 `@github/copilot-sdk` 1.0.11 与随包安装的 `@github/copilot` 1.0.83。Controller 直接 spawn CLI 对应平台 binary 的 `--headless --no-auto-update`，避免 npm launcher 的同步包装进程遮蔽真实 PID。随机连接 token 通过私有子进程环境传入，SDK 以 `RuntimeConnection.forUri` 连接该进程的 loopback TCP endpoint；这条连接既不共享其他 runtime，也不承载 TUI。真实 child 经 `onSpawn` 登记进程身份，继承 Controller 的 POSIX 进程组或 Windows Job 约束，沿用统一停止证明。

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

Web 将 setting intent 按用户、执行与 operationId 保存，展示 pending 目标和原生实际值；确认前不乐观替换实际值。命令目录在 / 菜单中提供过滤、键盘选择和参数，model/permissions 为本地打开设置面板的入口。原生命令草稿沿用 revision 与受理回执绑定。运行中目录查询错误通过 refresh_controls 重新读取；只读与失效投影深拷贝后关闭 mutable/available，不能改写持久能力。

已核实的排队取消使用 input_cancelled，主动中断只有在成功原生 ACK、输入 UUID 匹配且 terminal_reason 为 aborted_streaming/aborted_tools 时使用 turn_interrupted。Web 将这两个终止诊断显示为中性状态；其他诊断仍是错误提示，不能仅凭用户点击中断或错误文本掩盖原生故障。

新 server/Web 能读取没有 controls 的既有 Controller；这些会话不提供新控制目录。旧严格客户端不保证识别新增字段，更新顺序为 server/Web 在先，新 Controller 在后，不强制重启用户现有原生会话。

## Relay 与恢复

Controller 以短期 grant 建立 WebSocket，浏览器通过项目会话权限建立另一条 WebSocket；命令和历史也有 HTTP 接口。bootstrap grant 有效期 120 秒，reconnect grant 为 15 分钟；launcher 在首次 spawn 前将 bootstrap 换成可复连凭据，避免首次连接后短暂断网必须等待续签；grant 冻结签发凭据归属，撤销父凭据会使现有连接失效。服务端每次操作核验项目权限、claim、executionGeneration 和连接 fencing，不将浏览器传入的 native ID 当作授权。Controller 在 WebSocket 升级前先验证 grant、父凭据与 active scope，收到 hello 后在 Connect 事务中重复验证并消费凭据；握手预检不能替代原子 fence 校验。连接配额包含正在升级的请求，失败升级释放预留名额，伪造或失效 token 不能先占用 WebSocket。

Task Worker 的 grant 维护每 30 秒独立扫描当前服务的未完成 Web 执行，在凭据剩余不超过 120 秒时续签，不受 claim 发现的 pollIntervalMs 影响。维护过程验证 launch ticket 与原 claim、Controller、execution generation 一致；prepare、launch 和续签按执行串行，读取最新执行记录后才写入凭据。退出先取消并等待维护结束，再关闭执行存储，避免后台续签访问已关闭的数据库。续签失败保留原执行和凭据事实，并通过 worker diagnostic 暴露。

原生调用前，Controller 先持久记录操作，再请求服务端 operation_begin 授权，获准后写 dispatching 并调用原生。数据库仅保存 operation 身份、类型、正文哈希、操作者、执行约束和无正文的回执摘要；完整命令、原生结果和错误详情由 Controller 本地保存。服务端只在当前在线连接的有界内存中暂存命令。accepted 表示 relay 暂收，不保证持久排队；网页保留草稿，直到原生明确受理或确认。尚未送达 Controller 的正文在服务重启后不可从哈希重建，原操作按实际证据拒绝、过期或保持 unknown。已 offered 但尚未 dispatch 的操作如果因状态或权限变化失去授权，服务端持久化 rejected 并返回 receipt_ack，只拒绝该操作，保留当前连接。Controller 记录拒绝并拒绝对应 authorization 等待，不调用原生；迟到回执与重连对账仍按同 operation 身份收敛。已 dispatching 的不确定结果、内部错误或失效 Controller fence 不走这个拒绝捷径。重连以最多 100 条一批对账，最后一批带 final；整个对账完成后还需同步当前本机状态，才能启用新命令。重复 operationId 必须保持相同内容，断线或超时不能触发自动重发原生输入。

### 本机内容与在线读取

Session 内容归属于 Agent 执行环境，要求对应 Controller 在线且本地数据存在才能加载历史。这里的执行环境可由容器或 sandbox 承载；普通 worktree 本身不具有安全隔离能力。Controller journal 保存原生身份、完整操作记录、时间线投影和资源。Timeline entryId 源于原生条目身份，entrySeq 在本机首次插入时分配，revision 单调维护；ACK 只清除传输 outbox，不清除本机投影。原生 transcript 可以辅助恢复，但不能替代已丢失的操作受理和未决审批证据。

sourceEpoch 和整数 sourceSeq 标识传输顺序。outbox 的 64 MiB 上限只限制等待发送的数据；内容先在本机事务中保存，超限时压缩传输积压并记录 sourceFloor。新连接以该下界跳过已舍弃的传输事件，重置展示 historyEpoch 并重新同步。网络积压不再暂停原生输入或停止健康 Agent；本机持久化失败仍须暴露，并停止无法可靠记录的执行。操作日志不参与 outbox 压缩，不确定输入不得因此重放。

Controller 每次连接先分批 reconcile，排空剩余 outbox，再发送 sync_state，内容为当前状态及最多 100 个待处理交互。服务端收到后返回 sync_ack，完成前禁止网页控制。executionGeneration 隔离原生实例，connectionEpoch 隔离连接；historyEpoch 标识可用展示缓存，改变时网页重新读取本机内容，不创建或恢复另一段原生执行。

历史 HTTP 请求经过权限校验后，经 Controller WebSocket 转发 content_request。Controller 按本机稳定条目序列分页，返回内容捕获时的 sourceThrough；该点之前的事件先获 ACK，随后发送 content_response，再发送较新的事件。服务端在处理响应的同一有序事务中捕获 lastEventSeq，不能改用等待结束后的较晚水位。分页游标绑定 Session 与 historyEpoch。每页最多 200 条，并按 WS 帧大小进一步截断，前后游标表示实际返回边界。

Session 的 HTTP、WebSocket、嵌套 timeline/content 编码与展示缓存统一使用不转义 HTML 字符的 JSON 表示。内容只作为 JSON 或 WebSocket 文本提供，不嵌入 HTML。Controller 预算还计入 Go 对 U+2028/U+2029 的转义；持久操作和源事件的哈希仍保留原编码，避免重试同一操作时改变内容指纹。

Poll 使用相同的 MarshalWire 编码计算 operation_offer 的完整封装字节数。单个 offer 超过 2 MiB 时，以 payload_too_large 终态拒绝原操作，释放暂存正文并继续后续队列；若仅当前批次累计超限，则将该操作留到下一次 Poll。HTTP 请求体通过入站上限不代表增加 offer 封装后仍可发送；不得截断输入或让永远无法发送的单个 offer 阻塞后续操作。

单条非交互展示投影的传输预算为 1,400,000 字节，给分页及帧封装留出空间。超过预算时，本机 journal 保留完整投影，实时发送与历史读取统一返回 display_budget_exceeded 错误条目，保留原 entryId、entrySeq 和 revision。旧 outbox 也在发送前执行同一投影，并保留 sourceSeq，使源水位可以继续确认；不是跳过事件后宣称完整回放。带权限语义的 interaction 不采用此替换，完整交互和 controls 仍受总帧及内存容量约束，超限明确失败，不通过截断审批内容或自动批准获得同步。

资源以登记的 resourceId 读取，不能把任意本机路径转换为下载地址。每块最多 512 KiB，单资源最多 8 MiB；完整读取检查长度、SHA-256 及相同 Controller 连接身份。每个内容请求最多等待 15 秒，全服务最多 32 个、单 Session 最多 4 个在途请求。等待前后都检查访问权限，取消或迟到的响应不能污染另一请求或断开健康 Controller。当前 Provider 的图片/文件输入与不支持的原生二进制内容仍遵守基础交付边界。

### 服务端存储与容量

PostgreSQL 保存 Session 归属、注册身份、授权、原生与连接代次、生命周期、水位和最小操作账本。不写入时间线、消息、工具输出、资源、动态 controls、待审批正文或自由文本错误；操作正文也不藏在 command 或 snapshot 中。既有内容表和历史行不自动删除，当前实现停止向其中新增内容；既有备份或历史行的清理由运维单独决定，迁移不会宣称已擦除旧数据。

服务端的每 Session 内存状态最多 4 MiB，其中最近事件缓存最多 2 MiB、1000 条。缓存丢失返回 reset_required，从在线本机重新加载；不承诺离线历史回放。最多 64 个 live Session，超额明确拒绝接入，不代表实测并发能力。每 Session 最多保留 4096 条持久操作摘要，达到上限拒绝新操作；不能简单 TTL 删除 unknown 或去重记录后重新执行旧请求。Session 身份仍随创建数增长。

在线状态由持有 Controller 连接的 relay 实例维护。另一实例不能凭共享数据库假装拥有会话内容，也不能抢占仍有效的连接租约；请求需要路由到持有连接的实例，未满足时明确失败。服务端重启后 Agent 继续在本机执行，重新连接、授权和状态对账后恢复网页操作。数据库事务成功后才发布对应内存状态；失败事务不能先向浏览器确认尚未提交的控制结果。

Controller 离线时，新页面只能读取有权限的身份与离线状态，不能加载历史或操作。已打开网页保留当前离线画面；重新同步成功后替换过期内容。归档记录保留身份与必要回执，原 URL 不提供服务器聊天历史；独立 resume 在新的在线执行中从原生本地历史恢复。执行环境的数据保留、备份和丢失恢复由该环境负责。

响应操作按 interactionId 与 interactionRevision 限制同一交互的重复提交，不能按整个 turn 或 interaction_response 类型互斥。工具审批等待 tool_result 确认期间，同一工具提出的新 MCP form 必须可独立响应。浏览器只持久保存 operation 与交互身份的关联，不保存答案；缺少旧缓存时，服务端当前在线交互校验和 Controller 原生校验仍决定能否响应。

## Session View 的阅读与输入状态

浏览器将 scope/current 失效与 auth 暂停分开。身份待复核时最多保留 WebSocket 60 秒；新帧保存在最多 1000 条、合计 4 MiB 的内存缓冲中，不推进已消费 cursor 或发布新内容。HTTP 在途结果也等待复核，负面授权结果仍立即失效。确认同一身份后按原序消费缓冲，并继续原连接与历史；到期、缓存超限或真实断线则关闭连接，使用最后已消费 cursor 恢复。scope 撤销、principal 不符和执行失效不享受此宽限。Chatbox 与审批暂时禁用操作，但保留输入、阅读位置和连接呈现；只有实际失去同步才显示恢复提示。该策略继承[前台身份核验](daynight-auth.md)的账号隔离规则，不停止或重新创建原生 Agent。

Claude SDK 不保证实时回显提交的 user message。Controller 在本地派发时按 `operationId:0` 投影用户文本，与以后原生 echo/history 的稳定 ID 相同，避免重复行。这条本地展示不调用 `onInputObserved`、不验证原生身份、不确认回执；原生受理及恢复对账仍必须有真实输入或响应证据。unknown 状态下可查看提交原文，不能因该行存在重发或消除 unknown。

Task 与 Test 共用 `SessionView`、Session client、timeline 和 composer。`SessionMarkdown` 对消息和 reasoning 使用安全 Markdown，保留软换行，为每个实例生成脚注命名空间；只允许该实例生成的脚注内部链接，外链保留协议限制。工具文本用原始文本区域显示，参数和输出限高、可聚焦滚动，展开后才挂载内容。工具摘要从已有参数提取，不向模型补发请求。Copilot 投影去除相同的结果字段，保留不同结果与失败附带的错误/输出；工具状态取原生 `success`，不解释 shell 日志中的自由文本退出码。

滚动状态区分跟随和阅读。触摸起点仅用于检测上读方向，轻点不改变模式；非编辑控件的上读按键、旧内容焦点和脚注跳转可暂停跟随。宽度变化后优先按可见文本位置恢复，找不到该文本时退回稳定条目锚点。分页、inactive 页面和返回最新沿用同一滚动状态，不能用布局变化推断用户恢复跟随。

client 持有 `{text, revision, submission}` 草稿，`submission` 关联 operationId 和提交 revision。sessionStorage 键由 principal、Task 的 project/task 或 Test ID，以及完整执行 fence 组成；相同文本不能替代操作身份。只有相同 operation 的明确受理且 revision 未改变时才清空文本。unknown 继续查询原 operation，不重放；存储失败时保持内存编辑。账号退出或变更清 principal 草稿，换代清旧 fence；访问403即使没有快照也清归属范围。离开页面后不维持全局撤权监听，下一次访问重新授权。

composer 通过实际 scrollHeight 与宽度变化调整高度并遵守最大高度，保留 timeline 阅读空间。发送过程中记录焦点是否仍属于该输入操作，仅在页面可见、组件 active 且未转移到其他控件时恢复焦点。IME、Shift+Enter 和原生 capability gating 继续独立生效。

阅读与草稿决策的替代方案和限制见[Session 阅读与草稿决策](../../.agents/notes/implemented/bug-fix/2026-10-28-session-reading-and-draft-ownership.md)。

## 关闭与清理

网页关闭或网络断线不停止 Agent loop。worker 请求 cleanup 时，Controller 禁止新的普通发送，保留 cleanup 所需审批；先取消原活动 turn，再提交唯一 cleanup prompt，并等待该 turn 的原生结束。旧 generation 的 cleanup 记录不能禁用恢复后的新 generation。claim 进入清理时 relay 有最多 60 秒的 draining 窗口，普通发送和取消被禁止，尚未投递的 accepted 操作在同一事务内拒绝。

Controller 用 `cleanupInteractionIds` 标识清理阶段实际产生的交互。服务端冻结时保存 Timeline 序号边界，拒绝将冻结前的 pending 交互重新标为 cleanup；只有边界后且属于当前白名单的交互响应可以提交。浏览器按相同白名单启用控件，服务端在接受、Poll 投递和 operation_begin 时分别重验，避免排队期间权限变化绕过限制。

Controller 自身只能报告 stopping。worker 独立检查对应进程停止后才写入 stopped/nativeStopped，并据此清理 worktree 或创建下一代恢复 ticket。POSIX 检查 Controller 进程组及已记录原生进程身份；主动脱离进程组的后台服务仍须由任务 cleanup 停止，此证明不覆盖任意逃逸 daemon。Windows 使用不允许 breakaway 的 Job Object；跨平台支持声明仍以对应平台真实验收为准。

## 升级与安全失败

Task API 通过 `Daynight-Worker-Protocol: 2` 显式协商扩展 WorkerClaim。新 CLI 与 Web 发送此请求头，响应包含 `agentControlMode`。未发送或不能识别的版本按旧协议投影：Herdr Codex/Copilot 保留原 WorkerClaim 字段并省略 mode；Web 或 Claude claim 的 worker 键被省略，任务本身的状态、版本、依赖和资格不变。该投影仅表示客户端没有可用的 worker 摘要，持久 claim 与实际控制归属不受影响。

普通列表和详情不因项目混用执行方式而失败。带 `workerId` 的旧 worker 清单一旦含有不支持的 claim，整页明确拒绝，不能通过过滤或省略 worker 摘要把正在运行的执行伪装成缺失。无 `workerId`、同时指定 `ready=true`、`allowAgents=true` 和 `compatiblePlatform` 的旧 worker 候选查询过滤不可执行的历史 claim；保留原有排序和游标，连续全过滤页继续扫描到可见结果或末尾，每页不超过请求 limit，也不返回带后续游标的空页。其他普通列表不应用候选过滤。

未协商扩展协议的写请求携带旧 worker 限制。服务层保留原有输入校验顺序，在项目写锁内核对版本及实际 claim，然后决定是否允许更新、状态改变、删除或 worker 操作；claim/resume 还检查新 descriptor。旧客户端看不到的执行不能被当作无主任务重新认领或操作。兼容投影不作为写入依据，也不代替项目权限。

服务端可在保留既有 CLI/Herdr worker 的情况下升级；只有使用 Web 或新增 Provider 的调用方需要支持对应能力的客户端。新客户端仍将旧服务端响应中缺失的 mode 规范化为 Herdr，Herdr claim/resume 不添加旧服务端无法识别的 mode 字段。Web 新执行必须确认服务端支持相应协议，失败时不省略 mode 重试为 Herdr。选择及其成本见[Worker 协议协商决策](../../.agents/notes/implemented/architecture/2026-10-28-worker-protocol-negotiation.md)。

协议解析不授予项目权限，也不能证明原生进程停止。鉴权、持久操作去重、连接代次校验、初始化输入门控和停止证明仍必须在实际调用边界实施。故障不得通过换 ID、重建会话或提升连接代次绕过。
