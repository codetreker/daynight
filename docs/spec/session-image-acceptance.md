# Session 图片验收与容量规格

本文定义图片能力的容量保证、验收追溯和证据边界，不表示整条图片输入、采集及归档链或任何平台已通过验收。[输入与草稿规格](session-image-input.md)拥有 R1–R3/R7，[显示与归档规格](session-image-history.md)拥有 R4–R6/R8；本页引用这些规范，不另设竞争行为。

当前 Provider 图片矩阵覆盖 Codex、Copilot。Claude 不属于当前图片交付与验收范围；已有适配与历史数据保留兼容、权限和拒绝语义。此范围不豁免原生权限、平台证据、来源保存或外部网络验收，具体理由见[Provider 范围决策](../../.agents/notes/implemented/architecture/2026-11-11-image-provider-scope.md)。

## 容量与兼容要求

- 单图 10 MiB 的输入上限必须贯穿上传、Provider 输入、在线资源读取和归档。不能出现前端接受，而后续层仍按 8 MiB 无法读取或保存的状态。
- 大图片使用有界的传输和内存，不阻塞已有命令、回执与时间线读取；一次传输失败不破坏文本会话。服务器、Controller、浏览器和持久化格式需要有明确兼容行为。
- 旧 schema1 归档的 64 MiB JSON 上限包含 Base64 膨胀；schema3 将图片原件外置。已接受图片须可历史回看，超过 Session 实际内容总量或真实磁盘不足时明确拒绝新增内容。
- 老版本 Controller 或客户端不具备图片能力时，明确阻止图片操作并保留文本能力；不能通过严格协议拒绝造成整个 Session 无法读取。具体版本协商与发布顺序由方案定义。
- 原型中的模拟上传和回显仅用于界面评审，不能证明真实 Provider、网络、存储、权限或平台验收。

## 容量与边界计量

所有 MiB 使用二进制单位：1 MiB = 1,048,576 bytes；1 GiB = 1,073,741,824 bytes。图片按原字节、JSON 按完整 UTF-8 编码计量，不用声明 Content-Length、压缩大小、浏览器 size 或取整后的数字替代。格式和大小合格之外仍须完整解码及几何资格；更小的已证明原生 profile 限制优先，并由前端到最终派发一致执行。

| 对象 | 必须满足的容量与可观察结果 |
| --- | --- |
| 单条输入 | 最多 8 张，每图 10,485,760 bytes，全部图片合计 20,971,520 bytes；任一图片失败整条拒绝，无截断、剩余子集或仅文字发送。 |
| 输入与显示格式 | 输入 PNG/JPEG/WebP；显示保留 PNG/JPEG/GIF/WebP/AVIF。SVG、HTML、空、伪装、截断和损坏内容明确拒绝，不转码替换原件。 |
| Session 实际内容 | 正文、完整索引、不同已提交 resourceId 的原件、已提交 descriptor 与已发布 manifest 合计不超过 134,217,728 bytes；同 resourceId 多引用只计一次，不同 resourceId 即使摘要相同分别计量。临时副本、数据库内部空间和无内容控制记录不计入；旧大记录保持可读，已确认重放不重复计量。 |
| 完整历史 | schema3 timeline 的完整 UTF-8 编码最多 134,217,728 bytes、100,000 entries；全部文字、reasoning、工具、失败图片、bindings、retained 和撤回容器计入 Session 总量。旧 schema1/2 保持 67,108,864 bytes 边界。 |
| 归档 | manifest 最多 4,194,304 bytes、1000 项；新图片原件不内嵌 Base64。schema3 完整同步 envelope 最多 134,234,112 bytes，其 timeline 和整个 Session 仍须满足实际内容总量。显示分页截短不能代替完整历史。 |
| 服务存储准入 | 不为未来原件、正文、索引、归档或暂存预留额度，也不按卷空闲水位拒绝旧容量申请。实际存储不足或写入失败必须明确返回，保留原身份和清理责任，不删除历史原件腾空间。 |
| 上传身份与保留 | 上传准备资格为 24 小时；GET 或重传不续期。身份 tombstone 保留原查询和去重职责，不以累计数量作为容量申请拒绝条件。过期不清除 operation unknown、消息、记录或 native/resume 的有效引用。 |
| 服务传输 | 图片块最多 524,288 原字节；同 Session 全方向和全部连接代次合计最多 2 个媒体块在途，账户最多 8、部署最多 64。归档文件块 1–1,048,576 bytes，同 Session 最多 1 个，仍占公共媒体额度。控制、查询、删除和回执在块边界可进展。 |
| Controller | 每 execution 媒体 2200 MiB，stateDirectory 媒体 8 GiB，卷空闲 512 MiB；控制元数据 128 MiB 加 8 MiB 结算余量；已提交正文及原身份匹配的完整同步文件提供实际字节对应的额外空间，未登记孤儿不豁免。当前正文替换只计最新版本，DB/WAL/SHM、未退休旧文件和同步文件仍计真实占用。原生协议解析和子进程另计实际占用；不能由小块传输推断内存有界。 |
| 通用完整解码 | 单轴最多 16,384，画布最多 33,554,432 像素，最多 256 帧，累计最多 67,108,864 像素，RGBA8 输出最多 268,435,456 bytes，单图最多 15 秒。完整遍历所有帧；静态为 1 帧。每解码子进程 512 MiB RSS 为监控目标，不能称为硬内存隔离。 |
| 浏览器持久草稿 | 每账户 256 MiB，总量 512 MiB；editable 和 frozen 引用不因淘汰页面缓存而被删除。配额、事务或 Blob 错误明确阻止含图发送并保留实际编辑状态。 |
| 浏览器页面原件 | 页面 128 MiB/32 项、owner 64 MiB/16 项；前景保留 40 MiB/2 槽，后台 88 MiB/30 项、owner 后台 24 MiB/14 项；在途缓冲计入。背景满时一个 10 MiB 预览和一个下载仍有前景准入。 |
| 浏览器解码和下载 | 画布估算 256 MiB，最多 2 个完整解码；下载 1 在途加 2 排队。估算不能称为 GPU 硬限额；取消或超时须实际结束后才返额度。 |

10 MiB 原件的 Base64 长度为 13,981,016 bytes；五张仅 Base64 就有 69,905,080 bytes，已超过 64 MiB。因此必须验证合法原件通过外置存储完成归档，不能简单扩大旧 JSON 限制，或沿用旧 8 MiB 分支导致前端已接受的图片无法读取。旧资源与旧归档继续按其原格式校验，不伪造缺失图片或帧数。

字节和几何边界应以有效可完整解码的样本覆盖 limit−1、limit、limit+1，数量覆盖上限与上限+1。单图必须包含 8 MiB+1 到 10 MiB 的新资源，消息必须覆盖 8/9 图与 20 MiB±1。每个更小原生 profile 亦覆盖同样边界；几何包含 EXIF 方向、动画帧数、长宽比及小字节大画布，不能只改 descriptor 模拟超限。

## R/A 追溯

| 需求 | 唯一行为拥有者 | 验收覆盖 |
| --- | --- | --- |
| R1 添加、预览与编辑 | [输入规格](session-image-input.md#r1-添加预览与编辑) | A1、A3、A7、A9、A10 |
| R2 上传与发送状态 | [输入规格](session-image-input.md#r2-上传与发送状态) | A2、A5、A11 |
| R3 原生 Provider | [输入规格](session-image-input.md#r3-原生-provider) | A2、A4 |
| R4 原生图片 | [历史规格](session-image-history.md#r4-用户agent-与工具的原生图片) | A2、A6、A8、A9 |
| R5 Markdown 来源 | [历史规格](session-image-history.md#r5-markdown-本地与外部图片) | A6、A7、A8 |
| R6 加载、预览与下载 | [历史规格](session-image-history.md#r6-加载预览与下载) | A6、A7、A9、A10 |
| R7 草稿恢复 | [输入规格](session-image-input.md#r7-草稿恢复) | A5、A11 |
| R8 历史与归档 | [历史规格](session-image-history.md#r8-历史与归档) | A8、A9、A11、A12 |

## 整体验收

| 编号 | 验收场景 | 可观察结果 |
| --- | --- | --- |
| A1 | 选择、粘贴、拖拽单图与多图 | 草稿顺序正确，可预览和移除；纯文本粘贴、输入法和快捷键不退化 |
| A2 | 纯图片与文字加图片分别发送到 Codex、Copilot | 原生输入确有图片，Agent 能依据测试图回答；消息回显对应同一输入且只发送一次 |
| A3 | 8 张、10 MiB 单图、20 MiB 总量及各边界超限 | 边界内全链路可用；超限明确拒绝，不截断或隐式只发文字 |
| A4 | 不支持图片的模型、模型变化、回合中输入 | 能力判断一致，拒绝时保留草稿；不伪造原生图片能力 |
| A5 | 上传失败、断线、发送回执丢失、刷新后恢复 | 可重试准备图片，发送未知结果仅恢复原操作；无重复原生回合或跨会话误投 |
| A6 | 用户图、Agent 原生图、工具图、Markdown 本地图与外部 HTTP(S) 图 | 所属关系正确、真实图片可见，能放大与下载 |
| A7 | 路径越界、损坏字节、外部跳转与不可访问源 | 明确失败，不能越权读取；重试可恢复真实的暂时失败 |
| A8 | 历史分页、原生恢复、结束归档、Controller 离线、原文件删除或外部源变化 | 已采集的历史图片仍显示保存的原内容；缺失资源不冒充完整记录 |
| A9 | Task 弹窗、独立任务页、Test、Bot、全屏、历史选择器及附件记录 | 对应输入/只读边界正确，共享图片行为无入口遗漏 |
| A10 | 390px 与桌面、大图、多图、长名称、读取过程中流式更新 | 无页面溢出、焦点逃逸、背景滚动或阅读位置强制跳转 |
| A11 | 账户切换、权限撤销、会话执行代次变化、删除和资源清理 | 旧草稿与回执不误投，图片访问不跨账户或越权，仍有效的历史资源不误删 |
| A12 | 旧文本记录、旧归档、图片功能不支持的组件版本 | 保持既有文本读取和操作；图片不支持状态明确 |

Provider 验收应分别注明原生版本、模型和运行平台；受控测试只能证明其测试范围。桌面与窄屏浏览器检查不能替代Codex、Copilot 的真实 Provider 输入和归档读取验证。

## 必需失败与恢复观察

每个适用场景同时验证拒绝结果、真实副作用和成功恢复，不以 HTTP 200、界面标签或截图单独判断通过。

| 验收范围 | 必须覆盖的失败与恢复 |
| --- | --- |
| A1/A3 输入 | 三种添加入口、同文件重选、异步验证乱序、长名称及超限；普通粘贴、选区、撤销、IME 和菜单行为保持。拒绝的第九张不能刷新后消失而偷偷发送其余图片。 |
| A2/A4 原生 | Codex、Copilot 分别测试纯图、混合、不同图顺序与重复同图；第二图不可读时零次原生调用，派发后丢回执时最多一次调用且仅查询原操作。无图片模型、能力 unknown、模型/权限/上下文变化及回合中输入保持一致拒绝。 |
| A5 草稿与上传 | 上传各阶段响应丢失、连续块确认与精确重传、100% 仍验证中、事务 abort、缺 Blob、quota、多标签竞争、冻结/派发/接受/清理间崩溃。接受仅清原版本；后继草稿保留，unknown 不重发、不被新 draftId 绕过。 |
| A6/A7 来源与显示 | 用户、Agent、工具、Markdown 本地与外部图及五种显示格式；真实 AST 节点、引用式和链接图片，代码/raw JSON/HTML 不触发读取。路径越界、符号链接替换、损坏图、重定向、DNS 变化、私网和凭据隔离须观察源打开/HTTP 请求与字节数。 |
| A8 历史 | 原图 A 保存后路径/URL 改为 B 或删除、Controller 停止，历史、预览及下载仍为 A 的完整摘要，源请求为零。完整分页、页外 coverage、跨 revision 的完整条目 content_changed、原生恢复、正文撤回与迟到关联、归档提交丢回执、备份恢复、已保存原件损坏分别验证。正文/totals/Markdown/图片/outbox 写入及提交故障只暴露完整旧或新视图；活动同步、stopped source-tail、schema3 与旧 ready receipt 保持原字节和身份，网络阶段无 SQL 快照或已关闭连接访问；unknown 或损坏不能冒充 partial。 |
| A9 全入口 | Task 弹窗、独立页、Test、Bot、每个 live 全屏及 Task 双层全屏；历史选择器与附件原生记录只读。核对实际 resolver、目标 fence、草稿/operation 身份及网络次数，不以同样外观代替接线证据。 |
| A10 阅读与交互 | 桌面及 390px、多图、大图四边、长名、流式更新、工具折叠、权限无变化复核、真实键盘/触屏/滚轮、软键盘、旋转和缩放；媒体锚点偏差≤2 CSS px、原文字 prepend≤1 CSS px，关键触控≥44 CSS px。 |
| A11 身份与清理 | 换账户、Task generation、native 身份、Team/项目撤权、Bot 父凭据失效、删除与迟到写入竞争、冷 pane 淘汰、缓存命中及排队下载撤权。旧回执不误投，敏感预览撤下，有效消息/归档/native/unknown 引用不误删，取消实际结束后才清理。 |
| A12 兼容 | 新旧服务/Controller/Web 组合、旧文本和资源、schema1/2/3、Herdr 专属读取、未知表示、回滚；图片不支持明确，旧文本读取与操作保持，已有图片原件和原操作查询继续可用。 |

## 原生与平台证据

| 层次 | 运行对象 | 结论边界 |
| --- | --- | --- |
| L1 合同与模块 | 生产 parser、codec、状态机和受控故障输入 | 验证接受/拒绝、顺序和调用次数；不能证明真实模型识图。 |
| L2 集成与故障 | 真实隔离数据库/文件系统、Controller 传输、真实浏览器与受控 Provider | 验证权限、原子提交、持久恢复、DOM/网络与生命周期；fake SDK 不构成原生能力证据。 |
| L3 原生与整链 | 固定真实 Provider/model/profile、真实服务/Controller/浏览器和保存文件 | 验证原生输入、精确接受、识图、消息关联与 Controller 离线归档；结论限于实际平台与版本。 |

每个 Provider 的样本须独立覆盖纯图、图文、两张不同图顺序及重复同图身份。图片内含随机颜色、几何位置、短码或任务；答案不能泄露在文件名、prompt、displayName 或之前的会话文本。证据同时包含真实 native payload 形状、逐图摘要、唯一调用数、精确接受关联和模型答案；“看到了图片”或缺少 payload/身份链的正确答案均不足。

Codex 接受必须关联原 start 返回的合法 turn.id，或 steer 返回的精确 expectedTurnId；clientUserMessageId 不提供自动重发幂等性。Claude 不在当前图片验收矩阵内；若将来开放其图片资格，须先有已证明原生 profile 下 root user_message_uuid/command_uuid 的精确投递关联；SDK 消费、user 落盘、hook-blocked 或下一条 assistant 的位置关系不能代替。Copilot 须持久保存唯一 send Promise 返回的非空 messageId 与原 operation/有序图片关联，不猜测其恒等于 user event ID。历史可展示与原生已接受是不同事实。

实际支持平台按[开发与验证说明](../development.md)及各组件发布要求核验 macOS arm64、Linux、Windows。Codex、Copilot 分别记录每个平台的 native/SDK/backend/model/profile 结果；其他平台通过不能填补未测组合，Intel macOS 不计作已支持平台。Task/Test/Bot 三种原生输入 host 至少各有一个真实 L3 路径，其余入口核对同一原生身份与 L2 接线；不能据此声称每个 Provider×入口均真实运行。

浏览器证据记录产品版本、OS/arch、viewport、DPR 和输入方式。390px 桌面模拟只证明窄屏布局，不能代替真实触屏、软键盘、移动浏览器解码或原生平台文件句柄与进程终止。原型仅为内存交互输入，其上传、回显和恢复模拟不得成为生产 oracle。

每例结果为 `passed`、`failed`、`not_run` 或 `native_not_produced` 并附原因。缺必需环境、凭据或平台为 not_run，必需项 not_run/failed 不能通过验收。native_not_produced 仅适用于真实版本确未产生的特定输出形态，仍需 L1 解析覆盖；不得豁免 Codex、Copilot 的 A2 输入。

## 性能、证据记录与完成条件

容量和有界性验证记录空载与负载对照、最坏并发、RSS（含子进程和 native allocation）、heap、FD、队列、对象 URL、文件/数据库用量及控制回执/历史请求进展。媒体忙碌不能饿死原控制操作；首次打开不全量载入图片原件。沿已确认准入值验证，不擅自增加毫秒 SLA，也不把监控目标、Node heap 或画布估算当作硬内存上限。来源结算 60 秒到期不能证明 writer 停止或 commit 未发生。

Controller 当前正文采用的容量验收还须验证重复累计更新仅保留一行、无新候选文件，重开后的完整字节/hash/seq/revision/totals 一致；精确 128 MiB/100000 上界、+1 拒绝和替换不累计，同时满足实际物理准入。大体积、989 版本和 100000 条探针独立于普通 CI，记录生成数据的内容/顺序、outbox/ACK、reader 条件和 DB/WAL/SHM 实测峰值。生成探针不能冒充未取得的原事故 trace，也不能与隔离模型宣称等同性能。

正式结果记录 caseId、requirementIds、layer、result、reason、productionCommit、testCommit、combinedTree、platform、nativeVersion、sdkVersion、backend、effectiveModel、capabilityProfile、fixtureSha256、byteLength、mediaType、dimensions、imageOrder、nativeCallCount、receiptEvidence、historyEvidence、archiveHashes、measuredLimits 和 limitations。未知事实写 null 并解释；稳定脱敏身份须保持关联，不能记录认证令牌、全量 Base64、敏感路径或未授权正文。此为验收结果格式，不是产品 API。

检查使用实际文件对应的[开发验证命令](../development.md)和组件说明，保留现有覆盖、权限、兼容和失败断言。文档发布只证明规范、链接和决策记录的一致性，不替代 L1/L2/L3。图片功能完成要求所有必需行为与失败恢复通过，实际生产/测试版本及组合明确，全部必需交付已合入并有可读证据。新写入和来源采集在完整链路验收前保持关闭；启用时重新核对实时有效能力，不能仅凭上游设计完成或测试文件存在宣称可用。
