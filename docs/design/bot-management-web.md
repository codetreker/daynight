# 助手管理页面

[需求](../spec/bot-management-web.md)拥有可观察行为；[共享会话设计](bot-session-view.md)拥有 Bot Session 绑定和缓存。页面以阅读和输入为主，列表、创建及详情围绕同一会话宿主组合。[呈现决策](../../.agents/notes/implemented/architecture/2026-11-05-assistant-management-presentation.md)记录布局选择和替代成本；[管理页面决策](../../.agents/notes/implemented/architecture/2026-11-05-bot-management-web.md)保留读取与创建身份的理由。

## 工作区与列表

`AuthenticatedApp` 为 `/bots` 与 `/bots/{id}` 使用同一 `BotsPage` 组件位置，并添加助手专用外壳样式。`assistant-workspace.css` 取消该路由 `.content` 的最大宽度、居中 margin 和 padding；全局导航仍使用已有展开偏好、Team、账号入口和路由。页面复用 Session 外壳的动态视口高度约束，不另建导航或会话路由。

`bots.css` 将 `.bots-page` 定义为命名 `bots-workspace` inline-size 容器。列表固定 256px（含边框），与对话之间没有额外 gap；工作区内容宽度低于 676px 时，只显示列表或当前选中的对话，等于 676px 时仍并列并为对话保留 420px。判断依据是扣除导航后的实际容器宽度。CSS 只改变既有面板可见性，不创建宽度状态、Session 宿主或新的目标绑定。单栏返回及关闭聊天都导航到 `/bots`，不停止或删除助手。

工作区、对话列、SessionHost 和 pane 的 flex 高度链允许收缩。列表面板承载创建与搜索，长列表在自己的区域滚动；短视口中面板也可滚动以到达创建操作。消息时间线继续拥有自己的滚动面，历史分页与阅读书签使用同一可见区域，输入不会因历史增长被推出页面。详情的滚动区与时间线独立。

列表标题与创建按钮同行，名称搜索下是列表小标题、数量和刷新按钮。刷新用 busy/disabled 表达状态，读取失败保留实际错误。列表沿用服务返回顺序，行内只保留头像标记、名称及必要的启动或 Worker 异常状态；主机、路径和完整信息在详情中读取。零助手与搜索无匹配分别显示。行上的更多、右键和键盘菜单仍固定其自身 Bot 为删除目标。

## API 与准入

`api/bots.ts` 消费服务端 `/api/v1/me/bots` 的 list、defaults、create、get、delete。读取要求响应 principal 与当前账号一致；定义再次核对 owner、Worker 配置和 Session 双身份。删除响应是仅含身份及删除责任的联合类型。版本与创建顺序保持十进制字符串，不经浮点数转换。

创建只发送 `{id,name,overrides?}`。默认值选择、Provider 的 model/args 解析以及成功偏好保存均由服务端拥有。响应解析保留真实 pending/ready/failed；已 dispatch 的传输、解析或非明确拒绝错误转换为 `BotCreationUnknown`。接口不自动重试写入。

## 内联创建与未确认请求

`BotCreateForm` 在列表标题下渲染普通 `form`，高级配置使用默认折叠的原生 `details`。表单不进入模态层，不使工作区 inert，也不取得 body scroll lock。打开时聚焦名称；已有未确认请求时聚焦核对按钮。显式取消或 Escape 关闭当前创建层并恢复仍连接的原入口；输入法组合期间不消费 Escape，提交期间禁用取消与重复提交。导航卸载表单不将焦点拉回列表。

表单以独立字段记录显式 Worker、目录和 Provider；显示默认值不改变这些记录。Worker 切换立即作废旧请求代际、取消旧读取并清除目录及 Provider 覆盖，再读取 defaults。只填名称时 POST 不含 overrides；明确失败保留输入和错误。取消与完成均不写浏览器偏好。`creating` 绑定账号 scope 与打开时的选择，目标导航使表单收起，迟到的完成回调不能把新选择导航回旧创建结果；同 scope、同选择下的后台检查、语言和布局变化不重建表单。

页面在 dispatch 前将未确认请求交给 `pending-creation.ts`。同一账号 scope 的 WeakMap 跨组件卸载保留内存请求，`sessionStorage` 仅保存 Bot ID，不保存可重放的 POST 正文。收起后重新打开、返回页面或重载后的表单只能按该 ID GET；确认结果后清除记录，404 和读取失败仍保留。scope abort 清除对应记录和可访问的存储。无法访问存储时保留同文档内存并显示 ID，不能承诺跨重载恢复。呈现方式改变不把结果未知转换为可重新 POST 的明确失败。

## 读取与展示

`useBotRead` 为列表、defaults 和选中详情分别管理请求。资源 key 与账号 scope 共同约束结果；每五秒在页面可见且身份准入时刷新，不重叠请求。隐藏、资源变化和 scope abort 取消旧读取，结果发布前再次检查准入。暂停与实际失败分开：普通后台检查保留同 scope、同 key 已确认的值，实际失败保留上次值并标记 stale；切换资源不显示前一个资源的值。首次加载、显式刷新和实际错误各自保留原有语义。

列表遍历到末页后一次发布，检查重复 ID/cursor，搜索在完整快照中进行。defaults 单独读取，因此 Worker 观测失败不会清空助手列表。`ready` 仅显示已启动，当前同步和输入可用性继续由 Session View 解释。服务端 defaults 的 Worker 状态不替代 Session 同步事实。

`BotsPage` 在选中项之上创建一次缓存，`/bots` 与 `/bots/{id}` 使用同一个组件位置。SessionHost 始终挂载；未知绑定传 null，已缓存的 pane 隐藏，只有当前目标同 scope 的已确认详情提供真实绑定。临时准入暂停不会使已确认绑定消失，Host 的 active 表示实际选中和展示；Session client 自行暂停请求、发送及结果发布。关闭聊天只导航回列表。删除或权威拒绝访问调用 `cache.invalidateBot`；普通读取失败撤下输入但不销毁可恢复状态。

路由进入既有身份检查与页面标题流程，保留原生链接修改键行为。全局侧栏提供助手入口，并按助手路由显示选中状态；导航不替换本页身份或会话缓存模型。列表搜索、详情展开与布局尺寸不参与缓存身份。绑定继续由 owner、Bot、Session 和执行 ID 共同确定，隐藏 pane 保持 hidden/inert；删除与失效仍由原协调机制处理。

## 统一标题与状态来源

`BotsPage` 用 `BotConversationTarget` 向标题和详情传递同一次已准入的 Bot 读取、匹配的 Worker 观测、stale 标记、详情展开状态与触发 ref。有绑定时，`BotSessionHost` 将 `variant: 'assistant'` 和 `renderHeader` 透传给原 `SessionView`，`BotConversationHeader` 在共享标题元素内组合当前 Provider、会话活动、显示、专注和刷新控件；无绑定时才渲染页面的后备标题。详情使用独立按钮，更多 popover 容纳共享刷新与关闭聊天链接。显示和专注控件仍由共享 Session 创建和控制，不复制其状态机。

自定义标题只替换标题内容。共享视图继续渲染连接错误、启动与恢复原因、历史、审批、命令回执及输入能力；Bot 的 ready 不证明 Session 已连接或可发送。当前 Session 的连接与活动采用共享状态，未绑定时显示 Bot 启动及 Worker 观测；详情分别呈现 Bot 启动、Worker 可用性和 Session 状态。defaults 读取失败不得延用“可用”判断，临时身份核对则保留已确认展示并暂停业务准入。

`.bot-conversation` 是标题的 inline-size 查询容器。名称默认 17px 单行省略，完整名称从详情读取。可用宽度不超过 600px 时，名称为 15px，返回、名称和操作形成三列，状态独占下一行，关键按钮为 44px；不超过 300px 时再允许操作换行。名称区域可收缩，控件保留自身空间，状态原因允许断行。这些规则不参与 Session 或详情模式选择，标题也不依赖主机名撑开宽度。

## 删除协调

`BotListItem` 的原生 popover 菜单负责更多、右键和键盘入口，确认目标与原按钮一起交给 `BotDeleteDialog`。确认框使用原生模态层、滚动锁和焦点恢复；打开只选择目标，确认才调用删除协调器。

`deletion-coordinator.ts` 按账号 scope 复用单个协调器。每个目标保存名称、Session/Worker 身份、原删除请求、最小阶段结果及错误，不保留配置或对话正文。提交前同步 `blockBot` 并保存请求；同一协调器按已知 Session 身份向独立入口提供准入状态。初始 Session 尚未注册时，后续经 owner/Worker 校验的 active 读取补齐其身份，但不能用不同 Session 替换已知绑定。`BotDeletionUnknown` 保留已 dispatch 的不确定性。失败后的 GET 不将一次瞬时 active 观察当成撤销原请求的证明；原请求曾未知时，后续重试被拒绝也不能清除该不确定性。明确拒绝且权威 active 才解除对应 Bot 与独立 Session 的屏障，后续新请求仍需用户确认。

权威删除按精确版本单调接纳，同一删除身份的旧阶段不得覆盖新结果；不同 Worker 响应不能影响目标。两个 cleanup 均 completed 才完成。协调器在接纳删除或权威拒绝访问时，直接按账号和 Bot 清理草稿、回执及对应 Session 显示偏好，再通知已挂载缓存通过 `invalidateBot` 清理内存与阅读状态。浏览器存储清理不依赖页面挂载，因此离开助手页后到达的删除结果仍完成定向清理。即使原响应来自另一删除身份，也不重开对话。请求重试由用户显式触发，先 GET 再沿用权威 deletionId/requestedVersion；自动轮询只读。scope abort 取消准入并清记录，提交结果未知不重放。

WeakMap 保留同 scope 的记录，sessionStorage 保存可校验的最小身份和删除状态供重载恢复；存储失败保留内存。临时身份核对暂停阻止新请求和恢复准入，但不丢弃同一有效 scope 已发出请求的明确响应分类；明确拒绝的证据保留到同账号恢复后再查询权威状态。真正的 scope 失效丢弃响应与记录。`BotsPage` 订阅协调器与缓存的 guard revision，以本地删除状态过滤列表和详情，因此删除前发出的迟到读取不能绕过屏障。旧页面卸载只解绑缓存，原在途请求仍归账号 scope；新页面重新绑定时先恢复对应屏障。状态区展示实际清理阶段，完整页面刷新不是删除完成依据。

取舍见[浏览器删除决策](../../.agents/notes/implemented/architecture/2026-11-05-bot-browser-deletion.md)。

## 详情、焦点与全屏边界

`BotsPage` 拥有局部 `detailsOpen` 和当前详情按钮 ref；它们不参与 Session cache、pane key 或 client 的依赖。面板在 `.bot-conversation-body` 中与 `.bot-conversation-content` 并列，接收当前 Bot、相同 workerId 的 defaults 观测及 stale 标记，不另行读取或保存选中 Bot。切换时 `useBotRead` 的资源 key 隔离立即撤下旧目标值；面板可保留展开意图并显示局部加载，随后与标题及绑定接纳新目标。权威删除、拒绝访问、无选中项或 scope 失效撤下面板；临时准入暂停保留已确认展示。创建及删除确认的展示同样由用户操作、真实资源状态与 scope 生命周期拥有，提交仍检查准入。

详情显示完整名称、Bot 启动阶段、独立 Worker 观测、主机名称或 Worker ID，以及冻结的 cwd 和 Agent；defaults 变化不改写冻结启动配置。Session 信息从现有 cache 中按完整绑定找到 pane，订阅其 client，并再次核对 snapshot 的 owner、Session 和执行 ID。无匹配时显示不可用，不借用上一目标信息。共享状态选择器解释连接、启动与恢复；模型和权限来自 `controls.settings` 的确认值，setting intent 与 operation 另行表达 pending、等待或结果未知，保留设置错误和 next-turn 范围说明。详情不发起第二个 Session client，也不将尚未确认的选择当成已生效。

非模态详情须同时满足 `window.innerWidth >= 1280` 和稳定 `.bot-conversation-body` 内容宽度 `>= 760px`。ResizeObserver 与窗口 resize 读取父容器 clientWidth 并扣除 padding；不测量已经被详情压缩的内容列，也不随开关减去 340px，避免模式振荡。条件满足时，同一 `dialog` 以非模态 open 和 complementary 语义参加 flex，340px 宽度含边框，剩余会话至少 420px；任一不足时通过 `showModal()` 进入 top layer。

首次打开聚焦关闭按钮。跨断点先关闭原模式，再打开新模式；仍有效的面板焦点保持，转为非模态时也可保留已聚焦的会话控件，转为模态则只保留面板内焦点。关闭后回到仍连接、未禁用且不在 hidden/inert 区域的当前详情按钮。抽屉取得计数式 body scroll lock，原生模态隔离背景，本地 Tab 首尾循环且阻止向外层全屏传播。非模态模式允许同时操作会话；对话区域的 Escape 也先关闭展开的详情。

抽屉宽高与偏移跟随 `visualViewport`，缺失时使用窗口尺寸。标题和底部删除入口不收缩，中间内容独立滚动；短视口缩减纵向 padding，长名称、主机、路径和原因允许断行。详情删除入口与列表复用 `BotDeleteDialog` 和原删除协调器，目标固定于打开确认时。存在选中对话时，确认层通过 portal 留在同一全屏边界；确认层先消费 Escape/Tab，`modalBlocked` 暂停底层详情模式切换和键盘关闭，避免一次按键关闭两层或在确认期间重排模态层。

`BotSessionHost` 将可选 `fullscreenBoundary` ref 透传给 `SessionView` 和 `useSessionFullscreen`。助手提供稳定的 `.bot-conversation` 祖先，包含名称、会话内容和详情；hook 校验该边界确实包含原 Session section，并将注册、背景隔离、焦点范围、视口变量及 `data-session-fullscreen` 状态应用于它。原 section 保持挂载且不重复使用固定全屏定位。未提供边界的 Task/Test 调用方仍以原 Session section 为根。

外层边界模式在 document 冒泡阶段处理键盘，晚于 React 内层控件。详情先消费自己的 Escape；窄屏 Tab 在抽屉首尾循环后停止向外传播。这样关闭详情不退出全屏，也不让外层 Tab 处理器选择原生模态之外的控件。外层模式的焦点观察允许详情内部焦点，因为 dialog 是同一边界的后代。退出或卸载恢复本层持有的属性、样式与 inert 所有权，不改写其他模态拥有者。

详情开关通过当前 pane 的 Timeline handle 捕获、恢复文字书签；详情模式切换也在同一 pane/handle 上恢复。全屏边界属性变化触发已有 handle 的书签恢复，防止宽度变化先钳制 scrollTop 后被误当成用户阅读意图。时间线仍拥有锚点与跟随状态，不用原始 scrollTop 重放代替文字书签；Session DOM、client 和草稿不因详情或全屏重新创建。

## 验证边界

管理页规格定义容器临界值、长内容、短视口和焦点矩阵。API 与组件测试验证默认覆盖、未知结果、当前身份、缓存、标题组合和模态协同；浏览器测试才能验证真实几何、原生 dialog、滚动与 DOM 身份。原型只用于设计交互核对，受控 API 或 Session 测试只证明 Web 消费行为，不证明真实 Worker、Provider、偏好持久化或真机软键盘。共享阅读、输入和图片能力的设计由各自所有者说明，不从标题及详情改造推断其已交付。
