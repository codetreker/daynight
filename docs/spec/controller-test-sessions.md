# Controller 独立测试会话需求

## 目标与入口

用户在本机用 `daynight controller codex`、`daynight controller claude` 或 `daynight controller copilot` 启动真实 Agent，通过 Daynight 的 Test Session 页面使用与 Task 相同的时间线和聊天输入。命令使用当前工作目录，不要求创建 Task、认领 claim、配置 worker 或指定目录和浏览器打开参数。启动输出对应的页面 URL，URL 不包含凭据。

命令可携带首条 prompt 和该 Provider 已支持的创建参数。参数沿用原生命名；不支持的参数必须明确拒绝，不能静默忽略或宣称完整原生 TUI 参数兼容。没有 prompt 时等待网页输入，有 prompt 时先完成唯一首次输入的受理与同步；不以启动成功或 native idle 冒充输入已受理。

worker 使用的 `--launch-id` 路径继续服务原 Task 执行。独立入口与内部 ticket 参数互斥。Test Session 不属于新的 `agentControlMode`，不改动 `herdr`/`web` 的任务执行选择。工作目录由用户持有，结束测试不得删除它或自动删除用户文件。

## 继续原生上下文

`daynight controller <provider> resume [test-session-id]` 继续本机已登记并确认停止的独立 Test Session。Codex、Claude、Copilot 共用此入口；不带 ID 时，交互终端列出当前真实工作目录、Provider 和服务匹配的会话供选择。非交互调用必须传入完整 Test Session ID。字面 prompt `resume` 可通过 `daynight controller <provider> -- resume` 发送。

恢复新建受登录保护的 Test Session URL，旧页面保持归档；新页面从原生持久历史还原上下文。同一个 native session ID、原 native home 与工作目录必须保持，不能在失败后静默创建另一段原生对话。原 prompt、未确认操作、排队输入和待审批响应不自动重放。恢复不覆盖原生已经确认的模型或权限；无法核实的设置仍显示未知。

选择来源限定 Daynight 本机记录，不接受任意裸 native ID，不扫描其他原生历史。当前账号必须有权读取原会话。异目录、异服务或账号、原生 ID 缺失、停止状态未知与仍有原生进程时必须拒绝；不会自动停止或接管其他执行。跨执行写锁防止同时恢复同一原生会话。只有本次启动未发生或其进程树已证实停止时释放锁；崩溃或停止不确定时保留占用证据，不能仅因 launcher PID 不存在就自动重试。

## 登录与权限

Test Session 页面必须在 Daynight 现有登录机制保护下。未登录访问时先登录，再返回同一合法站内页面；不同登录账号不能因知道 URL 获得会话访问权。只有创建该会话的用户可查看和操作。

身份验证覆盖快照、历史、资源、operation 查询、WebSocket 订阅及写命令，不能只保护页面路由。登录过期、退出、账号变化或父 CLI 凭据撤销后，受影响连接和操作必须拒绝；缓存不得把上一个账号的会话显示给下一个账号。Controller 的短期凭据只用于绑定的测试会话和执行代次，不放入网页 URL。

Test 与 Task 身份必须明确区分。Test 不伪造 task、claim、worker 或 worktree；Task 的项目权限与当前 claim 检查不能被 Test 路径绕过。操作去重、原生受理回执、交互 revision、连接代次和资源范围使用同一公共会话规则。

## Session View

登录后访问 `/test-sessions` 可浏览当前账号有权读取且在线的独立测试会话，按最近的连接观察时间排序。在线要求生命周期 active、连接为 connected 或 synchronizing、心跳未超时且连接凭据有效；已归档、离线、停止中或授权失效的记录不显示。筛选在服务端分页之前完成，不能让归档记录占据页面而遗漏后面的在线会话。列表显示 Provider、状态、创建及更新时间，使用简短标识辅助区分，点击进入完整 Session URL。列表和 Session 页之间提供直接导航；用户不必保存或手工输入会话 ID。

列表分页加载全部在线记录，支持刷新、加载更多、空态和失败重试。刷新从最新记录重新开始；分页期间会话活动可能改变排序位置，重复记录按 Session ID 合并。在线状态是读取时的观察，刷新重新确认；短暂断连不会删除会话或停止 Agent。归档身份与必要回执仍可通过原 URL 读取；停止后文件归档 ready 时，内容无需 Controller 在线即可只读加载，pending/failed/unavailable 明确展示且禁止控制；CLI resume 的本地候选不受此展示筛选影响。账号切换、退出或授权失效不得留下其他账号的列表内容。列表读取与单会话读取遵守相同的 owner 及父 CLI 凭据有效性检查。

新建仍通过 `daynight controller <provider>` 完成。列表不扫描本机原生历史，不创建或恢复 Agent，也不提供删除会话或跨账号发现能力。

Test 页面与 Task 页面复用 Session client、timeline、composer、交互卡片、资源与回执处理。仅外围身份、API 地址和授权来源不同，不维护第二份近似 UI 或模拟 transport。基础交互范围沿用 [Task Session 需求](task-sessions.md#基础会话交互)。

无 prompt 的 Test 会话在 Provider 初始化完成、Controller 持有可用 handle 且 relay 同步后才能发送第一条消息。Claude 在空会话阶段可以尚无已确认原生 ID；此时不得填造 ID，收到真实原生证据后才显示。其他首次输入门控与未知结果防重规则不因此放宽。

刷新、关闭页面、打开第二个页面及重连不创建新 Agent、不重发 prompt。未知结果保留原 operation 身份供查询，不用新的 operation 或新会话绕过不确定性。长对话中的折叠工具结果不应因无关回执变化反复执行昂贵渲染；实际可用性需在浏览器中验证。

Session View 内容遵守 [Task Session 的本机内容归属](task-sessions.md#内容归属与在线要求)。新页面需要在线 Controller 提供历史，已打开页面在离线时可保留已加载画面，但不能操作；重新上线后重新同步。resume 从本机原生数据恢复到新 URL，不依赖 PostgreSQL 聊天内容副本。

## 生命周期

独立命令在前台管理自己启动的 Controller 和原生进程，并负责会话凭据续签。Ctrl+C 停止该执行并验证进程停止；服务不可用不能阻止本机清理，未确认的服务端归档不能伪装成功。停止确认后服务保留归档身份与必要回执，会话内容留在本机；原页面不承诺离线历史回放。

网页关闭或网络短暂断开不停止 Agent loop。本机 IPC 的连接与请求受理超时不能提前终止已认证、正在等待原生受理的输入。输入请求发出后若响应丢失或超时，launcher 保留同一执行和 operation 身份，继续观察及续签，不自动重发输入，也不将通信结果未知当作停止原生的依据。若后续确认原始输入失败，即使 Provider 仍可用，也须报告初始化失败并清理原执行，不能永久续签。明确的授权或协议拒绝、原生退出及用户取消仍须按各自的失败或停止路径处理。

意外原生断开必须显示真实失败并清理拥有的进程，不静默新建会话替代原会话。独立入口不承担后台 daemon、任务调度或自动恢复循环；Task 的 worker 恢复责任继续由 [共享实现设计](../design/task-session-protocol.md)定义。

## 停止后的归档与重试

launcher 确认本机进程停止和服务端 Session 终止后上传只读历史。上传失败须明确区分“原生执行已停止”与“归档未完成”，保留本机源并输出重试命令：`daynight controller <provider> archive <test-session-id>`。该命令只核验原 ticket、停止证据、账号与服务，确认服务端停止结果并重试上传，不启动或 resume Agent，不要求原工作目录仍存在。字面 prompt `archive` 可通过 `-- archive` 发送。

归档 ready 后原 URL 展示冻结 timeline 和资源，不提供 chatbox 或任何 Agent 写操作。未启动过 Controller 的 Session 不伪造历史。文件格式与容量遵守 [Task Session 内容归属](task-sessions.md#内容归属与结束后历史)。独立原生 resume 仍建立新 URL，不改变旧归档。

## 验收边界

真实测试覆盖三个 Provider 的启动、有无 prompt、创建参数、消息和工具、审批/提问/表单、取消、刷新、多页面、窄屏、中文输入、长内容及清理。至少用该入口完成一段多轮小应用开发，独立检查文件、测试结果与应用行为；不能仅依靠 Agent 自述。

Test Session 验收不能替代 worker 资格选择、Task 认领、managed prompt、worktree、claim-bound done 和任务完成后的清理。共享实现改变时仍须回归 Task 路径，尤其原生断开、清理阶段审批及长 Unicode 历史。fixture、原生 loopback、真实在线模型和平台实测应分别记录，不相互替代。
