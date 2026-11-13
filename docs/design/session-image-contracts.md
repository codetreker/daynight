# Session 图片协议与存储设计

## 状态与责任

本文定义统一 Session 消息、服务原件、Controller 存储和完整解码器。基础层使用统一输入、资源客户端和 manifest 归档；原生图片编码、来源解析、预览与草稿由各自消费者交付。图片 Provider profile 保持关闭，基础层验证不表示原生识图或完整产品链路已验收。需求分别由[图片输入与草稿规格](../spec/session-image-input.md)、[显示与归档规格](../spec/session-image-history.md)及[验收与容量规格](../spec/session-image-acceptance.md)拥有。

本文是基础图片 DTO、身份、能力、上传、读取、来源登记、错误和跨层预算的唯一设计定义。[来源设计](session-image-sources.md)拥有 Markdown part/binding/retained 的完整结构和采集算法；[归档设计](session-image-archives.md)拥有 schema3、完整历史同步和封存文件 DTO；[Provider 设计](session-image-providers.md)拥有原生 payload、接受证据和历史映射；[浏览器设计](session-image-browser.md)拥有持久草稿和唯一预览接口。各消费者复用这些定义，不再建立同名竞争类型。

旧记录的兼容依据为 [固定协议](https://github.com/codetreker/daynight/blob/7fe4684b83d4d850f3b2dc6e7772392f75b175ef/packages/daynight/src/session/protocol.ts)及[原生入口](https://github.com/codetreker/daynight/blob/7fe4684b83d4d850f3b2dc6e7772392f75b175ef/packages/daynight/src/commands/controller/providers/types.ts)。严格 v1、旧文字命令编码、8 MiB legacy resource、64 MiB 旧原生归档和 Herdr v2 语义保留；Provider 文字发送已迁入统一结构化输入。服务责任分别落在 `internal/core/session/` 执行、`internal/service/session/` 授权事务、`internal/core/store/` DAO、`internal/server/session/` HTTP、`internal/core/filestorage/` 文件抽象，不重建旧 `internal/sessionrelay/` 服务。

## 数据与控制流

浏览器先持久保存原始 Blob 和有序草稿，再按目标上传。服务登记原上传身份，将有界块暂存并转给 Controller；双方完整验证后，服务持久保存原件并确认 complete。发送另行冻结原操作，整组校验和 pin 后只调用一次原生入口。原生接受由精确证据结算；unknown 只查询。可信历史出现先登记位置，再采集；成功后读取原件，永不重取变化来源来替换原图。

身份有不同用途：origin/account/Session 决定归属；完整 fence/native/capability revision 决定发送目标；imageId 是一次出现、resourceId 是不可变原件、uploadId 是准备、operationId 是发送。相同 SHA、路径、显示名、botId 或 native ID 均不等于同一授权。Task fence 使用 sessionId/claimId/executionGeneration，Test/Bot 使用 sessionId/testExecutionId/executionGeneration；Controller 传输再绑定 connectionEpoch、controller/instance。

## 公共值与版本

所有新 JSON 对象严格校验：未声明字段、缺少必填字段、重复键、非法 UTF-8/孤立代理项、错误 discriminant 均拒绝。下文类型中除 `?` 外均必填；`null` 只能出现在明确 union 中，不等于省略、通配符或空字符串。不会修改旧 v1/v2 parser 的宽松程度。

| 值 | 类型及校验 |
| --- | --- |
| UUID | 小写标准 UUID 字符串，与现有协议一致；各命名空间分别校验，不以任意文本替代 |
| Decimal | 规范十进制字符串，`0` 或非零开头，≤9223372036854775807；revision/generation/长度正数，offset/配额计数允许 0；不转换成浮点数比较 |
| SHA256 | 64 位小写十六进制，摘要对象是完整原始文件字节；不是 Base64 文本或解码像素 |
| MIME | 输入仅 `image/png`、`image/jpeg`、`image/webp`；显示另支持 `image/gif`、`image/avif`。禁止 SVG/HTML；扩展名和声明 MIME 不证明真实格式 |
| Timestamp | UTC RFC3339 字符串；过期判定以服务端时钟为准 |
| name/label | 显示字符串，非空、无控制字符、UTF-8 ≤1024 bytes；不是路径或文件系统名字；下载文件名由 [浏览器设计](session-image-browser.md) 安全生成 |
| 尺寸 | width/height 为 1..2147483647 的安全整数，尚未解码用一对 null；二者同时存在或同时 null；解码资源限制由 下文解码策略规定，失败必须显式报告 |

原生 Session 继续使用 `protocol:"daynight.session.v1"`、`schemaVersion:1`、`projectionVersion:1`。Controller hello 以可选 `contentRevision:2` 协商统一媒体合同，旧缺省 revision1。服务 snapshot 仅在该合同可用时同时发布 contentRevision、capabilities.images 和 imageBudget。Herdr 的 `daynight.session.v2` 不变。旧 Worker 仍可使用文字；需要图片时明确提示升级，不能把图片降为文字。

统一 `SessionInput` 为可选的首个非空 TextPart 和随后有序 ImageInputPart；纯图没有虚构文字，不支持任意图文交错。含图 send_message command 显式携带 `contentRevision:2`，payload 必须有 target、draftId、draftRevision 和 expectedImageCapabilityRevision。纯文字沿既有 command 编码及原 hash。MessagePart 在原 TextPart/ResourcePart 上增加 ImagePart、ImageUnavailablePart 和 MarkdownImagePart，所有在线、历史、content 和归档路径复用相同类型。

资源只使用 SessionResource。已完整解码的图片追加 revision、width、height 和 frameCount；旧资源在边界读取时保留未知几何，不伪造结果。timeline 页和资源事件继续使用原 resources 数组与 kind:"resource"，不建立 images 数组或第二种事件。四类图片 entry 的 imageProjectionError 和 reasoning markdown 分支沿来源设计严格校验；其他 entry 不添加这些字段。

专有 image_request/image_response 控制帧使用完整 requestId/action/ControllerFence，支持 prepare/write/complete/status/release/read_prepared/read_capture/retry_capture/read。HTTP 媒体请求使用 `Daynight-Session-Content-Revision: 2`，统一资源 chunk reader 允许10 MiB原件；无query的旧raw reader仅保留旧调用边界。不会扩大旧 relay 常量并假装旧 Worker 已具备新能力。

## 执行目标与能力

```ts
type ImageGeometry = {
  version: 1; known: boolean;
  maxWidth: number; maxHeight: number; maxPixels: number; maxFrames: number;
};
type ImageTarget = {
  serverOrigin: string;
  actorUserId: UUID;
  fence: SessionFence;
  expectedNativeSessionId: string | null;
};
type ImageCapabilities = {
  revision: Decimal;
  providerRevision: Decimal;
  expectedNativeSessionId: string | null;
  modelId: string | null;
  controlsRevision: string | null;
  send: "supported" | "unsupported" | "unknown";
  steer: "supported" | "unsupported" | "unknown";
  reasonCode: string | null;
  inputMediaTypes: InputMime[];
  maxImageBytes: Decimal;
  maxMessageImageBytes: Decimal;
  maxImagesPerMessage: number;
  geometry: ImageGeometry;
};
type ProviderImageCapabilities = Omit<ImageCapabilities, "providerRevision">;
type ImageBudget = {
  revision: Decimal;
  maxBytes: Decimal;
  committedBytes: Decimal;
  reservedBytes: Decimal;
  maxResources: number;
  committedResources: number;
  reservedResources: number;
};
```

ImageTarget 只接受当前请求 origin/认证 actor 与真实 SessionFence 的精确匹配。native ID 保留当前原生字符串规则（非空、无控制字符、UTF-8 ≤256 bytes），null 仅指当前独立 Session 尚未建立首次原生会话。上传可绑定该 null 目标；首个 send operation 原子占用初始化目标，只有它创建的 native ID 可结算其上传与回执。并发的另一条首次输入必须在派发前重新核验，不能把 null 匹配到已创建的任意会话。发生其他原生初始化后，旧 null 回执只能查询，需显式重新准备草稿；不能自动重新发送。已知 native ID 在同代次不允许变化，变化按 target_changed 处理。

ProviderImageCapabilities.revision 是 Controller 持久单调正整数，绑定其原生模型、权限设置、身份与结构化send能力；服务不原样复用它作为有效revision。ImageCapabilities.revision 则是服务为该Session持久分配的单调revision，providerRevision记录参与合成的原生报告revision。服务根据原生报告、协议模式、上传/持久化/归档链路及策略计算最终能力；任一影响资格的输入变化都推进有效revision，同revision绝不对应不同能力。已提交资源变化更新 imageBudget；实际内容超限在发布事务中拒绝，不制造模型能力变化。重复读取及无变化权限复核均不推进revision。恢复不得在旧revision下发布新值。

Controller 接收 operation_authorized 后，在标记 dispatching 之前使用已冻结的 command intent、服务 effective capability revision 与本地持久 providerRevision 重新核对整组资格。服务生成授权前重新校验自身最终能力；Controller紧接原生调用前校验自己的providerRevision。已经发出的授权如遇服务策略撤销，使用既有原子授权边界结算已授权操作，不能声称撤销可以取消已经原生派发的输入；尚未授权者必须拒绝。服务每次授权也复核真实访问权限，revision不是权限凭据。modelId=null 表示有效模型无法确定，send/steer 均不能 supported。原生 default 选择值与已经确认的 effective model 不同；只有实际有效模型及其 profile 已获证实时才能宣布支持。controlsRevision=null表示原生未提供，不跳过能力校验。

支持状态是**已验证的原生能力与所有中间层能力的交集**。send 和 steer 分开；文字 steer=true 不推出图片 steer=true。未知和不支持都禁止对应图片输入，reasonCode 必填；完全支持时可 null。reasonCode 取 `model_unsupported|capability_unknown|provider_unsupported|component_unsupported|policy_restricted`。inputMediaTypes 为去重数组且为输入白名单的子集。任一 supported 时数组非空、数值为正，maxImagesPerMessage 为 1..8；均不支持时数组可为空、上限全部为 `"0"`/0。上限不大于 10485760、20971520、8，已知 Provider 更小限制向下取交集，浏览器和 Controller 必须使用同一个最终值。解码器等尚不可用时不得先宣布支持。

发送仍要求原有 operations.canSend、当前 expectedTurnId、同步状态和生命周期允许。活动回合需要图片 steer=supported；不支持时保留草稿等待，不扩展队列、不取消回合。纯文字继续使用原文字能力，不受未知图片能力影响。

几何限制： ProviderImageCapabilities 与有效 ImageCapabilities 均包含必填 `geometry:{version:1,known:boolean,maxWidth:number,maxHeight:number,maxPixels:number,maxFrames:number}`。known=true时四项均为正安全整数，且不得高于通用解码上限；known=false时四项均为0且send/steer不能supported。宽高按原始存储画布（不交换EXIF方向），pixels为width×height，frames为完整解码的容器画布帧数、静态图为1。需要按显示方向判定的原生profile，由Provider先将两种方向归约成保证满足原生限制的保守存储画布上限，不让消费者自行猜方向。

Provider先把已证明的backend/model、原生累计历史/工具图片上下文及本条可能新增1..8图的条件限制归约为当前固定上限；不能把本条图数当累计上下文。上下文不可观测时，采用该backend/profile已证明覆盖所有可达上下文分支的最严格上限；没有可证明的包络才unknown。发送前若实际上下文/模型/权限改变，重新计算并推进revision，拒绝旧revision后保稿重核；不能偷偷继续用旧profile。服务取该上限与Controller 存储模块通用限制的交集，Web、上传complete及最终派发都消费相同有效值。显式更小限制对用户可见。

为使maxFrames可跨层核验，`ValidatedImage.frameCount` 必须为1..256安全整数；SessionResource 的图片扩展 `revision/width/height/frameCount` 必须整组提供，非 available 图片使用 null 几何值，旧资源可省略整组扩展。完整全帧 decoder产生此事实，Controller journal、服务资源对象、receipt、manifest原样持久和校验；frameCount与原bytes/hash绑定且available后不可变。legacy资源经读取/迁移边界归入同一资源模型，不伪造帧数；浏览器本地尚未完整确认帧数时以上传complete的双端验证元数据作为发送资格依据，本地预览不是frameCount证明。输入/恢复/模型变化测试必须覆盖静态1帧、动画及更小maxFrames。Profile绑定真实native/SDK/backend/model证据，单次识图成功不构成发布profile的充分依据。

## 上传、回执与已保存资源

### 资源描述与显示出现

```ts
type SessionResource = {
  resourceId: UUID;
  revision?: Decimal;
  status: "pending" | "available" | "failed" | "unavailable";
  name: string;
  mediaType: string | null;
  byteLength: Decimal | null;
  sha256: SHA256 | null;
  width?: number | null;
  height?: number | null;
  frameCount?: number | null;
  error: string | null;
};
type ImageUnavailablePart = {
  type: "image_unavailable";
  imageId: UUID;
  label: string;
  error: { code: ImageErrorCode; message: string };
};
type ImagePart = {
  type: "image";
  imageId: UUID;
  resourceId: UUID;
  label: string;
};
```

revision/width/height/frameCount 是严格的整组扩展：旧资源不带这四个字段，新资源带 revision 时四项全部必填。图片 MIME 只接受 DisplayMime，available 图片必须完整声明正长度、摘要和三项几何，error=null；它意味着原字节已校验、可解码且已持久保存并关联其 owner。新 pending/failed/unavailable 资源的 MIME/长度/摘要/几何均 null，pending.error=null，其他两态有安全错误字符串。旧资源保留既有 error 字符串和真实元数据，不虚构几何；receipt 和 occurrence 使用结构化 ImageError 表达具体失败。失效原生历史、尚未获得资源槽或配额拒绝时使用 ImageUnavailablePart，不分配 resourceId。它保留同一 imageId 及消息位置；error.message 是≤256 UTF-8 bytes 的安全说明，错误码保留完整原因，不伪造尺寸或 bytes。它不占二进制资源配额，数量受其所属 timeline 的既有 entry/part/JSON 上限约束。

resourceId 是 Session 范围内注册且全局唯一的随机 ID，不是文件路径、HTTP URL、blob key 或摘要。available 的原字节和元数据不可更改；后续暂时读取失败只出现在读取结果中，不降级或替换已保存描述符。已登记但未成功的采集保留原身份和清理责任；确定失败后将对应出现投影为ImageUnavailablePart，再次准备分配新resourceId但保留imageId。成功后首次采集关闭。重新抓取源必须创建新 resourceId 和显式的新图片出现/记录关联，不能改写旧 ImagePart。

imageId 在消息整个寿命稳定。同一图片重复出现时每次出现有不同 imageId，可引用同一已授权 resourceId；数组顺序即显示顺序。imageId 全 Session 唯一，仅可在其原 entryId、用户/助手 content 或某 callId 的 output 内重复 upsert；不得迁移到其他消息。生产端保留原生 messageId/itemId/blockId 到 entryId/imageId 的持久映射，没有原生稳定 ID 时持久保存分配结果及原生源索引。流式文本变更、分页、重连、historyEpoch 改变不能重新随机分配。无法匹配时明确显示缺失，不凭相似文字或同 URL 合并。

### 上传交换

下述是 固定业务操作 DTO，不预定磁盘算法。HTTP 新路由位于现有已授权的 Session base 下：Task 为 `/api/v1/projects/{projectId}/tasks/{taskId}/sessions/{sessionId}`；Test/Bot 使用其现有独立 Session resolver 得到的 base。不得把 body 中的 actor 或 owner 当路由授权。所有媒体路由要求 contentRevision2 协商且禁用共享缓存。

```ts
type ImageUploadSpec = {
  uploadId: UUID;
  imageId: UUID;
  target: ImageTarget;
  name: string;
  mediaType: InputMime;
  byteLength: Decimal;
  sha256: SHA256;
};
type ImageUploadReceipt = {
  uploadId: UUID;
  imageId: UUID;
  target: ImageTarget;
  state: "receiving" | "verifying" | "complete" | "failed" | "expired" | "released";
  acceptedOffset: Decimal;
  spec: { name: string; mediaType: InputMime; byteLength: Decimal; sha256: SHA256 };
  resource: SessionResource | null;
  expiresAt: Timestamp;
  error: ImageError | null;
};
```

| 交换 | 请求 | 成功结果与约束 |
| --- | --- | --- |
| 创建准备 | `PUT {base}/image-uploads/{uploadId}`，body ImageUploadSpec，path/body ID 必须一致 | 201 新建或 200 同 identity/spec 已存在，返回完整 receipt。不同内容复用 ID 为 409 upload_conflict，不追加 bytes。登记原身份后返回 receiving；该兼容状态不预留未来容量。 |
| 写块 | `PUT .../{uploadId}/chunks?offset=<Decimal>`，二进制 body，`Content-Type: application/octet-stream`，`Daynight-Chunk-SHA256` 为本块摘要 | 200 receipt。块原字节 1..524288；offset 必须等于已确认偏移或精确重传已确认相同块；服务验证块 digest。重复相同块不增加偏移，不同块或跳跃偏移为409。 |
| 查询 | `GET .../{uploadId}` | 200 当前 receipt；未知ID为404。读取失败不证明上传失败。 |
| 完成 | `POST .../{uploadId}/complete`，body `{sha256,byteLength}` | 200 complete，或202 verifying；必须与 spec 一致。服务和 Controller 完成真实格式/可解码性/完整摘要校验及服务持久化后才能 complete。 |
| 释放 | `DELETE .../{uploadId}`，无body | 200 receipt state=released；只撤销未发送准备引用。原发送已占用或未知时返回409 upload_in_use，不能删消息引用。 |

receipt 中 complete 必须 resource.status=available、offset=spec.byteLength，资源 MIME/长度/摘要与 spec 完全一致，error=null。其他状态 resource=null；failed/expired 必须 error，receiving/verifying/released 的 error=null。verifying 已接收全部 bytes；receiving 的 offset 从0到长度；已失败/过期/释放保留最后确认偏移用于诊断，不允许继续。expiresAt 为未占用上传资格到期时间，初始创建后24小时，不由查询或精确重传自动延长。complete 仍可能过期；已占用发送、未知发送和消息引用不按上传到期清理。过期可保留本地原图显式重新准备新 uploadId，不能偷换旧 operation 的 intent。

浏览器传入 MIME 只是声明；Controller 用字节验证后不匹配则拒绝，不静默转码、压缩或改摘要。图像炸弹、无法解码或资源不足必须失败，已接受的其他草稿项保留。上传是一张图的准备，20 MiB/8 张限额在草稿和发送时按完整有序集合再验证，不能将“每张都成功”视作消息合法。

块请求通过独立的有界媒体通道传至Controller，不挤入operation队列。服务→Controller为 `image_request`，Controller→服务为 `image_response`，均包含现有完整ControllerFence、requestId、protocol及action。请求含body，响应含result/error且严格二选一。每次响应与请求fence/requestId/action精确匹配，连接失效先查询原准备身份。

Controller本地准备采用独立DTO，不得产生服务complete或公开available：

```ts
type ValidatedImage = {
  mediaType: DisplayMime; byteLength: Decimal; sha256: SHA256;
  width: number; height: number; frameCount: number;
};
type LocalImagePreparation = {
  uploadId: UUID; imageId: UUID; target: ImageTarget;
  state: "receiving" | "validated" | "failed" | "expired" | "released";
  acceptedOffset: Decimal;
  validated: ValidatedImage | null;
  error: ImageError | null;
};
type PreparedImageChunk = {
  preparationId: UUID; sha256: SHA256; byteLength: Decimal;
  offset: Decimal; data: string; eof: boolean;
};
```

validated状态仅证明Controller完整字节及解码验证，validated非null、offset等于声明长度、error=null；其他状态validated=null，failed/expired含error，receiving/released无error。准备绑定原ImageUploadSpec，validated必须与声明MIME/长度/摘要相等。PreparedImageChunk的边界与ImageReadChunk一致，但其身份是尚未公开的准备对象，不接受resourceId绕过上传权限。

| action | 请求body | 成功result |
| --- | --- | --- |
| `prepare` | ImageUploadSpec | LocalImagePreparation |
| `write` | `{uploadId,offset,sha256,data}`，data为规范Base64块 | LocalImagePreparation |
| `complete` | `{uploadId,sha256,byteLength}` | LocalImagePreparation |
| `status` | `{uploadId}` | LocalImagePreparation |
| `release` | `{uploadId,spec?}`，spec 为原 ImageUploadSpec，仅确定失败的 prepare 回收携带 | LocalImagePreparation |
| `read_prepared` | `{preparationId:uploadId,offset,limit}` | PreparedImageChunk，仅validated允许 |
| `read` | ImageReadRequest | ImageReadChunk，仅公开available允许 |

服务取得validated后读取并持久化各块、流式核验完整长度/摘要，原子发布SessionResource.available和浏览器ImageUploadReceipt.complete。服务可以使用接收上传时自己的暂存bytes，但仍须匹配Controller的validated结果；不得透传本地状态充当服务持久化。持久化失败保持verifying或明确failed，响应丢失查询原uploadId，已提交complete只能读回，不再次注册资源。

同一 uploadId 与 spec 的准备/块重复可以安全返回现存状态；网络未知时客户端先查询，禁止盲目新建或重传整个图。这里的可协调准备不授予 SessionCommand 自动重放权限。

服务媒体请求的持久账本保留原 requestId/action/fence、完整非字节元数据、块长度/摘要及完成结果，不长期保存 write body 或 read/read_prepared/read_capture result 中的 Base64 原件。私有账本用 `$data` 保存块身份，该字段不进入 wire；原 data 从同 Session、同 upload/attempt 的已计量共享暂存块或已提交 blob 恢复。原件不存在或摘要不符时拒绝，不能从变化的外部来源重建。

Poll 先按当前 Session、claim/test execution 与 generation 筛选持久媒体请求，再排序并取最多两个 offer；同 generation 的 connection epoch 可沿原请求重绑，旧 generation 的 unknown 行继续保留供原身份查询。Poll 构造持久 offer、Controller read response 的服务落盘及等待者读回都使用短事务取得原请求、scope、fence、delete epoch 和 durable lease，结束事务后持精确文件 gate 执行有界 I/O，再以短事务复核这些原事实。read response 的原 bytes 先写入受原 upload 身份与 durable lease 保护的精确 chunk namespace，再持久保存不含 bytes 的结果；已经完成的原件只核验既有 blob，不晚到重建 staging。offer 的 write body 和等待者读取结果在事务外从同一共享文件恢复并核块摘要，因此 HTTP caller 和 Controller relay instance 无须是同一进程。进程内等待状态不是 durable replay bytes 的所有者。 complete 等待远端 prepare/write/complete 时没有本地文件 I/O，保留原 upload 私有 gate 和执行生命周期 gate，但先确认释放外层 transfer lease；write 只登记既有计量块的元数据，由 relay 自取 durable lease 读取。远端结果完整匹配后，服务重新核验原 actor、spec、receipt、blob、到期、fence、delete epoch 和 frozen 状态并取得新 lease，才打开本地原件。释放结果未知不开始远端请求。Poll 若仅因临时媒体并发额度不足而无法重建某 write，则保留原请求，延期该 offer，继续健康文本传输；存储、校验、清理及混合错误仍明确返回。

旧账本中的完整 body/result 在 core 计算无 bytes 的等价元数据，并由 DAO 按读到的原 fence/body/result/error/complete 做精确 Expected CAS；冲突或 unknown 保留原身份与占用，不覆盖较新的结果。取消只结束该次 I/O 并等待执行单元退出；准备、unknown 和未完成清理继续保留其原身份及本机清理责任。

Controller 释放原准备时，relay 与本地 release 使用同一存储错误分类，覆盖首次访问媒体目录、预算账本初始化以及实际释放；可恢复的文件访问/flush、SQLite busy/存储或元数据容量不足与身份、格式和安全拒绝分别处理。前者在 `action=release` 的响应中返回 `release_storage_unavailable`；短暂本地 reader 占用也使用该错误，真正 operation/native 引用仍拒绝为 `upload_in_use`。服务仅对 release 的该专用错误及既有 `rate_limited` 保持原持久请求 pending，沿同 requestId/action/body/fence 再次 offer；已经完成的成功或确定错误不被迟到暂拒改写，SQL 终态保护不放宽。未知、取消和重复暂拒期间保留原文件及本机物理计量；只有原远端 release 成功、本地文件删除及元数据提交全部确认才完成清理。`budget_exceeded`、`image_unavailable` 等通用错误不推断为可重试清理，其他 action 不因该专用 code 获得重放许可。

## 图片发送与 NativeProvider 入口

```ts
type ImageInputPart = {
  type: "image";
  imageId: UUID;
  uploadId: UUID;
  resourceId: UUID;
  sha256: SHA256;
  byteLength: Decimal;
};
type SessionInput = {
  content: (TextPart | ImageInputPart)[];
  expectedTurnId: string | null;
  target: ImageTarget;
  expectedImageCapabilityRevision: Decimal;
  draftId: UUID;
  draftRevision: Decimal;
};
```

本版输入组织固定为可选一个非空白 TextPart，后接1..8个有序 ImageInputPart；纯图片不生成空 TextPart。本文新增 payload 专用于含图片 send_message；图片模式的纯文本 send_message 使用严格的旧 `{content:TextPart[],expectedTurnId}` 分支，不带图片专用字段，以保持现有文字分片语义。两个分支依 content 中是否有 image 精确区分，不能解析失败后删除图片重试文字分支。输出内容可以交错文本和图片，工具输出仍属原 callId。

所有 imageId/uploadId 在一个输入内唯一；同样 bytes 的两次有意附件有两个 imageId/uploadId。resourceId、摘要和长度必须与当前 actor/target 的 complete receipt 查回结果相等。完成上传不代表 native 已可读：发送前 Controller 必须取得并验证本地 bytes，服务须保留全部图片发送引用。只有所有图片均可用且单输入限制、目标和能力满足，才原子接受整条图片发送；缺任一张即整条拒绝，不能降为部分图片或仅文字。

operation intent hash 覆盖原 envelope（不含可变传输 requestId）、target、draftId/revision、能力 revision、expectedTurnId 和完整有序 content；新图片intent的规范JSON递归按字段名ASCII升序排序，数组不排序；不含空白，字符串保持UTF-8原字符（只转义双引号、反斜线及控制字符，控制字符统一小写\u00xx），整数用十进制、不含浮点数，null显式保留。摘要含protocol及原envelope除requestId外全部字段，不能沿用只包含旧字段的hash投影。服务与Controller使用同一序列化向量；旧v1 hash保持原算法。纯文本及其他非图片命令保持原v1语义对象和旧hash算法；同一operation跨表示查询/协调不能因wire版本不同产生operation_conflict。只有含图片的intent使用上述新算法。相同 operationId 不同 intent 是 operation_conflict；不能因重连重新编号或改变引用后继续同一 operation。服务 accepted/offered 仅为命令接纳，provider_accepted/confirmed 才可清理对应原草稿版本。新草稿 revision 即使同 draftId 也不被旧回执清除。

送入原生之前依次满足：当前权限与 fence → 目标与能力 revision → 全部资源可用 → 持久化 intent 和图片引用 → 持久化 dispatching → 原生调用。模型设置变更与发送授权按现有控制序列串行；授权后、原生调用前重新检查变化。不得检查后允许并行设置改变把图片送给不支持模型。

NativeProvider 公共入口新增 `send(input, operationId, expectedTurnId)`，三 Provider 的文字发送也迁入该入口，不保留 text/sendInput 并行 API。NativeInput.content 是有序 TextPart 与 `{type:"image",imageId,resourceId,mediaType,byteLength,sha256,localPath}` 数组；localPath 是 Controller 生成的只读本地资源句柄路径，绝不接受浏览器/Markdown 原始路径。其 bytes 已验证且 operation 引用在原生读取期间保持存活。Provider 内部 lease 保留 path、长度与摘要，以及有界 read/close 能力；路径不作为公开资源引用。下文存储机制拥有资源解析和句柄生命周期；[Provider 设计](session-image-providers.md) 按原生协议将其转换为原生图片输入。该内部接口不序列化到浏览器，不把本地绝对路径写入公有回执。

当前支持范围内的 Codex、Copilot 各自证明纯图片、图文与顺序、接受回执及历史映射；保留 Claude 的协议身份和现有适配不代表开放其图片资格。不由共享接口猜测 Provider 的图片 steer、默认模型 vision、queued 语义。不满足结构化 send 或完整媒体 revision 的旧适配器明确要求升级。NativeProvider 返回沿用 ProviderReceipt，图片回显或本地 timeline 生成不是原生接受证据。

### 操作恢复

| 观察 | 后续行为 |
| --- | --- |
| 服务明确拒绝、未派发 | 保留草稿，修复后用户发起新 operation；旧操作不可变 |
| accepted/offered | 查询原 operation，不能因页面刷新重复提交 |
| dispatching 后连接丢失、原生响应不确定 | 原 operation 保持 unknown，保留所有图片引用和冻结草稿；只查询/协调，不自动重放 |
| provider_accepted/confirmed | 按同一 target、operation、draftId/revision 结算；新文字图片不受旧回执影响 |
| 新 generation/native/account | 旧 operation 只作历史结果查询；旧 upload 不获得新目标资格。用户显式重新准备前重新验证所有 bytes 与权限 |

未知不表示永远无法结算：可信原生 receipt 或历史中的原生关联 ID 可提升为已接受/确认；文字相等、图摘要相等或 operation 查询404不能证明未派发。客户端取消查询不取消 native。unknown 引用不得 TTL 释放；只有可信未提交/终态结论或所属 Session/记录明确删除后释放。

### 确定未派发与旧操作查询

受信 pre-admission 分类不需要新增`dispatchEvidence` wire字段。服务在解析/认证后，先按原actor/Session/operationId查已有操作，再检查可变化的目标、模型和输入限制；已有操作只返回原事实或operation_conflict，不能用新的capability_changed伪装原操作从未派发。仅首次合法请求、该ID从未登记/授权/派发，服务确定的接纳前 `capability_changed|target_changed|message_image_limit|image_budget_exceeded` 分支可以没有operation行；该路由保证这些严格图片错误分支只在上述条件返回。浏览器须验证认证主体、请求对应、图片协议与严格body后，持久保存该可信拒绝为内部definitive_not_dispatched，再允许修复后的显式新operation。代理同名code、通用401/403/404、5xx、解析失败、operation_conflict、超时/丢回应和GET404均不提供此证明；已进入派发的后续错误走operation结果，不能返回这些接纳前分支。

已登记操作的rejected/failed/expired并不天然代表未派发：只有公共派发模块已持久证实尚未原生调用，或精确原生profile证明本次调用确定未接纳时，才可用既有ProviderReceipt/operation结果作可修复拒绝；后者明确区分“已调用但未接受”，不能记录为调用数0。不能证明未接受的原生错误维持unknown。按原profile的错误类型及关联证据持久化分类，禁止通用SDK异常直接映射成可重发rejected。已经接受后的部分附件交付失败不回退：在原operation和消息中持久关联缺图/失败原因，关闭有问题profile，即使草稿已清也可回看失败；不能只发toast或变普通rejected。

旧operation按原Session只读规则、原actor及执行owner既有可见边界查询，并继续受当前访问权/parent credential/删除屏障约束；任务current claim不同不取消合法历史查询，也不新增操作授权。浏览器从原冻结intent恢复target/draft身份，不假设既有operation回执新增target字段。所有图片新增字段留在图片表示，纯文字和旧投影不承担新的拒绝字段。

## 定位符、采集与读取

### 定位符

```ts
type ImageOccurrence = {
  imageId: UUID;
  entryId: UUID;
  container: "content" | "tool_output" | "reasoning";
  partId: UUID | null;
  sourceRevision: Decimal | null;
  sourceTextSha256: SHA256 | null;
  callId: string | null;
  sourceKey: string;
};
type ImageLocator =
  | { kind: "resource"; resourceId: UUID }
  | { kind: "native"; provider: "codex" | "claude" | "copilot";
      nativeSessionId: string; nativeMessageId: string; nativePartId: string }
  | { kind: "local"; path: string; contextId: UUID }
  | { kind: "external"; url: string };
type NativeImageSource = {
  provider: "codex" | "claude" | "copilot";
  nativeSessionId: string; nativeMessageId: string; nativePartId: string;
};
type ImageCaptureRequest = {
  captureId: UUID;
  attemptId: UUID;
  occurrence: ImageOccurrence;
  locator: ImageLocator;
  nativeSource: NativeImageSource | null;
};
```

该请求只接受受信 Controller/投影器建立的消息关联；浏览器可请求服务重新处理已登记 imageId，但不能自由构造 local/native locator 或 contextId 来读取文件。sourceKey 是生产端持久来源键（UTF-8 ≤1024 bytes、非空、无控制字符），不是随重绘变化的 DOM 索引。container=tool_output 时 callId 必填且属于原工具，否则 callId=null。entryId 必须是本 Session 的真实条目，sourceKey 与 imageId/entryId 绑定不得复用到另一出现。

resource locator 须验证该 Session/记录已有引用；native locator 由 Provider 私有映射取得 bytes，不能跨 nativeSessionId。nativeMessageId/nativePartId 采用 ≤1024 bytes 非空原生字符串；不包含 Base64 内联数据，无 ID 的原生 block 由适配器持久生成私有键。local path 接受相对、绝对、file://，UTF-8 ≤8192 bytes、无 NUL；contextId 由 Controller 登记消息来源文档目录或 Session 工作目录与允许根范围，不允许客户端提交新的允许根。[来源采集设计](session-image-sources.md) 核验真实路径和符号链接后的范围；缺上下文则使用同 Session 的已登记工作目录，没有可信目录就 context_unavailable，不按网站根目录拼接。

external url 仅 HTTP(S)、≤8192 UTF-8 bytes、无内嵌用户名密码；[外部来源设计](session-image-sources.md) 对解析结果、DNS/IP、每次跳转、连接实际对端持续复核公有目标边界，拒绝本机/局域网/云元数据。既不转发 Daynight token/Cookie，也不使用浏览器其他站点 Cookie。原始 URL/本地路径留在已授权的来源上下文，不放进图片下载地址或服务错误消息。

[来源采集设计](session-image-sources.md) 只登记真实 Markdown AST 的 image 节点（含引用式）；代码/普通文本不产生 capture。[外部来源设计](session-image-sources.md) 的网页抓取与 [来源采集设计](session-image-sources.md) 的本机读取是不同能力，不能因 URL 解析失败降级成本地 path。

采集不借用输入uploadId或InputMime白名单。Controller→服务使用 `image_capture` 帧（protocol、ControllerFence、requestId、action、body），服务→Controller为 `image_capture_result`（同envelope、action、result/error二选一）。它们也走媒体队列，查询需要当前已授权Controller；原native/generation的采集可以在已有归档上传权限下结算，不授予新原生发送权限。

```ts
type ImageCaptureReceipt = {
  captureId: UUID; attemptId: UUID; revision: Decimal;
  occurrence: ImageOccurrence;
  state: "reserved" | "copying" | "committed" | "failed";
  resourceId: UUID | null;
  resource: SessionResource | null;
  error: ImageError | null;
};
```

| action | 请求body | 成功result |
| --- | --- | --- |
| `register` | ImageCaptureRequest | ImageCaptureReceipt；先核验消息关联/locator 来源并登记原身份；兼容 reserved 不代表容量预留 |
| `commit` | `{captureId,attemptId,validated:ValidatedImage}` | receipt进入copying。服务对MIME/尺寸/限额再次校验，Controller须保留本地准备直到提交或释放 |
| `query` | `{captureId}` | 原receipt；缺失的 capture 返回 `capture_not_found`，不证明先前 register 未发生，原身份先观察再决策 |
| `failed` | `{captureId,attemptId,error:ImageError}` | 尚未committed者进入failed并保留原清理责任，保留ImageUnavailablePart；committed者拒绝回退 |

reserved/copying时resourceId非null、resource=null、error=null；committed时resource非null且available、ID相同、error=null；failed时resource=null、error非null，已分配的resourceId可以保留作诊断但不归档为资源。revision 是服务单调正 Decimal。服务复制时通过image_request的 `read_capture` action发 `{captureId,attemptId,sha256,byteLength,offset,limit}`，Controller回PreparedImageChunk，preparationId 精确等于 attemptId。摘要和长度绑定原 attempt 的 validated 结果，offset 小于总长，其他块规则与 read_prepared 相同，支持 DisplayMime 五种格式。每个准备对象严格区分 upload/capture 命名空间，capture 文件按 attempt 隔离，旧 attempt 的块不能混入新准备。

当前 fence 下的确定图片业务拒绝以同一请求的 `image_capture_result` 返回，不关闭 Session 通道。可以保存控制身份时，register 的确定拒绝保留原 capture 和 attempt 的 failed receipt，resourceId 为 null；已有身份的确定失败也保留原身份。身份或失败回执未能保存时如实返回存储错误，不伪造登记。连接失权、非法帧和 fence 冲突仍按连接错误处理。文件已发布而数据库提交结果未知时，保留原文件和身份并协调原操作；不能将其当作确定失败或删除可能已被引用的内容。清理失败保留清理责任与错误。

账户媒体速率准入在读取或登记 capture 身份之前执行，`rate_limited` 表示该请求未通过准入。Controller 本地连接未就绪或请求槽已满也在发送前明确拒绝；这些确定未发送的请求保留原 register、commit 或 failed 内容，冷却后以同一 capture 和 attempt 重试。提交使用原 validated 结果，失败结算使用原错误，不重新读取来源。发出请求前持久标记结果未知；若响应丢失，重启后只查询原身份。后续查询得到 `capture_not_found` 仍不能证明该请求未提交。

register 前的完整历史同步未完成时，capture 帧尚未发送。历史结果未知保留冻结文件和原 syncId 并先按该身份查询、协调；写入非成功响应也先观察原回执，不能推断提交失败。服务确认 failed 后，Controller 持久保存实际 ImageError（包括 `quota_exceeded`），采集前读取并报告该确定原因，不伪造服务 capture 回执；仅后续完整 checkpoint 确认成功才清除保存的失败。

服务取得字节后核验摘要/长度并按实际总量检查并原子提交 blob、occurrence 快照关联，receipt变committed，公开available；未成功的状态只产生pending或ImageUnavailablePart。首次成功后captureId查询始终对应同bytes；同captureId的原register请求、occurrence和locator不可改变。copying/committed及同一attempt中已确认的validated摘要不可替换，变化返回capture_conflict。只有从未committed、已进入failed、旧 writer 实际停止且旧 staging 已释放后，唯一来源重试端点才可在原captureId/locator/occurrence下分配新attemptId、内部upload/chunk身份和reserved准备，接受改变后的源摘要；旧attempt迟到commit/failed/read均拒绝。精确重放原register只观察当前receipt，不触发重取源。query只需captureId，结果未知时不要求调用方猜测新的attemptId。服务提交回执丢失时Controller只query，不能另分配resource或更换已采集字节。提交后重新获取必须新captureId/resourceId/imageId及显式的新记录关联。

### 出现登记顺序与原生来源键

采用两阶段既有通道，不新增另一套source事件。第一阶段Controller持久entry/出现位置并经原sourceSeq/outbox发送timeline upsert（或完整历史账本同步），取得覆盖该位置的service ACK；没有资源槽时该位置用ImageUnavailablePart或待采集表示。第二阶段`image_capture action=register` 的 ImageCaptureRequest 包含必填 `nativeSource:NativeImageSource|null`，ImageOccurrence 包含 `container:"reasoning"`及必填 `partId:UUID|null`、`sourceRevision:Decimal|null`、`sourceTextSha256:SHA256|null`；后三者对于Markdown/reasoning绑定必须完整非null，独立原生image part均null；tool_output必须callId，其他container的callId=null。sourceKey沿原规则绑定一次出现。NativeImageSource为 `{provider,nativeSessionId,nativeMessageId,nativePartId}`，值沿本设计 native locator限制，由受信Provider持久映射产生，不携URL/本地path；可信键不存在为null，不按相似文字/摘要臆造。它与locator分别表达“所属原生位置”和“取bytes的方法”，Markdown源也可带nativeSource。

register在短事务内验证第一阶段已确认位置/revision/hash，持久sourceKey/nativeSource/原出现映射（确定失败也持久相应出现失败身份），然后返回ImageCaptureReceipt；收到reserved才允许source IO。receipt沿同一扩展ImageOccurrence返回，nativeSource不向Web公开。重放同capture/出现必须精确匹配；sourceKey与已有nativeSource不能改绑，Controller可信alias只在同canonical出现的专用内部映射事务追加。第一阶段无法送达时outbox保留且不读源；register未知只query原ID。服务归档冻结同一记录来源索引并核对每项原出现/资源hash与timeline，manifest不包含私有locator。停止后的最终同步先确认原位置，再以原stopped权限登记已发生的本地来源与已有validated结果；不得启动新的来源IO。自有上传图的原生回显也在位置ACK后以locator={kind:"resource",resourceId:原上传资源}执行同一register，提交原imageId与可信nativeSource；已available同Session资源直接返回committed，仅原子增加出现引用和来源映射，不重新读源、不分配blob、不重复计资源槽。captureId仅标识这次关联事务而非第二次输入；它既不确认原生接受也不解除unknown。服务离线resume读取该冻结索引；nativeSource=null只影响无法证明的新Session导入，原记录图片仍可读。仅有未上报的本地映射且Controller已丢失时明确context_unavailable，不伪造恢复。

### 图片读取

```ts
type ImageReadRequest = { resourceId: UUID; offset: Decimal; limit: number };
type ImageReadChunk = {
  resourceId: UUID;
  sha256: SHA256;
  byteLength: Decimal;
  offset: Decimal;
  data: string;
  eof: boolean;
};
```

在线/归档图片均按已授权 owner+resourceId 读取；不接受客户端选择本地路径或对象存储 key。HTTP 为 `GET {base}/resources/{resourceId}/content?offset=<Decimal>&limit=<integer>`，携带内容 revision header 后返回200 ImageReadChunk；limit 为1..524288，offset≤byteLength。data 使用标准、规范填充的 Base64（重新编码应完全相等），最多699052字符；offset=length 仅返回空 data、eof=true。其他块非空、decode长度≤limit，eof 当且仅当 offset+decode长度=byteLength。每块摘要与长度是完整文件的期望身份，不是块摘要。读取端验证连续偏移、相同 resourceId/hash/length，最终 SHA 匹配后才显示/下载。HTTP 失败沿现有服务错误 envelope，不在 data 内夹带错误文字。

统一 reader 同时保留旧资源的零字节原件。该描述符必须没有图片扩展、byteLength="0" 且 sha256 为规范空 SHA-256；客户端仍发送 offset="0" 的已授权读取，服务打开并核验实际持久原件，返回同 resourceId/hash/length、空 data 和 eof=true。客户端核验该响应及空字节摘要后才能提供下载，不能仅按描述符合成空 Blob。新图片、图片准备、history 和 timeline 仍要求正长度。

archive reader 以 recordId 所属授权解析 resourceId；在线 Session 的新 generation 不修改旧记录的图片归属。服务可直接从已保存 blob 读取，不依赖 Controller；仅尚在采集的资源由 Controller 通道读取。跨连接 chunk 要验证同一不可变身份，旧请求响应不得混入新请求。浏览器按 origin/account/owner/resourceId/hash 缓存，先验证当前授权再用缓存；图片 URL 不是 bearer 公开地址，响应 `Cache-Control: private, no-store`。访问撤销/账户切换/记录删除后立即撤销当前 Blob URL、敏感预览和下载资格，保留阅读位置的普通权限复核不能重挂图片。

Session 账户刷新停止能力可独立关闭 live 或固定记录的远端媒体 reader，拒绝新读取和下载，同时保留原图片 scope 与已解码 lease。它不改变认证 generation，也不代替根 owner 对真实账户切换、撤权和记录删除的清理策略；现有根清理仍可销毁 scope。浏览器生命周期与展示边界见[图片浏览器设计](session-image-browser.md)。

### 来源资格与唯一重试

唯一来源重试端点为 `POST {base}/image-occurrences/{imageId}/retry`，严格body `{}`，返回 `{capture:ImageCaptureReceipt}`；服务向Controller发送 `retry_capture {captureId,attemptId}`，成功结果为该attempt的ValidatedImage。POST只接受已登记原出现、可信local/external来源及当前操作权限，不接受新locator、headers或actor。

出现状态端点为 `GET {base}/image-occurrences/{imageId}`，严格返回 `{imageId,revision,state,resourceId,action,error}`，全部字段必填；revision为服务单调Decimal，resourceId/error可null。state为unregistered/pending/unknown/failed/committed/unavailable；action为none/observe/retry_source/read_saved。unregistered/unavailable仅none；pending/unknown仅observe；committed仅read_saved且resourceId非null；failed只有从未committed、旧 staging 已清理、来源可信且当前可操作才retry_source，否则none。pending/committed/unregistered的error=null；failed/unavailable必须有安全ImageError；unknown可有协调错误。pending 的原登记身份可有 resourceId，其余未提交终态为null。未授权按原隐藏存在性错误拒绝，不返回unregistered泄漏信息。GET不创建出现、不采集，unknown只协调原ID。

错误profile显式区分input、saved、uncommitted local/external。可信来源已确认failed且完成旧 staging 清理后，invalid_image/unsupported_media_type/decode_failed允许用户请求重新准备并完整重验原locator；input及saved不因此改变never规则；forbidden/permission_denied不能靠retry绕过。已committed只重读同原件，不能“重试”换源字节；重新取源需新明确出现/记录。只读归档永远无retry_source。资格由服务action决定，UI不得按错误文案猜测。

## 错误与失败分层

```ts
type ImageError = {
  code: ImageErrorCode;
  message: string;
};
```

message 是 ≤256 UTF-8 bytes 的非空安全说明，不含 token、凭据 URL、主机敏感路径或内部堆栈。图片身份由所属 receipt、occurrence 或 part 提供，不在 error 中重复。客户端根据 code 展示本地化提示，不能按 message 推断状态。重试动作是操作状态与来源资格的结果，不是可由客户端自由使用的 error 字段；未知 code 不自动重试，显示一般错误并保留草稿。

| code 集合 | HTTP/动作 | retry 与效果 |
| --- | --- | --- |
| invalid_payload, invalid_image, unsupported_media_type, decode_failed, digest_mismatch | 400/422 | never；具体图片修复或重新选择，不发剩余内容 |
| image_too_large, message_image_limit, image_budget_exceeded | 413 | prepare；移除/更换图片或获得容量后重新准备；原有内容不删 |
| permission_denied | 403（按既有隐藏存在性规则可404） | never；停止缓存使用；恢复真实权限后重新读取目标 |
| stale_fence, target_changed, capability_changed | 409 | prepare；重新观察目标，不能自动重发 |
| model_unsupported, capability_unknown, provider_unsupported, component_unsupported, policy_restricted | 409 | never；对应操作明确禁用，能力变化后重核 |
| upload_conflict, capture_conflict, chunk_conflict, operation_conflict, archive_conflict, upload_in_use | 409 | query；查原身份，绝不换 ID 冒充同操作重试 |
| upload_expired, upload_released | 410 | prepare；本地 bytes 仍可用时显式重新准备 |
| resource_not_found, source_unavailable, context_unavailable, source_forbidden | 404/409/403 | source_unavailable 可 read；其他 never；保留所属图片位置 |
| storage_unavailable, read_failed | 503 | read 对读取；prepare 对明确未完成上传；未知写结果仍先query |
| upload_outcome_unknown | 结果未获确认的客户端/恢复状态 | query uploadId；不得声称服务 failed |
| send_outcome_unknown | 结果未获确认的客户端/恢复状态 | query operationId；不得自动重放 native |

网络错误不是一个服务端已提交失败回执；HTTP 202 是进展状态，不是 error。operation.error、媒体帧及 receipt 中的 ImageError 均保留 `{code,message}` 严格形状。HTTP 错误沿服务统一 envelope `{error:{code,message,requestId}}` 及已有可选 details，客户端验证原认证主体与请求后读取；不将其当作 receipt。当前适配使用 invalid_image/image_integrity/image_decode_failed（400）、quota_exceeded/resource_in_use/component_unsupported/capability_changed（409）及 media_outcome_unknown（503）等服务错误；上表的恢复原则同时适用。unknown upload/send 不需要服务知道浏览器断线，客户端可本地表示未知但不能覆盖服务已知的成功。

## 容量、存储保证与归档交换

固定二进制单位：单图 `10485760` bytes，单消息图片合计 `20971520` bytes，最多8张。总量按每个附件实际长度求和，即使摘要相同也逐项计数。图片展示采集同样使用10 MiB文件上限，至少保留PNG/JPEG/GIF/WebP/AVIF；更大来源明确 image_too_large，不改变输入白名单。

单 Session 的已接纳正文、索引、图片原件、已提交 descriptor 和已发布 manifest 合计不得超过 134217728 bytes。相同 resourceId 多引用只计一次，不同 resourceId 即使摘要相同仍分别计。失败或 unavailable 出现作为正文的一部分计量，未提交暂存和不含内容的控制记录不计入总量。旧 prepare/register 不预留容量；实际发布在 Session 锁下重读最新事实并检查候选。已确认重放不重复计量，旧大记录保持可读，不能删历史腾空间。精确算法和失败责任见[归档设计](session-image-archives.md#容量预算与准入)。

兼容 `ImageBudget` 保留七字段：`maxBytes=1073741824`、`maxResources=1000`，`committedBytes` 与 `committedResources` 反映真实已提交资源，`reservedBytes` 与 `reservedResources` 为零，`revision` 保持既有单调观测。该兼容值不是新写入的总量策略，实际计量不截断旧大记录。

图片内容走独立有界通道：512 KiB 原字节块，2 MiB 控制帧上限保持。每个 Session 至多两个媒体块同时在途，控制/receipt/历史请求优先；不能一次将整张图/Base64写入 command、事件批次或归档 JSON。服务/Controller按块持久化和摘要，不能每读一块全量解码图；浏览器允许为预览持有本次完整10 MiB Blob，但不得把全历史图片预加载到内存。全服务并发/背压/磁盘水位算法由 服务上传与鉴权模块/Controller 存储模块 设计，不能破坏这些单通道边界。

已保存图片先存在服务的 Session 私有 blob 存储，输入成功与采集 available 均在服务保存完成后成立；Controller 本地文件作为原生消费缓存，不是唯一历史副本。关联消息前是上传引用，关联后是消息引用，归档可添加记录引用。清理最后一个有效引用才能物理删除，unknown operation 是有效引用。草稿删除释放自己的准备引用；未发送 complete 原件失去最后引用后还须完成物理回收，不能只撤 pin 而遗留未清理资源。Session 或记录删除走其原有权限和删除屏障，并同步失效对应客户端缓存。

## 协商与旧数据边界

Controller hello 以 contentRevision2 协商媒体，服务为该连接保留实际revision。新welcome保持原limits；能力和预算位于同一snapshot中，不增加竞争的imageLimits常量。媒体不足时返回component_unsupported并提示升级，网络失败或权限失败都不是支持证据。

浏览器通过既有Session resolver调用 `GET {base}/image-capabilities`，携带 `Daynight-Session-Content-Revision: 2`，严格读取 `{contentRevision:2,capabilities:ImageCapabilities,budget:ImageBudget}`。共享资源客户端绑定origin、actor、完整fence和授权代次；代次失效先停止发布，取消并等待读取完成。媒体profile关闭不阻止授权读取已保存原件。

| 组合 | 结果 |
| --- | --- |
| 新浏览器、旧服务 | 原文字流程，禁图片操作并保留草稿；旧记录可读 |
| 新服务、旧 Controller | 原 welcome/payload/send，图片 component_unsupported，不下发图片帧 |
| 新服务和 Controller、旧浏览器 | 旧文字会话继续使用既有合同；统一媒体记录要求升级reader，不维护图片转文字的第二套生产投影 |
| 新组件、原生能力 unknown | 禁相应图片输入，读取已存图片仍按独立权限；文字能力独立 |
| schema1 旧归档 | 原 decoder/实际资源，无 bytes 不伪造已保存图 |
| schema3、旧读者 | 明确要求支持统一 reader 的版本，不生成 schema1 兼容副本；原操作身份和已保存原件仍保留 |
| Herdr/v2/schema2 | 原 terminal_recording/native_snapshot 包装、paste/keys 和归档语义不变 |

媒体块不分配时间线序号；统一资源事件保持原resource kind、eventSeq、historyEpoch及entry身份。旧数据转换只在读取/迁移边界，新内核不重复维护文字降级投影。

schema3 timeline 的精确 UTF-8 编码最多 134217728 bytes、100000 entries，还必须满足 Session 实际内容总量；schema1/2 的 64 MiB 边界保留。归档封存必须确认所有 Markdown/reasoning 图片绑定完整且 imageProjectionError=null；图片出现集合未知不能由空数组判定 complete，也不能伪造缺图项变为 partial。状态摘要对应实际原 bytes。schema3 manifest、timeline、旧数据原文件与状态/读取接口见[归档设计](session-image-archives.md)。

## 服务上传、权限与持久提交

### 鉴权与锁顺序

Task base 为 `/api/v1/projects/{projectId}/tasks/{taskId}/sessions/{sessionId}`；Test/Bot 为当前 resolver 的 `/api/v1/test-sessions/{sessionId}`，Bot 还须关联检查和删除屏障。历史记录只提供读取。serverOrigin 来自受信配置，不信 body/Host；actor 来自当前认证。Task 读取沿 `ReadProjectAccess`（含 Team 继承）；输入上传与执行交互还要求认证 actor 等于持久 Session owner，其他管理员与成员只读。Test/Bot 沿 owner/parent PAT。

创建、写块、继续验证要求原 actor、当前准确 target、活动生命周期、操作权和图片输入资格；准备不要求此刻可 steer。GET 原上传仅要求原 actor 和原 Session/历史访问权，不要求 Controller 在线或 current claim 仍相同；它不重新授权新目标。DELETE 要求原目标当前操作权，并与发送引用竞争。已发送图片由合法读者读取，不要求读者等于上传者；未发送资源仅在原 actor receipt/私有授权中可见，不广播。

原件读取在已授权 Session 短事务中复核资源引用：`message` 引用允许共享读取；`upload` 引用须匹配当前 actor、原 complete receipt 和 resourceId；`archive` 引用须匹配已发布 ready schema3 的 bundle 或 migration 身份及 manifest hash。准备中的归档引用和 `operation`、`unknown`、`native_resume` 保活引用不授予共享读取权。无合法引用返回 not found，避免暴露私有原件。文件读取完成后再次复核同一授权及删除屏障，已撤销的引用不能产生迟到成功响应。

Cookie 写必须精确主站 Origin；PAT 沿既有认证，不接受 query token。用户 REST 使用[统一精确 CORS](daynight-auth.md#用户-rest-的精确-cors)，原图片权限与生产者凭据要求保持。Web 保留 `credentials:"same-origin"`、`redirect:"error"`、`assertResponsePrincipal` 和 `Daynight-User-ID` 核验；身份等待结束、真正 dispatch 后才计网络等待。`IndependentSessionReadDenied` 的已认证 409 resource_conflict 仍是删除/归属屏障。所有响应及错误为 private,no-store。

Task → 访问/Session、Bot → Session 为父锁顺序，随后 upload、resource/引用；多资源按 UUID 排序。网络、文件、解码不持数据库锁。块 ACK、available 发布、异步恢复和 operation 授权提交前，短事务再次核对凭据、权限、target、删除屏障、原 revision/intent/fence。撤权先提交则停止推进；上传先提交的 bytes 仍可能存在，但后续读取受新权限约束。取消请求不能收回已经取得的 bytes 或证明回滚。

### 规则校验与存储原子性

core 拥有图片协议、状态转换、期限、正文和摘要的校验，以及账户令牌桶的容量、补充与消耗决策。DAO 保存明确的记录和候选值；SQL 中的身份、原值、引用与 lease 条件负责在实际写入时拒绝并发变化。新媒体表保留主键和必要的并发唯一索引，不增加业务 CHECK 或外键级联；Bot Session 的最终删除按 intent→operation、reference→resource、chunk→upload 的依赖顺序显式清理。账户速率桶独立于 Session，不随单个 Session 删除而重置。既有 schema1/2 归档约束保持原保证，schema3 不增加对应数据库业务校验，其合法性由共享协议解析和 core 的闭包验证拥有。

账号速率桶只锁定该 owner/category 的一行，core 在同一授权事务内读取并计算明确的替换值。新准备按 control→prepare 固定顺序处理两个桶；短事务中的行锁避免两桶分离竞争后重放整个已授权操作，不跨文件或网络 I/O。时钟回拨保留原时间，越界持久值明确拒绝；提交未知仍沿原操作身份核对。

采集的单调状态转换、失败重试资格和旧 staging 已释放由 core 在 Session 锁内判断；DAO 对原 request、receipt 和 validated 做精确预期值校验，再保存明确的候选结果，零命中返回冲突。媒体 lease 的全局64、账户8、Session2上限由 core 作为明确的原子占用条件传入，DAO 在部署准入锁内比较实际计数，不能用默认零值跳过检查。

source ACK 的保留策略由 core 拥有：先核原 identity/hash，再按当前 epoch 和通过序列计算2048序列窗口，将明确 cutoff 交给 DAO 删除旧记录；读取真实 count 后执行8192条准入。相同原 ACK 重放先返回既有摘要，不因满额清理或创建新身份；窗口外缺失的旧 ACK 明确拒绝，未知提交不重放。

实际内容发布在 Session 锁内读取最新完整索引、可用资源和已发布 manifest，并用实测候选计算总量；相同 Session 的并发发布因该锁串行。跨 Session、账户与部署的媒体 lease 并发集合仍由部署准入锁协调，锁等待传递 context 与 deadline，后续 I/O 由 durable lease 和精确文件锁保护。

### 两端块确认与提交恢复

正常路径服务持久暂存块并转发 Controller。服务 receipt 直接返回，不包 `{upload:...}`；JSON 请求上限 16384 bytes。块 body 1..524288 bytes，单值摘要 header、规范 offset，无未知/重复 query、不允许压缩/multipart/Range；Content-Length 不符、非 identity Content-Encoding、重复摘要或超长实际流均拒绝，确认前缀不变。无 Content-Length 的正常有界流允许。框架 401/405、协议错误和非业务 envelope 保留 HTTP 语义。

每 upload 同时仅一项变更 intent，固定 offset/length/digest。顺序为：持久 spec/24h 到期和身份 → Controller prepare；块校验 → 服务暂存和块 intent → Controller 落盘 ACK → 服务复核并提交 acceptedOffset → HTTP receipt。receiving 不证明 Controller 已准备好，首块前必须协调成功。重复块要求原边界、长度、digest 和实际 bytes 完全相同，不接受部分重叠或另一切块方案。

| 断点 | 原身份恢复 |
| --- | --- |
| 服务块存在、Controller write 未知 | status 原 upload；只发已登记同一块，或核对本地偏移与同 spec/intent 后确认；不得超过服务已登记连续前缀 |
| Controller 准备丢失、服务确认块存在 | 同 target 重新 prepare，按已确认块重建；public offset 不倒退，本地追平前不接新块 |
| 浏览器块响应丢失 | GET 原 upload；确认没前进后沿原完整块重传，已前进则从新偏移继续；查询失败保 unknown |
| complete 响应丢失 | GET 原 complete/resource/hash；不能注册第二资源或重新扣费 |
| blob 已落盘、SQL 未提交 | 可恢复孤儿清理；没有 complete，不从孤儿文件自动发布 |
| SQL 已提交、响应丢失 | 原持久 complete 是事实；重启不回退 offset 或终态 |

完整长度后持久 verifying（202，已完成可200）。Controller 和服务分别完整校验原 bytes、MIME、hash、长度、画布及 frameCount；双方一致后 blob 先耐久，再在 SQL 事务核对实际内容总量并发布 available、建立上传引用和 complete。文件与 SQL 不是一个事务。`read_prepared` 仅作同身份缺块协调，不要求正常路径再传一遍全图。图片局部故障不关闭健康文本 Session。

验证由持久工作驱动，HTTP 断开不删除工作。每次恢复核对原 actor 凭据及目标；同账户新的有效变更请求可在复核后接管未完成准备授权，GET 不能刷新授权、expiry 或 owner。一次 attempt 最多60秒，暂时 IO/离线保持 verifying，1/2/4/8/15秒抖动退避；确定解码失败为 failed，到期 expired。超时 cancel+join 执行单元及释放 IO 后才返还并发槽，不能用超时推断写失败。

服务解码器保留父请求的取消和 deadline 原因，在子进程退出并 join 后返回原 context 错误。解码器自身预算耗尽同样返回 deadline，不转换为内容拒绝。HTTP 断开或请求到期不转换为 `image_decode_failed`，不提交 failed 或清理原验证工作；后续有效请求仍可沿原 uploadId 完成验证。

### 发送、释放与到期

发送授权在一个事务校验完整有序输入、全部 complete/upload 身份、目标、能力、20MiB/8张与实际输入资格，持久 intent 并取得全部 pin。任何一图失败整条拒绝。DELETE 先提交使 released，迟到验证不能复活；complete 先提交而无其他有效引用时仍可释放；发送先取得 pin 则 upload_in_use。DELETE 保留原 uploadId、BlobID、spec 和固定 expiry 的 tombstone。仅取消浏览器等待不是 DELETE。

零引用回收在授权的 Session 锁内将资源标记为 `gc_pending`。标记保留原 descriptor、blob 路径和资源行，资源仍计入已接纳内容；它拒绝新增该资源的引用和 lease，也拒绝可能使用任意 Session 原件的无 resourceId lease。其他仍有合法引用、尚未进入 GC 的资源可正常交接 message/archive pin。清理持有原 upload 的 `PrivateGate`，对已有相关 reader/writer 取得其原 lease 的 exact gate，证明执行单元退出后才撤销 durable lease；活跃 owner 返回 busy。原件及 staging 物理删除并完成文件存储屏障后，最终事务复核原身份、零引用和无相关 lease，再删除资源行并确认 staging 已释放，此后才停止计入该资源。staging 回收按 typed Session namespace 与原 uploadId 完整清扫 uploads 子目录，不仅枚举已提交 chunk 行：文件发布后、chunk 行提交前崩溃或事务失败留下的孤儿也必须删除。清扫与 read response 落盘共享该 upload 的精确 payload gate，先证明全部原 writer 已退出，持锁至目录耐久删除及最终状态确认，防止清扫后迟到重建。旧媒体账本内的原件副本也须先按原值完成元数据化，不能仅删文件便宣称清理完成。任何物理失败、事务失败或 unknown 结果保留可观察状态和未确认清理责任，通过同一 tombstone 重入；receipt 已变 released 或 expired 不证明磁盘空间已释放。

24h 从首次创建固定，精确重传、读取、重连不续期，每次事务和有界清理扫描均检查。未占用 receiving/verifying/complete 可到期；sending/unknown/消息/记录引用不随 TTL 释放。failed/expired/released 保存最小 tombstone 到所属保留期结束，相同 uploadId 不复活；不能为腾身份而删除仍需保留的 tombstone；身份数量不作为预申请容量门禁。

GET 通过原 Session 的历史读取 scope 复核认证、项目访问与 upload actor，不要求 Task 仍处于原 claim；它不授予新目标或发送资格。固定到期后，receiving/verifying 转为 expired；complete 只有在 Session 锁内确认不存在自身 upload pin 之外的有效引用时，才撤销自身 pin、清空 receipt.resource 并转为 expired。原 operation/unknown/message/archive/native_resume 引用存在时保持 complete；complete 重放沿同一存储保留规则返回原状态，精确 prepare 重放只返回原身份当前终态，不延长 expiry。其他引用只保留原件，不授予到期后的新发送资格；新发送准入拒绝过期准备。已经登记的原 operation 精确重传返回原回执，其派发重核只接受绑定该 operationId 的原 operation pin，不能借另一操作或历史消息的引用创建新 intent。

停止后的 archive prepare 和 seal 使用相同规则主动结算到期上传，不依赖原客户端再发 GET 或 DELETE。结算先在数据库 scope 外取得原 upload 的 `PrivateGate`，再重读固定 expiry 和当前身份，确认 writer 已退出才进入 expired 并清理 staging；不能仅从归档屏障中过滤过期行。failed/expired/released 的 staging 或原件尚未清理时，同一结算入口继续回收，未完成者仍阻止 seal。曾创建远端 preparation 的上传必须读到原 prepare/release 身份下完整且匹配的 Controller release 确认；离线、verifying、缺失结果或 unknown 均不能推断远端已释放，不宣称原清理已完成。 原 prepare 若已持久完成且仅有 error、没有 result，服务在重新核验其原 request/action/spec/fence 后，可使用携带精确原 spec 的原 release 身份继续回收；确定失败不证明没有残留文件。Controller 核验已有准备的完整 spec，缺行时持久 released tombstone，阻止迟到 prepare 重建；仍须等待原 decode/read/pin 退出并完成已知路径删除。成功 prepare 的 release 保留原 `{uploadId}` 身份。原 prepare 仍 unknown 时只观察它，不提前 release 或宣称清理完成。

明确未派发或可信未接受结论解除 operation 占用，尚未过期上传可保留；原生接受后先建消息引用再解除冗余上传引用。unknown 保留。归档先建立记录引用再允许 Session 清理。浏览器移除只释放其草稿，权限撤销只取消该 actor 访问，均不能删除其他合法引用。

### 共享物理空间与调度

多实例使用共同可读、具耐久语义的暂存/blob 后端和共享账本；无共享后端不得开启多实例图片写入。只有数据库当前拥有 Controller 连接的 relay instance 派发；其他实例登记有界工作，不夺 epoch。通知仅唤醒，无通知最多250ms查询一次，HTTP 等结果最多15秒。连接重建协调原 upload；进程内 pending map 不是持久队列。

| 维度 | 上限与行为 |
| --- | --- |
| 媒体块 | 每 Session 全方向、跨 epoch 合计2；每账户8、部署64；每 upload 一项变更。归档文件≤1MiB、每Session一块，也占公共媒体槽 |
| 控制速率 | 每账户20次/秒、突发40；新准备2次/秒、突发8；GET/DELETE各有独立20次/秒、突发40的小配额；服务持久账户token bucket跨Session和实例协调，429 rate_limited不消耗原操作身份 |
| 调度 | Session公平轮转；控制/回执/心跳/历史元数据在块边界优先，已开始WS帧不抢占；写超时5秒、块/状态等待15秒 |
| 解码 | 服务最多2个可终止执行单元，单图15秒、外层attempt60秒；不占WS发送锁 |
| 实际写入 | 不预留未来副本或归档空间；实际磁盘不足和文件失败按真实结果返回，原身份与清理责任保留 |
| 临时拒绝 | 并发、速率及实际存储失败按各自错误返回；未知写仍查询原身份，实际内容总量超限返回 409 quota_exceeded |

共享持久 admission 原子协调，进程内 semaphore 只是优化。租约到期只撤提交资格，不返物理槽；失联、心跳丢失、DB lease 到期、WS 重连均非执行单元停止证明。只有 cancel+join 或监督器确认原进程终止后回收。新实例先协调旧占用，再另取空闲槽，不能把计数清零或继承未释放槽；无可靠终止证明则保守拒绝超额。解码/缓冲/队列实测包含语言运行时副本，512KiB块不等于RSS上限。

普通媒体 I/O 在取得新槽之前读取部署内持久 lease，结束该数据库事务后逐项非阻塞尝试原 owner 使用的精确文件锁。busy 表示原 owner 仍可能执行 I/O，保留其行；成功取得锁后持锁到删除该原 lease 的短事务确认提交，再关闭锁。列举、提交结果或锁关闭未知均返回错误，不凭 TTL 清空计数。该恢复覆盖 Session、账户及部署级计数，服务重启后的孤儿占用无需通过删除 Session 才能回收。

统一 codec 计量已接纳的完整正文、索引、资源和 manifest；最终提交按最新事实检查，完整旧 envelope 仅在旧数据读取或迁移边界计量。准备与发送身份、原 operation 和 pin 的协调不预留未来 Session 容量。ENOSPC 和清理失败按实际结果处理，不删旧图腾空间。

## Controller 文件、解码与生命周期

### 私有文件与 journal

资源 descriptor、blob、pin 与 lease 由 `content/resource-files.ts` 统一拥有，路径不依赖正文表示。`content/session-content.ts` 组合这一文件拥有者与 journal v11 的 SQL 当前正文；释放资源前在原同步 SQL 读快照中核对当前正文和 `native_input_publication_images`，再由文件拥有者核对 pin/lease。[SQL 正文设计](session-sqlite-content.md)拥有当前行、编号转换、退休和压缩。

沿 `controllerExecutionDirectory`，媒体暂存与 pending-content 同属于原 execution，原件不写入 journal 的 Base64 字段。

```text
journal.sqlite
journal.sqlite.media-staging/
  owner.json
  <UUID>.part
  native/<UUID>.bin
journal.sqlite.history-sync/
  <UUID>.json
journal.sqlite.pending-content/
  manifest.json
  index.json
  timeline/          # legacy source retained only until stopped maintenance
  entries/           # legacy candidates retained only until stopped maintenance
  resources/
  blobs/
  resource-pins.json
```

`owner.json` 的 schemaVersion=1 绑定规范 origin、executionId、sessionId 和原 claimId/testExecutionId。每次写入另外核验当前 ControllerFence、writer 与 ImageTarget；目录归属不因代次改变而重建。原 actor 必须满足该 Session 的操作授权。路径组件只用校验 UUID 或私有随机 ID，不拼接用户 name、URL 或 native ID。目录0700，私有暂存0600，验证后的 native 文件只读；Windows 等价私有 ACL 需要平台验证。这些措施不防同 OS 用户的恶意进程。

根及已有父组件须可信，拒绝 symlink/reparse；exclusive create、禁跟随打开、fstat 核验 regular file 与登记身份。来源模块交付已授权打开的 stream，存储模块不能重新按不可信 path 打开。native 仅可硬链接已经复制、完整验证且由 Controller 私有持有的不可变原件，不能硬链接用户可变文件；native pin 保留该 inode 到准确的原生恢复引用解除。

journal 格式迁移007–010与精确 schema 检查拥有以下表；状态和错误存于对应身份记录，不另建重复资源内核。

| 表 | 持久事实 |
| --- | --- |
| timeline_entries | 每个 entryId 的当前规范正文、稳定 entrySeq、真实 revision、UTF-8 长度与 hash |
| timeline_totals | 与正文同事务维护的当前条数和 JSON 字节总量 |
| input_message_origins | 原 operation/entry 身份及 user/daynight 来源 |
| native_input_publications | 原 operation/native identity 的不可变关联回执、实际 publication revision 与 source sequence |
| native_input_publication_images | 原 operation+imageId 对应的稳定原件资源及槽位 |
| input_intents | operationId 的完整规范 intent 与 SHA-256；旧 intent/hash 原样保留 |
| input_observations | 原 operationId 的接受/未知观察 |
| image_preparations | 原 uploadId、完整 spec/target、状态、offset、验证结果及错误 |
| image_chunks | 原 uploadId 下 offset/length/hash 的已刷盘连续前缀，无 Base64 |
| image_occurrences | 原 imageId 的 occurrence、nativeSource、source sequence 与确认状态 |
| image_pins | operation/resource/native 的真实引用、私有路径及释放状态 |
| image_runtime_state | 持久能力 revision、active_history_sync、active_history_checkpoint，以及 Markdown projection/source/context、来源请求计费和 capture-source 私有预留等运行状态 |
| image_captures | captureId/attemptId/imageId 的私有文件及完整验证结果 |

timeline 当前行、totals、Markdown projection、原生图片接收证据/槽位/关联和 outbox 在原 SQLite 写事务中提交或回滚。所有 timeline、inspection、完整历史同步、归档及引用判断读取同一连接的提交快照；普通路径不写候选正文或维护正文 Map。v8–9 已提交候选仅由编号010验证并导入，未引用文件不得公开。导入后旧 WAL 快照仍可能引用旧文件，只有停止维护的成功 TRUNCATE 屏障后才可退休；缺失、损坏、路径或摘要不符明确失败。

Controller 的 `content/resource-files.ts` 负责 descriptor、blob、持久 pin、进程内 lease、资源文件校验和共享资源索引；它不加载正文或初始化 timeline 目录。`content/session-content.ts` 组合 SQL 正文与资源，以当前正文和 descriptor UTF-8 字节数计量逻辑元数据，并把 SQL 引用保护后的删除入口交给媒体导入收尾。停止维护在旧读者屏障后，通过同一资源拥有者耐久清空共享索引的旧 `entries`，保留完整 `resources` 清单，之后才删除旧 timeline 文件。资源目录、Session 绑定、旧资源导出及其校验保持原格式，资源和正文不各自维护一份独立资源索引。新读者跨过退休发布时，只能根据一次确实改变且完整有效的新索引继续打开，未改变或仍不完整的来源继续失败。[资源所有权决策](../../.agents/notes/implemented/architecture/2026-11-12-session-resource-files.md)记录拆分的原因。

具名 `publishNativeInputAssociation` 验证已存在的原接受证据及完整 intent，基于当前 entry 保留原生槽并绑定或追加原件，在同一事务提交 alias、实际引用、occurrence、真实 revision 和确切 outbox 水位。`queryNativeInputAssociation` 返回原不可变回执与当前视图；后续 capture 可以推进当前 revision，不能改变 publication revision。未知结果只查原身份，不重发原生输入。若 COMMIT 与 ROLLBACK 都未确认且连接仍有事务，隔离该连接的所有业务读取和写入；同连接的未提交行不能充当 committed 查询结果。关闭连接不清除原 writer 身份，后续由独立生命周期恢复核对。原生来源采集继续遵守位置 ACK 后 register，不扩张为跨服务的分布式事务。Provider 接线由[Provider 设计](session-image-providers.md#copilot)拥有。存储的 canonical intent 不含传输 `requestId`；本地恢复仅补解析所需的该字段，再重核原 operationId、规范编码及 SHA，不改持久 intent，不把恢复对象当作新的发送请求。

跨 execution 的准入账本位于 `stateDirectory/controller/media/budget.sqlite`，以 immediate transaction 更新 `allocations`。2200 MiB/execution、8 GiB/stateDirectory 包含实际原件、暂存、未知残留与预留；私有硬链接按 inode 只计一次。控制元数据限额为 128 MiB，另有 8 MiB 结算余量，计入真实 SQLite sidecars 与 pending metadata。已提交 `timeline_totals.byte_length` 及与 `active_history_sync` 原身份、路径、长度匹配的完整 history 文件的实际字节另提供相应空间；未登记或不匹配的孤儿文件不豁免。真实正文增长和冻结副本前登记峰值，按 8 MiB 档位更新跨进程账本。关闭 Controller 不释放 native/resume 及未知引用；只有完整 execution 目录最终删除并刷盘后才退还该 allocation。

Decimal 用规范文本/bigint比较，仅在限额内转换文件API安全整数；正文受 schema3 128 MiB timeline 与100000 entries约束，图片原件按需读取，不预载全部图片。prepare 先持久包含完整 spec 和随机私有路径的 receiving 行，再创建并刷盘空文件和目录，全部成功才返回零偏移；创建或刷盘失败仍保留可精确回收的路径。缺行的旧随机文件不能凭猜测删除，仍计入实际占用。块顺序为 write → fsync → immediate transaction提交块及offset → 回执。恢复截断并刷盘未提交尾部；文件短于确认offset或已提交块hash损坏为明确失败，不倒退偏移冒充成功。rename持久源/目标目录，Windows实际flush/rename持久性须独立验证。

### 双端完整解码

Controller和服务采用同一 `image-validation-v1`、隔离 Node.js 24 + sharp/libvips runner。共享纯策略和实现只有一份，Go用受限适配器调用独立已打包helper；两端各执行完整验证。服务镜像与发行包携带runtime及锁定依赖，构建实测五格式profile。仅metadata或首帧验证不足，不能因相同libvips版本推定一致。

完成接收先封写入口，流式核对真实文件大小、原bytes SHA和声明，再嗅探真实容器；禁止SVG/HTML、伪MIME、静默改格式和转码。sharp启用 failOn:"warning"、显式像素限制、关闭unlimited，遍历全部容器画布帧并消费所有输出；不能完成全帧就decode_failed。宽高按存储画布，不交换EXIF方向，不用多页拼接高度。frameCount 是完整解码的1..256事实。

| 解码策略 | 限制 |
| --- | --- |
| 画布 | 单轴16384、单画布33554432 pixels |
| 动画 | 最多256帧，累计67108864 pixels |
| 输出/时长 | RGBA8输出≤268435456 bytes、单图15秒；分块消费丢弃像素，不改原件 |
| 执行 | 单子进程一图、线程1、禁持久vips cache和网络/外部loader |
| 内存 | 每子进程512MiB目标含native allocation；OS硬限制与RSS监控分别报告，监控须记录短时超额及峰值约束，不能拿Node heap当硬界 |

父进程只从绝对配置路径、不经shell启动helper，自检独立产物预期digest/buildId及policy，不从PATH或运行中Controller目录借用。私有管道请求严格 `{version:1,policy:"image-validation-v1",inputPath,expectedByteLength,expectedSha256}`，inputPath是调用方固定并持读lease的私有快照。响应严格 `{version:1,buildId,result:ValidatedImage|null,error:ImageError|null}`，恰一项非null，UTF-8≤16384 bytes，无路径/日志；错误日志另有界脱敏。超时/超额cancel+join整个进程树后才返额度。无helper/完整profile/有效资源约束则图片component_unsupported，文字服务独立。

验证通过后刷盘、rename为随机object并持久目录、SQL关联object/validated/preparation pin，才回 local validated。文件孤儿不能自行升级。service complete 与本地 cache absent/fetching/verified/corrupt/deleting 是不同状态，本地损坏不能回退服务descriptor。

### 原生文件、服务取回与引用

`stageCapture` 只接受 register reserved 后取得的完整私有文件；实际参数为 `CaptureStageInput {captureId,attemptId,imageId,inputPath,byteLength,sha256,declaredMediaType?}`，调用方持有原来源授权和文件租约，存储层重核原 attempt、位置 ACK、私有普通文件及完整摘要/解码。`reserveCaptureSource` 为来源 reader 创建0600空文件，并将来源与验证副本的最坏双份容量计入同一媒体账本；reader 不自行创建资源身份。`readPrepared` 按 upload/capture命名空间、attempt与lease读；`ensureLocalResource` 校验服务原bytes后重建本地verified；`acquireInput` 整组验证并原子保存原intent/pin，返回有序只读native路径，不调用Provider。稳定native文件写随机临时副本、核hash、fsync、设只读、rename并持久目录后才准许pin/dispatching；既有有pin路径不得覆盖。

`media.adoptCaptureResource(captureId,attemptId,resource)` 将已提交的capture原件交给资源所有者。它要求原请求、耐久committed回执、原occurrence及完整resource严格一致，并逐项比对validated的MIME、byteLength、SHA-256、宽高和frameCount。复制前取得共用IO槽并检查保存副本的第三份峰值预算，经 `ResourceFiles.importResourceFile` 按512 KiB分块验证和耐久导入。已有available原件仅核验原descriptor和原bytes；missing/corrupt不得从stage或旧source重建。coordinator只有在导入与原位置投影都成功后才持久settled，失败保留原capture以query协调。

生产runtime通过capture桥向Provider和Markdown来源coordinator提供register/query/commit/failed/stage接口，先持久原请求、等待当前完整历史账本确认，再发register；回执校验原出现、当前attempt及单调revision。重试沿原请求调用可信来源resolver，重核当前可写身份后才stage：local/external交给coordinator的`retry`，其他可信原生来源沿Provider的`retryImageCapture`。query观察到新service retry attempt只持久`awaitingRetry`并观察；原`retry_capture`控制才授权启动该attempt的writer。缺少对应resolver时明确component_unsupported，不自行读取locator或启动来源扫描。coordinator的原生读取证明、网络出口证明和平台opener限制由[来源设计](session-image-sources.md#当前实现与权限边界)拥有；resolver已接线不表示真实来源IO已获准。

`readCapture(input, acquirePolicy, deliver)` 对原capture/attempt的私有prepared文件逐块读取。local来源必须提供`CaptureReadPolicy`，其lease包含同步`verify/close`；异步验证不授予块交付权。读取前及交付前复核后，在同一lease内同步调用`deliver`，relay不得等Promise返回后才发送而留下撤销窗口。来源reader与relay非解码媒体块共享`tryAcquireMediaBlock`，整个Controller合计最多两个槽；source取消、stage退出和私有文件清理确认前不能提前返还相关预留。

Controller只读服务原件profile使用专用认证，不借浏览器token。每次GET原upload或image块须当前完整ControllerFence、generation/instance、有效parent凭据及删除屏障，且持久同代次 operation_authorized 的原actor/target/完整intent确实列出该upload/resource，发送pin仍有效。按持久关联授权，不增wire operationId、不信客户端actor；多个操作引用资源时至少一个全条件合格。不开放枚举、创建upload或任意历史。

旧generation授权不能修复新generation的native路径。已有稳定路径按精确native身份、停止证明和私有pin恢复；缺失时报告原生恢复文件不可用，服务历史仍可读。新的合法操作可用新上传和授权取回资源，不能借此重放旧输入。

服务complete后可发既有release结束本地preparation保活，不等于浏览器receipt.released，也不是服务complete通知。未知/离线保留原pin；上传对账由已认证服务按原upload驱动status/release，Controller不得冒用actor HTTP凭据。capture沿query协调。服务时钟拥有expiry，本地不独立推导到期。

native accepted/confirmed、turn结束或进程停止都不证明未来不再读文件；native/resume pin默认到原native Session明确删除，或Provider明确证明无延迟/恢复路径依赖。unknown无TTL。原生全组失败前撤未派发临时pin；原生已接受先建消息关系，迟到失败保原operation证据，不能伪未发送。

### Controller 准入与回收

每execution图片元数据最多10000 preparation attempts、1000 resource槽、100000 occurrences、200000 chunk边界、128MiB逻辑编码；另留8MiB只供已有结算/失败/GC。新增前预留整项最坏增量；碎块耗尽元数据明确拒绝，不能省略记录。终态且无重传资格的块历史可折叠tombstone，不能复用已终结身份。

物理硬上限每execution2306867200 bytes（2200MiB），包括staging/objects/native/decoder临时输出、残留、图片增量journal页/WAL及目录元数据；各子预算不能同时取满。卷空闲≥512MiB；同stateDirectory媒体总量≤8GiB，通过独立 `controller/media/budget.sqlite` 的短immediate事务共享预留，不存资源授权。先全局reservation，再本地记录，再分配；崩溃须证明原writer停止并按文件/journal对账，不按TTL返额。

每Controller最多2媒体块/1decoder，全局最多16媒体块/2decoder；decoder等待队列最多32项固定元数据，不排队保留块body。暂时容量拒绝保持原服务媒体请求pending，按同requestId及原bytes再次offer；不能永久缓存rate_limited而使原upload无法完成。来源retry的reserved状态和原retry_capture请求在同事务持久化。控制/原生回执优先，块间让出事件循环；断线撤销排队项，实际活跃工作退出后才返槽。ledger不可用则拒新媒体，已有安全结算与文字继续。长reader阻碍checkpoint时停止新媒体写入，留结算余量。

物理去重仅同origin/owner/Session、hash+length+MIME候选再核全bytes；不合并逻辑resource计费、imageId/uploadId/actor资格。带pin原件/native与未提交唯一来源不淘汰。服务已有原件且无pin的本地object可LRU，保服务descriptor与出现映射。

GC事务核全部pin并标deleting，阻止新acquire；事务外unlink、刷目录，再tombstone及返实际计费。unlink失败保持deleting/计费；孤儿必须owner有效、无活跃writer/prepare/pin及未决文件提交，不凭mtime删除。Session删除先封新lease，再cancel+join物理writer/reader/native，最后清扫和刷盘才能确认server_cleanup completed。撤权不等于owner删除，也不删其他记录有效引用。未知journal版本/身份或事务结构损坏沿既有fail-closed，不重建空journal冒充恢复。

## 发布、回滚与验证责任

先部署严格协议、schema3/旧表示读取和容量guard，再部署私有blob、Controller与Provider，最后完整Web接线。新图片写入和来源采集默认关闭；只有同一真实路径的上传、校验、原生能力、保存、读取、归档和权限全部满足，才可发布supported。既有原件读取不因新输入能力unknown而失效。

回滚关闭新写入，保留统一schema3/blob reader、旧数据边界、原upload/operation查询及unknown恢复直到保留期结束。只能使用理解新journal/schema的兼容程序，不能安装旧二进制后删存储重建。原生恢复路径可用与服务历史可读分别报告。

验证以[验收规格](../spec/session-image-acceptance.md)为准：严格TS/Go正反向量、双端字节/解码、各fsync/rename/SQL故障、同块重传、发送/DELETE/expiry竞争、跨epoch物理槽、全部身份矩阵、64MiB现行timeline与旧数据边界以及引用删除都须有可观察证据。原型、类型检查、受控Provider不能代替真实原生接受和离线原件链。决策及备选成本见[协议与存储决策](../../.agents/notes/implemented/architecture/2026-11-05-session-image-contracts.md)。
