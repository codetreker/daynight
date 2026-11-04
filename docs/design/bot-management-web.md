# 助手管理页面

[需求](../spec/bot-management-web.md)拥有可观察行为；[共享会话设计](bot-session-view.md)拥有 Bot Session 绑定和缓存。

## API 与准入

`api/bots.ts` 消费服务端 `/api/v1/me/bots` 的 list、defaults、create、get。读取要求响应 principal 与当前账号一致；定义再次核对 owner、Worker 配置和 Session 双身份。删除响应是仅含身份及删除责任的联合类型。版本与创建顺序保持十进制字符串，不经浮点数转换。

创建只发送 `{id,name,overrides?}`。默认值选择、Provider 的 model/args 解析以及成功偏好保存均由服务端拥有。响应解析保留真实 pending/ready/failed；已 dispatch 的传输、解析或非明确拒绝错误转换为 `BotCreationUnknown`。接口不自动重试写入。

## 创建状态

`BotCreateDialog` 以独立字段记录显式 Worker、目录和 Provider；显示默认值不改变这些记录。Worker 切换立即作废旧请求代际，再读取 defaults；取消与完成均不会写浏览器偏好。原生 `dialog.showModal()`、现有 body scroll lock 与焦点恢复负责模态交互。

页面在 dispatch 前将未确认请求交给 `pending-creation.ts`。同一账号 scope 的 WeakMap 跨组件卸载保留内存请求，`sessionStorage` 仅保存 Bot ID，不保存可重放的 POST 正文。新页面或重载后的弹窗只能按该 ID GET；确认结果后清除记录，404 和读取失败仍保留。scope abort 清除对应记录和可访问的存储。无法访问存储时保留同文档内存，不能承诺跨重载恢复。

## 读取与展示

`useBotRead` 为列表、defaults 和选中详情分别管理请求。资源 key 与账号 scope 共同约束结果；每五秒在页面可见且身份准入时刷新，不重叠请求。隐藏、资源变化和 scope abort 取消旧读取，结果发布前再次检查准入。失败保留上次值并标记 stale，切换资源不显示前一个资源的值。

列表遍历到末页后一次发布，检查重复 ID/cursor，搜索在完整快照中进行。defaults 单独读取，因此 Worker 观测失败不会清空助手列表。`ready` 仅显示已启动，当前同步和输入可用性继续由 Session View 解释。服务端 defaults 的 Worker 状态不替代 Session 同步事实。

`BotsPage` 在选中项之上创建一次缓存，`/bots` 与 `/bots/{id}` 使用同一个组件位置。SessionHost 始终挂载；未知绑定传 null，已缓存的 pane 隐藏，只有当前权威详情提供真实绑定。关闭聊天只导航回列表。删除或权威拒绝访问调用 `cache.invalidateBot`；普通读取失败撤下输入但不销毁可恢复状态。

路由进入既有身份检查与页面标题流程，保留原生链接修改键行为。全局侧栏不增加正式助手入口，后续组合不需要替换本页身份或会话缓存模型。

取舍见[管理页面决策](../../.agents/notes/implemented/architecture/2026-11-05-bot-management-web.md)。
