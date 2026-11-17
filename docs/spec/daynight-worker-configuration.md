# Worker 云端配置接口

本文拥有账号级 Worker 目标配置与本机应用观测的服务端协议及消费者必须保持的数据含义。[设计](../design/daynight-worker-configuration.md)拥有表示与事务；[运行快照](daynight-worker-snapshots.md)继续拥有机器报告、在线与近期窗口。配置接入不依赖 active claim，不改变 Task/claim 的数据、接口、认领或恢复规则。

## 资源与认证

| 方法 | 路径 | 成功结果 |
| --- | --- | --- |
| GET、HEAD | /api/v1/me/workers/{workerId}/configuration | 当前云端目标、应用观测版本与最近结果 |
| PUT | /api/v1/me/workers/{workerId}/configuration | 版本化保存完整目标后返回配置资源 |

资源由认证账号和规范 workerId 定位。沿用 PAT/浏览器会话、Cookie 写入的主站 Origin、Daynight-User-ID 和 no-store。端点不接受查询参数，未知方法返回带 Allow 的 405。未知或他人 Worker 为 404。

配置查询不使用 72 小时近期条件，不刷新 lastReportedAt。现有 Worker 列表与详情窗口保持。资源包含 desired、observationRevision、observation；尚未导入时 desired 为 null，尚无应用观测时 observation 为 null。

## 目标配置

基础配置完整值包含 maxConcurrent、pollIntervalMs、recoveryLimit、preferPlatformSpecificTasks、native 与 projects，均必填。非 null 目标在直接配置响应中始终提供 enableSudoCleanup；写入可省略，省略时按下述规则保留或初始化。toolPaths 为必需的两工具字段；agentControlMode 不属于新目标。服务端输入拒绝未知、重复、其他必填字段缺失、非法 UTF-8/NUL、错误类型和尾随 JSON。Worker 对成功响应的未知内容遵循下述保留规则，已知字段校验保持严格。

| 字段 | 语义 |
| --- | --- |
| maxConcurrent | 1..64 的整数 |
| pollIntervalMs | 1000..60000 的整数，单位毫秒 |
| recoveryLimit | 0..10 的整数 |
| preferPlatformSpecificTasks | 布尔值；true 优先领取明确指定当前运行平台的任务，false 保留原候选顺序 |
| enableSudoCleanup | 布尔值；默认 false，保存目标不代表 Worker 已应用或执行 sudo |
| toolPaths | 固定两键 codex/copilot，各项为未采纳 null、显式自动或显式路径 |
| native | 完整 {agent,model,args}，Agent 为 codex、copilot 或 claude |
| projects | 显式数组；条目为 {projectId,nativeOverrides}，规范 Project UUID 不重复，最多 128 项 |

全局 model 是非空且不含控制字符的字符串或显式 null，null 表示 provider 默认模型；args 是字符串数组，各参数非空且不含控制字符，[] 表示无附加参数。项目 nativeOverrides 只允许 agent/model/args；缺失 key 表示继承，model:null 与 args:[] 是显式清除。Agent 与全局不同时，未显式给出的 model/args 使用该工具默认值；服务端保存意图，不执行工具准备。

model 最多 256 UTF-8 字节；args 最多 128 项，每项最多 4096 UTF-8 字节。项目覆盖遵循相同限制。本地候选及云端目标共享这些数值和集合限制。

项目列表规范化后比较语义值。preferPlatformSpecificTasks 是每个 Worker 独立的运行设置，首次本地候选省略时为 false；云端完整目标必须显式提供布尔值。开启后对所有已选且可领取项目的后续新领取生效，各类别独立保留项目轮转与项目内创建顺序，具体调度行为由 [Worker 需求](daynight-worker.md#w-05调度与全局并发)拥有。repositoryRoot、仓库本机路径、服务连接与凭据及 Worker 身份不属于目标配置。toolPaths 是 Worker 级目标，不允许项目 nativeOverrides 覆盖。

### 工具路径三态

toolPaths 的两个键均必填。每项 null 表示尚未采纳；`{kind:"auto"}` 表示明确恢复自动；`{kind:"path",path:string}` 表示完整文件路径。旧目标原样返回，不将缺失值推断为 auto。已采纳 choice 不能清回 null。Web Copilot 的自动选择使用内置来源。

path 最多 4096 UTF-8 字节，必须是有效 Unicode、非空白且不含控制字符的绝对路径；保留原始空格、大小写和词法路径，不 trim、不展开环境变量或 `~`、不拆参数、不交给 shell。服务和浏览器只校验远端路径语法，不访问文件；真实存在性、入口种类、解释器与协议由 Worker 验证。不能用服务所在操作系统的路径规则拒绝另一平台的合法路径。

## Worker 响应的未知内容保留

Worker 对配置 GET、普通报告回执及 prompts 联合回执使用配置专用源文本载体，完整保留 desired 与外层未知元数据，持久目标只保存 desired 原始 JSON。native、projects、nativeOverrides 与 toolPaths 已知对象中的未知兄弟同样保留。未知数字不经普通 number 解码后回写；合法负数、小数、指数和超安全整数保持数据含义。字符串、boolean/null、数组顺序和对象成员均保持，空白排版不构成保证。重复解码键、深度和原有字节边界继续有效。

known 仅从已知路径投影并按原合同严格验证，未知 observation kind 只保留在完整远端观测中，不套用已知 appliedValue 枚举，也不进入 Worker 本机 currentItems/retainedItems。未知目标不生成执行、pending 或 applied；Worker 只报告自身真正处理的已知项。显式 GET 的远端观测和报告 receipt 的接纳事实分别保留，后者不能伪造前者已被重新读取。

仅未知字段、更高 revision 或 updatedAt 变化时，Worker 更新完整目标并保持已知应用身份、applicationRevision 与在途工作；已知目标变化才正常应用。报告 observation.desiredRevision 使用最新收到版本，item.targetRevision 仍为真实应用目标版本。同 revision 的 desired 必须在双方可见内容上 JSON 语义相等：对象成员顺序无关，数组顺序有关，等值十进制数字写法相等且不经浮点舍入。同版本的语义差异为协议错误。迟到较低回执不回退目标；回执暴露较低目标或观测计数时 Worker 重新执行认证 GET，以确认并恢复服务状态。缓存格式、应用版本消费者和恢复由[Worker 需求](daynight-worker.md#w-01前台运行配置与平台)与[设计](../design/daynight-worker.md#云端接收与本机提交)拥有。

本项未知内容保留不放宽服务端严格输入合同。支持扩展容忍的客户端必须先实际采用，服务随后才能直接增加新字段；未打补丁的旧严格客户端不因此取得兼容能力。

## 兼容基线与上线

服务直接返回 enableSudoCleanup，不为该字段新增能力头或端点。上线前须确认需要持续使用的 Worker 已运行支持未知配置保留的版本，Web 已采用相应兼容版本，仍打开的严格旧页面已刷新。代码合入或发版本身不能证明这些客户端已实际采用；尚未打补丁的严格旧客户端不属于新增字段后的支持基线。若仍需支持它们，服务应保持原格式直到兼容基线就绪。

兼容但尚不认识该字段的 Worker 保留目标，继续处理已知配置，并不把未知目标报告为已应用。兼容 Web 在修改已知字段时保留该值。新服务提供目标不表示 Worker 已具备 sudo 清理实现，也不表示生产环境已经启用它。

## 首次导入与编辑

完整本地候选只在目标不存在时原子建立 revision 1；已有目标时忽略完整候选。toolPathsBootstrap 是完整两项非 null choice 或整体 null，只填尚未采纳的项；省略的本地工具项成为 auto。多个工具的采纳合并为一次持久化，只推进一次 revision。并发编辑使用同一 Worker 行锁与目标版本合同，冲突不能自动重放。接入不要求先处理任务，也不回写用户 YAML。

PUT 使用 {revision,value} 替换已初始化目标。若 value 省略 enableSudoCleanup，服务在目标版本检查与同一事务内保留当前值；显式 false 是关闭，null 和非布尔值无效。首次 bootstrap 省略该字段时初始化为 false，已有目标不被后续完整 bootstrap 覆盖。revision 是读取时的目标版本，为 1..9223372036854775807 的规范十进制字符串，不接受前导零、符号、小数或指数。版本不符为 409 version_conflict；规范值相同不递增目标版本或修改时间。目标尚未导入时返回 409 configuration_not_initialized，不能通过 PUT 创建它；revision:"0" 不是合法创建操作。达到最大正 int64 后需要真实变化时为 409 version_exhausted，同值 no-op 仍有效。

新增或修改的项目条目必须可访问。原样保留或删除已选但后来失权的条目，不阻塞其他配置编辑；不能获取失权项目的名称或仓库信息。

## 心跳扩展

### 工具路径协议

配置 GET/HEAD/PUT、报告 POST 和 Worker 详情 GET/HEAD 必须请求并收到 `Daynight-Worker-Tool-Paths: 2` 回显；缺失、重复或其他版本在业务处理前返回 400 invalid_input。Worker 列表仍为摘要，不检查该头。配置协议 1/2 保持自身职责，claim 使用原有 Worker-Protocol:2。客户端遇到缺失回显应提示升级服务，不能降级重发旧正文；Worker 在领取新任务前完成协议准备。

旧目标不经新 schema 重写：GET 返回原始 JSON 和 revision。CLI 将不支持的旧字段视为配置问题，不自动导入或启动任务；Web 展示原目标及问题，用户明确保存完整新配置后才替换。PUT 仍按目标 CAS、项目权限和 no-op 规则处理。历史 telemetry 只投影真实存在的 codex/web、copilot/web 观察，不伪造值。

工具实际状态使用[工具路径观察](daynight-worker-snapshots.md#工具路径观察)。Codex/Copilot 的版本、模型、host 能力及新执行消费同一个已验证选择；保存目标不等于准入成功。首次执行冻结实际命令及依赖身份，改变目标或 PATH 仅影响后续执行；原身份缺失或变化时恢复拒绝新 spawn。已有执行的输入、停止和归档保留原归属。

### 配置报告

Worker 配置客户端对原报告端点发送 Daynight-Worker-Configuration: 2。该标记选择配置交换格式和 9 MiB 报告正文上限，不改变任务或 inventory 协议。协议 1 同样使用 9 MiB，未携带配置协议的报告保持 1 MiB。重复或未知协议头在业务调用前拒绝。未携带标记的报告和协议 1 保留各自的既有字段与回执合同。协议 2 在同一报告回执中附带有限的个人 prompt 结果；selector、权限和错误由[个人 prompt 接口](worker-prompts.md#配置报告同步)拥有。

扩展正文增加 configuration，含显式 nullable bootstrap 和 observation。bootstrap 为完整候选；没有候选时为 null。toolPathsBootstrap 必填，为完整两项 choice 或 null。即使已有云端 desired，仍可提交独立采纳候选。observation 包含 baseRevision、desiredRevision 和本次有界的 items 集合；尚无结果时为 null。每个发送项保持完整结构，本机全部应用与保留事实不必同时进入一次报告。

扩展回执保留原时间字段，并含 configuration:{desired,observationRevision,observationAccepted}。观测 CAS 不匹配时返回 false 与当前版本，保留已有应用观测；合法机器报告仍按原规则保存。响应未知不能被当作未写入，后续使用最新实际状态收敛，不重放旧报告。

## 应用观测

每项含 key、targetRevision、appliedValue、state、error、lastFailure、nextAttemptAt；项目 key 另外包含 projectId。state 为 pending、applying、applied 或 error。服务端每批最多接受 1027 个不同 key；CLI 每批最多发送 1025 项。应用值遵循目标配置相同的字段与数值限制。

| kind | appliedValue |
| --- | --- |
| maxConcurrent、pollIntervalMs、recoveryLimit | 对应合法标量或 null |
| preferPlatformSpecificTasks | true 或 false 表示已应用的优先策略；尚无确认值时为 null |
| enableSudoCleanup | true 或 false 表示实际应用的清理设置；尚无确认值时为 null |
| native、projectNative | 完整 native 元组或 null |
| projectPreparation | true 表示已准备；没有可确认结果时为 null |
| projectRemoval | true 表示已移除/停止；没有可确认结果时为 null |

null 表示没有可确认的实际值，不是生效默认值；preferPlatformSpecificTasks:false 和 enableSudoCleanup:false 分别表示对应设置已应用关闭，不能解释为缺少结果。服务不会因保存或初始化目标而生成应用观察；不认识该字段的兼容 Worker 不报告该项。项目准备与移除可以来自不同目标版本，必须保留对应 targetRevision；结果不携带 Task 或 claim 标识。

error 表示当前失败，lastFailure 保留尚需报告的最近失败，nextAttemptAt 为 nullable RFC3339 本机重试期限。失败使用闭合 code/category/phase 及 occurredAt，不接受自由命令输出、配置正文或敏感信息。code 为 not_found、permission_denied、timeout、command_failed、invalid_output、invalid_configuration、io_error 或 unavailable；category 为 validation、repository、agent、runtime、storage；phase 为 validate、prepare、apply、stop、persist。error 只在 state:error 时存在；applied 必须具有非 null 实际值，nextAttemptAt 只用于 error 状态。pending/applying/error 可保留先前成功值。恢复可清除当前 error，不能提前丢弃尚未报告的失败。

目标配置值以及实际存储的应用观测（包含服务端生成的 reportedAt）分别受 4 MiB 规范化 JSON 编码预算约束。超限返回 400 invalid_input，整个事务回滚。客户端以 Go JSON 的 HTML、U+2028/U+2029 转义字节计量观测，并预留 512 字节覆盖 reportedAt 与存储包装；本批还须同时满足条数上限和完整配置报告的 9 MiB 请求预算。

本机完整事实与网络报告分别管理。当前目标变更或本机项目移除责任登记不以一次报告的条数或字节名额为前置；已确认且不再需要的记录可以收敛，未完成停止、未知结果、仍有归属的工作和未确认失败继续保留。结构合法但当前网络表示无法容纳的历史值保留本机，不能截断实际值、改成 null 或伪报确认。

有未完成或失败移除时，每批固定包含一项真实当前停止核验，优先反映其原停止责任的最高严重程度。其余合格项按持久化的 recordId 游标连续轮转；遇到第一个因条数或字节预算不能进入的项即结束本批，该项成为下批起点，不跳过大项填入后续小项。合法最大 native 单项可在带固定移除项的下一批实际发送。匹配且 observationAccepted=true 的回执才确认所发送的失败来源；游标仅在捕获属于当前本机 generation 时推进。拒绝、未知回执和重启不能丢弃未报告的本机事实。

同 key 的当前与保留记录分别拥有失败，wire lastFailure 选取最近的一条待确认失败。确认必须匹配本次实际发送的 sourceRecordId/failureId，不清除同 key 的较新或未发送失败。没有合法当前载体的旧失败留在本机，不制造新项目目标以获得上传名额。来源标识、原操作和实际值出处属于本机检查点，不增加公开 DTO 字段。

服务端整体替换最近一次接纳的 observation，不把多批结果合成为不存在的完整历史。遗漏表示本次未观察，不能推断为已应用、已停止或已确认；正常可全部容纳时仍发送完整当前投影。

baseRevision 允许初始 "0"。desiredRevision 和每项 targetRevision 为正 int64 十进制字符串，不得引用未来目标。资源 observation 的 reportedAt 由数据库生成，仅在观测被接纳时更新，输入不能提供它。GET 中保留该次输入的 baseRevision，而下一次报告必须使用外层当前 observationRevision。普通或 CAS 被拒绝的机器报告不能更新这个应用确认时间。

## 有效原生配置来源

机器 telemetry 可包含 `runtimeConfiguration`，与 configuration 中的云端目标及应用观测分开：

```json
{
  "schemaVersion": 1,
  "native": {
    "agent": "codex",
    "model": { "value": "model-id", "source": "local" },
    "reasoningEffort": { "value": "high", "source": "cloud" }
  },
  "projects": []
}
```

`native` 是可空的完整原生来源对象，`projects` 是最多 128 项的完整列表，每项包含规范且不重复的 `projectId` 与同形可空 `native`。来源对象的 Agent 为 codex/claude/copilot；两个值对象均必填，source 只能为 local/cloud/native。local/cloud 对应非空字符串，model 最多 256 字节、reasoningEffort 最多 64 字节；native 来源必须 value:null，表示 Daynight 未指定该项，不是对 Agent 实际解析值的观察。字符串不得包含控制字符。

云端目标尚未建立、Worker 按本地候选运行可访问项目时，报告该本地全局配置及当前可运行项目；本地候选中明确的旧 model/args 也标记 local，不能冒充 cloud。云端目标建立后报告切换为云端有效配置与本地覆盖的组合。

不可用原生配置用 native:null 表示。旧合法云端模型超过来源报告上限时该项也报告 null；超过项目上限时省略整个可选对象，不截断并假称完整，也不让可选观测阻断心跳。完整报告（含配置观测、任务清单和遥测）按 UTF-8 JSON 编码共同受所选请求上限约束：配置协议报告为 9 MiB，普通报告为 1 MiB；仅来源对象使原本合法的完整报告超限时，整份省略 runtimeConfiguration。必需内容本身超限仍明确拒绝，不截断清单，也不隐藏序列化错误。字段存在时不得为 null，必须满足 schemaVersion=1 的闭合结构。新服务接受旧客户端省略字段，新客户端发送该对象需要支持它的服务；旧严格服务的拒绝不能被解释为已保存来源。

服务器按完整 telemetry 替换存储。移除本地覆盖后的新报告更新有效值及来源；后续报告省略整个字段也必须移除旧观测，不保留过时的 local 标签。该对象不会写入 desired、改变目标版本或取得执行资格。字段归属和组合规则由 [Worker 需求](daynight-worker.md#本地模型与推理强度覆盖)拥有。

## Web 消费者

“我的 Worker”详情的配置表单编辑 desired.value，以 desired.revision 保存完整目标；observationRevision 与 observation 只用于展示最近应用报告，不改变草稿的保存版本。页面的运行观测和配置分别读取：近期快照超窗的 404 不代表配置不存在，配置读取失败也不清除独立的运行观测。客户端校验工具协议版本回显，不能从默认值或已有目标推断支持。desired:null 表示尚未首次导入，Web 不能使用 PUT 建立初值。

Web 对成功配置响应保留完整未知目标和未知观测项，已知字段仍按类型、范围、必填和身份规则严格校验；未知项不生成控件或应用成功。编辑已知字段时保留同一目标版本下未修改的未知数据，包括无法由 JavaScript number 精确表示的数值。明确移除项目时一并移除该项目的未知内容；保留的项目按 projectId 对齐。回执和未知结果查询核对完整目标语义，不能只比较已知字段。后台读取不将新版本基底静默用于旧草稿。

服务端增加未来配置字段前，必须确认需要持续使用的 Web 已使用兼容版本，仍打开的严格旧页面已刷新；部署新资源本身不会更新已打开页面。服务端当前请求准入保持严格新合同。

表单保留项目覆盖的字段存在性、model:null 与 args:[]，并区分目标、尚未确认的实际值和每项结果。比较目标时保留各项 targetRevision 与实际值：值未变的独立项可沿用成功；缺失项不得被其它字段成功覆盖，项目准备/native 还需核对当前目标观测及后续移除版本；已移除项目的 projectRemoval 保留自己的状态和版本，结果仍应显示。observation.reportedAt 表示服务器接纳本批应用结果的时刻，不能以机器上报时间或保存目标的时间替代它。配置反馈使用最近接纳的整批观测，缺少当前目标项时保持 pending，不跨批拼接旧项来宣称完整成功。

工具草稿保留两项 choice/null，空 path 不隐式变成 auto。客户端必须确认工具协议并以完整目标保存；旧目标的问题和原始值保持可查看，只有明确保存才移除不支持的旧字段。未知保存先回读完整当前目标，缺失或陈旧不能确认结果；实际应用来自 telemetry.toolPaths，并核对当前 desired revision 和 choice。

保存冲突、明确失败和响应未知保留草稿及无效原始输入。响应未知先读取当前资源核对，不重放 PUT，不根据同值核对推断先前写入成功。保存准备或结果发布期间准入暂停时，本地 pending 与保存 promise 在结果已知或取消分类后结束，保留已有配置和草稿；暂停期间不自动读取或重放。未派发的取消不代表写入，已派发而未确认的结果仍需核对，可信保存确认不因后续发布失败变为未知。取消网络不证明服务端回滚。

延迟结果的资源发布仍须通过原账号和 Worker 的准入，且不能覆盖提交之后的草稿编辑或清除其未保存状态。临时暂停恢复后可发布同一操作的结果；新的保存仍须重新满足版本、权限、新鲜度和操作身份检查。本地 pending 结束本身不授权再次保存；已确认结果尚未发布时不能以旧资源执行丢弃，离开时放弃草稿的意图仍需在结果发布时保留。完整编辑与交互要求由[Web 需求](daynight-web.md#云端运行配置)拥有，机制由[Web 设计](../design/daynight-web.md#worker-云端配置编辑)拥有；Web 展示的应用结果来自 Worker 报告，不能作为本机副作用的独立证明。

## 失败与验证

输入约束与格式错误为 400；目标版本冲突、尚未初始化或版本耗尽为明确错误；未认证为 401、其他账号或未知 Worker 为 404。存储错误保留链并返回清洗后的 500。响应沿用 requestId，不记录配置正文或原始工具错误。

Worker 本机检查点的临时文件 I/O 故障独立于服务端事务错误：在原实例所有权中等待并重试同一冻结结果，未保存应用不公开，已知报告回执不因等待者取消失去归属。格式、身份和其它确定错误仍拒绝；新执行准入服从存储 readiness，原执行与停止事实继续保留。应用错误只从实际受控类型或操作边界映射为上述闭合词汇；本机阶段、原记录/目标与当前权威关联、远端/本地确定性和五分钟摘要由[报告诊断需求](daynight-worker-reporting.md#配置交换)拥有，不增加 wire 字段或更改 API 错误外壳。完整本机恢复及关闭合同由[Worker 需求](daynight-worker.md#w-01前台运行配置与平台)与[设计](../design/daynight-worker.md#临时存储恢复与准入)拥有。

验证覆盖账号与 Origin、闭合字段、继承/null/[]、完整版本范围、并发导入、独立 CAS、相同值 no-op、过期窗口、当前项目权限、旧格式及存在运行中任务时的接入。Web 保存验证覆盖准入前取消、派发后未确认、可信确认后的发布失败、暂停中的本地收尾和保留草稿、恢复发布与较新编辑，以及 owner 替换或销毁时的取消。服务端接纳应用观测不代替真实 Worker 应用验证。
