# 助手管理页面

[需求](../spec/bot-management-web.md)拥有可观察行为；[共享会话设计](bot-session-view.md)拥有 Bot Session 绑定和缓存。页面以阅读和输入为主，列表、创建及详情围绕同一会话宿主组合。[呈现决策](../../.agents/notes/implemented/architecture/2026-11-05-assistant-management-presentation.md)记录布局选择和替代成本；[管理页面决策](../../.agents/notes/implemented/architecture/2026-11-05-bot-management-web.md)保留读取与创建身份的理由。

## 工作区与列表

`AuthenticatedApp` 为 `/bots` 与 `/bots/{id}` 使用同一 `BotsPage` 组件位置，并添加助手专用外壳样式。`assistant-workspace.css` 取消该路由 `.content` 的最大宽度、居中 margin 和 padding；全局导航仍使用已有展开偏好、Team、账号入口和路由。页面复用 Session 外壳的动态视口高度约束，不另建导航或会话路由。

`bots.css` 将 `.bots-page` 定义为命名 `bots-workspace` inline-size 容器。列表固定 256px（含边框），与对话之间没有额外 gap；工作区内容宽度低于 676px 时，只显示列表或当前选中的对话，等于 676px 时仍并列并为对话保留 420px。判断依据是扣除导航后的实际容器宽度。CSS 只改变既有面板可见性，不创建宽度状态、Session 宿主或新的目标绑定。单栏返回及关闭聊天都导航到 `/bots`，不停止或删除助手。

工作区、对话列、SessionHost 和 pane 的 flex 高度链允许收缩。列表面板承载创建入口与搜索，长列表在自己的区域滚动；创建弹窗使用独立的可见视口约束，不占用列表高度。消息时间线继续拥有自己的滚动面，历史分页与阅读书签使用同一可见区域，输入不会因历史增长被推出页面。详情的滚动区与时间线独立。

列表标题与创建按钮同行，名称搜索下是列表小标题、数量和刷新按钮。刷新用 busy/disabled 表达状态，读取失败保留实际错误。列表沿用服务返回顺序，行内保留头像标记、名称、关注计数及必要的启动或 Worker 异常状态；主机、路径和完整信息在详情中读取。零助手与搜索无匹配分别显示。行上的更多、右键和键盘菜单仍固定其自身 Bot 为删除目标。

## API 与准入

`api/bots.ts` 消费服务端 `/api/v1/me/bots` 的 list、defaults、create、get、delete。读取要求响应 principal 与当前账号一致；定义再次核对 owner、Worker 配置和 Session 双身份。删除响应是仅含身份及删除责任的联合类型。版本与创建顺序保持十进制字符串，不经浮点数转换。

创建只发送 `{id,name,overrides?}`。默认值选择、Provider 的 model/reasoningEffort/args 解析以及成功偏好保存均由服务端拥有。响应解析保留真实 pending/ready/failed；已 dispatch 的传输、解析或非明确拒绝错误转换为 `BotCreationUnknown`。接口不自动重试写入。

## 关注计数与已看到

网站在 Bot 列表、详情与创建请求中发送 `Daynight-Bot-Attention: 1`，要求服务端回显该版本，并在活跃 Bot 定义中提供非负整数 `attentionCount`（包括零）。未声明该能力的客户端继续得到不含该字段的旧响应，避免已安装 CLI 的严格字段校验拒绝 list、show 或创建后的原 ID 核对；删除责任响应保持原有最小结构。CLI 解析器兼容缺失字段，并验证存在时的非负安全整数。服务端 Bot 查询在同一读取快照中按 owner 和 Bot 汇总两部分：目标为该 Bot、`attention=true`、`seenAt` 为空且不是 `proposal_pending` 的事件；该 Bot 为当前 holder 的未删除助手任务中状态为 pending 的提案。提案通知只负责投递，提案资源负责持续计数，因此不会重复计数，也不会因打开聊天或认领过期消失。投递状态不参与已看到判定。

`POST /api/v1/bots/{id}/attention/seen` 复用助手任务模块的 `ClearAttention`，验证当前用户和目标 Bot，事务内为普通关注事件写入 `seenAt`，排除提案通知；响应为 `{targetBotId}`。已有 `/api/v1/assistant-task-events/attention` 保留同一清除语义。此操作不改变 Bot 定义版本、不确认事件投递、不决定提案，也不改变 Session 执行。服务层负责实例组装，HTTP 层只解析目标和编码结果。配置应用来源时，根 CORS 适配器允许该精确路径的 POST 预检及 Authorization、Content-Type 请求头；预检不执行认证或清除操作，实际请求仍经过原有身份与权限检查。

`BotListItem` 将正数计数显示为紧凑数字徽标，提供中英文可访问名称。打开对话时，页面在当前账号和当前目标的权威详情确认后发起一次已看到请求；列表刷新及缓存 pane 留存不触发该写入。首次确认计数为零时也消费本次打开，后续轮询出现的新报告保留提醒，直到用户再次打开对话；首次详情仍在加载时不提前消费。成功后重新读取列表与目标详情，保留仍待决定的提案。清除失败保留计数和局部错误，核对入口只重新读取列表与详情；同一次打开不重放 POST，关闭后重新打开才产生新的已看到操作。恢复读取服从既有身份准入；迟到结果不能更改新目标或恢复已删除的内容。

关注事实由[助手任务设计](assistant-task.md#手册与协作)拥有；计数与展示取舍见[关注标记决策](../../.agents/notes/implemented/feature/2026-11-13-bot-attention-count.md)。

## 名字优先弹窗与配置解析

`BotCreateDialog` 以原生 `dialog.showModal()` 打开 `BotCreateForm`，取得计数式 body scroll lock。弹窗最大宽度 492px，不改变列表或 Session 的布局尺寸。名称自动聚焦；已保留未确认请求时聚焦核对按钮。默认界面保留名称、实际 Worker/Agent/默认或自定义摘要、折叠设置及提交区。摘要可通过键盘展开完整主机、路径、有效模型、effort 及其来源，长名称不依赖 hover 才能读取。

首次 defaults 未完成时保留名称编辑，暂不允许创建；后续读取保留已有展示与草稿，不插入后台检查状态行。错误显示实际原因和重试入口，重试不重建表单。`creating` 绑定账号 scope 与打开时的助手选择，目标导航使弹窗收起，迟到完成不能把新选择导航回旧结果。语言、同目标后台检查和布局变化不重建表单。

Worker、Agent、model 和 effort 使用[公共原生选择组件](native-select.md)的 form/fill 与 responsive 触控模式；选项和联动仍由表单拥有。原生菜单打开时，Escape 只阻止向外传播，保留浏览器取消操作和表单草稿；IME 与已处理事件不触发外层关闭。

`BotCreateForm` 分开记录 Worker、cwd、Provider、model 和 reasoningEffort 的显式覆盖。名字创建只发 `{id,name}`；查看默认、展开设置和取消菜单不会把预览写入请求。`getBotDefaults` 接收当前覆盖并重新解析有效配置，来源读取 `configuration.selection`，保留 explicit/preference/local/cloud/native/unknown 的区别；没有历史来源的旧记录不伪造来源。使用默认删除对应覆盖，恢复全部默认同时解除显式 Worker。

确认目录或明确选择 Agent、Model、effort 时，将当前解析到的 Worker 固定为显式目标。切换 Worker 清除旧机器的 cwd、Provider、model 和 effort；切换 Provider 保留目录，清除 model 和 effort；切换 model 清除表单 effort，再读取该模型的权威默认。Worker 当前明确 effort 的兼容性由服务端解析与真实能力校验，不能通过 UI 丢弃该配置来绕过错误。显式 Worker 不可用时保留错误，不自动换机。

`useBotCreationModels` 在设置展开后通过 `discoverWorkerModels` 读取目标 Worker、Provider、cwd 和模型的原生能力，使用 `includeHidden:true` 在同一次有界分页查询中取得隐藏默认模型的能力。它按相同连接及能力代次收齐分页，并核对 configurationGeneration、catalogGeneration、目录、Provider、重复模型和游标，再发布完整目录。表单用完整目录匹配模型与别名，模型菜单只显示非隐藏项；已明确选择的模型后来变为隐藏时保留该值以便恢复默认。

有效模型依次取表单明确值、服务端 Bot defaults 已解析值；仅当服务端以 native/null 委托原生时，才使用无 selectionError 的同目标目录默认模型。effort 摘要同样只补充 native/null，且目录默认模型必须匹配有效模型或其别名，避免把其它模型的默认强度带入。成功偏好和本地/云端明确值仍由 Bot defaults 拥有，未知或失败目录不伪造默认。目录观察只影响摘要与可选能力，始终独立于显式状态；因此仅选 effort 的请求固定 Worker，但不带 model，查看默认仍保持名字请求。没有已确认的模型或 effort 列表时不生成静态选项，失败保留重试入口；提交保留用户明确选择的标识。请求取消和表单代次隔离迟到响应。

## 同一弹窗中的目录浏览

`BotDirectoryBrowser` 接收打开时的 Worker、当前目录与已解析默认目录，在同一个 dialog 内切换视图，父表单保留名字和覆盖状态。`browseWorkerDirectory` 只查询目标 Worker 的目录；路径、父目录和子项路径均使用响应中的规范化值，不在浏览器拼接 HOME 或解释远端平台。默认目录按钮只导航，只有“选择此目录”才写回并固定 Worker。取消、Escape 和浏览页关闭按钮均返回原表单，焦点恢复到 Browse。

目录视图提供当前层已加载条目的本地筛选、隐藏目录开关和显式加载更多。后续页固定连接及能力代次，校验同一路径、父目录、重复条目和游标；条目总数有界。改变路径或隐藏项后重新读第一页。身份暂停只阻止远程操作，路径和本地筛选输入仍可编辑。尚未确认的路径编辑、读取中、错误和身份暂停均不能确认目录。旧 Worker 不支持、离线、权限、路径不存在及超时保留各自错误，不冒充空目录；取消或换目标中止原请求，账号 scope 继续约束结果准入。

浏览不读取文件内容、不创建目录、不启动助手。浏览成功只证明这次目录观察，首次启动仍由 Worker 校验实际路径。取消浏览不产生覆盖，原表单仍可使用默认或手动输入绝对路径。

## 焦点、视口与未确认请求

创建弹窗以 `visualViewport.height/offsetTop` 更新高度和纵向位置，缺失时使用窗口尺寸；监听 resize 和 scroll。标题与操作区不收缩，中间内容独立滚动；窄屏左右保留 12px，Model/effort 从双列变为单列。窄屏或粗指针下输入字号至少 16px、主要交互目标至少 44px。可见视口约束用于保持操作可达，不能代替实体手机软键盘验收。

原生模态隔离背景并约束焦点。Escape 由当前子视图处理：目录页先返回表单，表单取消后回到仍连接的创建入口；输入法组合不触发提交或关闭，提交期间禁用取消与重复请求。关闭创建不更换 Bot 绑定，不卸载 SessionHost，不清除会话草稿、阅读位置或执行状态。

页面在 dispatch 前将未确认请求交给 `pending-creation.ts`。同一账号 scope 的 WeakMap 跨组件卸载保留内存请求，`sessionStorage` 仅保存 Bot ID，不保存可重放的 POST 正文。关闭后重新打开、返回页面或重载后的表单只能按该 ID GET；取得可信结果后先按原请求在 scope 内保留确认事实，本地 busy 不等待发布准入；404 和读取失败仍保留未确认记录。受原 scope 和操作身份约束的可取消发布在准入恢复后清除未确认身份，但暂停过的结果须由用户显式打开，避免恢复自动触发读取。提交时的表单实例、内存 revision 和导航位置保护较新草稿；用户修改后旧结果不会关闭弹窗或导航。原实例销毁或新操作替代时取消其发布工作，已确认事实按原 ID 保留至用户消费或 scope 销毁。scope abort 清除对应记录和可访问的存储。无法访问存储时保留同文档内存并显示 ID，不能承诺跨重载恢复。弹窗和浏览视图切换不把结果未知转换为可重新 POST 的明确失败。

布局取舍与原内联方案的关系见[创建弹窗决策](../../.agents/notes/implemented/architecture/2026-11-07-assistant-creation-dialog.md)。

## 读取与展示

`useBotRead` 分别管理列表和 defaults。资源 key 与账号 scope 共同约束结果；每五秒在页面可见且身份准入时刷新，不重叠请求。隐藏、资源变化和 scope abort 取消旧读取，结果发布前再次检查准入。账户变化等待刷新保留同 scope、同 key 已确认的值，实际失败保留上次值并标记 stale。

选中详情由既有 `useBotDetail` / `BotDetailCache` 管理，按账号 scope、选择对象和请求代次隔离。页面传实际三席 pane 的 Bot ID 集合；新选择可读取自己的缓存详情与 `displayBinding`，但上次选择的确认不能成为本次 `actionBinding`。普通五秒轮询开始保留确认，真实网络、协议或服务错误撤确认，取消不产生成功或失败。`confirmed` 与 actionBinding 使用同一当前确认规则；无 Session 的启动详情仍可得到确认，不把空 binding 误解释成持续加载。

列表遍历到末页后一次发布，检查重复 ID/cursor，搜索在完整快照中进行。defaults 单独读取，Worker 观测失败不会清空助手列表。当前可信列表名称可在冷详情等待时提供标题，不带入上一助手状态。`ready` 仅显示已启动，当前同步和输入可用性继续由 Session View 解释。服务端 defaults 不替代 Session 同步事实。

`BotsPage` 在选中项之上创建一次 cache，`/bots` 与 `/bots/{id}` 使用同一个组件位置。Host 始终挂载，展示不受详情 stale 隐藏；它接收当前目标独立的显示与操作绑定，原 DOM、草稿和阅读先恢复，远端提交待当前完整身份确认。临时失败保留可读内容并显示局部错误和重试，权威拒绝访问及删除撤下失效内容。具体准入和原回执继续的责任见[Session 设计](bot-session-view.md#绑定和消费接口)。

路由进入既有账户准入与导航草稿准入，不创建另一份 route state，保留原生链接修改键行为。已采纳导航同步冻结旧 client，提交后的布局 effect 选择当前目标；同 URL 或取消导航维持原选择。关闭聊天只导航回列表。搜索、详情展开与布局尺寸不参与缓存身份；完整绑定仍由 owner、Bot、Session 和执行 ID 共同确定，隐藏 pane 保持 hidden/inert，删除与失效由原协调机制处理。

## 统一标题与状态来源

`BotsPage` 用 `BotConversationTarget` 向标题和详情传递同一次已准入的 Bot 读取、匹配的 Worker 观测、stale 标记、详情展开状态与触发 ref。有绑定时，`BotSessionHost` 将 `variant: 'assistant'` 和 `renderHeader` 透传给原 `SessionView`，`BotConversationHeader` 在共享标题元素内组合当前 Provider、会话活动、显示、专注和刷新控件；无绑定时才渲染页面的后备标题。详情使用独立按钮，更多 popover 容纳共享刷新与关闭聊天链接。显示和专注控件仍由共享 Session 创建和控制，不复制其状态机。

自定义标题只替换标题内容。共享视图继续渲染连接错误、启动与恢复原因、历史、审批、命令回执及输入能力；Bot 的 ready 不证明 Session 已连接或可发送。当前 Session 的连接与活动采用共享状态，未绑定时显示 Bot 启动及 Worker 观测；详情分别呈现 Bot 启动、Worker 可用性和 Session 状态。defaults 读取失败不得延用“可用”判断，临时身份核对则保留已确认展示并暂停业务准入。

`.bot-conversation` 是标题的 inline-size 查询容器。名称默认 17px 单行省略，完整名称从详情读取。可用宽度不超过 600px 时，名称为 15px，返回、名称和操作形成三列，状态独占下一行，关键按钮为 44px；不超过 300px 时再允许操作换行。名称区域可收缩，控件保留自身空间，状态原因允许断行。这些规则不参与 Session 或详情模式选择，标题也不依赖主机名撑开宽度。

## 删除协调

`BotListItem` 的原生 popover 菜单负责更多、右键和键盘入口，确认目标与原按钮一起交给 `BotDeleteDialog`。确认框使用原生模态层、滚动锁和焦点恢复；打开只选择目标，确认才调用删除协调器。

`deletion-coordinator.ts` 按账号 scope 复用单个协调器。每个目标保存名称、Session/Worker 身份、原删除请求、最小阶段结果及错误，不保留配置或对话正文。提交前同步 `blockBot` 并保存请求；同一协调器按已知 Session 身份向独立入口提供准入状态。初始 Session 尚未注册时，后续经 owner/Worker 校验的 active 读取补齐其身份，但不能用不同 Session 替换已知绑定。`BotDeletionUnknown` 保留已 dispatch 的不确定性。失败后的 GET 不将一次瞬时 active 观察当成撤销原请求的证明；原请求曾未知时，后续重试被拒绝也不能清除该不确定性。明确拒绝且权威 active 才解除对应 Bot 与独立 Session 的屏障，后续新请求仍需用户确认。

权威删除按精确版本单调接纳，同一删除身份的旧阶段不得覆盖新结果；不同 Worker 响应不能影响目标。两个 cleanup 均 completed 才完成。协调器在接纳删除或权威拒绝访问时，直接按账号和 Bot 清理草稿、回执及对应 Session 显示偏好，再通知已挂载缓存通过 `invalidateBot` 清理内存与阅读状态。浏览器存储清理不依赖页面挂载，因此离开助手页后到达的删除结果仍完成定向清理。即使原响应来自另一删除身份，也不重开对话。请求重试由用户显式触发，先 GET 再沿用权威 deletionId/requestedVersion；自动轮询只读。scope abort 取消准入并清记录，提交结果未知不重放。

WeakMap 保留同 scope 的记录，sessionStorage 保存可校验的最小身份和删除状态供重载恢复；存储失败保留内存。每次操作为准备和准入等待持有可取消信号，暂停取消未派发的准备并结束原 promise 与 busy；确认零派发时解除该次屏障，已派发的未知结果继续保留原身份。派发后临时暂停不丢弃同一有效 scope 的可信响应分类，暂停后的操作不自动读取或重放。active 读取尚未通过发布准入时结束原操作，后续核对仍需新的获准操作；明确拒绝的证据保留到同账号恢复后再查询权威状态。每次收尾检查操作身份；观察到另一删除身份时取消并解除旧操作，新操作不受旧结果或 busy 收尾影响，重试只处理开始时的原请求。真正的 scope 失效丢弃响应与记录。`BotsPage` 订阅协调器与缓存的 guard revision，以本地删除状态过滤列表和详情，因此删除前发出的迟到读取不能绕过屏障。旧页面卸载只解绑缓存，原在途请求仍归账号 scope；新页面重新绑定时先恢复对应屏障。状态区展示实际清理阶段，完整页面刷新不是删除完成依据。

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

管理页规格定义容器临界值、长内容、短视口和焦点矩阵。API 与组件测试验证默认覆盖、Worker 绑定和级联重置、目录/模型分页与迟到响应、未知结果、当前身份、缓存、标题组合和模态协同；浏览器测试才能验证真实几何、原生 dialog、滚动与 DOM 身份。原型只用于设计交互核对，受控 API 或 Session 测试只证明 Web 消费行为，不证明真实 Worker、Provider、偏好持久化或真机软键盘。共享阅读、输入和图片能力的设计由各自所有者说明，不从标题及详情改造推断其已交付。
