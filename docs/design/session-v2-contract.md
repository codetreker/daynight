# Task Session v2 契约设计

## 模块与责任

[行为要求](../spec/session-v2.md)规定生产者和消费者必须维持的保证。本设计定义
可交换的字节、对象和验证入口。TS 的
[`session/v2/`](../../packages/daynight/src/session/v2/) 是 browser-safe 源码；
Go 的 [`core/session/protocol/v2/`](../../packages/daynight-server/internal/core/session/protocol/v2/)
为独立包。v1 模块保留原类型和解析规则，不通过放宽旧 parser 接收新内容。

TS `values.ts` 拥有版本、限额、原始 JSON 解码、基本值和规范序列化；`types.ts`
拥有公共类型；`protocol.ts` 拥有消息判别与跨字段约束；`archive.ts` 拥有归档
引用和完整性。共享原始字节向量位于
[`fixtures/v2/`](../../packages/daynight/test/session/fixtures/v2/)，由两种语言直接读取。
文件入口和测试清单一起构成可执行交换契约，不能各自在服务端、Worker、Web
复制另一套字段。

服务端消费 registration/ledger/finalization 时仍须在事务与 Session 锁下核对
认证用户、原 claim 和已登记的运行身份。Worker 负责 durable 写入、原生能力、
单调时限和资源责任。浏览器只在验证过的内容上呈现画面，不把解析成功视为授权。
HTTP/WebSocket 路由启用、原生适配器、持久录制及 UI 分别由其实现模块负责；
本包提供纯协议选择函数，不自行注册服务端路由。

Web 的 `TerminalRecordingView` 以[公共原生选择组件](native-select.md)的 `filter/content` 呈现本地录制缩放，继续用原受控值改变 `--terminal-text-scale`，不产生控制请求、回执或归档修改。播放器与所在 Session 的全屏根保持同一子树；`useSessionFullscreen` 的共享 React/document 键盘处理器尊重已消费事件与 IME，并在缩放原生 popup 打开时只停止 Escape 传播，保留原生取消和当前全屏。非 popup Escape 沿原退出与回焦点逻辑处理。播放、暂停、时间轴和归档完整性仍由各自原机制拥有。

## 原始 JSON 与基本类型

所有表中字段均必需，包括值为 `null` 的字段。所有对象拒绝未知字段、遗漏字段
和重复的解码后键名（`"a"` 与 `"\u0061"` 是重复键）。入口接受原始 UTF-8
字节或无损字符串，拒绝非法 UTF-8、未配对 surrogate、BOM、尾随值与非 JSON
数字。先 `JSON.parse` 再调用对象 parser 会丢失重复字段证据，不能用于不可信输入。
单条在线消息原始 UTF-8 最多 4 MiB，完整归档最多 64 MiB；嵌套深度最多 64。
这些入口限制先于对象和引用校验执行，超过限制不能通过去掉空白或重编码后重试解析。

| 简写 | 规则 |
|---|---|
| UUID | 小写 `8-4-4-4-12` 十六进制字符串 |
| Seq | 规范十进制字符串，`1..9223372036854775807`，无符号和前导零 |
| ZeroSeq | 同 Seq，但允许 `"0"` |
| NativeText | 非空非空白、最多 256 UTF-8 字节、无 Unicode Cc，按原值精确比较 |
| Time | UTC RFC3339，必须 `Z`，小数秒可省略或 1–3 位；真实日历日期 |
| Hash | 64 个小写十六进制字符，SHA-256 |
| Int | JSON 安全整数，满足指定范围；数值相等的 `1`、`1.0`、`1e0` 等价 |
| Origin | 规范 `http`/`https` origin，最多 2048 字节，无路径、末尾斜杠、userinfo、query、fragment |

Herdr 的实际 terminal ID 是 `term_…` 字符串；不可将其当 UUID。
`paneId` 允许 RPC 的 NativeText 或原生布局的 uint32（`0..4294967295`），
字符串 `"1"` 与数字 `1` 不相等。其余 Herdr 标识为 NativeText。
原生类型依据 Herdr
[`TerminalId`](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/terminal/id.rs)
和 [`PaneId`](https://github.com/herdrdev/herdr/blob/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde/src/layout.rs)。

`selectSessionProtocol` / Go 对应选择函数对缺省值选择 v1，对精确的 v1/v2 值
返回该版本，对其他值报 `unsupported_protocol`。调用者负责区分请求头缺省与
显式空字符串；WebSocket 调用者先解析 subprotocol 列表，不能把列表作为单个值。

## 公共对象

`Binding`：`instanceId`、`sessionId`、`workspaceId`、`terminalId` 是 NativeText；
`paneId` 如上；`nativeSessionId` 为 NativeText 或 `null`。这里 `sessionId`
属于 Herdr，外层 Session UUID 与它没有推导关系。比较 binding 必须核对全部字段。
`assertNativeSessionIdProgression` 只允许 `null → null/value` 或 `value → 同值`。

`Owner`：`projectId`、`taskId`、`workerId`、`worktreeId`、`ownerUserId` 为 UUID；
`serverOrigin` 为 Origin；`provider` 为 `codex|claude|copilot`。

`Lease`：`leaseId`、`holderUserId`、`browserClientId` 为 UUID；`controlEpoch`
为 Seq；`expiresAt` 为 Time。到期字段用于交换，Worker 的进程内有效性仍按
单调时限计算，不能用浏览器时间决定。

`ProcessProof`：`role=shell|agent`、`pid=1..2147483647`、NativeText
`birthToken` 和 `bootId`。`StopProof` 包含 UUID `recordId`、Seq
`executionGeneration`、`binding`、NativeText `bootId`、Time `stoppedAt`、
`method=instances_exited|boot_changed`、`terminalStopped=true`、`processes`。
普通证明的进程至少覆盖一个 shell 和一个 agent，原实例三元组不得重复；其 JSON
不包含 `nativeLaunch` 或 `daemon` 键。

准备证明保留上述共同字段，并且必须包含 `nativeLaunch="not_submitted"` 与
`daemon:{pid,birthToken,bootId}`。`processes` 恰有一个 `role=shell` 的原进程，
daemon 与 shell 使用同一 boot、不同 PID；字段类型与普通进程身份相同。两种证明
分别校验精确键集合，缺少 agent 不会隐式选择准备分支。准备证明依赖 Worker 的
持久启动事实及原资源停止观察，服务端不能独立观察执行机器上的原生进程。

`Run`：`executionGeneration`、`owner`、`binding`、Time `startedAt`、
Time 或 `null` 的 `stoppedAt`、StopProof 或 `null` 的 `stopProof`、UUID 数组
`segmentIds`。停止时间与证明同时为 null 或同时存在；证明的代次、绑定和时间
必须匹配该运行。账本代次从 1 连续递增，外层代次等于最后一代；除最后一代外
全部已停止。各代 owner 相同、段 ID 全局唯一，已知 nativeSessionId 不可改写。
准备证明要求本代 `segmentIds=[]`，proof 与 run 的 nativeSessionId 完全一致；
可保留前代已知值，不能在停止时补入新值。服务端在 ledger、recording evidence
的两个写入方向及最终冻结前，均拒绝准备证明与本代非零 selected/registered count
或 ObservedContent 共存。前代内容不影响本代判断；captureError 不得清空来制造
合法 unavailable。准备证明不能消费 generation grant 或自动恢复授权。

零帧准备运行按实际无错误证据取得 `unavailable/ended_before_first_sample` 回执。
若前代已有帧，固定归档保留原帧与段，准备代进入 `unavailableRuns`，代次边界仍有
显式 restart gap。不得制造空 ready 归档或将丢失的源改称合法零帧。

新分支沿用 v2 envelope/schemaVersion/projectionVersion，要求服务端与 Web reader
先具备解码能力，再启用 Worker 生成。旧 Worker 的普通证明仍可读写；旧 reader
拒绝新增分支时保留原证据与收尾责任，不转换 proof 或固定归档。缓存旧 Web 需要
刷新到支持版本；此扩展不承诺旧页面无刷新读取新证明。

## 完整帧

`Frame` 字段是 `frameSeq:Seq`、`capturedAt:Time`、`elapsedMs:ZeroSeq`、
`width/height:Int(1..1000)`、`full:true`、`rows`。rows 数量严格等于 height，
每行是 0..1000 个 `StyledRun`，文本合计最多 16 KiB UTF-8。

`StyledRun` 必须有 `text`、`foreground`、`background`、`bold`、`italic`、
`underline`、`inverse`。颜色为 `null` 或小写 `#rrggbb`；四个样式为 boolean。
文本允许普通 Unicode 和空字符串，但不含 Cc（包括 TAB、换行和 ESC）。换行
由 rows 表示，终端 TAB 由 producer 归一为画面内容。禁止样式之外的附加属性。
live snapshot 的 Frame 对象按规范 JSON 计数，不超过 256 KiB；归档中
FrameFile.data 的原始 UTF-8 字节也必须不超过 256 KiB，包括其空白与转义。

## 消息外层与 payload

每条消息的共同字段：`protocol="daynight.session.v2"`、`schemaVersion=2`、
`projectionVersion=1`、`type`、UUID `sessionId/claimId`、Seq
`executionGeneration`、`agentControlMode`、`contentKind`、`payload`。
除 `native_snapshot` 外，判别组合固定为 `herdr/terminal_recording`。

| type | payload 必需字段 |
|---|---|
| `registration` | `registrationId:UUID`、`mode:register|reconnect`、Owner `owner`、Binding `binding`、`connectionEpoch:Seq|null`、`capabilities:{observe,control,archive}`（三个 boolean） |
| `registration_ack` | `registrationId:UUID`、`connectionEpoch:Seq` |
| `snapshot` | `connectionEpoch:Seq`、`segmentId:UUID`、`segmentOrdinal:Seq`、Binding `binding`、Frame `frame`、`recorded:boolean` |
| `automation_recovery_prepare` | `recoveryId:UUID`、`connectionEpoch:Seq`、`controlEpoch:Seq`、`closingControlEpoch:Seq`、`stopOperationId:UUID`、`binding:Binding`、`initialAssignment="transport_completed"` |
| `automation_recovery` | `recoveryId:UUID`、`connectionEpoch:Seq`、`controlEpoch:Seq`、`previousGeneration:Seq`、`stopOperationId:UUID`、`binding:Binding` |
| `automation_recovery_state` | `recoveryId:UUID`、`prepareDigest:Hash`、`sourceGeneration:Seq`、`sourceConnectionEpoch:Seq`、`sourceControlEpoch:Seq`、`closingControlEpoch:Seq`、`stopOperationId:UUID`、`nativeSessionId:NativeText`、`consumed:RecoveryConsumption|null` |
| `control_state` | `connectionEpoch:Seq`、`controlEpoch:Seq`、`state`、`lease:Lease|null`、`initialAssignment`、`availableActions`、`unavailableReason:ErrorCode|null` |
| `control_request` | `operationId:UUID`、`connectionEpoch/controlEpoch:Seq`、`action`、`browserClientId:UUID`、`leaseId:UUID|null`、`draftHandled:boolean`、`initialUnknownDisposition:null|delivered_continue` |
| `control_dispatch` | `actorUserId:UUID`、`requestDigest:Hash`、`request:ControlRequest` |
| `control_ack` | `requestDigest:Hash`、`durable:true`、`controlState:ControlState`、`result:OperationResult` |
| `recording_responsibility` | `responsibilityId:UUID`、`recordingEnabled:boolean` |
| `recording_evidence` | `responsibilityId:UUID`、`evidenceId:UUID`、`revision:Seq`、`selectedFrameCount/registeredFrameCount:ZeroSeq`、`captureError:ErrorCode|null`、`closed:boolean`、`journalSha256/sourceSha256:Hash` |
| `operation` | `operationId:UUID`、`connectionEpoch:Seq`、`segmentId:UUID`、Binding `binding`、`controlEpoch:Seq`、`leaseId:UUID`、`leaseSeq:Seq`、`kind:paste|keys`、对应 `payload` |
| `operation_result` | `operationId:UUID`、`state`、`errorCode:ErrorCode|null` |
| `generation_ledger` | `runs:Run[]`、`finalizationId:UUID|null` |
| `finalization` | `finalizationId:UUID`、`claimTerminal:true`、`runs:Run[]` |
| `archive_status` | `state`、`sha256:Hash|null`、`byteLength:Seq|null`、`completeness:complete|partial|null`、`errorCode:ErrorCode|null`、`finalizationId:UUID|null` |
| `receipt` | 下节的终态回执 |
| `native_snapshot` | 完整且未修改的 v1 SessionSnapshot；外层必须 `web/native_timeline`，内外 fence 一致 |

register 的 epoch 必须 null，reconnect 必须非空；control 能力要求 observe。
RecoveryConsumption 包含 `executionGeneration:Seq`、`connectionEpoch:Seq`、
`controlEpoch:Seq`、`requestDigest:Hash`。prepare 的 closingControlEpoch 大于
controlEpoch；两种请求的 binding.nativeSessionId 必须非空。消费请求的外层代次
恰好为 previousGeneration 加一；回执未消费时外层代次等于 sourceGeneration，
已消费时等于 consumed.executionGeneration，且后者为 sourceGeneration 加一。
消费连接和控制代次分别大于 sourceConnectionEpoch 和 closingControlEpoch。
prepareDigest/requestDigest 对相应完整请求的规范 JSON UTF-8 计算 SHA-256。
这些是结构约束；单次授权、停止证明、当前控制与旧服务失败关闭规则由
[shutdown 恢复要求](../spec/session-v2.md#干净-shutdown-的自动输入恢复)约束。

control_state 的 `state=automation|manual|suspended|closing|closed`；manual
当且仅当 lease 非空，且 lease/control epoch 相同。paste/keys 只能在 manual
可用；closing/closed 没有可用动作。`initialAssignment` 为
`pending|dispatching|transport_completed|unknown|unconfirmed`；unknown/unconfirmed
不能 automation，dispatching 不能 manual。原受校验 Worker 在持久确认零写入后可发布
`dispatching → pending`；服务端依赖 Worker 的输入 receipt 保证，不独立推断 native
写入结果。`unknown`、`unconfirmed` 和 `transport_completed` 均不能退回 `pending`。
owner、claim、generation、connection/control epoch 和 automation 交还限制继续适用。

动作集合是 `acquire_control|renew_control|release_control|resume_automation|paste|keys`，
control_request 只接受前四项。acquire 使用 null lease 与 false/null 确认字段；
renew/release 要求 lease，确认字段仍 false/null；resume 要求 `draftHandled=true`，
Worker 结合持久首次输入状态决定是否还必须提供 `delivered_continue`。

paste payload 为 `{text}`，非空、最多 16 KiB UTF-8，可含 LF/CR/TAB，不含其他
Cc。keys payload 为 `{key}`，仅接受 Enter、Escape、ArrowUp、ArrowDown、
ArrowLeft、ArrowRight、Tab、Backspace、Delete、Home、End、PageUp、PageDown、
Ctrl+C、Ctrl+D、Ctrl+U。每次一个逻辑键，不接收任意转义字节。

operation_result 的 state 为 `queued|dispatching|transport_completed|rejected|unknown`。
rejected 要求非空 errorCode，unknown 必须 `input_unknown`，其他状态 errorCode
必须 null。generation_ledger 的非空 finalizationId 与 finalization 消息都要求
全部运行已停止；库不执行冻结 CAS。

## 控制请求的认证派发与持久确认

服务端补充的 `control_dispatch` 和 `control_ack` 保留原 `control_request`、
`control_state` 和 `operation_result` 的形状。`requestDigest` 是规范 JSON
`{actorUserId,request}` 的 SHA-256；外层 fence 仍须单独核对。原始 decoder
验证 dispatch 的摘要，不能仅从对象 parser 的结果推断摘要已验证。
`actorUserId` 来自服务端认证，浏览器不能替其他用户提供该值。

Worker 只在持久提交请求结果与仲裁状态后发送 `durable:true` 的 ACK。
ACK 的 result 只接受 `transport_completed|rejected|unknown`，其 operationId
关联原派发请求。`transport_completed` 对控制请求表示该次仲裁转换已经持久完成，
不是原生 provider 接受输入。服务端核对请求摘要、执行与连接代次、原 holder、
browser 和预期转换；迟到结果只能结算原操作，不能恢复过期控制。

`renew_control` 是独立的幂等请求，必须携带当前 leaseId；续约保留同一 holder、
browser、leaseId 和 controlEpoch，Worker 与服务端都核对尚未到期，仍需 durable
ACK 才能延长浏览器可用期。过期后需重新 acquire，不能通过续约复活。acquire
成功必须为 manual；release 成功必须为 suspended；resume 成功必须为 automation。
浏览器不能以未关联的 control_state 或 queued/dispatching 结果自行取得控制。

Terminal 客户端的 `suspendForAccountRefresh()` 不依赖当前身份或执行准入：它同步
关闭 channel、取消读取并停止续约、回执查询及重连，保留已显示的 Session 与画面。
已派发操作按原 unknown 规则收尾；该客户端在页面刷新前不能因可见性恢复而重新
派发。普通可见性暂停仍可恢复，真正撤权和失效仍执行原有清理。具体展示与输入
规则见 [Herdr Session 页面设计](herdr-session-web.md#实时连接与人工输入)。

这些补充消息及 renew 动作须由能力发现明确声明，不能只凭同一 v2 字符串推断
旧 Worker 已实现。未匹配的组合保持不可用，不降级为原生输入或即时授予。

## 可信 Worker 的录制责任

每个运行代次在采集开始前，通过 `recording_responsibility` 登记固定责任 ID 和
是否启用录制。服务端先持久 ACK；Worker 将同一身份可靠写入本机日志后才能采集。
此后无需运行期逐帧联网或远端备份。初始 ACK 未确认时不能假称已建立责任。
原 owner、claim、generation、Worker、worktree、录制策略和责任 ID 不得替换。

Worker 在选择内容前持久登记责任，随后登记文件和索引；计数与修订单调增长，
捕获错误不可清除。`recording_evidence` 可提交中间状态或最终关闭证据：
registeredFrameCount 不得大于 selectedFrameCount；每个修订有固定 evidenceId
与完整正文。相同 ID 或修订的重试只接受相同内容；已经 closed 的证据不可追加、
清零或替换。服务端按原代次持久保存并比较既有观察，原始 decoder 只验证单条
结构，不替服务端执行跨提交的单调性、身份或冻结检查。

`journalSha256` 标识 Worker 可信持久日志的固定原始字节。`sourceSha256` 是该
运行所选规范 JSON `{files,index}` 的 SHA-256：从已验证的 Archive 按该 Run 的
segmentIds 筛选 files/index，保留归档内顺序及 FrameFile.data 的原始文本。
无帧运行使用 `{files:[],index:[]}` 的固定摘要。Go `SourceDigest`/
`EmptySourceDigest` 和 TS `sourceDigest`/`emptySourceDigest` 共享向量；这些摘要
不替代最终归档原始字节的 hash。

最终 evidence 必须源于完整可信日志的正常关闭；日志缺失、断裂、已登记文件丢失
或无法核实关闭时不能重建零帧证据。ready 要求每代 closed、selected 和 registered
均等于该代实际归档文件数，并核对 sourceSha256；错误必须与 partial 的可信缺口
相容，不能用 gap 掩盖损坏。unavailable 要求每代 closed、两个计数为零、无捕获
错误、空 source 摘要，以及原策略与原因一致；还须核对所有运行已停止和最终冻结。
不可用回执原有 NoRecordingEvidence 是这些持久事实的终态投影，不是其来源。

Worker 是真实采集和本机持久事实的可信生产者；服务端不能直接观察远程磁盘。
journal hash 只证明内容身份，不独立证明采集事实；单调比较也仅覆盖服务端已
观察的记录。完整本地状态或日志尾部回滚到自洽旧前缀、恶意 Worker 与凭据滥用
没有独立远程证明。缺可信正常关闭证据仍须保留失败或未知责任，不能据目录为空
签发 unavailable。录制模块必须以真实 Worker 故障注入验证这些恢复约束。

## 归档文件和引用

顶层字段：`schemaVersion=2`、`projectionVersion=1`、
`contentKind=terminal_recording`、`agentControlMode=herdr`、UUID
`sessionId/claimId/finalizationId`、Seq `executionGeneration`、Owner `owner`、
Time `startedAt/endedAt`、`completeness=complete|partial`、
`policy:{sampleIntervalMs:350,checkpointIntervalMs:5000}`、`runs`、`segments`、
`files`、`index`、`gaps`、`unavailableRuns`。runs 最多 1000，全部停止，owner/最终代次与外层一致。
归档至少有一个可信完整帧；合法零帧用 unavailable 回执表达。

| 对象 | 必需字段与约束 |
|---|---|
| Segment | `segmentId:UUID`、`segmentOrdinal:Seq`、`executionGeneration:Seq`、Binding `binding`、Time `startedAt/endedAt`、`durationMs:ZeroSeq`；按 ordinal 严格递增，首段 ordinal 为 1；最多 1000 |
| FrameFile | `fileId:UUID`、`segmentId:UUID`、`frameSeq:Seq`、`sha256:Hash`、`byteLength:Seq`、`data:string`；data 为完整 Frame 的原始 UTF-8 JSON 文本 |
| FrameIndex | `segmentId:UUID`、`frameSeq:Seq`、`fileId:UUID`、`firstElapsedMs/lastElapsedMs:ZeroSeq` |
| 区间 Gap | `segmentId:UUID`、`reason:restart|read_interrupted|recording_limit|checkpoint_lost`、`startElapsedMs:ZeroSeq`、`endElapsedMs:ZeroSeq|null`；null 延伸至段结束 |
| 边界 Gap | `kind:boundary`、`reason:restart`、`from`、`to`；两端均为 `{executionGeneration:Seq,segmentId:UUID|null}` |
| 无帧运行 | `unavailableRuns` 中的 `{executionGeneration:Seq,reason,evidence}`；reason/evidence 使用 unavailable 回执的同一规则 |

段归属必须与运行账本中的 segmentIds 完整一致，并按其顺序引用；随着段序递增，
所属 executionGeneration 不得倒退。段 binding
与运行一致，只允许 nativeSessionId 从未知补齐。段时间在所属运行和归档内。
文件最多 100000，每个只被索引一次，不允许缺文件或未引用文件。索引按
segmentOrdinal/frameSeq 排序，段内 frameSeq 严格递增但允许跳号；它不是原生
事件序号。首时间等于 Frame.elapsedMs，末时间不早于首时间且不超段 duration。
同段观察区间不重叠，Frame 的 capturedAt 落在段内。

gaps 先列区间，再列边界，两者合计最多 1000。区间按段序与开始时间排序，
彼此及与观察区间均不重叠。边界按运行顺序列出：先该运行内部每对相邻段，
再该运行到下一运行。每个预期边界必须恰好一条；同运行使用相邻段 ID，跨运行
使用前运行末段与后运行首段，无段一端为 null。边界记录不占帧观察区间，
可以与下一段 elapsed=0 的首帧共存，reader 从原运行账本呈现停止与恢复时间。
不能用空 gaps 把恢复或采集重启伪装成连续观察。

unavailableRuns 按运行代次排序，精确覆盖没有任何帧的运行，包括没有段的运行；
有帧运行不得出现在该数组。生产者保留合法零帧原因与证据，不能伪造采集段，
也不能仅由无文件推断 recording_not_enabled。缺证据拒绝 ready 候选，不能由
解析器独自判定实际源是否损坏。全部无帧仍不能生成 archive。
无 gap 为 complete，有 gap 为 partial；不允许仅改 completeness 绕过损坏。
每个 FrameFile.data
重新进行严格 JSON 解码和结构验证，frameSeq 与文件/索引匹配，字节长度与
SHA-256 对原始 data UTF-8 字节验证。

64 MiB 检查原始完整包字节；60 MiB 检查规范 JSON `{files,index}` 的序列化
字节，4 MiB 检查剩余完整规范归档开销。规范化预算使 TS/Go 得到同一计数，
但绝不能用规范化后的包 hash 代替上传原始包 hash。固定 seal 后重试保留原字节。 服务端的占用及传输期限由[共享归档设计](task-session-protocol.md#归档操作占用)定义，不改变这些计量或 hash。

## 状态、回执和摘要

archive_status 的 ready 必须具有 sha256、1..64 MiB 的 byteLength、completeness
和 finalizationId，errorCode 为 null；其他状态正文三字段均 null。unavailable
必须有 finalizationId，errorCode 仅为 `recording_not_enabled|ended_before_first_sample`。
failed 必须有错误；pending 可以携带错误以呈现重试原因。failed 不是允许清理的回执。

receipt payload 字段为 `finalizationId`、`disposition:ready|unavailable`、
`dispositionDigest:Hash`、`reason`、`sha256`、`byteLength`、`completeness`、
`evidence`。ready 要求正文三字段非空，reason/evidence 为 null。unavailable
要求 reason 为上述两种原因，正文三字段为 null，evidence 为：
`{recordingEnabled:boolean,selectedFrameCount:ZeroSeq,registeredFrameCount:ZeroSeq,captureError:ErrorCode|null}`。
两个计数必须为 `"0"`，captureError 必须 null；未启用原因要求 recordingEnabled
为 false，首帧前结束要求 true。服务端还必须从持久责任中核实这些证据，不能
仅接受客户端声明。回执引用 finalizationId，停止账本由最终冻结记录拥有。

`dispositionDigest` 输入是移除 `payload.dispositionDigest` 后的整个 receipt
消息的规范 JSON UTF-8。键递归按字典序排序（本契约键均为 ASCII），数组保持
顺序；安全整数使用十进制；无空白。字符串按 JSON 转义引号、反斜杠和 C0，
使用 `\b/\f/\n/\r/\t` 的短转义，其他 C0 使用小写 `\u00xx`；其他 Unicode
含 U+2028/U+2029 原样输出，不转义 HTML 或 `/`。

正文 hash、每帧 hash 和 dispositionDigest 各自覆盖不同对象。消费外部字节时
必须使用完成完整性验证的 decoder；对象 parser 仅供结构处理，不能作为可信
归档或回执的最终验证。整体包下载还须与服务端可信 receipt 的原始 hash/长度/
完整性及原 fence 比较；自带的 hash 不能证明来源授权。

## 错误与接口验证

有限 ErrorCode 集合为 `permission_denied`、`stale_fence`、`target_changed`、
`lease_expired`、`input_busy`、`automation_suspended`、`unsupported_protocol`、
`unsupported_content_kind`、`input_unknown`、`recording_limit`、`source_corrupt`、
`stop_unknown`、`archive_pending`、`recording_not_enabled`、`ended_before_first_sample`、
`upload_failed`、`invalid_payload`。不可把写入边界后的 unknown 转成发送前拒绝。

TS 公开 `decodeSessionV2Message`、`decodeSessionV2Archive`、
`parseSessionV2Message`、`parseSessionV2Archive`、`verifySessionV2Receipt`、
`verifySessionV2Archive`、`decodeStrictSessionJson`、`canonicalSessionJson`、
`hashSessionBytes`、`selectSessionProtocol`、`assertNativeSessionIdProgression`、
`sessionV2ReceiptDigest`，以及类型与 `SESSION_V2_PROTOCOL`、`SESSION_PROTOCOL_HEADER`、
`SESSION_V2_LIMITS`、`SESSION_V2_KEYS`。解析入口、类型和限额的
实际导出以对应模块为准；调用者不能把内部值 helper 当成完整消息验证。

Go 的补充辅助入口包括 `ControlRequestDigest`、`SourceDigest`、
`EmptySourceDigest`；TS 对应 `controlRequestDigest` 及 `responsibility.ts` 的
`sourceDigest`、`emptySourceDigest`。

Go 通过 `DecodeMessage([]byte) (Message,error)` 与
`DecodeArchive([]byte) (Archive,error)` 完成结构和 hash 校验，`Message.Payload`
使用受限的 payload 类型集合。`SelectProtocol(*string)` 以 nil 表示缺省，非 nil
空字符串拒绝。`CanonicalJSON`、`HashBytes`、`ReceiptDigest` 与
`AssertNativeSessionIDProgression` 提供与 TS 相同的辅助语义。`Envelope`、
`Binding`、`NativePaneID`、`Owner`、`Run`、`StopProof`、`Frame`、`Registration`、
`Snapshot`、`ControlState`、`ControlRequest`、`Operation`、`GenerationLedger`、
`Finalization`、`ArchiveStatus`、`Receipt`、`Archive` 是主要消费者类型。
`Protocol`、`ProtocolHeader` 与 `Max*`/`*Millis` 常量由同一 limits fixture 校验。
公开的辅助构造函数和基本值不能替代整个消息/归档 decoder。
Go 消息与输入操作的序列化拒绝 nil payload，以及外层 type/kind 与具体 payload
类型不一致的组合；这不替代 decoder 对其余字段、引用和完整性的验证。

两种语言对 manifest 中每个原始 fixture 执行对应 decoder。常规 CI 采用仓库标准
CLI 与 Go gate，保留紧凑归档、256 KiB 帧边界、快速数量/字节拒绝以及排序、归属、
完整性和非法终态；既有 v1 fixtures 与 archive 回归保持运行。
完整 100000 帧、60 MiB 录制、64 MiB 归档及其他规模边界由显式本地压力套件构造，
避免提交数十 MiB 文件。仓库根 `pnpm test:stress` 运行 TS 压力套件，
`pnpm server:test:stress` 运行 Go 压力套件；相应配置、构建标签测试入口在 CI 中拒绝。
生产协议限额与完整规模的精确边界断言保持不变。
原生副作用与性能承诺必须由真实隔离运行另行验证。
