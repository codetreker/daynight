# 助手 Session 呈现、绑定与页面缓存

[需求](../spec/bot-session-view.md)定义助手阅读、输入、稳定切换及清理结果；[共享 Session 设计](task-session-protocol.md)拥有 renderer、reducer、操作回执与阅读 hook。[管理页设计](bot-management-web.md)拥有列表、创建、统一标题的页面组合及详情布局。助手呈现通过可选插槽消费共享控件，不建立第二套聊天状态或 Provider 操作。

## 呈现接口与责任

[`session-presentation-slots.ts`](../../packages/daynight-web/src/features/task-agent-session/session-presentation-slots.ts)定义 `SessionPresentationSlots`，由 `SessionView.presentation` 接收。全部 render 回调返回 `ReactNode`，字段为 readonly。

| 类型或入口 | 内容与责任 |
| --- | --- |
| `SessionPresentationVariant` / `variant` | `default` 或 `assistant`；后者增加显式样式标记，不改变身份、能力或操作。 |
| `SessionHeaderSlot` / `renderHeader` | 当前状态及共享标题节点；在共享 header 内组合，不替换 section/header。 |
| `SessionEmptySlot` / `renderEmpty` | `draft` 和只更新草稿的 `setDraftAndFocus(text)`；仅在共享视图确认初次空对话时调用。 |
| `SessionComposerPresentation` / `composer` | 可选 `compactMenus`、`nativeSelectTouchMode`、`renderAttachments` 和 `renderFooter`，透传给共享 Composer；也可作为 `SessionComposer.presentation` 使用。 |
| `SessionComposerAttachmentSlot` | `text`、`setText`、同一 textarea 的 `inputRef`，以及 `snapshot`、`active`、`connected`、`authPaused`。提供布局和现有草稿入口，不授予上传或原生输入能力。 |
| `SessionComposerFooterSlot` | `settings`、`activity`、`submit` 三个实际节点；自定义 footer 的 `activity` 仍包含独立 Interrupt。 |

`SessionView` 继续持有客户端订阅、显示偏好、状态描述 ID、全屏 hook、恢复诊断、错误、历史、操作回执和 Composer。`SessionComposer` 继续持有 form、textarea、菜单、IME/命令键盘处理及原生控制。宿主组合节点，不能复制 handler、重写准入、按 Provider 名称推断能力，或用 CSS 隐藏唯一错误、审批或操作。

普通 `TaskAgentSession` 和 `TestSessionPage` 不传 `presentation`，使用共享默认标题、footer 与菜单路径，不匹配 Bot 样式选择器。没有 `renderEmpty` 时也不增加欢迎层容器。助手转入只读归档仍可保留样式，但生命周期不为 active 时不渲染 Composer；归档尚未就绪显示真实读取状态，就绪后复用 Timeline，只读交互不会获得响应能力。

## Bot 标题与稳定 DOM

`BotsPage` 提供 `renderHeader`，由 `BotConversationHeader` 消费；`BotSessionHost` 合并调用方配置，固定 `variant: 'assistant'`、`renderEmpty: BotConversationEmpty`、`composer.compactMenus: true` 和 `composer.nativeSelectTouchMode: 'container'`；Composer 配置在调用方 spread 后指定这两个展示值，保留其他插槽。当前 Bot 未自定义 `renderFooter` 或 `renderAttachments`。

`renderHeader` 在没有 snapshot 或 unavailable 时仍被调用，返回共享 `<header className="session-header">` 的内部内容。状态字段包括 `snapshot`、`startupReport`、`active`、`current`、`available`、`readOnly`、`runtimeReady`、`authPaused`、`status`、`fullscreen`、`displayMode` 和 `statusDescriptionId`。不可用时 snapshot/report 为 null；report 只来自已匹配的执行报告。`runtimeReady` 表示 Session 运行可用性，不能替代发送、审批、设置和取消各自的准入条件，也不能由 Bot 启动成功推导。

宿主在名称旁呈现共享 `provider` 和 `activity`，操作区使用共享 `display`、`focus`，`refresh` 放在更多 popover 内。每个共享节点只挂载一份；popover 的显隐不复制刷新控制。无 snapshot 时保留通用标题和仍可用的控制。返回列表、详情与关闭选择由 Bot 宿主管理，关闭只退出阅读选择，不删除或停止 Bot。

共享 section 的 ref、tabIndex、键盘处理和 `.task-agent-session` 祖先保持不变；`focus` 保留全屏按钮 ref，`activity` 保留 role、原生标签语言和状态 ID，textarea 的 `aria-describedby` 继续指向该 ID。详情触发 ref 由宿主拥有，浮层留在同一 `fullscreenBoundary` 中，Escape 按最上层关闭和焦点恢复规则处理。

每个已挂载 pane 固定插槽结构。连接、详情、空态或专注模式变化不改变 Timeline 祖先、key、reading handle 或客户端。回调对象可重建，但不能用条件增删 `renderEmpty` 配置来切换结构；附件区可出现或消失，共享 textarea 仍是 `.session-composer-surface` 的直接子节点，保留同一 ref、事件和身份。

## 阅读样式与空对话

[`bot-session.css`](../../packages/daynight-web/src/features/bots/bot-session.css)将共享内容覆盖限定在 `.bot-session-pane .session-presentation-assistant`；欢迎组件使用独立 `bot-conversation-*` 类。阅读列和输入内容上限为 760px。正文 16px、行高 1.8，用户气泡按内容收缩、靠右且不超过列宽的 85%，助手正文直接使用共享安全 Markdown。同一 `.session-presentation-assistant` 元素提供 `container: bot-reading native-select-region / inline-size`，保留阅读样式的容器名称并供公共选择控件查询。`bot-reading` 实际容器宽度不超过 600px 时，正文为 15px、阅读区左右留白 18px。代码、表格沿用共享局部滚动，普通工具输出保持原文，长链接、资源名称及错误在列内换行；任务链接不产生额外业务查询。

输入对齐使用共享 `useSessionColumnLayout`，测量 Timeline 内容相对 Composer 内边框的左右距离，写入 `--session-column-left/right`，包括真实滚动条占位。ResizeObserver 在下一帧更新；隐藏 pane 的零宽测量被忽略，恢复可见后继续测量。单独设置相同 max-width 不足以保证对齐。Bot 阅读区使用零 flex basis 为输入和菜单让出高度；高度与横向测量均不改变阅读身份或触发另一个分页机制。

空态由共享 View 同时检查：可用且 ready、active/current、运行可用、非只读、历史已确认、没有更早历史、分页加载或历史错误、没有会话错误或恢复缺口、原始 entries 为空且 Agent idle。Conversation 过滤后为空不满足初次空对话条件。无助手、未绑定、加载、历史失败与归档保留各自状态，不显示可填写的欢迎建议。

`BotConversationEmpty` 提供本地化欢迎语和三项文本建议，按钮仅调用 `setDraftAndFocus`。回调执行前再次核对挂载、active/current、账号、当前 input、最新 ready 状态、原 execution fence 与 active lifecycle；失效回调直接返回。它只更新当前草稿并聚焦，不发送、不启动执行、不修改设置。普通身份后台核验保留已确认且仍可展示的空态及本地草稿编辑，写入仍受 authPaused 限制；真正断线或权威失效按实际状态撤下空态。

配置 `renderEmpty` 后，Timeline 与欢迎内容位于同一稳定 shell；欢迎内容在独立可滚动层呈现，不替换 Timeline。返回 null、undefined 或 false 时保留共享默认空提示；返回内容时只抑制其默认空提示，不遮盖历史错误、审批或恢复诊断。显示模式、虚拟化、回到最新及文字锚点继续由共享 Timeline 拥有。

## 输入、回执与附件扩展

Bot 在会话底部使用共享 Composer，输入与阅读各自占用可收缩空间。textarea 随文本增长至局部上限后内部滚动；≤600px 容器的关键输入按钮至少 44px，≤500px 窗口高度缩减输入留白与 textarea 高度。聚焦表面采用紫色边框，reduced-motion 关闭颜色过渡。

`SessionControlsPanel` 的动态 Provider 设置采用[公共原生选择组件](native-select.md)的 `form/fill`；`SessionComposerPresentation.nativeSelectTouchMode` 经 Composer 和 ControlsPanel 传到 `NativeSelect.touchMode`。普通 Task/Test 未指定时为 `none`，Bot 为 `container`。精细指针下，Bot 阅读容器宽 700px 时控件高 38px，宽 560px 时至少 44px；粗指针下高度至少 44px、字号为 16px；内层 `session-composer` 与 `session-composer-surface` 容器不截获 `native-select-region` 查询。页面只拥有布局，选择控件的皮肤、箭头、焦点和待定边框由公共组件拥有。`pending={Boolean(pending)}` 只呈现原 operation 状态；控件的 value 继续使用已确认设置值，原有 mutable、busy、操作准入及错误归属不变。

当前 Bot 使用共享默认 footer：设置、活动状态、主要动作按实际输入容器宽度分组，Interrupt 与 Send/Steer 保持同组。自定义 `renderFooter` 则仍获得 settings、包含 Interrupt 的完整 activity 和 submit；不能把默认布局的内部拆分误当作插槽签名变化。分组理由由[共享 footer 决策](../../.agents/notes/implemented/bug-fix/2026-11-06-responsive-session-footer.md)拥有。

| 条件 | 共享行为 |
| --- | --- |
| 空闲且可发送 | Enter 与 form submit 使用现有消息/命令分类；Shift+Enter 换行。 |
| working 且可 Steer | 依据真实 steer 能力与 currentTurnId 提交补充；无能力时保留草稿并禁用对应提交。 |
| 可取消 | Interrupt 是独立 `type="button"`，按取消门禁执行；textarea Enter 不调用 cancel。 |
| IME 或命令选择 | 保留 composition、isComposing、229 保护及命令菜单键盘规则，不把原型命令作为真实目录。 |
| 断线或 authPaused | 保留允许显示的同身份内容和本地编辑，暂停受限写入；设置、响应、发送与取消分别判定。 |
| pending 或 unknown | 保留原 operation 与草稿版本，unknown 仅通过 `checkOperation(operationId)` 查询原结果，不重发；身份暂停时检查也禁用。 |
| 成功确认或设置确认 | 发送只清理匹配提交 revision 的草稿，新编辑保留；模型、权限及 reasoning effort 的实际值仍等待原生确认或回读，pending 不冒充已生效。 |

`compactMenus` 缺省为关闭。Bot 显式启用后，仅 active pane 且 `visualViewport.height`（缺省用 innerHeight）≤500px 时使用短屏路径：共享菜单在 textarea 上方限高，命令标题、刷新、关闭与候选在同一容器滚动，设置面板整体滚动，菜单不占普通流高度预算。它保留原 DOM、输入及底部动作。键盘或辅助技术打开 Model/Permissions 时聚焦首个可用控件；指针打开沿原焦点路径。非原生 popup 的 Escape 或显式关闭返回 textarea，焦点移向被覆盖的其他内容时关闭菜单并保留新目标；命令菜单允许 textarea 保持焦点以输入与选择。宽高切换和隐藏 pane 清理布局监听、滚动锚点与样式，不重建客户端。

`SessionComposer` 的设置面板 Escape 与 `useSessionFullscreen` 的共享 React/document 处理器均尊重 `defaultPrevented`、IME/isComposing 和键码 229，并通过 `isNativeSelectPopupOpen` 判断真实控件的 `:open`。原生 popup 打开时只停止传播，保留原生 Escape 取消，不关闭设置面板或全屏，也不清除文本草稿。非 popup Escape 继续按原层级关闭和恢复焦点。全屏处理器同时保护不经过 Composer 的 Timeline 交互表单和录制缩放控件；交互多选仍以原生列表呈现并返回数组。

`renderAttachments` 是正常流、可收缩的布局槽，`setText` 使用原草稿和命令意图失效逻辑。共享高度预算优先保留 textarea、footer 与错误所需空间，不把完整附件高度设为硬性下限；大预览应有局部上限，极端视口中附件区可能缩至零，不能承诺所有附件操作同时可见。宿主不得包裹或替换 textarea，也不得强制附件容器不可收缩。

当前 Bot Composer 仍发送文本，未挂接上传控件或图片输入协议。既有 `SessionResourceView` 可以读取获准图片资源，校验字节长度和 SHA-256 后显示或下载，并在卸载时取消读取和撤销 Blob URL；图片资源阅读不等于支持上传图片作为模型输入。图片输入、持久草稿、预览和归档扩展分别由[图片输入规格](../spec/session-image-input.md)、[图片历史规格](../spec/session-image-history.md)及[图片设计](session-image-contracts.md)拥有。后续接入必须使用真实能力、身份与资源协议，并重新验证高度和控制组宽度，未接入时不显示假上传按钮。

## 绑定和消费接口

`api/sessions.ts` 导出 `BotSessionBinding` 和 `createBotSessionApi(binding, onPrincipalMismatch)`。factory 复用独立 Session 的 `/api/v1/test-sessions/{sessionId}` API，额外核对真实 `testExecutionId`。`TaskSessionClient` 的独立分支接受 `bot`，在 HTTP current 与 channel snapshot 上重新验证账号、Session、执行及 Web 模式；草稿范围包含 Bot 身份。既有 fence 继续约束请求结果，旧代请求的迟到权限错误不能撤销新代客户端。

页面在已认证的 `TaskCacheProvider` 内调用一次 `useBotSessionCache()` 和 `useBotDetail()`。两者的所有者均在选中项与详情面板之上，不以 Bot ID 或详情开关作 key。页面从真实 pane 集合推导最多三席驻留 Bot ID，详情缓存仅保留这些目标及当前冷目标。详情的 `displayBinding` 提供当前目标同账号范围内仍有效的显示身份，`actionBinding` 只来自当前选择代次的有效确认；`confirmed` 暴露同一确认事实，让没有 Session 的启动详情也能正确判定操作资格。列表名称仅作为当前目标的标题回退，不创建绑定或授权。

`BotSessionHost` 接收独立的 `displayBinding`、`actionBinding` 和当前 `botId`。完整身份使用 `botSessionKey`，包含 `ownerUserId`、`botId`、`sessionId`、`testExecutionId`；不属于当前目标或账号的绑定不能显示或准入。Host 保留同一 shell 和完整绑定 key 下的 Timeline、Composer 与 reading handle，当前选择直接控制 `hidden`、`inert` 和 `active`。布局 effect 以已提交选择和两份完整绑定更新 cache，render 不创建 client 或修改 cache。回切有效驻留目标时先恢复原内容，本次详情请求不隐藏会话；无可信显示绑定时传 null，不借用另一目标。

`BotSessionCache.select(displayBinding, actionBinding = null)` 每次先同步撤销全部 pane 的新操作资格，再仅为有效且完整相等的当前目标开放；命中已有 pane 也执行这个更新。Bot client 创建时显式使用 `initialActionAdmitted: false`。`suspendActions()` 只撤销新操作，不关闭读取或原回执恢复。导航仍由既有 `BrowserNavigation` 拥有；实际采纳通知在 React 提交前同步冻结旧 client，布局 effect 再处理已提交目标。相同 URL、未采纳或被取消的导航不能让当前目标永久冻结。外部导航、active 变化及账号/删除 guards 也在提交边界关闭旧操作，不依赖 250ms availability 定时器。

共享 `TaskSessionClient` 用 `SessionViewState.actionAdmitted` 发布新操作资格，`setActionAdmission(boolean)` 同步更新，同值不重复发布。`execute` 在创建 requestId/operationId 和写入 unknown、草稿 submission、setting intent、进度之前检查；`respond` 在 submissionId 之前先检查，最终 execute 仍再检查。所有写入口复用这道门禁，拒绝不排队、不自动补发、不制造未知操作。Task/Test 省略 `initialActionAdmitted` 时默认为 true，保留原行为。图片后续入口必须在其冻结或提交副作用之前消费同一准入。

操作资格不加入 `canInteract`、`owned`、`live`、认证 `admitted` 或 `authPaused`。`isCurrent` 仍由账号范围、撤权状态和实际 pane client 身份决定，不依赖当前可见项；隐藏 pane 可以同步历史和查询原 operation。SessionView 将资格分别传给 Composer 与 Timeline/InteractionCard，只禁止发送、取消、设置、命令、controls refresh 和回答提交。原 textarea、菜单浏览、live interaction 本地填写、待处理定位和展开保持原能力与身份规则；原 unknown 的 Check 继续按原 ID 查询。详情普通后台轮询保留当前确认，真实失败撤销，取消读取不伪造结果。

真正 auth pause 继续暂停受限写入与结果发布，保留原 pane、Timeline 和本地状态。可复用的 channel 在暂停期间保留，现有 60 秒和消息缓冲边界或真实传输中断会触发必要断开与恢复；重连等待原认证准入，并沿用 cursor 重放和代际拒绝。删除或权威失权使用原失效机制撤下内容；详情布局与显示模式不复制 renderer 或 reducer。

## 有界资源与轻量保留

`BotSessionCache` 按最近选择序号管理最多三个 pane。新增 pane 前先从旧集合淘汰最久未选择项，因此新当前项不会被淘汰。淘汰先从 reading ref 捕获书签，再从集合移除、关闭 client；取消后的迟到响应不能发布。React 移除对应子树，资源组件负责撤销 Blob URL。

每个绑定仅额外保留 `BotSessionStorage` 与可空书签。storage 包装现有客户端的草稿和 operation 序列化协议，使用完整 Bot 绑定命名空间；先写内存再尝试磁盘。读取后以内存值为准，删除失败保留 tombstone，避免旧值回流。它不保存 Timeline、资源或发送命令正文，回执沿用现有最多 200 项的未决集合限制。已认证新 fence 清理旧代草稿与回执；恢复未决操作仍调用原 operation 查询。

淘汰调用 `close`，不触发 `onInvalidate`。真正撤权使用幂等 `invalidate` 回调清除该 Bot 的挂载与冷状态、存储和显示偏好。`invalidateBot` 按 owner/Bot 命名空间清理，即使当前缓存从未选择过该 Bot，也覆盖此前导航留下的存储；页面内保留 owner/Bot/Session 关系供显示偏好清理。scope 的 abort 清除该账号的全部缓存。认证组件的退出、账号切换和已证实 principal 变化还调用 owner 级清理，枚举整个 Bot 命名空间，覆盖已经导航离开的页面。命名空间撤权版本在访问磁盘前更新，覆盖 owner、Bot 或具体绑定；旧 storage 实例不能再读取或补写状态。存储拒绝枚举或删除时，新实例仍禁止读取旧值；之后新授权实例成功写入的键才可供其它新实例读取。无法访问的浏览器存储和页面重载后的物理删除不属于可证明结果。

共享显示偏好增加按绑定移除：旧句柄失效并通知订阅者，磁盘删除失败仍保留页面 tombstone；后续新的授权句柄从默认模式开始且允许重新选择。未涉及的 Task/Test 偏好保持既有行为。

`blockBot` 关闭目标 pane，但按正常淘汰规则保存轻量恢复状态；`unblockBot` 仅在删除协调器确认可以恢复时解除。`identityScope` 共享 blocked/revoked 标记和 guard revision，活跃缓存同步处理，关闭的实例解除订阅。Host 同时订阅 pane 与 guard revision，解除临时阻止后重新选择目标。`invalidateBot(botId, sessionId?)` 还按已知 Session 清理显示偏好，以及同账号通过旧 Test URL 保存的独立草稿和回执。独立键以账号及完整 Session ID 为边界，不清理普通 Task 草稿或其他 Session；旧页面已经关闭、无法继续观察权限时也须完成此项清理。

独立 Session 页面在创建客户端前读取同账号删除协调器恢复的 Session 准入状态；客户端的实时准入检查和协调器订阅共同撤下已打开的历史、停止读取及操作。提交中或未知只关闭客户端，保留轻量输入；权威删除或拒绝访问永久失效。明确拒绝且权威 active 允许重新创建客户端并恢复草稿。该屏障按已知 Session 身份工作，其他独立 Session 和普通 Task 保持原准入。

独立 API 仅把已认证 current 读取的 409/resource_conflict 转为 `IndependentSessionReadDenied`，保留真实 HTTP 状态和错误码；它不解释一般 command/resource 冲突。共享 client 对该访问失效清空状态、草稿、回执和 Session 显示偏好。独立 current 没有调用方可变版本/fence，服务端删除屏障使用该拒绝。共享观察器每三秒复核独立 live/归档入口，归档已载入时只复核权限，不重复下载正文；本地已知的删除屏障不等待轮询结果。暂停、close 与 invalidate 沿原生命周期停止或延迟观察；普通 Task 的冲突语义保持不变。

## 持久显示快照与真实历史

`display-snapshot-coordinator.ts` 为已认证 `TaskCacheScope` 共享一个
`BotDisplaySnapshotStore`。页面读取、pane 观察器和冷目标删除使用同一协调器；
账号清理入口还覆盖当前没有挂载助手页面的账号。协调器先同步撤销读取、观察
和待写候选资格，再调用 store 的 `clearTarget` 或 `clearAccount`。物理清理失败
保留撤销状态并记录诊断，不能作为已从磁盘删除的证据。临时删除 block 同步撤销
目标当前及在途观察，包括已经关闭 observer 的排队保存，但保留最后成功快照；
只有权威 active 详情允许恢复。权威拒绝或删除清目标记录。

选择目标时读取可更新 LRU；存储通知触发的被动重读使用 `touch: false`，不能
再次写磁盘并形成跨标签反馈。旧清理失败的重试只处理失败时的磁盘值，不重新
撤销后续同账号 scope 的资格或重复清理其当前草稿；磁盘已有新值时不覆盖新记录。
重试仅写入旧磁盘值对应的空 tombstone，不替换同一 localStorage realm 中新 scope
的内存历史、不改变其观察 lease。跨标签真实清理、淘汰或撤销改变 store 的撤销
token，协调层据此推进账号级撤销代次，覆盖尚未得到缓存记录的首次读取和观察，
不能只撤销已经显示的目标。普通保存和 LRU 更新只触发被动重读，不撤销合法历史来源。
真实撤销通知同步清空旧内存记录，并将当前撤销 token 标记为待磁盘校验，
仅保留通知中已校验的 generation 和目标 historyVersion 元数据。
后续读取用该 token 校验最新磁盘值，不为同一次通知重复撤销；锁失败降级也不能
重新暴露旧内存记录。新历史观察捕获排队前已知版本，lease 仍须通过锁内的当前
版本比较；通知已被后续清理或历史替换覆盖时，不能为旧来源取得新版本的 lease。

`SessionViewState.historyLoaded` 表示当前 fence/historyEpoch 下实际应用过合法
历史页或校验归档；它与负责在线分页的 `historyReady` 分开。`historySettled`
还要求替换和 hydration 已结束且没有待恢复缺口。普通同历史刷新保留已读事实，
身份或 epoch 替换、close 和 invalidate 清除；current 和连接本身不构成历史证据。
`historyCoverage` 记录真实应用页的首条序列、覆盖水位、完整前边界和事件水位，
供视图撤下已覆盖预览，不由保存时间或空数组猜测完整性。
连续覆盖上下边界仅由合法历史页扩张；单条 `timeline_upsert` 通过 entryId
确认其自身行并推进事件水位，不能把它与已读页之间尚未读取的范围认作已覆盖。
每次 tail 刷新建立自己的游标链覆盖范围，before 分页仅扩张该链；不连续的新旧
tail 不能通过最小首序列和最大末序列合并。此前真实行仍按 entryId 保留。

`BotHistorySnapshotObserver` 仅观察真实 client。确认完整绑定、scope、历史与
可信名称后取得 store-owned lease，再合并约两秒的变化；候选保持原 lease，
隐藏、pagehide 和关闭尽力 flush。异步 lease 返回后重新验证当前历史与撤销代次。
store 在锁内通过 lease 与历史进度检查后，将规范化候选与当前记录比较；仅
`savedAt` 不同不写入、不改变 LRU，也不发布变更。名称、阅读锚点和历史内容
变化仍会保存；内存降级的相同记录仍报告内存结果。
预览行不进入 client state 或保存输入；替换半成品、空壳和无法保留一条完整 entry
的超大记录不能覆盖最后成功快照。预算与 UTF-16 单位裁剪继续由既有 codec/store
拥有；pagehide 写入不保证完成，无 Web Locks 或存储失败沿用内存降级。

stale lease 或跨标签失效会冻结该次已接受历史来源，后续本地草稿发布不能为
旧 payload 续租。store 在观察排队前捕获已知代次与目标历史版本，锁内发现变化即拒绝原来源，
不依赖跨标签通知先于锁返回。新合法页或同身份真实历史进度允许重新观察，完整历史身份
替换还须等待旧快照清理完成。覆盖水位与阅读锚点只描述历史，不授予操作资格。
观察代次变化总是先丢弃旧 lease 和候选；新历史来源与撤销同时到达时，也必须
重新取得观察，不能沿用旧 lease 后将新权威来源错误标记为过期。

本地绑定或历史与磁盘预览不匹配，只能证明该本地来源不能使用该预览，不能证明
另一个标签保存的历史已经失效。读取以及首次绑定、首次历史确认中的此类冲突
使用幂等的本地负向屏障：保留对方记录，不发出历史替换通知，并冻结当前来源，
包括尚无名称或尚未取得 lease 的来源。相同冲突不推进代次；本地草稿和被动重读
不能解除冻结，只有新的合法历史 revision 或事件水位进展允许重新观察。
协调器以 client 与来源保留冻结状态，同一 client 重建 observer 不能重获资格；
pane 重开创建的新 client 仍须实际接受合法历史页，current 本身不能保存。
真实已知本地身份转换仍执行原有清理与替换流程。
历史冲突、临时删除 block 与权威无 Session 共用目标级负向来源屏障。
负向屏障同步撤销当前及在途 store-owned observation；`save` 在持锁后检查其撤销标记，
拒绝已经越过协调层检查但仍排队的旧写入。撤销只作用于该 observation，不删除
其他标签记录，也不撤销其他 Bot 的观察资格。observer 关闭时立即停止普通观察，
但为已排队的保存保留负向撤销订阅，最后一笔保存结束后解除订阅。

读取须等待实际账号确认，并在返回时重新校验账号、目标、选择和撤销代次。
账户变化等待刷新暂停新读取和保存；仅同账号、目标和撤销代次下已经前台显示的
预览继续可读，隐藏或切换后不能在暂停期间重新恢复。
`lastKnownBinding` 只校验历史数据，不能创建 client 或授予新操作资格。无绑定
时 `SessionView` 接受 null client，保持同一外壳、Timeline 和输入占位；绑定由
真实详情提供后接入实际 client，不以伪造 snapshot 复用能力或操作账本。
详情尚未确认与权威确认 `sessionId: null` 是不同状态。后者同步撤下目标旧 pane、
显示种子和恢复记录，并清理持久历史；scope 保留可恢复的无 Session 事实，认证
暂停、迟到读取、旧 observer 或重新选择目标均不能撤销该事实。普通缓存 binding
和历史回调不能恢复资格，只有新的权威详情通过 `confirmSession` 确认真实绑定
后，才允许新 client 接受历史并保存；该状态不把 Bot 永久标记为已删除。

共享 `SessionHistoryPreview` 仅包含 fence、epoch、事件水位、entries、资源描述符和可选
阅读锚点。Timeline 在同一滚动区使用相同 entryId 行 key，真实 reducer 的行优先；
实际页覆盖的范围撤下旧预览，未覆盖范围继续明确标记。完整历史或权威空历史
撤下剩余预览，身份变化拒绝跨历史拼接。预览资源显式使用 `resourceAccess: none`，
不请求资源、不生成下载入口；历史交互只读，不恢复旧审批。
本次准入的有界显示种子独立于后续持久记录。同账号、目标、撤销代次和完整历史
身份下，普通保存或 LRU 通知不能用更短记录替换它。真实页覆盖及真实 entryId
接管会永久缩减种子，后续游标链覆盖范围重建也不能使已撤下的旧行再次出现。
种子只减不增，不进入 reducer 或保存输入；真实撤销和身份变化仍立即撤下它。

`SessionPresentationSlots` 的可选 `renderPending` / `renderUnavailable` 接受
`binding`、`snapshot`、`history` 阶段、是否存在可读内容及现有重试回调。
插槽只负责显示，错误、请求、身份和权限仍由原 owner 管理。正常复核保留正文、
草稿和阅读状态；无内容时显示稳定占位，有内容的失败局部显示，不能制造欢迎语
或缓存活动状态。省略预览及新插槽的 Task/Test 调用方保持原默认行为。

详情错误重试归详情 owner，已绑定 Session 的刷新与历史恢复归真实 client，
不能用详情回调覆盖其固定失败恢复。撤权或删除撤下私有正文和操作后，窄屏仍
保留中性标题与返回助手列表入口，避免列表隐藏时失去产品内导航。

数据所有者及取舍见[持久历史决策](../../.agents/notes/implemented/architecture/2026-11-09-bot-persistent-history-preview.md)。

## 书签与分页

`SessionView` 将可选 `reading` 透传给 `SessionTimeline`；未提供时保持原调用方式。pane 的 scope 是完整 Bot 绑定，Timeline 再加实际 Session fence，并独立校验 historyEpoch。

重挂取得真实 reading handle 后立即接纳保留书签；handle 自行校验 identity 和 historyEpoch，不要求 pane 可见或尾页已加载。缺页、隐藏和零高度只延后定位，不能留下可被淘汰捕获覆盖的初始跟尾状态。reading handle 在一次挂载内稳定，方法代理最新滚动状态；普通渲染、显隐和布局变化不构成新实例。实时 Timeline 因归档加载卸载时，容器保留原 handle 的恢复状态，只有仍为 `pending` 的目标才交给归档的新 handle；隐藏 pane 也立即交接，新 handle 仍验证完整 identity 和 historyEpoch。`idle`、`restored`、`rejected` 不重放，尤其不会把真实 Latest 取消当成待转交目标。仅 active 且历史就绪、`pending` 目标尚不在原始 entries 中时，复用 `client.loadOlder()`；该客户端负责 cursor 校验、取消、去重、失败传播及实际页面进度。Host 以浏览器 `connectionGeneration`、Controller `connectionEpoch` 和 `historyRevision` 防止无进度循环，且仅在 snapshot 已同步、连接就绪、执行活跃时记录分页尝试；若认证准入在视图更新前拒绝请求，则释放本次尝试标记。浏览器重连和同一 channel 内的 Controller 连接替换取消旧请求后，都能在实际可分页时继续定位。局部重试沿用 Timeline 原有入口，失败不丢书签。`restored`、`rejected` 或用户选择 Latest 后的 `idle` 都停止恢复，不因下一次回执、模式变化或布局重放旧位置。

锚点已加载但因显示过滤隐藏时，定位由共享 hook 决定；历史边界确认前不会把缺页当作条目已删除。已校验且完整加载的归档确认历史边界，但不开放在线分页；归档确实缺失的目标沿用前邻、后邻或第一可见行降级。没有可见行或 pane 不可见时可继续保留 pending。新 generation/historyEpoch 拒绝旧书签，正常布局变化保留文字锚点。

## 验证责任

Web 单元与 DOM 测试验证 API 身份、LRU、轻量存储、草稿/回执恢复、迟到响应、当前与可见性分离以及认证生命周期。共享插槽与助手呈现回归还核对默认 Task/Test 调用、真实空态与过滤空页、建议不发送、IME、独立 Steer/Interrupt、设置 pending、unknown 原操作查询和只读无写入。真实浏览器用共享组件测量文字锚点、DOM 对象身份、分页失败与重连、资源释放和窄屏布局。选择字段回归还须测量宽桌面下 700px/560px Bot 容器、普通 Task 及粗指针尺寸，保留旧 `bot-reading` 查询与后台检查时的字段节点、草稿和确认值；可信点击打开系统原生菜单后验证首次 Escape 只取消菜单，再验证正常关闭与回焦点。`selectOption` 只证明值变更，不能证明原生菜单取消。测试用 API、连接和 Provider 受控时，结果只证明浏览器消费行为，不证明原生托管或完整助手运行。

呈现组合与样式隔离的取舍见[呈现决策](../../.agents/notes/implemented/architecture/2026-11-05-assistant-session-presentation.md)，实测对齐见[阅读列决策](../../.agents/notes/implemented/bug-fix/2026-11-06-session-reading-column.md)。绑定缓存的历史取舍见[缓存决策](../../.agents/notes/archived/architecture/2026-11-04-bot-session-cache.md)。
