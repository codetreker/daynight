# Task Session v2 契约设计

## 模块与责任

[行为要求](../spec/session-v2.md)规定历史录像读取的保证。本设计定义
保留的字节、对象和验证入口。TS 的
[`session/v2/`](../../packages/daynight/src/session/v2/) 是 browser-safe 源码；
Go 的 [`core/session/protocol/v2/`](../../packages/daynight-server/internal/core/session/protocol/v2/)
为独立包。v1 模块保留原类型和解析规则，不通过放宽旧 parser 接收新内容。

TS 的 `strict-json.ts` 拥有通用严格 JSON 解码；`session/v2/values.ts` 提供
版本、限额、基本值、规范序列化和 v2 错误映射。`recording-types.ts` 与
`recording.ts` 拥有归档所需记录、帧及解析，`archive.ts` 拥有归档引用和完整性；
历史播放器只依赖这些纯模块。`types.ts` 与 `protocol.ts` 保留历史归档状态消息的判别与跨字段约束。共享原始字节向量位于
[`fixtures/v2/`](../../packages/daynight/test/session/fixtures/v2/)，由两种语言直接读取。
文件入口和测试清单一起构成可执行交换契约，避免服务端和 Web 使用不同字段。

服务端只向 v2 暴露历史列表、归档状态和正文读取；活动注册、控制、恢复和
归档写入不再接入 HTTP。旧活动消息协议已退役，仅保留已上传录像所需的历史格式。浏览器只在验证过的内容上呈现画面，不把解析成功视为授权。
Go 包提供纯协议选择函数，不自行注册服务端路由。

Web 的 `TerminalRecordingView` 以[公共原生选择组件](native-select.md)的 `filter/content` 呈现本地录制缩放，继续用原受控值改变 `--terminal-text-scale`，不产生控制请求、回执或归档修改。播放器与所在 Session 的全屏根保持同一子树；`useSessionFullscreen` 的共享 React/document 键盘处理器尊重已消费事件与 IME，并在缩放原生 popup 打开时只停止 Escape 传播，保留原生取消和当前全屏。非 popup Escape 沿原退出与回焦点逻辑处理。播放、暂停、时间轴和归档完整性仍由各自原机制拥有。

## 原始 JSON 与基本类型

所有表中字段均必需，包括值为 `null` 的字段。所有对象拒绝未知字段、遗漏字段
和重复的解码后键名（`"a"` 与 `"\u0061"` 是重复键）。入口接受原始 UTF-8
字节或无损字符串，拒绝非法 UTF-8、未配对 surrogate、BOM、尾随值与非 JSON
数字。先 `JSON.parse` 再调用对象 parser 会丢失重复字段证据，不能用于不可信输入。
完整归档原始 UTF-8 最多 64 MiB；嵌套深度最多 64。
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

Go 的协议选择函数对缺省值选择 v1，对精确的 v1/v2 值返回该版本，对其他值报
`unsupported_protocol`。调用者负责区分请求头缺省与显式空字符串。

## 公共对象

`Binding`：`instanceId`、`sessionId`、`workspaceId`、`terminalId` 是 NativeText；
`paneId` 如上；`nativeSessionId` 为 NativeText 或 `null`。这里 `sessionId`
属于 Herdr，外层 Session UUID 与它没有推导关系。比较 binding 必须核对全部字段。
`assertNativeSessionIdProgression` 只允许 `null → null/value` 或 `value → 同值`。

`Owner`：`projectId`、`taskId`、`workerId`、`worktreeId`、`ownerUserId` 为 UUID；
`serverOrigin` 为 Origin；`provider` 为 `codex|claude|copilot`。

`ProcessProof`：`role=shell|agent`、`pid=1..2147483647`、NativeText
`birthToken` 和 `bootId`。`StopProof` 包含 UUID `recordId`、Seq
`executionGeneration`、`binding`、NativeText `bootId`、Time `stoppedAt`、
`method=instances_exited|boot_changed`、`terminalStopped=true`、`processes`。
普通证明的进程至少覆盖一个 shell 和一个 agent，原实例三元组不得重复；其 JSON
不包含 `nativeLaunch` 或 `daemon` 键。

准备证明保留上述共同字段，并包含 `nativeLaunch="not_submitted"` 与
`daemon:{pid,birthToken,bootId}`。`processes` 恰有一个 `role=shell` 的原进程，
daemon 与 shell 使用同一 boot、不同 PID；两种证明分别校验精确键集合。它们是
历史记录的结构事实，不证明当前机器上的原生进程状态。

`Run`：`executionGeneration`、`owner`、`binding`、Time `startedAt`、
Time 或 `null` 的 `stoppedAt`、StopProof 或 `null` 的 `stopProof`、UUID 数组
`segmentIds`。停止时间与证明同时为 null 或同时存在；证明的代次、绑定和时间
必须匹配该运行。归档中的运行均已停止，代次从 1 连续递增，外层代次等于最后一代；
各代 owner 相同、段 ID 全局唯一，已知 nativeSessionId 不可改写。准备证明要求
本代 `segmentIds=[]`，proof 与 run 的 nativeSessionId 完全一致。

## 完整帧

`Frame` 字段是 `frameSeq:Seq`、`capturedAt:Time`、`elapsedMs:ZeroSeq`、
`width/height:Int(1..1000)`、`full:true`、`rows`。rows 数量严格等于 height，
每行是 0..1000 个 `StyledRun`，文本合计最多 16 KiB UTF-8。

`StyledRun` 必须有 `text`、`foreground`、`background`、`bold`、`italic`、
`underline`、`inverse`。颜色为 `null` 或小写 `#rrggbb`；四个样式为 boolean。
文本允许普通 Unicode 和空字符串，但不含 Cc（包括 TAB、换行和 ESC）。换行
由 rows 表示，终端 TAB 由 producer 归一为画面内容。禁止样式之外的附加属性。
归档中 FrameFile.data 的原始 UTF-8 字节也必须不超过 256 KiB，包括其空白与转义。

## 消息外层与 payload

历史 `archive_status` 使用 `daynight.session.v2` envelope，保留原 Session、claim、
执行代次、`herdr/terminal_recording` 类型及状态字段。状态必须符合下述归档
状态约束。注册、控制、输入、恢复和录制写入消息不再由活动协议解析或处理。

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
可以与下一段 elapsed=0 的首帧共存，运行账本保留停止与恢复时间。
不能用空 gaps 把恢复或采集重启伪装成连续观察。

unavailableRuns 按运行代次排序，精确覆盖没有任何帧的运行，包括没有段的运行；
有帧运行不得出现在该数组。合法零帧原因与证据必须保留，不能仅由无文件推断
recording_not_enabled。缺证据的记录不能视为完整归档；解析器不能独自判定实际源
是否损坏。全部无帧的历史结果不包含 archive 正文。
无 gap 为 complete，有 gap 为 partial；不允许仅改 completeness 绕过损坏。
每个 FrameFile.data
重新进行严格 JSON 解码和结构验证，frameSeq 与文件/索引匹配，字节长度与
SHA-256 对原始 data UTF-8 字节验证。

64 MiB 检查原始完整包字节；60 MiB 检查规范 JSON `{files,index}` 的序列化
字节，4 MiB 检查剩余完整规范归档开销。规范化预算使 TS/Go 得到同一计数，
但绝不能用规范化后的包 hash 代替上传原始包 hash。已上传的归档保留原字节。服务端的占用及传输期限由[共享归档设计](task-session-protocol.md#归档操作占用)定义，不改变这些计量或 hash。

## 状态、回执和摘要

archive_status 的 ready 必须具有 sha256、1..64 MiB 的 byteLength、completeness
和 finalizationId，errorCode 为 null；其他状态正文三字段均 null。unavailable
必须有 finalizationId，errorCode 仅为 `recording_not_enabled|ended_before_first_sample`。
failed 必须有错误；pending 可以携带错误以呈现重试原因。failed 不提供可播放正文。

历史无帧运行的 evidence 为
`{recordingEnabled:boolean,selectedFrameCount:ZeroSeq,registeredFrameCount:ZeroSeq,captureError:ErrorCode|null}`。
两个计数必须为 `"0"`，captureError 必须为 null；未启用原因要求 recordingEnabled
为 false，首帧前结束要求 true。保存的 receipt 与录制责任是原历史事实；服务端读取
ready 正文时核对记录的运行、已关闭责任、帧计数与来源摘要。

正文 hash 覆盖原始归档字节，每帧 hash 覆盖原始 FrameFile.data 的 UTF-8 字节。
`SourceDigest` 使用规范 JSON 的 `{files,index}`，按运行选择其段对应的条目；它与
原始正文 hash 含义不同。规范化时键递归按字典序排序，数组保持顺序，安全整数
使用十进制，无空白。字符串按 JSON 转义引号、反斜杠和 C0，使用 `\b/\f/\n/\r/\t`
短转义，其他 C0 使用小写 `\u00xx`；其他 Unicode 含 U+2028/U+2029 原样输出。

消费外部字节时须使用完整性验证的 decoder；对象 parser 仅供结构处理。服务端
核对原有记录和正文，浏览器再将正文原始 hash、长度、完整性及原身份与状态和
历史项比较。解析或自带 hash 不证明来源授权。

## 错误与接口验证

TS 的状态及归档解析器、Go 的历史归档解析器与共享 fixture 验证保留的格式。
归档读取验证原始字节、引用、长度和哈希，并由服务端另行核验访问权限和原身份。
常规测试覆盖结构、边界及错误；规模压力测试使用独立入口，不进入常规 CI。
