# Session 图片原生 Provider 设计

当前图片设计与验收范围为 Codex、Copilot。本文同时保留已实现 Claude Code 适配的兼容与拒绝语义；它不属于当前图片交付目标，未知图片资格和本地来源权限继续拒绝。三个既有适配器的文字和图片共用结构化 `send` 入口，分别通过原生编码器、证据 matcher 和有界读取器接入公共存储。运行时只对证据完整的 executable、SDK、backend 和模型组合开放图片资格；本地实现和受控回归不表示真实模型识图或平台验收已经完成。图片输入要求由[输入与草稿规格](../spec/session-image-input.md)拥有，显示与保存要求由[历史规格](../spec/session-image-history.md)拥有，验收证据由[验收规格](../spec/session-image-acceptance.md)拥有。

[协议与存储设计](session-image-contracts.md)是 `send`、能力、operation、occurrence、capture、错误、预算和字节存储的唯一公共定义。Provider 只实现各自原生编码器、强关联证据和来源投影，不另建上传协议、数据库或预览接口。本地及外部来源使用[来源采集设计](session-image-sources.md)，展示使用[浏览器设计](session-image-browser.md)，封存与恢复使用[归档设计](session-image-archives.md)。[决策记录](../../.agents/notes/implemented/architecture/2026-11-05-session-image-providers.md)保留备选与维护代价。

## 原生事实与版本资格

以下固定资料解释设计选择，不是运行中的版本声明或最低支持版本。发布 profile 必须绑定实际 executable、SDK、backend、精确模型、平台、send/steer、原始输入限制和适用条件，并关联原生 payload/receipt/history 与视觉证据，不能仅按版本字符串或一次识图成功开放支持。资格是对明确组合的发布判断，不宣称证明全部不可观测内部算法；当前生产资格目录为空，未匹配组合继续关闭。[资格边界决策](../../.agents/notes/implemented/architecture/2026-11-16-image-qualification-boundaries.md)解释原件责任和局部发布的取舍。

[资格目录与选择器](../../packages/daynight/src/commands/controller/providers/image-qualification.ts)以 `ImageRuntimeIdentity` 记录 provider、nativeVersion、nativeExecutableSha256、sdkVersion、platform、arch、backendIdentity 和 modelId。nativeExecutableSha256 绑定实际可执行文件字节摘要，版本字符串不能代替。backendIdentity 按对应 Provider 机制编码可观测身份并取 SHA256，公共值不保存地址或凭据，也不把 Provider 别名本身当作充分身份；其证据范围受下文观察机制限制；Codex app-server 的 sdkVersion=null 表示不使用 SDK，Copilot 的缺失 SDK 版本则是未知。`ImageQualification` 在同一精确身份上保存 evidenceId、evidenceSha256、独立 send/steer 开关、MIME、单图/整条字节、图数及原始输入 geometry。证据文档拥有适用条件及原生处理观察，不增加未经验证的默认支持。

只有完整运行时身份唯一匹配合法目录项时，`selectImageQualification` 才返回冻结的 `QualifiedImages` 和该完整资格记录的 fingerprint；缺项、歧义或非法证据拒绝。Codex 和 Copilot 可使用下文各自限定的程序与原生声明配置观察，但观察本身不建立资格。不能从版本字符串、modelProvider 或 SDK 版本猜测身份，当前空目录使协议兼容的组合也保持 unknown。数值能力对象以私有 WeakMap 绑定 fingerprint，不扩展公共 DTO。journal 将 `provider_images_qualification` 与 Provider 能力同事务持久化；证据变化即使不改变数值上限，也推进 providerRevision。原授权保留该绑定，native 最终派发比较当前资格，不能在同一数值能力下沿用另一份证据。

| 来源 | 影响设计的原生事实 |
| --- | --- |
| Codex [UserInput](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/app-server-protocol/schema/typescript/v2/UserInput.ts)、[turn processor](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/app-server/src/request_processors/turn_processor.rs)、[history](https://github.com/openai/codex/blob/8ff74cc9b11ac54c4c4446ef60a87b49ae657a1f/codex-rs/app-server-protocol/src/protocol/thread_history.rs) | `localImage/path` 与 `image/url` 是原生图片类型；HTTP(S) 不是合法输入 URL。`clientUserMessageId` 提供关联，未提供重复 start/steer 的幂等保证；旧历史重建可能改变 item ID 或按类型分组。 |
| Claude Agent SDK `0.3.247` 的类型及 Daynight [Claude adapter](https://github.com/codetreker/daynight/blob/7fe4684b83d4d850f3b2dc6e7772392f75b175ef/packages/daynight/src/commands/controller/providers/claude.ts)、[controls](https://github.com/codetreker/daynight/blob/7fe4684b83d4d850f3b2dc6e7772392f75b175ef/packages/daynight/src/commands/controller/providers/controls-claude.ts) | `SDKUserMessage.message` 可包含 image source；模型目录本身不提供足够的 vision 证明。`user_message_uuid` 可表达输入关联，但不同生产者、hook 和终态的投递含义必须分别验证。SDK 历史 offset/limit 在完整读取和建链后切片，不能作为内存上限。 |
| Copilot SDK `1.0.11` [session](https://github.com/github/copilot-sdk/blob/a550258d5c37bd662197536992a23d633bfe5804/nodejs/src/session.ts)、[types](https://github.com/github/copilot-sdk/blob/a550258d5c37bd662197536992a23d633bfe5804/nodejs/src/types.ts)、[events](https://github.com/github/copilot-sdk/blob/a550258d5c37bd662197536992a23d633bfe5804/nodejs/src/generated/session-events.ts)、[image input](https://github.com/github/copilot-sdk/blob/a550258d5c37bd662197536992a23d633bfe5804/docs/features/image-input.md) | 支持 blob attachments，send 返回 messageId，但未承诺它等于 user event.id。模型目录给出 vision 和限制；原生处理可缩放或省略图片，发送成功与每图模型消费是不同证据。`getEvents` 全量读取不能承担大图历史。 |

设计形成时的 Daynight 源码定位基线为 `7fe4684b83d4d850f3b2dc6e7772392f75b175ef`，当时的 Provider 接口和 Controller runtime 尚无完整图片接线。当前[公共 Provider 接口](../../packages/daynight/src/commands/controller/providers/types.ts)通过 `imageRuntime`、接受观察、出现位置与 capture callbacks 连接[Controller runtime](../../packages/daynight/src/commands/controller/runtime.ts)，保留原有错误分类、角色说明、子 Agent、控制、恢复和历史行为。

## 实现所有者与持久边界

| 所有者 | 职责 |
| --- | --- |
| [共享 projector](../../packages/daynight/src/commands/controller/providers/image-projector.ts) | 将完整 content/tool output 布局中的图片位置、稳定来源 tuple 和 capture 状态存入原 journal；为富图片条目设置 `imageProjectionError`，经位置 ACK 和实际完整历史确认后封存并 submit，未知时 query 原身份。 |
| [原生状态](../../packages/daynight/src/commands/controller/media/native-state.ts) | 在既有 `image_runtime_state` 中保存 matcher、别名、分页及出现状态；单值不超过 1 MiB，消费普通元数据预算。 |
| [wire spool](../../packages/daynight/src/commands/controller/media/native-spool.ts) 与 [media owner](../../packages/daynight/src/commands/controller/media/preparations.ts) | 按实际暂存与未落盘字节检查公共空闲水位，单次写不超过 64 KiB；seal 后只读，活跃 reader、未完成 unlink 或目录同步均不允许提前释放。 |
| [Codex RPC](../../packages/daynight/src/commands/controller/providers/codex-rpc.ts) | 有界解析原生流，将明确媒体字段交独立 token 暂存，保持 RPC 回执与原连接。 |
| [Claude live helper](../../packages/daynight/src/commands/controller/providers/claude-live.ts) 与 [transcript helper](../../packages/daynight/src/commands/controller/providers/claude-transcript.ts) | 隔离 SDK 全量解析和受权历史索引，使用有界 IPC 与媒体 ACK；Controller 保存实际 native 子进程证明。 |
| [Copilot bridge](../../packages/daynight/src/commands/controller/providers/copilot-bridge.ts) | 同一 runtime 的唯一 SDK 连接承载输入、控制、交互、订阅和分页；帧代理限制输入，私有媒体 lease 把字节逐块交给 Controller。 |

索引 writer 的预算 reservation 与实际进程证明持久保存。恢复只有在原 writer 已停止或已被其他进程替代时才释放 reservation；存活、无法确认或缺少证明时拒绝新 writer。实际索引、sidecar 和 reservation 按占用上界计量，避免重复计费；原生状态不能借用结算专用额度。

Provider 只交出本地或外部 locator，不自行打开路径或抓取 URL。公共 `resolveImageCaptureSource` 在原出现已 ACK、本地原 request 已持久且实际完整历史已确认后，沿原来源权限读取；组件缺失时保留同位置的 `component_unsupported`。读取不等待服务 register 或 reserved。已保存的图片直接复用服务 resource，重开不重新访问原来源。待到达来源保留 pending，最终 payload 到达后更新同一位置；完成布局由 normalizer 完整提供，不能用纯文字 delta 覆盖图片槽。

## 三者共同的发送屏障

输入只有可选的一个非空白文字块和其后的有序图片，不增加任意图文交错编辑。三者均须满足同一顺序：服务对原 actor、target、能力 revision、完整图片集合和元数据预算授权；Controller 再核对 providerRevision、当前回合、设置与权限；整组 `acquireInput`；持久原 intent 及 operation/native pin；`markDispatching`；唯一一次原生调用。一个图片准备失败就整条拒绝，不能只发剩余图或文字。设置与最终检查到原生调用之间互斥，异步准备后必须重新检查。

图片的上传完成、SDK 消费输入、本地回显、同文字/图片摘要、当前恰有一个回合都不是接受证据。派发后超时、断线、坏回执或不能证明未接受的 SDK 异常维持 unknown；只查询原 operation，不重放原生调用。原生明确未接纳的 profile 错误要与“从未调用”分开持久化，不能把所有 rejected/failed 当作零调用。恢复只结算原 target/draftId/revision，旧回执不得清除后继草稿或升级旧上传资格。

Daynight 将公共存储中的完整原件按原顺序交给原生图片接口，不自行缩放、压缩、转码或省略输入以绕过限制。接口之后的正常原生转换、缩放和历史压缩允许产生不同字节，不改变 Daynight 保存的原件。模型请求中的转换图片、原生返回的图片和原上传图分别记录来源；不能要求它们摘要相等，也不能用转换后较小的字节数替代原始输入限额。

接受证明也不等于模型已读每张图。本次输入不得被静默省略或变成纯文字占位；正常历史压缩不承诺永久保留旧图。若原生接受后出现明确部分附件交付失败，原 operation、消息、原件和失败原因均持久可回看，同时关闭有问题的 profile。不得撤回接受事实、只弹 toast、伪装普通未派发拒绝或自动重发。资格证据将传输、精确接受和视觉回答分开，已知省略条件不得获资格；无法观察的内部字节不伪造为与原件一致。

能力取原生 profile 与完整上传、解码、保存、历史读取、归档及策略能力的交集。输入为 PNG/JPEG/WebP，通用上限为 8 图、每图 10485760 bytes、消息图片合计 20971520 bytes；原生有更小的明确限制时取交集。send 与 steer 分别报告 supported/unsupported/unknown，未知不猜支持，文字能力独立。

公共 `geometry` 和 `frameCount` 只由协议设计定义，表示获资格组合允许提交的原始画布与帧数。Provider 依据精确组合的证据、明确接口限制和适用条件给出固定上限；不能拿本条 8 图代替累计上下文，也不能把通用解码上限或另一 backend 的规则当作资格。历史、工具、恢复和压缩证据按实际覆盖条件保留，未确认的组合保持 unknown。存储画布宽高不交换 EXIF 方向；涉及显示方向的 profile 先归约成两种方向都满足已确认输入限制的固定上限。模型、权限、原生绑定、可观测上下文条件、资格或限制变化推进持久 providerRevision，无变化复核不推进。

原生原件只能从公共存储的受控 lease 取得。当前 Controller 读取服务原件时，必须受同代次 `operation_authorized` 的原 actor、完整有序 intent、有效发送 pin 和每块授权约束；不能借浏览器 token、枚举历史或修复旧代次任意 native 路径。服务历史可读与 native resume 文件存在分别报告。

## Codex

### 新 thread 的声明配置身份

[配置观察器](../../packages/daynight/src/commands/controller/providers/codex-config-observation.ts)通过同一 app-server、同一实际 thread/start cwd 读取 config/read，只投影选中 model_provider 的显式 base_url、wire_api 和 supports_websockets。native_declared_config_v1 摘要标识这些非秘密声明字段；supports_websockets 保留 true、false 和未声明的区别，不代表实际传输方式。headers、token、完整配置及原生错误正文不进入摘要或诊断，URL 不接受 userinfo、query、fragment 和未验证编码结构。未处理的 OPENAI_BASE_URL、OPENAI_API_BASE 非空覆盖使观察未知；环境变量名按原生平台规则识别，Windows 不区分大小写。其他未纳入的配置字段不被宣称已经证明。

观察器核对实际发送的thread/start参数，明确model覆盖由原生response确认，未指定模型时使用首次配置默认值；不增加provider开关。未知thread配置覆盖拒绝建立观察，已知权限、effort及Agent CLI alias配置保留。新thread的modelProvider必须匹配选中配置，启动前后路由摘要一致才能建立基线；物理cwd仍由adapter验证。前后相同表示有界一致性，不是原子快照或thread专属endpoint证明。

程序摘要来自verifyToolLaunch已验证、与实际child直接启动路径相符的唯一Windows原生artifact；JS、interpreter和未验证fallback保持未知。Windows0.169.0与既有macOS0.167.0是分别识别的协议兼容入口，不是通用版本许可或receipt/history资格。sdkVersion=null表示无SDK。当前生产目录为空，所以观察成功仍不能开放图片。

设置、模型、cwd、进程与连接变化撤销generation和旧观察。公开controls刷新与确认设置事件可重新读取；同一thread只能回到原路由基线，不能因全局配置变化而套用新backend身份。不同模型必须匹配其自己的资格，活动turn继续受已确认turnModel限制。resume不建立新观察，图片保持unknown；已接受输入、历史、归档及原操作查询仍保留。观察5秒到期后撤销，最多保留一个未完成原生读取，迟到不能恢复观察；后台观察不占用普通文字发送门禁。

图片在读取、编码后核对原 grant 和观察，实际 transport 写入前再次验证同 child 生命周期、thread、generation、controls revision、资格 fingerprint 及待处理的原生交互。该检查位于 Read authority 可能等待 drain 之后；提交前失败零次输入，提交后的失败保留接受或 unknown，不重发。[决策记录](../../.agents/notes/implemented/architecture/2026-11-16-codex-image-config-observation.md)解释新 thread 范围和恢复成本。

### 能力、编码与接受

当前精确模型必须在完整 `model/list` 分页结果中得到可靠映射，并明确 `inputModalities` 含 image；`imageGeneration` 是输出能力。缺字段、模型未知、设置未确认或版本 profile 不匹配时禁图片。steer 按当前回合的已确认模型判断，不能沿用未来默认模型；二者无法同时准确表达时 steer=unknown。

profile 还绑定 `thread/start` 或 `thread/resume` 返回的实际 `modelProvider`。模型目录的 image modality 不能证明原始输入几何资格；自定义 gateway 不能借用官方 OpenAI backend 的规则。只有当前 executable、SDK、平台、backend/model 和操作精确匹配已发布证据及输入限制，才能提供资格。缺少匹配时，公共能力为 `unknown`、`capability_unknown` 和全零 unknown geometry。受控测试注入的 profile 只证明编码和回执处理，不构成生产支持证据。

原生数组保持顺序：可选 `{type:"text",text,text_elements:[]}` 后接 `{type:"localImage",path}`。path 仅来自稳定私有文件，纯图片省略文字块，不添加提示词、文件名、Markdown 或空 TextPart；detail 沿原生缺省。不以 data URL 或远程 URL 作隐式 fallback。

已发现的原生技能由独立 `skill` 块提供命令输入，允许其文字参数为空；命令仍须通过当前 controls revision 和空闲状态校验。该例外只用于技能命令，普通空消息仍在原生调用前拒绝。

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

用户消息中只有一个 string text block 且其余均为 image/localImage 时，该正文保留 Markdown 资格，包括已接受输入及历史。完整性来自原生终态或已持久化原输入；多 text block 不合并为一个可采集正文，纯图不添加空正文。Markdown bindings 复用稳定正文 partId，原生图片仍保持原位置、imageId 和接受回执。

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

解析器跨 chunk 校验 UTF-8、JSON token/escape，仅对明确 schema 的媒体字符串建立候选暂存槽。字段顺序任意，type/id 晚于 bytes 时先暂存不可执行 wire bytes，完整帧、来源和身份通过后才能使用；不能正则替换 JSON。该暂存仅消费已连接原生进程主动发来的 bytes，不抓 URL 或读 path，仍执行公共空闲水位检查，不计媒体累计额度。

| 对象 | 上限与处理 |
| --- | --- |
| byte buffer / 单图 | 64 KiB / 10 MiB；逐字符串 Base64 解码。超单图保留原位置错误并有界排空。 |
| wire 暂存 | 每帧 96 MiB、1000 槽；至多两个完成帧合计 192 MiB，仍受实际磁盘准入限制。输出不套用输入 8 图/20 MiB 限制。 |
| metadata / 结构 | 每帧 16 MiB、深度 64、100000 tokens。已知文字沿原文字截断并标识，不能截断 JSON 后 parse。 |
| 整帧 | 总输入 128 MiB、绝对解析期限 30 秒。超限关闭该私有连接，未决操作 unknown；已保存历史保留。 |

完成队列最多两帧，stdout 背压。RPC reader 将 OS chunk 以至多 64 KiB 的 subarray 片段交给同一个惰性 decoder，每帧和片段末尾等待一次 ref'ed setImmediate，覆盖无完整帧和 UTF-8 分割。每帧先分发，再让微任务取得独立媒体 lease，最后释放帧引用；I/O 让步前同步原绝对帧 timer，完成帧清除旧 timer。显式释放、原生错误或期限失败后停止派发及 timer 重设；自然进程关闭立即禁止新写入，已收到的 stdout 由 reader 排空后再触发 Provider 收尾。已安排 immediate 正常结算并 join rpc.stopped，decoder 清理不释放消费者持有的 lease。完整调度及 IPC 合同由[Controller 输出消费](task-session-protocol.md#codex-输出消费与-io)拥有。RPC 回执分发不等待服务 capture 网络；暂存不足的图可保留容量错误，不能拖死控制消息。自有回显若已可信关联原件，可验证格式/摘要后丢弃冗余 inline bytes。只读重取工具图片绑定已知 item/turn 和待采 part 索引，避免已采图占满暂存；没有可信身份的实时帧按其准入结果处理，绝不重新执行工具。未通过完整帧验证的文件不能关联消息；释放须等 reader/writer 停止及实际 unlink。

## Claude Code

### 能力和完整输入

兼容 profile 绑定实际 SDK/executable、backend、已确认 effective model、输入及接受事件、历史 schema。保留原生选择值 `default`，另存实际 resolved model；未知 backend、default 未解析、设置超时或 profile 不匹配时图片 unknown，不能隐式发一轮探测。图片 steer 固定 unsupported；文本 steer 保持原有能力，图片不入队、不 interrupt。

实际 executable 从 SDK 的 `spawnClaudeCodeProcess` 观察，不猜测固定 `cli.js`。helper 在该入口探测版本，并结合实际 spawn 环境和 SDK effective settings 判断 backend；覆盖冲突、不可解析的设置来源或未执行的 policy helper 均不能证明 first-party backend。模型别名、点号与短横线拼写不自行等同，必须取得精确 resolved model 或经过独立验证的映射。这些运行时身份事实只定位待验证组合，不证明图片准入资格；版本匹配、模型目录及公开视觉限制不能替代该组合的原生接受、几何和平台证据。

Claude 图片能力不在当前设计与验收范围，且当前没有已完成资格验证的 Claude 图片 profile。因此即使 SDK、CLI、Anthropic backend 和精确模型均已确认，生产能力仍报告 `send:unknown`、未知 geometry、空媒体类型和零图片额度；adapter 在读取图片文件或原生提交前拒绝图片输入。模型 readback 仍更新真实模型身份，不会自行开放图片能力。受控 adapter 测试使用测试内的能力替身验证原生编码和接受处理，不提供生产配置开关；开放资格须先取得完整证据并更新相应 profile。

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

历史 user 落盘不能单独证明通过 UserPromptSubmit hook 或执行。历史缺 user_message_uuid 时只可用已验证 schema 的 parentUuid 执行链补强，不按“下一条 assistant”猜测。索引和分页保留 assistant 的 `error`、`isApiErrorMessage`，认证或无效请求错误不能因重开而变成无错误的执行证据。matcher 先持久关联再通知 runtime，重复证据幂等，不覆盖其他操作。空历史、取消或查不到记录都不证明未派发。

### 图片投影和 transcript 恢复

live、final 和历史用同一 normalizer，先识别图片/工具再做文字转换。自有输入保持原 image/resource；其他 user 以 transcript uuid+block index 为来源，没有 UUID 时用已登记文件身份/记录偏移/摘要作私有键，这种 fallback 不作为输入接受证据。assistant 使用 message.id+native block index；final-only 的拆分 sibling 必须从完整所选 chain 计算并持久块顺序，不能每页重置 ordinal。工具结果保留 tool_use_id 和内嵌 index；子代理仅消费根会话已暴露且父工具关系授权的内容，不遍历其他 transcript。

正文块和图片位置先持久、按原次序发表，text A/image B/text C 的 B 不等待采集结束才排到 C 后。resource 槽未取得时用同 imageId 的未采集表示，不能虚构 resourceId。原生 materialized 用户历史可保存，但不结算 unknown，也不把草稿乐观条目当正式归档消息。

base64 image source、tool_result 的有序 text/image 和明确 native URL/path 分别走公共 capture、外部及本地采集；tool `is_error` 保留。展示接受五格式，不能因输入三格式删 GIF/AVIF。缺 bytes/坏源同位置不可用，已有 committed 图不再访问原源。

SDK user 工具事件的 `tool_use_result` 若为明确的 image `FileReadOutput`，且 `file.base64` 与同事件工具内容中的图片及 MIME 完全匹配，冗余位置复用同一 transfer 和结果，不重复传输或把 Base64 副本计作 IPC 元数据。文件尺寸等其他字段保留；未知结构及不匹配的副本仍受原元数据上限约束。

原生 transcript 使用 `toolUseResult.file.base64` 保存同一结构化 Read 结果。扫描器以有界状态计算逻辑字符串签名，在完整记录解析后核对 user、`FileReadOutput` 形状、MIME 和同记录工具图片的内容签名，再移除已证明的副本字节；JSON 字段顺序和等价转义不改变判定。权威 `message.content` 图片继续保留原 offset、出现身份及不可用原因，不为副本新增采集。未知形状、不匹配或没有权威图片的字段仍按原编码字节计入元数据，不能借此通道跳过容量限制。

新增只读 transcript helper，不用 getSessionMessages 的全量数组或 execFile 全量 JSON。SessionStart transcript_path 只是线索，须核 native ID、cwd、配置 home、文件身份；旧布局只在当前已授权 home 内按固定 resolver 精确查找，未知布局失败，不跨账户搜索。授权 FD 固定快照的身份、初始长度、完整行边界和前缀摘要。

第一遍增量 tokenizer 扫描 JSONL，媒体按 token 跳过并记录 offset；受限磁盘索引保存 uuid/parentUuid/message.id/block、tool、sidechain/meta 与 compaction 字段。按真实 parent chain、preservedMessages/preservedSegment、父链重写及 sibling/tool_result 选可见分支，不以物理行序当最终对话。helper 只输出元数据，由 Controller 唯一 journal writer 提交：每页最多 100 条、序列化最多 1 MiB，ACK 后下一页。

第二遍只读取所选出现，原位置 ACK 和必要完整历史确认后逐块解码其媒体到本机已预留 staging，封存后直接 submit。单行或总历史大于旧 32 MiB 不是失败理由；超单图 10 MiB 有界跳过并保留位置，不吞同行文字。结构深度 64，身份沿公共上限，文字沿既有截断规则。末尾未完成行等待后续扫描；截断、替换、前缀变化或父链缺口停止新导入且保留旧图。cursor 绑定快照/chain/表示/historyEpoch；append 验证连续前缀，不重建身份。helper 不 query/send、不恢复或修改原生会话。

已知 `tool_result.content` 字符串及其 text 块在元数据预算前保留有界前缀，最终显示仍由既有文字投影生成截断标记。历史扫描继续检查被丢弃尾部的 JSON 转义、UTF-8 和完整结构，完整解析后核对所属块类型；未知字段不能借用文字截断通道绕过容量限制。live 与历史共享前缀规则，保留图片位置和相邻正文；总元数据和页预算不变。

### 内存与保留

20 MiB/8 图的 Base64 最多 27,962,048 ASCII 字符。只允许一个含图 send 在途、一个不超过 10 MiB 的原图 Buffer，不建立编码待发队列，matcher 不复制 payload。Claude 媒体适配额外 RSS 预算目标为 512 MiB，包含 SDK 宿主、history helper、Buffer/native allocations；Node heap 不是内存硬隔离。

若 SDK 主宿主无法给出有限输出分配界限，query/JSON 解析进入受限私有 helper，控制和媒体分通道并保持原 controls/cancel/respond/onSpawn 及进程树归属。无法验证内存、控制优先级或回收则 component_unsupported，不能重启已有用户会话来满足预算。

native/resume pin 默认保留到原生 Session 删除。仅 profile 已证明 SDK 获得独立完整 bytes、持久历史不依赖 localPath 且无活跃读者时，才接受私有“不再依赖文件”释放证据；accepted/回合结束本身不够。unknown、消息和归档引用独立保留。

## Copilot

### 原生声明的运行时身份

[私有路由观察器](../../packages/daynight/src/commands/controller/providers/copilot-route-observation.ts)读取同一 SDK Session 的当前模型、默认 endpoint，再读取当前模型核对。它只在支持的 type、wireApi、可选 transport 及安全 URL 结构内生成 `native_declared_route_v1` 摘要；地址不得包含 userinfo、query 或 fragment。原生省略 transport 时，摘要明确编码 null，与 http、websockets 区分，不推断实际传输方式；显式非法值仍拒绝。摘要和 modelId 可以由 bridge 返回；apiKey、headers、sessionToken 及完整 endpoint 不得从 bridge worker 返回 Controller 父进程、进入摘要或诊断。专用观察失败返回空结果，普通 RPC 不透传 getEndpoint。

装配图片观察的 Controller 仅在所属原生子进程中默认设置 `COPILOT_ALLOW_GET_PROVIDER_ENDPOINT=true`，满足原生 endpoint 读取接口的显式开关。已有环境值保持不变，Windows 按键名大小写不敏感识别已有值；不修改父进程、用户配置、模型、路由或认证。原生继续拒绝读取时保持未知，不绕过认证或重发输入。

程序身份复用 `verifyToolLaunch` 已验证的同一 Windows 直启原生 executable artifact，绑定实际所属进程。JS launcher、interpreter、materialized runtime 和未验证 fallback 保持未知；不能用 Node 或启动脚本的摘要冒充原生程序身份。进程关闭或退出后不再提供有效摘要。

`CopilotRouteObservation` 的 sessionId、generation 和模型读回限制异步观察及最终图片派发；原生没有提供原子快照，因此前后模型相同也不能被描述成原子证明。设置、模型或模式变化、恢复及断连使旧观察失效，稳定读回后可重新观察。发送前在现有派发互斥范围内刷新，bridge 在异步图片编码和最终授权回调之后再次核对 generation。generation 不参与稳定资格摘要，无变化读回不制造新的资格身份。观察必须有界，晚到结果不得恢复已失效观察；图片观察失败不得永久占有普通文字发送门禁。

这里的 backendIdentity 仅标识原生声明的可见路由配置，不证明最终 HTTP 目标、隐藏部署或模型权重，也不是实际出站请求观察。生产不为此安装 requestHandler：SDK 在回调前全量缓冲请求，默认转发的重定向行为也需要独立验证。当前资格目录仍为空；真实输入、精确回执、历史及产品证据由资格验收负责，不能由配置读回替代。[决策记录](../../.agents/notes/implemented/architecture/2026-11-16-copilot-image-runtime-observation.md)保留替代方案和成本。

### 图片输入与目录限制

### 当前模型与 blob 输入

`model.getCurrent` 的精确 modelId 必须在完整目录中唯一对应，`supports.vision === true`，MIME、`max_prompt_image_size`（bytes）、`max_prompt_images`（张数）均合法；缺项、重复、非布尔、非法限额为 unknown。明确 vision=false 或 MIME 交集为空为 unsupported。动态限制与公共 geometry 同时有效，不以模型名称猜测。

目录事实还须与当前 `QualifiedImages` 的精确 modelId、身份和 send/steer 资格匹配，MIME 与数值限制取资格、模型目录及通用上限的交集。原生允许内部缩放不表示可以忽略 `max_prompt_image_size`；没有资格时，目录支持 vision 也不能开放输入。

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

Copilot matcher 保存可恢复的原请求意图，随后调用共享 `publishNativeInputAssociation`。共享 owner 校验既有原接受观察、完整 intent 与原资源，以当前已提交 entry 选择首次绑定或尾部追加；Provider 草案不决定真实 revision 或覆盖已完成 capture。alias、原件槽/引用、occurrence、当前正文及 totals、实际 revision 与 outbox source sequence 在原 SQLite 写事务中提交。所有内容读取同一 SQL 当前行，事务失败保留上一完整视图。

提交返回不可变 receipt 与当前 view。receipt 的 `publicationRevision` 和 `sourceSequence` 固定，view 的 revision 可以因后续 capture 更高。`ProviderImageProjector.adoptCommitted` 接管当前 view，不再次发布旧 timeline 或 occurrence。若先前 capture 终态已持久而对应 part 尚未写入 timeline 就中断，通过 `patchNativeImagePart` 在当前 SQL entry 上补写同 imageId 的持久 part；不重新 register、读取来源或发送原生输入。该单槽入口也防止异步捕获回调以旧整条消息覆盖刚提交的原件槽；写失败保留已确认 capture 终态，不改成未知采集结果。重复同身份返回原 receipt 和当前 view，不加槽、不推进 revision；同身份异请求拒绝。unknown 只通过 `queryNativeInputAssociation` 查询原身份；权威 absent 后才允许恢复同一元数据提交，不能再次 native send。旧 Provider publication 仅作恢复意图，缺少共享提交证据时不能冒充已提交。

少数迟到情况显示两种真实来源，即使同摘要也不能改绑已公开身份。这些关联和 retained 内容在完整历史实际发布时按统一 Session 内容总量检查，不为未来双槽或归档预留空间。超限保留上一已接受历史及原身份，不删除已保存原图；原生 capture 的实际资源提交同样检查总量，已保存原上传图仍可按原权限读取。

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

三者全部来源遵守同一次序：Controller 先持久 entry/出现位置与原 request，经原 timeline/source outbox 得到覆盖该位置的服务 ACK，并确认必要实际完整历史；沿原来源权限读取并封存，再以原 request、当前 attempt 和 frozen outcome 直接 `image_capture submit`。服务原子核验来源映射、身份和当前 attempt，真实保存后 committed；本地读取不等待 register 或 reserved。未知先 query 原 captureId，只有当前授权和 fence 有效且明确 capture_not_found 才重放原冻结提交与封存字节。自有输入回显同样在位置 ACK 后以 resource locator 和 resource outcome submit，已 available 同 Session 原件直接 committed，只增加出现引用和可信 nativeSource，不复制 blob、不重计资源槽，也不凭此确认输入。

canonical aliases 只由可信 native ID 关联事务添加，不能用 hash 猜并。已 committed 永远读服务原件，格式错误、源消失、权限变化保留原位置与安全错误。结束时停止新源 IO，结算原捕获；unknown 或已保存 bytes 损坏不能伪装“从未采集”。

Windows、macOS、Linux 分别验证原生 adapter、helper/bridge 进程树与资源回收，native 进程峰值和 Controller/SDK 宿主峰值分开记录。没有真实模型输出的特定助手图片形态可标 native_not_produced；Codex、Copilot 的纯图及图文输入不能据此豁免。

必须验证：各 Provider 实际原生 payload 的类型/顺序/bytes、唯一调用数、精确接受关联、第二图失败零调用、回执丢失和迟到、模型与权限变化、重复同图与乱序历史、工具归属、合法边界和恶意大帧、控制不饿死、源变化后的原摘要、Controller 离线的归档读取及旧文本兼容。受控 SDK/RPC 证明本地调用和状态处理，真实 profile 证明原生接受与模型视觉消费；二者不能互相替代。
