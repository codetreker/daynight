# 助手 Session 绑定与页面缓存

[需求](../spec/bot-session-view.md)定义稳定切换及清理结果；[共享 Session 设计](task-session-protocol.md)拥有 renderer、reducer、操作回执与阅读 hook。

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

Web 单元与 DOM 测试验证 API 身份、LRU、轻量存储、草稿/回执恢复、迟到响应、当前与可见性分离以及认证生命周期。真实浏览器用共享组件测量文字锚点、DOM 对象身份、分页失败与重连、资源释放和窄屏布局。测试用 API、连接和 Provider 受控时，结果只证明浏览器消费行为，不证明原生托管或完整助手运行。

取舍与后续组合约束见[缓存决策](../../.agents/notes/implemented/architecture/2026-11-04-bot-session-cache.md)。
