# 助手

## 范围与能力

本文的管理、登记、grant 及独立恢复 v1 合同描述服务端接口。“Bot 本地存储与恢复合同”还包含 Worker 与 Provider 的独立验收要求；服务端接口存在不表示真实 Provider 恢复已通过。未登记恢复身份的 Bot 继续使用既有 Worker 与父 PAT 规则；登记后只接受带恢复证明及承载代次的新运行时写接口。没有对应能力的 Worker 不能启用恢复或退回旧写接口。

Bot 是当前用户拥有、绑定已有 Worker 的独立定义，不属于项目，也不生成 Task、claim 或 worktree。当前实现提供公开 Bot CLI、远端 Worker 查询、名字创建的默认解析、幂等定义存储、查询、删除屏障与服务端历史清理，以及绑定 Worker 使用的独立 Session 登记、grant 和启动结果报告。服务端按实际 Session 同步事实提交成功偏好；`worker run` 组合原生执行托管、恢复和私有资料清理，网页全局侧栏提供助手入口。首次创建成功只表示定义已持久化，启动状态为 `pending`，不表示完整助手已可用；同请求重放保留原资源的当前状态，包括删除责任，不复活定义。

公开 `POST /api/v1/me/bots` 接受调用方先生成的 ID 和名字，可选显式 Worker、目录、Provider、model 和 reasoningEffort；服务端解析并冻结配置。不能通过管理接口传入 args 或 resolvedConfiguration。Worker 的实际目录访问与 CLI/Provider 启动仍需执行前预检，服务端接受普通绝对目录不证明其存在。

网页的列表、创建、详情侧栏和全屏协同行为由[助手管理页面规格](bot-management-web.md)拥有，稳定 Session 绑定与页面缓存由[助手共享会话规格](bot-session-view.md)拥有。

## 产品入口与托管

登录后的全局侧栏提供助手入口，列表和对话使用 `/bots` 与 `/bots/{id}`。名字创建通过轻量弹窗使用可用默认 Worker、普通目录和 Agent；Worker、目录、Agent、Model 与 Reasoning effort 设置默认折叠。默认摘要显示实际目标与配置来源，阅读默认值不产生显式覆盖。目录浏览使用目标 Worker 的只读通道，只有确认目录或明确选择机器相关选项才绑定 Worker；取消浏览不改变创建请求。弹窗开关不改变当前助手 Session、草稿、阅读位置或生命周期。旧 Worker 缺少 `assistantHost` 时不可作为可用默认候选，不能因在线标签而推导托管支持。Task、旧 Herdr 只读历史和独立 Test 入口保持各自身份；不自动迁移 Test，也不恢复已撤销的 Conversations。

`worker run` 在同一前台进程中托管 Bot，与任务执行槽和项目准备独立，允许零仓库运行。能力广告来自实际组合的托管模块和当前有效配置；配置变化影响新建默认与首次意图，不修改已冻结 Bot。关闭聊天或浏览器不停止执行，Worker 离线时如实显示不可联系。正常退出等待 Task 和 Bot 的停止结果，重启沿原 Session/native identity 恢复，不重放业务请求；缺失身份、停证或授权时保留错误和恢复资料，不启动空白替代。

角色指令采用各 Provider 的原生追加机制，用户请求仍是独立输入。助手通过正常 CLI 查询和操作系统，保持已有权限与适用的 Goal 阶段确认；无项目、单项目和跨项目请求均不引入业务旁路或助手动作白名单。任务状态、暂停、依赖和 Worker 在线、库存、资源分别按真实观测解释。

长期可用依赖服务、Worker 和机器持续在线，不提供 OS daemon 安装、跨机器自动迁移、专属高可用或离线业务队列。Webhook/MCP 尚未提供，详情不显示虚构设置。删除只清理 Daynight 管理的对话和私有执行资料，保留独立任务、普通 cwd 与 Provider 自己管理的原生历史。

## 定义与身份

- Bot ID 由调用方在提交前生成。名字去除首尾空白后须为 1–40 个 Unicode 字符，拒绝控制字符及非良构 Unicode。
- 所属用户来自当前有效登录或 PAT。托管身份为 `(owner_user_id, worker_id)`；另一用户可以拥有同 UUID 的 Worker，但不能因此访问当前用户的 Bot。
- 保存显式覆盖项和首次解析得到的 Worker、绝对目录、Provider、model、reasoningEffort、args 及模型选择来源。覆盖项省略与显式输入保持区别；后续默认变化不改写已有配置。
- `version` 和 `creationOrder` 为正 int64；HTTP 使用十进制字符串，不能经浮点数转换。时间为 UTC RFC3339。
- 尚未登记时 `roleConfiguration`、`sessionId` 和 `testExecutionId` 为 null。登记后一个 Bot 只关联一个稳定的独立 Session；恢复改变 generation，不新建空白 Session。
- Session 保持独立 `testExecutionId` wire 分支，不携带虚构的 Task、claim、project 或 worktree。`startupResult.state=pending` 不证明原生进程已启动或 Worker 当前在线。

## Bot 本地存储与恢复合同

### 数据归属与迁移

在当前服务域及账号作用域内，`bots/<botId>/` 是该 Bot SQLite、执行意图、启动与恢复记录、Controller 票据及 journal、助手任务凭据、近期缓存和原生恢复材料的权威本地位置。路径由同一解析规则派生，创建、续跑、修复和删除使用同一归属。`worker/state.sqlite` 和公共 `controller/executions/` 不再是支持该能力的 Bot 的权威存储；公共索引可重建，清空后仍能从 Bot 目录发现原助手。目录内身份必须匹配服务、owner 和 Bot，不能仅凭目录名字信任内容。服务端继续共用现有数据库和资源设施，以 owner、Bot、Session 和用途隔离权限与期限，不要求独立服务端数据库。

Bot ID 是稳定业务身份；Worker ID 是当前承载实例。业务 cwd、独立 Task、共享 Provider 登录材料各有其所有者。Bot 专属原生副本属于 Bot 私有资料，删除仍需原执行可靠停止；最小删除责任与原回执须保留到两端清理确认，不能随 journal 或整个目录先行删除而丢失重试证据。共享 native home 不在该删除范围内。

迁移先取得 Bot 独占锁并证明旧执行停止，再复制一致 SQLite 快照、已提交 WAL 和关联资源，核对身份、摘要及原生记录。位置切换前只有旧位置可写，原子切换后只有新位置可写；持久迁移阶段支持中断后继续，禁止双写。跨端恢复身份登记及其回执是独立的可核对阶段，不能以本地复制成功推断服务端已接受。身份、原生记录或停证缺失时保留仍可看的材料并报告缺项，不创建同名新线程代替恢复。

### Provider 恢复与能力

每个 Provider 必须声明恢复所需最小文件集、原 `nativeSessionId`、兼容版本和最后已保护轮次。优先让原生会话直接写入 Bot 专属位置；不能安全隔离时，轮次结束并确认写入后生成一致副本，校验成功再替换旧恢复点。仅保存指向公共目录的路径不足以满足恢复要求，也不得复制整个用户 home。隔离 Provider home 必须保持并实测配置、工具发现及当前账号登录语义。

Codex 必须以发生 compact 的线程验证同一 ID resume 后继续下一轮；Claude、Copilot 各自提供真实版本、原生 ID、恢复后下一轮及副作用未重跑的证据。受控适配器不证明原生恢复。单磁盘副本只覆盖公共目录清理，不能覆盖磁盘或整机丢失。首版只承诺同机恢复；跨机需要异机恢复点、工作区交接、目标 Provider 实测与防双执行协议，复制目录或时间线不提供这些证明。

### 独立接管与写入屏障

新 Worker 启动先扫描本机 Bot 目录，再核对服务端归属；按新 workerId 过滤的远端 inventory 不是唯一发现入口。接管须使用当前有效账号认证、持久受保护的恢复身份及相同服务域，验证 Bot 未删除、owner 和 Session 访问仍有效，再取得本机 Bot 独占锁。原 PAT 已失效时不能当作恢复凭据，服务端核验新认证后重新签发新执行授权。该操作独立于普通 Task claim，也不重新认领 Bot 持有的助手业务任务。

旧 Controller 存活时优先核对身份并重新连接；需要新进程时，必须先证明旧执行停止。心跳过期或撤销服务端权限不等于外部命令已停止。接管按预期旧承载代次原子更新 Worker 和执行授权，保持 Bot ID、平台 Session、testExecutionId 及已知 nativeSessionId；拒绝旧代次迟到写入。承载代次与 Controller executionGeneration 分开：接回同一存活 Controller 不凭空制造新原生执行，重新启动沿既有 previousGeneration／stopProof 条件推进。恢复成功并完成当前身份同步前不开放输入。

请求结果未知时，只核对持久原请求及其结果，不分配新请求或新线程、重发业务输入。两个候选接管只能有一个取得同一预期代次；失败者观察原状态。旧命令副作用未知时显示待核对，缓存可读不改变这一限制。

### 字段、版本与失败语义

新增字段通过独立版本化接管／观测合同交换，既有管理 DTO 和 `/grant` 不静默扩展。恢复登记、接管、grant、report 与原操作查询由[独立恢复 v1 协议](../design/assistant.md#服务端恢复-v1-协议)提供；机器定位与可用性由[服务端观测 v1 协议](../design/assistant.md#服务端观测-v1-协议)提供。下表的 Provider 备份字段仍须由其生产方声明能力，不能从恢复回执或在线状态推导。

| 字段／能力 | 语义 |
| --- | --- |
| `botRecoveryVersion=1` | 本地独立存储、恢复身份登记及同机接管能力；须同时核对服务端与 Worker 支持。 |
| `recoveryIdentity` | 绑定 serviceOrigin、ownerUserId、botId 的受保护证明；秘密材料不出现在公开 DTO、日志或时间线。 |
| `operationId`、`expectedHostingGeneration` | 持久原接管请求 UUID 与精确十进制旧承载代次；不能用当前值盲重放未知写入。 |
| `workerId`、`hostingGeneration` | 已确认承载 Worker 与单调推进的承载代次；与 Session 的 executionGeneration、connectionEpoch 各有语义。 |
| `sessionId`、`testExecutionId`、`nativeSessionId` | 原 Session 身份；首次尚无 native ID 可为 null，恢复不以 null 代替已知 ID。 |
| `provider`、`providerVersion`、`recoveryFormatVersion`、`protectedThroughTurn` | 恢复材料适配版本及最后已校验轮次；未知轮次为 null，不宣称完整备份。 |
| `machine`、`observedAt`、`freshUntil` | 最后确认机器 ID／显示名与观测时效；离线仍保留定位，不能以当前 Worker 配置猜机器。 |
| `state`、`reason` | `offline`、`connecting`、`recovering`、`idle`、`working`、`abnormal`，附实际原因；当前 Bot 代次和同步事实决定状态。 |

无能力为 `upgrade_required`；账号认证失效为 `unauthenticated`，错误 owner／服务域为拒绝访问，预期代次或执行权冲突为 `resource_conflict`。缺恢复材料、Provider 不可用、不兼容版本、旧执行未证实停止必须有可区分原因，分别为 `recovery_material_missing`、`provider_unavailable`、`recovery_version_unsupported`、`stop_unconfirmed`。未知结果保持 `outcome_unknown`，不能映射成失败重试许可。旧接口仍维持原错误形状；新增错误通过版本化合同提供。

Worker 心跳过期显示 offline 并保留机器、主机名与最后时间，提示在该机器运行 `daynight worker run`。上线但定位、接管或同步未完成显示 connecting/recovering；已证实缺件或执行权冲突显示 abnormal 及具体补救。idle/working 只取该 Bot 当前代次已同步 Session 的当前轮次；同机其它任务活动和持久 ready 不改变它。首次尚无原生 ID 显示 connecting。已有授权缓存只供阅读，不恢复实时 Working、计时或发送资格。

`GET /api/v1/me/bots/{botId}/observation` 返回独立 `schemaVersion=1` 的观测 DTO，也支持 HEAD；不接受 query。它使用当前有效账号与 Bot 归属授权，不要求原创建 PAT 仍有效，不启动 Provider、不写 Session、不签发 grant，且不返回发送权限。旧 Bot 列表、详情及 Worker inventory 的 DTO 与创建时 Worker 字段保持原义。未升级服务没有此入口时，客户端不得由旧 ready 构造新观测。

观测返回当前承载 `workerId`、可空 `machine`、`provider`、原平台及原生 Session 身份、承载与连接代次、`state`／`reason`、服务端 `observedAt`、可空 `workerLastSeenAt`／`sessionLastSeenAt`／`freshUntil` 和仅工作中有效的 `currentTurnId`。版本及代次为十进制字符串，未知值明确为 null；未登记恢复身份的 `hostingGeneration` 为 null。机器定位不受普通 Worker 查询的 72 小时窗口影响。恢复登记的机器 ID 保持不变，同一机器的新上报名称可以更新显示；不同机器 ID 不覆盖已确认定位。

Worker 报告年龄须严格小于 120 秒；有效在线活动还要求当前 Session 心跳年龄严格小于 30 秒、持久连接租约未到期、相同 Controller fence、年龄严格小于 30 秒的当前 relay 已提交同步采样。`freshUntil` 取所用事实的最早截止时间，客户端到期须撤下实时状态并刷新，不能延续计时。只有其它 relay 的连接时返回 recovering／`session_observation_unavailable`，不从数据库的历史 activity 猜测在线活动。原生记录缺失等已确认启动失败保留其实际错误码，过期的 Provider 预检失败不覆盖当前已同步的 Bot 活动。

### 恢复验证边界

真实 SQLite/WAL、目录和锁验证隔离、迁移各提交点中断、单一写入位置及删除范围。Worker 模块验证清空公共索引、新 workerId、本地发现、登记未知结果、存活 Controller、双候选及旧操作不重发。服务端模块用隔离 PostgreSQL 验证原子接管、旧代拒绝、错误账号及新认证恢复；Provider 逐项以真实 CLI 证明 resume。Web 验证离线机器定位、时效到达、异常原因与缓存只读。缓存清空后原线程继续工作是恢复与展示存储分离的验收条件。规格检查不替代这些实现证据。

## 默认值与成功偏好

Worker 按显式选择、最近成功显式 Worker、首次登记时间与 Worker ID 的稳定顺序解析。自动候选必须有新鲜的托管报告及可用的目标 Provider；不能默认写死某个 Provider，也不能偷偷把失败的 Provider 替换成另一种。显式 Worker 不可用时直接返回原因，不换机；自动候选可以跳过不可用 Worker。 创建自动选择在需要扫描候选时，若 active Worker 超过 100 个，返回 `active_worker_limit_exceeded`，不从截断集合选择；显式目标不依赖其他历史 Worker。defaults 查询保留完整历史目录。

目录和 Provider 分别采用当前请求显式值、该 Worker 最近成功的显式偏好、该 Worker 报告默认值。模型按单助手显式值、用户/Worker/Provider 成功偏好、目标 Provider 有效默认或原生默认解析。reasoningEffort 按显式值、用户/Worker/Provider/有效模型成功偏好、Worker 有效配置、该模型原生默认解析；Worker 有效配置包含原 args 中的 effort，不能跳过本地或云端明确值。失效历史偏好回退至有效默认；当前显式值或没有更高层覆写的 Worker 明确 effort 不兼容时拒绝。有效模型未知时不套用任何模型的 effort 偏好。args 只来自目标 Worker 的对应 Provider，切机器或 Provider 不继承另一组参数。目录须符合目标平台的绝对路径规则，不由服务端创建或检查本机同名目录。

Worker 原生默认值及其来源来自受容量约束的机器报告；model、args、目录和来源项目集合遵循[快照](daynight-worker-snapshots.md#助手托管预检)及[配置协议](daynight-worker-configuration.md#有效原生配置来源)，不能从被拒绝或截断的报告推断默认值。

托管观测使用服务端时间：最近报告与 assistantHost.observedAt 均须不在未来且年龄严格小于 120 秒。旧 Worker 为 unsupported；报告失联为 offline；探测过期为 stale；全部 Provider 失败为 unavailable。目标 Provider 单独失败时保留具体原因。defaults 只提供观察，不预留资源或承诺未来启动成功。没有 model/effort 覆写或成功偏好的名字创建不增加全量原生发现；需要选择校验时通过绑定 Worker 的[模型能力通道](worker-model-discovery.md)读取真实能力。预览后选择依赖机器的选项时，调用方须绑定实际 Worker；旧 Worker 未声明 `assistantHost.creationConfigurationVersion=1` 时拒绝新增明确选项。

原生只读预检清理未确认时，对应 Provider 保持不可用且不得启动替代探测。只有原探测取得[可靠清理确认](daynight-worker-reporting.md#原生只读探测的清理与恢复)后，才在下一轮正常采集中绕过对应旧失败缓存重新预检；新预检成功且符合当前配置与观测时效后，才可报告可用。清理确认本身、`versions` 成功、其它 Provider 可用和已有 Bot 的持久 ready 均不能替代该 Provider 的新预检。此恢复不切换默认 Provider、不修改已冻结 Bot 或 Session，也不重放用户输入。公开 DTO、服务端创建准入与前端按钮判定保持既有规则；目标 Provider 真实不可用或观测过期时仍拒绝新建，页面刷新不保证旧 Worker 恢复。

读取默认值、取消未提交的表单、创建 pending 定义和启动 failed 均不提交偏好。只有绑定 Worker 的 report 经服务端核验当前 Session 身份与实际同步事实，并在同一事务中持久化 ready 后，才提交成功偏好。表单、spawn 回执和客户端声明均不能代替该核验。用户 Worker 偏好、每 Worker 的目录/Provider 偏好、每 Provider 的模型偏好及每模型的 effort 偏好各自保存服务端 creation_order 水位；旧创建晚成功不能覆盖新成功显式选择，没有显式选择的字段不重写偏好。配置和偏好失败时与同一生命周期事务一起回滚。

## 创建幂等性

创建内核以规范化名字和显式覆盖项计算请求指纹。同一用户以相同 ID 和指纹重放时返回原定义及其冻结配置；重新解析的默认值不构成另一次创建。相同 ID 的不同指纹返回冲突；另一用户不能接管该 ID。失败的数据库事务不留下部分定义。

需要原生发现的新建必须在入库时重验解析输入，包括成功偏好覆盖前的 Worker 原生基线。历史偏好不能掩盖发现期间的 Worker 默认变化。未执行发现的请求若在入库时遇到新出现、需要模型能力确认的 effort 历史，也必须返回 `resource_conflict`，不能忽略该偏好后冻结。原 ID 已存在时仍优先按既有幂等规则返回，不以这些新建条件拒绝原结果。

提交结果未知时，调用方按原 ID 查询并核对，不能自动生成新 ID 重试。已标记删除的 ID 不复活，也不能用重复创建移除清理责任。

## HTTP 管理契约

管理接口使用现有登录/PAT、浏览器写入 Origin 校验、`no-store` 和 `Daynight-User-ID` 响应身份。Worker 生命周期写入只接受有效 PAT，另核验 Bot owner 与绑定 Worker；浏览器登录和 Controller relay token 不能代替 Worker PAT。没有项目参数。分页采用现有 `limit`（1–100，默认 50）和 `cursor`，游标绑定用户及普通/Worker 清单范围。列表按条数返回完整项，使用一项 lookahead 判断续页，cursor 指向最后返回项；普通列表和 Worker 清单不按响应字节裁页。写入入口负责数据结构、字段、规范化与现有容量规则，读取保存的定义不重复这些检查；正常解码及响应编码错误继续传播。

| 方法与路径 | 结果 |
|---|---|
| `GET /api/v1/me/bots` | `{items,nextCursor}`，按创建时间及 ID 稳定排序，排除删除意图 |
| `GET /api/v1/me/bots/defaults` | 可选唯一 `workerId/cwd/provider/model/reasoningEffort`；返回当前用户候选、选中配置或不可用原因，不写偏好 |
| `POST /api/v1/me/bots` | `{id,name,overrides?}`，overrides 只允许 workerId/cwd/provider/model/reasoningEffort；200 返回原始或新建定义的真实状态 |
| `GET /api/v1/me/bots/{id}` | 未删除时返回定义；删除后仅返回 ID、Worker ID、版本及删除责任 |
| `GET /api/v1/me/workers/{workerId}/bots` | 当前用户该 Worker 的定义和未完成清理责任；普通列表隐藏不移除 Worker 责任 |
| `DELETE /api/v1/me/bots/{id}` | 请求 `{ifVersion,deletionId}`；`ifVersion` 为正 int64 十进制字符串，`deletionId` 为 UUID；返回真实删除意图 |

defaults 响应为 `{observedAt,workerId,configuration,reason,workers}`。未找到可用自动候选时 workerId/configuration 为 null、reason 为 no_available_worker；显式不可用 Worker 保留 workerId，configuration 为 null 并提供原因。workers 按稳定顺序列出当前用户已登记 Worker，包含 workerId、machine、platform、state、reason、configuration 与 providers；离线记录也能解释显式选择失败，不输出任务库存。state 表示主机观测，configuration/reason 表示该机器目标配置是否可用；providers 不取代新鲜度判断。reason 包括上述主机状态、invalid_cwd、provider_unavailable 或带 provider_ 前缀的预检原因。所有当前格式的可空字段显式为 null，数组为空时为 []；旧冻结配置省略新增字段。

model 和 reasoningEffort 独立可选，只接受非空、无控制字符、良构 Unicode 字符串，分别最多 256/64 个 UTF-8 字节。省略保持省略；预览默认不能写入原请求或指纹。未指定 workerId 的直接创建按权威默认解析 Worker，并在同一创建中冻结实际机器；使用预览选择时须显式传入该 Worker，防止预览与创建之间换机。创建与默认查询拒绝未知/重复字段、非法 query 和 null 覆盖项。显式 Worker 不属于当前用户时为 403；新创建无可用配置时为 409 resource_conflict，信息包含失败原因。同 ID 重放先核对持久定义，不因后来 Worker 离线或默认变化而再次解析。

定义响应包括 `id`、`ownerUserId`、`workerId`、`name`、`version`、`creationOrder`、`requestedOverrides`、`resolvedConfiguration`、`roleConfiguration`、`sessionId`、`testExecutionId`、`startupResult`、`deletion`、`createdAt` 和 `updatedAt`。内部请求指纹不向 HTTP 输出。新冻结配置使用可选 `selection` 对象（schemaVersion=1）保存 modelSource/reasoningEffortSource，来源为 explicit/preference/local/cloud/native/unknown；经能力发现的配置另保存 configurationGeneration/catalogGeneration。存在 selection 时 reasoningEffort 必须存在，可为 null。旧持久记录没有这些字段时保持原配置语义，不伪造历史来源。

删除责任包含 `deletionId`、原 `requestedVersion`、`workerCleanup` 和 `serverCleanup`。两个清理结果分别包含 `state` 和可空 `code`。记录删除意图时两者均为 `pending`，不返回伪造的 completed。删除后的 HTTP 响应不含名字、启动配置、角色或 Session 内容。

无效输入为 400，未认证或失效凭据为 401，非 owner 或不属于当前用户的 Worker 为 403，不存在的 Bot 为 404，版本或幂等请求冲突为 409。读库失败保持错误，不转换为空列表。

## 公开 CLI

`daynight bot list|show|create|delete` 和 `daynight worker list|show` 使用当前配置的服务与认证。所有命令支持 `--json`，无需项目或 Git 仓库，可从普通目录执行；不接受 `--project`，也不读取本地 Worker 库存来替代远端事实。

| 命令 | 输入与结果 |
|---|---|
| `bot list` | 读取所有分页；JSON 为 Bot 数组，普通列表不含删除意图 |
| `bot show <bot-id>` | 返回当前定义或最小删除责任；JSON 为 Bot 对象 |
| `bot create --name <name>` | 可选 `--worker <uuid>`、`--cwd <path>`、`--agent <codex\|claude\|copilot>`、`--model <model-id>`、`--reasoning-effort <effort>`、`--request-id <uuid>`；JSON 为实际创建或同请求重放所得 Bot（包括删除责任） |
| `bot delete <bot-id> --if-version <version>` | 可选 `--request-id <uuid>`；只使用显式观察版本，JSON 为删除后的 Bot 责任对象 |
| `worker list` | 读取所有分页；JSON 为 `{observedAt,items}` |
| `worker show <worker-id>` | JSON 为 `{observedAt,worker}`，包括详细资源、任务库存及可选助手托管观测 |

创建只需名字，CLI 不自行选择 Worker 或向服务端填入本地目录；服务端拥有默认解析和冻结配置。cwd 是目标 Worker 的绝对路径，不要求仓库，CLI 不创建或证明该目录存在。返回 pending 只证明定义已接受，不能报为 ready；持久 ready 也不能推导当前 Worker 在线。

请求 ID 在写入前生成或使用显式值。创建请求 ID 就是 Bot ID；删除请求 ID 对应 `deletionId`，与目标 Bot ID 分开保留。提交后响应丢失、格式不合法或远端结果未知时，CLI 保留原业务 ID，提供 `daynight bot show <bot-id> --json` 核对指令，并以失败退出；不得自动重发 POST/DELETE 或生成新 ID。HTTP 响应关联 ID 不替代业务请求身份。版本冲突保留失败，不自动读取更新版本后再写入。

同一创建请求在删除后重放时，服务端验证原 owner 与请求指纹，CLI 接受身份匹配的最小删除责任并显示真实清理阶段，不伪造定义或启动状态。活跃定义须匹配提交的名字和显式覆盖；删除责任不含这些字段，仍须通过 principal、Bot ID、显式 Worker、版本及清理结构校验。

Bot JSON 的 version、creationOrder 和 requestedVersion 始终为十进制字符串，不经浮点数转换。删除分别显示 Worker 和服务端清理状态；任一 pending 不构成完成，只有两方均 completed 才表示完成，failed 保留错误码。CLI 遵守服务端的删除准入及真实清理阶段，不将列表隐藏解释为历史或原生进程已清理。

列表在所有分页成功后才输出结果。`bot list` 每页请求 100 项，单响应上限采用该命令现有累计响应体预算 256 MiB，全部页面的累计上限仍为 256 MiB；服务端条数分页不要求每页低于通用客户端的 128 MiB 默认值。`bot show/create/delete` 和其他命令保留默认传输限额，操作与请求期限继续适用。权限、网络、格式、预算或后续页错误不产生空列表或部分成功。Bot 和远端 Worker 操作失败时 `--json` 向 stderr 输出单个 `{error:{...}}` 对象，包含 operation、可取得的 botId/requestId 或 workerId、phase、HTTP status、code、serverRequestId 以及 outcomeUnconfirmed；未知写入另有 reconcile 核对命令。已知创建环境失败和请求冲突通过 reason 保留具体原因；缺少认证时给出 login_required。认证材料、原始传输异常和任意服务端错误正文不进入诊断。操作失败 exit 1，参数用法错误沿用文本诊断与 exit 2，不因 `--json` 改变。

远端 Worker 保留服务端 observedAt、lastReportedAt 和库存观测状态。在线显示按服务端观测时间与最后报告的 120 秒间隔判断；它不证明空闲容量或 Provider 可启动。unavailable 库存的任务数与观察时间为 null，不能当作零任务；stale 和 offline 保留旧事实的时效边界。详情保留探测失败码和采样时间；缺少 assistantHost 不能推断支持助手托管。普通 Worker 查询沿用最近 72 小时窗口，超出窗口的单项查询返回不可用结果，不证明 Worker 从未存在。`worker repo list` 仍只列本机配置的仓库。

## 独立 Session 生命周期

生命周期接口位于 `/api/v1/me/workers/{workerId}/bots/{botId}`，均为 POST，不接受 query 参数；请求拒绝未知/重复字段和非法类型。`botVersion` 为正 int64 十进制字符串，不能使用 JSON 数字。所有成功响应为 200。

| 后缀 | 请求 | 响应与条件 |
|---|---|---|
| `/register` | `{botVersion,registration,configuration,roleConfiguration}` | `{bot,session}`；同事务冻结首次角色并绑定 Session，返回当前 Bot 版本和真实 Snapshot |
| `/grant` | `{botVersion,grant,nativeSessionId}`，可选 `initializationEvidence` 见下文 | 现有 Controller grant 结果，含 token、到期时间、sessionId、testExecutionId、generation 与 Controller 身份 |
| `/report` | `{botVersion,fence,controllerId,controllerInstanceId,nativeSessionId,result}` | 更新后的 Bot；`result` 为 `{state:"ready"或"failed",code:string或null}` |

### 首次登记与重放

`registration` 使用现有独立 TestRegistration：`protocol`、`schemaVersion`、`projectionVersion`、`registrationId`、`testExecutionId`、`controllerId`、`controllerInstanceId`、`provider` 和 `initialInput`。Bot 只接受 `initialInput="none"`，不以角色配置制造用户输入。`configuration` 必须与 Bot 创建时冻结的 Worker、cwd、provider、model、args 和存在的 reasoningEffort/selection 完全一致，registration 的 provider 也必须一致。

`roleConfiguration` 包含 instructions 全文、revision 和 SHA-256 digest。instructions 须为非空良构 Unicode 字符串，UTF-8 最多 64 KiB；digest 必须对应该全文。服务端不生成或替换 Worker 的角色模板。角色仅在首次登记时由 null 原子冻结；以后所有 generation 沿用持久角色，不因 Worker 升级或页面重开变化。

首次登记校验当前 Bot 版本，并在创建 Session 的同一事务内推进 Bot 版本。相同原登记请求的精确重放返回原 Session 和当前 Bot，即使首次登记已推进版本；不同登记身份、原请求版本、冻结配置或角色均冲突。并发登记不能产生第二个 Session。已删除状态优先拒绝重放，不能复活 Bot。提交结果未知时，保留原请求并查询原 Bot，不以新登记身份重试。

首次登记与尚未绑定 Session 的失败报告在等待 Bot 锁后、事务提交前必须重新核验 PAT 的自然过期；相同失败结果的无变更成功响应也须核验。凭据在等待期间过期时返回 `401 unauthenticated`，Bot 版本、角色、Session 关联、启动结果和偏好均保持原值。

### Grant 与代际恢复

`grant` 保留独立 `testExecutionId`、Controller 身份、`executionGeneration`、`kind` 和已有 `previousGeneration`/`stopProof` 语义；kind 为 bootstrap 或 reconnect。`nativeSessionId` 必须与当前 Session 精确一致，null 与非空值不同。bootstrap 或续期不能绕过当前 Bot 版本与绑定 Worker 校验。

恢复已有原生会话的新 generation 必须保留已知、匹配的原 native ID；previousGeneration 必须是当前 generation，新 generation 恰好加一，stopProof 必须指向原 Controller instance，新 instance 必须不同。停证时间不得晚于服务端当前时间加 1 秒。恢复精确重放必须匹配原 previousGeneration、原 stopProof 和已登记的新 Controller instance。`never_started`、未知 native ID 或启动结果不明本身均不能授权新 generation，旧 fence 不能继续操作已推进的 Session。

Codex Bot 的创建请求经本机证明确未派发时，两个 Bot grant 外层可携带 `initializationEvidence:{version:1,state:"not_dispatched"}`。仅当前和请求 native ID 都为 null、初始输入为 `not_required`、具备精确前代与真实停止证明时接受；原实例确实运行过，不能使用 `never_started`。该例外不适用于普通 Task/Test Session 或其他 Provider。证据与有界重试由[Worker 初始化恢复要求](worker-bot-runtime.md#codex-创建前失败)拥有。

普通 Test 注册、grant 和 stop 不能作为 Bot 生命周期入口；普通 Test grant 仍不接受恢复参数。Bot Session 不出现在普通 Test 列表中，Task 的 claim 准入与普通 Test 权限保持不变。

### 启动结果与真实同步

未绑定 Session 的预检失败仅接受 failed 结果、null fence、空 Controller 身份和 null nativeSessionId，不提交成功偏好。绑定后的 ready 或 failed 报告均须匹配当前完整 Controller fence、Controller 身份和 native ID；旧 generation 或 connectionEpoch 的报告被拒绝。

ready 还要求处理请求的 relay 已实际同步该 Session，连接与心跳仍有效，且实际连接的原父 PAT 在报告事务内仍有效。同代新 grant 使用另一 PAT 不能替代对原连接凭据的验证；原 PAT 撤销或过期后，报告不得提交 ready 或成功偏好。另一个实例没有当前 live 同步事实时不得凭数据库快照或已有 startupResult 推断成功。首次输入前惰性创建 native ID 的 Provider 可以报告 null，但仅当真实同步快照也为 null；该规则不放宽代际恢复对已知 native ID 的要求。

ready 要求 code 为 null；failed 要求非空、良构 Unicode 错误码。ready 与成功显式偏好在同一事务内提交，failed 不写成功偏好。报告必须使用当前 Bot 版本；结果变化时推进版本，当前版本下的相同结果经身份和同步核验后返回原 Bot，不重复推进版本。响应丢失后先查询原 Bot 及其版本，不盲重放旧版本。startupResult 描述启动结果，不是第二套在线状态机：持久 ready 不保证当前 Worker 在线，消费者须结合 Session 连接与同步观测判断当前可用性。

### 共享入口准入

所有 Bot 关联 Session 入口在读取 live cache 或产生副作用前，核验持久 Bot 归属、稳定绑定和删除状态，包括浏览器 Snapshot/channel/command/timeline/operation/resource、Controller 接入/event/ack/content 回传及 archive。删除标记生效后，旧 Test URL、直接 Session API 和另一个实例的旧缓存均不能继续读写历史。

浏览器身份必须是 Bot owner，当前登录和 Controller 父 PAT 均须有效；换账户、父 PAT 撤销或过期不会因已有 channel 而保留访问权限。Controller token 只授权 relay，不是 Bot 管理或 CLI 凭据。

## 删除及对话清理

删除在当前版本保护下原子记录意图并递增版本；从普通列表隐藏，撤销关联 Session 的 grant 和连接授权。所有关联入口立即遵守持久删除屏障，不等待 Worker 在线或文件清理。相同删除 ID 与原请求版本可重复核对；不同请求冲突，不能盲重试。只核对结果时版本不增加；当 Worker 已完成而服务端清理未完成时，重放原 DELETE 会重试服务端清理并返回实际阶段。

公开 DELETE 的 owner PAT 或登录 Session 必须在事务完成前仍有效，包括原请求的精确重放。等待 Bot 或关联 Session 行锁期间自然过期时返回 401；整个删除事务回滚，Bot 版本、删除责任及 Session 的 grant/连接授权保持不变。

绑定 Worker 通过 `POST /api/v1/me/workers/{workerId}/bots/{botId}/deletion-complete` 提交 `{deletionId,stop,result}`。请求必须包含全部字段且无额外字段，使用 owner 的有效 PAT 和绑定 Worker ID。`result` 为 `{state:"completed",code:null}` 或 `{state:"failed",code:<非空错误码>}`。未绑定 Session 的 completed 回执使用 `stop:null`；已绑定的 completed 回执必须携带现有独立会话 `TestStop`：`protocol`、`sessionId`、`testExecutionId`、`executionGeneration`、`controllerId`、`controllerInstanceId` 和 `stopProof`。停证必须匹配删除时原执行，不能用未来时间或旧代替代；`never_started` 仅在未消费 grant、未连接、没有 source/native 身份时接受。failed 回执可以用 null stop，不触发服务端清理。相同 failed state/code 的重放返回原版本与更新时间；错误码变化或推进到 completed 才记录新的结果。

Worker 的 completed 声明表示它已验证原生写入停止并清理该 Bot 私有资料；服务端校验身份与停证格式，不独立测量远端进程。有效 completed 回执先持久化，再清理服务端 SQL 子表、Session 行、live cache 和按当前布局派生的归档命名空间，包括其中没有 SQL metadata 的孤立对象。新写入的 Bot 归档按原 owner 和 Session UUID 前两位分组，清理保留同 owner、同分片的其它 Session。既有旧布局归档不转换，不纳入当前命名空间的物理删除保证；旧目录存在不阻止当前清理完成。已完成 Worker 回执只接受语义完全相同的重放，不能改用新的停证；相同回执可重试未完成的服务端阶段。

文件或 SQL 清理失败保留删除屏障、原 deletionId 和已完成的 Worker 责任，`serverCleanup` 返回 failed 及 `server_cleanup_failed`。修复后重试原 DELETE 或原 completed 回执，不新建 Bot 或删除请求。两个阶段均为 completed 才表示 Daynight 服务端与绑定 Worker 可管理资源清理完成。Worker 离线或尚无回执时保持 pending，失败回执保持 failed；HTTP 成功不代表两个阶段都完成。查询和响应始终仅返回最小删除责任，无只读历史入口。

清理仅涉及该 Bot 实际关联的 Session，不修改独立任务、普通 Test Session、用户 cwd、worktree 或共享 native home。Provider 原生历史没有统一删除 API，不承诺擦除其原生文件、安全擦除、离线浏览器缓存或用户导出副本。浏览器和 Worker 各自负责其范围内的缓存/私有资料处理。

## 验证要求

模型选择覆盖两个可选字段的四种组合、同 ID 同/不同指纹、原 ID 未知结果查回、两次创建反序完成及逐字段偏好、失败不记忆、旧记录迁移与旧 Worker 拒绝。CLI/Web/MCP 的显式字段必须贯通到首次启动，原生参数由统一适配器去重并按 Provider 映射；真实能力在首次启动复核，恢复仍使用原冻结配置。会话内临时切模型不写新助手默认。

助手可用性验证覆盖原探测清理未确认时的拒绝、可靠确认后的下一轮重采、当前配置与新鲜度校验，以及重新预检失败仍保留实际原因。独立验证版本采集成功、其它 Provider 成功和既有 Bot ready 均不能误报该 Provider 可用；清理与取消的完整矩阵由[上报验证要求](daynight-worker-reporting.md#验证)拥有。受控预检与创建准入测试不证明真实 Worker 恢复或助手启动成功，真实创建与启动结果须分别观察。

CLI 验证覆盖普通非仓库目录下的六个命令、help 与 JSON、名字创建的 pending、固定请求 ID、未知写入不重试及 show 核对、超安全整数的版本、删除阶段区别、分页及后页失败、401/403/404/409 和诊断认证材料隔离。Worker 查询验证在线与库存状态分别呈现，未知库存不假报零任务，远端查询不获取本地 runtime 锁。受控 HTTP 与命令测试只证明 CLI 契约，不证明真实 Provider、完整托管或历史清理。

真实隔离 PostgreSQL 测试覆盖名字创建、稳定候选、显式离线拒绝、跨机器和 Provider 参数隔离、默认观测时效、反序成功偏好、失败不提交、偏好事务回滚、并发重复 ID、不同指纹、组合 Worker 归属、失效凭据、事务回滚、分页、精确 int64、删除重放和任务不变。Session 测试另覆盖并发与丢失响应登记、首次角色原子冻结、错误 Worker/owner/版本/native/fence、普通 Test 绕过拒绝、代际停证及精确重放、真实同步 ready、父 PAT 撤销、浏览器换身份和持久删除后所有旧入口拒绝。删除测试覆盖 PAT/登录 Session 在 Bot/关联 Session 锁等待期间过期的拒绝与完整状态回滚、有效删除和精确重放、上传和删除的两种锁交错、跨实例旧缓存、全部 SQL 子表、孤立归档、文件及 SQL 失败重试、受限路径和符号链接保护。HTTP 测试覆盖实际 DELETE 路径在 Bot 锁等待期间过期的 PAT/登录 Session、原请求重放、认证、严格请求解析、真实绑定引用、删除阶段、精确回执重放和删除后响应隐藏。完整服务端检查使用 [服务端验证命令](../../packages/daynight-server/README.md)，包含 race 与覆盖率门禁。这些检查不证明真实 Provider、Worker 托管或完整助手交互已交付。

`TestBotRuntimeHTTPChecksCredentialAfterUnchangedBotLockWait` 使用完整迁移的隔离数据库，对首次登记、首次未绑定失败报告和同结果失败报告分别取得 Bot 行锁，并通过当前 schema 的 blocker PID 观测实际请求等待。锁持有者不修改 Bot 版本或其它字段；观测 PAT 按真实时钟自然过期后释放锁，要求 HTTP 返回 `401 unauthenticated`，并比较完整 Bot、关联 Session 和偏好持久值以证明没有提交副作用。对应有效 PAT 用例要求正常成功、一次版本推进或原版本无变更，以及精确重放返回原结果。

relay 包内的 `TestBotUnboundLifecycleRevalidatesCredentialAfterLockWait` 直接调用生产服务入口，使用同样的实际 blocker 和自然过期观测，对三个操作分别验证过期拒绝、有效凭据成功及同结果持久值不变。HTTP 用例证明调用方可见的状态码与响应；包内用例独立验证事务拒绝和回滚。
