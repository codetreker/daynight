# Task Discussion Web 设计

## 职责与组成

[Thread 需求](../spec/daynight-task-thread.md)拥有不可变消息、认证作者、Id 分页、提交结果和 Web 可观察行为；[服务端设计](daynight-task-thread.md)拥有持久化、顺序及实际编码。Discussion 是任务详情的独立消费者，与任务描述、附件和原生 Session 分开。

`TaskDetailSurface` 组合 Discussion、概览、附件和可选 Session；`TaskDetailReading` 将各面板交给 `TaskDetailPanels`。顺序为概览、附件、讨论、可选 Session。Discussion 不依赖 claim、任务状态或 Controller 在线，普通 Web 发言只发送 body 和可选 replyTo，不携带 claimId。

`TaskDetailTab` 类型与 router 的运行时白名单都包含 discussion。`?tab=discussion` 使用既有任务 URL，独立页以 URL 恢复页签，弹层仍保存本地选择。同一任务切换页签不卸载 Discussion；离开任务页面、关闭详情或账号生命周期退休则释放其内存。面板全部保持挂载并使用 hidden/inert，因此 controller 的活动状态必须由明确的 active 参数控制。

| 所有者 | 职责 |
| --- | --- |
| `src/app/CurrentAccountContext.tsx` | 从 AuthenticatedApp 直接提供当前 session.user 与认证准入状态，跨 portal 覆盖独立页和项目详情 |
| `src/features/task-thread/contract.ts` | 浏览器消费者的 scope/query 类型、消息一致性和条数窗口；复用浏览器安全的 API parser |
| `src/features/task-thread/json.ts` | 响应流、fatal UTF-8、错误传输限额和原始 JSON 来源解析 |
| `src/features/task-thread/api.ts` | Thread 路由、身份头、HTTP 结果、dispatch 边界及确认资源 |
| `src/features/task-thread/controller.ts` | 页面内存、订阅、请求代际、连续读取、历史、草稿、发送与容量 |
| `src/ui/ChatMarkdown.tsx`、`useTimelineScroll.ts`、`reading-text-anchor.ts` | Session与Discussion共用的纯Markdown和阅读锚点原语 |
| `src/features/task-thread/TaskDiscussion.tsx` | controller 生命周期、活动页签/可见性和不可变 snapshot 的 React 订阅 |
| `DiscussionTimeline.tsx`、`DiscussionComposer.tsx`、`ThreadMessageDetails.tsx` | 时间线、撰写区、引用与原生详情 dialog |
| `src/features/task-thread/presentation.tsx` | 账号标签、来源、摘要、图标与安全错误详情 |
| `src/styles/task-discussion.css` 与 inspection 语言目录 | Discussion 专属布局、响应样式、双语文案和可访问性标签 |

CLI的`src/api/thread.ts`、`json-source.ts`和相关纯校验代码不依赖Node运行时。Web直接复用其字段、精确时间、来源区间和重复字段校验，保留自己的网络、身份、页面状态与渲染；不导入CLI命令、终端renderer或Operation。共享parser不产生共享客户端生命周期。生产及dev-ci共用的[Dockerfile](../../deployment/localhost/Dockerfile)与其context allowlist纳入CLI `src/api/`、`src/session/`树及精确的`src/platform/text.ts`，覆盖Thread parser与既有Session协议的源码闭包；这些共享输入变更同时选择CLI和Web检查，规则由[开发指南](../development.md#ci-selection)拥有。

## 请求与响应准入

唯一资源为 `/api/v1/projects/{projectId}/tasks/{taskId}/thread/messages`。Web 页面、历史和引用 GET 均显式使用 details=true；普通页 count=50，引用解析 count=1。历史 Agent 的 provider 徽标来自消息快照 execution，不能从当前 worker 推断。

请求复用既有 no-store、same-origin、Cookie/Origin、认证暂停与 `ApiError`。`request()` 的可选 onDispatch 回调在内部认证等待完成后、fetch 前执行；15 秒网络/响应时限从该边界开始，等待认证不占此时限。客户端不能以调用 request 函数代表请求已发送。

fetch 返回后，先检查请求 ticket、scope generation、lifetime 和当前账号，再检查 Daynight-User-ID。只有仍属于当前 live scope 的响应才能触发 principalMismatch；回调自身也重验准入。解码后发布之前重复检查，避免旧成功响应或旧错误账号头影响新账号。普通同 UID 身份重新验证不退休任务 scope。

成功响应使用 `ReadableStream` 与 fatal UTF-8 解码，沿用媒体类型、abort 和 15 秒期限，不执行 Thread 页面或单消息读取字节准入；错误 envelope 保留独立 16 KiB 传输上限。共享 source scanner 在对象解码前拒绝重复键、未知字段、损坏输入和过深结构；来源解析保留服务端完整字段和字符串。

有类型解析要求小写 canonical UUID、真实 UTC 日期及固定三位毫秒、大写 Agent 布尔、必填 nullable displayName、完整且合法的可选 execution。details 的 Agent 消息必须含 claimId/workerId/provider，普通账号必须省略来源。页面严格升序、ID 唯一、数量不超过请求 count，空页两个 hasMore 均为 false。

同任务同 ID 的作者、displayName、Agent、body、createdAt 和 replyTo 必须一致；经过验证的详细资源只能补充相同基础消息的 execution，已有来源也必须一致。冲突拒绝整页，部分解析结果不能发布。

`isThreadScopeLoss` 只接受通过身份及错误 envelope 校验的 403 forbidden、父任务 404 not_found、410 task_deleted，或已确认的 principal/lifetime 失效。404 message_not_found 属于引用、回复或分页边界的局部失败，保留消息、草稿、回复与连续游标。畸形错误或单独 HTTP 状态不能证明 scope 丢失。

## 页面内存与账号生命周期

scope 仅为 `(userId,projectId,taskId)`。任务 version、当前 claim、图 revision 和当前 worker 都不是 Discussion 的 key。`CurrentAccountContext` 使用 AuthenticatedApp 已有 session.user，不请求第二份 `/me`、成员名册或缓存账号资料。

`createThreadController`构造`ThreadController`，通过不可变`ThreadView`与subscribe/snapshot供`useSyncExternalStore`订阅。setActive、setDocumentVisible和setAdmissionBlocked控制准入，setFollowing/setReadingAnchor表达阅读意图；refresh、loadOlder、loadWindowNewer、revealIncoming、showReference/openDetails、send和retire分别拥有其操作。状态包括可见消息窗口、已缓冲新增、连续位置、历史两侧标志、草稿及其 revision、回复及其 revision、发送阶段、引用缓存和独立读取错误。Thread 不调用 TaskCache 数据读写、IndexedDB、BroadcastChannel、task-sync 或图刷新；仅复用账号 scope 的 ready、signal、principalMismatch 和项目撤权订阅。

首次激活读取最新页；页面可见且该页签活动时，成功结束后 5 秒安排下一次增量读取。积压按页立即追赶，正向读取串行。隐藏页签、隐藏 document 或认证暂停时停止计时器并取消 GET；恢复可见立即刷新。document 隐藏和临时认证准入阻塞不清除详情、消息、引用、草稿、回复、阅读锚点或分页；已加载页面仍允许本地编辑草稿，新读取、发言和结果发布仍受准入限制，失效 ticket 的响应不能发布。读取失败保留数据与位置，显示所属操作的错误和重试入口，明确重试后恢复轮询。

已 dispatch 的 POST 不因页签隐藏取消。账号变化、任务页面释放、scope abort 或可信撤权会同步退休 controller，清空消息、草稿、引用和详情，关闭子 dialog 并取消请求。退休后的成功响应也不能恢复数据或清理其他任务的草稿。

## 连续位置与双向窗口

`consumedAfterId` 表示完整校验且已保留的连续正向位置。初始最新页以实际末项建立它；空 Thread 使用 fromBeginning，从最早新增开始追赶。只有整页所有消息都保留到 visible 或 incoming 后，正向页才推进到实际末项。空页保持输入位置，容量不足时拒绝整页准入并暂停追赶。

POST 回执、历史、引用和详情永不推进连续位置。已消费 A、别人先发 B、本地 POST 返回 C 时，C 可以先显示，但下一次仍从 A 读到 B/C，再去重 C 并推进位置。当前可见末项不能代替连续位置。

| 数据窗口 | 上限 |
| --- | --- |
| visible | 200 条 |
| incoming | 100 条 |
| 引用 LRU | 16 条，固定项也计入条数 |
| 读取并发 | 正向 1 个、历史 1 个、引用解析 1 组 |
| 固定项 | 阅读锚点至多 1 条、最新确认回执至多 1 条、唯一在途 POST 预留 1 条 |

条数限制保留的消息身份，不执行正文或引用的读取字节准入，也不承诺固定 JavaScript 堆大小或模型 token 数量。相同 ID 共享已验证资源，不为每个视图复制正文。新确认回执替换前一回执固定项；已展示的自己回执不因尚未被连续 GET 覆盖而无限固定。

incoming保留完整连续缓冲区间，包括已经在visible出现的回执；新消息数量只统计incoming中当前未展示的Id，不冒充服务端总积压。当前读取区间完整覆盖缓冲区间后才可清除incoming。有缓冲消息的reveal以完整incoming重建区间并保留固定项，其他已展示消息可重读；空缓冲且无容量暂停的跳转保留原区间并恢复底部阅读；需要释放追赶容量时可缩到原区间最新已读取单项，不把分离的可见项提升为区间边界。显式导航可以移出尚未被连续GET覆盖的自己回执，移出绝不改变连续位置。incoming 上限加三个固定项最多 103 条，再加完整 50 条正向页仍低于 visible 的 200 条上限，因而释放条数空间后可继续追赶。

`windowIds`只表示一个已接纳且仍保留的连续服务端区间；分离的阅读锚点和自己POST回执可以继续可见，但不属于该区间。applyVisible从完整候选序列按被移出项划分连续段，按操作方向选择最旧或最新的边缘段；已有读取区间的裁剪至少保留一个已读取成员，保留可导航边界。方向可用性根据所有已知候选、移出项和可见项相对所选区间端点的位置计算，不能用分离可见项扩张区间。

正向页仅在捕获的after边界属于当前区间或返回Id与区间重叠时扩展它，初始fromBeginning也可建立区间；否则保留为独立incoming连续段。历史只从当前区间的真实首尾端点延伸；窗口外引用跳转以父消息单项建立新区间；POST不增加区间成员。历史ticket捕获私有windowRevision、方向与实际边界的Id/createdAt，在身份头回调前、解码后及合并前重新核对。窗口外引用跳转或reveal明确替换窗口时，replaceHistoryWindow先推进revision和history generation，取消旧请求并立即释放历史槽位及错误；旧成功、迟到错误和finally都不能覆盖新窗口或新历史请求，连续正向位置保持不变。

历史加载保持首个可见消息与文本偏移。达到容量时，明确向旧方向浏览可移出视口外已展示项；底部以afterId加载较新窗口。局部移出消息使对应方向“还有消息”成立。无法同时保留整页和当前锚点时，使用明确导航切换目标窗口并建立新锚点；不截断正文，不把tail GET当作游标重置。任意历史都可通过有限窗口双向到达。

## 回复引用与身份呈现

父消息已在内存时直接使用其验证后作者和纯文本摘要；摘要最多 160 个 Unicode code point，只影响展示。父消息不在内存时先显示完整 replyTo 和可操作的引用入口，不伪造作者或摘要，不对每条引用自动发请求。

用户请求后最多进行两个串行 GET：先 beforeId=target,count=1，取得直接前驱 P；有 P 再 afterId=P.id,count=1，无 P 则 fromBeginning=true,count=1。第二页必须恰好返回 target 才准入引用 LRU。不可变消息和严格追加顺序保证两次读取间不能插入到 target 之前。引用读取不推进连续位置，不覆盖历史标志；失败保留引用 ID 和局部重试。

作者使用快照 displayName；null、空串或仅空白时显示独立的完整账号 UUID 标签，不改写 wire 名称或使用 email。Agent 标签与 provider 徽标独立呈现。短时间和日期分隔本地化，详情保留完整 UTC 毫秒时间、消息及账号 ID、可选回复与来源和原始正文。

## 撰写与提交确认

composer 保存完整原始 body，不 trim、重排换行或破坏代码缩进。空白仅用于可用性校验，另拒绝 NUL、非法 Unicode 和原始 UTF-8 超过 64 KiB。Ctrl/Command+Enter 发言，IME composing 不触发。同一 controller 最多一个 POST；等待结果期间仍可编辑草稿和回复。

发送捕获 body、replyTo、账号及草稿/回复 revision。有效 201 要求身份头、完整默认资源、author.userId、Agent=false、body 和 replyTo 回显全部匹配。完整验证后立即停止网络计时并记录远端 confirmed，再等待同 UID 认证准入；之后的本地取消或准入失败不能改成 unknown。确认资源只占一个在途槽及一条消息预留；真正scope退休仍阻止旧资源发布。confirmed之后的本地准入失败进入readError并以admit阶段诊断，保留confirmed资源与远端结果，不写入postError或显示“未发送”。

准入后按 ID 合并消息。仅当各自 revision 仍等于发送快照时清空草稿或回复，不清理后续编辑。201 的 displayName 不要求等于页面当前名称，改名可以与发言同时发生。

有效 4xx 和经过验证的 clock_not_advanced 是明确拒绝；已 dispatch 的网络失败、超时、generic 5xx、message_outcome_unknown 或无法验证的成功资源是未知结果。二者均不自动重发。未知结果保留草稿和真实状态，普通刷新只 GET；相同正文不能证明是原发送，再次点击发送是新的追加。

## 阅读、键盘与验证

Discussion沿用任务详情公共页头和操作。宽屏横向留白按讨论区所在容器宽度计算；普通960px详情弹层保留30px边距，独立页/全屏保留原有1080px默认、1280px宽屏阅读上限；600px及以下的窄屏间距和发送按钮10px字号保持。时间线与composer分配独立可用空间，长正文换行，代码/表格局部横向滚动，窄屏消息动作始终可达。忙碌、禁用和选中由控件表达，实际错误清楚展示；双语文案由typed inspection catalogs拥有。

Markdown 使用共享安全聊天 renderer，保留 GFM、软换行和隔离的 footnote ID，不接收 raw HTML。外链仅 http/https/mailto，使用 noopener noreferrer；图片呈现替代内容，不加载附件或原生资源。滚动复用阅读意图与文本锚点；向上阅读停止跟随，历史 prepend 和 composer 变高保留锚点，明确查看新消息才恢复底部跟随。

原生消息详情 dialog 拥有 capture 阶段的 Escape/Tab、父 owner inert 及关闭后焦点恢复，同时报告子层占用给 Surface 键盘、焦点回收和遮罩处理。临时检查保持同一 dialog 挂载，不重复调用 showModal 或释放父 owner 的 inert；隐藏页面、准入阻塞和任务/账号失效时禁止向旧 opener 恢复焦点。子层 Escape 只关闭详情，不能退出任务全屏或关闭父任务。

读取与发送错误通过`ThreadErrorDetails`按需展开已验证code/requestId，不显示原始响应或上游错误文字。controller的私有`reportFailure()`使用console.warn输出局部结构化事件，包含component=task_thread_web、projectId/taskId、phase、读取direction、受限code、HTTP status、验证后的requestId、固定cause类别与outcome。confirmed后的准入失败保留outcome=confirmed；未知结果不能计为已失败回滚。事件不包含正文、名称、草稿、凭据或原始Error对象，不建立持久遥测队列或新的请求/提交身份。

可按component、taskId及既有requestId过滤浏览器诊断，并关联服务端component=task_thread日志；没有requestId的网络失败只使用任务、阶段和浏览器时间定位，不能据此推断Agent已读。

功能验证覆盖来源 decoder、A/B/C 连续性、初始空后积压、独立历史及引用、条数窗口边界、完整大消息页、连续自己发言的回执替换、认证暂停及迟到响应、明确/未知/确认结果、确认后准入失败、正文与 revision、page/modal/fullscreen 焦点和窄屏滚动。真实服务与浏览器互操作证据与单元中的可控传输区分；常规 CI 不运行压力负载。完整命令由 [Web 指南](../../packages/daynight-web/README.md#validation-and-build)拥有。

[决策记录](../../.agents/notes/archived/architecture/2026-11-03-task-thread-web.md)保存原职责划分、复用和窗口容量的取舍；[普通读取决策](../../.agents/notes/implemented/simplification/2026-11-09-canonical-resource-pages.md)记录保留条数窗口并移除读取字节准入的职责。
