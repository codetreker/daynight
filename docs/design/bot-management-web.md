# 助手管理页面

[需求](../spec/bot-management-web.md)拥有可观察行为；[共享会话设计](bot-session-view.md)拥有 Bot Session 绑定和缓存。

## API 与准入

`api/bots.ts` 消费服务端 `/api/v1/me/bots` 的 list、defaults、create、get、delete。读取要求响应 principal 与当前账号一致；定义再次核对 owner、Worker 配置和 Session 双身份。删除响应是仅含身份及删除责任的联合类型。版本与创建顺序保持十进制字符串，不经浮点数转换。

创建只发送 `{id,name,overrides?}`。默认值选择、Provider 的 model/args 解析以及成功偏好保存均由服务端拥有。响应解析保留真实 pending/ready/failed；已 dispatch 的传输、解析或非明确拒绝错误转换为 `BotCreationUnknown`。接口不自动重试写入。

## 创建状态

`BotCreateDialog` 以独立字段记录显式 Worker、目录和 Provider；显示默认值不改变这些记录。Worker 切换立即作废旧请求代际，再读取 defaults；取消与完成均不会写浏览器偏好。原生 `dialog.showModal()`、现有 body scroll lock 与焦点恢复负责模态交互。

页面在 dispatch 前将未确认请求交给 `pending-creation.ts`。同一账号 scope 的 WeakMap 跨组件卸载保留内存请求，`sessionStorage` 仅保存 Bot ID，不保存可重放的 POST 正文。新页面或重载后的弹窗只能按该 ID GET；确认结果后清除记录，404 和读取失败仍保留。scope abort 清除对应记录和可访问的存储。无法访问存储时保留同文档内存，不能承诺跨重载恢复。

## 读取与展示

`useBotRead` 为列表、defaults 和选中详情分别管理请求。资源 key 与账号 scope 共同约束结果；每五秒在页面可见且身份准入时刷新，不重叠请求。隐藏、资源变化和 scope abort 取消旧读取，结果发布前再次检查准入。暂停与实际失败分开：普通后台检查保留同 scope、同 key 已确认的值，实际失败保留上次值并标记 stale；切换资源不显示前一个资源的值。首次加载、显式刷新和实际错误各自保留原有语义。

列表遍历到末页后一次发布，检查重复 ID/cursor，搜索在完整快照中进行。defaults 单独读取，因此 Worker 观测失败不会清空助手列表。`ready` 仅显示已启动，当前同步和输入可用性继续由 Session View 解释。服务端 defaults 的 Worker 状态不替代 Session 同步事实。

`BotsPage` 在选中项之上创建一次缓存，`/bots` 与 `/bots/{id}` 使用同一个组件位置。SessionHost 始终挂载；未知绑定传 null，已缓存的 pane 隐藏，只有当前目标同 scope 的已确认详情提供真实绑定。临时准入暂停不会使已确认绑定消失，Host 的 active 表示实际选中和展示；Session client 自行暂停请求、发送及结果发布。关闭聊天只导航回列表。删除或权威拒绝访问调用 `cache.invalidateBot`；普通读取失败撤下输入但不销毁可恢复状态。

路由进入既有身份检查与页面标题流程，保留原生链接修改键行为。全局侧栏提供助手入口，并按助手路由显示选中状态；导航不替换本页身份或会话缓存模型。

助手路由复用既有 Session 页面按动态视口约束的应用外壳。页面网格、对话列与 SessionHost 的高度链允许收缩；列表和时间线各自滚动，输入框留在可用视口内。时间线的实际滚动面继续由共享 Session View 拥有，确保历史分页触发与缓存阅读位置使用同一滚动坐标。

## 删除协调

`BotListItem` 的原生 popover 菜单负责更多、右键和键盘入口，确认目标与原按钮一起交给 `BotDeleteDialog`。确认框使用原生模态层、滚动锁和焦点恢复；打开只选择目标，确认才调用删除协调器。

`deletion-coordinator.ts` 按账号 scope 复用单个协调器。每个目标保存名称、Session/Worker 身份、原删除请求、最小阶段结果及错误，不保留配置或对话正文。提交前同步 `blockBot` 并保存请求；同一协调器按已知 Session 身份向独立入口提供准入状态。初始 Session 尚未注册时，后续经 owner/Worker 校验的 active 读取补齐其身份，但不能用不同 Session 替换已知绑定。`BotDeletionUnknown` 保留已 dispatch 的不确定性。失败后的 GET 不将一次瞬时 active 观察当成撤销原请求的证明；原请求曾未知时，后续重试被拒绝也不能清除该不确定性。明确拒绝且权威 active 才解除对应 Bot 与独立 Session 的屏障，后续新请求仍需用户确认。

权威删除按精确版本单调接纳，同一删除身份的旧阶段不得覆盖新结果；不同 Worker 响应不能影响目标。两个 cleanup 均 completed 才完成。协调器在接纳删除或权威拒绝访问时，直接按账号和 Bot 清理草稿、回执及对应 Session 显示偏好，再通知已挂载缓存通过 `invalidateBot` 清理内存与阅读状态。浏览器存储清理不依赖页面挂载，因此离开助手页后到达的删除结果仍完成定向清理。即使原响应来自另一删除身份，也不重开对话。请求重试由用户显式触发，先 GET 再沿用权威 deletionId/requestedVersion；自动轮询只读。scope abort 取消准入并清记录，提交结果未知不重放。

WeakMap 保留同 scope 的记录，sessionStorage 保存可校验的最小身份和删除状态供重载恢复；存储失败保留内存。临时身份核对暂停阻止新请求和恢复准入，但不丢弃同一有效 scope 已发出请求的明确响应分类；明确拒绝的证据保留到同账号恢复后再查询权威状态。真正的 scope 失效丢弃响应与记录。`BotsPage` 订阅协调器与缓存的 guard revision，以本地删除状态过滤列表和详情，因此删除前发出的迟到读取不能绕过屏障。旧页面卸载只解绑缓存，原在途请求仍归账号 scope；新页面重新绑定时先恢复对应屏障。状态区展示实际清理阶段，完整页面刷新不是删除完成依据。

取舍见[浏览器删除决策](../../.agents/notes/implemented/architecture/2026-11-05-bot-browser-deletion.md)。

## 详情与全屏边界

`BotsPage` 拥有局部 `detailsOpen` 状态和名称按钮 ref；它们不参与 Session cache、pane key 或 client 的依赖。面板是会话内容的兄弟节点，`BotDetailsPanel` 接收当前详情读取所得的 Bot、相同 workerId 的 defaults 观测及 stale 标记，不另行读取或保存选中 Bot。切换时 `useBotRead` 的资源 key 隔离会立即清空旧值；面板可以保持挂载并显示加载，随后与标题及绑定一起接纳新目标。权威删除、拒绝访问、无选中项或 scope 失效撤下面板；临时读取准入暂停保留展开状态和已确认内容。创建及删除确认的展示同样由用户操作、真实资源状态与 scope 生命周期拥有，提交仍检查准入。

名称、Worker、cwd 和 Agent 来自已解析的 Bot 定义。`BotStatus` 复用列表与标题的启动结果及观测解释，详情状态不以 Worker 名称替代可用性说明；冻结启动配置不受后来 defaults 变化影响。读取失败与不可用保持原有状态，不将持久 ready 转换为当前 Session 同步事实。

面板使用同一个 `dialog` 元素：宽屏以非模态 `open` 和 complementary 语义参加横向 flex 布局，窄屏通过 `showModal()` 进入浏览器 top layer。窗口宽度 1000px 是两种布局的分界。断点变化先关闭原模式再打开新模式；只有抽屉取得既有计数式 body scroll lock。打开后聚焦关闭按钮，清理时仅向仍连接且未隐藏或 inert 的当前名称按钮恢复焦点。原生模态负责背景 inert；抽屉只在 Tab 到达首尾时循环本面板控件，避免单个关闭按钮后的焦点离开网页。

`BotSessionHost` 将可选 `fullscreenBoundary` ref 透传给 `SessionView` 和 `useSessionFullscreen`。助手提供稳定的 `.bot-conversation` 祖先，包含名称、会话内容和详情；hook 校验该边界确实包含原 Session section，并将注册、背景隔离、焦点范围、视口变量及 `data-session-fullscreen` 状态应用于它。原 section 保持挂载且不重复使用固定全屏定位。未提供边界的 Task/Test 调用方仍以原 Session section 为根。

外层边界模式在 document 冒泡阶段处理键盘，晚于 React 内层控件。详情先消费自己的 Escape；窄屏 Tab 在抽屉首尾循环后停止向外传播。这样关闭详情不退出全屏，也不让外层 Tab 处理器选择原生模态之外的控件。外层模式的焦点观察允许详情内部焦点，因为 dialog 是同一边界的后代。退出或卸载恢复本层持有的属性、样式与 inert 所有权，不改写其他模态拥有者。

详情和全屏改变尺寸时，仍由既有时间线观察器保持文字阅读锚点与跟随意图，不缓存或重放原始 scrollTop。边界选择与取舍见[详情面板决策](../../.agents/notes/implemented/feature/2026-11-05-bot-details-panel.md)。

取舍见[管理页面决策](../../.agents/notes/implemented/architecture/2026-11-05-bot-management-web.md)。
