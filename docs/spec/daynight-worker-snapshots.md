# Worker 运行快照接口

本文定义账号级 Worker 最新运行快照的服务端协议。[设计](../design/daynight-worker-snapshots.md)拥有事务、查询与存储机制；[客户端上报需求](daynight-worker-reporting.md)拥有 CLI 的持续采集、调度与取消；[任务认领协议](../design/daynight-worker-claims.md)继续拥有任务执行归属。[云端配置接口](daynight-worker-configuration.md)拥有独立的目标与应用观测，以及显式选择的报告扩展；本页默认报告格式保持。

Worker 快照是认证客户端主动提交的观测。服务端校验格式、账号及任务归属，不执行系统采集或启动执行进程。硬件和版本数据是客户端提供的展示信息，机器名称及 machine.id 不构成认证身份。

本机检查点存储不就绪或诊断文件不可写时，Worker 的独立[运行监控](daynight-worker-monitoring.md)保留相应故障与重试信息；最近机器快照或应用报告不构成当前新执行准入证明。未持久化的实际结果不能借快照声明 applied，日志缺项也不能证明副作用未发生。

## 资源与认证

| 方法 | 路径 | 成功结果 |
|---|---|---|
| POST | `/api/v1/me/workers/{workerId}/report` | `200`，默认 `{observedAt,lastReportedAt}`；显式配置协议扩展其回执 |
| GET | `/api/v1/me/workers` | `200`，`{observedAt,items,nextCursor}` |
| GET | `/api/v1/me/workers/{workerId}` | `200`，`{observedAt,worker}` |

三个端点及方法拒绝路径均要求认证，沿用 PAT、浏览器会话和 Cookie 写入的精确主站 Origin 规则。响应为 `no-store`，包含认证的 `Daynight-User-ID`。GET 同样支持 HEAD；其他方法返回带 Allow 的 405。

Worker 资源键为认证账号与规范 workerId 的组合。workerId、machine.id 和任务引用 ID 必须是带连字符 UUID，并由服务规范化。body 不接受 userId。其他账号、未知或超过近期窗口的 Worker 详情统一为 `404 not_found`。

## 上报结构

请求为 UTF-8 `application/json`；带有效 `Daynight-Worker-Configuration: 1` 或 `2` 的报告正文最多 9 MiB，未带配置协议的普通报告最多 1 MiB。未知或重复配置协议头在业务调用前拒绝。必须是单个对象；各层字段名区分大小写，未知字段、重复键、缺少必填字段、错误分支字段及尾随 JSON 均为 `400 invalid_input`。报告端点不接受查询参数。

以下顶层字段必填；`assistantHost` 为可选扩展，旧报告省略该字段仍有效。选择配置协议时另外要求其定义的 `configuration` 字段，未选择时该字段仍属于未知输入：

| 字段 | 内容 |
|---|---|
| machine | `{id,name}`；id 为 UUID，name 为非空白文本 |
| platform | `linux`、`macos` 或 `windows` |
| workingDirectory | 非空白的工作目录文本，说明磁盘数据的作用范围 |
| sampledAt | 客户端采样时刻 |
| os | Probe，成功值为 `{type,release,version,arch}`，四项均为非空白文本 |
| cpu | Probe，成功值为 `{model,logicalProcessors,usagePercent}` |
| memory | Probe，成功值为 `{usedBytes,totalBytes}` |
| disk | Probe，成功值为 `{availableBytes,totalBytes}` |
| versions | `{daynight,herdr,codex,copilot}`；daynight 为非空白版本文本，其余为下述探测结果 |
| taskInventory | 显式 null，或完整 `{observedAt,claims}` 对象 |

文本必须是无 NUL 的有效 UTF-8。machine.name 最多 256 字节，workingDirectory 最多 4096 字节，Daynight、Herdr 和 Agent 版本各最多 256 字节；OS type/arch 各最多 64 字节，release 最多 256 字节，version 最多 1024 字节，CPU model 最多 512 字节。字节均按解码后 UTF-8 计量。日期使用有效、非零的 RFC3339 时刻，响应转换为 UTC。客户端 sampledAt、checkedAt 和 inventory observedAt 只说明数据来源，不决定在线状态。

### 探测结果

每个 Probe 仅允许所处状态的字段：

| 状态 | 必填结构与适用范围 |
|---|---|
| ok | `{state:"ok",checkedAt,value}` |
| error | `{state:"error",checkedAt,code}` |
| not_installed | `{state:"not_installed",checkedAt}`，仅 Codex/Copilot |
| not_running | `{state:"not_running",checkedAt}`，仅 Herdr |

error 的 code 仅接受 `not_found`、`permission_denied`、`timeout`、`command_failed`、`invalid_output`、`invalid_sample`、`out_of_range`、`io_error`、`unavailable`。成功不能携带 code，失败不能携带 value，特殊安装/运行状态不能携带两者。

CPU model 是非空白文本，logicalProcessors 是 `1..9007199254740991` 的整数，usagePercent 是有限的 `0..100` 数值。容量字段是 `0..9007199254740991` 的整数；usedBytes、availableBytes 不超过对应 totalBytes。整数条件按 JSON 数值含义判断，不接受非整数或超出可精确表示范围的值。

版本探测的成功值为非空白字符串。未安装、未运行和检测失败是独立结果，不以 null 或空字符串代替。某项探测为 error 不影响其他有效字段的保存，也不使一份格式正确的机器报告失效。

### 工具路径观察

`Daynight-Worker-Tool-Paths: 1` 请求与响应回显控制此扩展。报告的可选 toolPaths 保存为 telemetry.toolPaths；缺字段表示本次报告未提供工具路径信息，与 not_checked 不同，不能沿用旧报告或猜测自动路径。旧读者的详情响应省略该字段，versions 继续原有严格形状。列表不复制完整遥测。

对象为 `{schemaVersion:1,observedAt,entries}`。entries 最多五个唯一 tool/context：codex/web、codex/herdr、copilot/web、copilot/herdr、herdr/herdr；Herdr/web 拒绝。Bot 使用 web 上下文。每个可用上下文都保留条目，未检查时使用 not_checked。

每项完整包含以下字段，所有对象均拒绝未知字段：

| 字段 | 合同 |
| --- | --- |
| tool、context | 上述工具和上下文组合 |
| configurationSource | local 或 cloud |
| targetRevision | local 为 null；cloud 为正 int64 规范十进制字符串，并绑定该版本的 target |
| target | 完整 ToolPathChoice，不能是未采纳 null |
| state | not_checked、checking、pending、applied 或 error |
| reason | null、active_instance、cleanup_unconfirmed、configuration_unavailable 或 report_budget_exceeded |
| actual、candidate | 各自为完整实际选择或 null |
| activeSelectionCount | 实际运行选择总组数；无法确认总集合时为 null |
| activeSelectionsComplete | 布尔值；数量、预算省略或无法确认集合时为 false |
| activeObservationError | null、legacy_tool_identity_missing、cleanup_unknown 或 inventory_unavailable |
| activeSelections | 按 selectionKey 排序的运行选择分组，每项含 actual、nullable executionCount、nullable instanceCount、unconfirmedCount |
| error | null 或闭合 `{code,occurredAt}`，不能包含自由诊断正文 |

实际选择为 `{selection,selectionKey,entryPath,executablePath,interpreterPath,source,version,checkedAt}`。selection 是产生该结果的完整 choice；selectionKey 为运行管理器给出的 64 位小写 SHA-256 十六进制标识。entryPath 表示入口、executablePath 表示实际工具程序、interpreterPath 为解释器路径或 null。source 只能是 explicit/path/bundled；path 每项最多 4096 UTF-8 字节，version 最多 256 字节。时间必须有效；服务不接收 command、argv、环境、artifact 内容或进程凭据。target 沿用 desired 的平台无关路径语法，使 Worker 能携带原目标报告平台不匹配的 invalid_path；actual、candidate 和 activeSelections 的实际路径仍须符合所报 Worker 平台。

actual 仅表示后续新执行可准入的已验证选择，不代表全部旧执行。candidate 是已探测但尚未安全应用的目标，不能替代 actual。目标失败可以保留旧 actual，但新执行不得借旧值回退。applied 必须有与 target 相等的 actual.selection；消费者还必须核对 cloud targetRevision、当前 desired choice 和 tool/context，不能把迟到报告当作新目标成功。保存成功、单独 versions probe 和候选都不能证明工具已应用。离线或快照过期时，actual 只能作为带 checkedAt 的历史事实展示。

activeSelections 由原 Task/Bot/Herdr 责任按选择聚合，不逐 Task 枚举。每个上下文最多八组；超出数量或编码预算只省略完整组，不截断路径。activeSelectionCount 保留已知真实总数，activeSelectionsComplete=false 明确尚有未展示选择；未知总数不能写成已展示数量。旧执行没有冻结工具身份时以 activeObservationError 和不完整标记表达，不能重建伪路径，也不能因此把已正确应用的新目标改报 error。停止未确认的责任继续计入 unconfirmedCount。

错误 code 只接受 not_found、permission_denied、not_executable、invalid_path、unsupported_launcher、unrecognized_output、incompatible_runtime、probe_timeout、cleanup_unknown、tool_identity_changed、legacy_tool_identity_missing、io_error、unavailable。它们保留路径、权限、启动器、输出、协议、期限、回收和原身份故障，原始命令输出及 cause 只留本地。not_checked 是状态而非异常。

工具扩展受 256 KiB UTF-8 JSON 编码子预算、所选完整请求预算（配置报告 9 MiB，普通报告 1 MiB）和已存 telemetry/Worker 4 MiB 预算共同约束，不保证所有字段可同时取最大值。生产者预算不足时省略完整运行组，并在仍不能容纳时降为有界 pending/report_budget_exceeded 观察，保留本地完整事实和普通心跳；不能删掉必需任务清单或未确认配置结果制造成功。若必需内容占用的剩余预算连保留完整 target 的降级条目也无法容纳，则省略可选工具扩展，保留本地 report_budget_exceeded 结果；缺少扩展不能继续展示上次成功。服务继续严格拒绝超限或格式错误输入，不替客户端截断数据。

服务只验证结构、来源时间、版本关系、路径语法、预算和账号归属，不运行工具。工具状态由 Worker 运行管理器提供；未接入该管理器的 Worker 不得从 bare 版本字符串生成工具实际路径或 applied。

### 助手托管预检

可选 `assistantHost` 一旦提供就必须是完整对象，不接受 null、未知字段或重复键：

| 字段 | 内容 |
|---|---|
| protocolVersion | 数值 `1` |
| observedAt | 本次预检的有效 RFC3339 来源时刻 |
| defaultCwd | Worker 启动目录，按报告 platform 验证绝对路径语法，最多 4096 UTF-8 字节 |
| defaultProvider | `codex`、`claude` 或 `copilot`，来自 Worker 全局配置 |
| providers | 恰好三个不重复的 Provider 条目，每项为 `{provider,available,reason,model,args}` |

`available` 为布尔值，成功时 `reason=null`；失败时 reason 仅接受
`unsupported_arguments`、`invalid_cwd`、`not_found`、`permission_denied`、
`timeout`、`command_failed`、`invalid_output`、`unavailable`。
model 为 null 或最多 256 UTF-8 字节的非空白文本；args 为显式数组，最多 128 项，每项为最多 4096 UTF-8 字节的非空白文本。目录、model 和 args 不接受控制字符。`unsupported_arguments` 必须同时清空 model 为 null、args 为 []，不能把不支持的原生命令或凭据作为报告内容。

默认 Provider 才能继承全局 model/args；其它 Provider 使用各自原生默认，即 model=null、args=[]。所有 Provider 都按 Web 适配器参数规则预检，Worker 任务使用 Herdr 不影响该规则。Worker 本机核对真实目录与可执行文件；服务端只校验路径语法，不访问另一台机器的目录。Windows 接受完整盘符路径或 UNC 路径，不接受 drive-relative 路径。

预检成功只表示在来源时刻通过有界启动条件检查，不证明认证、模型访问或原生 Session 已成功建立。消费者必须同时核对 Worker 最近报告和预检时刻：两者都不能在服务端当前时间之后，且年龄都必须小于 120 秒；达到边界即不可作为可启动依据。缺报告表示不支持助手托管；依次区分 offline、stale、全部 Provider unavailable 和至少一个 Provider available。选择具体 Provider 时还必须检查对应条目，不能用另一 Provider 的成功替代。

每次有效机器报告完整替换助手预检；后来省略字段会清除之前的助手能力，不能沿用任务清单 null 的保留行为。详情保留原报告及 observedAt，不把历史 available 改写为当前启动承诺。服务层提供上述状态判断供创建默认解析使用；普通 Worker 列表和详情外层字段保持原有结构。

报告协议和预检采集器不代表完整助手已可运行。默认 Worker runtime 不提交此扩展；只有完成托管链路组合后才能接入能力广告。

### 任务清单

非 null 的 taskInventory 必须包含有效 observedAt 和显式 claims 数组；空数组表示已知无任务，null/missing claims 无效。每项仅包含必填 `{projectId,taskId,claimId}`，同一规范化 taskId 不得重复，最多 256 个不同任务引用。

服务端根据这些引用读取当前任务，只接受认证账号与 workerId 拥有的相同 active claim，且 task 为 in_progress、未删除、账号仍有项目权限。任务标题、项目名、status、phase 和 agent 均取服务端数据，客户端不能提供这些权威字段。已完成、已撤回、转交或失权的普通竞态省略对应引用；不存在与不可访问的目标不通过省略差异泄漏给调用者。

报告发送的是完整任务观测清单，不按 maxConcurrent 截断。恢复清单可以大于当前并发设置；所选报告传输上限仍适用，超限明确失败。独立的 configuration.observation.items 使用[配置协议](daynight-worker-configuration.md#应用观测)规定的本批有界集合；服务端接纳后整体替换该批，遗漏项表示本次未观察，本机保留事实不因此被确认或删除。任务清单的完整性和应用观测的分批语义分别保持。

## 最新快照与时间

telemetry 和完整 Worker 单项分别受 4 MiB 规范化 JSON 编码预算约束；字段和集合上限同时生效，不保证各字段可同时填满。完整 Worker 以合并后实际存储的快照计量，包括 unavailable 报告保留的旧 stale 任务。超限为 400 invalid_input，事务不提交。

一次成功报告原子保存服务端 observation 时间、telemetry 和规范化任务快照。lastReportedAt 是取得账号准入锁后采集的数据库时间，不是客户端时刻；目标原有时间位于未来时，成功报告以本次数据库时间更新它。响应 observedAt 是服务端时间样本。

每个账号跨服务实例最多准入 100 个 active Worker。以同一数据库时刻 T 为准，只有 `T - 120s < lastReportedAt <= T` 才是 active，恰好 120 秒及未来时间均不计入。满 100 个时已有 active Worker 可以续报，新 Worker 或 inactive Worker 恢复返回 `409 active_worker_limit_exceeded`。如果完整 active 数已超过 100，任何报告都返回该错误，包括已有 active 的续报；已保存的成功时间自然过期后，按当时计数重新准入。

额度拒绝、非法报告及确认回滚的事务不更新目标的成功时间、机器或任务快照、配置和应用观测；提交结果未知不能推断已回滚。准入不改写其他 Worker 的时间、不驱逐执行，也不限制历史 inactive 记录数量。active 与是否持有任务无关；所有成功报告入口遵循同一账号准入。

| taskInventory 情况 | taskObservationState 与任务结果 |
|---|---|
| null，尚无已知快照 | unavailable，taskObservedAt 和 activeTaskCount 为 null，tasks 为 [] |
| null，已有已知快照 | stale，保留原任务与观测时刻 |
| 完整清单，包括 [] | observed，保存本次规范化任务；空结果的 activeTaskCount 为 0 |

连续 null 不会把从未同步的 Worker 变成已知空闲。inventoryObservedAt 是客户端清单来源时间；taskObservedAt 是服务端生成该任务快照的时间；lastReportedAt 是本次机器报告时间。stale 的硬件数据可以较新，任务观测仍带原时间。

读取不会刷新 lastReportedAt。近期条件为 `lastReportedAt >= observedAt - 72h`，恰好 72 小时仍可见。在线状态采用同一 active 时间规则，恰好 120 秒或未来时间为 offline；接口提供时间事实，不持久化或返回可续活的在线标记。

离线和移出近期列表只影响观测可见性，不释放/撤回 claim、不改变 task 状态、版本、执行计时或本机数据。新资源只由有效报告登记，不从旧 claim 或任务更新时间合成活跃记录。

## 列表与详情

列表只接受 limit 和 cursor；limit 默认 50，范围 1–100。显式空值、重复或未知参数为输入错误。items 始终为数组，nextCursor 为字符串或 null。

每项摘要包含：

```text
workerId, machine, platform, lastReportedAt,
taskObservationState, taskObservedAt, activeTaskCount
```

activeTaskCount 是当前有权限访问的快照任务数。它不是实时任务归属统计；unavailable 为 null，observed/stale 为过滤后整数，包括 0。列表不复制完整 telemetry。报告入口负责结构、字段、规范化和现有容量规则；列表与详情直接读取保存的规范数据，不重复校验这些规则。正常解码和响应编码失败保留原错误链，不转换为空结果。

详情 worker 在摘要字段之外包含 telemetry、inventoryObservedAt、tasks。telemetry 使用报告中的结构，tasks 始终为数组；每项为 `{projectId,taskId,claimId,title,projectName,status,phase,agent}`。status 和 phase 是上报时的规范化值；agent 沿用当前 claim 枚举，包含 codex、copilot、claude。

每次读取都按当前项目准入和 task 未删除状态过滤保存的任务，摘要计数与详情数组使用同一可见性规则。当前 claim 后续完成或转交不会抹掉仍有权限访问的旧观测；被删除或失去项目权限的任务及其旧标题不再返回。过滤不改写保存的快照；重新获得项目权限后，仍未删除的历史观测可再次返回。任务链接读取的当前详情与历史观测各有其时间含义。

分页使用不可变 `(created_at,worker_id)` 位置，cursor 绑定资源类型和认证账号。持续更新的 lastReportedAt 不作为位置；换账号或不匹配的 cursor 返回输入错误。每页是各自一致的读取快照，跨页期间的新注册或重新活跃记录可在下一轮遍历出现。

列表按请求条数分页，以 `limit+1` 判断是否还有记录；有后续项时 cursor 指向最后返回项，末页为 null。列表与详情不设置读取响应字节预算，也不因保存数据的容量重新拒绝读取。写入容量规则不转化为额外配额。

## 错误与可观察结果

格式与约束错误沿用 `400 invalid_input`，未认证为 401，未知/他人/超窗详情为 404，active 名额拒绝为 `409 active_worker_limit_exceeded`，存储失败为清洗后的 500。失败响应保留既有 requestId，SQL、连接串、完整遥测、原生命令输出和凭据不进入诊断。

必须能够观察账号隔离、null/空/旧清单、部分采集错误、并发报告、当前权限变化、完成后的历史任务、时间窗口和稳定分页。以独立服务实例和受控时间验证 99、100、101 个 active 时的续报、新建及恢复、锁等待后重新取时、取消和失败回滚；同时验证拒绝不改写报告或配置，并在自然过期后恢复准入。存储失败保留错误链，不能伪装成成功或空列表。
