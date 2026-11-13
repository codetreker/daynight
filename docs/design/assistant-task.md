# 助手任务服务端

[CLI 设计](assistant-task-cli.md)定义命令、私有认领状态和只读恢复；[Worker 维护](worker-bot-runtime.md#助手任务维护)负责持续续约、接手、通知、定时触发和应用挂载。

[规格](../spec/assistant-task.md)拥有通用行为，[认领合同](assistant-task-claims.md)拥有凭据状态、固定租期、操作指纹和未知结果恢复。助手任务使用独立的用户归属资源，不复用项目 Task、Worker 调度 claim 或 Thread。

## 分层与装配

`core/model` 定义持久模型与认领观测，`core/store/assistant_task_contract.go` 定义数据库中立的 DAO、预期条件、查询位置和事务合同。`core/assistanttask.Module` 执行权限、状态转换、规则校验和跨表候选生成；`service/assistanttask.Tasks` 将它绑定到同一 `AssistantTaskScope`，解释真实事务完成结果。`service/application` 公开该实例，`server/assistanttask` 负责 REST 解析、响应编码和错误映射。

用户凭据与可选 Bot ID 组成 `Actor`。HTTP 严格检查 `X-Daynight-Bot-Id` 的规范 UUID 格式，core 在事务内核验归属与删除状态。协议预检查不代替数据库准入。业务模型不直接作为 HTTP DTO；响应显式选择字段，版本、代次和 episode 编码为十进制字符串，时间为 UTC，令牌及其摘要不进入公开输出。

应用通过 `Tasks.RegisterRules(application, validator)` 注册 `ValidateRules(old, new) (widens bool, err)` 能力。注册表拒绝空名称、空函数与重复注册。创建手册、提交提案、修改后决定与回退共用该边界；未注册应用只接受空规则。普通任务不拥有 Watchdog 的类别、动作或次数策略。

## 存储与事务

迁移 `071_assistant_tasks.sql` 增加下列独立资源；每行保存 `owner_user_id`，所有 DAO 查询带 owner 条件。迁移与 `schema/current.sql` 同步，不改写历史迁移，也不新增外键或 CHECK。

| 表 | 持久职责 |
| --- | --- |
| `assistant_tasks` | 定义、状态、当前手册版本、认领字段、版本及记录时钟头 |
| `assistant_task_claim_operations` | `(owner_user_id, task_id, operation_id)` 唯一的成功认领操作回执 |
| `assistant_task_manual_versions` | 只追加的正文、规则、来源及提案引用 |
| `assistant_task_appendix` | 引用工作记录的经验、作者、编辑状态及版本 |
| `assistant_task_proposals` | 基准版本、候选正文与规则、证据、扩大标记及用户决定 |
| `assistant_task_items` | 应用键、episode、跟进 Bot、状态、应用私有 JSON 与版本 |
| `assistant_task_records` | 只追加的事实、判断、动作、问答及引用 |
| `assistant_task_events` | 目标 Bot、负载、投递与关注状态、确认操作身份 |
| `assistant_task_inquiries` | 双方 Bot、问题与回答、状态和固定截止时间 |

非空应用标识在同一用户的未删除任务中唯一。事项在同一任务内以打开状态的应用键唯一；通用模块不推导 episode 或异常复发策略。索引分别服务 owner 任务分页、任务材料分页、事项记录分页、目标 Bot 待投递事件和到期问答查询。查询先在数据库中执行筛选、排序及 `limit+1`，core 生成绑定 owner、任务、资源种类和筛选条件的游标，每页最多 200 项。

`WriteAssistantTask` 使用 ReadCommitted 事务。凭据共享锁保护撤销交错，Bot 共享锁保护删除交错。任务行是同一任务材料和认领变更的共同互斥范围：仅对单个子资源做 CAS 无法同时保护暂停、删除、手册基准、租约和事项转移。core 在该范围中重读并决定，DAO 仍以明确版本和认领条件执行实际写入，零命中返回冲突。锁等待接受请求取消与 deadline。

创建尚无任务行可锁，因此使用按规范 task ID 命名的事务 advisory lock，覆盖初版手册、创建指纹读取和插入。插入继续使用 `ON CONFLICT DO NOTHING` 保护 ID 及应用唯一性。相同请求身份返回原定义，不同内容或已删除身份不重新创建。任务删除保留最小 tombstone，以阻止旧身份恢复；业务材料和操作回执在同一事务中删除。

时间由数据库提供。受保护写入在锁等待后取当前时间，最终返回事务 callback 前再次核验凭据、相关 Bot 和原租约期限；不能用事务起点 `now()` 证明等待后的有效性。认领回执中的 `admittedAt` 是事务内准入时间，不是 COMMIT 时间。公开任务观测的时间与 holder 删除状态来自同次数据库投影，不能给旧数据附上一次较新的时间读取。

记录写入在任务记录头保护下使用数据库真实时钟，沿用 Thread 的有界前进机制；不能用 `head+1ms` 合成未来时间。成功写入返回实际持久位置，下一页以 `(created_at, id)` 继续。同一事务中的附录、问答和系统记录保持真实顺序。

## 认领与完成结果

认领、转交、绑定、续约及释放全部由 core 生成候选和回执，DAO 在同一事务保存。首次认领或接手推进 generation 并绑定调用 Bot 的预存令牌；转交推进 generation、指定目标并清空旧凭据，进入 pending。绑定仅写入目标自己的摘要和绑定操作 ID；续约仅延长期限。转交与接手在同事务中更新打开事项的 follower，保留应用状态和既有操作身份。

DAO 的认领预期条件包括版本、holder、generation、摘要和需要时的活租约。权限与 Bot 删除屏障覆盖整个事务；最终租约复核失败使材料和成功回执一起回滚。返回结果把不可变的 `operation` 和独立的 `currentClaim` 分开，回放不重复修改或延长租约。

service 区分 `committed`、`not_committed`、`unknown` 及清理失败。只有确认提交后才返回成功资源；未知结果映射为 503 `claim_outcome_unknown`，不自动重试。读取原操作不存在只表示该次观察未看到回执。详细的规范请求数组、HTTP 字段和恢复条件见[认领合同](assistant-task-claims.md#http-合同)。

## 手册与协作

附录、修订、事项、记录、事件和问答共享任务归属与暂停/删除准入。负责 Bot 的工作修改需要当前认领；非负责 Bot 的介入记录和问题使用独立规则，不能借此修改手册或应用状态。提案 `widens` 来自注册的应用校验器，用户决定前不改变当前手册。用户决定和回退按调用方的任务版本执行，成功时追加手册版本并更新当前指针。

问题保存创建后 5 分钟的 deadline，目标来自打开事项的 follower 或任务 holder；已关闭事项的历史 follower 不改变当前问题路由。正常回答与超时转换分别保存记录和通知。转交保留问题 ID 和原始 `toBotId`，当前有效 holder 可以承接未结束问题，用 `answerBotId` 明示实际回答者。新负责助手由转交或接手通知读取现有材料，不伪造原目标的回答。读取或拉取事件时按 open、deadline 和提问方范围有界选择到期问题，再在任务锁内重读并条件更新；已回答或已超时的问题不会重复生成通知。服务端不运行新的调度循环。

问答分页在所属任务锁内取得数据库观测时间，按该时间判定 open 与 timed_out 的筛选条件，再执行游标与 limit+1 查询。返回页中的到期问题与对应记录、通知在同事务中持久转换，页面 observedAt 保留筛选所用时间。后台批次之外的到期问题不能作为 open 返回，也不能因其他事项的积压而从 timed_out 页面遗漏；只读取 open 的客户端仍推进有界超时维护。

事件保存 pending、delivered 或 expired 与独立的 `attention`、`seenAt`。确认使用客户端 operation ID，可选 `state` 为 delivered 或 expired，省略时为 delivered；指纹包含该结果状态，重复确认不制造新事件，也不能改变结果。expired 不写入 `deliveredAt`，其适用性由应用决定，转交不会自动判定所有旧事件无效。普通关注在用户查看时标为已看，待决定提案由最终决定清除，不能借过期确认清除。Session 输入的发送与恢复、Bot 列表计数和网站展示由消费者负责，事件 delivered 不证明用户已经看到内容。

定时配置为 `null`、`{"kind":"interval","minutes":N}` 或 `{"kind":"daily","time":"HH:MM","timeZone":"IANA"}`。`N` 为至少 1 的整数，daily 使用有效的 24 小时时间和 IANA 时区，未知键拒绝。服务端保存配置，当前负责 Worker 计算到期时间；它不能因暂停仍续约而继续触发。

## REST 资源

所有路径使用 `/api/v1/assistant-tasks`。创建请求包含 `id,name,purpose,scope,kind,takeover` 和 `manual:{body,rules}`，可选 `application,trigger`。`kind` 为 `continuous` 或 `once`，`takeover` 为 `manual` 或 `auto`。返回独立助手任务；子资源路径以 `/{taskId}` 为前缀。

| 资源 | 操作及条件 |
| --- | --- |
| 集合及任务 | GET 列表/详情；POST 创建；PATCH 用户修改；DELETE 用户删除，修改与删除用 `ifVersion` |
| `claim, renew, release, transfer, claim/bind` | POST 认领类操作；字段与指纹按独立认领合同 |
| `claim-operations/{id}` | GET 历史回执及当前认领 |
| `manual, manual/versions, manual/versions/{manualVersion}` | GET 当前手册、版本页和历史版本 |
| `manual/rollback` | POST 用户回退，带任务 `ifVersion` 和目标 `manualVersion` |
| `appendix, appendix/{id}` | GET 列表；POST 负责 Bot 追加；PATCH/DELETE 用户编辑或删除，带任务 `ifVersion` |
| `proposals, proposals/{id}/decision` | GET 列表；POST 负责 Bot 提案；POST 用户决定，带任务 `ifVersion` |
| `items, items/{id}` | GET 列表/详情；POST/PATCH 负责 Bot 写入，更新另带事项 `ifVersion` |
| `records` | GET 可按事项分页；POST 有明确作者的追加记录 |
| `events, events/{id}/ack` | GET 可按目标和状态分页；POST 负责 Bot 产生事件；POST 目标 Bot 用 `operationId` 确认 |
| `inquiries, inquiries/{id}/answer` | GET 列表；POST Bot 提问；POST 负责目标 Bot 回答 |

跨任务事件拉取使用 `/api/v1/assistant-task-events`，以 `targetBotId` 筛选；Bot 请求省略时使用自身身份。`POST /api/v1/assistant-task-events/attention` 接受目标 Bot，执行用户查看后的关注清除。所有查询参数、请求键、UUID、版本类型和 Bot header 均严格解析；不得通过多余字段表达另一种操作。

## 验证责任

core 单测以受控 DAO 事实和权威时间验证状态、权限、租约、规则扩大、手册基准及问答超时。HTTP 保留真实解析、路由、DTO 和错误映射，检查拒绝时下层没有被调用。service 测试执行真实事务 callback，分别控制业务结果与完成/清理结果，不把 mock 写入视为持久证据。

PostgreSQL 测试使用独立实例，以锁或操作屏障验证并发竞争、等待后失效、凭据与 Bot 删除屏障、实际 CAS、记录时间、回执和材料的原子提交/回滚及跨用户隔离。正常 API integration 通过现有 `TestServerAPINormalFlows` 入口连续读写同一任务，包括转交后的事项与原操作身份、目标绑定和手册历史。验证命令为 `scripts/check.sh`、`scripts/startup-shutdown.sh` 和 Linux 的 `scripts/integration.sh`；真实 Worker 接收和跨 Worker 文件恢复仍由 CLI/Worker 及产品验收负责。

结构取舍见[服务端决策](../../.agents/notes/implemented/architecture/2026-11-12-assistant-task-server.md)。

## Watchdog 应用

Watchdog 由持有有效认领的 Worker 通过 `registerApplication` 挂载，每 60 秒评估一次，
不占项目任务并发名额。应用复用[Session 观测语义](task-session-status.md)，不修改
Session 状态判定。它读取用户可访问的项目及各项目 `task-work` 的本人进行中任务，
遍历任务组与贡献者分页，再读取完整任务观测。已有事项对应的任务从列表消失时，
仍须读取原任务确认结束或重新指派；权限或读取失败不能作为解决证据。

| 类别 | 持续时间 |
| --- | --- |
| 停滞 | 10 分钟 |
| 断线或停止 | 5 分钟 |
| 等待输入 | 10 分钟 |
| 无执行 | 10 分钟 |
| 不可观测 | 15 分钟 |

`freshUntil` 过期优先归为不可观测。事项以项目任务 ID 为键，`appState` 保存首次
观测时间、报告类别、关闭时间、复发标记、原发送操作和待写入的通知。类别变化
更新同一打开事项并重新计时。只有可信 working 观测或确认不再属于监控范围才
关闭事项；关闭记录保留前后观测、最近输入和历史进展，原因未知时不推断原因。
关闭后 30 分钟内同类异常重开原事项，保留 episode 并标记复发。复发后短暂恢复、尚未达到报告阈值，也保留历史复发身份和原操作；再次复发不能恢复直接处理额度。

### 规则与直接处理

`core/assistanttask/watchdog` 注册服务端规则校验，创建手册、提案、决定及回退
共用该校验。规则是数组，每项包含唯一 `id`、`category:"stalled"`、可选 `match`
和 `action:{kind:"send_message",message:非空文本}`。`match` 只接受 `contains`、
`regex` 和 `projectIds`，各条件同时满足才匹配 Agent 最后一条消息。正则有
1024 字节上限，并限定为 Go 与 JavaScript 共同支持的语法；重复次数须使用无前导零的规范整数，裸锚点不能直接量化。Worker 的正则执行
有独立时限。未知字段、越界类别或动作在持久化前拒绝。旧版通用应用保存的空对象 `{}` 仅作为旧手册的空规则基线参与校验，允许提案、决定或回退将其替换为有效数组；新规则仍拒绝对象形式。Worker 读取旧空对象时按只报告处理，非空对象仍拒绝。

`widens` 对新增规则、移除或放宽文本条件、扩大项目范围标记扩大。正则表达式
变化与动作消息变化按保守策略标记扩大，不尝试证明任意正则之间的集合包含关系。
附录不参与匹配，用户批准前提案不改变有效规则。

直接处理要求停滞已达时长、未复发、事项从未尝试、当前 Session 允许发送、
完整历史证明最近两分钟没有其他输入，以及原助手认领仍有效。历史输入没有时间戳时，应用在完整读取后保存输入身份与首次观测时间；同一 Session、claim、generation、connection epoch 和历史内容连续保持至少两分钟，才构成保守的安静区间证据。读取不完整、身份或内容变化、时钟倒退、相邻观测超过两次轮询间隔均重置该区间。发送前再次完整读取并匹配证据。读取失败、缺少安静区间证据或截断的最后一条 Agent 消息都不能支持直接发送。发送前把固定操作 ID、
原 Session/claim/generation 和消息写入事项；即使在保存之后、提交之前退出，
恢复也只查询原操作，不补发。每个事项最多尝试一次，手册变化不重置该限制。

动作结果写入记录，并通过事件由助手报告。成功的 `direct_success` 不点亮关注；
`report`、`escalation` 和 `result_unknown` 需要关注。后续观察基准 `followUpSince` 在发送调用返回后保存，原准备时间 `at` 保持独立；恢复时若没有已保存的基准，则在首次原操作查询后保守开始计时，已有基准不重置。自该基准起十分钟内没有新的有效
历史条目且活动未恢复 working 时升级；进展比较使用稳定的条目 ID 与 revision，历史 epoch 仅用于观测一致性和安静区间保护；Controller 重连而条目未变化不能解除升级义务。可读的普通用户输入计入进展，`origin=daynight` 的自动输入不计入进展。超大输入被历史投影替换为内容引用、无法读取来源时，也不能证明用户进展；该输入仍参与近期输入保护。
待通知记录与事件 ID 保存在事项中，恢复先读回再继续写入，避免换身份重复报告。
事项中的动作正文、规则 ID、历史文本及自由文本观测保存有界预览，携带原始 UTF-8 字节数、SHA-256 和截断标记；动作引用不可变手册版本与规则位置以定位完整原文。待通知内容不再复制完整动作正文，安静区间身份采用摘要，避免一次合法发送使后续结果与升级状态超过写入上限。

预置端点与网站合同见下文。初始手册规定报告格式、事实与推测分开、结束后复盘、
附录及修订的证据要求，并要求无新证据不得重复提出已拒绝修订。初始 `rules=[]`、
`takeover=auto`。重复开启复用用户现有 Watchdog 和手册；选定助手通过通用认领
机制接管。应用机制与取舍见[决策记录](../../.agents/notes/implemented/feature/2026-11-13-watchdog-application.md)。

## 网站

助手工作区在助手列表下展示独立的助手任务列表，详情路径为
`/bots/tasks/:id`。`tab=manual|records|proposals` 选择内容，`recordId` 和
`eventId` 定位证据记录或升级事件。任务详情与聊天共享工作区，切换时保留
聊天的 Session 缓存；助手详情侧栏列出该助手登记负责的任务。

列表、详情和当前记录页使用 `useBotRead` 的五秒可见页面轮询，沿用账号准入、
取消与身份隔离。手册、附录、版本、提案与任务分别读取；详情在读取材料后
再次核对任务版本，避免把不同版本的材料作为同一次用户决定的依据。后台读取
保留已有内容、筛选、选中的页签及编辑草稿。工作记录按事项分组，以服务端
游标加载，类型和作者筛选作用于已经加载的记录并显示这一范围。

所有已有资源的用户写入带任务 `ifVersion`。附录编辑、提案修改或拒绝、回退
及转交确认在开始交互时固定该版本；后台更新不替旧草稿换用新版本。转交与
释放同时固定认领代次，并带客户端生成的 `operationId`。浏览器不发送 Bot
身份、不生成或保存认领令牌。转交成功先显示 pending，只有服务端确认有效
认领后才显示负责中。

写入不自动重试。冲突触发读取，保留草稿供重新核对；未知结果在同账号作用域
内跨路由保留，并通过共享订阅通知重新打开的详情。认领类未知结果先读原操作
回执，再读取当前任务。普通未知写入只能确定当前状态，不能用相同内容推断原
请求成功。用户核对后才能解除该次写入的限制。创建请求在发送前保存原始 ID
与输入到账号隔离的 sessionStorage，存储不可用时使用内存；重新打开或刷新
页面先核对原身份，不能换 ID 重发。结果已确认而后续读取失败时，保留已确认
写入的事实。

应用定义的 `rules`、`appState`、`refs` 和事件 `payload` 使用保留数字原文的
JSON 编解码；不能精确重编码的数字不会经 JavaScript Number 舍入。展示、
编辑决定与未知结果快照使用相同编解码；协议版本和标识仍按各自严格合同校验。
提案省略规则时，用户仅修改正文的决定继续省略规则，由服务端保留已有规则。

聊天待处理条挂在 Session composer 的正常布局插槽中，展示当前负责任务的
待决定提案及尚未解决的升级、未知结果事件。它按任务当前负责助手展示，不以事件原来的 `targetBotId` 隐藏转交后仍未解决的事件。它不依赖 `seenAt`：看过通知不
等于处理了事项。已关闭事项或已过期事件不再列入。提案跳到任务的决定面板，
升级通过 `eventId` 定位对应事件。关注计数与清除由独立的关注机制负责。

### Watchdog 开启入口的接口合同

网站选择负责助手后发送
`POST /api/v1/assistant-task-presets/watchdog`，请求为
`{id,targetBotId}`。`id` 是发送前保存的创建身份；服务端应原子创建预置手册
或返回用户已有的 Watchdog，并把负责助手指定为 `targetBotId`。成功响应采用
标准助手任务 DTO，必须是 `application=watchdog`、`state=active`，且
`holderBotId` 与选择一致；已有单例可以返回不同任务 ID。pending 仍表示等待
助手绑定，不证明监控正在运行。未知结果先读取当前用户的 Watchdog 单例，
不自动重发开启请求。

此预置端点由 Watchdog 应用提供，通用助手任务服务不实现预置手册或监控。
服务器未提供端点时，网站显示 Watchdog 不可用，不以通用创建请求替代预置，
也不报告开启成功。网站的受控接口验证与真实 Watchdog 应用联调分别建立证据。
