# Session 图片浏览器交互设计

本文定义浏览器图片交互及其接入要求。统一资源客户端、schema3 归档读取、共享图片显示、页内预览及持久图片草稿接入现有 Session 消费者。草稿上传与发送始终消费服务的当前图片能力；生产 Provider 图片 send/steer 尚未取得完整资格时保持关闭，浏览器组件或受控传输通过不能开放该资格。输入要求由[图片输入与草稿规格](../spec/session-image-input.md)拥有，显示、只读及权限要求由[图片显示与归档规格](../spec/session-image-history.md)拥有，验收边界见[图片验收与容量规格](../spec/session-image-acceptance.md)。

[公共协议与存储设计](session-image-contracts.md)唯一拥有 wire DTO、严格解析、能力、身份、错误及容量合同；本文只定义浏览器内部状态和预览接口，并消费该合同。[来源采集设计](session-image-sources.md)拥有 AST 与来源 IO，[归档设计](session-image-archives.md)拥有记录 reader。本文不扩展 Herdr、Thread、通用文件、富文本、跨设备草稿、图片编辑或轮播。采用原 textarea 与有序附件区，所有入口沿现有 Session resolver。

设计取舍和代价由[对应决策记录](../../.agents/notes/implemented/architecture/2026-11-05-session-image-browser.md)保存。

## 交互依据与状态

图片输入、预览、只读归档、不可用历史、断线、模型不支持和未知回执场景应遵循[规格的交互原型要求](../spec/session-image-acceptance.md)。原型及截图只表达交互意图，页面内存和模拟上传不能作为 IndexedDB、真实 Provider、权限、原件保存或归档证据。交互原型保存在其所属 Daynight 附件中，不作为产品资源发布。

界面遵循 [UI 原则](../ui-design.md)。控件表达可用、选中和忙碌，真实失败保留具体可恢复信息；不向用户暴露 uploadId、fence、hash、块协调或数据库术语。

Session 历史展示快照复用统一资源引用遍历，保留旧 `resource`、`image`、Markdown、reasoning 和 retained binding 的描述符闭包。快照允许保留未决投影及上一份已知图片，只保存描述符，不保存原件、URL、操作或读取资格。缓存行以只读方式展示，不请求图片原件；当前权威历史接管对应行后，资源读取继续由当前 Session 权限和共享 reader 决定。

## 草稿组件与控制流

`TaskSessionClient.imageDrafts` 持有一个 `ImageDraftController`，由现有 Session client/host 提供已认证身份和生命周期。`SessionView` 将当前 pane 的可见性和操作准入交给该 controller，`SessionComposer` 复用原 textarea、命令分类和操作入口。它不创建第二个 Session client。草稿代码位于 `packages/daynight-web/src/features/task-agent-session/drafts/`，职责拆为四个模块：

- `draft-store`：IndexedDB 原始 Blob、文本、版本、冻结提交、清理引用与事务结果；不发网络。
- `draft-uploads`：消费服务图片存储的 `api/sessions.ts` 与共享 `session/resource-client.ts`，逐图 prepare/chunk/complete/query/release；不构造 SessionCommand。
- `draft-send`：完整集合 gate、持久冻结、唯一 dispatch 权、operation 查询及同版本结算；通过现有 client 的命令入口发送，不调用 Provider。
- `ComposerAttachments` 与 draft preview adapter：选择/粘贴/拖拽、逐图错误、移除和预览；复用预览模块的 ImagePreviewController/VerifiedImageLease，不接管预览模态。

本地图片使用 `pageImageStore.createLocalAsset`，明确没有服务 `SessionResource`，与已保存图片共享字节检查、解码和页面预算。草稿仅在首次加入图片时从旧文字路径激活；已有持久 owner 在当前真实身份确认后恢复。移除最后一张图片不会丢失已激活 owner 的文字或原发送屏障。

数据流为：用户添加 → 原子保存未校验原件和有序草稿项 → 有界字节/解码验证 → 按原 owner 和字节版本保存已校验元数据 → 创建上传身份并保存 → 按服务确认偏移上传 → complete 匹配 → 显式 Send → 原子冻结操作和引用 → 一次命令派发 → 原生接受结算。保存原件不代表图片有效或允许上传；存储、上传与消息是三个结果，一个成功不推导另两个成功。

## 身份、版本与持久模型

### 草稿 owner 和发送 target

草稿归属 key 是规范 service origin + 真实 actorUserId + resolver owner kind/ID + 完整 SessionFence + expectedNativeSessionId（null 为精确值）。Task resolver 附带 projectId/taskId，独立 Session 使用 sessionId/testExecutionId；Test URL 和 Bot URL 若解析为同一实际独立 Session，应共享草稿 owner，不各建一个竞争草稿。botId 仅作为已验证关联，不进入内容身份。key 使用有版本的结构化数组编码，不能用含原生字符串的冒号拼接产生碰撞。

公共协议 `ImageTarget` 从当前已认证 snapshot 生成，不接受用户可编辑的 target。连接 epoch、historyEpoch、sessionRevision、React mount、全屏及无变化权限复核不改变草稿归属；native/generation/account 的真实变化使旧目标脱离当前发送资格。旧草稿只在其原账户和原 Session 访问权限重新确认后作为旧目标草稿可读，不自动移到新目标。owner 切换时文字与附件作为完整草稿同步切换；新 owner 没有草稿时不得留下旧图片草稿的文字作为可发送的纯文字输入。跨 Session 搬运不提供产品入口。

选择、发送及恢复读取均捕获开始时的 owner 和授权代次。异步结果先检查原身份仍有效，再更新当前状态；阻止旧结果发布不足以防止它先污染新 owner 的内存。发送准备返回后，调用方在进入发送路径的同一同步续段再次核对目标、能力与用户已查看的完整内容，身份检查之后不能跨过未校验的异步间隙。

相同实际 Session 新代次或 native 初始化变化时，旧 owner 的非空 editable 独立于未决操作发现。原发送接受、失败选择完成或取消 prepared 后，保留的草稿仍能展开查看；当前输入不会自动继承它。用户可明确选择“移到当前草稿”，确认后重新准备图片。源草稿和目标空草稿的身份、内容版本及访问代次都绑定此次确认，单事务再次核对双方权限、版本、未决操作和当前执行屏障。目标已有文字、图片或拒绝候选时不覆盖，必须先处理当前草稿。成功时完整移入原文字、有序附件和拒绝候选，建立新的 draftId、imageId/blobId，清除旧 uploadId，再由当前 owner 重新校验字节、权限与图片资格并分配新上传；源 editable 只在同事务成功后移除，旧 intent 与查询身份永不改写。移动事务失败保留源稿；提交后的字节或上传校验失败保留新目标的完整草稿与具体错误，不退化为文字发送。存在原发送 unknown 时此入口禁用，先查原 operation。其他输入先建立 native 身份时，旧 null 上传不能用于该新身份。只有公共协议明确归属于原首次 operation 的 null→native 接受结果能够结算原冻结草稿；不能用“当前已经有 native ID”猜归属。

### IndexedDB 数据

数据库 `daynight-session-drafts` 当前 schemaVersion=3，以下为浏览器内部数据，不扩展 wire DTO。版本 1、2 升级保留已有 owner、草稿、原件、上传和提交记录。版本升级要求旧连接处理 versionchange 后关闭；旧版程序再以版本 1 或 2 打开时被拒绝。版本 1 不能把新的 `recovery_only` 访问状态误当作普通撤权后重新建立可写草稿；版本 2 不能把未校验原件当作完整图片元数据读写。升级被其他连接阻塞或遇到更高未知版本时保留数据并拒绝草稿读取和发送，不删除数据库或降级重建。旧记录可能缺少附件 `incarnation`；正式授权后的读写事务在返回当前 editable 前，仅为缺失字段分配稳定值。只读读取及冻结快照保持原样，已升级到版本 3 的旧记录也按同一路径补齐。该元数据初始化保留正文、顺序、原件、上传关联、内容 revision、存储版本和保存时间；事务提交后才发布，授权失效或事务中止时全部回滚。

| store | key、值与不变量 |
| --- | --- |
| `owners` | ownerKey → accessEpoch、当前 editableDraftId、unresolvedSubmissionId、blocked 原因、持久 recoveryOnly 历史访问限制、已分配本地字节计数。accessEpoch 是本地失效代次，不是权限令牌；真正授权始终来自现有身份入口。 |
| `drafts` | ownerKey+draftId → 正 Decimal revision、text、有序 items、保存时间、editable/frozen/detached 状态、未确认放弃的 rejectedCandidates（稳定候选ID/安全label/原因）及超额拒绝数量。一个 owner 最多一个 editable 和一个未结算 frozen 提交；不会建立自动发送队列。 |
| `blobs` | ownerKey+blobId → 不可变原始 Blob、长度、byteRevision 及引用集合，明确区分未校验原件与带摘要/真实 MIME/尺寸的已校验图片。未校验记录不编造图片元数据。仅同 owner 可共享本地字节；SHA 不是授权或全局 key。 |
| `uploads` | ownerKey+uploadId →公共协议原 spec、关联 draftImageId/byteRevision、最后确认 receipt、request sequence、待协调 action/块 offset/length/hash、release intent。没有公共 receipt revision，自有顺序不写回服务。 |
| `submissions` | ownerKey+operationId → 完整不可变 command intent、原 ImageTarget、draftId/revision、提交文本/有序附件快照、相关 blob/upload 引用、dispatch 状态、最后观察 operation。草稿清除不能删除 unresolved 操作。 |

每项附件有稳定本地 `draftImageId`、本地字节版本、label、blobId 或显式 null、校验状态、uploadId 或 null。wire imageId 是该次上传和待发送图片的出现身份；服务在同一 Session 内保留它与原 uploadId 的关联，终态或释放不会让该 imageId 可供另一次上传使用。精确重试原上传保持两项 wire 标识和原 spec；确认原上传为 failed、expired 或 released 后，显式重新准备必须同时建立新的 imageId 和 uploadId。稳定的本地 draftImageId 与原件不因此改变；已发送后的新消息也必须使用新 imageId。选择相同 bytes 两次仍是两个有序项，按两份长度计入消息限制。

接纳的新候选在开始异步校验前分配稳定 blobId，并把原 File 的字节和 pending 项作为同一内容提交。原件持有与图片验证资格分开：刷新、关闭重开或切换 native 目标不会只留下无字节的 pending 名称。校验仍在事务外完成；结果只能提升原 owner、访问代次、草稿项及同一 blobId/byteRevision 对应的原件，不能复活已移除或替换的项。未校验记录不能用于上传身份分配或冻结发送。恢复时从原件重新校验；切换目标不要求旧身份继续后台解码，回到有权访问的原 owner 或明确移动到当前草稿后再恢复校验。显式移动保持 pending 状态并清除旧上传资格，由新目标完整验证后重新准备。

revision 从 `"1"` 起，对文字、附件增删/替换、显式目标重新准备等用户内容变更加一；上传进度、保存提示、查询和能力刷新不增加内容 revision。draft、upload、owner 各自有独立 storeVersion 用于 CAS；进度只推进所属 upload.storeVersion，不推进 draft.storeVersion，不引发文字冲突。owner.storeVersion只在指针/屏障/资格改变时推进；不能把 upload progress 当草稿内容版本。达到 int64 上限时只允许在无冻结提交条件下新建 draftId，不绕回旧 revision。

写入使用覆盖相关 stores 的短 readwrite 事务，按 observed storeVersion/accessEpoch 比较；Blob 和引用、草稿内容一起提交。hash/解码和网络在事务外，完成后再核对原 owner、byteRevision 和 observed revision。只以 transaction `complete` 确认保存，不以单次 put request 成功确认；关键冻结和清理请求 strict durability，仍不把浏览器存储当不可被用户删除的备份。[IndexedDB 标准](https://www.w3.org/TR/IndexedDB-3/#transaction-durability-hint)明确其耐久提示和完成语义。

本地串行队列属于当前 owner 和授权代次；切换后旧读取或网络等待不能阻塞新 owner 的恢复与保存，已捕获的旧稿保存仍按原身份结束。旧任务的迟到回调不得接管新队列。切换时捕获完整的未保存文字、附件原件和拒绝候选，包括已被 CAS 拒绝而仍待用户选择的本地冲突版本，并保留其原写入基线。目标变化不等于选择已保存版本，也不能将竞争版本授予旧内容作为新的自动写入基线。捕获内容仍作为先前草稿可见，新目标尚无持久记录也不隐藏它。后台保存失败保留捕获内容及原归属的重试入口；若另一窗口已提交竞争版本，则展开两份内容，用户确认保留已保存版本或用本窗口保留的修改替换。选择绑定这份捕获内容的唯一身份与已展示的源持久版本，后者再次变化必须重新查看；放弃只释放该捕获内容，替换只写原 owner，均不改当前输入。

同一草稿 controller 的内容写入、上传身份分配及版本读回共用该队列，包括上传回执触发的草稿读回。排队动作开始后重新核对 owner、附件字节版本和已有 uploadId，避免同时选图或恢复触发重复分配，也避免本地写入或回执读回使用自己刚推进前的旧 storeVersion。成功内容写入在队列外恢复当前草稿的上传准备，避免暂因未保存编辑退出的上传永久停留；等待已有上传后重新核对最新状态，未知请求仍沿原查询和显式恢复规则。网络上传在该队列外运行，用户编辑不等待上传完成；跨标签页竞争仍由实际 IDB CAS 决定。

操作查询、结算及发送前检查的读回都经过同一本地串行队列和内容冲突判定；发送前等待 flush 期间产生的新编辑仍以原内容版本为写入基线。远端操作状态推进不能把另一标签页已提交的 successor 版本授予本地旧内容。检测到竞争内容时，保留本地未保存版本及其原写入基线，显示冲突，直到用户明确选择。

正文输入立即更新本地显示，按每次 input 排序提交，合并尚未启动的连续文本写（最长 250ms）；IME 组合期间不改选区，保存原 text 值，compositionend 刷新。添加 Blob、Send、切换 owner、正常导航前 flush 已排队写；不依赖 unload/pagehide 最后一刻异步写保证恢复。尚未完成时是“正在保存”，失败时为“草稿未保存，刷新可能丢失”，提供“重试保存”。默认成功不显示常驻说明；只有所有最新内容提交才能撤销失败提示。

QuotaExceeded、IDB 不可用、schema blocked/不认识、transaction abort 均保留当前内存和最后成功版本。禁用含图上传/发送，允许编辑、预览、移除及重试保存；不能声称持久成功或悄悄退成纯文字。独立纯文字且未进入新图片草稿时保留旧文字路径；浏览器根本不支持 IndexedDB 时仍提供纯文字输入。具有 IndexedDB 的浏览器恢复失败时，不能证明原 owner 没有图片或未知提交，因此阻止该 owner 发送并保留错误和重试入口，不能把读取失败当成空草稿后发送纯文字。高版本库禁止破坏式降级，versionchange 关闭连接，重新打开迁移后才能继续。

恢复读取尚未完成时，正文输入、建议填入与公开 setDraft 入口均不接受新的文字修改；完成后再按当前草稿权限开放。恢复先确认账户和 owner 读取资格，再读元数据与按需 Blob；未校验原件执行完整验证，已校验原件逐项重新检查长度/hash/格式、字节引用和 target，complete 凭证也需 GET 当前状态后才获发送资格。缺 Blob、长度/hash 不符则 `bytes_missing`/`bytes_invalid` 本地状态，显示原顺序/名称并禁发，提供重新选择或移除，不以服务 receipt 冒充已恢复本地图。重新选择创建新的字节版本及上传身份；任何旧请求结果不得发布。网络离线且当前页面身份仍有效时本地预览/编辑可用；新页面还不能确认登录身份时先保持私有内容隐藏，联网确认后恢复，不凭 IDB 自报账户解锁。

### 旧文字草稿兼容

在同账户、真实 SessionFence 已确认且新 owner 无记录时，一次性导入当前 tab 可读的旧 sessionStorage text；旧 UUID revision 映射为新 draftId/Decimal `"1"`，不发送旧 UUID 到公共协议。若有旧 submission，先保存原 operationId、旧 fence 与 legacy correlation 为只查模式；未结算前不能把它变成新的图片发送。导入标记与新草稿在同事务提交后才删除对应旧 key。原 old-generation key 不被盲目全删；失效数据由下面归属清理路径处理。旧纯文字操作保持旧 wire/hash 和原恢复语义。

当前 tab 尚未接管持久草稿时，client 明确提供原 owner 的旧文字来源；图片 controller 已投影的文字不再冒充 legacy 输入。新写入的旧文字草稿按完整 ownerKey 使用独立存储槽，记录也保留该 ownerKey；native 目标变化先撤销原输入投影，不共享写入位置。既有 fence 级旧 key 只作兼容来源，首次有权绑定时补充 ownerKey 而保留正文、revision 与 submission correlation。来源位置与原值随对应 owner 保留，消费时再次核对归属和内容；另一目标的编辑、清空、发送结算或导入均不得覆盖或删除它。首次读取发现已有 owner，或另一 tab 赢得导入事务，都必须在发布任何持久内容前捕获本页完整旧稿及其 revision。非空旧稿与持久完整内容不同便显示冲突，保留原旧 key 和本页内容；比较包括附件，文字相同但另一页有图片也不算同一份稿。本地选择代表原纯文字稿，不自动附上另一页的图片；已保存选择保留另一页完整图文。明确选择以当前权限和竞争版本核对，失败继续保留两份内容，成功后才消费相应旧 key。发送前复核沿相同接管路径，不能先覆盖输入再以阻止发送代替恢复。

旧 unknown operation 碰到已有持久 owner 时，使用独立的内部恢复命名空间，按规范 owner key 与原 operationId 结构化编码；它保留真实 identity、fence、kind 和 legacy correlation，不更换原生目标。只查恢复记录与其执行屏障在事务中保存，不修改当前 editable/frozen，不持有正文、Blob 或可派发 command，也不能变成可编辑 owner。相同原操作的导入必须核对完整身份与 correlation 后幂等复用；终态记录保留去重所需 metadata，正常重开不能复活已接受内容，权限清理仍按既有私有内容和最小恢复身份规则执行。legacy revision 与原 submission revision 相同的文字属于已提交内容，未知期间不能通过本地选择重新发送；原操作接受只消费仍未再编辑的对应文字。revision 不同或后来编辑形成的后继保持冲突恢复，不受旧接受清理。选择已保存内容不能移除原操作屏障；所有未知观察仍只使用原 operationId。

## 跨标签页并发与资源预算

同源 tabs 通过 IndexedDB 事务 CAS 共同拥有事实，BroadcastChannel 只发 ownerKey/storeVersion 失效通知，不传正文、Blob、凭证或授权。通知丢失时 focus/visibility 恢复和每次写前重新读；不依赖广播正确性。尚未激活图片草稿的 tab 在发送文字或执行命令前也复核原 owner 和执行屏障；首次读取仍未完成时禁止发送；新发现持久草稿时按首次接管规则保留本页旧稿，展示完整冲突选择，不能将当前文字直接附在另一 tab 的图片后发出。两个 tab 基于相同版本编辑，第一份提交成功，另一份保留本地未保存内容并显示“草稿已在另一窗口更新”。提供“使用已保存版本”或“用本窗口内容替换”；后者重新读当前版本后显式 CAS，竞争再发生则继续保留冲突，不静默 last-writer-wins，不自动合并文字或附件。第二项只替换 editable，不能覆盖 frozen/operation。替换前仍需当前有效权限。

每个 upload 的网络变更由一个 `navigator.locks` exclusive 锁持有者运行，同 owner 的发送冻结另有锁；它们配合 IDB 持久 intent，不能以锁取代持久事实。锁名仅用 ownerKey 的本地摘要和 uploadId。禁止 steal/超时强抢；冻结 tab 仍持锁时其他 tab显示“另一窗口正在处理”，允许其他本地编辑。锁释放/页面关闭后接手者先查持久状态和原服务身份。Web Locks 不可用时图片网络变更禁用，保留文字与本地草稿，不能用不安全的 localStorage 心跳模拟互斥。[Web Locks 标准](https://www.w3.org/TR/web-locks/#introduction)规定同源 exclusive 访问及生命周期；跨进程服务去重仍由公共协议与服务存储承担。

发送屏障另以 origin+actor+SessionFence 的执行key建立跨owner索引；expectedNativeSessionId从null变为值不能绕过原未决提交。相同执行的任一旧target unresolved存在时，新owner只准本地编辑，不发新命令；原operation接受后按确切初始化关联结算并解除。新的generation不读取旧target为当前输入。历史未决操作按相同 origin、actor、resolver、实际 Session 及其原 claimId/testExecutionId 独立发现，保留原 owner、fence 和 operationId 的只读查询入口；该恢复查找不依赖当前 executionGeneration，也不把旧内容绑定到新 owner。普通消息和原生命令的准入均检查持久屏障，不能因当前内存 operation 列表为空或旧查询404绕过。

上传锁持有至本次变更已返回或等待取消完成并把 unknown 写入 IDB；即使浏览器取消 fetch，下一持有者也先 GET，不能认为服务撤回。发送只允许事务中的 `prepared → dispatch_claimed` 单次转换者发原命令；状态提交后崩溃即当可能已派发，仅查询。这样暂停旧 tab 恢复也不能与新 tab 同时拿到 dispatch 权。浏览器局部锁不取代服务 operationId/intent 去重。

首版应用本地持久预算每账户 256 MiB 原始 bytes、所有账户合计 512 MiB；计入 frozen、editable 和待清理有效引用，同 blob 不重复计费。每 owner 最多两份 20 MiB 集合（冻结加编辑），单图仍 10 MiB。到达预算拒绝新 Blob 保存，保留既有内容并显示本地存储不足；不淘汰任何未发送或 unknown 草稿。不自动设置未发送草稿 TTL，避免“重开恢复”被无提示过期破坏；移除/清空/接受/确认撤权或删除时按引用清理。用户清浏览器数据/浏览器驱逐导致丢失不能修复成假成功，恢复时明确缺失；本地草稿不承诺跨设备或永久备份。

每次选取最多对有容量的 8 个候选分配完整 Blob 准入，其余只生成有名称的拒绝结果；拒绝摘要列表至多 32 项，更多明确显示拒绝数量，发送前须显式确认放弃这些未纳入项，不能自动发已接受子集。拒绝项/拒绝数量与草稿在同一次内容事务保存，恢复仍阻止发送；用户逐项移除或明确“放弃这些未加入的图片”才解除。无法持久化拒绝结果时整个最新选择处于未保存/禁发状态，不只保存已接受子集。哈希/头部检查每次一张，最多一个 10 MiB ArrayBuffer；解码和预览使用预览模块页面协调预算、最多两个完整解码任务，不把 8 张都永久解码。新选择中超过单图大小者不读完整字节；浏览器头部尺寸预检加有界 worker/解码准入，服务和 Controller 仍作权威全验证，不把客户端成功当安全证明。文件句柄/临时 URL 只在有界候选生命周期持有，拒绝/移除即释放；原 bytes 不转 Base64 存 IDB，不转码缩小以绕过上限。

## 添加、命令冲突与预览交互

选择器设置 multiple、accept PNG/JPEG/WebP，只是选择提示；真实格式/可解码性和长度仍校验。图片按一次 FileList/clipboard/drop 中的出现顺序追加，后选批次排在前一批之后，即使异步解码完成顺序相反也不重排。先占有序候选位置，验证失败留可定位错误，其他已经接受的草稿不丢失。空文件、伪装、损坏、MIME 不符、9 张、10 MiB+1 或20 MiB+1不能发送。名称转换为公共协议合法显示 label，移除控制字符并按 UTF-8 1024 bytes 安全截断；原文件名不作路径，完整安全名称在可聚焦详情中可读。清洗后为空时按真实MIME生成 `image-<draftImageId短片段>.png/.jpg/.webp`；不得以空name调用公共协议。重选同一个文件先清 input.value，使 change 可再次触发。

只对 textarea 的实际剪贴板 File 图片项进行接管；纯文本粘贴保持默认选区/撤销栈/IME。若同次剪贴板含明确图片文件和 text/plain，则阻止浏览器默认插入后，使用编辑器受支持的文本插入路径在当前选区插入 text/plain 一次，并按 File 项添加图片；忽略 HTML img/外链，不能将 HTML 图片地址自动下载。没有 text/plain 不制造路径或替代文字；含不支持的实际文件显示对应拒绝，不能假装它是成功图片。若粘贴处正处 IME composition，保留系统组合行为，不派发图片，提示组合结束后重试。

拖拽只在当前 active composer 的范围接管真实 File 项，不递归目录、不抓 URI、不在整页覆盖其他拖动。嵌套 dragenter/leave 用计数维持一个落点状态；drop/取消清理。只读/账户待确认/隐藏 pane 拒绝图片进入，离线但已认证 active owner可本地添加。非图片 drop 显示具体拒绝且防止浏览器导航打开文件。普通文本拖放保持既有语义。

附件区处于原 textarea 上方，卡片按稳定 draftImageId keyed；上传进度不换 key、不重挂预览。可聚焦缩略按钮和独立移除/重试按钮不嵌套。有效预览可在离线、能力不支持、上传失败时继续查看本地 bytes。移除更新精确当前 editable revision，取消订阅、登记服务 release 意图；它不是撤销冻结发送。已移除图的迟到回执只能用于清理原上传，不重新插入草稿。

预览模块的 `open({scope,asset,label,trigger,fallbackFocus})` 消费稳定 draft asset handle；adapter 的 `acquire` 返回自己已校验原 Blob 的 VerifiedImageLease。模型变化、上传进度、断线不换句柄；字节替换、删除、账户/owner 变化触发失效。预览、fit/100%、下载、焦点和滚动完全由预览模块实现。接受后若预览仍开，可将该 lease 转成仅页面临时引用再删持久草稿；无法保持则 close('asset_removed')。回到 textarea 的 fallback 仅限仍 active 同 owner。打开预览同步关闭命令菜单/键盘提示，停用 Composer 的全局 Escape capture；预览的 Escape 先关闭内层，不被旧提示抢走。

含图时，先用现有 `classifySubmission` 区分 message/command/invalid。真实斜杠命令、保留的无效菜单 intent 拒绝图文组合并保留全部草稿；命令菜单选择也须在替换 textarea 或执行命令前阻止。无匹配命令且无 intent 的 `/path` 仍为普通消息，可以带图，不能退回“所有 / 都禁止”。`/model`、`/permissions` 文本命令带图也不清正文；直接工具栏设置不消耗草稿，按原 controls gate 运行，确认变化后重新检查图片资格。审批回答和表单由原响应路径提交，永不读取/附加 composer 图片，完成响应不清图片草稿。

## 上传状态与恢复

本地校验、持久化、网络准备是正交状态。UI 不用一个 ready 布尔值混淆；发送资格从全部事实派生。

| 上传状态 | 用户可观察行为与转移 |
| --- | --- |
| local/preparing | 字节已保存但无上传确认；联网且 target/能力有效后可自动准备，上传本身不启动回合。 |
| receiving | 只按 acceptedOffset/byteLength 显示已确认进度；浏览器已写 socket 的 bytes 不算确认。 |
| verifying | 块已齐全，显示校验忙碌状态；100% 不能使 Send 可用。 |
| complete | 严格匹配 uploadId/imageId/target、spec 名称/MIME/长度/hash、available resource 元数据及 offset，且当前资格未过期，才用于发送集合。 |
| upload_outcome_unknown | 查询原 uploadId；不重造 ID、不用 timeout 当 failed，不允许发送。 |
| failed/expired/released | 按公共协议code/retry 显示修复、重新选择或显式重新准备；failed 不原地重开，新的准备同时使用新 imageId 和 uploadId。 |
| disconnected/target_detached/access_blocked | 暂停新写；离线保留本地编辑，目标脱离需显式重新准备，确认撤权立即清敏感显示。 |

显式终态重试在一个 IDB 事务中复核 owner 的访问代次、当前 editable、附件 incarnation/原件、原上传版本、已确认终态以及不存在 pending action 或 unknown，再同时替换附件的 wire imageId、uploadId 和新上传记录，登记旧上传的释放意图。事务失败保持旧绑定；竞争标签页不能各自分配一份替换。该操作保留本地附件身份、Blob、字节版本、顺序、正文和内容 revision，仅推进存储版本。本地编辑和退休稿的读回须一起吸收两项 wire 标识，避免后续文字保存写回旧 imageId。旧请求仍只影响原上传账本，不重新绑定当前附件。

创建身份/spec、当前块边界/摘要及 complete/release intent 均先持久保存再请求。每 upload 一个变更请求，最多两个不同图片的数据块在途，并与预览模块读取共享服务图片存储的 Session 两块额度；消费者不能各给两个。每次请求的本地 sequence、owner accessEpoch、target、imageId/byteRevision 匹配后才发布。GET 迟到不能回退 offset 或用 receiving 覆盖 complete/released；已知 complete 后服务可能因到期/显式释放变为 expired/released，只有后发起且仍匹配的权威观察能收敛该终态，不能一概把 complete 当永远不变。

断线后恢复先验账户/同 target，GET 原上传。receiving 的新 offset 从此续传；偏移未前进可按已登记同块精确重传；verifying只观察或按服务图片存储协调原 complete；complete 匹配后复用。创建响应丢失后 GET 404 不是写未发生证明；允许在仍相同 target/spec 下精确重复 PUT 同 uploadId 由服务图片存储去重协调，不能换 ID。查询失败保持 unknown。明确 rejected/failed/expired/released 且本地 bytes 可用时，用户“重试”按错误分类新建准备；未知请求按钮写“检查状态”。Retry-After 沿服务图片存储，普通观察用 1/2/5/10/30 秒退避，每轮最多 60 秒后保留状态与手动检查入口；focus/连接恢复可重启观察，不重发消息。

能力变化先暂停新块并观察原 receipt，不释放仍有效 bytes；同 target 且仍 supported、原 MIME/长度合格可继续准备。更小集合上限不偷偷丢图，整组 Send 禁用；指出当前上限，由用户移除/替换。upload complete 不携带永久模型许可，最终始终用最新 image capability revision。过期显示以服务判定为准，客户端时间只作提前查询提示，不自行延长 expiresAt。

本地原件与远端上传账本分开保留。只有 editable、frozen 和未决 submission 的真实引用占用本地 Blob 及持久字节预算；单独的 release intent 不持有本地原件。最后一个本地内容引用移除后，在同一事务删除 Blob 并回收计量，但保留上传身份、请求未知状态及 release intent 供远端对账；旧 native owner 不再成为当前目标也不阻碍本地回收。同授权恢复范围在冷恢复时重新核对本地内容引用，回收旧版本曾仅因 release intent 保留的孤立 Blob；不修改远端账本，不越过当前访问权限或待清理屏障。移除/清空提交本地 tombstone/release intent 后，尝试服务图片存储DELETE。响应未知先 GET；receiving/verifying/complete 可重做相同显式释放，released 确认结束；upload_in_use 保留 operation 对账，不强删服务资源。旧目标或撤权无 DELETE 资格时停止写，由服务 TTL/所属生命周期清理；不声称 bytes 已删除。释放登记独立于已移除卡片，不能为了后台清理让图重新出现。

## 发送事务、编辑和未知结果

含图资格消费公共协议的 `geometry:{version:1,known,maxWidth,maxHeight,maxPixels,maxFrames}`，宽高按存储画布，帧数按完整解码。known=false 或模型/上下文限制缺少可证明包络时，send/steer 不能 supported。每个 available 资源的 `frameCount` 必须为 1..256 并与原件 hash 绑定；本地预览未完整遍历时不能伪造帧数，发送消费上传 complete 的双端校验结果。Provider 已知更小限制与通用限制取交集；模型、权限或实际上下文变化重算 revision，保留草稿重新核验，不偷偷继续使用旧 profile。

含图 Send 同时要求：原 sessionSendGate、当前 auth/active、无本地/跨 tab 未结算提交、持久保存最新内容、无拒绝候选/缺 bytes/失败图、完整有序集合≤8张/20 MiB及每图≤10 MiB（与原生更小上限取交集）、每图当前 complete、同 target、最新图片能力 idle send 或 working steer 为 supported。未知或不支持禁用，不推断默认模型 vision。控件 pending/recovery/initialInput 原门禁保持；上传可为工作回合后的 idle 准备，但不会扩展队列、取消回合或自动发送。

纯图序列只有 ImageInputPart；图文为一个非空白 TextPart 后接有序图片，保留用户原文字值、不插入文件路径。纯文字走公共协议旧 payload 分支。移除最后一张图片后，原草稿仍是持久草稿；消费其正文的原生命令也必须冻结精确 draftId/revision，取得唯一派发权并按原 operation 结算。命令保持 execute_command 的原参数，不改成普通消息或附加图片；工具栏等不消费正文的命令不清草稿。未知命令跨刷新只查原身份，接受只清原冻结版本，后续编辑继续保留。含图 gate 失败不得删除图再试纯文字。下述动作是原子边界，不是跨网络事务：

1. Send 再 flush 文本/候选保存，在 exclusive send 锁内重读 owner、editable revision、最新资格和 operation 状态。IDB 事务验证 CAS，将完整不可变 command（新 operationId/requestId、target、capability revision、expectedTurnId、draftId/revision、有序 parts）与冻结快照和所有引用一并保存，建立 owner 发送屏障。失败则零网络派发。
2. 单独短事务把 prepared 变为 dispatch_claimed，只有该次成功转换的调用持有一次 dispatch 权。事务结果未知时先读本地事实但不因此重复发送；重载看到 dispatch_claimed 一律查询原 operation。若在转换前可证明 prepared 未被领取，恢复也不自动发送，只提供用户再次确认原冻结提交的入口。当前命令目录或发送资格变化时，恢复派发可以禁用，但仍提供取消入口；当前或旧 native 目标中尚未领取的待发消息/命令均可显式取消，私有内容仍保留时恢复原目标 editable 草稿；内容已按权限清理的 recovery_only 记录只解除原操作屏障，不重建草稿；取消事务必须再次确认 prepared，不能解除另一窗口已取得的 dispatch claim，也不把旧图片资格移给新目标。
3. dispatch 权持有者在实际请求前再次核对当前账户/owner/target、能力和是否仍 live。若确定尚未调用请求就发现变化，可持久记录 local_not_dispatched 并解冻；否则只以原 command 调现有 client 一次。client新增接受已冻结 command 的内部派发入口，不调用会重新生成operationId的旧execute(input)；同一身份由冻结事务一路保留。发布后按下一项区分确认拒绝和未知，不自动重新编号或重发。
4. accepted/offered/dispatching 只观察；provider_accepted/confirmed 才按原 owner+operationId+target+draftId/revision 结算。operation 读取先解析协议/fence/ID/kind，target 从不可变本地 intent 关联，而非假定 operation 回执新增 target 字段。可信的 rejected/failed/expired 未提交终态解冻保留尚未按权限清理的内容。对首次提交的确定性拒绝，只有经认证/表示/严格错误解析、且公共协议服务分支保证 operation 未登记且未派发的响应，才能归为本地 definitive_not_dispatched，保存原拒绝并解除屏障。当前 `operation-error.ts` 只接受命令接纳端点经认证严格解析的 `409 capability_changed`：服务先返回已存在 operation 的原事实，再在新操作登记前检查该能力 revision。即使服务没有 operation 行，也允许用户修复后以新 operation 显式发送。不能简单按所有 4xx、任意同名 code 或错误 message 推断；operation_conflict、通用 401/403/404、预算拒绝、代理错误、解析失败、5xx、超时及响应丢失都不属于当前分类，只查原身份。扩展分类须先验证对应服务分支保证。公共操作恢复模块拥有确定拒绝分类的唯一语义，草稿发送模块消费内部分类，不向 wire error 私加字段。

服务接纳前先按原 actor/Session/operationId 查询已有操作，再检查会变化的 target、model 和预算。已有操作只返回原事实或 operation_conflict，不能以新的 capability_changed 把原操作伪装为未派发。已登记操作的 rejected/failed/expired 也不天然允许新发送：只有持久证明没有原生调用，或精确原生 profile 证明已经调用但未接受，才能作为可修复拒绝；后者不得计为调用数 0。无法证明未接受的 SDK 异常保持 unknown。接受后的部分附件交付失败保留在原 operation 和消息中并关闭有问题 profile，不能退为普通 rejected 或只显示瞬时提示。

发送后原冻结内容继续在同一 composer 可查看（含图预览），不能在 service accepted 时清空。用户点“继续编辑”才显式创建空的 successor 草稿并把原冻结快照缩成待确认摘要；原文字/附件仍可展开查看，只有一个活动 textarea，没有第二套编辑器。新输入进入新 draftId，不自动拷贝旧图片。successor 可以本地保存和准备图片，但原操作 unknown 期间 Send/再次新建 successor 禁用；不是队列。用户不点继续编辑则保留原只读草稿，接受后清理该版本并显示空编辑框。

原生接受结算在单事务中为原 submission 记已接受、清理仅匹配的 frozen draft、移除它的本地引用、释放 owner 屏障；已有 successor 的文本/图片/revision完全不改。界面立即与持久状态一致更新，存储结算失败时显示“已发送，草稿清理未保存”，保持发送屏障并重试本地结算/查询，不再派发。恢复原 frozen 后查询同 operation 得到接受再幂等清理。同一提交不存在按“文字相同/摘要相同”认领的规则。

明确未派发失败：没有 successor 时恢复原 editable；已有 successor 时保留两份内容，原 frozen 变为待处理失败稿。提供两个有明确放弃对象的操作：“保留当前编辑，放弃失败稿”或“恢复失败稿，放弃当前编辑”；提交选择前展示两份内容的文本摘要和图片数量，允许展开查看，取消不修改任何一份。恢复项绑定原 owner、operationId 及两份草稿的内容版本；确认期间条目、权限或版本改变则要求重新查看，事务内再次比较后才处理引用。旧 native 或旧 generation 的失败稿也保留此入口；只更新原 owner 的两份草稿及其屏障，不将任何一份自动替换当前 owner 的输入。第一项删除失败稿引用并保留successor，第二项删除successor引用并将失败稿恢复editable；不自动合并、不产生第三份草稿。在处理失败稿前不建立第二个提交。服务释放原 operation 占用由公共协议与服务存储完成，客户端 DELETE不能假冒结算。原生失败终态如无法保证未接受，按 unknown处理。

unknown 时保留完整 intent、快照、bytes、引用和原操作入口；前后台使用原 operation 查询，轮询超时不解除发送屏障。页面关闭、刷新、Bot pane 驱逐只结束当前观察。权限或目标改变时，通过原 owner 的正式只读查询入口观察，不能对新 base 查询旧 ID，不能从旧 404 判定未发送。

`GET {base}/operations/{operationId}` 保持原 `{operation}` envelope。服务先验证原 actor 对原 Session/历史所属项目或独立记录的当前访问权、parent credential 和删除屏障，再返回原 fence receipt；任务当前 claim 不同不取消合法历史查询，不要求 Controller 在线。此读取不创建或补发 command，不把旧 target 绑定当前 Session。无法读取时显示原发送结果仍未知，保留原身份且不重投。浏览器从原冻结 intent 恢复 target/draft 关联，不假设 operation 回执新增 target 字段。

## 账户、撤权与清理

恢复和每次网络/本地发布都使用既有 principal 屏障。账户生命周期及私有内容清理由现有 `AccountSessionProvider` 统一拥有；草稿清理失败进入同一重试入口，冷 Session 的失败也保持可见。账户变化等待刷新暂停新上传、发送、下载及正式重新授权，保留已显示草稿及其本地编辑、预览、焦点和已解码图片；不自动重读或重传。已加载 owner 的本地编辑仍按原 accessEpoch 与 CAS 保存，不能解除另一个窗口写入的清理标记；清理后保存被拒绝，正文仍保留在页面并明确报告未保存。真实访问撤销、Session/record 删除或会话失效时同步关闭预览、清 src、撤销 URL、停止请求和 owner 使用，再做异步持久清理。

将 owner accessEpoch 递增/blocked tombstone 与删除相关 drafts/blobs 的事务序列化；旧异步写回必须检查 epoch，不能在清理后重建。账户变化等待刷新保留当前内容但阻止新的远程工作；真实会话失效只清原账户私有内容，不枚举或显示给新账户。新的 tab 对另一账户只能经正式身份确认打开对应 owner；广播提示接收方重读当前账户记录，网络响应仍执行 principal 检查。已提交请求与撤权的先后由服务决定，浏览器 abort 不声称撤回 Provider 已接受数据。

对 unresolved 操作，真实会话失效或撤权可以删除敏感正文和 Blob，但保留不含正文、图片label/摘要/凭证的最小 owner+operationId+fence关联 tombstone。原账户正式重新获权且清理完成后，按相同 origin、actor、resolver、实际 Session 及原 claimId/testExecutionId，将合法历史记录开放为 `recovery_only`，仅纳入不高于当前已验证代次的记录。已经领取派发或结果未知的操作只查询原 fence 和 operationId 并按原回执结算；prepared 记录不查询、不派发，只能按原操作明确取消，避免其永久占用同一执行的发送屏障。当前 executionGeneration 或 native 目标变化不应使这些原操作永久消失。

每次正式确认 Session 操作权限后的草稿加载和发送前复核，都先幂等协调该恢复范围的历史 tombstone，再发现原操作和执行屏障。同 owner 从只读恢复操作权也重新执行协调，不要求授权代次一定变化；事务开始和提交前均复核原 controller、owner、授权代次和当前操作权，期间失效便回滚，不能用早先捕获的权限清除后来建立的撤权屏障。此步骤不依赖当前 owner 是否存在、是否可读或是否抛出 blocked，也不依赖账户级清理标记仍然存在；登录后先打开其他 Session 不能隐藏本 Session 的原操作。重复协调不推进已开放历史记录的 accessEpoch，不使其他标签页持有的原查询身份失效。当前 owner 不存在时仍返回空记录，不为未激活的纯文字路径创建图片草稿。

`recovery_only` 由存储层统一限制：保留原操作身份和执行归属，不开放普通 owner 读取、编辑、上传、冻结或领取派发；查询结算或取消也不建立旧 owner 的新 editable。这一历史访问限制独立于后续撤权原因保存；操作结清、再次注销或重新验证均不能使旧 owner 重新变成可编辑身份。它不恢复已清除的正文、图片或上传凭证，不把旧代次重新授权为发送目标。其他账户、服务、Session、resolver 或 claim/testExecution 不共享此恢复资格。服务 unknown引用仍按公共协议保留。若所属 Session 被正式删除，停止后续查询并清本地 tombstone，重新验证也不能解除删除屏障；不能据此声称原生从未执行。IDB 清理失败保持 blocked 并报告本地清理未完成，后续打开先完成清理，不先渲染；不得用“已删除”掩盖失败。

普通移除、清空、接受只删除没有 editable/frozen 引用的本地 Blob；预览模块页面 lease 独立释放。卸载/全屏切换/冷 pane 驱逐不删除持久 bytes。服务资源由服务图片存储引用集合清理，草稿模块最多释放上传引用；消息/unknown/归档引用不是前端 GC 对象。

## 响应式与入口一致性

桌面和390px共享 DOM与交互。附件区 flex/grid可换行，限制自身高度并内部滚动，给 textarea、动作栏和时间线保留空间；输入区最小高度只计入自己的直接错误提示，不重复计入附件或历史恢复条目的内部错误。尺寸观察回调引起的最小高度写入合并到下一动画帧，并在卸载时取消，避免在观察器分发期间再次改变被观察元素的尺寸；软键盘/visualViewport变化重新计算可用高度，不把全页撑出横向滚动。长名省略但键盘焦点可读完整安全label；主要图片操作目标≥44px，缩略预览、移除、重试均有文字可访问名称。进度 aria-valuenow按确认偏移更新并节流公告；校验中用aria-busy，失败有具体修复动作，不逐块刷屏朗读。遵守prefers-reduced-motion，不依赖hover查看失败理由。

Enter/Shift+Enter及平台快捷键沿主线，IME期间不提交；纯图点击/快捷键走同一gate。Send只表达当前准备/提交资格；原因不明显时提供可聚焦说明，真实失败保留行内错误。既有session状态提示只显示一次；不向用户暴露uploadId、fence、hash、数据库或块协调术语。取消回合仍是独立原控件，不移除草稿或替代取消上传。

| 入口 | 草稿、输入及共享预览接线 |
| --- | --- |
| Task 弹窗/独立页 | TaskSessionHost→TaskAgentSession→SessionView同owner，原项目/Session操作资格；正常离开/重开恢复同持久草稿。 |
| Test | TestSessionPage→SessionView，独立sessionId/testExecutionId，null首次native规则完整适用。 |
| Bot | features/bots/BotSessionHost→SessionView，实际选中的独立Session；隐藏pane停止新上传/观察、释放页面lease，持久内容留存，重新激活先核身份再续准备。 |
| Session/Task全屏 | 复用原draft controller/client/预览模块 host，切换不上传、不改revision；Escape按预览→Session全屏→外层处理。 |
| 历史选择器/附件NativeRecording | 只读预览模块预览，无composer/草稿绑定/上传；打开历史不得自动把旧草稿转入record或删除仍有效的当前草稿。 |
| Herdr | 不建立图片草稿、上传或paste图片转换路径，终端语义保持。 |

## 预览组件与数据流

`SessionImageScope` 在每个 live Session 或只读 record 展示 owner 上建立一次，包含当前身份/授权适配器、资源索引、共享读取 store 和预览控制器。身份不随 React render、连接 epoch、权限无变化复核或全屏切换重新创建。账户、真实 owner 或表示改变属于新的 scope；旧 scope 立即失去准入。

- `SessionImageStore` 消费现有 Session client 或固定记录 reader，拥有完整验证、请求合并、Blob lease、取消、错误和内存预算。分块读取和块校验属于统一资源 reader；真实响应体进度刷新无进展时限。它不决定来源采集，不自行创建 Session client。
- `SessionImageFrame` 拥有缩略展示、尺寸框、解码状态、可访问错误及动作；输入是稳定出现和 store 状态，不是 URL/path。用户、Agent、工具、Markdown 与 retainedImages 复用它。
- `ImagePreviewHost`、`ImagePreviewController` 与 `useSessionImageScope` 定义本专题公共 UI API，负责一个展示 owner 的页内预览、缩放、焦点、滚动和下载；草稿消费者通过同一 asset/lease 合同接入。
- `SessionMarkdown` 连接 Markdown 来源采集的正文映射与 SessionImageFrame；`ChatMarkdown` 只接收已验证的纯渲染回调，不获取权限、解析 Controller 路径或发网络请求。
- live/record/draft adapter 各自提供可读原件与撤销信号。record 不依赖在线 Controller，draft 不伪造服务资源。

读取流为：真实出现 → owner 校验与 descriptor → store 合并读取 → 校验全部块及完整 SHA → 创建受控 Blob → 浏览器解码 → 原位置展示。打开预览获取同一 lease，下载同一已校验原件。每一异步完成都检查 scope、resource identity 与请求代次；旧结果不能写进新账户、新记录或新出现。

## 公共预览接口（仅浏览器内部）

浏览器接口由 `features/task-agent-session/images/image-types.ts` 与 `image-preview.ts` 实现，不属于 JSON 或服务 DTO。以下列出消费者需要的核心成员；`ImageScope` 与 `ImageAssetAdapter` 由当前 owner 的适配器创建，调用方不能通过字符串、URL 或 SHA 构造授权。

```ts
type PreviewCloseReason =
  | 'user' | 'owner_inactive' | 'identity_changed' | 'access_revoked'
  | 'asset_removed' | 'host_disposed';
type PreviewRequest = {
  scope: ImageScope;
  asset: ImageAssetAdapter;
  label: string;
  trigger: HTMLElement | null;
  fallbackFocus: () => HTMLElement | null;
};
type ImagePreviewController = {
  open(request: PreviewRequest): void;
  close(reason: PreviewCloseReason): void;
};
type VerifiedImageLease = {
  readonly blob: Blob;
  readonly mediaType: DisplayMime;
  readonly byteLength: number;
  readonly sha256: string;
  readonly storedSize: { width: number; height: number } | null;
  readonly valid: boolean;
  decode(signal: AbortSignal, priority?: ImageReadPriority): Promise<DecodedImageLease>;
  subscribeInvalidation(listener: () => void): () => void;
  release(): void;
};
type ImageAssetAdapter = {
  readonly scope: ImageScope;
  readonly key: string;
  acquire(signal: AbortSignal, priority?: ImageReadPriority): Promise<VerifiedImageLease>;
  subscribeInvalidation(listener: () => void): () => void;
  canRead(): boolean;
  canDownload(): boolean;
};
```

`ImageReadPriority` 区分 `background`、`preview` 与 `download`。live scope 从真实 Session fence/native 身份与账户构建；record scope 使用实际记录命名空间、记录 ID 与所选归档摘要。固定记录的状态与内容使用同一份已核对的状态验证，不能以第二次状态读取替换所选表示。认证复核期间 `readAdmitted=false` 阻止新读和下载，已经显示的同身份内容保持；权威撤权通过 scope 失效同步撤下表示并等待读取、解码实际结束。

账户刷新停止入口同步撤销 live 和固定记录的远端读取准入并关闭 reader，保留同一个 scope 和已解码 lease；迟到的读取不能发布。该入口不可恢复，不借用临时认证复核的 60 秒连接宽限。真正撤权或记录离开仍调用破坏性的 scope 失效，根 owner 负责选择策略。

格式验证先核对完整长度、摘要与 PNG/JPEG/GIF/WebP/AVIF 容器，再发布原件 lease。解码单独报告本地失败并保留仍获授权的原件下载。支持 `ImageDecoder` 的浏览器遍历所有帧；仅在容器已证明静态单帧时才使用 `createImageBitmap` 后备路径。多帧或帧数未知且缺少完整解码能力时明确显示本地解码失败，不把第一帧成功当成完整验证。

`open` 同步建立模态并立即显示图片框/加载状态；读取可异步完成。相同 scope+asset 的重复 open 只聚焦现有预览，不重置缩放、读取或创建第二个模态。不同图片替换当前内容，释放旧预览 lease，初始回到 fit；旧读取即使晚到也不能替换新图。每个 host 同时只有一张图；跨图片轮播不是本期要求，调用方保留原有多图顺序。

`close` 幂等，取消预览本次订阅、释放 lease，不取消仍被卡片使用的公共读请求。仅 user 关闭尝试返回触发点；其他关闭原因由仍有效的上层 owner 决定焦点，不能把焦点送回撤权或隐藏界面。回调只在关闭时调用，不持有已销毁 DOM 树。host 卸载解除所有订阅。

句柄身份：saved 为真实 scope+命名空间+resourceId+hash，出现另保留 imageId；legacy 为 scope+legacy resourceId+hash；draft 为账户+真实 Session 草稿 owner+稳定 draftImageId+本地字节版本。`label` 只作显示，不是 cache key。草稿模块为同一草稿字节版本复用句柄，上传进度不改句柄；只有删除、字节替换、账户/目标归属改变才撤销。上传、模型变化或离线不会把仍可本地阅读的草稿误判成字节不可读；发送资格由草稿模块独立管理。

草稿模块的 adapter 从自己已验证的原始 Blob 获取 lease，并负责持久化/删除引用；预览模块不接收 upload receipt，不移除草稿，不产生 send。草稿发送后仍打开的预览可保持这份本地 lease 至用户关闭，前提是相同账户/owner且草稿模块明确转移其引用；若草稿模块无法保持则关闭为 asset_removed。不能借 UI 持有阻止草稿模块清理持久草稿；lease 只保留页面所需 bytes。

## 资源与浏览器状态

公共协议的 `ImagePart`、`ImageUnavailablePart`、`SessionResource` 原样消费。`imageId` 是出现身份，`resourceId` 是原件身份；两个出现可以共享原件但不共享消息位置。available descriptor 的 MIME、长度、SHA、存储尺寸和 frameCount 不可变。资源更新用 decimal revision 比较，旧 revision 不覆盖新状态；同 available ID 出现不同身份元数据视为合同错误，停止读取并重取所属条目，不接受换图。

| 服务事实 / 本地状态 | 呈现及允许动作 |
| --- | --- |
| 完整 Markdown 语法尚未确认，或服务 pending | 保留位置，显示有名称的加载框；不将原 src 交浏览器，不启动来源读取；轮询/事件只观察状态 |
| available / idle、queued | 有尺寸框，进入可视范围后排队读取；打开预览/下载优先；不预取所有历史 |
| available / reading、verifying、decoding | 保留同一 DOM 框，细粒度状态交辅助技术；忙碌操作禁用；未完成 SHA 验证前无 src、无下载 |
| available / ready | 原位置显示，点击预览，下载原件；显示与下载不取决于 images.send/steer |
| available / read_failed | 显示读取失败；显式重新读取同资源。仍有同身份已验证缓存时可继续使用它，临时失败不把原件降为 unavailable |
| available / browser_decode_failed | 显示“此浏览器无法显示这张图片”；同字节可显式重新解码，不重新下载或重新抓源；完整校验且仍有权限时保留下载原件 |
| digest/长度/块格式不一致 | 丢弃本次未验证 bytes 和 URL，显示校验失败；不可下载，不自动循环；重取服务事实后由正式错误资格决定恢复 |
| failed/unavailable 或 ImageUnavailablePart | 留在原消息/原工具位置，显示安全错误；适用来源重试只由服务明确资格提供，只读记录无此操作 |
| 暂时权限复核 / 已知无变化 | 保持已显示图片、锚点和预览，冻结新的读/下载/来源重试；复核成功后复用原 lease，不重挂 |
| 账户变化等待刷新 | 停止请求和下载，丢弃旧响应，保留已解码图片及当前预览直到真实刷新 |
| owner 删除、确认撤权或真实会话失效 | 立即关闭敏感预览、清除 src、撤销 Blob URL、取消请求和下载资格；旧响应丢弃 |

网络失败不证明权限撤销；确认撤销也不能当普通离线。长期未恢复的未知身份沿现有认证流程，不能使用旧授权发新请求。执行 generation/native 变化时 live adapter 先隔离旧 scope，旧消息若仍可读取需由新的正式 owner 读取授权重新确认；已保存 record 的 scope 不绑定新的 live generation，不能错误删除有效归档缓存。无变化权限复核与这些真实变化必须区分。

错误主要使用本地化 code 映射及安全 message，不暴露 URL query、绝对路径的额外副本或内部堆栈。失败框有 label 和适用动作；加载只使用 role=status/aria-busy，失败使用节制的 live region，避免每个分块或每次 render 重复朗读。

## 读取、缓存、容量与下载

saved reader 由真实 Session/record resolver 得到 base，使用公共协议的 `GET {base}/resources/{resourceId}/content?offset&limit` 和内容 revision header，每块至多 524288 原字节，每 Session 最多两个媒体块在途。只接受规范 Base64、连续 offset、相同 resourceId/hash/byteLength、精确 EOF；最终 SHA 对完整原始 bytes 计算，不能对 Base64 或像素计算。不得把 10 MiB 图片塞回旧 8 MiB raw resource reader。HTTP `private, no-store`，不放 Service Worker、共享 HTTP 缓存或 localStorage；草稿模块本地草稿持久化是另一责任。

缓存键为规范 service origin、真实 accountId、owner kind+owner ID、读取表示/legacy 命名空间、resourceId、sha256；live owner 还含当前 Session 的授权身份边界。recordId 不能替成 taskId/botId，resource UUID/hash 不能作为权限凭据。epoch 改变不改变已确认相同 owner 的内容身份。单次读取的请求合并、lease 引用计数和最后使用时间独立于 React 卡片。一个消费者卸载只释放自身 lease，最后一个等待者取消才取消尚未完成的请求。同一原件的新消费者在旧请求取消后重新进入时，等待旧 reader 和 decoder 真正结束，不能继承旧消费者的取消错误，也不能提前归还旧预算。等待期间新消费者、asset 或 scope 失效立即拒绝；结束后重新核验当前权限并走普通合并与准入，没有存活消费者则不再读取。

浏览器预算采用页面级协调器：压缩原件 Blob 上限 128 MiB/32 项，每个 owner 上限 64 MiB/16 项；在途完整缓冲计入预算，预留成功后才读取。单图仍支持 10 MiB。先释放不显示且无 lease 的 LRU；同一图消息卡片/预览/下载共享 Blob。只预取可视区及上下各一屏的小窗口，隐藏 pane、折叠工具和未加载历史不申请新读取。未使用项最多保留 5 分钟；owner 销毁或撤权立即清理，不等待 TTL。到期只处理无 lease 项，不能删当前预览。

为保证合法图片的主动操作可进展，上述限额内专门保留页面40 MiB/2资源槽、每owner40 MiB/2资源槽给前景操作，后台最多使用页面88 MiB/30槽、每owner24 MiB/14槽。前景只并行一个预览读取和一个下载读取，每个按最多20 MiB预留（10 MiB原件及最多一份10 MiB校验/构建临时副本）；已经命中同一Blob则复用而不重复计费。普通frame不能长期占用保留槽。打开另一图先释放旧预览独占lease与缓冲再开始新图；原图若仍被frame使用，能转入后台预算才保留，否则暂时释放该非当前图表示/lease并保留稳定占位。离屏或隐藏frame立即释放Blob与解码lease，store仍可按LRU保留无lease原件。仅普通状态更新不引起此释放。

原件的预留类别随仍存续的使用者协调，不固定为首次请求类型。同一原件先被预览、再被下载共享时，关闭预览后由下载槽承担其占用；下载先释放而预览仍存续时反向转移。换槽仍受页面、owner和目标槽限额约束，不重复计费，也不提前归还未结束工作的预算。目标槽被占用时保留计量并在占用变化后重评；两个原件相互换槽须作为一次完整分配验证，避免彼此等待。

下载保留最多一个前景原件lease/专用URL，最长60秒；后续下载按用户点击顺序排队，最多2项、等待最多65秒，超限/到时返回本地可理解的“下载繁忙，请重试”，不发请求、不报资源不可用。等待项不持bytes，只持句柄与取消信号，撤权/owner失活即取消；没有第三份下载原件挤占预览槽。预览不排在下载之后，每次新open取代尚未完成的旧open。后台队列最多32项，超出只保留idle框，等进入可视区或用户操作再准入；无自动来源重试。新前景操作可取消尚未完成的后台读取，取消确认并释放其缓冲后才能复用计费。每次读请求有15秒无进展和60秒总时限，到时取消并给显式读取失败；用户可重试同原件。由此即使后台可见卡片或下载占满其额度，一张合法10 MiB图仍有独立预览预留，不会永久queued。缓存压力改变页面表示，不删除历史资源。

解码需单独准入：单图按 Controller 媒体存储最大 33554432 画布像素估算 128 MiB RGBA，页面同时在用图像画布估算预算 256 MiB、最多两个完整原件解码任务。 已保存 descriptor 缺少尺寸时，完整容器校验提取 PNG/JPEG/GIF/WebP/AVIF 的画布尺寸作为 legacy 准入估算；无法证明尺寸时保留最大估算。解码在途仍占估算额度，完成后按实际定向画布面积收缩保留额度，实际面积超出已准入估算则拒绝发布。并不声称这个估算是浏览器/GPU 的实际硬内存上限；动画和实现差异必须测量。超出准入的卡片保持尺寸框与可聚焦“查看图片”，用户打开可优先释放离屏解码表示后查看，不报服务资源失效，不改变 10 MiB 接受上限。大量小图可依其实际画布并行显示，但解码任务仍最多两个；大图完成任务后保持的画布也计入预算。隐藏/离屏 frame 可释放 img 的解码表示，外层框和 imageId 保留，之后优先复用 Blob而不是重复网络。可视中已展示图片不能因普通流式更新被逐出。若可视图耗尽预算，预览暂时挂起非当前图的解码展示并保留占位；关闭后恢复其原 Blob。浏览器不支持安全解码或内存不足是显式本地失败，不更改服务 descriptor。

这里淘汰的是可重新读取的页面缓存，不释放消息、unknown operation 或归档引用，也不减少服务 1 GiB/1000 资源计费。8 张/20 MiB 仅限制输入消息，不能截断 Agent/工具/Markdown 图片输出。原件保持 PNG/JPEG/GIF/WebP/AVIF，输入三格式不缩减展示；禁止 SVG、HTML 或未知内容执行。

下载先确认当前 canDownload，再取得完整验证 lease，在实际触发下载前复核相同 scope/资格。使用 Blob URL 与 download attribute，绝不导航来源路径/外站、对象存储地址或打开新标签作为下载替代。已经交给浏览器/用户的下载不能被后续撤权追回；撤权必须阻止尚未触发的下载并撤销页面保留地址。下载专用 URL 在发起后保留至浏览器接管所需的有界时间（默认 60 秒），或撤权/owner销毁时立即撤销；到期无论下载状态如何释放自身 lease。它不复用关闭预览即撤销的独占 URL。

文件名去掉目录分隔符、控制字符、双向文本控制字符、路径段和 OS 保留名称；去除不匹配扩展名，按真实 MIME 添加 `.png/.jpg/.gif/.webp/.avif`，长度上限 120 个 Unicode code points，不截断代理项。空/危险名使用 `image-<imageId短片段>.<ext>`，草稿用稳定本地 ID。label 的完整安全显示值仍通过可访问名称或可聚焦详情读取，不把处理后的下载名写回消息。

## 尺寸、显示模式与阅读锚点

普通消息图片最大宽度取 `min(100%, 420px)`；草稿缩略图尺寸由草稿模块布局决定（可采用 88–112px），统一 frame 接受尺寸变体而不复制预览逻辑。未知尺寸使用宽度不超过容器的 4:3 占位，名称/失败区始终在框内。available 后设置 width/height 与 aspect-ratio；极端长宽比在消息中限制展示框高至 320px、object-fit:contain，不截掉原件，完整尺寸通过预览查看。图片/长名的父级 min-width:0、max-width:100%，不让表格、长 URL 或多图撑开页面。

Controller 媒体存储尺寸是未应用 EXIF orientation 的存储画布，动画是帧画布。frame 解码后以浏览器实际定向尺寸修正显示比例；不改服务 width/height 或原件 SHA。若浏览器 naturalWidth/Height 无法可靠给出方向，使用受控解码得到的显示尺寸，无法确定时保持 contain 和明确可查看框，不强制错误拉伸。原始比例模式按定向后的图片像素对应 CSS px，而非承诺一个物理屏幕像素。

保留当前 `standard`/`conversation` 筛选，默认值沿既有 preference；隐藏工具/reasoning 不强制出现。工具展开状态放在时间线 owner 的 entryId/callId keyed map，筛选暂时卸载不清空；真实 owner 变化/条目删除再清理。资源完成不得修改 details.open，工具图片留在 callId.output 原顺序。retainedImages 单独保存在原消息的“较早版本图片”折叠区，正文/part 被撤回仍使用原 entry/part owner，不能移到最新消息。

所有布局变化复用 `useTimelineScroll`：follow=true 时沿用户已有跟随意图；阅读旧内容时不调用 latest/scrollToBottom。扩展其内部 ReadingAnchor 为可选媒体锚点 `{mediaKey, normalizedY, top}`：mediaKey 为 entryId+partId/imageId，normalizedY 为视口顶部在实际定向图片内容矩形内的 0..1 相对高度（不包含contain留白、名称和动作区），top 为目标点相对 viewport 的 CSS 像素位置。可见阅读位置在图片框内时优先媒体锚点，否则沿已有文字锚点。尺寸/方向纠正后按同一媒体相对点补偿，保持在原图片细节；未知尺寸/无图的占位使用占位内容矩形锚定，图片解码后再转为实际内容矩形；名称/动作区沿entry或文字锚点。布局更新前捕获，ResizeObserver 后一次补偿，禁止同时让 CSS scroll anchoring 再补偿；相关 viewport 采用 overflow-anchor:none。媒体不存在时依已有 entry 邻项规则，不自动换到最新。

分页 bookmark 增加媒体锚点但不持有 DOM/Blob；historyEpoch 与 owner 校验继续保留，找不到目标且历史未完整时继续等待原页，不提前当删除。record-only timeline 显式传 record scope/历史 revision，不再用 snapshot 可有可无的字符串构造阅读身份。预览打开时记住背景锚点、跟随意图及各滚动位置并挂起布局补偿/自动跟随；后台流式数据可更新，关闭时恢复原意图，旧内容读者恢复锚点，原本跟随者恢复最新位置。用户在预览里滚动不能改变背景 following 状态。

## Markdown 映射与链接图片

采用 Markdown 来源采集的完整正文 AST+bindings；不拆正文成散片段、不用正则替换。先验证 partId/revision/textSha256、UTF-16 半开区间和 imageId 唯一归属，再给真实 image/imageReference HAST 节点注入稳定展示。chatBreaks、表格和脚注前缀保留；图片绑定基于原始正文，不因软换行插件改位置。无真实节点、旧 revision/hash 或绑定越界时保留可读正文、阻止对应图读取并重取条目，不能 fallback 到原 src/srcset。 自动重取按同 owner 和 entry revision 去重，最多一次；账户变化或 current 准入暂停时保留待处理项，恢复后只重读权威条目或所选归档。同 available ID 元数据冲突使用同一恢复通道，普通网络、完整性或本地解码错误不自动循环读取。重取后仍不合格则保留显式失败与手动刷新入口。未声明格式的工具 raw 文本不走解析；reasoning 只有公共协议纳入独立位置后采用同规则。

`ChatMarkdown` 新增可选受控节点 renderer，只接收经验证的节点 key/内容；缺省仍显示不可用。Session 层负责创建 callback及scope，其他 ChatMarkdown 消费者（例如 Thread）缺省不获得图片访问权。原始 HTML img、code、普通路径零图片读取。

同一scope与partId的合法完整正文更新在摘要待验期间保留最近一次已验证的正文及图片映射，避免已显示图片、预览触发点和解码lease因异步检查而卸载。新版本通过校验后原子替换展示，未改变的图片出现保持原DOM与焦点；新增或替换绑定在此之前没有准入权。身份变化、只读缓存、缺失或非法metadata不能沿用旧展示，迟到验证也不能恢复已经结束的scope。

未链接图片以可聚焦按钮作为预览触发，下载为并列控件；不能 button 内再放 download。对于 `[![alt](image)](https://example.com/page)`，保留外层合法 `<a>` 及原链接导航语义，图片视觉部分不处理预览点击；预览与下载是该链接之后的并列按钮，具有“预览图片：alt”和“下载图片：alt”名称。在一条链接含文字或多张图时，整个 anchor 保留原 children，所有对应图片动作按出现顺序附在 anchor 后，不能在 anchor 内嵌 button。纯内联容器使用 span，不能把 div 放进 p。非法 href 维持当前白名单降级为 span，已授权图片仍有独立预览按钮；不得把本地 destination变成可打开文件链接。

retainedImages 使用原 imageId、label及保存资源；有合法 linkHref 时同样提供分离的原链接入口。当前 bindings 与 retained 集合不能重复显示同一 imageId。预览打开后正文修订将该图转入 retained，仍是同 owner/asset，可继续预览；真正移除引用或权限失效才关闭。来源修订生成新出现而不是在旧预览内无声换图。

## 模态、键盘、滚动与窄屏

采用每个展示 owner 一个原生 `<dialog>` 的 `showModal()`，dialog 节点挂在实际 Session 全屏根/record展示根内部，但位于滚动时间线之外。普通 Task 弹窗内也须属于该任务 DOM 子树；不要 portal 到 document.body。这样现有 fullscreen root.contains、Task 的焦点边界都包含 dialog。record/附件适配器提供实际 root，不通过“最近的任务名”猜 owner。全屏切换复用同一个 host、client 和 frame，不重挂图片或重新获取。

dialog 设置可访问标题、aria-modal；初始焦点到关闭按钮，Tab/Shift+Tab 只循环内部有效控件，包含可滚动图像区域。自己的 keydown 在冒泡到父级之前处理 Escape/Tab，Escape preventDefault+stopPropagation，cancel事件也 preventDefault 并调用同一 close。不要用全局 capture listener 抢其他模态。预览关闭后第二次 Escape 才交 Session 全屏，再交 Task 全屏/弹窗。背景点击不关闭，以免拖动大图误关闭；关闭按钮和 Escape 始终可用。

user 关闭仅在 trigger 仍 connected、可见、非 inert且属于同 owner 时以 preventScroll 聚焦；否则调用 fallbackFocus，优先原工具 summary/原消息可聚焦容器，再当前 timeline；owner 已消失时不抢新界面焦点。原消息被过滤不强制展开/改模式以恢复焦点。身份验证/删除确认等更高层模态打开时暂停图片 host，隐藏敏感图像并把焦点权交给既有上层模态；授权未变且返回同 owner可恢复原预览状态，确认撤权则销毁。暂停必须在上层确认框聚焦之前同步执行：调用 dialog.close() 退出浏览器 top layer，解除预览自己的焦点trap与timeline/body滚动锁，清空显示src但保留经授权的asset/缩放/舞台位置状态，且不运行用户关闭的trigger恢复。仅把img设hidden或把祖先设inert不够，原生modal仍可能屏蔽现有body portal的role=alertdialog。上层模态关闭且同owner仍active、身份已确认后，重新showModal并恢复原asset/缩放/舞台位置，读取复用原lease；若撤权则完全释放而不恢复。该层级通过TaskDetailSurface/TaskConfirmation和既有认证modal owner的“即将打开/已关闭”桥接信号接入，不在确认框已经聚焦之后才依赖effect/MutationObserver补救，也不让多个trap互相抢焦点。

body 使用已有引用计数 `useBodyScrollLock`；另锁定该 owner 的 timeline 内部滚动容器，并保存原 overflow/scrollTop/scrollLeft，以引用计数恢复，不能解除外层 Task 的锁。预览舞台 overflow:auto、overscroll-behavior:contain，移动端触摸只滚舞台；控制区域阻止滚动链到背景，键盘 PageUp/Down/Home/End 作用于舞台。不能在整页禁止 touch-action 导致浏览器缩放不可用。

fit 模式使用可用舞台宽高等比 contain，小图不强制放大；100% 模式使用实际定向 CSS 像素尺寸，舞台从顶部/左侧可到达所有边缘，不用居中 transform 制造负坐标不可达区。模式按钮以 aria-pressed表达选中。尺寸变化、屏幕旋转或软键盘使用 visualViewport 重新计算舞台，但同图已选100%不自动回 fit；仅新图默认 fit。预览不提供图片编辑/裁切。

390px 与桌面共享控件，标题允许换行/省略且完整名称可访问，工具栏可换行、关闭常驻，无页面级横向溢出。大图的横向滚动仅在舞台内。添加、移除、重试、预览关闭、下载和发送等主要图片操作触控目标均至少 44px；焦点轮廓与现有主题一致。遵守 prefers-reduced-motion，取消缩放过渡、spinner转动可用静态忙碌标识替代，GIF/AVIF 原件格式和下载仍保持；不以动画替代可读状态。

## 入口覆盖与权限适配

| 入口 / 主线实际链 | scope/宿主与必须结果 |
| --- | --- |
| Task 弹窗、独立页：TaskDetailSurface → TaskSessionHost → TaskAgentSession → SessionView | 真实账户+Task Session授权；同一个 SessionView 挂 scope/host，弹窗与页布局不产生第二个 client。图片输入资格给草稿模块，读取独立。 |
| TestSessionPage → SessionView | 使用独立 Session resolver 与 testExecutionId；不伪造 task/claim。既有删除准入、账户暂停与媒体取消连接。 |
| BotSessionHost → retained pane → SessionView | botId只是管理对象，媒体 owner 为实际 selected Session；隐藏/inert pane停止新读并关闭预览。切换回来在原权限确认后复用缓存/展开状态/bookmark；不把另一 Bot 同名 Session 的图挂入。 |
| Session 全屏、Task 全屏 | 复用原 host/DOM/client，预览作为内层模态；同图不重新下载，Escape只退出一层，保留背景锚点。 |
| Task 历史选择器 → FixedSessionRecording → NativeRecording → SessionTimeline | 归档模块提供 recordId所属 reader与资源索引，无 live snapshot 也可展示、预览和下载；禁输入和来源采集重试。保留 current Session pane不授予历史写资格。 |
| 附件中的 NativeRecording | 沿实际任务附件/record授权，使用record owner；不能把附件路径当 Session base，也不能用 manifest blobId 构造公开下载地址。schema1仍读已有字节，schema3由归档模块 adapter接线。 |
| Herdr/TerminalRecordingView | 保持终端分支，不注入图片host、输入或新native图片parser。 |

只读记录有保存原件时网络失败允许重读；从未采集的坏路径/URL明确不可用且不抓源。旧 schema1 保存的五格式资源可经 legacy adapter校验后使用同一预览，不要求迁移才能看图。仅 descriptor 无 bytes不能伪造成功；schema3 known available blob丢失按归档模块存储错误，不退到源。旧服务/Controller不支持新图片表示时沿公共协议严格旧文字流程，保留可读取旧资源，不把整个Session送进新parser失败。

## 来源状态与读取重试

浏览器只观察出现和读取已保存原件，不因展开、滚动或预览而获取原 URL/路径。来源资格由公共协议的 `GET {base}/image-occurrences/{imageId}` 返回，严格消费 `{imageId,revision,state,resourceId,action,error}`：`unregistered/unavailable` 只有 `none`，`pending/unknown` 只有 `observe`，`committed` 只有 `read_saved` 且资源非 null；`failed` 只有服务确认从未 committed、旧 staging 已清理、来源可信且当前有操作权才允许 `retry_source`。所有字段、null 和错误约束由公共协议拥有，未授权不能用 `unregistered` 泄露存在性。

唯一来源重试为 `POST {base}/image-occurrences/{imageId}/retry`，严格 body `{}`，返回 `{capture:ImageCaptureReceipt}`；不提交新 locator、headers 或 actor。可信 local/external 来源确定 failed 且旧 staging 清理后，`invalid_image/unsupported_media_type/decode_failed` 可请求重新准备并完整核验原 locator；输入上传及 saved 原件不因此改变 `never` 规则，权限错误不能靠重试绕过。已 committed 只重读原件，不能换源字节；只读记录永远没有 `retry_source`。

资格 GET 按需在可见失败卡片读取，同 scope+imageId 合并。pending 可由事件或 2/5/10/30 秒退避观察，隐藏页面停止；单轮最多 60 秒后保留状态及检查状态入口，后续事件仍可更新。点击来源重试前重核资格，服务再次核验原 capture 与权限；202 不代表 available，响应未知改为原身份观察。资格 revision 变化只更新动作，不重挂 frame；不能按错误文案猜资格，不能把 canSend=false 等同历史不可读。

## 验证要求

浏览器验证须观察原生调用入口次数、原 operation、IDB 事务结果、DOM/lease 身份、网络读取次数和原件 SHA，截图只证明布局。覆盖选择/粘贴/drop/IME、乱序解码、非法与超额候选恢复、IDB abort/配额/迁移、两 tab CAS 与冻结、逐阶段响应丢失、原接受不清 successor、账户/代次变化、删除及晚到结果。边界内 8 张、10 MiB 单图、20 MiB 总量与更小原生 profile 均沿同一 gate；任意一图失败不得派发子集。

每个 live 和 record 入口须覆盖五格式、原位置与 retained、linked-image 独立动作、重复出现共享读取、展开/筛选/分页、原件读取失败、浏览器解码失败、权限无变化复核、撤权 URL 清除、满缓存仍可主动预览、fit/100%、焦点恢复和逐层 Escape。媒体锚点偏差不超过 2 CSS px；既有文字 prepend 锚点不超过 1 CSS px 的保证不放宽。390px、桌面、旋转、visualViewport/软键盘、浏览器缩放和减少动画分别验证；受控窄屏不能替代真实移动设备。

实现验证执行仓库对应 Web 检查及适用浏览器验收；存储、服务和 Provider 组合沿各模块门禁。当前范围内 Codex、Copilot 的真实纯图、混合输入、唯一原生接受和历史原件必须单独取证，浏览器 fixture 不证明 Agent 实际读图。
