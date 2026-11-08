# 助手 Session 呈现、绑定与页面缓存

[需求](../spec/bot-session-view.md)定义助手阅读、输入、稳定切换及清理结果；[共享 Session 设计](task-session-protocol.md)拥有 renderer、reducer、操作回执与阅读 hook。[管理页设计](bot-management-web.md)拥有列表、创建、统一标题的页面组合及详情布局。助手呈现通过可选插槽消费共享控件，不建立第二套聊天状态或 Provider 操作。

## 呈现接口与责任

[`session-presentation-slots.ts`](../../packages/daynight-web/src/features/task-agent-session/session-presentation-slots.ts)定义 `SessionPresentationSlots`，由 `SessionView.presentation` 接收。全部 render 回调返回 `ReactNode`，字段为 readonly。

| 类型或入口 | 内容与责任 |
| --- | --- |
| `SessionPresentationVariant` / `variant` | `default` 或 `assistant`；后者增加显式样式标记，不改变身份、能力或操作。 |
| `SessionHeaderSlot` / `renderHeader` | 当前状态及共享标题节点；在共享 header 内组合，不替换 section/header。 |
| `SessionEmptySlot` / `renderEmpty` | `draft` 和只更新草稿的 `setDraftAndFocus(text)`；仅在共享视图确认初次空对话时调用。 |
| `SessionComposerPresentation` / `composer` | 可选 `compactMenus`、`renderAttachments` 和 `renderFooter`，透传给共享 Composer；也可作为 `SessionComposer.presentation` 使用。 |
| `SessionComposerAttachmentSlot` | `text`、`setText`、同一 textarea 的 `inputRef`，以及 `snapshot`、`active`、`connected`、`authPaused`。提供布局和现有草稿入口，不授予上传或原生输入能力。 |
| `SessionComposerFooterSlot` | `settings`、`activity`、`submit` 三个实际节点；自定义 footer 的 `activity` 仍包含独立 Interrupt。 |

`SessionView` 继续持有客户端订阅、显示偏好、状态描述 ID、全屏 hook、恢复诊断、错误、历史、操作回执和 Composer。`SessionComposer` 继续持有 form、textarea、菜单、IME/命令键盘处理及原生控制。宿主组合节点，不能复制 handler、重写准入、按 Provider 名称推断能力，或用 CSS 隐藏唯一错误、审批或操作。

普通 `TaskAgentSession` 和 `TestSessionPage` 不传 `presentation`，使用共享默认标题、footer 与菜单路径，不匹配 Bot 样式选择器。没有 `renderEmpty` 时也不增加欢迎层容器。助手转入只读归档仍可保留样式，但生命周期不为 active 时不渲染 Composer；归档尚未就绪显示真实读取状态，就绪后复用 Timeline，只读交互不会获得响应能力。

## Bot 标题与稳定 DOM

`BotsPage` 提供 `renderHeader`，由 `BotConversationHeader` 消费；`BotSessionHost` 合并调用方配置，固定 `variant: 'assistant'`、`renderEmpty: BotConversationEmpty` 和 `composer.compactMenus: true`，保留调用方其他 Composer 插槽。当前 Bot 未自定义 `renderFooter` 或 `renderAttachments`。

`renderHeader` 在没有 snapshot 或 unavailable 时仍被调用，返回共享 `<header className="session-header">` 的内部内容。状态字段包括 `snapshot`、`startupReport`、`active`、`current`、`available`、`readOnly`、`runtimeReady`、`authPaused`、`status`、`fullscreen`、`displayMode` 和 `statusDescriptionId`。不可用时 snapshot/report 为 null；report 只来自已匹配的执行报告。`runtimeReady` 表示 Session 运行可用性，不能替代发送、审批、设置和取消各自的准入条件，也不能由 Bot 启动成功推导。

宿主在名称旁呈现共享 `provider` 和 `activity`，操作区使用共享 `display`、`focus`，`refresh` 放在更多 popover 内。每个共享节点只挂载一份；popover 的显隐不复制刷新控制。无 snapshot 时保留通用标题和仍可用的控制。返回列表、详情与关闭选择由 Bot 宿主管理，关闭只退出阅读选择，不删除或停止 Bot。

共享 section 的 ref、tabIndex、键盘处理和 `.task-agent-session` 祖先保持不变；`focus` 保留全屏按钮 ref，`activity` 保留 role、原生标签语言和状态 ID，textarea 的 `aria-describedby` 继续指向该 ID。详情触发 ref 由宿主拥有，浮层留在同一 `fullscreenBoundary` 中，Escape 按最上层关闭和焦点恢复规则处理。

每个已挂载 pane 固定插槽结构。连接、详情、空态或专注模式变化不改变 Timeline 祖先、key、reading handle 或客户端。回调对象可重建，但不能用条件增删 `renderEmpty` 配置来切换结构；附件区可出现或消失，共享 textarea 仍是 `.session-composer-surface` 的直接子节点，保留同一 ref、事件和身份。

## 阅读样式与空对话

[`bot-session.css`](../../packages/daynight-web/src/features/bots/bot-session.css)将共享内容覆盖限定在 `.bot-session-pane .session-presentation-assistant`；欢迎组件使用独立 `bot-conversation-*` 类。阅读列和输入内容上限为 760px。正文 16px、行高 1.8，用户气泡按内容收缩、靠右且不超过列宽的 85%，助手正文直接使用共享安全 Markdown。`bot-reading` 实际容器宽度不超过 600px 时，正文为 15px、阅读区左右留白 18px。代码、表格沿用共享局部滚动，普通工具输出保持原文，长链接、资源名称及错误在列内换行；任务链接不产生额外业务查询。

输入对齐使用共享 `useSessionColumnLayout`，测量 Timeline 内容相对 Composer 内边框的左右距离，写入 `--session-column-left/right`，包括真实滚动条占位。ResizeObserver 在下一帧更新；隐藏 pane 的零宽测量被忽略，恢复可见后继续测量。单独设置相同 max-width 不足以保证对齐。Bot 阅读区使用零 flex basis 为输入和菜单让出高度；高度与横向测量均不改变阅读身份或触发另一个分页机制。

空态由共享 View 同时检查：可用且 ready、active/current、运行可用、非只读、历史已确认、没有更早历史、分页加载或历史错误、没有会话错误或恢复缺口、原始 entries 为空且 Agent idle。Conversation 过滤后为空不满足初次空对话条件。无助手、未绑定、加载、历史失败与归档保留各自状态，不显示可填写的欢迎建议。

`BotConversationEmpty` 提供本地化欢迎语和三项文本建议，按钮仅调用 `setDraftAndFocus`。回调执行前再次核对挂载、active/current、账号、当前 input、最新 ready 状态、原 execution fence 与 active lifecycle；失效回调直接返回。它只更新当前草稿并聚焦，不发送、不启动执行、不修改设置。普通身份后台核验保留已确认且仍可展示的空态及本地草稿编辑，写入仍受 authPaused 限制；真正断线或权威失效按实际状态撤下空态。

配置 `renderEmpty` 后，Timeline 与欢迎内容位于同一稳定 shell；欢迎内容在独立可滚动层呈现，不替换 Timeline。返回 null、undefined 或 false 时保留共享默认空提示；返回内容时只抑制其默认空提示，不遮盖历史错误、审批或恢复诊断。显示模式、虚拟化、回到最新及文字锚点继续由共享 Timeline 拥有。

## 输入、回执与附件扩展

Bot 在会话底部使用共享 Composer，输入与阅读各自占用可收缩空间。textarea 随文本增长至局部上限后内部滚动；≤600px 容器的关键输入按钮至少 44px，≤500px 窗口高度缩减输入留白与 textarea 高度。聚焦表面采用紫色边框，reduced-motion 关闭颜色过渡。

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

`compactMenus` 缺省为关闭。Bot 显式启用后，仅 active pane 且 `visualViewport.height`（缺省用 innerHeight）≤500px 时使用短屏路径：共享菜单在 textarea 上方限高，命令标题、刷新、关闭与候选在同一容器滚动，设置面板整体滚动，菜单不占普通流高度预算。它保留原 DOM、输入及底部动作。键盘或辅助技术打开 Model/Permissions 时聚焦首个可用控件；指针打开沿原焦点路径。Escape/显式关闭返回 textarea，焦点移向被覆盖的其他内容时关闭菜单并保留新目标；命令菜单允许 textarea 保持焦点以输入与选择。宽高切换和隐藏 pane 清理布局监听、滚动锚点与样式，不重建客户端。

`renderAttachments` 是正常流、可收缩的布局槽，`setText` 使用原草稿和命令意图失效逻辑。共享高度预算优先保留 textarea、footer 与错误所需空间，不把完整附件高度设为硬性下限；大预览应有局部上限，极端视口中附件区可能缩至零，不能承诺所有附件操作同时可见。宿主不得包裹或替换 textarea，也不得强制附件容器不可收缩。

当前 Bot Composer 仍发送文本，未挂接上传控件或图片输入协议。既有 `SessionResourceView` 可以读取获准图片资源，校验字节长度和 SHA-256 后显示或下载，并在卸载时取消读取和撤销 Blob URL；图片资源阅读不等于支持上传图片作为模型输入。图片输入、持久草稿、预览和归档扩展分别由[图片输入规格](../spec/session-image-input.md)、[图片历史规格](../spec/session-image-history.md)及[图片设计](session-image-contracts.md)拥有。后续接入必须使用真实能力、身份与资源协议，并重新验证高度和控制组宽度，未接入时不显示假上传按钮。

## 绑定和消费接口

`api/sessions.ts` 导出 `BotSessionBinding` 和 `createBotSessionApi(binding, onPrincipalMismatch)`。factory 复用独立 Session 的 `/api/v1/test-sessions/{sessionId}` API，额外核对真实 `testExecutionId`。`TaskSessionClient` 的独立分支接受 `bot`，在 HTTP current 与 channel snapshot 上重新验证账号、Session、执行及 Web 模式；草稿范围包含 Bot 身份。既有 fence 继续约束请求结果，旧代请求的迟到权限错误不能撤销新代客户端。

页面在已认证的 `TaskCacheProvider` 内调用一次 `useBotSessionCache()`，把返回值与已验证的 `binding` 传给 `BotSessionHost`。选中项尚未取得绑定时传 `null`，不沿用旧绑定。缓存 hook 应放在选中项与详情面板之上，不能以选中 Bot 或详情开关作为 key。关闭页面内容时可传 `active=false`；删除或权威拒绝访问调用 `cache.invalidateBot(botId)`。同一账号 scope 内被撤销的 Bot 不接受陈旧选择，页面重挂不撤销该标记；重新授权须在新的有效身份范围建立缓存。

`BotSessionHost` 始终渲染同一个 shell，pane 以完整绑定的 JSON key 区分。当前选择直接控制 `hidden`、`inert` 和 `active`，布局 effect 才创建新客户端。`isCurrent` 由账号范围、撤权状态和 pane 的实际客户端身份决定，不依赖当前可见项。非当前 pane 可同步消息；共享 View 的发送和交互控件还要求 `active`，不会将可见性变化当成身份撤销。普通后台检查不改变当前已确认绑定或 Host 的展示 active；client 的 `authPaused` 暂停发送和结果发布，保留原 pane、Timeline 和本地交互状态。可复用的 channel 在暂停期间保留，现有 60 秒和消息缓冲边界或真实传输中断会触发必要的断开与恢复；重连等待当前准入，并沿用 cursor 重放和代际拒绝。详情布局与模式使用共享组件，未复制聊天 renderer 或 reducer。

## 有界资源与轻量保留

`BotSessionCache` 按最近选择序号管理最多三个 pane。新增 pane 前先从旧集合淘汰最久未选择项，因此新当前项不会被淘汰。淘汰先从 reading ref 捕获书签，再从集合移除、关闭 client；取消后的迟到响应不能发布。React 移除对应子树，资源组件负责撤销 Blob URL。

每个绑定仅额外保留 `BotSessionStorage` 与可空书签。storage 包装现有客户端的草稿和 operation 序列化协议，使用完整 Bot 绑定命名空间；先写内存再尝试磁盘。读取后以内存值为准，删除失败保留 tombstone，避免旧值回流。它不保存 Timeline、资源或发送命令正文，回执沿用现有最多 200 项的未决集合限制。已认证新 fence 清理旧代草稿与回执；恢复未决操作仍调用原 operation 查询。

淘汰调用 `close`，不触发 `onInvalidate`。真正撤权使用幂等 `invalidate` 回调清除该 Bot 的挂载与冷状态、存储和显示偏好。`invalidateBot` 按 owner/Bot 命名空间清理，即使当前缓存从未选择过该 Bot，也覆盖此前导航留下的存储；页面内保留 owner/Bot/Session 关系供显示偏好清理。scope 的 abort 清除该账号的全部缓存。认证组件的退出、账号切换和已证实 principal 变化还调用 owner 级清理，枚举整个 Bot 命名空间，覆盖已经导航离开的页面。命名空间撤权版本在访问磁盘前更新，覆盖 owner、Bot 或具体绑定；旧 storage 实例不能再读取或补写状态。存储拒绝枚举或删除时，新实例仍禁止读取旧值；之后新授权实例成功写入的键才可供其它新实例读取。无法访问的浏览器存储和页面重载后的物理删除不属于可证明结果。

共享显示偏好增加按绑定移除：旧句柄失效并通知订阅者，磁盘删除失败仍保留页面 tombstone；后续新的授权句柄从默认模式开始且允许重新选择。未涉及的 Task/Test 偏好保持既有行为。

`blockBot` 关闭目标 pane，但按正常淘汰规则保存轻量恢复状态；`unblockBot` 仅在删除协调器确认可以恢复时解除。`identityScope` 共享 blocked/revoked 标记和 guard revision，活跃缓存同步处理，关闭的实例解除订阅。Host 同时订阅 pane 与 guard revision，解除临时阻止后重新选择目标。`invalidateBot(botId, sessionId?)` 还按已知 Session 清理显示偏好，以及同账号通过旧 Test URL 保存的独立草稿和回执。独立键以账号及完整 Session ID 为边界，不清理普通 Task 草稿或其他 Session；旧页面已经关闭、无法继续观察权限时也须完成此项清理。

独立 Session 页面在创建客户端前读取同账号删除协调器恢复的 Session 准入状态；客户端的实时准入检查和协调器订阅共同撤下已打开的历史、停止读取及操作。提交中或未知只关闭客户端，保留轻量输入；权威删除或拒绝访问永久失效。明确拒绝且权威 active 允许重新创建客户端并恢复草稿。该屏障按已知 Session 身份工作，其他独立 Session 和普通 Task 保持原准入。

独立 API 仅把已认证 current 读取的 409/resource_conflict 转为 `IndependentSessionReadDenied`，保留真实 HTTP 状态和错误码；它不解释一般 command/resource 冲突。共享 client 对该访问失效清空状态、草稿、回执和 Session 显示偏好。独立 current 没有调用方可变版本/fence，服务端删除屏障使用该拒绝。共享观察器每三秒复核独立 live/归档入口，归档已载入时只复核权限，不重复下载正文；本地已知的删除屏障不等待轮询结果。暂停、close 与 invalidate 沿原生命周期停止或延迟观察；普通 Task 的冲突语义保持不变。

## 书签与分页

`SessionView` 将可选 `reading` 透传给 `SessionTimeline`；未提供时保持原调用方式。pane 的 scope 是完整 Bot 绑定，Timeline 再加实际 Session fence，并独立校验 historyEpoch。

重挂取得真实 reading handle 后立即接纳保留书签；handle 自行校验 identity 和 historyEpoch，不要求 pane 可见或尾页已加载。缺页、隐藏和零高度只延后定位，不能留下可被淘汰捕获覆盖的初始跟尾状态。reading handle 在一次挂载内稳定，方法代理最新滚动状态；普通渲染、显隐和布局变化不构成新实例。实时 Timeline 因归档加载卸载时，容器保留原 handle 的恢复状态，只有仍为 `pending` 的目标才交给归档的新 handle；隐藏 pane 也立即交接，新 handle 仍验证完整 identity 和 historyEpoch。`idle`、`restored`、`rejected` 不重放，尤其不会把真实 Latest 取消当成待转交目标。仅 active 且历史就绪、`pending` 目标尚不在原始 entries 中时，复用 `client.loadOlder()`；该客户端负责 cursor 校验、取消、去重、失败传播及实际页面进度。Host 以浏览器 `connectionGeneration`、Controller `connectionEpoch` 和 `historyRevision` 防止无进度循环，且仅在 snapshot 已同步、连接就绪、执行活跃时记录分页尝试；若认证准入在视图更新前拒绝请求，则释放本次尝试标记。浏览器重连和同一 channel 内的 Controller 连接替换取消旧请求后，都能在实际可分页时继续定位。局部重试沿用 Timeline 原有入口，失败不丢书签。`restored`、`rejected` 或用户选择 Latest 后的 `idle` 都停止恢复，不因下一次回执、模式变化或布局重放旧位置。

锚点已加载但因显示过滤隐藏时，定位由共享 hook 决定；历史边界确认前不会把缺页当作条目已删除。已校验且完整加载的归档确认历史边界，但不开放在线分页；归档确实缺失的目标沿用前邻、后邻或第一可见行降级。没有可见行或 pane 不可见时可继续保留 pending。新 generation/historyEpoch 拒绝旧书签，正常布局变化保留文字锚点。

## 验证责任

Web 单元与 DOM 测试验证 API 身份、LRU、轻量存储、草稿/回执恢复、迟到响应、当前与可见性分离以及认证生命周期。共享插槽与助手呈现回归还核对默认 Task/Test 调用、真实空态与过滤空页、建议不发送、IME、独立 Steer/Interrupt、设置 pending、unknown 原操作查询和只读无写入。真实浏览器用共享组件测量文字锚点、DOM 对象身份、分页失败与重连、资源释放和窄屏布局。测试用 API、连接和 Provider 受控时，结果只证明浏览器消费行为，不证明原生托管或完整助手运行。

呈现组合与样式隔离的取舍见[呈现决策](../../.agents/notes/implemented/architecture/2026-11-05-assistant-session-presentation.md)，实测对齐见[阅读列决策](../../.agents/notes/implemented/bug-fix/2026-11-06-session-reading-column.md)。绑定缓存的历史取舍见[缓存决策](../../.agents/notes/archived/architecture/2026-11-04-bot-session-cache.md)。
