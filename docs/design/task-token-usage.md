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

## Controller 采集与上传

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
