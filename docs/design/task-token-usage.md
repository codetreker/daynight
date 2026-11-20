# Token 用量

## 职责与不变量

[用量要求](../spec/task-token-usage.md)定义身份、数值、权限、HTTP 和聚合语义。
业务事实仅在 `usage_records`，不新增 Session 或调度机制，不更新 Task。
计量与能力/收集状态同表存储，是为了让没有 measurement 的执行也能表达缺口，
而不是把缺失误报为零或完整。

领域模型承载精确十进制、来源、state、grant 安全投影和查询结果。
core `usage` 拥有 profile、数值关系、修订、完整性和权限准入规则；
`core/store` 拥有数据库中立的读写合同；PostgreSQL 实现拥有 SQL、映射、
唯一性、CAS 和快照；service 协调既有 Session、Task、identity、Project 与用量操作。
HTTP 入口只处理认证、严格解析、响应、条件请求和错误映射。

## 存储与并发

`execution_state` 用 `(session_id,execution_generation)` 唯一索引登记代次；
原生 anchor 用 `(native_authority_user_id,provider,native_session_id)` 唯一索引固定。
measurement 的同一身份再加 source_key，与 model、profile、claim、generation 无关，
避免换维度或恢复时重复计量。measurement 永久绑定 originating state。

token 是 `numeric(38,0)`，SQL 聚合使用无 typmod numeric；Go 计算使用 `math/big.Int`。
原始指标和能力是白名单 JSON，不存正文或凭据。必要约束仅为 PK、NOT NULL、
身份唯一索引，不用 CHECK、FK、trigger 或存储过程重复业务规则。
Task/session/state 明细索引支持范围查询和 keyset。

新源通过唯一索引收敛；修订以已观察 rowVersion 做条件更新，禁止无条件 upsert 覆盖。
duplicate/stale 不改更新时间或版本。并发竞争返回可观察冲突，不在 DAO 偷偷重算业务。
提交区分 committed、not_committed 和 unknown，保留错误链；未知不能假装回滚。

上报授权的固定锁序是按 ID 的 Task/Goal resource `FOR SHARE` →
原 PAT/user `FOR SHARE` → 平台 Session `FOR UPDATE` →
Project authorization 共享锁 → 按 UUID 的 usage state → 按来源键的 measurement。
复用既有 `LockTaskResource` 与 `LockProjectAuthorization`，因为单行 CAS 不能阻止
权限或资源生命周期在决定后、提交前变化。等待锁后重新取时间核验期限。
批次绑定自己的 state rowVersion 和 grant 身份，轮换/撤销不能被并发穿越。
Test 省略 Task/Project，不省略父凭据、user、Session 和 state。
其原 PAT/user 锁先于 Session，与既有 Test 登记的 PAT 共享锁、user 排他锁、
Session 排他锁次序兼容；争用先在 user 等待，不能持有 Session 再等待 user。

冲突诊断与计量事务结果分开表达：正常 batch 全部计量原子提交；
来源矛盾拒绝全部计量，但将原 state 的 sticky partial 诊断持久化，并明确回执。
诊断提交未知仍需观察，不能将 409 当作计量 ACK。

## 正文 hash

SHA-256 输入是固定顺序数组的 RFC8785 canonical JSON UTF-8，无 BOM/LF。
measurement 的精确字段顺序为：

```text
["daynight.usage.measurement.v1",provider,nativeSessionId,sourceKey,profileId,
 providerVersion,revisionAuthority,sourceRevision,finality,disposition,
 aggregationRole,includedInSourceKey,nativeTurnId,nativeCallId,model,inputTokens,
 outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens,totalTokens,
 providerTotalTokens,nativeMetrics,sortedReasonCodes]
```

state 的精确字段顺序为：

```text
["daynight.usage.state.v1",stateId,stateSequence,collectionState,capability,
 sortedReasonCodes,nativeStartedAt,nativeEndedAt,seal]
```

对象键排序，指标和修订是字符串，缺失显式 null，枚举列表排序且去重。
排除传输 event/batch ID、originatingStateId、observedAt、grant 和 rowVersion；
归属单独核验，防止观察时间变化把安全重放误判为计量冲突。
Go 默认 HTML 与 U+2028 转义不能直接作为跨语言规范编码。

## 授权与生命周期

初次登记从既有 active Web Session 读取归属，要求精确 Controller 身份和原 PAT 父凭据。
grant 不是普通 API 凭据，只授权相同 anchor 的计量。`grant_hash` 是私有版本化
hash 封套：一个版本字节、32 bytes token SHA-256、32 bytes 登记身份摘要。
身份摘要覆盖原始登记字段及已认证 owner/父凭据，包含 Controller instance 和
connection epoch；不保存明文 token。平台 Session 快照会随连接推进，不能代替
这份不可变登记证明。轮换仅替换 token hash，保留原始身份摘要；重复登记必须匹配
该摘要，不重新展示 token。封套格式错误是显式存储错误，不能退回较弱的身份检查。
同一 `bytea` 字段保留完整凭据 CAS 屏障，不新增授权表或更改公开行投影。

丢失 token 的当前同代次只能 CAS 轮换。

grant 期限最多七天且不超过平台 Session 创建后九十天；恢复、重连和新 grant
不能延长原 measurement originating state 的窗口。claim 完成后允许有效 grant 补报，
不重新索取 claim，不获得操作新执行的能力。
原父凭据失效、成员撤权、Task 禁止 Agent/pause 或资源删除均拒绝新写入。
读时也按各 state 保留的父凭据与 native authority 判断原采集授权；同一 Session
后续换用其他 PAT，不改变旧 state 的授权依据。
seal 只代表原生停止并排空采集，不等同 Task done。

原因集合最多十六项；合并时优先保留 sticky conflict、profile 固有限制和
派生故障所必需的原因，其余按固定顺序保留。容量边界不得抹去冲突或使部分覆盖
变成完整。

## 运行配置

写开关 `DAYNIGHT_USAGE_WRITE_ENABLED` 默认 false，仅接受精确的 `true|false`。
`DAYNIGHT_USAGE_QUALIFIED_PROFILES` 是逗号分隔且不重复的
`profileId@providerVersion`，只允许支持的生产 profile；没有资格证据时保持未验证，
不能仅因打开写开关就宣称真实 Provider 合格。
能力接口的 `profiles[].qualifiedVersions` 列出精确版本及其 capability；
基准 capability 与未列出的版本仍未验证，登记和能力协商使用相同版本判定。

游标签名使用所有副本共享、重启稳定的三十二字节 key。
`DAYNIGHT_USAGE_CURSOR_KEY` 显式配置为规范、无 padding 的 base64url；
未配置时从既有 S2S shared key 以 `daynight.usage.cursor.v1` 做 HMAC-SHA256
用途分离。两种 key 都没有时不挂载用量接口；若同时请求开启写入则启动失败。
非法显式配置也启动失败，不静默降级。key 更换使原游标失效，不使用进程随机 key
伪装重启一致性。

## 查询

summary 在 SQL 内按当前 active/counted 行聚合指标、null 数量和更新时间。
批量一次处理最多 100 Task，先在同一快照核验完整选择，再返回请求顺序结果，
不进行每卡查询或取回全部 measurement 在 Go 求和。

覆盖母集连接既有保留 Session；state generation 先归并为一个 Session，
缺口不得被恢复代次覆盖。有效状态在查询时考虑期限、撤销及真实停止证据，
不因 Task done 推断终止；正常 seal 的确认结果不受自然到期影响。
已确认停止证明后的 generation 推进使旧 generation 按已停止判定，
而非复制当前 generation 的 active 状态；仍合法的原窗口补报不因此撤销。
查询先固定 Session 范围，保留没有计量的执行，再批量返回计量存在性及归属缺口。
`usage_known_session` 部分索引仅含 active/counted 且至少一个规范指标非 null 的行；
`usage_gap_session` 部分索引按 Session/role 覆盖 active/included 或 unattributed 行。
存在性探测使用精确谓词索引，不为布尔标记重新聚合全部计量，
也不让未过滤的相关探测抬高计划成本、触发昂贵的 JIT 编译。
覆盖 state 仅取身份、能力判定、收集状态、原因和期限字段，不读取完整账本行；
records 与 state API 仍使用独立的完整记录投影。
投影决定 ETag，授权先于条件响应。批量 summary 散列请求顺序中的
`(taskId, summary.etag)` 对及权限 token；相同统计值不能掩盖任务选择或顺序变化。

records 在 repeatable-read 快照中授权、计算过滤集合 revision 并 keyset 查询。
revision 包含稳定顺序的行 ID/rowVersion；页面可能含 state 时，还纳入同一快照、
同一操作时钟派生的有效收集状态与原因。原父凭据撤销、Task pause 或 grant 到期
没有改写 usage 行，也不能使旧页与新投影混合。只散列时钟影响的可见结果，
不因每次请求的时间不同而无条件 reset；measurement-only 页面保持原集合语义。
revision 不使用 Task.version 或单个最大时间代替这些事实。
签名游标绑定查询、权限、集合与最后键，不保留跨请求事务、快照表或进程内游标缓存。
集合变化要求 reset，不能悄悄把新值接到旧页。

Chain 用普通依赖双向连通分量，Goal 用 parent_id 的直接普通子 Task。
先 distinct 当前成员，排除删除，再一次关联账本；不将 Task summary 与其链二次加总。
聚合和成员分页使用相同快照/权限/集合 revision，超过 10,000 成员确定拒绝。

## Web 读取与呈现

Web 的用量 API 适配与 Task codec 分离，运行时校验精确数字字符串、响应身份和
分页边界。查询复用当前账户的 principal admission；旧账户的延迟响应不能填充
新账户的界面。所有计量数值保留字符串，仅在格式化时使用 BigInt，不能经过 Number。

Task 摘要由独立的批量读取状态分发给卡片和 Detail。相同 Project 的待查询 Task
合并为最多一百项的请求，用量的刷新不依赖 Task.version，也不写 Task summary cache。
能力协商先于用量查询；Detail 的能力接口 404/501 展示不支持，其他读取故障展示可重试错误。
普通 `TaskRow` 从同一读取状态取得摘要，与紧凑格式化共用 total、output、input 的
已知指标选择逻辑；没有这些数字时不创建用量元素，有数字时仅展示摘要与用量页签链接。
读取层保留的摘要可在刷新失败时继续展示，行内不附加查询诊断或重试；这些入口保留在
Detail 与用量页签。图节点也复用同一读取状态，仅在有可显示数字时渲染用量行。
用量自己的读取失败不能阻断任务详情和 Session。

`features/usage/` 拥有摘要、执行与来源明细。Detail 用既有的保留面板与路由机制
承载用量页签，Card 的入口直接定位该页签。明细分开读取 execution_state 和
measurement，过滤后重启分页，延迟的旧过滤响应被取消。明细按页替换，服务端
游标绑定 snapshotToken；reset_required/cursor_expired 保留已读页并要求从第一页
重读，不能悄悄把两个集合拼接。能力状态独立于摘要结果，协商成功后才请求明细；
明确不支持时页签只呈现中性说明。详情容器拥有页签滚动和留白，筛选控件按可用宽度
换行。摘要和分页各自显示观察时点。

`features/usage-aggregate/` 直接读取服务端 Chain/Goal 汇总，不从可见图节点或
Task 摘要再相加。Chain/Goal 图通过原生展开入口惰性加载，Goal Detail 提供用量
页签。汇总显示当前成员政策、已知用量成员、未知成员和互斥完整性分类；
缺失成员按服务端游标继续读取，并通过既有 Task 导航定位。
成员 revision 或摘要 ETag 变化时拒绝追加旧页，保留已读内容并提供刷新；
权限或资源丢失则清除该范围的私有统计。账户代次和 scope 身份共同隔离组件状态，
不能将前一个账户或范围的迟到响应用于当前汇总。

## Controller 采集与上传

创建任何 Provider 的 usage runtime 前，先按 launch ticket 的执行范围准入。
Task 沿用已有 claim 身份；独立 Test 启动器在新建和 resume 的新票据中明确写入
`usageScope=standalone_test`。该可选字段仅允许在 testExecutionId 票据上出现，
并与 Bot recovery 绑定互斥。Bot 同样使用 testExecutionId，且旧票据未必带 recovery
绑定，不能仅凭 ID 类型或恢复目录判断用途。缺少明确用途的旧 Test/Bot 票据不创建
usage runtime、不向 Provider 传递采集器；原生执行继续。resume 生成的新票据只建立
本地用途准入，不补写旧票据，也不授予跨 Test 的用量来源归属。独立 Test resume
按既有产品合同创建新 Session/URL并复用 nativeSessionId；如果该原生身份已在旧 Test
登记 anchor，现有服务端返回 source_conflict，新 Test 不取得 grant、不上传计量。
旧来源保持原归属，原生恢复继续，不能将这项注册缺口视为零用量或 unsupported。
跨 Test 的恢复计量需要服务端可验证的恢复关系及来源授权，不能仅放宽 anchor 检查。

Copilot SDK `1.0.11` 的实时 `assistant.usage` 在历史恢复缓冲之前进入独立用量入口。
Provider 先公布原生 Session 和 `SDK/runtime` 精确版本；事件映射仅保留 UUID、
模型、时间及指标白名单。`sourceKey=copilot-event-v1:<event.id>`，immutable 修订为
`"1"`，finality 为 final。output 和可选 reasoning 保留原值，input/cache/total
保持 null；原生输入和缓存值仅保存在 nativeMetrics，不与规范指标重复加总。
不使用 session/model 累计值、上下文占用或其他 Provider 的历史填补该平面。

Controller journal 格式 014 包含独立的 `usage_sources`、`usage_outbox` 和
`usage_meta`。原生来源、正文 hash、originating state、注册身份、状态序列、grant
与待发正文都由原 journal 的写事务保存。旧 outbox 的清理和 cumulative ACK 不访问
这些表。恢复重用原 event/source 身份；已确认来源仍保留去重记录。
待发容量为 16 MiB、20,000 项，来源上限 100,000；measurement 不占用预留的
4 KiB 状态空间，达到九成容量产生固定诊断。容量或存储失败只记录计量缺口，
不使原生任务失败；未成功持久化的事件不能宣称已经接收。

上传器使用独立 HTTP 请求，能力和注册使用原服务的 PAT，batch 只用该 state 的
usage grant。只有 `qualifiedVersions` 精确匹配时才发送 measurement；未验证版本
保留本地计量，只上报 unavailable/profile_unverified 状态。未发送 measurement
不能阻挡这种状态事件。每次 flight 固定准确 eventId/hash 集合，完整核验每项回执
后才能原子删除；未知、缺项或异文回执不清队列。stale state 额外核对服务器来源
状态。明确来源冲突隔离具体 poison event，保留证据并上报 partial，其余来源继续。

单请求期限十五秒，网络/5xx 指数退避一至六十秒并带 jitter；429 遵循有界
Retry-After。401/403/410 停止对应上传，不能换凭据绕过撤权。Controller 停止时
drain 最多五秒；Worker 在原 Controller 已确认停止后，按原 ticket/hash、Session、
claim、代次和 Worker 身份重新核验 journal，以原 grant 有界补传。SQLite 操作各自
取得 stopped-storage permit，网络期间不持数据库连接或事务，不启动原生进程。
补传独立于历史归档开关及归档成功状态。保留判定同时读取 `usage_outbox`（含隔离行）
和 `usage_meta.source_conflict` 的非 null 冲突证据槽；后者没有可上传事件，不能因
已接受计量及 partial 状态收到 ACK 而视为解决。任一证据仍存在时保留唯一 journal，
显式删除和自动清理历史录制均不能丢弃它。

Copilot ephemeral 通知在 SDK/helper 到 durable ingress 之前仍可能丢失，原生历史
不能重放这一窗口。因此该平面始终记录 native_recovery_gap，结束只能 partial，
不把 assistant.idle 或 Task done 当作完整计量凭据。未知整数不能变成已知零；
不安全 JS number 记录 native_integer_unrepresentable。停止后的未 seal state
按已确认停止证据补 missing_final，而不是推断 complete。
独立 Test 在本地确认停止后尝试原 journal/grant 的有界补传；
controller archive 重试同样重放原执行。用量与服务端停止回执、历史上传及历史 ACK
独立，任一路失败仍尝试另一路，未确认用量保留 journal 并提供同一 archive 重试入口。

## Codex Controller 能力上报

Codex 与 Copilot 使用同一 journal、上传器和 stopped 补传机制。state 中的 provider
在代次首次准入时固定，恢复不能改写 Provider 身份；旧 Copilot journal 无需迁移。
上传器按 provider 选择固定 profile，并核对注册回执的 profile/provider。

Codex 从实际 App Server initialize 回执的 `daynight/<version>` userAgent 读取版本，
只准入已核实的 0.169.0/0.169.1；版本未核实不冒充原生 unsupported。
原 thread 身份和 cwd 验证后登记 `codex-snapshot-unaccountable-v1`，仅上传
unsupported/provider_unsupported 的 execution_state，不读取累计或 last 快照生成
measurement。停止和恢复保留 unsupported，不把无计量误写成零或采集失败。
原生快照缺少可比较权威修订且含上下文估计，因此 turn/completed 不构成用量最终回执。

## Claude Controller 输入计量

Claude 复用相同 durable ingress、source hash、grant、独立 ACK 和停止后补传。
后端身份取自实际启动 SDK 的 initializationResult().account.apiProvider；只有
firstParty 且生效环境、settings 与官方 endpoint 检查一致时才映射 anthropic。
Mantle、Anthropic AWS、Anthropic Google Cloud 等选择器和缺失/矛盾的原生读回
均不能借用 Anthropic qualification；账户其他字段不进入 profile。
`claude-message-input-0.3.247-v1` 仅接收实际 SDK=0.3.247、实际 CLI 版本已知、
backend=anthropic 的实时 root 消息完成流；providerVersion 编码为
`<sdk>/<cli>/<backend>`，服务端还必须精确公布该组合的 qualification。

来源键为 `claude-message-input-v1:<message.id>`，immutable revision=1。
规范 input 是原生 input/cache-read/cache-creation 三项已知值之和，cache 是 input
分项；output/reasoning/total/providerTotal 保持 null，不采集包装消息的输出占位值，
不叠加 result.usage 或 modelUsage。缺失字段保持 null，
不安全整数逐字段变 null、保留其他已知值并记录 native_integer_unrepresentable。

SDK 0.3.247 的流式 assistant 包装消息在每个 content_block_stop 后发出，
stop_reason=null，之后的 message_delta 仍可修正输入和缓存，因此不能提前入账。
采集器只缓存一个 root message_start 的原生 id、model 和输入三项白名单；
message_delta 中存在且非 null 的输入项覆盖原值，未提供的项保持原值或未知，
不采用 CLI 内部缺失转零或累计聚合。收到非空 stop_reason 后的 message_stop 才生成
immutable 事实。子代理流不结束 root 缓冲；缺少 start、完成证明、原生身份或模型时
记录 native_recovery_gap，不猜关联。新的 start 覆盖未完成消息、结果返回、取消、
断连和停止均丢弃未完成缓冲并保留缺口。非流式包装消息仅在自身 stop_reason 非空、
没有 aborted/error 标记且原生 ID 有效时可使用；如果其 ID 不同于待完成流，
先为旧流记录缺口，再接收独立完成的新消息。CLI 的 streaming_fallback_began
不会转发给 SDK 消费者，没有完成 block 的失败流也没有 tombstone，不能依赖这两种
信号清理旧流。同 ID 包装消息不能替代待完成流；中途 block 包装消息不入账。
CLI 本地命令（例如 /context）的完整 assistant 包装消息使用 model=`<synthetic>`，
没有真实模型调用。collector 在替换 pending 前忽略该消息，mapper 同样拒绝计量；
本地命令既不制造零用量事实，也不清除无关原生流。真实模型的合法零值仍可计量。
原生流语义以固定发布包
[SDK 0.3.247 类型](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.247/sdk.d.ts)
中的 SDKAssistantMessage 与 SDKPartialAssistantMessage 为准。

CLI 2.1.247 的服务端 refusal fallback 能在相同 message.id 下更换 model，内部
fallback block 不保证出现在公开 stream_event 中。root 的 system
model_refusal_fallback 通知，或 message_delta.usage.iterations 中的
fallback_message，均使当前模型归属失去证明。采集器丢弃缓冲并保留
native_recovery_gap，直到新的 message_start 才恢复接收；旧消息后续的 delta、stop
及完整 assistant 包装消息都不能绕过抑制重新入账。明确 scope=local 或带子代理
parent_tool_use_id 的通知不清除无关 root 消息。不从 fallback 提示猜测或拆分 token
到新旧模型，也不以本地修订改写 immutable 事实。

CLI 的客户端 refusal fallback 还会在通知转发之前，使用临时 usage 合成
stop_reason=refusal 的 message_delta 和 message_stop。因此 refusal 关闭和完整包装
消息均不准入，立即记录 native_recovery_gap 并抑制旧消息，直到新的 message_start。
此限制也会排除无法与合成关闭区分的真实 refusal；保留部分覆盖，不把临时零值当作
最终事实，不等待延迟通知来撤销已经入账的 immutable 来源。

只有原生 profile 到达后才固定当前代次身份；提前到达的消息记录缺口。
backend 未知或其他后端不准入计量，不把 proxy 返回的数值冒充 Anthropic 语义。
现有历史读取不提供原 SDK/backend provenance，因此不使用当前版本重新资格化历史
消息；已落盘事实由原 journal 重放，未落盘窗口保留 native_recovery_gap。
子 Agent 不纳入本平面，保留 subagent_scope_unknown，结束状态最多 partial。

## 兼容与回退

写入开关默认关闭；只读能力与旧 Task/Session 协议独立。未知/未资格验证的
Provider 不准入 counted，Copilot/Claude 只提供已证明的部分平面，Codex 只报告不支持。
关闭新能力不停止原生执行、不修改旧累计 ACK，也不删除账本。

迁移与 schema snapshot 同步维护，既有历史迁移不可改写。
回退构建必须仍认识新迁移；`appliedMigrations` 的已知前缀检查会拒绝任意旧二进制。
不得删迁移账本、checksum 或数据来伪造可回退状态。
Controller journal 同样保留格式 014；回退 CLI 必须认识该格式，即使关闭用量功能。

## 验证职责

core 使用合成数据证明规范十进制、null/零、profile、修订、冲突和完整性；
无需数据库的测试必须在未设置数据库环境时运行。
DAO 使用任务独占的真实 PostgreSQL，证明迁移、受限角色、唯一性、CAS、
锁等待取消、快照、并发与持久化读回；mock 不能替代数据库证明。
HTTP 测试保留真实解析/编码/鉴权接入，service 测试保留真实协调与提交结果处理。
正常组装 API 通过独立集成入口运行。

性能资格独立于常规 CI：100 Task，各 10 state、每 state 100 measurement，
批量摘要预热五次、测量三十次 P95≤500ms；10,000 measurement 的单 Task，
100 条分页 P95≤200ms。保存真实 `EXPLAIN (ANALYZE,BUFFERS)`，不以截断改变语义，
不把压力场景加入普通单元或集成测试。
