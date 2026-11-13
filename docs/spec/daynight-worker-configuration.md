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

基础配置完整值包含 maxConcurrent、pollIntervalMs、recoveryLimit、preferPlatformSpecificTasks、native 与 projects，均必填。独立能力协商分别决定 agentControlMode 和 toolPaths 的必需字段。未知、重复、缺失字段、非法 UTF-8/NUL、错误类型和尾随 JSON 明确拒绝。

| 字段 | 语义 |
| --- | --- |
| maxConcurrent | 1..64 的整数 |
| pollIntervalMs | 1000..60000 的整数，单位毫秒 |
| recoveryLimit | 0..10 的整数 |
| preferPlatformSpecificTasks | 布尔值；true 优先领取明确指定当前运行平台的任务，false 保留原候选顺序 |
| agentControlMode | 协商后为 herdr 或 web；已有旧目标尚未采纳时可为 null，不是第三种模式 |
| toolPaths | 工具能力协商后为固定三键 codex/copilot/herdr，各项为未采纳 null、显式自动或显式路径 |
| native | 完整 {agent,model,args}，Agent 为 codex、copilot 或 claude |
| projects | 显式数组；条目为 {projectId,nativeOverrides}，规范 Project UUID 不重复，最多 128 项 |

全局 model 是非空且不含控制字符的字符串或显式 null，null 表示 provider 默认模型；args 是字符串数组，各参数非空且不含控制字符，[] 表示无附加参数。项目 nativeOverrides 只允许 agent/model/args；缺失 key 表示继承，model:null 与 args:[] 是显式清除。Agent 与全局不同时，未显式给出的 model/args 使用该工具默认值；服务端保存意图，不执行工具准备。

model 最多 256 UTF-8 字节；args 最多 128 项，每项最多 4096 UTF-8 字节。项目覆盖遵循相同限制。本地候选及云端目标共享这些数值和集合限制。

项目列表规范化后比较语义值。preferPlatformSpecificTasks 是每个 Worker 独立的运行设置，首次本地候选省略时为 false；云端完整目标必须显式提供布尔值。开启后对所有已选且可领取项目的后续新领取生效，各类别独立保留项目轮转与项目内创建顺序，具体调度行为由 [Worker 需求](daynight-worker.md#w-05调度与全局并发)拥有。repositoryRoot、仓库本机路径、服务连接与凭据及 Worker 身份不属于目标配置。agentControlMode 与 toolPaths 是 Worker 级目标，不允许项目 nativeOverrides 覆盖。新完整 bootstrap 必须提供 herdr 或 web；PUT 可保留尚未采纳的 null，但不能将已采纳模式清空。

### 工具路径三态

toolPaths 的三个键均必填。每项 null 表示尚未采纳；`{kind:"auto"}` 表示明确恢复自动；`{kind:"path",path:string}` 表示完整文件路径。旧存储缺少 toolPaths 时读取为三个 null，不能推断为 auto。已采纳 choice 不能清回 null。自动来源由工具及执行模式决定，Web Copilot 的内置来源与 Herdr Copilot 的命令环境发现分别保留。

path 最多 4096 UTF-8 字节，必须是有效 Unicode、非空白且不含控制字符的绝对路径；保留原始空格、大小写和词法路径，不 trim、不展开环境变量或 `~`、不拆参数、不交给 shell。服务和浏览器只校验远端路径语法，不访问文件；真实存在性、入口种类、解释器与协议由 Worker 验证。不能用服务所在操作系统的路径规则拒绝另一平台的合法路径。

## 首次导入与编辑

完整本地候选只在目标不存在时原子建立 revision 1；已有目标时忽略完整候选，始终保留云端值。独立 controlModeBootstrap 候选只在目标尚未采纳模式时填入 agentControlMode。toolPathsBootstrap 是完整三项非 null choice 或整体 null，只填现有目标中对应的 null 项。候选来自同一捕获的本机配置：明确 web 保持 web，未指定模式才为 herdr；省略的本地工具项成为 auto。模式和多个工具的采纳合并为一次最终值持久化，只推进一次 revision；完整首次导入不额外升版，任何编码或容量失败回滚全部采纳。

网页选择、并发采纳和迟到候选使用同一 Worker 行锁与目标版本合同。网页先明确 Codex 时，随后 bootstrap 只填仍未采纳的 Copilot/Herdr；bootstrap 先提交时，旧 revision 的网页 PUT 冲突，不能自动重放。已保存的非 null choice 不被候选覆盖；恢复 auto 后本地旧路径不再出现。接入不查询任务状态或要求先处理任务，不回写用户 YAML。

PUT 使用 {revision,value} 完整替换已初始化目标。revision 是读取时的目标版本，为 1..9223372036854775807 的规范十进制字符串，不接受前导零、符号、小数或指数。版本不符为 409 version_conflict；规范值相同不递增目标版本或修改时间。目标尚未导入时返回 409 configuration_not_initialized，不能通过 PUT 创建它；revision:"0" 不是合法创建操作。达到最大正 int64 后需要真实变化时为 409 version_exhausted，同值 no-op 仍有效。

新增或修改的项目条目必须可访问。原样保留或删除已选但后来失权的条目，不阻塞其他配置编辑；不能获取失权项目的名称或仓库信息。

## 托管模式能力

配置 GET、HEAD、PUT 及带配置的 Worker 报告使用独立请求头 Daynight-Worker-Control-Mode: 1。服务明确回显同名响应头才表示支持；它不替代 Daynight-Worker-Configuration: 1/2，不改变 prompt 结果、认证、Origin、principal 或 CAS。配置页面与 API 同源使用，不为该能力新增跨源准入。

未协商请求仍使用原严格结构：GET 和报告回执省略 agentControlMode，配置资源观测省略同名项。旧 PUT 在目标 CAS 和同一事务锁内保留当前模式，只替换原协议字段。旧存储记录缺失模式通过专用旧格式解码成为未采纳状态；新写入合同不因升级而放宽。

已经持久化 mode 应用观测后，服务回退仍必须提供旧严格客户端可解析的配置响应。旧服务后续报告若替换了模式证据，再次升级时该实际值保持尚未确认，直到新的 Worker 报告，不能重建伪 applied 状态。

新客户端未收到回显时按旧合同解析并继续本机模式，不向旧服务发送新正文。运行中的 Worker 必须继续探测服务升级或回退，并按新读取的能力构造后续报告，不自动重放结果未知的请求。Web 禁用该字段并提供升级说明，其他字段保持可编辑。支持能力的旧目标尚未采纳时显示等待同步，不能将默认 herdr 当作实际已应用。

## 心跳扩展

### 工具路径能力

`Daynight-Worker-Tool-Paths: 1` 独立于托管模式头和配置协议 1/2，适用于配置 GET/HEAD/PUT、报告 POST 及 Worker 列表/详情读取。多个头值或非 1 在业务调用前拒绝。只有服务回显同名头才确认支持；未协商响应省略 desired.value.toolPaths 和 telemetry.toolPaths，未协商报告拒绝工具正文扩展。列表仍是原摘要，不增加 telemetry。

旧 PUT 在 Worker 锁内通过目标 CAS 后保留当前 toolPaths，再执行完整规范化、预算与 no-op 比较；不能让旧客户端保存其它字段清除工具选择。客户端仅在当前 origin 和认证账号的配置 GET（包括已认证的 404）确认能力后上传工具扩展，不能跨账号复用或按版本号猜测。运行中的 Worker 必须独立重新发现工具能力；已支持托管模式的服务升级后，无需重启 Worker 或等待其它故障即可开始同步工具选择。旧服务下继续本地选择和原配置合同，不发送工具字段；响应未确认能力不等同于新字段已生效，也不允许重放未知写。

工具实际状态使用[工具路径观察](daynight-worker-snapshots.md#工具路径观察)，不增加 observation.items 的 appliedValue 分支。协议支持只证明可交换目标与事实，不能证明工具已应用。Web Codex/Copilot 的版本、模型、host 能力及新执行必须消费同一个已验证选择；保存目标不等于准入成功。首次执行冻结实际命令及依赖身份，改变目标或 PATH 仅影响后续新执行；原身份缺失或变化时恢复拒绝新 spawn，不能改用其它安装。已有活执行的输入、停止和归档继续原归属操作。旧记录不能证明工具身份或历史版本时明确报告未知。Herdr 模式同时冻结 Agent 与 Herdr launch，原 claim 恢复不读取新目标；macOS 新 execution 使用独占实例，Linux/Windows 共享实例在旧责任未确认清空时报告 pending。实际 Herdr 版本来自对应实例握手；新 spawn 或 attach 缺少原工具身份证据时明确拒绝，不能静默忽略目标或改用其它安装。

### 配置报告

Worker 配置客户端对原报告端点发送 Daynight-Worker-Configuration: 2。该标记选择配置交换格式和 9 MiB 报告正文上限，不改变任务或 inventory 协议。协议 1 同样使用 9 MiB，未携带配置协议的报告保持 1 MiB。重复或未知协议头在业务调用前拒绝。未携带标记的报告和协议 1 保留各自的既有字段与回执合同。协议 2 在同一报告回执中附带有限的个人 prompt 结果；selector、权限和错误由[个人 prompt 接口](worker-prompts.md#配置报告同步)拥有。

扩展正文增加 configuration，含显式 nullable bootstrap 和 observation。bootstrap 为完整候选；没有候选时为 null。托管模式能力确认后还必填 controlModeBootstrap，为 herdr、web 或 null；工具能力确认后必填 toolPathsBootstrap，为完整三项 choice 或 null。即使已有云端 desired，仍可提交独立采纳候选。observation 包含 baseRevision、desiredRevision 和本次有界的 items 集合；尚无结果时为 null。每个发送项保持完整结构，本机全部应用与保留事实不必同时进入一次报告。

扩展回执保留原时间字段，并含 configuration:{desired,observationRevision,observationAccepted}。观测 CAS 不匹配时返回 false 与当前版本，保留已有应用观测；合法机器报告仍按原规则保存。响应未知不能被当作未写入，后续使用最新实际状态收敛，不重放旧报告。

## 应用观测

每项含 key、targetRevision、appliedValue、state、error、lastFailure、nextAttemptAt；项目 key 另外包含 projectId。state 为 pending、applying、applied 或 error。未协商托管模式的本批 items 最多 1025 个不同 key；协商后最多 1026 项，其中非 mode 项仍最多 1025 个，应用值遵循目标配置相同的字段与数值限制。

| kind | appliedValue |
| --- | --- |
| maxConcurrent、pollIntervalMs、recoveryLimit | 对应合法标量或 null |
| preferPlatformSpecificTasks | true 或 false 表示已应用的优先策略；尚无确认值时为 null |
| agentControlMode | herdr 或 web 表示已应用模式；尚无确认值时为 null |
| native、projectNative | 完整 native 元组或 null |
| projectPreparation | true 表示已准备；没有可确认结果时为 null |
| projectRemoval | true 表示已移除/停止；没有可确认结果时为 null |

null 表示没有可确认的实际值，不是生效默认值；preferPlatformSpecificTasks:false 是已应用关闭，不能解释为缺少结果。项目准备与移除可以来自不同目标版本，必须保留对应 targetRevision；结果不携带 Task 或 claim 标识。

error 表示当前失败，lastFailure 保留尚需报告的最近失败，nextAttemptAt 为 nullable RFC3339 本机重试期限。失败使用闭合 code/category/phase 及 occurredAt，不接受自由命令输出、配置正文或敏感信息。code 为 not_found、permission_denied、timeout、command_failed、invalid_output、invalid_configuration、io_error 或 unavailable；category 为 validation、repository、agent、runtime、storage；phase 为 validate、prepare、apply、stop、persist。error 只在 state:error 时存在；applied 必须具有非 null 实际值，nextAttemptAt 只用于 error 状态。pending/applying/error 可保留先前成功值。恢复可清除当前 error，不能提前丢弃尚未报告的失败。

目标配置值以及实际存储的应用观测（包含服务端生成的 reportedAt）分别受 4 MiB 规范化 JSON 编码预算约束。超限返回 400 invalid_input，整个事务回滚。客户端以 Go JSON 的 HTML、U+2028/U+2029 转义字节计量观测，并预留 512 字节覆盖 reportedAt 与私有 mode 存储槽；本批还须同时满足条数上限和完整配置报告的 9 MiB 请求预算。

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

“我的 Worker”详情的配置表单编辑 desired.value，以 desired.revision 保存完整目标；observationRevision 与 observation 只用于展示最近应用报告，不改变草稿的保存版本。页面的运行观测和配置分别读取：近期快照超窗的 404 不代表配置不存在，配置读取失败也不清除独立的运行观测。响应正文没有 supported 标志；客户端从独立能力响应头记录模式支持情况，不能从默认值或已有目标推断支持。desired:null 表示尚未首次导入，Web 不能使用 PUT 建立初值。

表单保留项目覆盖的字段存在性、model:null 与 args:[]，并区分目标、尚未确认的实际值和每项结果。比较目标时保留各项 targetRevision 与实际值：值未变的独立项可沿用成功；模式应用仍需要同名观测，缺失项不得被其它字段成功覆盖，项目准备/native 还需核对当前目标观测及后续移除版本；已移除项目的 projectRemoval 保留自己的状态和版本，结果仍应显示。observation.reportedAt 表示服务器接纳本批应用结果的时刻，不能以机器上报时间或保存目标的时间替代它。配置反馈使用最近接纳的整批观测，缺少当前目标项时保持 pending，不跨批拼接旧项来宣称完整成功。

工具草稿保留三项 choice/null，空 path 不隐式变成 auto。客户端独立记录工具能力，只有服务确认且 Worker 快照包含工具报告才允许编辑与提交路径；缺能力时保存其它配置采用保留工具目标的旧投影。未知保存的回读必须包含当前 revision 下已保留的工具字段，缺失或陈旧不能确认结果。旧投影提交省略工具字段后，核对结果应同步未编辑的当前目标，保留真实未提交编辑；双方对同一工具的修改不同时保持冲突，不得把旧路径与新版本组合后覆盖他人修改。工具实际应用来自 telemetry.toolPaths，并核对当前 desired revision 和 choice，不能从配置保存或旧版本 probe 推断成功。

保存冲突、明确失败和响应未知保留草稿及无效原始输入。响应未知先读取当前资源核对，不重放 PUT，不根据同值核对推断先前写入成功。保存准备或结果发布期间准入暂停时，本地 pending 与保存 promise 在结果已知或取消分类后结束，保留已有配置和草稿；暂停期间不自动读取或重放。未派发的取消不代表写入，已派发而未确认的结果仍需核对，可信保存确认不因后续发布失败变为未知。取消网络不证明服务端回滚。

延迟结果的资源发布仍须通过原账号和 Worker 的准入，且不能覆盖提交之后的草稿编辑或清除其未保存状态。临时暂停恢复后可发布同一操作的结果；新的保存仍须重新满足版本、权限、新鲜度和操作身份检查。本地 pending 结束本身不授权再次保存；已确认结果尚未发布时不能以旧资源执行丢弃，离开时放弃草稿的意图仍需在结果发布时保留。完整编辑与交互要求由[Web 需求](daynight-web.md#云端运行配置)拥有，机制由[Web 设计](../design/daynight-web.md#worker-云端配置编辑)拥有；Web 展示的应用结果来自 Worker 报告，不能作为本机副作用的独立证明。

## 失败与验证

输入约束与格式错误为 400；目标版本冲突、尚未初始化或版本耗尽为明确错误；未认证为 401、其他账号或未知 Worker 为 404。存储错误保留链并返回清洗后的 500。响应沿用 requestId，不记录配置正文或原始工具错误。

Worker 本机检查点的临时文件 I/O 故障独立于服务端事务错误：在原实例所有权中等待并重试同一冻结结果，未保存应用不公开，已知报告回执不因等待者取消失去归属。格式、身份和其它确定错误仍拒绝；新执行准入服从存储 readiness，原执行与停止事实继续保留。应用错误只从实际受控类型或操作边界映射为上述闭合词汇；本机阶段、原记录/目标与当前权威关联、远端/本地确定性和五分钟摘要由[报告诊断需求](daynight-worker-reporting.md#配置交换)拥有，不增加 wire 字段或更改 API 错误外壳。完整本机恢复及关闭合同由[Worker 需求](daynight-worker.md#w-01前台运行配置与平台)与[设计](../design/daynight-worker.md#临时存储恢复与准入)拥有。

验证覆盖账号与 Origin、闭合字段、继承/null/[]、完整版本范围、并发导入、独立 CAS、相同值 no-op、过期窗口、当前项目权限、旧格式及存在运行中任务时的接入。Web 保存验证覆盖准入前取消、派发后未确认、可信确认后的发布失败、暂停中的本地收尾和保留草稿、恢复发布与较新编辑，以及 owner 替换或销毁时的取消。服务端接纳应用观测不代替真实 Worker 应用验证。
