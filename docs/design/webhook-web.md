# Webhook Web 配置架构

## 组件与导航

`AuthenticatedApp`在已认证的TaskCacheScope下提供独立`WebhookCatalogProvider`，与侧栏默认Team选择解耦。`WorkspaceSidebar`只有验证过当前服务/主体catalog后展示入口；`/webhooks`的查询明确表达owner、teamId、endpointId和configuration/subscriptions。非法查询保留错误，不作为个人归属读取。

`WebhooksPage`按配置、订阅、秘密、列表和原生dialog组织交互；`useWebhookData`管理按owner与查询隔离的读取，`useWebhookDirectories`读取实际Team/Project目录。页面保持生产shell，Webhook组件使用独立作用域样式。要求由[Web配置规格](../spec/webhook-web.md)拥有，服务端权限、订阅和回执由[管理设计](webhook-management.md)拥有。

## 请求与发布

`api/webhooks.ts`复用现有同源request、取消、401清理与requestId机制。成功及非401错误响应先校验当前主体，成功再验证严格DTO和请求资源；浏览器使用Web Crypto，不导入CLI的Node依赖。配置版本与目的地代次为规范int64字符串，nullable和数组必须真实存在。

读取按服务/主体/owner/endpoint/查询代次发布；旧请求、低版本和错主体不能覆盖新视图。权限披露变化使用当前值，URL=null不能回退到旧敏感值。原生dialog与草稿不因背景读取卸载。分页记录查询与已经读取的页数，同查询刷新读取相同权威cursor范围，整批成功才替换；失败保留原集合，改变查询时明确区分旧集合和新结果。

catalog首次加载决定私有读取准入；背景验证保留已展示页面并暂停新准入，成功恢复，真实错误保持可重试。新确认身份撤销旧TaskCacheScope及客户端私有状态。Webhook配置不写任务IndexedDB。

## 固定意图控制器

`WebhookIntentController`在首次实际提交时建立固定元数据与最终body，用Web Crypto计算SHA-256。一个owner内未决操作阻止冲突的新意图；重复或重入提交共享同一结果。写入在准备、认证恢复及实际fetch前检查当前准入。

状态区分idle、preparing、submitting、unknown、rejected和confirmed。确认使用原operationId、issuedAt、actor、owner、种类、目标、hash和版本关系；响应中的历史operation与当前endpoint分别解析，当前投影损坏不能否定已经匹配的原效果。

unknown自动活动仅尝试读取原GET回执，失败保留unknown和原ID，显式核对继续使用原scope。sessionStorage仅存最小prepared metadata；body只在内存。重载后没有body不能重发。只有读取、解析并绑定scope成功的prepared metadata才恢复为unknown；存储不可读或损坏时保留明确persistenceError，不宣称旧操作回滚或记录已清理，当前文档中的新明确提交仍使用完整固定意图并保留核对ID。删除pending记录核对原operationId，旧控制器不能清除另一个操作；dispose移除内存正文与私有投影。存储清理返回失败，由认证壳继续完成身份隔离并保留可重试的opaque主体记录。

回执nullable overlapUntil来自原持久化结果；逻辑到期由数据库时钟决定。GET404和重放410只说明回执当前不可确认，不能证明回滚，详见[回执决策](../../.agents/notes/implemented/bug-fix/2026-11-08-webhook-receipt-results.md)。

## 配置、资格和秘密

配置对话框保留打开时观察版本，提交明确字段；订阅dialog提交完整最终数组及显式confirmProjectIds。服务端裁决实际资格和字节边界，前端目录不替代授权。扩大与启用遵循catalog能力，暂停、删除和范围收缩仍使用管理权与原CAS。

独立secret GET只在当前capability获准时读取。返回key与当前版本匹配才展示；离开区域、轮换、降权或账号变化撤下旧值。复制失败提供可选中明文的当前文档操作，不写额外持久存储。历史轮换结果保持原key和截止，当前secret另读。

## 验证与交付

单元验证负责wire、版本、状态机、存储和UI生命周期边界。无头浏览器连接同一生产RegisterRoutes、真实认证和PostgreSQL，通过真实第二客户端、barrier及仅转发的故障层验证业务效果。临时fixture只接线模块，不复制业务handler或成功JSON。

内容区与dialog对照视觉输入的样式向量、局部geometry和像素，生产shell单独核对控件、响应式与导航。全页截图保留shell起点、宽度、页头及边距差异，只允许对齐外层可用内容盒。未变化背景检查同时验证节点身份、草稿、选区、焦点、滚动和分页；产品测试不导入原型或场景状态。
