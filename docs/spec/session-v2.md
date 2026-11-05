# Task Session v2 协议与归档要求

## 范围与消费方

Session v2 为受管 Herdr 执行提供独立完整画面、终端控制、运行代次账本、
最终封存和不可变历史文件的共同交换契约。Worker、服务端和浏览器必须消费相同
类型和正反例。终端画面不具备消息、turn、结构化审批或 `provider_accepted`
语义；`native_timeline` 保留现有 Web Session 语义。

本规范约束交换值及其生产和消费责任。契约库不负责注册授权、持久化、租约计时、
原生停止、文件上传或页面操作。通过解析只证明结构和所声明内容的完整性，
不能证明调用者拥有执行权、原生进程确已停止或用户操作已经执行。
具体字段、编码、导出入口与校验算法见[契约设计](../design/session-v2-contract.md)。

## 版本与兼容

HTTP 用 `Daynight-Session-Protocol` 请求头显式选择版本，WebSocket 用同值
subprotocol。未选择时采用 `daynight.session.v1`；显式未知值必须返回
`unsupported_protocol`，不能静默回退。v2 使用 `daynight.session.v2`、
`schemaVersion=2`、`projectionVersion=1`。

| 消费组合 | 必须的结果 |
|---|---|
| 旧 Web/CLI 与新服务端 | v1 Web 行为、字段和历史读取保持不变；未选择 v2 的 Herdr 查询维持 `not_applicable` |
| 新 Web 与旧服务端或 Worker | Web 保持 v1；Herdr 显示不可用原因，不尝试宽松解析或按名称输入 |
| v2 服务端、Worker、Web | 独立检查观察、控制和归档能力；原生严格 attach 支持验证通过才能开放控制 |
| 未知 `contentKind` | 返回 `unsupported_content_kind`，不解释为普通聊天消息 |
| v1 历史文件 | 使用原 schema、hash、权限读取，不原地升级或追加 v2 字段 |
| v2 terminal 文件 | 支持 `terminal_recording` 和完整性字段的 reader 才能读取 |

路由仅在对应实现具备能力后选择 v2；可导入的类型或协议常量不是运行能力声明。
v1 adapter 仅承载通过原严格解析器验证的 native snapshot，不改变旧 producer。

## 身份、代次与注册

Session fence 是 `sessionId`、`claimId`、`executionGeneration`。服务端与 Worker
必须核对原项目、任务、Worker、worktree、owner 和 `serverOrigin`。浏览器不能提交
任意 socket 路径或目标名称。Daynight UUID 与 Herdr/provider 的原生 ID 分开校验；
原生字符串按原值比较，不强制转换为 UUID。数值 ID 必须保留原类型和原生范围。

`nativeSessionId` 在首次输入前允许 `null`，不得作为首次输入的准入条件。
后续观察只允许从 `null` 补齐为一致的非空值，不能退回 `null` 或替换另一会话。
首次输入仍需要可靠的原进程、claim、terminal 绑定与 readiness 检查。

正常重连保留 Session 与实际运行代次，只增加 `connectionEpoch`。原运行确已停止
并恢复后才能增加 `executionGeneration`。新的 claim 使用新的 Session。
采集器启动建立新 `segmentId` 和持久递增的 `segmentOrdinal`；同一运行的采集重启
只开新段。排序依据段序号和帧序号，墙钟只用于显示与范围校验。

运行账本保留每代的 owner、原生绑定、段归属和停止证明，不能只覆盖当前 snapshot。
停止证明必须引用原始 boot identity、PID 和 birth token，并覆盖受管 terminal、
承载 shell 与 native agent；当前 pane 消失或 close 返回不构成证明。
契约仅验证证明结构与归属，适配器负责提供可信原生观察。

## 完整画面与样式

每一 snapshot 都是可独立渲染的完整画面，`full=true`。禁止差分依赖、原始 ANSI、
HTML、脚本、OSC 剪贴板、外部资源或可执行链接。白名单 styled-text 只包含文本、
前景/背景颜色以及 bold、italic、underline、inverse。渲染器必须创建文本节点。
Unicode 字符数不等于终端 cell 宽度；reader 不得据此截断宽字符或组合字符。

实时传输允许用最新完整帧覆盖待发旧帧；历史录制不能因慢 viewer 丢弃已选帧。
采样由执行生命周期驱动，无 viewer 时仍继续。每轮读取完成至少等待 350ms；
持续相同画面保留观察区间，每 5 秒或段结束持久 checkpoint。
崩溃后只承认 durable checkpoint，其后到恢复之间明确记 gap。

已登记文件缺失、hash 错误、跨 Session/运行/段归属或无序引用均属于损坏。
不能删除错误引用后将文件标为 `partial`。每个归档索引必须引用唯一存在且校验
通过的完整帧，所有文件必须被索引，区间不能与 gap 重叠。

采集器重启和运行恢复必须保留显式边界 gap，即使两侧各自的采样都完整也只能
标为 partial。边界不是有持续时间的采样区间，不能因下一段首帧 elapsed=0
而被视为重叠。无帧运行需保留合法原因和无内容证据，不能省略旧运行来获得
complete，也不能伪造一个不存在的采集段。

## 控制与输入

页面默认只读；查看、刷新、回放或获取 lease 不得 native attach。明确提交
`paste`/`keys` 才能严格 `AttachTerminal(terminalId)`，等待完整基线和键盘模式，
再次校验 binding 与当前准入条件，然后发送并 Detach。目标消失不能按名称回退。
attach 本身可能重应用尺寸或恢复 pending agent，不能承诺无副作用。

所有 Daynight 输入由 Worker 的同一个持久仲裁器管理，包括初始 assignment、
continuation、网页输入和 cleanup prompt。`manual` 期间禁止自动输入；普通释放、
断线、撤权和 lease 过期后进入 `suspended`，不能根据 idle 自动恢复。
`closing`/`closed` 拒绝普通输入。Worker 重启、terminal 替换、撤权和停止提升
`controlEpoch`，旧结果仅能更新原操作，不能恢复旧控制。

lease 为 30 秒，10 秒续约，授予和续约必须收到关联原请求的 Worker durable ACK。服务端和 Worker
分别校验过期；Worker 使用单调时限，重启后租约失效。最多一个未决人工批次，
输入绑定完整 fence、connection/control epoch、segment、terminal、lease 与递增
`leaseSeq`。单次 paste 最多 16 KiB UTF-8；keys 每次只允许一个白名单逻辑快捷键。
批次总时限 10 秒。

发送前必须持久记录 operation ID、来源、目标、payload digest 与 `dispatching`。
同 ID 同正文只返回既有结果，不重复发送；同 ID 不同正文拒绝。已越过原生写入
边界或无法判明边界的失败必须是 `unknown`，不能降为可重试的 `rejected`。
`transport_completed` 只证明传输流程完成。重启把遗留 `dispatching` 收敛为
`unknown`；幂等记录保留到最终封存并撤销所有写权限。

首次 assignment 为独立稳定操作，只有 `pending` 能自动发送。
已确认零写入的拒绝必须保留原 receipt，并允许
Worker 将首次进度从 `dispatching` 发布回 `pending` 后重新准入；
`unknown`、`unconfirmed` 和 `transport_completed` 不得因此变为可重发状态。首次派发与人工
接管互斥；`unknown` 或旧运行的 `unconfirmed` 不得自动补发任务说明。
未知首次输入通过独立 `resolve_initial_assignment` 动作显式提交
`delivered_continue` 决定；仅允许无 lease 的 suspended 状态，`draftHandled=false`。
Worker 持久记录处置、提升控制代次并保持 suspended，不修改原 unknown 操作结果。
恢复自动执行必须另行提交 `resume_automation`，确认 `draftHandled=true` 且
`initialUnknownDisposition=null`，不得夹带首次输入处置。两种动作的 `leaseId` 均为 null；
未处置的 unknown/unconfirmed 禁止恢复。Worker 重新核对 readiness、原 fence、最新 epoch 和
进行中批次；处置不构成 provider ACK。旧 Worker 未公布独立处置能力时禁用该动作，
不能用同时恢复自动执行的旧请求替代。网页单写者不能排除本地 Herdr TUI/API 并发输入。

控制派发必须保留服务端认证的 actor、原请求摘要和 fence。Worker 持久仲裁后
返回关联 operationId 的结果与状态；未关联状态、尚未派发完成的结果或旧代次
ACK 不能授予 lease。`renew_control` 只续期当前 holder/browser 的同一 lease 和
controlEpoch；过期后不能复活。补充消息需要明确能力匹配，旧 v2 producer 不能
因协议名称相同而被当作具备这些行为。

## 干净 shutdown 的自动输入恢复

普通断线或重连不能恢复自动输入。计划 shutdown 可以在旧连接仍在线时申请单次
服务端许可：Worker 必须已经持久关闭本地输入，确认无草稿、未知输入或在途批次，
并将原自动状态的初始完成结果发布给服务端。服务端同时核验原 owner、active claim、
allowAgents、非 paused、旧 fence、无 lease/未决操作和未停止运行；确认许可的同一
事务将旧控制冻结为 closing。停止证明本身不产生自动输入权限。

Worker 使用 `automation_recovery_prepare` 请求许可、`automation_recovery` 消费许可，
服务端返回 `automation_recovery_state`。原始请求和回执字段由
[契约设计](../design/session-v2-contract.md#消息外层与-payload)拥有。

消息通过现有 `POST /api/v1/projects/{projectId}/tasks/{taskId}/sessions/{sessionId}/worker-messages`
发送，使用 v2 请求头和当前 Daynight-Connection-Epoch。摘要为完整请求的规范 JSON
SHA-256。发送前持久原请求；请求响应丢失后，通过
`GET /api/v1/projects/{projectId}/tasks/{taskId}/sessions/{sessionId}/automation-recovery/{recoveryId}`
读取原记录，不自动重发。GET 沿用 owner 读取授权，未登记返回 not_found；它只读取
历史记录，不签发新许可。registration、control_state 和原 state 的字段保持不变；
不支持新消息或 GET 的旧服务必须使恢复失败关闭，不能降级到普通状态发布。

消费要求旧 stopProof.recordId 与 stopOperationId 一致、同一原生会话、精确相邻
新代次和当前在线 Worker。许可最多消费一次；同请求只能读取原结果，异正文同 ID
拒绝。旧消费回执不能授权后来的 connection/control epoch，Worker 必须再读当前
服务状态确认仍 automation。manual、unknown、终态 cleanup 和缺许可都不能借
下一代运行解除暂停。原许可及消费记录保留至 Session 最终撤权，受 MaxRuns 限额
约束；容量满则拒绝新许可，不能淘汰旧身份后重用。

## 封存、归档与回执

最终封存与恢复授权在同一 Session 锁下互斥。只有原 claim 已终态且全部已登记
运行停止，服务端才能 CAS 冻结唯一 `finalizationId`。响应丢失时读回原 ID，
不得另建第二次封存。冻结后禁止新运行或新段。Worker shutdown 只关闭当前段，
保留原 claim、Session 和本地源；不能提前生成最终不可变 ready。

| 状态 | 保证与失败行为 |
|---|---|
| `pending` | 保留固定源和重试责任；短暂上传失败采用 5 秒至 5 分钟退避，每轮最多一个历史归档 |
| `ready/complete` | 正文不可变，声明采样范围内没有已知中断；不承诺全部 PTY 输出 |
| `ready/partial` | 所列完整帧可信，存在明确 gap；reader 显示缺口，播放到缺口停止，由用户选择继续 |
| `unavailable` | 仅合法未启用录制，或无采集错误且首帧前正常结束；正文信息为 `null`，有原身份和停止归属的终态回执 |
| `failed` | 缺登记文件、hash/归属错误、不可恢复 manifest 或采集故障零帧；保留证据和资源，停止无效自动重试 |

`unavailable` 必须证明没有已选择或登记但丢失的内容。没有本地文件不等于合法
零帧。`partial`、`unknown` 与无内容状态均不能放宽身份、权限或 hash 校验。
停止证据不足保持 `stop_unknown`，不能封最终文件、删除 worktree 或恢复替代运行。

归档使用 `session-archives` 与原 Session 权限，不是可覆盖的普通附件。
正文 hash 对实际上传 UTF-8 字节计算，重试上传同一字节。帧 hash 对所保存的原始
帧 JSON 字节计算。`dispositionDigest` 对规范化终态记录计算，与正文 hash 不可
互换。ready 回执绑定正文 hash、长度、完整性；unavailable 回执绑定不可变原因
和无内容证据。只有可信服务端生成并持久读回的回执才可作为清理门禁。

任务重新领取后仍应按原 Session 发现历史；读取重新检查权限，删除任务或撤销
成员不恢复访问。历史阅读不取得 lease、不 attach、不恢复 native session。
原 owner 的删除任务归档收尾权限沿用现有规则，与用户读取权限分别判断。

## 录制证据的来源与失败边界

每代先由服务端登记录制策略和固定责任身份并 ACK，再由可信 Worker 持久保存
同一身份后采集。初始登记之后，持续采集不依赖逐帧联网。Worker 选择内容前
必须写入持久责任；修订和内容计数不得回退，捕获错误不得被清除。

收尾提供固定、正常关闭的责任证据，绑定原 fence、责任 ID、日志字节身份和
该代文件/索引来源。服务端保存并核对证据与既有观察；ready 的每代 selected、
registered 计数必须均等于实际归档文件数，来源摘要必须匹配。合法 unavailable
仅允许闭合零计数、无错误、空来源且策略/原因一致的责任，仍需全部运行停止及
finalization 冻结。缺日志、未完成关闭或内容损坏不能重建为零帧。

证据的 hash 不独立证明本机采集事实；服务端只对已观察记录核验单调性。
可信 Worker 之外的恶意伪造或本地状态回滚不具有独立远程证明。无法取得可信
正常关闭证据时保持失败/未知并保留资源；真实 Worker 恢复验证不能被 schema
或测试生产者替代。

## 统一限额

| 项目 | 上限或固定值 |
|---|---|
| 最终 JSON UTF-8 字节 | 64 MiB |
| 单条在线协议消息 UTF-8 字节 | 4 MiB |
| 帧文件及时间索引规范序列化预算 | 60 MiB |
| 其余 manifest、段、gap、结束元数据 | 4 MiB |
| 单帧原始 JSON 字节 | 256 KiB |
| 不同帧 / 段 / gap / 运行代次 | 100000 / 1000 / 1000 / 1000 |
| width / height | 正整数，各不超过 1000 |
| 原生文本标识 | 256 UTF-8 字节，无控制字符 |
| 序号 | 十进制字符串，0..9223372036854775807；generation 和 seq 必须正数 |
| paste / 人工批次时限 | 16 KiB / 10 秒 |
| lease / 续约间隔 | 30 秒 / 10 秒 |
| 采样等待 / checkpoint | 350ms / 5 秒 |
| viewer 无发送进展 | 10 秒后断开该 viewer |
| 待收尾 worktree / 录制源总量 | 20 / 2 GiB |
| 新 claim 最低空闲磁盘 | 1 GiB |

预算耗尽不能静默截断后声称完整，也不能停止业务 agent 或删除旧帧；使用预留
末尾记录保存限制原因和截断起点，最后 gap 可延伸至停止时间。磁盘损坏可能
无法记录 gap；只有可信源和显式间断都能恢复时才允许 partial，否则 failed。
有限预算不是任意时长完整录制承诺。

## 验证与边界

TS/Go 必须对同一原始字节正反例得出相同结论，覆盖未知/重复字段、非法 UTF-8
和 surrogate、空/超范围序号、原生非 UUID ID、`nativeSessionId=null`、包/帧/
输入边界、完整帧、排序、缺文件、跨段/运行归属、完整/部分/无内容终态及摘要。
v1 真实既有样本继续由原解析器读取，未知版本明确拒绝。常规 CI 保留紧凑正反例、
快速数量/字节拒绝和 256 KiB 帧边界；100000 帧、60 MiB 录制和 64 MiB 归档的完整
规模验证由显式本地压力套件运行，保留原始生产限额及精确边界断言，压力入口在 CI
环境中拒绝。

原生控制副作用、持久仲裁、停止证明可靠性、磁盘故障、真实长任务容量、
浏览器交互和端到端验收属于相应实现的验证责任。契约测试不替代这些验证。
首版不提供多 pane、任意 mouse/resize、完整 scrollback、强制 takeover、运行期
远端备份、自动 GC、分块压缩或独立导出；保留版本、内容种类、段、完整性和
原执行身份，使这些扩展无需改写既有历史。
