# Task token 用量

## 结果与范围

用量是独立于任务状态的模型计量事实，不是货币账单。Task、Standalone Test Session
复用既有 Session 身份；Chain 和 Goal 从同一账本查询当前成员，不复制计量。
范围是已登记执行，不能声称覆盖无法观察的外部 Review。Herdr 和 Bot 不新增采集。

业务数据库只新增 `usage_records` 一张表，区分 `execution_state` 和
`measurement`。没有可靠历史记录时返回未知，不按请求数、上下文占用或任务时长估算。
上报不得改变 Task 的版本、更新时间、排序时间、claim 或 Session 生命周期。

## 协议与兼容

用量协议为 `daynight.usage.v1`，使用独立 HTTP 路径和独立确认，不扩展旧
Task/Session 严格 codec。旧 Worker 不上报、旧前端不查询仍正常工作。
能力接口的 404/501 表示服务不支持；超时和 5xx 是暂不可用，不得伪装成不支持。
关闭写入不删除账本和迁移，不得使主任务或原生进程失败。

所有 UUID 必须是小写规范 UUID。计数、修订、代次和记录数使用规范十进制字符串，
不接受 JSON number、符号、小数、指数、空白或前导零。token 单字段范围为
`0..99999999999999999999999999999999999999`；聚合不得受单条上限限制。
修订、代次、状态序列和行版本为正 int64。未知指标为 `null`，合法零为 `"0"`；
没有贡献记录时合计为 `null`。

时间采用 UTC RFC3339，最多微秒。`observedAt` 是诊断时间，不决定修订权威。
文本容量按 UTF-8 bytes：原生 Session/source/turn/call ID 各 256，model、
profileId、providerVersion 各 128。`nativeMetrics` 是固定 profile 白名单对象，
最多 4 KiB；原因最多 16 个固定枚举，不存原始错误文字、prompt、回复、凭据或 transcript。
合并原因时必须保留 sticky conflict、profile 固有限制和派生故障所必需的原因，
不能因容量边界将缺口抹成完整覆盖。

## 身份、重放与修订

计量唯一身份为 `(nativeAuthorityUserId,provider,nativeSessionId,sourceKey)`。
`nativeAuthorityUserId` 是首次登记来源的 Daynight 用户，不是 Provider 账户。
sourceKey 必须来自原生计量单元，不能使用 claim、generation、传输请求 ID 或接收时间。
同一原生来源不能重归属其他 Task、Project 或平台 Session。

每个既有 `sessionId + executionGeneration` 只有一个 state。首次 state 是 anchor，
恢复 state 指向相同 anchor。每个计量 event 携带持久化的 `originatingStateId`，
首次落库即固定为真实产生它的 state。恢复代次可以上传相同 anchor 的旧来源，
但不能延长原 state 的补报期限、绕过撤销或将旧来源改绑新代次。

`immutable` 只接受修订 `"1"`：同正文重复幂等，不同正文冲突。
`native` 必须有 profile 认可的原生可比较修订证据：较高修订整组替换，
较低修订 stale，同修订异文 conflict。不得用到达顺序、`max(tokens)` 或自行递增的
计数冒充原生修订。真实新调用仍有独立来源，传输重试不增加用量。

final 后不得回退 provisional。具备权威修订的更高 final 可以减值、归零或撤销；
撤销保留来源身份，指标全 null。immutable 不允许修订或撤销。冲突保留已存计量，
并持久标记来源 state 为 partial；后续普通 complete 状态不能清除冲突。

## 指标与 Provider 平面

规范指标为 input、output、cache read/write、reasoning 和 total tokens。
规范 input 包含已证实的 cache；output 包含已证实的 reasoning，分项不能再次相加。
只有有证据且必要分项已知时才能计算 `total=input+output`。
口径不明的原始 total 只能放 `providerTotalTokens`。

core 拒绝 cache 超过 input、reasoning 超过 output、已知 total 不等于
input+output，以及 profile 声明不相交的两类 cache 之和超过 input 的记录。

| profile | 允许的计量平面 | 规范指标与限制 |
|---|---|---|
| `copilot-event-1.0.11-v1` | `copilot-event-v1:<event.id>`，immutable 单事件 | output/reasoning 可知；input/cache/total 未知，原始分项单列；只能 partial |
| `claude-message-input-0.3.247-v1` | `claude-message-input-v1:<message.id>`，root assistant 输入 | 三个输入分项齐全才计算规范 input，cache 为子集；output/reasoning/total 未知；只能 partial |
| `codex-snapshot-unaccountable-v1` | 只登记 unsupported state | 不将累计或上下文快照变成 counted measurement |

实际 runtime/SDK 未通过精确组合资格验证时为 `profile_unverified`，研究过字段不等于
生产环境已验证。Provider JS number 不安全时不得转成看似精确的字符串。
Copilot Controller 使用 `1.0.11/<runtime-version>` 作为 providerVersion，实时事件在
历史恢复缓冲前持久化；ephemeral 通知不能从历史恢复，始终保留 native_recovery_gap，
不承诺收齐落盘前的事件。采集错误和用量网络故障不得中止原生任务。
能力接口通过 `profiles[].qualifiedVersions:[{providerVersion,capability}]`
公开精确的已验证版本；基准 capability 和未列版本不能因此自动升级。

`counted` 参与汇总；`included` 仅作明细，必须指向同 anchor 的 counted 父来源；
`unattributed` 不参与总数且使覆盖不完整。不得混加 session、turn、call 和子 Agent 平面。
父缺失或撤销不自动提升子来源为 counted。

## 写入与补报

登记使用平台 Controller 原 PAT 父凭据，要求原 owner、当前 active Web Session、
精确 generation/controllerInstance/connectionEpoch，以及已确认 nativeSessionId。
Task 必须允许 Agent、原 claim active、没有独立 pause，账户、父凭据、Project 权限均有效。
归属由服务器读取既有 Session/claim，不接受客户端选择 Project/Task/Worker。
Test Session 仅限原 creator；Bot/Herdr 返回 `unsupported_scope`。

grant 为 32 随机 bytes 的无 padding base64url，只保存 SHA-256 hash，限制为 state/anchor。
有效期为 `min(now+7 days,task_sessions.created_at+90 days)`。同代次仍 active、
尚未 seal 且未过期时才可轮换；硬截止不因恢复或重连延长。
重复登记须匹配原始全部登记身份，包括原 Controller instance 和 connection epoch；
不能用重连后的当前快照覆盖原登记事实。匹配时返回安全 state 和 `grant:null`，
不再次展示旧 token。
token 丢失后只有仍具当前同代次 Controller 身份的调用者能以原 rowVersion 明确轮换。

claim 完成和 Task done 不自动撤销已登记 grant，也不 seal。seal 表示原生停止并完成采集
drain；其后不再续期，但截止前仍可补报最终计量或有证据的修正。
未登记且 claim 已结束的执行不能事后自建 grant。
Controller 用量队列与 Session timeline 的 cumulative ACK 相互隔离。只有完整匹配
本次 flight 的用量回执才能清理对应事件；断网或响应未知时保留原身份重发。
原生停止后的补传使用原 journal 和有效 grant，不重新取得 claim、注册新执行或
延长原授权窗口。Worker 的历史归档开关不关闭补传；唯一 journal 中存在待发或
隔离计量或未解决的本地来源冲突时保留该 journal，显式删除和自动清理历史录制均不得
丢弃它。已接受计量与 partial 状态的 ACK 不解决本地冲突，不清除其证据。

每次写入重新核验 grant/hash/期限/撤销、原父凭据、账户、当前 membership、
资源存在以及 Task allowAgents/pause。结束后补报仅能写原 anchor，不能改变新执行。
到期、撤权和资源删除必须显式拒绝，不能换凭据或新 claim 绕过。

batch 最多 100 events、256 KiB，单 event 16 KiB；重复 eventId 整批拒绝。
解析先于计量写入；认证失败整批无写。正常结果逐项对应 eventId，
outcome 为 `inserted|replaced|duplicate|stale`，带当前 rowVersion/revision/hash。
客户端不能凭 HTTP 200、缺项或不同正文回执删除待发项。

batch 一个事务，任一冲突/非法项使全部计量不生效。`source_conflict` 或
`finality_regression` 的例外是单独提交 sticky partial 诊断，409 必须明确
`diagnosticCommitted:true` 和 state 新版本；该回执不确认任何计量。
CAS 竞争为 `usage_changed`；提交未知为 `write_outcome_unknown`，不得自动重放决定。

state event 包含 `eventId,kind:"execution_state",stateSequence,collectionState,
capability,reasonCodes,nativeStartedAt,nativeEndedAt,observedAt,seal`。
登记序列为 `"0"`，后续为正 int64、本地单 writer 持久化且重启不归零；
相同序列同 hash duplicate、异文 conflict、小序列 stale。
seal 后不得退回 collecting，但允许补充终止证据、显式 partial 和最终计量。
complete 必须在所涉 measurement 全部已获独立 ACK 后单独提交，不与未确认计量同批。

capability 固定包含 `profileId,qualification,measurementPlane,revisionAuthority,
metrics,subagents,recovery,completion`。qualification 为
`verified|unverified|unsupported`，measurementPlane 为
`native_event|root_message_input|none`，revisionAuthority 为
`immutable|native|none`；六个规范 metric 能力为
`supported|optional|unknown|unsupported`。subagents 为
`included_per_event|unknown|unsupported`，recovery 为
`durable_after_ingress_only|native_history_partial|unsupported`，
completion 为 `partial_only|complete_capable|unsupported`。
组合由服务端 profile registry 固定，客户端不能自选更高能力或增加 JSON 键。
生产拒绝 fixture profile；native 修订和 complete_capable 只由隔离测试 profile
证明机制，不代表当前三种 Provider 已有这些能力。

## HTTP 资源

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/usage/v1/capabilities` | 版本、开关、profile 和容量协商 |
| POST | `/api/usage/v1/registrations` | PAT 登记当前执行及独立 grant |
| GET | `/api/usage/v1/states/{stateId}` | owner 或当前 Project 管理员读取安全投影 |
| POST | `/api/usage/v1/states/{stateId}/grant` | 当前同代次 Controller 按 rowVersion 轮换 |
| POST | `/api/usage/v1/states/{stateId}/revoke` | owner/管理员按 rowVersion 撤销 |
| POST | `/api/usage/v1/states/{stateId}/batches` | usage grant 原子上报 |
| GET | `/api/usage/v1/states/{stateId}/sources` | grant 核对最多 100 个唯一 key 及 missingKeys |
| GET | `/api/projects/{p}/tasks/{t}/usage/v1/summary` | 单 Task 摘要 |
| POST | `/api/projects/{p}/usage/v1/task-summaries` | 1..100 唯一 Task 的有序批量摘要 |
| GET | `/api/projects/{p}/tasks/{t}/usage/v1/records` | Task 明细 |
| GET | `/api/test-sessions/{sessionId}/usage/v1/summary` | 原 creator 的独立 Test 摘要 |
| GET | `/api/test-sessions/{sessionId}/usage/v1/records` | 原 creator 的独立 Test 明细 |
| GET | `/api/projects/{p}/usage/v1/aggregates/chain/{memberTaskId}` | 当前普通依赖连通分量 |
| GET | `/api/projects/{p}/usage/v1/aggregates/goal/{goalId}` | 当前直接普通子 Task |

普通读取沿用当前身份与资源权限；批量任一 Task 缺失、删除、类型错误或不可访问时，
统一 `resource_unavailable`，不返回部分统计。安全投影不包含 grant token、
grant hash 或父凭据 ID；核对用的计量正文 bodyHash 不是 grant 秘密。

## 摘要、完整性与分页

每个规范指标返回 `{known,contributingRecords,unknownRecords}`。只统计当前 active、
counted measurement；无贡献为 null。权威修正可以使已知值下降。
`lastMeasuredAt` 只取 measurement 更新时间，不能被 grant 轮换或新的 observedAt 推进。

摘要 scope 为 `registered_web_executions`。覆盖母集来自保留的既有平台 Session，
不是仅有 usage 行的执行；恢复 generation 不增加执行分母。Web 未登记为 unregistered，
Herdr 为 unsupported，无 Session 的历史 Task 为 no_data。
collecting/complete/partial/unsupported/unavailable/unregistered 类别互斥，
总和为 executions；supportedExecutions 可与其重叠。

查询将未 seal 的到期、撤权、停止或归档执行派生为 partial（有已知量）或
unavailable（无已知量），保留 missing_final 与具体原因；Task done 不是停止证据。
正常 sealed 结果不因 grant 自然到期而退化，新 source conflict 仍可降为 partial。
父凭据有效性按每个 state 最初登记时保留的凭据与 authority 判断，不能因同一
Session 重连换用另一有效 PAT 而恢复旧 state 的授权。经停止证明推进 generation 后，
旧 generation 的未 seal state 按已停止派生 missing_final/collector_failed，
不能沿用新 generation 的 active 状态；这不撤销仍合法的原窗口补报。
同 Session 的恢复 state 不能掩盖旧缺口。先判 collecting，再判完整，再按已知量、
故障、不支持和无数据决定 completeness。

固定原因码为 `historical_no_data,registration_missing,provider_unsupported,
profile_unverified,native_recovery_gap,missing_final,subagent_scope_unknown,
external_review_unobserved,model_unknown,source_conflict,inclusion_parent_missing,
attribution_unknown,local_capacity_exceeded,local_storage_failed,upload_expired,
permission_revoked,collector_failed,scope_restricted,native_integer_unrepresentable,
input_cache_semantics_unknown`。

ETag 基于可见完整投影，包含有效状态和权限/成员变化，排除 observedAt；
批量 summary 还包含按请求顺序排列的 Task ID，即使各项统计值相同，
切换任务或调整顺序也不能沿用旧 ETag。If-None-Match 返回 304 前仍须重新授权。

records 使用 `kind=measurement|execution_state`，支持 stateId/model/provider/
aggregationRole 精确过滤，limit 1..100，按 `(createdAt,id)` 升序 keyset。
签名游标绑定身份、资源、过滤、权限、集合 revision 和最后键，15 分钟过期。
每页同一 repeatable-read 快照中重新授权、验证集合 revision；新增、修正、删除、
归属或权限变化返回 `reset_required`，不混合两个时点。页面包含 execution_state 时，
还须绑定影响可见派生状态的事实，包括原父凭据、Task pause/allowAgents、
generation 停止和 grant 自然到期；不能只比较 usage 行版本。
过期为 `cursor_expired`。

## Task 用量界面

普通 Task 行提供紧凑摘要并链接到 Detail 的用量页签。普通 Task 的详情弹窗和独立详情页
仅在「用量」页签展示用量；标题区不显示用量数字、提示、加载、错误、重试入口或其占位。
保留用量页签及 `?tab=usage` 直接链接，摘要、记录、筛选、重试和权限行为保持一致。
服务返回 `usage_unsupported` 时，普通 Task 行不显示原摘要容器，而在状态组的
生命周期状态前显示中性的「无LLM用量」（英文 `No LLM usage`）。这一提示不代表已测得零；
Provider 级 `unsupported` 数据、无记录和其他错误仍按各自状态展示。
卡片的批量摘要独立于 Task 同步和缓存，最多一百项一批，不能每张卡片发一次请求，
也不能依赖 Task.version 或 updatedAt 推断用量是否更新。

Goal 和任务链依赖图的 Task 节点只在 total、output、input 至少一项有已知数字时
显示紧凑用量，按此顺序选择读数，合法零也显示。加载、读取失败、不支持、无记录或
仅有未知读数时，不渲染用量行及其提示，不预留专用空间；暂时刷新失败但仍保留已知
摘要时继续显示该读数。节点原有尺寸和图布局保持不变。

简写仅用于摘要。明细以精确十进制整数显示 input、output、cache、reasoning 和 total；
未知值明确显示未知，合法零仍为零。total 未知时可显示带指标名的已知小计，
不得把部分 output 或 input 称作合计。cache 和 reasoning 标明包含关系，不能再加到
input/output 上。展示完整性、最近计量时间、查询时间和可解释的缺失原因；
不把 unsupported、暂不可用、无数据或采集中混成完整结果。

用量页签按执行或计量来源读取有界分页，支持模型、Provider 和执行过滤。
页签独立纵向滚动，筛选项在宽屏排列成行，在狭窄空间换行；字段有标签，动作可触控。
服务明确返回 `usage_unsupported` 时，选中的页签只显示一条中性说明，不请求明细，
不提供筛选、重试和分页。
每项保留执行、模型、来源身份、计量口径与指标；无法归属或已包含的来源不得
被界面再次相加。临时错误允许在所属区域重试，刷新或分页失效保留仍可访问的已读内容，
失效游标从第一页重读；权限撤销清除
相应私有投影。用量读取失败不影响其他 Detail 页签和任务操作。入口、筛选、重试
与分页支持键盘，小屏下精确整数与来源可换行或在所属区域滚动。

## 当前成员汇总

Chain 双向沿普通依赖展开，external 不加入；Goal 仅当前直接普通子 Task，
包括 cancelled，不沿链扩展。先 distinct Task，再关联事实，重叠视图不能二次相加。
聚合仅允许读取整个 Project 普通任务集合的账户；否则
`aggregate_scope_restricted`，不返回局部总数或隐藏成员身份。
当前成员不含 soft-delete，删除/移动/边分类变化使 membershipRevision 和游标失效。
响应明确 `membershipPolicy:"current_members_excludes_deleted"`。最多 10,000 成员，
超限 `aggregate_scope_too_large`，不得截断后报完整；缺失成员按 Task ID 分页，最多 100。

图中的 Chain/Goal 用量入口和 Goal Detail 的用量页签消费同一个聚合接口，
明确显示「当前成员 · 不含已删除任务」、统计时点、有已知用量的成员数、未知成员数
及完整性分类，并可从缺失成员定位到任务。withKnownUsage 与完整性分类重叠，
不能把其相加当作成员总数。查询失败允许重试，范围权限不足时不得拼接可见成员
的本地统计作为替代；成员页失效保留已读内容，刷新后从第一页继续。
