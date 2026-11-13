# Session 图片来源采集设计

本文定义真实 Markdown 图片节点的稳定绑定、本地授权句柄读取、外部 HTTP(S) 无凭据获取，以及首次成功后的不可变快照。Controller 包含来源解析、持久投影、采集协调、本地句柄 reader 和专用 HTTP(S) transport，并复用公共 capture、媒体预算和不可变资源存储。本地来源按精确 Provider 能力逐次取得原生读取许可；未支持的配置和缺少有效可信部署配置的外部来源拒绝新 IO。模块存在或某一 profile 可用，不表示完整来源验收已经完成。

[历史规格](../spec/session-image-history.md)拥有所需显示、原内容和权限结果；[公共合同](session-image-contracts.md)拥有 ImageLocator、ImageOccurrence、capture/read/retry DTO、错误与存储，本文不另建协议或数据库。[Provider 设计](session-image-providers.md)提供可信原生来源，[浏览器设计](session-image-browser.md)负责渲染和预览，[归档设计](session-image-archives.md)负责封存、读取与清理。[来源决策记录](../../.agents/notes/implemented/architecture/2026-11-05-session-image-sources.md)保留替代方案及代价。

## 当前实现与权限边界

实现位于 [Controller markdown 目录](../../packages/daynight/src/commands/controller/markdown/)。各模块通过现有 journal 和 capture 桥协作，不增加来源专用 wire 协议或资源数据库。

| 模块 | 当前职责 |
| --- | --- |
| [parser.ts](../../packages/daynight/src/commands/controller/markdown/parser.ts) | `parseMarkdownImages` 在可终止 worker 中运行 `remark-parse`/`remark-gfm`，输出完整 AST 图片集合及 UTF-16 原文区间；失败不交付节点前缀。 |
| [projection.ts](../../packages/daynight/src/commands/controller/markdown/projection.ts) | `createMarkdownImageProjector` 保存片段身份、正文 revision/hash、完整 bindings、retained 和解析失败容器。 |
| [pipeline.ts](../../packages/daynight/src/commands/controller/markdown/pipeline.ts) | `createMarkdownTimelinePipeline.accept/tick/receipt/failure/stop` 将同步正文接收、异步解析、回执关联和停止结算分开；旧投影从持久索引重放。 |
| [store.ts](../../packages/daynight/src/commands/controller/markdown/store.ts) | `createMarkdownSourceStore` 在既有 `image_runtime_state` 保存 `markdown:projection`、`markdown:source`、`markdown:context` 与 `markdown:rate`；按最多 32 个身份分页，计入既有元数据预算。 |
| [coordinator.ts](../../packages/daynight/src/commands/controller/markdown/coordinator.ts) | `createMarkdownCaptureCoordinator` 拥有可信 context、持久 source intent、位置 ACK、原 capture 查询、权限复核、来源重试和取消后的 join。 |
| [local-source.ts](../../packages/daynight/src/commands/controller/markdown/local-source.ts)、[local-source-proof.ts](../../packages/daynight/src/commands/controller/markdown/local-source-proof.ts)、[local-source-helper.ts](../../packages/daynight/src/commands/controller/markdown/local-source-helper.ts)、[local-source-filesystem.ts](../../packages/daynight/src/commands/controller/markdown/local-source-filesystem.ts)、[local-source-windows.ts](../../packages/daynight/src/commands/controller/markdown/local-source-windows.ts)、[local-source-windows-helper.ts](../../packages/daynight/src/commands/controller/markdown/local-source-windows-helper.ts) | `createLocalImageContext` 与 `copyLocalImage` 按平台选择独立 helper，以根和祖先句柄执行 no-follow/reparse-aware 组件遍历、链接解析和逐块复制；`LocalImageCheckpoint` 将有界的实际来源证明交给策略消费者。 |
| [external-source.ts](../../packages/daynight/src/commands/controller/markdown/external-source.ts) | `createExternalImagePolicy` 与 `copyExternalImage` 将受信出口策略和逐次请求计费接入独立 DNS、TCP/TLS、HTTP/1.1 reader。 |
| [external-policy.ts](../../packages/daynight/src/commands/controller/markdown/external-policy.ts)、[external-images.ts](../../packages/daynight/src/config/external-images.ts) | `createExternalImagePolicyProducer` 从有界可信配置与当前本机接口创建固定 generation 的目标策略，拒绝受保护域、地址及转换前缀，并在观察到变化或观察失败时取消活动采集。 |

[runtime.ts](../../packages/daynight/src/commands/controller/runtime.ts) 将 Provider 的正文和完成元数据交给 pipeline，以 250 ms 周期分别推进解析与采集；原生回调不等待媒体工作。断线使活动来源失效；停止先取消并等待来源工作，再关闭 Provider、完成已有正文的投影结算和关闭媒体存储。停止后不启动来源请求或后台 query。已持久的 unknown、validated 和 retained 仍属于原执行的恢复与归档闭包。

原生图片 projector 逐 entry 保留当前正文的完成元数据；正文相同但 complete 改变仍须发布，迟到图片回执沿用当前元数据，缺失元数据的新正文不能继承旧允许。原生输入的原子 publication 或查询仅在 committed 后进入 Markdown 管线；初次完整性以及已有 streaming 正文的完成提升，必须由持久原始 intent 的文本与当前唯一正文精确一致证明，publication 的 seed 或图片回执本身不证明 Markdown 完整。

`publishMarkdownProjection` 在 journal 的同一个 SQLite 事务中保存 Markdown projection state、SQL 当前正文及 totals 和 source outbox，避免 state 已完成而时间线仍为旧正文的恢复窗口。失败回滚保持上一份完整可见状态；事务结果未确认时沿 journal 隔离规则处理，不能用本连接的未提交状态恢复。

Markdown 状态在解析、回执与停止结算前读取 journal 的当前 committed entry，仅校准同位置、同 imageId 的原生图片更新及追加的原始图片，更新 parser token 使旧异步结果失效。这样即使进程在原生 patch 提交后、Markdown 同步前退出，恢复也不会写回旧图片状态。校准不重新登记原生 occurrence，不改变已接受 publication 的不可变回执或原生图片 index。解析失败的补充 Markdown carrier 位于原始正文之后，并保留协议要求的 text 前驱，避免插入到原生图片之前而移动已提交位置。

当前图片范围为 Codex、Copilot；Claude 不属于交付和验收目标，其本地来源继续返回 `policy_restricted`，已保存原件按现有读取权限访问。[范围决策](../../.agents/notes/implemented/architecture/2026-11-11-image-provider-scope.md)保留此调整的理由和后续接入成本。其余支持条件继续遵循[验收规格](../spec/session-image-acceptance.md)：

- Codex 与 Copilot 的真实 runtime 仅为下述精确版本和能力子集提供 `nativeReadPolicy`；不支持的版本、权限配置或 hooks 状态返回 `policy_restricted`。Claude 不发布本地图片 Read authority，也不触发图片权限审批。来源证明、`permissionMode`、启动时的 sandbox/profile 文案、同用户可读或一次工具读取均不能替代有效原生判定。
- 真实 runtime 提供本地出口策略 producer；有效 profile 仍依赖部署所有者提供完整受保护目标和出口条件。缺失或未知条件返回 `policy_restricted`。配置解析、真实本机接口和受控 transport 测试分别证明对应机制，不能证明尚未配置的真实部署已阻断透明路由到本机、内网和元数据。

Codex/Copilot 适用 profile 的原生权限保证、平台句柄验证和真实部署出口验收仍是交付要求。受控 transport、文件系统和 Provider fixture 分别只证明其覆盖的机制，不能据此声明真实 Provider 或端到端验收通过。macOS ARM64、Linux 和 Windows 的句柄用例须在对应平台实际执行，代码分支或其他平台的结果不替代该证据；Intel macOS 不在现行支持平台范围内。具体结果及版本由验收材料记录。

### 原生单次读取准入

Provider 发布的 `NativeReadPolicy` 绑定真实 native Session、可信 cwd 和当前 authority 实例。`verify()` 只同步核对实例、连接和本地失效状态，不授予读取；`authorizeCheckpoint(checkpoint)` 异步取得该 checkpoint 的原生决定。coordinator 在等待前后核对同一 policy 对象、Session、执行身份和 Daynight fence；helper 每次只等待一个 checkpoint，拒绝或取消后，迟到答复不再发送 continue。新 attempt 使用当时有效的 policy，原正文 context 的 policy revision 仅保存来源时的观察，不能充当永久许可。

`initial`、`opened`、每个 `block` 和 `final` 都独立判定，不预取或缓存允许结果。原生判定已经准入的单次操作可以完成；其后生效的原生拒绝约束下一次判定。Daynight 的账户、Session、执行或发布 fence 失效则立即阻止迟到结果继续读取或发布，不能用早先的原生允许恢复该 scope。Controller 自己发出的原生权限变化仍采用先同步失效、取消并 join writer，再发送原生变更的保守顺序。该区别及替代方案见[单次授权决策](../../.agents/notes/implemented/architecture/2026-11-10-single-checkpoint-native-read-authority.md)。

[Codex authority](../../packages/daynight/src/commands/controller/providers/codex-read-authority.ts) 只接受实际 initialize 返回的 0.167.0 版本、Provider 独占的 stdio 进程、明确 disabled 的 remote control，以及原生 start/resume 已解析的同一 thread/cwd、`dangerFullAccess`、`activePermissionProfile=null`、`approvalPolicy=never` 和唯一同根 local environment。这组原生事实在该精确实现中证明 FS 不再额外缩小导出根；它不扩大 A3 的根或 OS 权限，也不为图片改变用户 sandbox。版本依赖可信 Provider executable 的原生响应，不是生产二进制签名或指纹验证。

进程使用 0.167.0 的 `CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED` 关闭独立控制面，并读回真实状态。每个 checkpoint 再调用线程绑定的 `hooks/list`，只接受完整已知结构、同 cwd、没有 warnings/errors 且没有 enabled `PreToolUse` 的结果；不解释用户 hook 的脚本或 matcher，也不关闭它。后台新增 hook 不能被启动时的空列表掩盖，下一次查询必须重新判断。未知版本、格式、相关限制、协议失败或无法确认的变化均关闭本次 authority；关闭后同一 execution 不自动重开，原生进程重建须重新取得完整事实。RPC 设置变化、native 生命周期及同步 transport failure 走同一失效入口。

`thread/start` 的响应与随后正常的 `thread/started` 通知属于同一次启动；Codex authority 只容许一次与该请求响应的完整 thread 快照一致、`turns` 按原生通知规则清空的通知，无论通知先于还是晚于 policy 安装。没有 start 关联且尚未安装时，`thread/started` 通知使 authority 失效；已有 start 响应后，其他 thread 的通知不改变该启动关联。当前 thread 重复或快照不一致的通知仍使 authority 失效，`thread/resume` 不取得启动豁免。

[Copilot authority](../../packages/daynight/src/commands/controller/providers/copilot-read-authority.ts) 固定为 SDK 1.0.11、CLI 1.0.105、macOS ARM64。它核验安装的 SEA executable 以及私有有界解包得到的 `index.js`、`cli-main.js`、`runtime.node` 摘要，再由 Node 运行未修改的发行入口并加载 Daynight preload。独占 bridge worker 使用原 SDK/TCP 连接；preload 从同一真实 Session registry 调用固定 N-API 判定，不创建第二个授权 Session。未知版本、平台或原 SEA 摘要不匹配保留普通 Provider 路径，不发布图片来源策略。Worker 的受支持 profile 使用[冻结的私有运行目录](daynight-worker.md#copilot-authority-的私有运行目录)，完整发行树、Node 和 preload 闭包均核验；已匹配 profile 的准备或身份失败拒绝新启动，不降为普通 native。独立 Controller 维持私有临时解包。

每个 checkpoint 核对真实 Session/cwd、账户身份、当前原生模式、完整 hooks snapshot、SDK callback registry 和 strict content-exclusion 结果，再调用该 Session 的原生 Read permission route；只有明确 `result + approved` 可以继续。来源只接受与 held proof 对应的普通组件链；alias、symlink、目录链接、parent 折返，以及显式 `.` 或空组件均拒绝；`./image.png` 不属于该 Copilot profile 的路径子集。内容排除结果按固定发行物的完整路径策略合同消费，不把路径判断说成 inode 或内容权限。未知、不可用和相关 hook 状态拒绝，既不实现自己的 permission matcher，也不关闭用户 hooks。

支持的当前模式为 `manual` 或 `allow-all`。固定原生版本的 managed `defaultMode` 只影响新 Session，恢复保留原模式，动态 `permissions.disableAssistedPermissionsMode`/`permissions.disableBypassPermissionsMode` 只能收紧。独占 headless root Session 的 Host 模式变更先失效并 drain，权限变化事件也关闭 gate；每次原生 route 前再次读取实际模式，避免图片请求触发 assisted judge。模式值仅决定该无模型调用路径是否适用，不能代替完整 Read 判定。

Copilot 的 `model` 与 `effort` 设置经过 controls 的 revision、可用选项及当前状态验证，只调用对应原生 model RPC 和设置读回，不再次加载 skills。成功时保留同一个 Read authority；模型切换为 deferred 时沿原 controls 确认流程等待，不视为权限变更，也不提前报告模型生效。保留实例不复活已失效的 authority，后续每个 checkpoint 仍重新检查原生模式、hooks、content exclusion 和 Read。设置拒绝、超时或读回不符等失败关闭 authority 并 drain；权限设置及未分类操作在发出原生变更前先关闭并 drain，原生权限事件仍可独立关闭读取。

需要询问的图片请求由既有 SDK callback 精确拒绝，图片功能从不批准请求。每个请求预登记并签名绑定 native Session、execution、sequence、来源证明摘要及路径；live callback 还必须匹配 SDK context，且 request 与 `event.data.permissionRequest` 必须是同一个对象。拒绝 receipt 另签实际 native requestId。固定自有 ClientMetadata namespace 保存关联密钥，缺失时才初始化并读回，恢复保留原值，畸形或不确定状态不能覆盖、轮换或继续采集。密钥不进入 intention、事件、诊断或模型输入。历史只隐藏经两份签名验证的完整请求/拒绝对；未完成记录保留既有 expired/unknown 语义，不伪造完成，也不恢复为可批准的新请求。普通工具审批保持原流程，历史关联与当前图片模式资格分开。

Copilot IPC 每次只允许一个在途判定。15 秒 deadline 或未知 IPC 状态关闭图片 authority、拒绝队列并丢弃迟到允许结果；仍可能到达的本图片权限 callback 继续拒绝。原生 N-API 无法取消时最多保留一条在途调用，不能为了普通图片超时终止整个文字 Session。真正的 Provider close 负责关闭其拥有的 runtime；独立 Controller 同时回收正常临时解包资源，强制终止不能保证用户态清理。Worker 的已发布目录属于持久冻结依赖，Provider close 不删除。

SDK callback 与 permission event 的共享对象跨进程时，由 worker 对真实同对象分配仅桥内部的随机 identity；facade 核对同 Session、完整序列化请求及 identity 后恢复对象对应。permission callback 保持 SDK 的 callback-before-event 次序，identity 不授予权限；普通审批仍沿原交互流程。历史先按 permission 类型以 max=1 分页扫描，最多 100,000 页和 16 MiB 元数据，完成后才认证双签名 pair，再按原 durable cursor 投影普通历史。expired 仅允许从头重扫一次；未知、超限或关联失败关闭图片 authority并保留原交互与文字 Session，不能提前隐藏不完整的拒绝对。

## 来源与出现的职责

图片采集不依赖滚动、工具展开或浏览器在线。Controller 从可信消息内容建立位置，保存成功后才公开 available；浏览器懒加载只影响已保存原件的读取。Thread、Herdr、通用文件浏览、第三方登录、任意 MCP resource/read、网络文件共享和主动刷新历史图片不在此设计内。

共同流程为：可信投影器提交 entry、正文片段和来源上下文；纯 AST 模块只识别节点、不做 IO；Controller 持久原 imageId/sourceKey/locator 与 request/attempt，经 timeline/source outbox 得到覆盖该位置的服务 ACK，并实际上传必要完整历史；当前来源权限和本机容量有效时读取并封存 immutable validated 字节；冻结原 request、当前 attempt 和 outcome 后直接 submit。服务核验原位置、来源映射及当前 attempt，沿原 writer 保存 blob、引用与来源索引后 committed。此路径不发 register，也不等待 reserved；未知结果先查询原 captureId，只有当前授权和 fence 有效且明确 capture_not_found 才重放同一冻结业务及封存字节，不重抓来源、不更换身份。

可信 `NativeImageSource` 与 locator 分工不同：前者证明原生位置，后者说明如何取 bytes。原生位置须先 ACK，自有上传图的回显也以 resource locator 和 resource outcome 执行 submit；同 Session available 原件直接 committed，只增加出现引用和来源映射，不复制 blob、不增加资源槽。它不证明原生接受，也不能解除发送 unknown。

## Markdown 语法与正文稳定性

解析采用与 Session Markdown 相同的 CommonMark/GFM 语法和版本，只处理 AST `image` 和有有效 definition 的 `imageReference`，包括 full/collapsed/shortcut。definition 使用相同标识归一化及第一个生效定义规则；无 definition 保持文字。代码围栏、缩进/行内代码、转义标记、普通链接/路径、原始 HTML、工具参数和 raw JSON 都不登记图片。不用正则、扩展名或 DOM img 推导授权。

用户、助手和 reasoning 的 Markdown 正文适用；工具只有明确交付为 Markdown 的片段才适用，并保留 callId。raw output 不因此改成 Markdown；原生二进制工具图片由 Provider 投影处理。

每个真实正文片段具有稳定 partId，来自原生 block/item ID 或首次持久映射；不得使用数组位置、页面 epoch 或正文 hash 作身份。每次解析针对完整 revision：不做 NFC 归一化、CRLF 转换或 trim；偏移使用实际 text 的 UTF-16 code unit 半开区间 `[start,end)`，SHA-256 计算其 UTF-8 bytes。无源码位置的插件合成节点不得读源。alt 仅生成有界安全 label，不作路径、文件名或 sourceKey。

流式正文看似闭合仍可能被后续围栏、反引号或 definition 改变。首次采集等待可信正文完成信号；没有该信号时，只能由可信原生终态或完整历史证明该正文已经完整，不能用暂时 idle 或文本看似闭合代替。流中可以显示尚未加载位置，但不据此不可逆读取来源。已有稳定图的读取无需等待后续文字。

Provider 通过 `onTimeline(entry, metadata?)` 交付 `MarkdownTimelineMetadata {complete,format,truncated}`。真实 text/thinking block 终态或可信完整历史才标记 `complete:true`，delta 标记 false；工具 raw output、工具参数和结构化 JSON 保持 `format:"plain"`。Codex 的未完成历史 turn 不标完成；最终 reasoning 不再携带可读文本时，完成信号仍关联原条目已流式收到的正文。缺少可靠 block 身份的多 text 内容不猜片段映射。pipeline 还合并 `providerDisplayEntry` 的实际截断事实：完成但截断的正文不触发首次采集，缺少 metadata 的普通文字沿原文字投影保存。完成元数据不携带或授予原生读取权限。

正文修订中，无歧义保留的同节点可继续原 imageId；locator、definition 目标或可信来源 context 改变就是新出现，旧图进入 retained。重复同路径的两个节点分别建 imageId，不按 URL/SHA 合并。无法可靠对齐时保留旧图关系，并给新位置新身份或明确缺失。正文截断必须先于绑定；不能把截断恰巧造成的闭合当完整节点，必须证明节点在原文中也成立，不能使用截断前 offset 匹配显示文本。

Codex 用户消息或已接受输入中，只有一个 string text block 且其余均为 image/localImage 时，该正文可取得 Markdown 资格。其完整性沿原生终态或已持久化输入判定；多 text block 不合并猜测，只有图片时不制造正文。Markdown 投影保持原生图片 index、imageId、既有回执及正文 partId。

## Markdown part 与保留图片交换

下列字段仅属于 `daynight.session.v1` 的 `contentRevision:2` 的 Markdown 表示，不增加到旧 TextPart。UUID、Decimal、SHA256、ImagePart、ImageUnavailablePart 和严格对象/null 规则沿[公共合同](session-image-contracts.md)。新的 `MarkdownImagePart` 严格包含 `{type:"markdown",text,partId,revision,textSha256,complete,truncated,bindings,retainedImages}`，全部字段必填，不接受额外字段。`text:string` 保存完整正文；`type` 只接受字面值 `"markdown"`。图片表示的 `MessagePart` union 为 `TextPart | ResourcePart | ImagePart | ImageUnavailablePart | MarkdownImagePart`，其中旧 TextPart/ResourcePart 的字段保持不变；新分支只用于显示，不能作为发送输入。

| 字段 | 类型与约束 |
| --- | --- |
| `partId` | UUID；绑定本 entry 的唯一正文片段，跨修订不变。 |
| `revision` | Decimal；该片段正文的持久单调版本。 |
| `textSha256` | SHA256；准确对应 text 的 UTF-8 bytes。 |
| `complete` / `truncated` | boolean；分别表示可信完成信号和实际截断，不能彼此代替。 |
| `bindings` | 完整的 MarkdownImageBinding 数组；按 start 升序、不重叠，与该 revision/hash 的真实 AST 图片节点一一对应。 |
| `retainedImages` | RetainedMarkdownImage 数组；只保存已退出当前 bindings 的旧出现，imageId 唯一且不与当前 bindings 重叠。 |

`MarkdownImageBinding` 严格包含 `{start,end,imageId,part}`。start/end 是 text 内安全整数、`0 <= start < end <= text.length`；imageId 为 UUID，part 为 ImagePart 或 ImageUnavailablePart，且 `part.imageId === imageId`。没有真实节点、重复或额外绑定、错误 revision/hash 都拒绝；未完成节点可明确未采集，已预留才可引用 pending resource。

`RetainedMarkdownImage` 严格包含 `{imageId,sourceRevision,sourceTextSha256,start,end,part,linkHref}`。imageId、sourceRevision/sourceTextSha256 和 part 沿上述类型；start/end 为原 revision 的合法出处区间，不以当前 text 长度校验；`linkHref:string|null` 只保留原链接且经当前 href 白名单过滤，无链接为 null。保留原 entryId/partId/container/sourceKey，label 来自原 part，不复制所有旧正文。相同资源的多个真实出现各自保留 imageId。

reasoning 使用独立位置判别，不能冒充助手 content。图片表示中，其正常分支严格包含 `{entryId,entrySeq,revision,kind:"reasoning",text,markdown,imageProjectionError}`。entryId/entrySeq/revision 沿原 TimelineEntry 的身份与修订，text 保留原唯一正文；必填 `markdown` 对象严格包含 `{partId,revision,textSha256,complete,truncated,bindings,retainedImages}`，各字段沿上表，既不再复制 text，也不添加 MessagePart 的 type。`markdown.revision` 是正文版本，外层 revision 是 entry 版本，两者不能混用；textSha256 和 offsets 针对外层 text。正常分支的 imageProjectionError 必须为 null；没有图片节点也输出完整合法绑定结构，bindings 可以为空。旧 v1/v2 reasoning 仍只包含原公共 entry 字段、`kind:"reasoning"` 与 text，不接收 markdown 或 imageProjectionError。

tool_output 中的 MarkdownImagePart 保留所属工具原 callId。公共 ImageOccurrence 中的 partId/sourceRevision/sourceTextSha256 对 Markdown/reasoning 全部非 null；独立原生 image part 则全部 null。

text 与 bindings 在同一 entry revision 原子发布；旧图移出 bindings 与进入 retainedImages 也是同一事务。resource revision 更新不改变 text revision，不卸载组件或重新取源。浏览器发现 text/hash/offset 失配时停止图片读取、重取条目并保留可读文字，不自行解释 src。

整个 part 被删除时，原 entry 保留同 partId 的只读容器，text/bindings 为空而 retained 不变；整个 entry 撤回但记录尚存时保留同 entryId 的图片历史容器。原 reserved/copying/unknown 出现不能随 UI 删除，迟到 committed 原子进入原容器；确定从未采集的失败才保留 unavailable。不能产生无主 blob 或以删除节点为由释放 unknown pin。

所有当前 bindings、reasoning、retained 和撤回容器均进入统一在线/历史/content/schema3、引用闭包、授权、删除及 JSON 容量检查。完整历史实际发布时按统一 Session 内容总量检查 retained 元数据；修订超限时保留上一可读快照并报容量失败，不删旧图腾出空间。含新 Markdown part 的记录要求支持 contentRevision2 的 reader，不生成另一份降级文字投影。旧文本记录在读取边界保留完整原正文和 event/entry 序列。

### 解析失败的严格分支

图片表示的 user_message、assistant_message、tool_call 和 reasoning entry 均增加必填 `imageProjectionError:ImageError|null`，其他 entry 分支不添加该字段。它只表达该条目 Markdown 图片投影失败，不能改变工具 status 或发送 operation。正常为 null；解析超时、结构或节点预算失败时为非 null 的安全 ImageError，code 为 source_unavailable，描述该条目的图片解析不可用。TS、Go、在线/history/content 与 schema3 使用同一分支，旧表示移除该字段及所有新增承载字段，保持旧严格对象。

content/output 内的失败片段用原 `TextPart {type:"text",text}` 保留当前完整可读文字，不加任何字段；紧邻其后保留同原 partId 的只读 `MarkdownImagePart` 容器。该容器严格为 `type:"markdown"`、`text:""`、原 partId、新正文 revision、`textSha256` 为 UTF-8 空字符串的 SHA-256（64 位十六进制，不是空值）、`complete:true`、`truncated:false`、`bindings:[]` 和原 retainedImages；失败发生前仍有效的当前 bindings 图片须在同一 entry revision 移入 retainedImages，包括未决出现。该容器只表达较早图片的归属，不表示失败 text 已经成功解析；imageProjectionError 非 null 是这个组合的必需条件。没有旧图时仍保留空容器以保持原 partId。不能将失败 text 放进 `bindings:[]` 的正常 MarkdownImagePart，或发表部分 bindings。

reasoning 的失败分支保留同一外层字段集合、完整 text 和非 null imageProjectionError；其 markdown 仍严格包含 `{partId,revision,textSha256,complete,truncated,bindings,retainedImages}`，但 `bindings` 必须为 null，明确表示未得到完整 AST 绑定结果。其他元数据对应当前外层 text，retainedImages 保留旧出现，旧 bindings 向 retained 的转换与上述内容片段相同。仅该失败分支允许 null bindings；正常分支必须是完整数组且 imageProjectionError=null。这样无需另存一份 reasoning 正文，也不把空数组误当失败正文没有图片的证明。

所有失败分支关闭当前失败正文的图片读取，已有 retained 图片仍按原身份和权限读取；恢复解析成功时重建完整绑定并将 imageProjectionError 置 null，不能重新分配未改变的出现。空正文保留容器恢复成实际正文时须推进片段 revision，不能在同 revision 下换 textSha256；entry revision 同时推进。若原 writer 已停止且归档仍 settling，成功恢复是[归档最终同步](session-image-archives.md#归档准备与结算屏障)允许的确定增量，完整绑定为空也必须同步清除错误后的投影；原同步确认终态后才使用新 syncId，沿原 stopped 身份与 source 截止点，不启动新来源 IO。解析按同 revision 缓存，在独立有界任务中处理，单任务最多 2 秒，输入/节点数受既有正文及元数据容量约束；不得缩小原文本可读容量。重复失败只更新同条目错误，不无限追加 error 项。无法容纳失败分支和旧引用的完整新投影时保留上一可读快照并报告既有 timeline 容量失败，不删除旧图片引用。

## 本地来源上下文与策略

Controller 私有 contextId 绑定 origin、真实 owner、Session/execution/native 身份、来源平台、entryId/partId、可信文档目录或启动 cwd、允许根集合和 policy revision。浏览器、正文自称和工具参数不能登记 context。默认基点是已核 ticket/runtime 的 cwd；只有受信文档读取层证明正文来自某文档时才使用其目录。文档目录只改变解析基点，不扩大允许根。当前 `MarkdownSourceContext` 只从已核 ticket/runtime cwd 建立单根 context；额外 roots 和文档目录授权尚无生产输入，不能从正文或 locator 补出。

`LocalImageReadPolicy` 的默认导出范围是已授权 Session 工作目录树；额外根必须有既有原生/Session 明确授权且被导出策略接受。实际允许范围是导出 roots、当前原生读取限制和 OS 权限的交集。full access、同 OS 用户可读或工具曾成功读取不等于任意文件导出权，不能默认 home、磁盘根或全机器。

cwd/policy/来源平台或恢复归属不可信时 fail closed，报 context_unavailable/policy_restricted。恢复 cwd 改变不重定向旧 context，相同无变化权限复核不重建 imageId。范围内合法绝对路径自动采集，不能要求用户手工上传；范围外明确 source_forbidden，不新增 root 选择或提权流程。

读取前、每块源 bytes 交付前、validated 前都复核 policy；私有 prepared 副本的每个 read_capture 块也需要有效短期 policy lease。撤销与块 lease 发放串行：先撤销则不发新块；已合法交付 bytes 无法远程擦除。最后合法块交付是本地导出的线性化点，若它早于本地撤销，服务仍可在复核 Session 权限后提交；反之不能凑齐原件。copying 未知先 query，不擅删准备文件。

原生权限生产者须提供当前有效 Read 决定或可验证能力，以及足以与来源块准入排序的权限变化语义。此要求不限定上游必须导出完整权限快照或提供单块 lease RPC；完整原生判定配合可靠通知与屏障等机制，可以在证明同等效果后接入。原生 Session 由真实 RPC 实例关联，execution、导出根和已打开对象的对应由 A3 保持。原生已判定路径必须覆盖 helper 实际取得的对象；不要求原生端直接认识 Daynight executionId 或全部平台 file ID。字节复制、取消及 writer join 仍由 A3 承担。

已 committed 图的读权属于 Session/record，不因源根移除而销毁历史；账户、Session 访问撤销或删除则阻断服务读取和页面缓存/预览。只读权限不能创建 context 或重新读本地源。

### 路径分类与一次解码

在 AST destination 上按 Controller 来源平台分类一次，保存原串与解析结果；不使用浏览器 URL base，不失败降级或换平台重试。

| 形式 | 规则 |
| --- | --- |
| 相对路径 | 可信文档目录，否则原 cwd；按组件处理 `.`/`..`，合法根内回退允许，链接目标仍须授权。POSIX 反斜线是文件名，Windows 是分隔符。 |
| 绝对路径 | POSIX `/…` 或 Windows 完整盘符路径；Windows `C:foo`、根相对 `\foo` 拒绝。不拼网站根。 |
| `file://` | 只接受空 authority 或 localhost，无 userinfo/query/fragment；验证原 URI 后按来源平台转换一次。远程 authority/UNC 拒绝。 |
| `daynight-resource:<UUID>` | 必须命中同 Session 可信 destination→resource 映射；UUID 本身不授权，不能当本地路径。 |
| HTTP(S) | 交外部 locator；失败不 fallback local。`//host/path` 有歧义，拒绝。 |
| 其他 scheme、data/blob/javascript | 拒绝；native locator 只能由 Provider 可信映射产生。 |

路径最多 8192 UTF-8 bytes，拒绝 NUL、控制字符、非法 Unicode。实体及反斜线转义只由 Markdown parser 处理一次；URI percent encoding 只解一次，非法 `%`、编码分隔符/NUL 拒绝，`%252e` 不再解为 `.`。原始 `?`/`#` 按 query/fragment 拒绝，真实同名字符须写 `%3F`/`%23`；空格用 CommonMark `<…>` 或 `%20`，literal `%` 用 `%25`。

Windows 拒绝 UNC、`\\?\`/`\\.\`、NT namespace、ADS、设备名及其大小写/扩展别名、末尾点/空格，仅允许本地磁盘目录。POSIX 拒绝设备、magic link、`/proc`/`/dev` 等非普通来源；网络盘/FUSE 等不能证明稳定本地语义时拒绝。允许根按卷/句柄和实际文件系统比较，不能 lower-case 字符串前缀判断；`project-evil` 不是 `project` 子目录。

file URI 的原始/编码点段要在 URL 折叠前保留，不能词法消去 symlink 后的 `..` 而改目标。path/file URI 对照必须解析同一对象；标准转换无法保留语义时明确拒绝，不猜另一条路径。

### 授权句柄与竞态

realpath 仅用于诊断或选择候选根，不能作随后字符串 open 的安全凭据。平台 opener 从已核允许根目录句柄逐组件打开，禁止自动跟随未检查链接，保留所有已检查祖先句柄。根绑定磁盘对象及 policy revision，同名根被替换须重核，不收养新对象。coordinator 在接收 Provider 来源之前捕获并持久 `execution-root {dev,ino}`，每个 `MarkdownSourceContext.root` 保留该身份；创建 reader 时作为 `expectedRoot` 交给 helper，由实际打开根 fd 的 `fstat` 比对。延迟创建 helper 不得重新采纳该 pathname 当时的新对象；物理 cwd 别名也须核对同一原根。

符号链接可指向允许范围，最多展开 40 次。相对目标从链接父目录解析，绝对目标从另一个已授权根重新开始；展开的 `..` 用已打开祖先栈，不跨授权父边界。断链、循环、不断替换和越界有界失败。链接内容和身份必须核验，最终文件换成链接也由 no-follow 检出。

| 平台 | 必需实现条件 |
| --- | --- |
| Linux | 根内相对目标可用 openat2 的 RESOLVE_BENEATH/RESOLVE_NO_MAGICLINKS；绝对 symlink 显式重新授权，不用 IN_ROOT 改写目标。 |
| macOS | openat/fstatat/readlinkat + 目录句柄遍历及 no-follow，不能仅 fs.open(O_NOFOLLOW) 检查末组件。 |
| Windows | reparse-aware handle 检查每个组件，只接受可理解的本机 symlink/junction；其他 tag 拒绝。以 `NtCreateFile(RootDirectory)` 相对已持有父目录 handle 打开单组件，并按卷 ID/file ID 核验；共享冲突为暂时 unavailable。禁止共享写/删除不能阻止属性写句柄原地设置 reparse，逐段完整 pathname CreateFile 不足以防中间替换。 |

三者均不 fallback realpath+open。Linux/macOS helper 使用 `openat/fstatat/readlinkat` 与祖先 fd 栈，Intel macOS 使用对应 `$INODE64` ABI。Windows helper 仅以 `CreateFileW` 打开最初本地盘根，后续 cwd、绝对来源前缀、来源和输出组件均使用 `NtCreateFile(RootDirectory, FILE_OPEN_REPARSE_POINT)`，名称只含单组件，持有全部已检查祖先。内部 volume GUID 路径仅作诊断，后续打开不重新解析盘符或祖先 pathname。只共享读取以阻止源内容写入和 rename；属性写句柄仍可原地设置 reparse，安全边界来自父 handle 相对打开。只理解 symlink/junction 的 substitute name，手动展开链接和 `..`；cwd 别名最终须符合原 expectedRoot，绝对来源按实际组件到达同一 root ID 后才进入根内解析。未知 reparse tag 拒绝，共享冲突返回 `source_busy`。expectedRoot 与 Node journal 的 dev/ino 比对，遍历另保留完整 128-bit file ID。实现路径和所需真机验收仍须分别核验。 原共享锁方案的理由、属性写漏洞及替代选择见 [Windows 句柄决策](../../.agents/notes/implemented/architecture/2026-11-10-windows-image-source-handles.md)。

文件系统按句柄拒绝未知类型，Linux/macOS 当前允许本地 APFS/HFS 与 ext/XFS/Btrfs/tmpfs，并在 macOS 核验 `MNT_LOCAL` 与实际 `f_fstypename` 的 `apfs`/`hfs` 名称，拒绝扩展 flags 带 `MNT_EXT_FSKIT` 的 userspace 挂载，不把动态注册的 `f_type` 编号作为稳定类型；Linux 保持按文件系统 magic 判断。Windows 只接受 fixed 本地盘的 NTFS；ReFS 的 64-bit stat file ID 不保证唯一，在可信 execution-root 合同保存完整 128-bit 身份前拒绝。最终对象必须为本机受支持文件系统的 regular file，拒绝 FIFO/socket/设备/目录，不能在读取前被 FIFO 挂住。POSIX 使用 no-follow/nonblocking，Windows 使用 reparse-point/backup-semantics 句柄并核验 disk file 类型。不创建、截断、chmod 或提权来源文件。EACCES 显示安全 permission_denied，不泄露私有路径。

句柄授权的是当时从允许根取得的目录对象；同用户随后重命名不会改变该对象。重命名即撤权、恶意同用户恢复时间戳或硬链接原始来源隔离需要额外 OS 沙箱，本机制不声称提供进程隔离。允许目录里的普通硬链接沿该目录授权，不能凭 inode 推断全部出处。

helper 将本次真实遍历产生的来源证明交给策略消费者：原 locator 与一次解码后的路径、已持有根的身份、组件及链接/reparse 展开记录和最终打开对象身份。证明来自执行打开操作的句柄遍历，不用另一次 `realpath` 猜测来源；路径随后变化也不能将其替换为另一个对象的证明。该数据只在 helper 与 Controller 内部使用，不写入 Session journal、timeline 或对外错误。

`LocalImageCheckpoint` 的顺序为 `initial`、`opened`、一个或多个 `block`、`final`；initial 尚无最终来源对象，opened 的策略检查先于任何来源内容读取。父进程在放行前核验 checkpoint 的结构、关联、阶段顺序及证明稳定性，block/final 必须保留 opened 的同一来源。字符串必须为合法 Unicode、无控制字符且最多 8192 UTF-8 bytes；每个根或来源遍历集合最多 4096 条记录、编码最多 262144 bytes，包含消息类型的整个 checkpoint JSON 也最多 262144 bytes。追加遍历记录时即检查界限，发送及内容读取前再次核验完整证明；越限、失配或拒绝均停止来源读取。异步策略检查期间取消，仍须等 helper 真正退出，迟到检查成功不得继续 writer。证明传递本身不授予读取；实际 Provider 的单次原生判定必须覆盖该证明所描述的来源。Codex 无额外 FS 限制的子集覆盖整个可信导出根，路径型策略则还须证明其判定覆盖原路径及实际展开对象。

### 原件取得与本地资源界限

原位置 ACK、实际完整历史及私有暂存容量确认后再 open；来源权限由当前原生 Read 决定逐检查点核验。初始 fstat 记录对象身份、长度和纳秒 mtime/ctime；0 bytes 拒绝，大于 10485760 bytes 拒绝。最多 524288 bytes 一块复制，并对总上限+1 探测；结束复核同句柄身份/长度/时间/实读量，变化丢弃未提交快照，不能混拼两次文件。

该检查检测常见并发改写，不承诺文件事务快照。保存的是一次授权读取实际得到且完整解码通过的 bytes；需要严格源快照的生产者先原子发布完成文件，采集器不无界重读。实际格式由嗅探确定，有声明必须一致；公共 decoder 完整验证 PNG/JPEG/GIF/WebP/AVIF，不执行 SVG/HTML，不转码、改 EXIF 或动画。

resolve/open 每次最多 5 秒，源复制最多 30 秒（含打开），解码另最多 15 秒。可挂起调用放专用可取消 IO helper，最多两个打开/复制、一个 decoder，队列最多 32 个元数据项，后续来源从持久索引分批调度；共用公共媒体槽，不另加并发。失败关闭句柄，helper 未实际停止前不回收文件或计费。服务提交可能发生时先 query，计时器不证明未提交，正文与原生回执不等待媒体队列。

source intent 先持久原 occurrence、destination、context、captureId/attemptId、phase、started、awaitingRetry 和冷却状态，再登记 `image_occurrences`；中断后由同一 intent 补登记并等待 `imageOccurrenceAcknowledged`。ACK 覆盖原正文位置后通过公共 capture 桥持久本地原 request 并确认实际完整历史，然后执行 `reserveCaptureSource`；该顺序不需要服务 register 或 reserved。`CaptureSourceLease.runWriter` 交付调用方已创建、0600 的空私有普通文件；本地与外部 reader 都只写该文件，随后公共 `stageCapture` 完整验证并建立不可变 prepared 文件。运行中的 source writer、stage 和本机预留由同一释放入口取消、join、刷盘删除后结算。

`reserveCaptureSource` 在既有媒体账本预留来源与验证副本的最坏双份 10 MiB 空间，并使用媒体存储的 `tryAcquireMediaBlock()`。relay 的非解码媒体块也使用该入口，整个 Controller 合计最多两个槽；来源采集没有独立扩容的 semaphore。writer 与 stage 已停止、来源释放已持久确认后，即使刷新空间预算失败也须归还内存槽，预算错误仍交给调用方；重复释放须核对并回收已标记 released 的残留活动槽。join 或释放持久化尚未确认时不能提前归还。coordinator 最多两个活动来源，解析与来源索引每页最多 32 个身份，upload completion、native 与 Markdown staging 由媒体存储的同一 FIFO 队列准入公共单 decoder，最多 32 个等待元数据项；正常重叠等待已有 decoder 退出，不形成 source_capacity 失败。等待期间保留原来源文件及既有预算，不复制图片 body，取得槽后复核原 attempt、位置 ACK 与 native 目标，随后才建立验证副本。取消移除等待项；活跃工作实际退出后才返槽。

本地清理使用独立持久 `sourceCleanup`，保存原 `captureId`、`attemptId`、`pending` 和清理错误，不以服务 receipt 或 source `phase=settled` 代替释放确认。该义务在 reserve 之前保存，覆盖 reservation 已落盘但文件打开失败、尚未返回 lease 的窗口；只有原身份的 release 确认完成后才能持久清除 pending，最后清理错误与来源错误分别保留。后续 tick 先协调待清理义务，再继续服务结果恢复，因此 settled、copying、unknown 或服务查询失败均不能遗弃本地释放。查询或显式 retry 转入新 attempt 前须完成旧义务，不能覆盖旧清理身份，也不能重新读取旧源。回执引起 attempt 切换时，新身份、等待精确 retry 的状态及旧来源错误的清除一并持久化，然后再投影时间线，避免投影中断留下新身份与旧失败状态的混合记录。旧记录缺少该字段但已 started 时，按其原 request 保守补建清理义务。失败 outcome 的结果未知先查询原 capture；明确 capture_not_found 后仅可重放原冻结失败，不能因已有 staged 字节而改为提交 validated 副本。

final 来源判定通过、helper 完成复制和校验、公共 decoder 成功且 Daynight scope 仍有效后，coordinator 才持久 `sourceAdmission`，绑定原 capture/source record、attempt、实际 policy revision、来源证明摘要和完整 `ValidatedImage`。原始路径遍历证明不持久化。中断后只有 stage 文件而没有匹配 admission，不能提交，也不重新读源；必须协调原 capture 的失败或未知结果。本地与外部 `retry_capture` 先进入来源 coordinator 检查 admission，再决定能否复用 staged metadata，不能由通用 `captureStatus()` 缓存快路提前报告重试成功，使未准入的原 attempt 进入 copying。

`readCapture(input, acquirePolicy, deliver)` 只传输 admission 所对应的不可变副本，逐次核对原 attempt、完整验证元数据和当前 Daynight scope，在同步 policy lease 内读取并调用 `deliver`，验证到发送之间不跨 Promise continuation。后来的原生源限制不重新授权、改写或删除已经合法取得的副本；Daynight 访问权限撤销仍立即拒绝新交付。新 attempt 或重新取源必须重新走原生准入。

## 外部 HTTP(S) 获取

外部读取使用 Controller 专用 transport，与 Daynight 认证客户端、请求头和重定向实现分开。只处理已 ACK 的可信 occurrence，持久本地原身份、确认必要完整历史、取得本机暂存许可并核验当前外部 policy 后才向外站发请求。字节交公共 stageCapture，获取器不生成 uploadId 或 available。

### URL、DNS 与实际对端

只接受完整绝对 HTTP(S) URL，最多 8192 UTF-8 bytes；拒绝 userinfo（含编码变体）、控制字符/NUL/反斜线、空 host、zone ID、非法端口。显式端口 1..65535 仍受相同地址策略，不授权 CONNECT 或其他协议。标准 URL 解析一次，IDNA host 转 ASCII 小写、移除终止点用于比较；path/query 不排序或二次解码，不去签名参数。fragment 不发送但保留原 locator，不因去 fragment 合并出现。

IP 转二进制分类，替代 IPv4 整数/八进制/十六进制写法按最终地址判断；IPv4-mapped IPv6 归约 IPv4。仅允许普通公网单播，拒绝所有 IANA 特殊用途，即使标注 globally reachable；包括私网、loopback、link-local、CGNAT、文档/基准/保留、组播、广播及 IPv6 unspecified/ULA。NAT64 well-known/local-use、6to4、Teredo 等转换/隧道前缀和 zone ID 拒绝。分类表按固定 IANA 修订随代码发布，运行时不下载可变表。

DNS 前拒绝 localhost/子域、`.local`、单标签内部名称及元数据名称。全部 A/AAAA 和 CNAME 最终答案都检查：任一禁区地址拒绝整次；一族确定 NODATA 可用另一族已验证答案，任一族超时/错误或结果不完整则失败。CNAME 最多 8 层，最终最多 32 地址，不能 fallback 未检查 resolver。

每跳只连接已批准 IP，关闭隐含 DNS/family fallback；可在同批准集合顺序试最多两个地址，共用总 deadline。socket 建立后、HTTP 请求前核 remoteAddress 精确等于选定 IP 且仍合策略，不符立即销毁。Host 使用原主机和必要端口，TLS SNI/证书验证使用原域名或 IP SAN，验证链和有效期，不关闭校验或加载客户端登录凭据。

使用专用 HTTP/1.1，不用全局 fetch/Agent、环境/系统/浏览器代理、PAC、Cookie jar、自动认证、共享连接池、HTTP/2 coalescing 或 Alt-Svc；每跳新 socket。只 GET，不执行脚本、HTML/Refresh/meta refresh 或 401 challenge。HTTP 明文允许，保存后 hash 证明 byte 身份，不证明源站真实性。

这里的受保护目标属于 Controller 所在的可信 OS 和部署：本机地址、接口所在网络、部署内部目标及云元数据。它不要求证明所有公网站点的后端结构。普通出站 SNAT 和外部站点自己的私有后端不因此成为禁止目标；将获批目的地址转换或透明转发至本部署受保护目标则必须被阻断。应用的 `remoteAddress` 只证明所选 socket peer，不能独自证明转换后的目标。

可信本地配置声明这部分部署事实，目标 guard 再将它与当前本机接口、固定特殊地址规则共同执行。缺失、未知或失效的配置关闭新 external capture，报 policy_restricted。已保存图片继续按当前 Session 权限读取，不重新连接旧 URL，也不 fallback 服务端代理。[出口配置决策](../../.agents/notes/implemented/architecture/2026-11-10-image-egress-profiles.md)记录这项信任边界与替代方案。

### 可信部署出口配置

配置属于 Controller 本地的 `config.yml`，路径沿既有 `resolveConfigurationPaths()`：默认 `~/.daynight/config.yml`，或启动环境明确设置的 `DN_CONFIG_DIR/config.yml`。`controller.externalImages` 是独立拥有的小节，不能来自 Markdown、模型输出、URL、浏览器请求或云端任务参数。既有配置的其他小节保持原语义；图片小节严格解析并有读取大小上限，诊断不输出配置正文或凭据。配置只声明已存在的网络条件，不修改系统路由、防火墙或代理。

| 字段 | 责任 |
| --- | --- |
| `schemaVersion: 1` | 固定配置表示；未知版本拒绝。 |
| `profileId` | 本地部署配置的稳定标识；不作为图片或账户身份。 |
| `protectedCidrs` | 部署所有者提供的完整额外受保护 IPv4/IPv6 CIDR，包括内部使用的公网段、平台目标和公网别名；必填空数组明确表示没有额外项。 |
| `protectedDomains` | 额外受保护的规范域名及其子域；DNS 别名也接受同等检查，不能仅检查原始 URL hostname。 |
| `egress.mode: direct` 与 `nat64Prefixes` | 所有者声明，除完整列出的 NAT64 前缀外，当前双栈 HTTP(S) 路径不会把获批目的地址转换或透明转发到受保护目标。已知转换前缀保守拒绝。 |
| `egress.mode: enforced` 与 `policyId` | 所有者声明，指定的现有出口策略在目的地址转换后仍阻断同一受保护目标集合；标识本身不是程序独立核验防火墙的证据。 |

配置 revision 来自该小节规范化内容的 SHA-256，不能靠忘记递增的手填版本延长许可。没有可确认的完整额外目标或转换条件时不得填空数组来启用；这些是部署所有者提供的事实，不是程序从一次公网 canary、清空代理环境变量或未观察到代理进程推导的结果。

每个采集 attempt 绑定固定的策略实例。全部 DNS 候选、别名、每跳连接和实际 peer 均须通过目标检查；本机地址与接口 CIDR 是动态输入，包含公网接口和 IPv4-mapped IPv6 的等价表示。配置、网络上下文或读取可信度变化使原实例失效，取消并等待活动 socket 回收；后来的配置不能使原 attempt 自动重抓。Daynight 的账户、Session、执行和发布围栏独立生效，不能用部署配置替代它们。

每个准入点重新观察配置与接口；存在活动 lease 时，每 250 ms 另作一次观察，以取消正在等待 DNS、连接、响应头或 body 的 socket。这是观察后的失效机制，不是原子的 OS 网络变更通知。单次配置观察最多等待 1 秒，关闭 producer 也会中断等待；超时立即拒绝准入并撤销原 generation，迟到结果不能复活它。支持的配置来源是可信本地普通文件。Node 不能强制回收永久卡住的内核文件 IO，因此同一 producer 最多保留一个尚未完成的读取，由 reader 的 finally 在返回后关闭 fd，不继续叠加读取，也不把 socket 已回收表述为该文件 IO 已完成。

### 无凭据请求与完整响应

每跳从空头部构造 `Accept: image/png,image/jpeg,image/webp,image/gif,image/avif`、`Accept-Encoding: identity`、无账户信息的固定 User-Agent 及 Host。禁止 Cookie、Authorization、Proxy-Authorization、Origin、Referer、Daynight-*、用户 headers 和 TLS 客户端证书。URL query 自带令牌不能擅改，只发往原已登记 URL；URL/Location/响应头不进公共错误、日志或指标，只记录安全阶段/status/耗时/bytes/规则版本/不透明身份。

仅手动处理 301/302/303/307/308，保持 GET，Location 唯一且有效，相对 Location 只按当前外站解析。最多五次跳转、共六请求，循环/缺 Location 失败；每跳重新完整地址检查并重建空凭据头，不读跳转 body、不继承 Cookie。HTTP↔HTTPS 均可，但 HTTPS→HTTP 不延续 TLS 来源保证。浏览器始终读 Daynight 的授权原件，不依赖外站 CORS 或 mixed-content 例外。

仅最终 200 进入内容验证；204/206/304、升级和所有其他状态都不是图成功。不发 Range/条件请求，不用 ETag/Last-Modified 作历史身份。404/410 为源不存在，401/403 为无凭据拒绝，不发起登录；429/503 显示暂时失败，Retry-After 整数秒或有效 HTTP-date 最多冷却 300 秒，非法值 30 秒，用单调时钟等待，不后台无限重试。

响应头最多 32 KiB/100 字段，拒绝控制字符、重复关键头及 Content-Length/Transfer-Encoding 歧义。声明长度超 10 MiB 立即终止，缺长度/chunked 仍实读计数，第 10485761 byte 立即取消。Content-Encoding 只 absent/identity，不隐式解压 gzip/br。实体须完整终止，截断、长度不符、socket 中断不能提交；严格 HTTP parser，不用 insecure 模式。

显式 Content-Type 只允许五种 DisplayMime（合法参数可保留）；缺失或 application/octet-stream 交真实嗅探。HTML/SVG/XML 等显式类型拒绝，声明图类型与实际不符为 invalid_image。stageCapture 得到嗅探后的真实 MIME，再独立完整解码；这不改变上传声明须精确匹配的规则。文件名用安全 label 或格式生成名，不将 Content-Disposition/URL path 当本地路径。

### 网络与调度界限

| 对象 | 上限 |
| --- | --- |
| DNS / TCP+TLS / header | 每跳 3 秒 / 每连接 5 秒 / 每跳 8 秒。 |
| body / 总网络 | 无进展 5 秒；全部跳转、地址重试和 body 总计 30 秒，单调 deadline。 |
| bytes / 缓冲 | 每图 10485760 bytes；读取块最多 64 KiB、累计缓冲最多 256 KiB，等下游接收再读。 |
| 并发 / 排队 | 每 Controller 最多两个获取，计公共媒体槽；队列最多 32 项，仅 metadata，排队最多 30 秒。 |
| 开始请求速率 | 每 Session 每分钟最多 30 次、每主机每分钟 10 次，首跳/重定向/地址连接重试都计费，journal 持久冷却不因重连归零。 |

排队超时只可在确定未开始/未提交时结算 failed 并释放预留，否则 query。decoder 另有 15 秒和公共几何/帧数限制；所有超时和取消必须实际销毁 socket、停止 reader/helper 后返额度，不能只调用 setTimeout。未知 validated/copying 保留 immutable prepared 文件协调；页面卸载只取消页面读取，不取消共享采集。删除、撤权或 fence 失效中止来源，未证实提交结果前不能自行 unlink。

## 快照、已登记资源与唯一重试

同 URL/path 只是来源，不是资源身份。两个真实出现可保存不同 bytes；同 source event 重放只恢复原映射。成功后固定原 resourceId/hash，再次预览、下载或历史读取都不访问原 source。同源新内容只能通过明确新出现/记录取得，不能用“重试”改写已保存图。

coordinator 在 submit 发出前持久冻结业务 submission 与原 sealed 字节关联，并先记 unknown。原 request 保留初始 attemptId，顶层 attemptId 独立表示服务当前 attempt；requestId 与 connectionEpoch 由每次当前 relay 连接生成。重新打开 journal 后，已开始的 writer 不会重启；先查询原 captureId，copying 继续观察，committed/failed 采用原结果。只有当前授权、Session 和 fence 有效且明确 capture_not_found 时，可重放同一冻结 submission 和原 attempt 文件；缺失或损坏的 sealed 字节不能重新抓源代替。journal v12 在数据库迁移中转换未完成的旧登记、commit 和 failure 状态；只有旧登记仍未知且来源从未开始的记录，才能在原 attempt 的精确 reserved 回执后开始首次读取。冻结的旧 outcome 可在该回执后继续提交，也可在精确 capture_not_found 后重放；已开始但中断的来源不会重新读取。确定且不可重试的 submit 拒绝结束本次出现，不能转成无限 query/replay。源读取是否开始、私有文件是否存在或本地等待超时均不推断服务未提交。committed 回执先持久，再经 `media.adoptCaptureResource(captureId,attemptId,resource)` 导入本地保存原件并更新原 imageId 的当前或 retained 位置；两者都成功才将 source intent 标为 settled。任一步中断保留原身份，由后续 query 继续导入和投影，不提前把仅有 descriptor 的资源当作完整本地原件。正文删改不会让迟到 committed 换位置，也不会生成新来源请求。

`adoptCaptureResource` 要求耐久 committed 回执的 capture、attempt、occurrence 和完整 resource 严格匹配原请求，且 resource 的 MIME、byteLength、SHA-256、宽高与 frameCount 全部等于原 validated 结果。导入前取得共用媒体 IO 槽，并在来源与验证副本之外检查保存副本的第三份峰值预算，再经 `ResourceFiles.importResourceFile` 以 512 KiB 块核摘要并耐久导入。已有 available 原件只校验原 descriptor 和原 bytes；missing/corrupt 明确失败，绝不从 stage 或旧 source 修复已保存历史。导入收尾的资源删除经过正文组合层的引用检查；资源所有权与文件格式见[公共合同](session-image-contracts.md#私有文件与-journal)。

同 Session/record 的可信 resource locator 可复用 available 原件并增加出现引用，不增加 blob 槽；pending 只观察，failed/missing 不按 name 猜 path。legacy bytes在旧数据边界经原授权reader和原8 MiB限制核验，外置到同一SessionResource内核并保留原ID/hash；迁移不会授予新来源读取权，不批量抓旧路径，只有descriptor而无bytes时明确unavailable。

浏览器来源重试唯一为 `POST {base}/image-occurrences/{imageId}/retry`，严格 `{}`，回 `{capture:ImageCaptureReceipt}`；Controller 控制为 `retry_capture {captureId,attemptId}`。它只处理已登记原 occurrence、原可信 local/external locator，不接受 path、URL、headers、actor、roots 或其他 Session。新attempt须等待旧writer实际停止和staging释放，旧attempt迟到结果不能提交。当前真实 operator 须有操作权限，不要求等于原上传 actor；只读权限不够。具体返回类型和 `GET image-occurrences/{imageId}` 的 state/action/null 组合由[公共合同](session-image-contracts.md)唯一规定。

服务 action 是按钮资格依据，不按错误文案猜：pending/unknown 只 observe 原身份；committed 只 read_saved；failed 只有从未 committed、服务已确认旧 staging 清理、来源可信且当前可操作才 retry_source。POST 响应未知先 GET 原状态，不能自动重发 POST；并发按 capture 键串行。query 观察到服务已切换为新 retry attempt 时，只持久原 capture 下的新 attempt 和 `awaitingRetry`，继续观察而不启动 writer；只有服务随后下发精确原 `retry_capture {captureId,attemptId}` 控制，才能在旧 writer 退出、staging 清理并重新核权后开始该次来源读取。

| 状态/失败 | 允许的恢复 |
| --- | --- |
| submit 未知 | query 原 capture；当前授权、Session 和 fence 有效且明确 `capture_not_found` 才重放同一冻结 submission 与原 sealed 字节；超时、普通 404 或本地计时器不证明未提交。 |
| reserved 且原 attempt 活跃 | 返回进度，不并行第二次源请求。 |
| 原 writer 停止，只剩 partial staging | 先查服务，确定未提交且无活跃 attempt 后 failed/释放；显式重试才新 attempt，不 Range 续抓或拼接新响应。 |
| validated/copying/提交未知 | 用原 immutable prepared 文件协调，不换 hash/ID。准备丢失先查服务，确认未提交才可结算失败。 |
| 源暂时不存在、超时、共享占用、源变化、容量或队列失败 | 确定 failed/释放后，可显式重新准备原 locator，全套权限/网络/格式检查重做。 |
| 未提交 local/external 的 invalid_image、unsupported_media_type、decode_failed | 允许源修复后的显式 prepare；不自动循环。input 与 saved 错误仍保持 never。 |
| forbidden、permission_denied | 不得靠 retry 绕过；真实权限/策略恢复后仍需服务重新判定 action。 |
| committed 原件读失败/摘要错/丢失 | 保持原 descriptor，读失败可重读同原件；不能重新抓源修复或转成“从未采集”。 |

来源格式与完整解码的已确认失败通过 helper 的结构化错误传递，保留可重试的失败类别；进程崩溃、IO 错误或未知错误不能仅按文案归为图片解码失败。Sharp 的普通异常不能区分坏内容和运行故障，因此只有明确容器、CRC、格式、几何及完整帧检查等确认的拒绝获得内容类别；仅由 Sharp 模糊异常报告的损坏也保持 `source_unavailable`。两个活动来源占满容量时，尚未开始的 `retry_capture` 返回 `rate_limited`，relay 保留此准入结果。服务重新下发原 request/capture/attempt，不写入终态错误，也不新建来源读取身份。

重试可接受原未成功来源修复后的 bytes，但首次 committed 关闭该出现采集。未知保留原 pins，不能趁新 attempt 换资源。新 generation 不复用旧写凭据，只在可信同执行/native 链与当前授权下协调；无法证明则 context_unavailable。只读归档永远无 retry_source，只重读已保存图。最终同步可登记已经发生的本地来源和 validated 结果，但原生停止后不能启动新来源 IO。

## 显示、归档和验证边界

浏览器核正文 hash/revision/binding，再以受控节点替换原 img，移除 src/srcset；hydrate、错误 fallback 和解析失败都不能把原路径交浏览器。组件以稳定 imageId 为 key，不拼状态/hash/revision 导致卸载。linked image 的原链接与独立预览/下载入口并列，不嵌套交互元素；href 继续白名单和 noopener/noreferrer。reasoning/工具筛选不妨碍保存，图片完成不强迫滚底或展开工具。

归档闭包包含 bindings、retained、reasoning、撤回容器及迟到关联。非 null imageProjectionError 或 reasoning bindings=null 表示图片出现集合未知，必须阻止归档 sealed/ready，不能以空 retained/图片数组、完整文字或连续 source 序号认定 complete，也不能伪造 ImageUnavailablePart 凑 partial；原文字、retained 和未决引用保留，解析恢复并完整核验之前保持可协调状态，确定无法恢复则归档失败。只有确定从未采集的真实缺图可 partial；unknown、正文 gap、known available 丢失或摘要损坏均不能凑 partial。已保存原件在 Controller、源文件和外站离线后仍可按 Session/record 权限读取；这不承诺浏览器断网图库。

来源每图上限和 Session 预算沿公共合同，8 图/20 MiB 只限制用户输入，不限制一个工具或 Markdown 输出的图片总数。每个出现、失败和 retained 都计 metadata/JSON 预算；不能只采前几张而称完整。原件不转码，decoder、服务复制和摘要均须真实成功才 available。

验证须覆盖 AST 正反例和 UTF-16/定义/截断/修订；三平台真实 symlink/junction、中间目录替换、FIFO、共享冲突与取消，记录实际打开对象及关闭句柄；HTTP(S) 成功、DNS 混合/重绑定、私网跳转和实际 peer 错配，证明禁区收到请求数为零；代理环境和 Cookie/Auth/Referer 不泄漏；慢源、坏编码、10 MiB/+1、损坏动画与实际资源终止；unknown 和源 A→B 后原图仍 A；正文撤回的迟到 committed 仍有归属；所有入口、旧表示、只读与权限撤销。

URL/AST 单元测试不替代真实 socket/TLS 或 OS handle 证据，受控浏览器不替代真实 Provider，单次计时器回调不证明 writer 已停止。详细验收方法和证据层次见[验收规格](../spec/session-image-acceptance.md)。
