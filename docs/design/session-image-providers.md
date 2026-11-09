# Session 图片原生 Provider 设计（待实现）

本文定义 Codex、Claude Code、Copilot 的图片输入、接受证据、原生图片投影和有界历史读取。设计已确定；本文的发布不表示图片适配、原生模型识图或平台验收已经完成。图片输入要求由[输入与草稿规格](../spec/session-image-input.md)拥有，显示与保存要求由[历史规格](../spec/session-image-history.md)拥有，验收证据由[验收规格](../spec/session-image-acceptance.md)拥有。

[协议与存储设计](session-image-contracts.md)是 `sendInput`、能力、operation、occurrence、capture、错误、预算和字节存储的唯一公共定义。Provider 只实现各自原生编码器、强关联证据和来源投影，不另建上传协议、数据库或预览接口。本地及外部来源使用[来源采集设计](session-image-sources.md)，展示使用[浏览器设计](session-image-browser.md)，封存与恢复使用[归档设计](session-image-archives.md)。[决策记录](../../.agents/notes/implemented/architecture/2026-11-05-session-image-providers.md)保留备选与维护代价。

## 原生事实与版本资格

以下固定资料解释设计选择，不是运行中的版本声明或最低支持版本。发布 profile 必须绑定实际 executable、SDK、backend、精确模型、原生 payload/receipt/history 与平台证据，不能仅按版本字符串或一次识图成功开放支持。

| 来源 | 影响设计的原生事实 |
| --- | --- |
| Codex [UserInput](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/app-server-protocol/schema/typescript/v2/UserInput.ts)、[turn processor](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/app-server/src/request_processors/turn_processor.rs)、[history](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/app-server-protocol/src/protocol/thread_history.rs) | `localImage/path` 与 `image/url` 是原生图片类型；HTTP(S) 不是合法输入 URL。`clientUserMessageId` 提供关联，未提供重复 start/steer 的幂等保证；旧历史重建可能改变 item ID 或按类型分组。 |
| Claude Agent SDK `0.3.247` 的类型及 Daynight [Claude adapter](https://github.com/codetreker/daynight/blob/7fe4684b83d4d850f3b2dc6e7772392f75b175ef/packages/daynight/src/commands/controller/providers/claude.ts)、[controls](https://github.com/codetreker/daynight/blob/7fe4684b83d4d850f3b2dc6e7772392f75b175ef/packages/daynight/src/commands/controller/providers/controls-claude.ts) | `SDKUserMessage.message` 可包含 image source；模型目录本身不提供足够的 vision 证明。`user_message_uuid` 可表达输入关联，但不同生产者、hook 和终态的投递含义必须分别验证。SDK 历史 offset/limit 在完整读取和建链后切片，不能作为内存上限。 |
| Copilot SDK `1.0.11` [session](https://github.com/github/copilot-sdk/blob/a550258d5c37bd662197536992a23d633bfe5804/nodejs/src/session.ts)、[types](https://github.com/github/copilot-sdk/blob/a550258d5c37bd662197536992a23d633bfe5804/nodejs/src/types.ts)、[events](https://github.com/github/copilot-sdk/blob/a550258d5c37bd662197536992a23d633bfe5804/nodejs/src/generated/session-events.ts)、[image input](https://github.com/github/copilot-sdk/blob/a550258d5c37bd662197536992a23d633bfe5804/docs/features/image-input.md) | 支持 blob attachments，send 返回 messageId，但未承诺它等于 user event.id。模型目录给出 vision 和限制；原生处理可缩放或省略图片，发送成功与每图模型消费是不同证据。`getEvents` 全量读取不能承担大图历史。 |

Daynight 的源码定位基线为 `7fe4684b83d4d850f3b2dc6e7772392f75b175ef`。对应[公共 Provider 接口](https://github.com/codetreker/daynight/blob/7fe4684b83d4d850f3b2dc6e7772392f75b175ef/packages/daynight/src/commands/controller/providers/types.ts)和[Controller runtime](https://github.com/codetreker/daynight/blob/7fe4684b83d4d850f3b2dc6e7772392f75b175ef/packages/daynight/src/commands/controller/runtime.ts)仍需图片接线；实现时应保留实际主线的错误分类、角色说明、子 Agent、控制、恢复和历史行为。

## 三者共同的发送屏障

输入只有可选的一个非空白文字块和其后的有序图片，不增加任意图文交错编辑。三者均须满足同一顺序：服务对原 actor、target、能力 revision、完整图片集合和元数据预算授权；Controller 再核对 providerRevision、当前回合、设置与权限；整组 `acquireInput`；持久原 intent 及 operation/native pin；`markDispatching`；唯一一次原生调用。一个图片准备失败就整条拒绝，不能只发剩余图或文字。设置与最终检查到原生调用之间互斥，异步准备后必须重新检查。

图片的上传完成、SDK 消费输入、本地回显、同文字/图片摘要、当前恰有一个回合都不是接受证据。派发后超时、断线、坏回执或不能证明未接受的 SDK 异常维持 unknown；只查询原 operation，不重放原生调用。原生明确未接纳的 profile 错误要与“从未调用”分开持久化，不能把所有 rejected/failed 当作零调用。恢复只结算原 target/draftId/revision，旧回执不得清除后继草稿或升级旧上传资格。

接受证明也不等于模型已读每张图。若原生接受后出现明确部分附件交付失败，原 operation、消息、原件和失败原因均持久可回看，同时关闭有问题的 profile。不得撤回接受事实、只弹 toast、伪装普通未派发拒绝或自动重发。

能力取原生 profile 与完整上传、解码、保存、历史读取、归档及策略能力的交集。输入为 PNG/JPEG/WebP，通用上限为 8 图、每图 10485760 bytes、消息图片合计 20971520 bytes；原生有更小的明确限制时取交集。send 与 steer 分别报告 supported/unsupported/unknown，未知不猜支持，文字能力独立。

公共 `geometry` 和 `frameCount` 只由协议设计定义。Provider 将模型、backend、累计原生历史与工具图片上下文条件归约为当前固定宽高、像素、帧数上限；不能拿本条 8 图代替累计上下文。上下文不可见时使用已证明覆盖全部可达分支的最严格包络，否则 unknown。存储画布宽高不交换 EXIF 方向；涉及显示方向的 profile 先归约成两种方向均安全的固定上限。模型、权限、原生绑定或限制变化推进持久 providerRevision，无变化复核不推进。

原生原件只能从公共存储的受控 lease 取得。当前 Controller 读取服务原件时，必须受同代次 `operation_authorized` 的原 actor、完整有序 intent、有效发送 pin 和每块授权约束；不能借浏览器 token、枚举历史或修复旧代次任意 native 路径。服务历史可读与 native resume 文件存在分别报告。

## Codex

### 能力、编码与接受

当前精确模型必须在完整 `model/list` 分页结果中得到可靠映射，并明确 `inputModalities` 含 image；`imageGeneration` 是输出能力。缺字段、模型未知、设置未确认或版本 profile 不匹配时禁图片。steer 按当前回合的已确认模型判断，不能沿用未来默认模型；二者无法同时准确表达时 steer=unknown。

原生数组保持顺序：可选 `{type:"text",text,text_elements:[]}` 后接 `{type:"localImage",path}`。path 仅来自稳定私有文件，纯图片省略文字块，不添加提示词、文件名、Markdown 或空 TextPart；detail 沿原生缺省。不以 data URL 或远程 URL 作隐式 fallback。

空闲使用 `turn/start`，原 operationId 放入 `clientUserMessageId`；活动回合仅在图片 steer 已证明时使用 `turn/steer` 和精确 `expectedTurnId`。过期 steer 不改成 start，不新增队列，不自动取消回合。start 内部可能进入 start-or-steer 路径，外部并发造成返回与预期不符时保留 unknown，不能只凭方法名推定新回合。

| 观察 | 判定 |
| --- | --- |
| 原请求的 start response 含合法 turn.id；或 steer response.turnId 精确等于 expectedTurnId | 校验 thread/请求对应后持久 started/queued 回执。queued 只描述原生当前回合接纳；快速完成不把状态改回 working。 |
| 同 native thread 的 userMessage.clientId 与持久 operation 精确匹配，有序内容符合原 intent 的已知原生编码 | 先持久 canonical entry、别名和图片关联，再以 `onInputObserved` 提升原 dispatching/unknown 为 provider_accepted；不覆盖既有终态。 |
| 只有 turn/started、本地消息、同 hash/文字 | 不确认输入。确定原生未接纳按 profile 拒绝；写入后无法判断的失败仍 unknown。 |

`clientUserMessageId` 是关联 ID，不是幂等键。localImage 可能被原生延迟读取或转为错误占位，native/resume pin 必须保留至所属 native Session 明确删除，不能在回执、回合结束、进程停止或归档后释放。调用前校验稳定文件权限和摘要；后续外部删除或磁盘损坏如实显示原生错误，原上传历史仍可读，不用重发修复。

### 投影与历史身份

live、final、原生恢复和分页共用一个 normalizer。稳定原生 item 沿用 `nativeEntryId`；自有输入以原 operation 建立 canonical entry，live item ID 和恢复的 item-N 都是其可信别名。校验相同 native Session、intent、回合和目标链，不按内容或摘要合并。无可信关联的旧重建 ID 保留缺失说明和已有服务历史，不随机生成“原图片”。原生已按类型分组的旧内容按实际顺序展示，不声称恢复了未保存的交错信息。

sourceKey 来自版本化的原生位置 tuple，包含 canonical item/operation、container、callId、原生 part ID 或源数组索引；不含 URL、path 或 bytes。文字 delta 只更新文字槽，异步图片保持 entry/imageId 和工具状态，已终结工具不被迟到 start 改回 running。

| 原生形态 | 来源与所属 |
| --- | --- |
| userMessage.content 的 text/localImage/image | 保留顺序。自有操作关联原件；外来 localImage 交安全本地读取，data URL 交 inline 解码，历史 HTTP(S) 交外部采集。 |
| agentMessage.text | 保持文字，真实 Markdown 图片交 AST 管道，不猜 Base64 或 image 字段。 |
| imageView.path | 保留原工具及 callId，通过授权来源读取；绝对路径不自动扩大根。 |
| imageGeneration | 保留 status/failure。completed 且无 failure 时，文档化裸 Base64 PNG result 为权威 bytes，savedPath 为同出现备选；有效 result 不依赖路径。按路径恢复已知 result 必须比对原摘要，只有路径的已支持 profile 可首次采集，但不能伪称恢复旧摘要。in_progress 空 result 不误报失败，失败工具不因残留 bytes 变成功。 |
| mcpToolCall.result.content | 按序处理 text、image(data/mimeType)、嵌入 resource.blob；无 blob 则不可用。resource_link 仅在已定义来源内处理，不新增 MCP resource/read；不递归猜 structuredContent。 |
| dynamicToolCall.contentItems | inputText 与 inputImage.imageUrl 按序；data URL 解码，HTTP(S) 交来源管道；保留 success/status/callId。 |
| functionCallOutput.output | 文本或 input_text/input_image 数组按序。没有原 call_id 时以输出 item 作为独立工具容器，保留来源说明；不把 id 或邻近工具当原调用。 |

工具失败与有效诊断图可读性独立。未知/HTML/SVG/音频不当图片执行，诊断仅保安全类型和摘要；Base64、私有 path、凭据 URL 不进入 timeline、错误或 readable(JSON)。

恢复验证原 thread ID/cwd，使用 `thread/resume(excludeTurns:true)` 和 `thread/items/list`，升序、limit=1、一页在途，保留外层 turnId。cursor 防循环，页关联持久后才推进 checkpoint。重读页不重放 start/steer，不重建 native Session。已 committed 图优先读服务原件，原生路径变化不能改写历史。

### 有界原生接收

Codex 使用私有流式 RPC/JSON 接收器，保留 request/notify/respond/reject/dispose 和现有错误分类；不修改另两个 Provider 的通用 NativeRpc 行为。不能仅增大原 16 MiB 整行阈值，因为 readline 在检查前已经聚合完整行。

解析器跨 chunk 校验 UTF-8、JSON token/escape，仅对明确 schema 的媒体字符串建立候选暂存槽。字段顺序任意，type/id 晚于 bytes 时先暂存不可执行 wire bytes，完整帧、来源和身份通过后才能使用；不能正则替换 JSON。该暂存仅消费已连接原生进程主动发来的 bytes，不抓 URL 或读 path，仍计入公共 2200 MiB/execution、8 GiB 和空闲水位。

| 对象 | 上限与处理 |
| --- | --- |
| byte buffer / 单图 | 64 KiB / 10 MiB；逐字符串 Base64 解码。超单图保留原位置错误并有界排空。 |
| wire 暂存 | 每帧 96 MiB、1000 槽；至多两个完成帧合计 192 MiB，仍受实际磁盘准入限制。输出不套用输入 8 图/20 MiB 限制。 |
| metadata / 结构 | 每帧 16 MiB、深度 64、100000 tokens。已知文字沿原文字截断并标识，不能截断 JSON 后 parse。 |
| 整帧 | 总输入 128 MiB、绝对解析期限 30 秒。超限关闭该私有连接，未决操作 unknown；已保存历史保留。 |

完成队列最多两帧，stdout 背压。RPC 回执分发不等待服务 capture 网络；暂存不足的图可保留容量错误，不能拖死控制消息。自有回显若已可信关联原件，可验证格式/摘要后丢弃冗余 inline bytes。只读重取工具图片绑定已知 item/turn 和待采 part 索引，避免已采图占满暂存；没有可信身份的实时帧按其准入结果处理，绝不重新执行工具。未通过完整帧验证的文件不能关联消息；释放须等 reader/writer 停止及实际 unlink。

## Claude Code

### 能力和完整输入

兼容 profile 绑定实际 SDK/executable、backend、已确认 effective model、输入及接受事件、历史 schema。保留原生选择值 `default`，另存实际 resolved model；未知 backend、default 未解析、设置超时或 profile 不匹配时图片 unknown，不能隐式发一轮探测。图片 steer 固定 unsupported；文本 steer 保持原有能力，图片不入队、不 interrupt。

原生限制单位必须明确；编码上限 L 按 `4 * ceil(rawBytes / 3) <= L` 换算，不把 5 MB 编码额度当 5 MiB 文件。请求整体还受历史、工具和文字影响。累计上下文超过某阈值的几何限制必须纳入公共 geometry，不能以单条图数或普通 decoder 的 16384 上限代替 backend profile。

每条输入构造一个 `SDKUserMessage`：`type:"user"`、`uuid:operationId`、`session_id:nativeInputSessionId`、`parent_tool_use_id:null`，`message.role:"user"`；content 为可选 text 后接有序 `{type:"image",source:{type:"base64",media_type,data}}`。不发 path、data URL、Markdown、upload receipt 或 `shouldQuery:false`。公共存储 lease 逐张读取受控 regular file，再核长度、SHA、MIME；标准 Base64 有 padding、无换行。全部构造成功后只 push 一次，input 对象此后不可变。

合法首次 null target 由唯一初始 operation 持久占用 candidate native ID。若模型/backend 可在首发前可靠确认，可用同 candidate 发纯图；不额外发文字来取得 identity。身份绑定必须来自同受信通道、原首发相关且 profile 允许的根事件，session_id 精确等于 candidate；绑定不等于接受。若能力必须首发才能知道，则维持 unknown。错 ID 已 push 时仍 unknown，未 push 才能确定拒绝；其他 null 上传不会自动升级。

### 强关联接受 matcher

含图 matcher 与文本兼容 waiter 分开。先校验同 execution/nativeSession、根会话、无子代理 parent、原 UUID、原 intent 及 dispatching/unknown。SDK iterable 消费、本地 projection、imageId 和同 bytes 不进入接受判断。

| 原生观察 | 结论 |
| --- | --- |
| 根 user echo/replay 或可信历史 user，uuid 精确匹配且内容不是 tool_result/meta/synthetic/shouldQuery:false | 仅记录 materialized。只有 profile 证明记录发生在阻止 hook 和投递拒绝之后，或有同输入执行证据，才升级接受；纯图不要求 text。 |
| 根 assistant 或非 ping partial event，user_message_uuid 精确匹配，profile 证明投递含义 | 可确认 provider_accepted；先确认 native identity，不接受任意 message_start 或子代理事件。 |
| 根 command_lifecycle started，command_uuid 精确匹配且协商 profile 已验证 | 可确认开始；queued 不新增图片队列。 |
| 根 success result 精确关联且 profile 证明实际回合执行 | 可补结算；hook-blocked success/num_turns=0、仅追加或空终态均不是正例。 |
| error、cancelled、delivery failure | 已开始后的失败不撤销接受；只有原生证明确定未投递才能拒绝，其他 unknown。 |

历史 user 落盘不能单独证明通过 UserPromptSubmit hook 或执行。历史缺 user_message_uuid 时只可用已验证 schema 的 parentUuid 执行链补强，不按“下一条 assistant”猜测。matcher 先持久关联再通知 runtime，重复证据幂等，不覆盖其他操作。空历史、取消或查不到记录都不证明未派发。

### 图片投影和 transcript 恢复

live、final 和历史用同一 normalizer，先识别图片/工具再做文字转换。自有输入保持原 image/resource；其他 user 以 transcript uuid+block index 为来源，没有 UUID 时用已登记文件身份/记录偏移/摘要作私有键，这种 fallback 不作为输入接受证据。assistant 使用 message.id+native block index；final-only 的拆分 sibling 必须从完整所选 chain 计算并持久块顺序，不能每页重置 ordinal。工具结果保留 tool_use_id 和内嵌 index；子代理仅消费根会话已暴露且父工具关系授权的内容，不遍历其他 transcript。

正文块和图片位置先持久、按原次序发表，text A/image B/text C 的 B 不等待采集结束才排到 C 后。resource 槽未取得时用同 imageId 的未采集表示，不能虚构 resourceId。原生 materialized 用户历史可保存，但不结算 unknown，也不把草稿乐观条目当正式归档消息。

base64 image source、tool_result 的有序 text/image 和明确 native URL/path 分别走公共 capture、外部及本地采集；tool `is_error` 保留。展示接受五格式，不能因输入三格式删 GIF/AVIF。缺 bytes/坏源同位置不可用，已有 committed 图不再访问原源。

新增只读 transcript helper，不用 getSessionMessages 的全量数组或 execFile 全量 JSON。SessionStart transcript_path 只是线索，须核 native ID、cwd、配置 home、文件身份；旧布局只在当前已授权 home 内按固定 resolver 精确查找，未知布局失败，不跨账户搜索。授权 FD 固定快照的身份、初始长度、完整行边界和前缀摘要。

第一遍增量 tokenizer 扫描 JSONL，媒体按 token 跳过并记录 offset；受限磁盘索引保存 uuid/parentUuid/message.id/block、tool、sidechain/meta 与 compaction 字段。按真实 parent chain、preservedMessages/preservedSegment、父链重写及 sibling/tool_result 选可见分支，不以物理行序当最终对话。helper 只输出元数据，由 Controller 唯一 journal writer 提交：每页最多 100 条、序列化最多 1 MiB，ACK 后下一页。

第二遍只读取所选出现，register 后逐块解码其媒体到已预留 staging。单行或总历史大于旧 32 MiB 不是失败理由；超单图 10 MiB 有界跳过并保留位置，不吞同行文字。结构深度 64，身份沿公共上限，文字沿既有截断规则。末尾未完成行等待后续扫描；截断、替换、前缀变化或父链缺口停止新导入且保留旧图。cursor 绑定快照/chain/表示/historyEpoch；append 验证连续前缀，不重建身份。helper 不 query/send、不恢复或修改原生会话。

### 内存与保留

20 MiB/8 图的 Base64 最多 27,962,048 ASCII 字符。只允许一个含图 send 在途、一个不超过 10 MiB 的原图 Buffer，不建立编码待发队列，matcher 不复制 payload。Claude 媒体适配额外 RSS 预算目标为 512 MiB，包含 SDK 宿主、history helper、Buffer/native allocations；Node heap 不是内存硬隔离。

若 SDK 主宿主无法给出有限输出分配界限，query/JSON 解析进入受限私有 helper，控制和媒体分通道并保持原 controls/cancel/respond/onSpawn 及进程树归属。无法验证内存、控制优先级或回收则 component_unsupported，不能重启已有用户会话来满足预算。

native/resume pin 默认保留到原生 Session 删除。仅 profile 已证明 SDK 获得独立完整 bytes、持久历史不依赖 localPath 且无活跃读者时，才接受私有“不再依赖文件”释放证据；accepted/回合结束本身不够。unknown、消息和归档引用独立保留。

## Copilot

### 当前模型与 blob 输入

`model.getCurrent` 的精确 modelId 必须在完整目录中唯一对应，`supports.vision === true`，MIME、`max_prompt_image_size`（bytes）、`max_prompt_images`（张数）均合法；缺项、重复、非布尔、非法限额为 unknown。明确 vision=false 或 MIME 交集为空为 unsupported。动态限制与公共 geometry 同时有效，不以模型名称猜测。

model/effort/permission 变更发起后暂停图片资格，deferred、超时或尚未 readback 时不沿旧模型发图；实际应用、runtimeSettingsChanged 和恢复后重新核对，最终检查与 SDK send 互斥。初始化 native ID 尚未建立时 unknown，不为图片另建 Session。

纯图使用 `prompt:""`，图文使用原文字；attachments 按原序为 `{type:"blob",data,mimeType,displayName?}`，`mode:"immediate"`。安全 displayName 来自资源元数据或生成名，不能从私有路径取名或夹带 operationId。全部图读取和编码成功后才调用一次 send，不送 assetId、path、headers 或 Markdown。活动回合 immediate 只有在版本 profile 证明同回合接收全部图、无 enqueue/隐式取消时开放 steer，否则等待 idle。

### 接受与 public-first 关联

原 operation journal 保存 nativeSessionId、intent、有序 image/resource、dispatch 状态、原 send Promise 的 messageId 及 user event 关联。只有原 Promise 返回非空 messageId，并将证据持久成功，才返回 started（idle）或 handled（已验证 steer）；不返回 queued。

SDK 未保证 messageId 等于 user.message.id。运行时只在同 native Session、主 Agent、正确内容形态且二者确实精确相等时建立 alias；其他显式关联字段须有独立 profile。profile 验证必须包含纯图、图文、多图、连续相同文字操作。身份不匹配关闭新图片资格，保留已接受事实，不用 prompt/hash/时间/唯一在途猜关联。

| 首次公开和回执顺序 | 原子关联规则 |
| --- | --- |
| 回执已知，event 精确对应，图槽尚未公开 | 公开原上传 imageId/resourceId，复用原件。 |
| send 超时且无可信 ID | 原生 event 作为独立事实公开，分配其 occurrence/capture；原 operation 仍 unknown，不能长期阻塞其他消息。 |
| 原生槽已公开，原 Promise 迟到返回且精确匹配 | 原槽位、原生 bytes 和顺序不变；持久 provenance，在同 entry 末尾追加有序“原上传图片”槽，用原 image/resource；既有槽标“原生记录图片”。 |
| 同迟到证据重放 | operation+原 imageId 唯一键复用同附加槽，不重复追加；alias、引用和单调 entry revision 同事务。 |

少数迟到情况显示两种真实来源，即使同摘要也不能改绑已公开身份。原接纳时须按每图最坏双槽预留新 timeline/旧 schema1 两份元数据空间，正常早回执释放余量；不能等迟到后因历史已满丢原图。原生 capture 另按资源预算准入，不足时原生槽不可用，已保存原上传图仍可在可信迟到关联后读取。

原 send 的响应丢失、空 ID、传输错误、接受证据提交未知均保持 unknown，只查询原操作。`omittedReason` 仅表示历史 bytes 缺失，不自动证明模型未收到；真正部分交付失败按共同规则持久可见并关闭 profile。blob 不传 native 路径，但只有 SDK 读取/序列化结束且无读者的证据才能释放调用 pin；unknown 与服务历史 pin 独立。

### 原生来源与分页

sourceKey 绑定 nativeSessionId、owner/parentToolCallId、event.id 或工具完成事件、字段路径与块索引。binary_asset 只建立同 Session 私有字节字典，不自动成为助手消息；assetId 的 `sha256:` 形式核验摘要，同 ID 异 bytes 冲突。未引用 asset 暂存也计公共预算，不用无界 Map。

user attachments 的 blob.data、已观察同 Session asset 引用、可信 file image 来源分别处理；没有公开 asset 下载 API 时不能伪造请求。工具 contents 是主显示序列，text/image/resource.blob 保留交错；content/detailedContent 只补充未表达文字。binaryResultsForLlm 是模型侧补充，仅同 assetId、同工具、同结果的显式镜像关系复用同出现，其他保留独立来源槽。structuredContent 不递归猜图片。tool 状态、agentId 与 parentToolCallId 不因图片异步完成改变。

引用先到保留 pending，bytes 后到沿原 imageId 完成；流与历史都完成仍无 bytes 时明确缺失。捕获 unknown 先协调，不能为赶归档直接降为 partial。五种显示格式、MIME、Base64、长度、摘要与完整解码均验证；原生 profile 允许的无 padding Base64 可在边界规范化，公共块仍须规范 padding。

图片模式用 `rpc.eventLog.read`、max=1、includeEphemeral=false、持久 cursor；保留控制、交互、回合与工具事件，不只过滤图片。事件暂存和 occurrence intent 持久后推进 cursor，网络 commit 可继续协调。live/history 按 event ID 去重，revision 单调；cursor expired 从原历史起点重扫映射，不重发 send。durable 过载从最近确认 cursor 回填，只保存有界重读标记；ephemeral 无法重读，未保存须明确不可用。

### 单连接 SDK bridge

图片模式固定使用独立 bridge 承载同 runtime 的唯一 SDK 连接，controls、interaction、send、history 和订阅全部经此连接；不另建 native Session。Controller 仍负责 runtime 身份和真实停止证明。

原生 loopback 连接前使用有界 Content-Length JSON-RPC 帧代理：头部最多 8192 bytes，body 最多 134217728 bytes，每方向最多一帧待转发、两个 512 KiB 转发缓冲，30 秒无进展超时。规范非负十进制长度、重复/冲突长度或坏 framing 拒绝；不改 body/ID，token 只经私有 IPC。超限关闭该连接，未决操作 unknown，不丢半帧继续解析。

SDK 仍会在 bridge 全量解析一帧，故 RSS 监管阈值 1536 MiB、Node heap 上限 512 MiB；需记录实际 Buffer/native allocation 峰值、采样和超额，不能把监控称硬界限。一个 send、一个 history page 在途；媒体队列只存有界描述。无法验证隔离/回收时禁图片模式。

Controller↔bridge 元数据帧最多 1 MiB；合法较大控制目录按 requestId/binding/revision/总长度及 SHA/连续 offset 分片并在既有总容量内完整重组，不能截断 500 项以内的合法目录。图片逐张按 512 KiB、最多两块流入公共存储，反向只传可信路径句柄及摘要/长度。40 MiB 是待暂存原图驻留预算，不是事件图总量限制；例如 5×9 MiB 工具图应逐张保存，不能因总量大于 40 MiB 丢整组。整个 SDK 事件首次分配仍由 frame/bridge 预算承担。

bridge 失败只暂停媒体并留下当前连接未知；是否恢复/停止遵守原 lifecycle，不自动新建 Session 或重发图片/审批响应。服务已有正文、原件和归档继续可读。

## 来源提交、平台与验证

三者全部来源遵守同一两阶段次序：Controller 先持久 entry/出现位置，经原 timeline/source outbox 得到覆盖该位置的服务 ACK，再 `image_capture register` 原子登记来源映射并预留。收到 reserved 才读源；未知只 query 原 captureId。自有输入回显同样在位置 ACK 后以 resource locator register，已 available 同 Session 原件直接 committed，只增加出现引用和可信 nativeSource，不复制 blob、不重计资源槽，也不凭此确认输入。

canonical aliases 只由可信 native ID 关联事务添加，不能用 hash 猜并。已 committed 永远读服务原件，格式错误、源消失、权限变化保留原位置与安全错误。结束时停止新源 IO，结算原捕获；unknown 或已保存 bytes 损坏不能伪装“从未采集”。

Windows、macOS、Linux 分别验证原生 adapter、helper/bridge 进程树与资源回收，native 进程峰值和 Controller/SDK 宿主峰值分开记录。没有真实模型输出的特定助手图片形态可标 native_not_produced；三个 Provider 的纯图及图文输入不能据此豁免。

必须验证：各 Provider 实际原生 payload 的类型/顺序/bytes、唯一调用数、精确接受关联、第二图失败零调用、回执丢失和迟到、模型与权限变化、重复同图与乱序历史、工具归属、合法边界和恶意大帧、控制不饿死、源变化后的原摘要、Controller 离线的归档读取及旧文本兼容。受控 SDK/RPC 证明本地调用和状态处理，真实 profile 证明原生接受与模型视觉消费；二者不能互相替代。
