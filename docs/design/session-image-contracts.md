# Session 图片协议与存储设计（待实现）

## 状态与责任

本文发布已确认的图片协议、服务原件、Controller 存储和解码器设计。新增类型、端点、目录、数据库结构及图片行为均待实现，文档发布不表示图片功能已可用。需求分别由[图片输入与草稿规格](../spec/session-image-input.md)、[显示与归档规格](../spec/session-image-history.md)及[验收与容量规格](../spec/session-image-acceptance.md)拥有。

本文是基础图片 DTO、身份、能力、上传、读取、来源登记、错误和跨层预算的唯一设计定义。[来源设计](session-image-sources.md)拥有 Markdown part/binding/retained 的完整结构和采集算法；[归档设计](session-image-archives.md)拥有 schema3、完整历史同步和封存文件 DTO；[Provider 设计](session-image-providers.md)拥有原生 payload、接受证据和历史映射；[浏览器设计](session-image-browser.md)拥有持久草稿和唯一预览接口。各消费者复用这些定义，不再建立同名竞争类型。

现有代码以 [固定协议](https://github.com/codetreker/daynight/blob/7fe4684b83d4d850f3b2dc6e7772392f75b175ef/packages/daynight/src/session/protocol.ts)及[原生入口](https://github.com/codetreker/daynight/blob/7fe4684b83d4d850f3b2dc6e7772392f75b175ef/packages/daynight/src/commands/controller/providers/types.ts)为兼容依据：严格 v1、text send、8 MiB legacy resource、64 MiB 原生归档和 Herdr v2 都保留。服务责任分别落在 `internal/core/session/` 执行、`internal/service/session/` 授权事务、`internal/core/store/` DAO、`internal/server/session/` HTTP、`internal/core/filestorage/` 文件抽象，不重建旧 `internal/sessionrelay/` 服务。

## 数据与控制流

浏览器先持久保存原始 Blob 和有序草稿，再按目标上传。服务预留逻辑及物理容量，将有界块暂存并转给 Controller；双方完整验证后，服务持久保存原件并确认 complete。发送另行冻结原操作，整组校验和 pin 后只调用一次原生入口。原生接受由精确证据结算；unknown 只查询。可信历史出现先登记位置，再采集；成功后读取原件，永不重取变化来源来替换原图。

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

新 native 图片表示使用 `protocol:"daynight.session.images.v1"`、`schemaVersion:1`、`projectionVersion:1`。这是独立协议标识，不改变既有 `daynight.session.v1` 或 `daynight.session.v2` 的含义。该模式的所有 native command、snapshot、event、Controller 帧和 timeline response 按下文替换规则生成独立严格类型，不能对旧对象直接塞字段。

基础字段和未涉及图片的 command/state/event 保留当前 v1 结构及语义；其 protocol 字段在图片模式中统一替换为新标识。以下替换递归适用于 snapshot、stream、history、source event 和 content response：

1. send_message payload 扩展为下文 `ImageSendPayload`；其他 command payload 不变。
2. capabilities 保留 send/steer/cancel/respond，增加必填 `images:ImageCapabilities`。
3. MessagePart 增加 `ImagePart`、`ImageUnavailablePart` 及[来源设计](session-image-sources.md)完整定义的 `MarkdownImagePart`；旧 TextPart/ResourcePart 保留。timeline 页在原 resources 数组之外增加必填 `images:ImageResource[]`；resource event 新增独立 `kind:"image_resource"`，payload 为 ImageResource。
4. Snapshot 增加必填 `imageBudget:ImageBudget`。ControllerState 的 capabilities 保留原四个布尔值，另加唯一的 `providerImages:ProviderImageCapabilities`，不在 ControllerState.capabilities 内重复添加 images。服务将原生报告与链路条件合成为 snapshot.capabilities.images，预算也由服务生产，不接受 Controller 自报有效能力或可用容量。
5. 图片模式 ImageTimelineEntry 在原 TimelineEntry 的 message content、显式 Markdown tool output 和 reasoning 位置使用上述新 union 与来源设计的 reasoning 绑定承载，user/assistant/tool/reasoning 四类图片 entry 还必须包含来源设计的 `imageProjectionError:ImageError|null`，以严格区分正常投影与解析失败分支。其他字段保持原语义；旧 v1/v2 不接收这些字段。

图片读取与上传使用下文专有控制消息，不借旧 resource 的 8 MiB 合同传输大图。旧 resource 消息保留原语义。

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

ProviderImageCapabilities.revision 是 Controller 持久单调正整数，绑定其原生模型、权限设置、身份与sendInput能力；服务不原样复用它作为有效revision。ImageCapabilities.revision 则是服务为该Session持久分配的单调revision，providerRevision记录参与合成的原生报告revision。服务根据原生报告、协议模式、上传/持久化/归档链路及策略计算最终能力；任一影响资格的输入变化都推进有效revision，同revision绝不对应不同能力。余额变化只更新imageBudget，实际不足在原子预留处拒绝，不制造模型能力变化。重复读取及无变化权限复核均不推进revision。恢复不得在旧revision下发布新值。

Controller接收图片operation_authorized时，新模式额外包含必填 `imageAuthorization:{capabilityRevision:Decimal,providerRevision:Decimal}|null`；含图操作必须非null，与command.expectedImageCapabilityRevision及本地当前Provider报告分别相等，非图片操作必须null。服务生成授权前重新校验自身最终能力；Controller紧接原生调用前校验自己的providerRevision。已经发出的授权如遇服务策略撤销，使用既有原子授权边界结算已授权操作，不能声称撤销可以取消已经原生派发的输入；尚未授权者必须拒绝。服务每次授权也复核真实访问权限，revision不是权限凭据。modelId=null 表示有效模型无法确定，send/steer 均不能 supported。原生 default 选择值与已经确认的 effective model 不同；只有实际有效模型及其 profile 已获证实时才能宣布支持。controlsRevision=null表示原生未提供，不跳过能力校验。

支持状态是**已验证的原生能力与所有中间层能力的交集**。send 和 steer 分开；文字 steer=true 不推出图片 steer=true。未知和不支持都禁止对应图片输入，reasonCode 必填；完全支持时可 null。reasonCode 取 `model_unsupported|capability_unknown|provider_unsupported|component_unsupported|policy_restricted`。inputMediaTypes 为去重数组且为输入白名单的子集。任一 supported 时数组非空、数值为正，maxImagesPerMessage 为 1..8；均不支持时数组可为空、上限全部为 `"0"`/0。上限不大于 10485760、20971520、8，已知 Provider 更小限制向下取交集，浏览器和 Controller 必须使用同一个最终值。解码器等尚不可用时不得先宣布支持。

发送仍要求原有 operations.canSend、当前 expectedTurnId、同步状态和生命周期允许。活动回合需要图片 steer=supported；不支持时保留草稿等待，不扩展队列、不取消回合。纯文字继续使用原文字能力，不受未知图片能力影响。

几何限制： ProviderImageCapabilities 与有效 ImageCapabilities 均包含必填 `geometry:{version:1,known:boolean,maxWidth:number,maxHeight:number,maxPixels:number,maxFrames:number}`。known=true时四项均为正安全整数，且不得高于通用解码上限；known=false时四项均为0且send/steer不能supported。宽高按原始存储画布（不交换EXIF方向），pixels为width×height，frames为完整解码的容器画布帧数、静态图为1。需要按显示方向判定的原生profile，由Provider先将两种方向归约成保证满足原生限制的保守存储画布上限，不让消费者自行猜方向。

Provider先把已证明的backend/model、原生累计历史/工具图片上下文及本条可能新增1..8图的条件限制归约为当前固定上限；不能把本条图数当累计上下文。上下文不可观测时，采用该backend/profile已证明覆盖所有可达上下文分支的最严格上限；没有可证明的包络才unknown。发送前若实际上下文/模型/权限改变，重新计算并推进revision，拒绝旧revision后保稿重核；不能偷偷继续用旧profile。服务取该上限与Controller 存储模块通用限制的交集，Web、上传complete及最终派发都消费相同有效值。显式更小限制对用户可见。

为使maxFrames可跨层核验，同时包含必填 `frameCount:number|null` 到 `ValidatedImage`/`ImageResource`及其所有包含对象；ValidatedImage和available必须为1..256安全整数，其他resource状态必须null。完整全帧 decoder产生此事实，Controller journal、服务资源对象、receipt、manifest原样持久和校验；frameCount与原bytes/hash绑定且available后不可变。legacy资源保持旧namespace不伪造帧数；浏览器本地尚未完整确认帧数时以上传complete的双端验证元数据作为发送资格依据，本地预览不是frameCount证明。输入/恢复/模型变化测试必须覆盖静态1帧、动画及更小maxFrames。Profile绑定真实native/SDK/backend/model证据，单次识图成功不构成发布profile的充分依据。

## 上传、回执与已保存资源

### 资源描述与显示出现

```ts
type ImageResource = {
  resourceId: UUID;
  revision: Decimal;
  status: "pending" | "available" | "failed" | "unavailable";
  name: string;
  mediaType: DisplayMime | null;
  byteLength: Decimal | null;
  sha256: SHA256 | null;
  width: number | null;
  height: number | null;
  frameCount: number | null;
  error: ImageError | null;
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

available 必须完整声明 MIME、正长度、摘要和尺寸，error=null；它意味着原字节已校验、可解码且已持久保存并关联其 owner。pending/failed/unavailable 的 MIME/长度/摘要/尺寸均 null，pending.error=null，其他两态 error 必填。失效原生历史、尚未获得资源槽或配额拒绝时使用ImageUnavailablePart，不分配resourceId。它保留同一imageId及消息位置；error.message是≤256 UTF-8 bytes的安全说明，错误码保留完整原因，不伪造尺寸或bytes。它不占二进制资源配额，数量受其所属timeline的既有entry/part/JSON上限约束。

resourceId 是 Session 范围内注册且全局唯一的随机 ID，不是文件路径、HTTP URL、blob key 或摘要。available 的原字节和元数据不可更改；后续暂时读取失败只出现在读取结果中，不降级或替换已保存描述符。已预留的未成功采集可保持同一resourceId重试并增加revision；释放预留后将对应出现投影为ImageUnavailablePart，再次准备分配新resourceId但保留imageId。成功后首次采集关闭。重新抓取源必须创建新 resourceId 和显式的新图片出现/记录关联，不能改写旧 ImagePart。

imageId 在消息整个寿命稳定。同一图片重复出现时每次出现有不同 imageId，可引用同一已授权 resourceId；数组顺序即显示顺序。imageId 全 Session 唯一，仅可在其原 entryId、用户/助手 content 或某 callId 的 output 内重复 upsert；不得迁移到其他消息。生产端保留原生 messageId/itemId/blockId 到 entryId/imageId 的持久映射，没有原生稳定 ID 时持久保存分配结果及原生源索引。流式文本变更、分页、重连、historyEpoch 改变不能重新随机分配。无法匹配时明确显示缺失，不凭相似文字或同 URL 合并。

### 上传交换

下述是 固定业务操作 DTO，不预定磁盘算法。HTTP 新路由位于现有已授权的 Session base 下：Task 为 `/api/v1/projects/{projectId}/tasks/{taskId}/sessions/{sessionId}`；Test/Bot 使用其现有独立 Session resolver 得到的 base。不得把 body 中的 actor 或 owner 当路由授权。所有图片路由要求图片协议选择且禁用共享缓存。

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
  resource: ImageResource | null;
  expiresAt: Timestamp;
  error: ImageError | null;
};
```

| 交换 | 请求 | 成功结果与约束 |
| --- | --- | --- |
| 创建准备 | `PUT {base}/image-uploads/{uploadId}`，body ImageUploadSpec，path/body ID 必须一致 | 201 新建或 200 同 identity/spec 已存在，返回完整 receipt。不同内容复用 ID 为 409 upload_conflict，不追加 bytes。预留容量在返回 receiving 前完成。 |
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
| `status` / `release` | `{uploadId}` | LocalImagePreparation |
| `read_prepared` | `{preparationId:uploadId,offset,limit}` | PreparedImageChunk，仅validated允许 |
| `read` | ImageReadRequest | ImageReadChunk，仅公开available允许 |

服务取得validated后读取并持久化各块、流式核验完整长度/摘要，原子发布ImageResource.available和浏览器ImageUploadReceipt.complete。服务可以使用接收上传时自己的暂存bytes，但仍须匹配Controller的validated结果；不得透传本地状态充当服务持久化。持久化失败保持verifying或明确failed，响应丢失查询原uploadId，已提交complete只能读回，不再次注册资源。

同一 uploadId 与 spec 的准备/块重复可以安全返回现存状态；网络未知时客户端先查询，禁止盲目新建或重传整个图。这里的可协调准备不授予 SessionCommand 自动重放权限。

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
type ImageSendPayload = {
  content: (TextPart | ImageInputPart)[];
  expectedTurnId: string | null;
  target: ImageTarget;
  expectedImageCapabilityRevision: Decimal;
  draftId: UUID;
  draftRevision: Decimal;
};
```

本版输入组织固定为可选一个非空白 TextPart，后接1..8个有序 ImageInputPart；纯图片不生成空 TextPart。本文新增 payload 专用于含图片 send_message；图片模式的纯文本 send_message 使用严格的旧 `{content:TextPart[],expectedTurnId}` 分支，不带图片专用字段，以保持现有文字分片语义。两个分支依 content 中是否有 image 精确区分，不能解析失败后删除图片重试文字分支。输出内容可以交错文本和图片，工具输出仍属原 callId。

所有 imageId/uploadId 在一个输入内唯一；同样 bytes 的两次有意附件有两个 imageId/uploadId。resourceId、摘要和长度必须与当前 actor/target 的 complete receipt 查回结果相等。完成上传不代表 native 已可读：发送前 Controller 必须取得并验证本地 bytes，服务须保留全部图片发送引用。只有所有图片均可用且配额、目标和能力满足，才原子接受整条图片发送；缺任一张即整条拒绝，不能降为部分图片或仅文字。

operation intent hash 覆盖原 envelope（不含可变传输 requestId）、target、draftId/revision、能力 revision、expectedTurnId 和完整有序 content；新图片intent的规范JSON递归按字段名ASCII升序排序，数组不排序；不含空白，字符串保持UTF-8原字符（只转义双引号、反斜线及控制字符，控制字符统一小写\u00xx），整数用十进制、不含浮点数，null显式保留。摘要含protocol及原envelope除requestId外全部字段，不能沿用只包含旧字段的hash投影。服务与Controller使用同一序列化向量；旧v1 hash保持原算法。纯文本及其他非图片命令即使经images表示传输，也先归一为原v1语义对象并使用旧hash算法（不把表示protocol纳入）；同一operation跨表示查询/协调不能因wire版本不同产生operation_conflict。只有含图片的intent使用上述新算法。相同 operationId 不同 intent 是 operation_conflict；不能因重连重新编号或改变引用后继续同一 operation。服务 accepted/offered 仅为命令接纳，provider_accepted/confirmed 才可清理对应原草稿版本。新草稿 revision 即使同 draftId 也不被旧回执清除。

送入原生之前依次满足：当前权限与 fence → 目标与能力 revision → 全部资源可用 → 持久化 intent 和图片引用 → 持久化 dispatching → 原生调用。模型设置变更与发送授权按现有控制序列串行；授权后、原生调用前重新检查变化。不得检查后允许并行设置改变把图片送给不支持模型。

NativeProvider 公共入口新增 `sendInput(input, operationId, expectedTurnId)`，原 text send 在过渡期保留，含图绝不调用 text send。input 是有序 TextPart 与 `{type:"image",imageId,resourceId,mediaType,byteLength,sha256,localPath}` 数组；localPath 是 Controller 生成的只读本地资源句柄路径，绝不接受浏览器/Markdown 原始路径。其 bytes 已验证且 operation 引用在原生读取期间保持存活。下文存储机制拥有资源解析和句柄生命周期；[Provider 设计](session-image-providers.md) 按原生协议将其转换为原生图片输入。该内部接口不序列化到浏览器，不把本地绝对路径写入公有回执。

Codex、Claude、Copilot 各自证明纯图片、图文与顺序、接受回执及历史映射；不由共享接口猜测 Provider 的图片 steer、默认模型 vision、queued 语义。缺少 sendInput 的旧适配器声明 unsupported。NativeProvider 返回沿用 ProviderReceipt，图片回显或本地 timeline 生成不是原生接受证据。

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

受信 pre-admission 分类不需要新增`dispatchEvidence` wire字段。服务在解析/认证后，先按原actor/Session/operationId查已有操作，再检查可变化的目标、模型和预算；已有操作只返回原事实或operation_conflict，不能用新的capability_changed伪装原操作从未派发。仅首次合法请求、该ID从未登记/授权/派发，服务确定的接纳前 `capability_changed|target_changed|message_image_limit|image_budget_exceeded` 分支可以没有operation行；该路由保证这些严格图片错误分支只在上述条件返回。浏览器须验证认证主体、请求对应、图片协议与严格body后，持久保存该可信拒绝为内部definitive_not_dispatched，再允许修复后的显式新operation。代理同名code、通用401/403/404、5xx、解析失败、operation_conflict、超时/丢回应和GET404均不提供此证明；已进入派发的后续错误走operation结果，不能返回这些接纳前分支。

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
  captureId: UUID; occurrence: ImageOccurrence;
  state: "reserved" | "copying" | "committed" | "failed";
  resourceId: UUID | null;
  resource: ImageResource | null;
  error: ImageError | null;
};
```

| action | 请求body | 成功result |
| --- | --- | --- |
| `register` | ImageCaptureRequest | ImageCaptureReceipt；先核验消息关联/locator来源并预留容量。无法预留返回failed、resourceId=null，生成ImageUnavailablePart |
| `validated` | `{captureId,validated:ValidatedImage}` | receipt进入copying。服务对MIME/尺寸/限额再次校验，Controller须保留本地准备直到提交或释放 |
| `query` | `{captureId}` | 原receipt；404不证明先前register未发生，原身份先观察再决策 |
| `failed` | `{captureId,error:ImageError}` | 尚未committed者进入failed并释放预留，保留ImageUnavailablePart；committed者拒绝回退 |

reserved/copying时resourceId非null、resource=null、error=null；committed时resource非null且available、ID相同、error=null；failed时resource=null、error非null，已分配的resourceId可以保留作诊断但不归档为资源。服务复制时通过image_request的 `read_capture` action发 `{preparationId:captureId,offset,limit}`，Controller回PreparedImageChunk，规则与read_prepared相同，支持DisplayMime五种格式。每个准备对象严格区分upload/capture命名空间。

服务取得字节后核验摘要/长度并原子提交blob、资源预算、occurrence快照关联，receipt变committed，公开available；未成功的状态只产生pending或ImageUnavailablePart。首次成功后captureId查询始终对应同bytes；同captureId的occurrence/locator不可改变。copying/committed及同一次准备中已确认的validated摘要不可替换，变化返回capture_conflict；只有从未committed、已进入failed且旧预留已释放后，才允许沿原captureId/locator/occurrence再次register，取得新reserved准备并接受改变后的源摘要。服务提交回执丢失时Controller只query，不能另分配resource或更换已采集字节。提交后重新获取必须新captureId/resourceId/imageId及显式的新记录关联。

### 出现登记顺序与原生来源键

采用两阶段既有通道，不新增另一套source事件。第一阶段Controller持久entry/出现位置并经原sourceSeq/outbox发送timeline upsert（或完整历史账本同步），取得覆盖该位置的service ACK；没有资源槽时该位置用ImageUnavailablePart或待采集表示。第二阶段`image_capture action=register` 的 ImageCaptureRequest 包含必填 `nativeSource:NativeImageSource|null`，ImageOccurrence 包含 `container:"reasoning"`及必填 `partId:UUID|null`、`sourceRevision:Decimal|null`、`sourceTextSha256:SHA256|null`；后三者对于Markdown/reasoning绑定必须完整非null，独立原生image part均null；tool_output必须callId，其他container的callId=null。sourceKey沿原规则绑定一次出现。NativeImageSource为 `{provider,nativeSessionId,nativeMessageId,nativePartId}`，值沿本设计 native locator限制，由受信Provider持久映射产生，不携URL/本地path；可信键不存在为null，不按相似文字/摘要臆造。它与locator分别表达“所属原生位置”和“取bytes的方法”，Markdown源也可带nativeSource。

register在短事务内验证第一阶段已确认位置/revision/hash，持久sourceKey/nativeSource/原出现映射和容量预留（失败也持久相应出现失败身份），然后返回ImageCaptureReceipt；收到reserved才允许source IO。receipt沿同一扩展ImageOccurrence返回，nativeSource不向Web公开。重放同capture/出现必须精确匹配；sourceKey与已有nativeSource不能改绑，Controller可信alias只在同canonical出现的专用内部映射事务追加。第一阶段无法送达时outbox保留且不读源；register未知只query原ID。服务归档冻结同一记录来源索引并核对每项原出现/资源hash与timeline，manifest不包含私有locator。停止后的最终同步先确认原位置，再以原stopped权限登记已发生的本地来源与已有validated结果；不得启动新的来源IO。自有上传图的原生回显也在位置ACK后以locator={kind:"resource",resourceId:原上传资源}执行同一register，提交原imageId与可信nativeSource；已available同Session资源直接返回committed，仅原子增加出现引用和来源映射，不重新读源、不分配blob、不重复计资源槽。captureId仅标识这次关联事务而非第二次输入；它既不确认原生接受也不解除unknown。服务离线resume读取该冻结索引；nativeSource=null只影响无法证明的新Session导入，原记录图片仍可读。仅有未上报的本地映射且Controller已丢失时明确context_unavailable，不伪造恢复。

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

在线/归档图片均按已授权 owner+resourceId 读取；不接受客户端选择本地路径或对象存储 key。HTTP 为 `GET {base}/images/{resourceId}/content?offset=<Decimal>&limit=<integer>`，图片协议选定后返回200 ImageReadChunk；limit 为1..524288，offset≤byteLength。data 使用标准、规范填充的 Base64（重新编码应完全相等），最多699052字符；offset=length 仅返回空 data、eof=true。其他块非空、decode长度≤limit，eof 当且仅当 offset+decode长度=byteLength。每块摘要与长度是完整文件的期望身份，不是块摘要。读取端验证连续偏移、相同 resourceId/hash/length，最终流式 SHA 匹配后才显示/下载。HTTP 失败用 ImageError envelope，不在 data 内夹带错误文字。

archive reader 以 recordId 所属授权解析 resourceId；在线 Session 的新 generation 不修改旧记录的图片归属。服务可直接从已保存 blob 读取，不依赖 Controller；仅尚在采集的资源由 Controller 通道读取。跨连接 chunk 要验证同一不可变身份，旧请求响应不得混入新请求。浏览器按 origin/account/owner/resourceId/hash 缓存，先验证当前授权再用缓存；图片 URL 不是 bearer 公开地址，响应 `Cache-Control: private, no-store`。访问撤销/账户切换/记录删除后立即撤销当前 Blob URL、敏感预览和下载资格，保留阅读位置的普通权限复核不能重挂图片。

### 来源资格与唯一重试

唯一来源重试端点为 `POST {base}/image-occurrences/{imageId}/retry`，严格body `{}`，返回 `{capture:ImageCaptureReceipt}`；Controller使用 `retry_capture {captureId}`。POST只接受已登记原出现、可信local/external来源及当前操作权限，不接受新locator、headers或actor。

出现状态端点为 `GET {base}/image-occurrences/{imageId}`，严格返回 `{imageId,revision,state,resourceId,action,error}`，全部字段必填；revision为服务单调Decimal，resourceId/error可null。state为unregistered/pending/unknown/failed/committed/unavailable；action为none/observe/retry_source/read_saved。unregistered/unavailable仅none；pending/unknown仅observe；committed仅read_saved且resourceId非null；failed只有从未committed、旧预留已释放、来源可信且当前可操作才retry_source，否则none。pending/committed/unregistered的error=null；failed/unavailable必须有安全ImageError；unknown可有协调错误。pending已预留可有resourceId，其余未提交终态为null。未授权按原隐藏存在性错误拒绝，不返回unregistered泄漏信息。GET不创建出现、不采集，unknown只协调原ID。

错误profile显式区分input、saved、uncommitted local/external。可信来源已确认failed且释放旧预留后，invalid_image/unsupported_media_type/decode_failed允许用户请求重新准备并完整重验原locator；input及saved不因此改变never规则；forbidden/permission_denied不能靠retry绕过。已committed只重读同原件，不能“重试”换源字节；重新取源需新明确出现/记录。只读归档永远无retry_source。资格由服务action决定，UI不得按错误文案猜测。

## 错误与失败分层

```ts
type ImageError = {
  code: ImageErrorCode;
  message: string;
  retry: "never" | "query" | "prepare" | "read";
  imageId: UUID | null;
};
```

message 是 ≤4096 UTF-8 bytes 的非空安全说明，不含 token、凭据 URL、主机敏感路径或内部堆栈。imageId 仅在可定位具体图片时设置，整条消息/鉴权失败为null。客户端根据 code 展示本地化提示，不能按 message 推断状态。未知 code 不自动重试，显示一般错误并保留草稿。

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

网络错误不是一个服务端已提交失败回执；HTTP 202 是进展状态，不是 error。原有 operation.error 保留 `{code,message}` 严格形状，使用上表 code 而不插入 ImageError 的新字段；图片专用请求错误响应为 `{error:ImageError}`。unknown upload/send 不需要服务知道浏览器断线，客户端可本地表示未知但不能覆盖服务已知的成功。

## 容量、存储保证与归档交换

固定二进制单位：单图 `10485760` bytes，单消息图片合计 `20971520` bytes，最多8张。总量按每个附件实际长度求和，即使摘要相同也逐项计数。图片展示采集同样使用10 MiB文件上限，至少保留PNG/JPEG/GIF/WebP/AVIF；更大来源明确 image_too_large，不改变输入白名单。

一个 Session 的图片预算为 `1073741824` bytes（1 GiB）与1000个占用二进制槽的图片资源；按 resourceId 的逻辑完整长度计费，不因隐藏的跨账户去重减费。同 resourceId 被多个消息/归档引用只计一次；不同 resourceId 即使SHA相同分别计。failed/unavailable出现以ImageUnavailablePart内联在timeline，不占二进制槽；正在预留与已保存的资源占槽。第1001个来源即使无法采集，也能记录明确失败，不要求第1001个blob descriptor。Controller 存储模块/[归档设计](session-image-archives.md) 不得分别计算不同预算。服务在上传创建时预留声明长度/资源槽；无法预知长度的来源按10 MiB预留，采集完成后释放差额。committed+reserved 均不得越界，并发通过服务原子保留协调。已发送、未知发送、历史图片不可为了释放空间而被淘汰。容量不足拒绝新采集并显示原因；纯文字和已保存图片继续可用。ImageBudget 为观察信息，检查通过不替代服务实际预留。

图片内容走独立有界通道：512 KiB 原字节块，2 MiB 控制帧上限保持。每个 Session 至多两个媒体块同时在途，控制/receipt/历史请求优先；不能一次将整张图/Base64写入 command、事件批次或归档 JSON。服务/Controller按块持久化和摘要，不能每读一块全量解码图；浏览器允许为预览持有本次完整10 MiB Blob，但不得把全历史图片预加载到内存。全服务并发/背压/磁盘水位算法由 服务上传与鉴权模块/Controller 存储模块 设计，不能破坏这些单通道边界。

已保存图片先存在服务的 Session 私有 blob 存储，输入成功与采集 available 均在服务保存完成后成立；Controller 本地文件作为原生消费缓存，不是唯一历史副本。关联消息前是上传引用，关联后是消息引用，归档可添加记录引用。清理最后一个有效引用才能物理删除，unknown operation 是有效引用。草稿删除只释放草稿准备；Session或记录删除走其原有权限和删除屏障，并同步失效对应客户端缓存。

## 协商与旧表示

新客户端以 `Daynight-Session-Protocol: daynight.session.images.v1` 查询 `/api/v1/session-capabilities`。严格响应为 `{protocol:"daynight.session.images.v1",schemaVersion:1,projectionVersion:1,providers:["codex","claude","copilot"],backends:["web"],imageContractVersion:1,archiveSchemaVersions:[1,3]}`；providers 列表不证明某模型支持图片。旧服务拒绝该表示或返回旧 protocol 时，重新执行精确旧查询并使用文字模式；网络失败或 403 不能当作支持，认证失败沿既有流程。

服务确认后 Controller 才选择图片 hello/welcome。新 welcome 保留旧 limits，另加必填 `imageLimits:{maxImageBytes:10485760,maxChunkBytes:524288,maxInFlightChunks:2}`。旧 Controller 仍收原常量/字段，不接 image_request；服务记录每条连接实际模式。改变表示无需重启 native，也不得重放 source events 或 operations。

HTTP、stream、历史及归档读取每次显式选择表示；cursor 同时绑定表示和 historyEpoch，切换后重取。WebSocket 使用同名 subprotocol；HTTP header 与 subprotocol 不一致则拒绝，首 snapshot 必须匹配。一个读者切换不改变同 Session 其他读者。

| 组合 | 结果 |
| --- | --- |
| 新浏览器、旧服务 | 原文字流程，禁图片操作并保留草稿；旧记录可读 |
| 新服务、旧 Controller | 原 welcome/payload/send，图片 component_unsupported，不下发图片帧 |
| 新服务和 Controller、旧浏览器 | 严格 v1 snapshot/event，无新字段；图片在原位置映射文本 `[图片]`，文本仍可发送 |
| 新组件、原生能力 unknown | 禁相应图片输入，读取已存图片仍按独立权限；文字能力独立 |
| schema1 旧归档 | 原 decoder/实际资源，无 bytes 不伪造已保存图 |
| schema3、旧读者 | 提供确定 schema1 兼容全文，主归档保留图片原件；兼容表示不构成完整图片交付 |
| Herdr/v2/schema2 | 原 terminal_recording/native_snapshot 包装、paste/keys 和归档语义不变 |

旧投影保持 eventSeq/historyEpoch/entryId/entrySeq。每个 image_resource 事件一对一转为该序号处完整严格 v1 snapshot：lastEventSeq 为原序号，保留有效 sessionRevision；即使旧 reducer 忽略同 revision 的内容，也推进 lastEventSeq。不能删事件留缺口或发送未知 kind。媒体块不分配时间线序号。Markdown part 转原完整 TextPart，不另附当前图片；retained 旧图片保留有界说明。

归档接纳同时计算新 timeline 与完整 schema1 envelope 的精确 UTF-8 编码，各不超过 67108864 bytes、100000 entries。旧兼容投影保留全部文字、工具位置/状态和 legacy resources；不能只计 entries，也不能假设旧客户端有分页 fallback。状态摘要始终对应所选表示的实际原 bytes。schema3 manifest、timeline、旧表示原文件与状态/读取接口统一见[归档设计](session-image-archives.md)。

## 服务上传、权限与持久提交

### 鉴权与锁顺序

Task base 为 `/api/v1/projects/{projectId}/tasks/{taskId}/sessions/{sessionId}`；Test/Bot 为当前 resolver 的 `/api/v1/test-sessions/{sessionId}`，Bot 还须关联检查和删除屏障。历史记录只提供读取。serverOrigin 来自受信配置，不信 body/Host；actor 来自当前认证。Task 操作沿 owner/admin 与 `ReadProjectAccess`（含 Team 继承），Test/Bot 沿 owner/parent PAT。

创建、写块、继续验证要求原 actor、当前准确 target、活动生命周期、操作权和图片输入资格；准备不要求此刻可 steer。GET 原上传仅要求原 actor 和原 Session/历史访问权，不要求 Controller 在线或 current claim 仍相同；它不重新授权新目标。DELETE 要求原目标当前操作权，并与发送引用竞争。已发送图片由合法读者读取，不要求读者等于上传者；未发送资源仅在原 actor receipt/私有授权中可见，不广播。

Cookie 写必须精确 Origin；PAT 沿既有认证，不增加 CORS/query token。Web 保留 `credentials:"same-origin"`、`redirect:"error"`、`assertResponsePrincipal` 和 `Daynight-User-ID` 核验；身份等待结束、真正 dispatch 后才计网络等待。`IndependentSessionReadDenied` 的已认证 409 resource_conflict 仍是删除/归属屏障。所有响应及错误为 private,no-store。

Task → 访问/Session、Bot → Session 为父锁顺序，随后预算、upload、resource/引用；多资源按 UUID 排序。网络、文件、解码不持数据库锁。块 ACK、available 发布、异步恢复和 operation 授权提交前，短事务再次核对凭据、权限、target、删除屏障、原 revision/intent/fence。撤权先提交则停止推进；上传先提交的 bytes 仍可能存在，但后续读取受新权限约束。取消请求不能收回已经取得的 bytes 或证明回滚。

### 两端块确认与提交恢复

正常路径服务持久暂存块并转发 Controller。服务 receipt 直接返回，不包 `{upload:...}`；JSON 请求上限 16384 bytes。块 body 1..524288 bytes，单值摘要 header、规范 offset，无未知/重复 query、不允许压缩/multipart/Range；Content-Length 不符、非 identity Content-Encoding、重复摘要或超长实际流均拒绝，确认前缀不变。无 Content-Length 的正常有界流允许。框架 401/405、协议错误和非业务 envelope 保留 HTTP 语义。

每 upload 同时仅一项变更 intent，固定 offset/length/digest。顺序为：持久 spec/24h 到期/预算与准备工作 → Controller prepare；块校验 → 服务暂存和块 intent → Controller 落盘 ACK → 服务复核并提交 acceptedOffset → HTTP receipt。receiving 不证明 Controller 已准备好，首块前必须协调成功。重复块要求原边界、长度、digest 和实际 bytes 完全相同，不接受部分重叠或另一切块方案。

| 断点 | 原身份恢复 |
| --- | --- |
| 服务块存在、Controller write 未知 | status 原 upload；只发已登记同一块，或核对本地偏移与同 spec/intent 后确认；不得超过服务已登记连续前缀 |
| Controller 准备丢失、服务确认块存在 | 同 target 重新 prepare，按已确认块重建；public offset 不倒退，本地追平前不接新块 |
| 浏览器块响应丢失 | GET 原 upload；确认没前进后沿原完整块重传，已前进则从新偏移继续；查询失败保 unknown |
| complete 响应丢失 | GET 原 complete/resource/hash；不能注册第二资源或重新扣费 |
| blob 已落盘、SQL 未提交 | 可恢复孤儿清理；没有 complete，不从孤儿文件自动发布 |
| SQL 已提交、响应丢失 | 原持久 complete 是事实；重启不回退 offset 或终态 |

完整长度后持久 verifying（202，已完成可200）。Controller 和服务分别完整校验原 bytes、MIME、hash、长度、画布及 frameCount；双方一致后 blob 先耐久，再在 SQL 事务发布 available、转换预算、建立上传引用和 complete。文件与 SQL 不是一个事务。`read_prepared` 仅作同身份缺块协调，不要求正常路径再传一遍全图。图片局部故障不关闭健康文本 Session。

验证由持久工作驱动，HTTP 断开不删除工作。每次恢复核对原 actor 凭据及目标；同账户新的有效变更请求可在复核后接管未完成准备授权，GET 不能刷新授权、expiry 或 owner。一次 attempt 最多60秒，暂时 IO/离线保持 verifying，1/2/4/8/15秒抖动退避；确定解码失败为 failed，到期 expired。超时 cancel+join 执行单元及释放 IO 后才返额度，不能用超时推断写失败。

### 发送、释放与到期

发送授权在一个事务校验完整有序输入、全部 complete/upload 身份、目标、能力、20MiB/8张、精确双历史预算，持久 intent 并取得全部 pin。任何一图失败整条拒绝。DELETE 先提交使 released，迟到验证不能复活；complete 先提交而无 operation pin 仍可释放；发送先取得 pin 则 upload_in_use。仅取消浏览器等待不是 DELETE。

24h 从首次创建固定，精确重传、读取、重连不续期，每次事务和有界清理扫描均检查。未占用 receiving/verifying/complete 可到期；sending/unknown/消息/记录引用不随 TTL 释放。failed/expired/released 保存最小 tombstone 到所属保留期结束，相同 uploadId 不复活；Session 最多10000上传身份，超限 policy_restricted，不能删 tombstone 腾身份。

明确未派发或可信未接受结论解除 operation 占用，尚未过期上传可保留；原生接受后先建消息引用再解除冗余上传引用。unknown 保留。归档先建立记录引用再允许 Session 清理。浏览器移除只释放其草稿，权限撤销只取消该 actor 访问，均不能删除其他合法引用。

### 共享物理空间与调度

多实例使用共同可读、具耐久语义的暂存/blob 后端和共享账本；无共享后端不得开启多实例图片写入。只有数据库当前拥有 Controller 连接的 relay instance 派发；其他实例登记有界工作，不夺 epoch。通知仅唤醒，无通知最多250ms查询一次，HTTP 等结果最多15秒。连接重建协调原 upload；进程内 pending map 不是持久队列。

| 维度 | 上限与行为 |
| --- | --- |
| 媒体块 | 每 Session 全方向、跨 epoch 合计2；每账户8、部署64；每 upload 一项变更。归档文件≤1MiB、每Session一块，也占公共媒体槽 |
| 控制速率 | 每账户20次/秒、突发40；新准备2次/秒、突发8；GET/DELETE有独立小配额 |
| 调度 | Session公平轮转；控制/回执/心跳/历史元数据在块边界优先，已开始WS帧不抢占；写超时5秒、块/状态等待15秒 |
| 解码 | 服务最多2个可终止执行单元，单图15秒、外层attempt60秒；不占WS发送锁 |
| 物理准入 | 暂存+blob最坏2倍原长度，预留后空闲仍高于 max(1GiB,卷容量5%)；每图片Session另留132MiB归档元数据和最坏临时增量 |
| 临时拒绝 | 并发、速率或物理水位不足503 storage_unavailable，可 Retry-After 1..30秒；未知写仍 query；逻辑预算超限413 image_budget_exceeded |

共享持久 admission 原子协调，进程内 semaphore 只是优化。租约到期只撤提交资格，不返物理槽；失联、心跳丢失、DB lease 到期、WS 重连均非执行单元停止证明。只有 cancel+join 或监督器确认原进程终止后回收。新实例先协调旧占用，再另取空闲槽，不能把计数清零或继承未释放槽；无可靠终止证明则保守拒绝超额。解码/缓冲/队列实测包含语言运行时副本，512KiB块不等于RSS上限。

统一 codec/metadata guard 是新 timeline 和完整旧 envelope 的唯一计量器。创建准备先检查最小关联空间，发送时按完整文字/有序图片精确原子预留；并发纯文字也走同序列，不能消耗已预留空间。unknown 留预留，消息投影按原 operation/imageId 结算一次，确定拒绝才释放。归档最终再核对，不把未来可预见的容量失败拖到原生接受后。ENOSPC、临时残留和跨卷峰值实际计费，不删旧图腾空间。

## Controller 文件、解码与生命周期

### 私有文件与 journal

沿 controllerExecutionDirectory，在 journal.sqlite 旁设独立 image-content-v1/；旧 journal.sqlite.pending-content/ 与 legacy Base64 通道不变。

```text
image-content-v1/
  owner.json
  staging/<upload-or-capture>/<preparationId>/<attemptId>.part
  objects/<localObjectId>.bin
  native/<nativeBindingId>/<resourceId>.<verified-extension>
```

owner.json 本地 schemaVersion=1 绑定规范 origin、Session owner scope、executionId、原 claimId/testExecutionId；generation 不是目录归属，但每次写核验当前 ControllerFence、writer 和 ImageTarget。原 actor 不必等于 Controller/ticket owner。路径组件只用校验 UUID 或私有随机ID，不拼接用户 name/URL/native ID。目录0700、原件/暂存0600、native文件0400，Windows等价私有ACL；这些不防同OS用户恶意进程。

根及已有父组件须可信、拒symlink/reparse；exclusive create、禁跟随打开、fstat核验regular file与登记身份。来源模块交付已授权打开的stream，存储模块不能重新按不可信path打开。native使用私有不可变副本，不能硬链接或直接读取会变化的用户文件。

图片表必须进入既有 journal-format 版本迁移及精确schema检查，与 operation/pin 共用一个 journal：

| 表 | 必需持久事实 |
| --- | --- |
| image_preparations | namespace/id/attempt唯一、完整spec或locator/occurrence的intent hash、target/fence、状态/offset/validated/错误/服务观察；同准备仅一活跃attempt |
| image_chunks | offset/length/hash的已刷盘连续前缀，无Base64 |
| image_objects | 私有object身份、长度/hash/MIME/画布/frameCount、policy/build及物理状态 |
| image_resources | scope/resourceId的服务不可变descriptor及local object关联 |
| image_occurrences | scope/imageId的原entry/part/call/sourceRevision/hash、sourceKey/nativeSource/capture/resource或失败；禁止迁移出现 |
| image_pins | preparation/operation/native/read/archive的真实关联、fence、证据和释放状态；不只存漂移refcount |
| image_failures / image_gc | subject安全错误与未知事实；deleting/tombstoned及实际清理结果 |

Decimal 用规范文本/bigint比较，仅在限额内转换文件API安全整数；分页读取元数据，不启动全历史Map或图片预载。prepare先持久空文件和新增目录再提交零偏移。块顺序为 write → fsync → immediate transaction提交块及offset → 回执。恢复截断并刷盘未提交尾部；文件短于确认offset或已提交块hash损坏为明确失败，不倒退偏移冒充成功。rename持久源/目标目录，Windows实际flush/rename持久性须独立验证。

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

`stageCapture` 只接受 register reserved 后的可信stream；`readPrepared` 按 upload/capture命名空间与lease读；`ensureLocalResource` 校验服务原bytes后重建本地verified；`acquireInput` 整组验证并原子保存原intent/pin，返回有序只读native路径，不调用Provider。稳定native文件写随机临时副本、核hash、fsync、设只读、rename并持久目录后才准许pin/dispatching；既有有pin路径不得覆盖。

Controller只读服务原件profile使用专用认证，不借浏览器token。每次GET原upload或image块须当前完整ControllerFence、generation/instance、有效parent凭据及删除屏障，且持久同代次 operation_authorized 的原actor/target/完整intent确实列出该upload/resource，发送pin仍有效。按持久关联授权，不增wire operationId、不信客户端actor；多个操作引用资源时至少一个全条件合格。不开放枚举、创建upload或任意历史。

旧generation授权不能修复新generation的native路径。已有稳定路径按精确native身份、停止证明和私有pin恢复；缺失时报告原生恢复文件不可用，服务历史仍可读。新的合法操作可用新上传和授权取回资源，不能借此重放旧输入。

服务complete后可发既有release结束本地preparation保活，不等于浏览器receipt.released，也不是服务complete通知。未知/离线保留原pin；上传对账由已认证服务按原upload驱动status/release，Controller不得冒用actor HTTP凭据。capture沿query协调。服务时钟拥有expiry，本地不独立推导到期。

native accepted/confirmed、turn结束或进程停止都不证明未来不再读文件；native/resume pin默认到原native Session明确删除，或Provider明确证明无延迟/恢复路径依赖。unknown无TTL。原生全组失败前撤未派发临时pin；原生已接受先建消息关系，迟到失败保原operation证据，不能伪未发送。

### Controller 准入与回收

每execution图片元数据最多10000 preparation attempts、1000 resource槽、100000 occurrences、200000 chunk边界、128MiB逻辑编码；另留8MiB只供已有结算/失败/GC。新增前预留整项最坏增量；碎块耗尽元数据明确拒绝，不能省略记录。终态且无重传资格的块历史可折叠tombstone，不能复用已终结身份。

物理硬上限每execution2306867200 bytes（2200MiB），包括staging/objects/native/decoder临时输出、残留、图片增量journal页/WAL及目录元数据；各子预算不能同时取满。卷空闲≥512MiB；同stateDirectory媒体总量≤8GiB，通过独立版本化 controller/image-admission.sqlite 短immediate事务共享预留，不存资源授权。先全局reservation，再本地记录，再分配；崩溃须证明原writer停止并按文件/journal对账，不按TTL返额。

每Controller最多2媒体块/1decoder，全局最多16媒体块/2decoder；等待队列最多32项固定元数据。控制/原生回执优先，块间让出事件循环。ledger不可用则拒新媒体，已有安全结算与文字继续。长reader阻碍checkpoint时停止新媒体写入，留结算余量。

物理去重仅同origin/owner/Session、hash+length+MIME候选再核全bytes；不合并逻辑resource计费、imageId/uploadId/actor资格。带pin原件/native与未提交唯一来源不淘汰。服务已有原件且无pin的本地object可LRU，保服务descriptor与出现映射。

GC事务核全部pin并标deleting，阻止新acquire；事务外unlink、刷目录，再tombstone及返实际计费。unlink失败保持deleting/计费；孤儿必须owner有效、无活跃writer/prepare/pin及未决文件提交，不凭mtime删除。Session删除先封新lease，再cancel+join物理writer/reader/native，最后清扫和刷盘才能确认server_cleanup completed。撤权不等于owner删除，也不删其他记录有效引用。未知journal版本/身份或事务结构损坏沿既有fail-closed，不重建空journal冒充恢复。

## 发布、回滚与验证责任

先部署严格协议、schema3/旧表示读取和容量guard，再部署私有blob、Controller与Provider，最后完整Web接线。新图片写入和来源采集默认关闭；只有同一真实路径的上传、校验、原生能力、保存、读取、归档和权限全部满足，才可发布supported。既有原件读取不因新输入能力unknown而失效。

回滚关闭新写入，保留schema3/blob、旧表示、原upload/operation查询及unknown恢复直到保留期结束。只能使用理解新journal/schema的兼容程序，不能安装旧二进制后删存储重建。原生恢复路径可用与服务历史可读分别报告。

验证以[验收规格](../spec/session-image-acceptance.md)为准：严格TS/Go正反向量、双端字节/解码、各fsync/rename/SQL故障、同块重传、发送/DELETE/expiry竞争、跨epoch物理槽、全部身份矩阵、两个64MiB完整表示以及引用删除都须有可观察证据。原型、类型检查、受控Provider不能代替真实原生接受和离线原件链。决策及备选成本见[协议与存储决策](../../.agents/notes/implemented/architecture/2026-11-05-session-image-contracts.md)。
