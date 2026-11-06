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

完整值包含 maxConcurrent、pollIntervalMs、recoveryLimit、native 与 projects，均必填。未知、重复、缺失字段、非法 UTF-8/NUL、错误类型和尾随 JSON 明确拒绝。

| 字段 | 语义 |
| --- | --- |
| maxConcurrent | 1..9007199254740991 的整数 |
| pollIntervalMs | 1..2147483647 的整数，单位毫秒 |
| recoveryLimit | 0..9007199254740991 的整数 |
| native | 完整 {agent,model,args}，Agent 为 codex、copilot 或 claude |
| projects | 显式数组；条目为 {projectId,nativeOverrides}，规范 Project UUID 不重复 |

全局 model 是非空且不含控制字符的字符串或显式 null，null 表示 provider 默认模型；args 是字符串数组，各参数非空且不含控制字符，[] 表示无附加参数。项目 nativeOverrides 只允许 agent/model/args；缺失 key 表示继承，model:null 与 args:[] 是显式清除。Agent 与全局不同时，未显式给出的 model/args 使用该工具默认值；服务端保存意图，不执行工具准备。

项目列表规范化后比较语义值。repositoryRoot、本机路径、服务连接与凭据、Worker 身份及 agentControlMode 不属于目标配置。

## 首次导入与编辑

本地候选只在目标不存在时原子建立 revision 1；已有目标时忽略候选，始终保留云端值。并发或迟到候选不能覆盖它。接入不查询任务状态或要求先处理任务。

PUT 使用 {revision,value} 完整替换已初始化目标。revision 是读取时的目标版本，为 1..9223372036854775807 的规范十进制字符串，不接受前导零、符号、小数或指数。版本不符为 409 version_conflict；规范值相同不递增目标版本或修改时间。目标尚未导入时返回 409 configuration_not_initialized，不能通过 PUT 创建它；revision:"0" 不是合法创建操作。达到最大正 int64 后需要真实变化时为 409 version_exhausted，同值 no-op 仍有效。

新增或修改的项目条目必须可访问。原样保留或删除已选但后来失权的条目，不阻塞其他配置编辑；不能获取失权项目的名称或仓库信息。

## 心跳扩展

配置客户端对原报告端点发送 Daynight-Worker-Configuration: 1。该标记只选择配置交换格式，不改变任务或 inventory 协议。未携带标记的报告继续原精确字段及 {observedAt,lastReportedAt} 回执。

扩展正文增加 configuration，含显式 nullable bootstrap 和 observation。bootstrap 为完整候选；没有候选时为 null。observation 包含 baseRevision、desiredRevision 和完整 items；尚无结果时为 null。

扩展回执保留原时间字段，并含 configuration:{desired,observationRevision,observationAccepted}。观测 CAS 不匹配时返回 false 与当前版本，保留已有应用观测；合法机器报告仍按原规则保存。响应未知不能被当作未写入，后续使用最新实际状态收敛，不重放旧报告。

## 应用观测

每项含 key、targetRevision、appliedValue、state、error、lastFailure、nextAttemptAt；项目 key 另外包含 projectId。state 为 pending、applying、applied 或 error。

| kind | appliedValue |
| --- | --- |
| maxConcurrent、pollIntervalMs、recoveryLimit | 对应合法标量或 null |
| native、projectNative | 完整 native 元组或 null |
| projectPreparation | true 表示已准备；没有可确认结果时为 null |
| projectRemoval | true 表示已移除/停止；没有可确认结果时为 null |

null 表示没有可确认的实际值，不是生效默认值。项目准备与移除可以来自不同目标版本，必须保留对应 targetRevision；结果不携带 Task 或 claim 标识。

error 表示当前失败，lastFailure 保留尚需报告的最近失败，nextAttemptAt 为 nullable RFC3339 本机重试期限。失败使用闭合 code/category/phase 及 occurredAt，不接受自由命令输出、配置正文或敏感信息。code 为 not_found、permission_denied、timeout、command_failed、invalid_output、invalid_configuration、io_error 或 unavailable；category 为 validation、repository、agent、runtime、storage；phase 为 validate、prepare、apply、stop、persist。error 只在 state:error 时存在；applied 必须具有非 null 实际值，nextAttemptAt 只用于 error 状态。pending/applying/error 可保留先前成功值。恢复可清除当前 error，不能提前丢弃尚未报告的失败。

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

`native` 是可空的完整原生来源对象，`projects` 是最多 1024 项的完整列表，每项包含规范且不重复的 `projectId` 与同形可空 `native`。来源对象的 Agent 为 codex/claude/copilot；两个值对象均必填，source 只能为 local/cloud/native。local/cloud 对应非空字符串，model 最多 256 字节、reasoningEffort 最多 64 字节；native 来源必须 value:null，表示 Daynight 未指定该项，不是对 Agent 实际解析值的观察。字符串不得包含控制字符。

不可用原生配置用 native:null 表示。旧合法云端模型超过来源报告上限时该项也报告 null；超过项目上限时省略整个可选对象，不截断并假称完整，也不让可选观测阻断心跳。字段存在时不得为 null，必须满足 schemaVersion=1 的闭合结构。新服务接受旧客户端省略字段，新客户端发送该对象需要支持它的服务；旧严格服务的拒绝不能被解释为已保存来源。

服务器按完整 telemetry 替换存储。移除本地覆盖后的新报告更新有效值及来源；后续报告省略整个字段也必须移除旧观测，不保留过时的 local 标签。该对象不会写入 desired、改变目标版本或取得执行资格。字段归属和组合规则由 [Worker 需求](daynight-worker.md#本地模型与推理强度覆盖)拥有。

## Web 消费者

“我的 Worker”详情的配置表单编辑 desired.value，以 desired.revision 保存完整目标；observationRevision 与 observation 只用于展示最近应用报告，不改变草稿的保存版本。页面的运行观测和配置分别读取：近期快照超窗的 404 不代表配置不存在，配置读取失败也不清除独立的运行观测。资源没有 supported 标志；desired:null 表示尚未首次导入，Web 不能使用 PUT 建立初值。

表单保留项目覆盖的字段存在性、model:null 与 args:[]，并区分目标、尚未确认的实际值和每项结果。比较目标时保留各项 targetRevision 与实际值：值未变的独立项可沿用成功，项目准备/native 还需核对当前目标观测及后续移除版本；已移除项目的 projectRemoval 保留自己的状态和版本，结果仍应显示。observation.reportedAt 表示服务器接纳应用结果的时刻，不能以机器上报时间或保存目标的时间替代它。

保存冲突、明确失败和响应未知保留草稿及无效原始输入。响应未知先读取当前资源核对，不重放 PUT，不根据同值核对推断先前写入成功。完整编辑与交互要求由[Web 需求](daynight-web.md#云端运行配置)拥有，机制由[Web 设计](../design/daynight-web.md#worker-云端配置编辑)拥有；Web 展示的应用结果来自 Worker 报告，不能作为本机副作用的独立证明。

## 失败与验证

输入约束与格式错误为 400；目标版本冲突、尚未初始化或版本耗尽为明确错误；未认证为 401、其他账号或未知 Worker 为 404。存储错误保留链并返回清洗后的 500。响应沿用 requestId，不记录配置正文或原始工具错误。

验证覆盖账号与 Origin、闭合字段、继承/null/[]、完整版本范围、并发导入、独立 CAS、相同值 no-op、过期窗口、当前项目权限、旧格式及存在运行中任务时的接入。服务端接纳应用观测不代替真实 Worker 应用验证。
