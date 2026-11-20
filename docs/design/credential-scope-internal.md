# 凭据 Scope 内部合同

## 目录与授权事实

`internal/core/scopepolicy` 定义稳定的业务 Scope ID、有序展示组、文案键、
PAT 与 MCP grant 的适用性以及操作所需的权限。目录返回独立副本；选择必须
是非空、适用且不重复的明确 ID 集合，规范化后按 ID 排序。目录按当前可用项
计算默认值：Team 仅选 `team:read`，MCP 不选择 Worker 执行组；Agent 执行
许可是独立组。部署显式提供可用 ID，目录快照按展示顺序分组并以分组、可用 ID 和默认集合计算 SHA-256 修订；空可用集合不会隐式扩为全部。已保存的权限不随目录增长而变化。

策略快照保留凭据类型、规范化集合和正版本。读取非法或非规范集合时必须
拒绝，组合操作需要全部权限；空策略不能代表无限权限。Principal 仍仅表示
用户与凭据身份，策略快照与可持久化 actor 分离。固定 OAuth 等原有 profile
继续由其原有绑定及授权规则处理，不能把缺失的受限策略解释为固定授权。
Scope 检查与现有凭据有效性、资源访问、角色和业务条件共同生效。

## 设备授权准备入口

显式 scoped Identity 装配使用与浏览器目录相同的 PAT 快照。浏览器 session
可读取 PAT 和 MCP 目录，并以 v2 inspect 取得待决设备请求的目录修订。v2
批准携带该修订和非空的实际选择；过时修订冲突，非法或当前不可用的选择拒绝。
拒绝不带 scope。账号绑定、短码与终态读取继续使用原设备规则，提交结果未知时
通过原请求检查状态，不重放决定。

批准在设备行锁后复核数据库时间，在同一事务保存决定、账号和规范权限集合。
领取使用原 v1 CLI form 和响应，在设备行锁后复核期限，并在同一事务消费授权、
创建带实际批准集合的 PAT。只在确认提交后交付明文，同一授权至多签发一次。
旧批准入口在 scoped 装配中不能绕过显式选择；旧生产装配仍保留原行为。
目录及 v2 设备入口在真实路由注册时声明 browser-only 分类，方法回退单独登记。

## 账户凭据管理准备入口

显式 scoped 管理入口提供 PAT 和 OAuth grant 的完整安全列表，保留原有字段，
并以 `scopePolicy` 返回规范权限集合和精确的十进制版本；固定 OAuth profile
的策略为 `null`。手动 PAT 创建使用与 CLI 相同的目录，提交实际非空选择；
明文凭据只在确认提交后返回一次。两类 scope 编辑要求主站浏览器 session、
同源请求、预期账号、目录修订及目标的预期 scope 版本。

编辑在事务中复核 session 和目标，锁后以数据库时间检查有效性，并只替换权限
字段。选择可保留或移除已保存但当前不可用的有效 ID，新增项必须在当前目录
中可用。目录修订或版本冲突要求重新读取；提交结果未知时读取列表核对，不
自动重发。PAT 期限和最近使用时间使用独立字段，不覆盖权限版本或集合。
原生产装配继续使用现有接口，scoped 管理入口由后续启用阶段显式接入。

## MCP 应用授权准备入口

显式 scoped OAuth 装配复用浏览器共享目录中的 MCP 快照。v2 inspect 沿用原请求
ID、绑定 Cookie 和当前 Session；有效待决请求返回当前 `catalogRevision`，
已批准、拒绝、消费或过期的请求只返回原安全状态。旧页面刷新后可以用原请求
继续读取；读取不恢复授权码、state 或回调秘密。

v2 decision 批准必须提交显示账户、当前目录修订和非空的实际可用 scope；
目录过时返回冲突，非法或不可用选择拒绝。拒绝不携带目录修订或 scope。
决定仍在原 Session 与授权请求事务中完成，并在等待行锁后复核数据库时间。
同一写入保存批准决定、账号、授权码 hash 和规范化权限集合。scoped 装配中的
旧批准入口拒绝缺少显式选择的批准，旧读取和拒绝保留原合同。

授权码换取在原事务中消费授权并把批准集合保存为 MCP grant 的版本 1 策略。
access 与 refresh 不复制该集合；refresh 继续读取和保留原 grant 当前策略，
包括批准后由所有者修改的策略。公开 authorize、token、refresh 和 revoke 的
资源绑定及 `daynight:mcp` scope 不变，正确绑定的授权码重放仍撤销原 family。
提交未知不能交付或重放 redirect 和 token，通过原请求状态核对决定。

v2 浏览器 HTTP 注册显式声明 browser-only 路由及方法回退，保留精确 Origin、
账户和 Cookie 绑定、严格字段解析及禁止缓存。生产 OAuth 构造和路由继续使用
原装配，受限签发与 v2 路由由统一启用阶段接入。

## 凭据存储与复核

PAT 与 MCP grant 分别保存规范化业务 Scope 和独立版本，同值写入不推进版本。
OAuth access 与 refresh 不复制权限；按 access hash 读取原 grant 的当前策略，
事务复核按 grant、access 顺序加共享锁。授权请求保存 scoped 批准的明确集合；
固定 API profile 不保存集合，继续使用原资源和客户端绑定。读取已保存的非法
策略会失败，scoped MCP 读取也拒绝缺失策略。编辑和 refresh 使用同一 grant 锁，
编辑按账户、有效状态及预期版本更新，最近使用时间独立。

准备迁移保留历史及旧写入者的空字段；现有产品签发、批准和装配维持原行为。
历史回填及 scoped 认证装配须在启用时协调；不能把尚未回填的 MCP 空字段
当作无限权限。迁移复用既有 access hash 和 grant 索引，不增加热路径索引。

## 任务读取准入与投影

Task/Goal 的详情、列表、ready、搜索、属性、schema、依赖、分组、Graph 和 Sync
读取要求 `task:read`。服务在原有凭据及项目可见性检查后、受保护数据读取前执行
准入。搜索在自己的 TaskSearch 快照内执行同一规则。明确的 scoped 构造和路由
注册复用原查询及分页。REST 读取、搜索与写入入口可组合到同一 ServeMux；
MCP 读取与写入注册各自只拥有所属工具，可组合到同一 Entry，且不重复注册。
原生产装配维持既有行为。

普通任务读取不要求 `project:read`。包含完整 Project 的 Graph 与 Sync 同时要求
该权限；REST Graph 携带 `Daynight-Projection: task-only-v1` 时，服务回显该头并
只返回 `project.id`。MCP task_graph 缺少项目读取权限时采用相同最小投影，包含
`dependsOnly`，其余节点、依赖、统计和 projection 声明保持原合同。

缺少 `session:read` 时，普通组合查询不读取任何 Session 来源或采样 live 状态。
Task 属性中的执行记录 `worker`、`sessionStartup` 被排除；普通自定义属性保留。
`include=session` 的旧线协议仍返回可解析的 `unavailable/unknown` 观察，reason 为
`insufficient_scope`，会话关联标识、存在性、状态、时间和发送资格均为空，且结果
标记 partial。Graph 和工作分组保留真实任务查询时间，工作、提示、告警数量为零，
unknownCount 只由各聚合范围内可见、进行中的普通 Task 计算，complete=false。
分组先按完整任务集合形成投影，再进行原目标分页及响应预算处理。

Sync 在同一任务快照保留所有可见、进行中普通 Task 的 taskObservations 键，
每项带真实 taskVersion 与 unavailable；不受增量任务窗口限制。旧 sessions map
为空、sessionPartial=true，Task 水位与观察完成时间仍使用任务查询的合法时间。
完整机制分别由[观察设计](task-session-observation.md)与[同步设计](daynight-task-sync.md)维护。

## Tag 目录准入

`service/tag.NewScoped` 提供显式接收 `model.CredentialAuthorization` 的目录
操作，复用原有项目快照和写事务。`core/tag.RequireAuthorization` 校验 profile
与共享操作要求；项目可见性和原有写入角色通过后，在读取 Tag 数据、用量、
目录 epoch 或修改关联前检查 scope。缺失或不匹配的策略明确失败。

| 操作 | 所需 scope | 响应 |
| --- | --- | --- |
| Get、List、Resolve、ResolveColors | `tag:read` | 原有目录、引用、颜色及用量投影 |
| Create、Update、Rename | `tag:write` 与 `tag:read` | 原有完整 Tag 投影 |
| Delete | `tag:delete` | 原有 projectId、tagId、deleted 最小回执 |

REST 的目录 `GET /api/v1/projects/{projectId}/tags`、单项
`GET /api/v1/projects/{projectId}/tags/{tagId}` 及其自动 HEAD、
`POST /api/v1/projects/{projectId}/tags/resolve`、
`POST /api/v1/projects/{projectId}/tags/colors/resolve` 对应读取。
目录 POST 与单项 PATCH 对应写入，单项 DELETE 对应删除。
方法回退保留认证与原有 405 响应，不执行目录业务。
MCP 的 `tag_list`、`tag_show` 对应读取，`tag_create`、`tag_rename`、
`tag_update` 对应写入，`tag_delete` 对应删除；工具发现和 schema 保持原合同。

完整写回执包含用量或未修改字段，因此必须在写入前同时通过读取准入。
不具备要求的组合权限时，整个操作拒绝，不读取目录内容，不修改 Tag、
关联、关联条目版本或目录 epoch。同值更新仍经过准入和原始版本检查。
删除引起的关联清理和条目 touch 属于原删除动作，不增加 `task:write` 要求；
Task/Goal 主动变更标签关联仍由任务写入准入负责。项目资源访问检查不隐含
额外的 `project:read` scope。

REST 与 MCP 的显式 scoped 注册入口共享现有解析、业务操作和响应映射。
REST 对可靠的权限拒绝保留 HTTP 403 与 `forbidden` 错误对象，附加
`Daynight-Scope-Status: insufficient_scope`。MCP 沿用业务 envelope，返回
`insufficient_scope`，写入拒绝为 `not_committed`。提交未知和清理失败继续
使用原有完成语义，不能表述为确定的权限拒绝。

## Task 写入准入

Task 写入服务按解析后的字段合并所需操作，项目访问、原有角色、版本、
依赖和 claim 规则继续生效。创建的默认值不增加权限；显式非默认负责人和
平台使用 `task:assign`，依赖与父 Goal 使用 `task:dependencies`，普通状态
和阻塞属性使用 `task:status`。标题、普通属性和 Task Tag 关联使用
`task:write`，显式 `allowAgents` 使用 `agent:authorize`。删除使用
`task:delete`，带 claim 的完成使用 `worker:complete`。组合缺少任何一项
时不执行部分写入；Task Tag 关联不授予 Tag 目录修改权限。无 `task:read`
时，错误保留原错误码和完成结果，但不返回已有依赖的 Task ID。

显式 scoped REST 与 MCP 写入口将认证策略和响应选择传给同一服务准入。
原完整 Task 或属性响应需要在写入前取得 `task:read`。REST 请求
`Daynight-Return: receipt-v1` 时成功响应回显该 header，并仅返回
`projectId`、`taskId` 和数值 `version`。MCP 的 `returnView: "receipt"`
返回相同身份和十进制字符串版本及既有写入结果；省略视图且受限凭据缺少
`task:read` 时选择该回执，显式 summary/full 需要读取权限。省略 MCP
版本时的现有预读同样需要 `task:read`。服务在提交前检查实际 MCP 回执的
响应容量。Goal 依赖编辑保留原最小回执。

直接写入使用本次认证的策略快照；既有生产装配保持原行为，scoped 写入
入口由启用阶段接入。决策及取舍见[Task 写入准入记录](../../.agents/notes/implemented/architecture/2026-11-20-task-write-scope-admission.md)。

## Worker 任务执行准入

领取、执行状态上报、释放及撤回分别使用 `worker:claim`、`worker:report`
和 `worker:release`。带 claim 的完成继续使用 `worker:complete`。这些检查
与原项目访问、执行归属、版本及 claim 校验共同生效；原完整 Task 响应仍需
`task:read`，显式最小回执只包含身份和版本。`agent:authorize` 只控制
`allowAgents`，不授予实际执行能力。

Task Session 恢复 grant 在原有服务端请求入口复核 `worker:retry` 与
`session:produce`，并保留原 claim、owner、代次和停止证明检查。旧生产
装配保持原行为；scoped 路由与授权事实由启用阶段接入。CLI 的本机操作
继续遵守其现有语义。

决策见[Worker 执行准入记录](../../.agents/notes/implemented/architecture/2026-11-20-worker-execution-scope-admission.md)。

## 附件准入

`service/attachment.NewScopedAttachments` 显式接收授权事实，复用普通附件服务的
资源检查、上传容量和文件 gate。项目与 Task 可见性先于 scope 拒绝，附件元数据、
内容和文件副作用均在 scope 准入之后访问。项目可见性检查不要求额外的
`project:read` 或 `task:read` scope。

MCP 私有传输的显式 scoped 服务在每个新读和分块写入准入中，按原 PAT ID 或
OAuth Grant ID 锁定当前凭据并读取策略；同一 Grant 的新 access 可续取。下载的
读后 Touch 与快照发布在原事务内复核 `attachment:read`，上传块和最终发布复核
`attachment:upload`。完整附件元数据回执另需 `attachment:read`。最终发布在
附件事务中、文件副作用前复核；原内部回执结算和清理不因后续权限收窄而中断。
重试已有传输时，权限拒绝本身不证明原操作未提交；只有能够确认未提交的写入才
返回 `not_committed`。传输记录不保存 scope，生产装配继续使用原入口。

| 操作 | 所需 scope | 准入与输出 |
| --- | --- | --- |
| List | `attachment:read` | 同一读取快照中准入后获取目录及分页元数据 |
| Open | `attachment:read` | 取得目标 gate 后权威读取原凭据当前授权，再获取元数据和稳定文件句柄 |
| Put、PutRetained | `attachment:upload` 与 `attachment:read` | 开始上传前同时准入，返回原完整附件元数据 |
| Delete | `attachment:delete` | 原变更事务确认资源访问后准入，删除字节和元数据 |

上传完整响应包含覆盖前保留的创建时间，因此写入前也要求读取权限；仅有上传
权限不能先发布文件再因读取权限不足拒绝回执。删除返回原最小成功结果，不要求
附件读取权限。已准入的上传或已打开的单次流保持原有完成语义，scope 编辑不使
文件与元数据的既有完成事实失效。

Open 的权威读取保留原 Principal 和 profile，校验当前策略；缺少复核能力、
凭据失效或身份不匹配均拒绝交付。原 request context 穿过 gate 等待、授权与文件
操作；打开后不为每个字节重新鉴权，也不在流 I/O 期间持有凭据行锁。

REST 的显式 `RegisterScopedRoutes` 复用原解析与流响应。附件列表及自动 HEAD、
文件 GET 及自动 HEAD 对应读取，PUT 对应上传完整响应，DELETE 对应删除。
主站 preview GET 保留原无需业务授权的跳转；preview HEAD 必须经过 scoped Open。
独立 preview host 仍只通过原 preview Cookie 路径读取，不新增 PAT/MCP 预览入口。
实际注册同时提供按 host 区分的观察记录，覆盖自动 HEAD、preview HEAD 读取分支、
公开跳转、Cookie 专用入口和方法回退，供全量启用时核对。
方法回退保留原认证和 405。权限不足沿用 403 `forbidden`，并附加
`Daynight-Scope-Status: insufficient_scope`。

普通 MCP 的显式 `RegisterScopedAttachmentTools` 为 `task_attachment_list` 和
`task_attachment_remove` 传递原调用授权，分别执行读取和删除准入。工具 schema、
发现和原完成结果不变；权限拒绝为 `insufficient_scope`，删除拒绝标为
`not_committed`。私有分片上传、下载票据及其事务复核由独立传输服务负责。


## 账户与集成准入

账户资料、Worker 与 Reviewer Prompt、用户可见用量及 GitHub 用户操作的
scoped 服务入口接收明确的 `model.CredentialAuthorization`，并通过
`scopeadmission` 检查操作所需的全部权限。原有身份、资源可见性和角色检查
继续适用；固定 session 与 OAuth API profile 保留原有限制。权限不足时，
已确认可见的资源使用原有 `403 forbidden` 响应和
`Daynight-Scope-Status: insufficient_scope`，不可见资源与凭据失效保持原有
拒绝。真实路由注册同时记录操作、自动 HEAD、回退和独立 profile 分类。

账户资料更新需要 `account:write`；`GET /api/v1/me` 保留自省行为。
Prompt 读取需要 `prompt:read`，原 PUT 回执包含既有资源事实，因而需要
`prompt:write` 与 `prompt:read`。用户用量读取需要 `usage:read`，能力检查、
生产者和专用上传凭据沿用原协议。普通项目 PR 投影使用 `project:read`；
GitHub 集成读取及管理分别使用 `github:read` 和 `github:manage`，返回既有
资料的管理写入还需要读取权限。

先以窄查询确认目标和原有业务权限，再检查 scope，最后读取受保护投影或
执行写入。账户和用量的既有事务内凭据复核同时复核当前策略；缺少复核
能力时受限入口失败关闭。GitHub 操作在远端证明或跨阶段定位后继续时，
重新取得原凭据当前策略；涉及事务内凭据复核的路径在该事务中复核。

## Team 准入

`service/team` 的 scoped 构造入口接收明确的凭据授权提供器；Team 不可见时
保留原有拒绝，确认可见后检查实际操作的 scope，再判断原角色、版本和其他
业务条件。已有事务内凭据复核的成员操作使用同一事务或快照中的当前授权，
并在原复核点重新检查。缺失或不匹配的授权不能放行。

Team 和成员读取需要 `team:read`；创建和改名需要 `team:write`，改名的
完整响应还需要 `team:read`。成员管理使用 `team:members`，返回既有成员
投影的操作还需要 `team:read`；本人退出使用 `team:leave`，删除使用
`team:delete`。已发邀请使用 `team:invitations`，本人邀请查看与接受分别
使用 `team:invitation-read` 和 `team:invitation-accept`。原有完整接受响应
还需要邀请读取权限；最小服务回执只需接受权限，两者都不要求 `project:read`。
MCP 的 Team 项目列表同时要求 Team 读取和项目读取，预读与变更分别执行准入。

Team REST 使用受保护服务时保留原有解析和响应；MCP 提供显式 scoped 注册，
保持原工具 schema。权限拒绝沿用上文的 HTTP 和 MCP 错误合同。原角色和资源
规则仍独立生效，不因 scope 获得成员或管理员身份。

## Bot 定义准入

`service/bot` 的 scoped 构造入口接收授权事实来源；读取使用当前快照，创建和
删除在各自写事务中取得与原 Principal 绑定的当前策略。OAuth 事务按 grant、
access 的顺序锁定，原凭据、归属和删除协调检查继续生效。缺少策略、身份
不匹配或所需 scope 时不能作为固定 profile 放行。

| 操作 | 所需 scope | 响应 |
| --- | --- | --- |
| 定义 Get、List、ListWorker | `bot:read`、`session:read` | 原完整 Bot 投影，包含 Session 标识和启动结果 |
| Create、CreateResolved | `bot:write`、`bot:read`、`session:read` | 原完整 Bot 投影；在解析及写入前检查，并在写事务内复核 |
| Delete | `bot:delete`、`bot:read` | 原删除责任和清理状态；沿用 Session 准入撤销及清理协调 |
| Defaults | `bot:read`、`worker:read` | 原 Worker 和默认配置投影；主动模型发现另需 `worker:inspect` |
| Observation | `bot:read`、`session:read` | 原 Bot 与 Session 运行观测；采样前后复核 |

HTTP 请求显式携带 `Daynight-Bot-Attention: 1` 并请求完整定义投影时，另需
`assistant-task:read`；创建在写入前复核该权限。MCP 的 `bot_list`、`bot_show`、
`bot_create`、`bot_delete` 保留既有输出，不请求该投影。创建所需的内部模型
发现遵守 Bot 准入及原 Worker 资源检查，并在每次发现前复核当前权限；它不把
独立 Worker 检查能力授予 Bot 定义凭据。

既有 Bot 或指定 Worker 的可见性检查先于 scope 拒绝，分页读取、定义写入和
删除屏障在授权后执行。可靠的 scope 拒绝在 REST 保留 403 `forbidden` 并附加
`Daynight-Scope-Status: insufficient_scope`；MCP 返回 `insufficient_scope`，确定
拒绝的写入标为 `not_committed`。提交或清理结果不确定时保留原错误语义。

## Session 读取与订阅准入

Session 的 scoped 读取沿用原 Task、Test Session、归档及 Terminal 的资源和
角色检查，并在对应事务或只读快照中复核原凭据的当前 `session:read`。PAT
复用凭据行锁；OAuth 按 grant、access 顺序锁定并保留原资源与客户端绑定。
历史目录和 inspection 使用同一只读快照，inspection 在采样前后分别复核。
缺失授权来源、身份或 profile 不匹配均拒绝，不能把缺失策略解释为固定授权。
启用装配需要接入绑定对应事务或快照的当前凭据读取。

Task 与 Test Session 的状态、历史、操作回执、内容、Terminal 及归档读取，
以及 Task 历史目录和 inspection 使用独立的 scoped 接线。MCP 的
`task_session_current`、`task_session_list`、`task_session_show`、
`task_session_read`、`task_session_entry` 和 `task_session_operation` 共享这些业务准入，保持原工具
schema 与资源绑定。用户通道在握手及每次投递前复核当前权限，撤权后停止
后续投递并关闭连接、释放资源；网络 I/O 不持有凭据事务。能力查询、生产者
与命令入口保留各自的协议和准入责任。

图片 occurrence 的状态和重试使用下文的图片准入。只装配 scoped 读取而未
安装事务内命令准入时，PAT 的状态读取和重试在业务操作前失败关闭；Cookie 和
固定 OAuth API profile 保持原有规则。

## Worker 报告与检查准入

`service/worker.NewScopedWorkers` 及 `NewScopedWorkersWithPrompts` 显式启用业务
准入，原构造器保持原装配。`AuthorizationSource` 必须在传入的 Worker 写事务、
读取快照或 Prompt 快照中读取与原 Principal 相同的当前凭据事实。Worker 写入
期间保持凭据策略锁，OAuth 按 grant、access 顺序锁定；缺失来源、错误策略或
身份不匹配均拒绝。启用装配需要为这些作用域提供真实事务绑定的授权读取器，
不能以请求开始时的旧快照或独立事务代替。

| 操作 | 所需 scope | 判定边界 |
| --- | --- | --- |
| Worker 列表、详情、配置、别名、评审参与及监控读取 | `worker:read` | 读取快照；监控读取 Redis 后再次复核 |
| 配置、别名及评审参与修改 | `worker:configure`、`worker:read` | 写事务，保留原完整回执 |
| 评审 PR 列表 | `worker:read`、`project:read` | 原项目可见性与列表快照 |
| 普通报告与监控生产 | `worker:report` | 报告写事务或原监控准入快照 |
| 带配置交换的报告 | `worker:report`、`worker:read` | 报告写入前；原回执包含完整 desired |
| 报告实际改变 desired | 另需 `worker:configure` | 同一报告事务内的最终候选与已锁目标比较 |
| 报告提交后的 Prompt 选择 | `prompt:read` | 独立 Prompt 快照；拒绝只影响逐项结果 |
| readonly 主动请求 | `worker:inspect` | 派发前、结果交付及返回前复核原请求者 |
| readonly 生产者连接、检查与结果生产 | `worker:report` | 原 PAT 当前权限复核，失权关闭通道 |

`core/worker.ExchangeConfigurationAuthorized` 在实际 desired 写入前检查配置
权限，覆盖首次 Bootstrap、独立 ToolPathsBootstrap、typed 与 Raw 目标。已有
Bootstrap 或已采纳工具的无变化请求不额外要求配置权限；观测写入继续属于报告。
权限不足时报告事务整体拒绝，telemetry、目标和观测不发生部分提交。

`ReportSync` 先确认报告提交，再读取提示词。提交后的权限拒绝按现有逐项
`error`/`unavailable` 返回，不读取提示词正文，也不把已提交报告表述为失败。
客户端继续按没有有效 Prompt 的既有行为处理。

`service/worker.NewScopedReadOnly` 使用同一身份事务中的 `LockActivePAT` 与
`PATScopeDAO.ReadLockedPATScope` 分别确认有效性及当前策略；原有效性查询本身
不携带 Scope。Session 和固定 API OAuth 保留原身份及应用绑定。Broker 使用
独立 requester、producer 授权函数，主动检查不隐含 Worker 配置读取许可，
生产者不要求主动检查许可。请求者失权只拒绝对应结果，生产者失权断开共享
连接并释放待处理请求。

Worker 的显式 scoped HTTP 注册复用原解析与响应，要求 scoped 服务和认证。
readonly 注册配合 scoped Broker 使用。实际注册的 `ScopeRoute` 包含普通操作、
配置报告的动态分支、自动 HEAD 及方法回退；显式禁止的 HEAD 仍按回退处理。
HTTP 权限拒绝保留 403 `forbidden` 和 `Daynight-Scope-Status`，不改变提交未知语义。

## Session 命令准入

`service/session.NewScopedCommands` 接收事务内授权来源。发送文字、纯图片或
混合消息需要 `session:send`，取消、交互响应和设置或命令控制需要
`session:control`。原有身份、资源归属、角色及状态检查继续生效。Task、Test
和 Bot 的用户命令共享同一准入；固定 profile 保留原绑定限制。

首次提交返回原最小受理回执。重放先只探测 operationId 是否存在，存在时在
加载旧意图、比较 hash 或返回回执前检查 `session:read`；回执查询也需要该
权限。每次 offer 和最终 begin 在同一 Session 事务内以持久原 Actor 读取当前
凭据策略，并与状态更新或拒绝回执一起提交。撤权的未派发操作逐项拒绝，
已进入派发或已被 Provider 接受的事实继续按原回执规则结算。凭据读取错误
不会伪装成已确认的拒绝。

事务能力提供与 Session 写入共用事务的 PAT 与 OAuth DAO。PAT 复核锁定原
凭据并检查有效期；OAuth 按 grant、access 顺序锁定并读取当前 grant 策略。
scoped 命令服务显式装配后使用这些能力，原生产装配保持不变。
同时启用 MCP 命令与回执时，组合注册持有构造时安装了不可替换命令准入的
Execution；替换服务的公开执行字段不会改变该入口实际调用的实例。
启用时，`NewScopedCommandsAndProducer` 在同一 Session 服务装配命令和
生产者准入；各自的 scoped 构造入口只安装其对应的规则。

## Session 图片出现状态和重试

图片出现状态读取在原 Session 资源准入后、结算前检查 `session:read`。已有
attempt 的完成结果仍按原记录结算，已验证的 copying 继续由原 Controller
生产者及 fence 负责；状态读取不会创建新来源请求或替换 locator。只有具备
`session:control` 且符合原业务条件时才返回 `retry_source`。控制权限不足
仅隐藏该动作；身份和存储等其他授权错误仍向调用方返回。

重试 POST 在写入、计费或生成完整回执前同时检查 `session:control` 和
`session:read`。真实 Task 和 Test Session 路由及隐式 HEAD 在注册时记录这些
权限和动态投影，原生产装配保持不变。具体权衡见
[图片准入决策](../../.agents/notes/implemented/architecture/2026-11-20-session-image-scope.md)。
scoped 路由绑定构造时安装了命令准入的原 Execution；仅读取装配不能放行
这些受限凭据。

## Session 生产者准入

Session 与用量生产的 scoped 装配在实际操作所属事务或快照中读取原 PAT 的
当前策略，要求 `session:produce`。Task 注册检查实际调用凭据；后续 Controller
操作使用连接绑定的父凭据，保留原 claim、执行代次和连接 fence。Test 与 Bot
Session 的当前 grant 父凭据和活动连接父凭据可能不同：同代重连更换 grant 后，
旧连接仍须分别复核两者的有效性和生产权限。同一凭据只需一次策略检查。
Bot 授权恢复在事务中撤销旧连接 lease 后，旧连接父凭据不再参与新 grant 的
消费；正常同代重连保留旧 lease 时仍分别复核两者。
用量上传凭据保留原父凭据和资源绑定，不能凭新连接的权限替代原父凭据。

注册、签发及新生产操作在相应阶段拒绝权限不足；已有持久结果不因撤权改写。
恢复和重试仍遵循各自的原身份、回执和完成语义。固定 profile 继续受原协议和
资源约束，受限入口不将缺失的 PAT 策略解释为无限权限。具体权衡见
[Session 生产者准入决策](../../.agents/notes/implemented/architecture/2026-11-20-session-producer-scope.md)。

## 装配边界

生产仍使用既有业务装配，尚未启用
受限凭据签发或这些 scoped 入口。scoped 入口只接受显式授权事实，不以缺失 policy
放行。PAT 与 MCP 已具备策略存储与复核能力；完整入口分类、历史回填和公开
启用由相应实现接入。Tag 的直接操作使用调用方
已认证的策略快照；附件 Open 的权威读取与 scoped Bot 授权事实来源由启用阶段
接入对应凭据的当前读取。

目录准入的取舍见[决策记录](../../.agents/notes/implemented/architecture/2026-11-20-tag-scope-admission.md)。
附件准入与完整上传回执的取舍见[附件决策](../../.agents/notes/implemented/architecture/2026-11-20-attachment-scope-admission.md)。

## Steps 与讨论准入

Steps 读取使用 `step:read`。既有 REST 写响应包含完整 Steps 集合，MCP 写响应
也包含已有数据，因此写入需要 `step:write` 与 `step:read`。权限检查在原项目
访问及写入角色检查后、读取 Steps 内容或修改之前执行；版本、排序、容量和
事务完成语义保持原有规则。项目资源检查不隐含 `task:read` 或 `project:read`。

讨论读取使用 `thread:read`，发帖和回复使用 `thread:post`。REST 原响应包含
既有作者资料，因此还需要 `thread:read`；指定 `Daynight-Return: receipt-v1`
时仅返回项目、任务和新消息 ID，并回显 header。MCP 按事务中的当前策略选择
原消息响应或最小回执。项目访问、有效凭据和指定 claim 的真实执行归属仍分别
检查。发帖在原 Thread 事务中读取当前策略，OAuth 按 grant、access 顺序锁定，
与 grant 编辑保持互斥；读取使用原快照中的当前策略。失败继续区分确定未提交
和提交结果未知。

REST 的 Steps 集合及单项 GET（包括自动 HEAD）对应读取，集合 POST、单项
PATCH、DELETE、status PUT 和 position PUT 对应写入；方法回退不执行业务。
讨论 messages GET（包括自动 HEAD）对应读取，POST 对应发帖。MCP 的
`task_step_list`、`task_step_show`、`task_thread_read` 对应读取，
`task_step_add`、`task_step_update`、`task_step_set_status`、`task_step_move`、
`task_step_delete` 和 `task_thread_post` 对应各自写入。显式 scoped 注册入口
复用原解析与资源检查，原产品装配保持不变。
