# Webhook Web 配置架构

## 组件与导航

`AuthenticatedApp`在已认证的TaskCacheScope下提供独立`WebhookCatalogProvider`，与侧栏默认Team选择解耦。`WorkspaceSidebar`只有验证过当前服务/主体catalog后展示入口；`/webhooks`的查询明确表达owner、teamId、endpointId和configuration/subscriptions。非法查询保留错误，不作为个人归属读取。

`WebhooksPage`按配置、订阅、秘密、列表和原生dialog组织交互；`useWebhookData`管理按owner与查询隔离的读取，`useWebhookDirectories`读取实际Team/Project目录。页面保持生产shell，Webhook组件使用独立作用域样式。要求由[Web配置规格](../spec/webhook-web.md)拥有，服务端权限、订阅和回执由[管理设计](webhook-management.md)拥有。

## 请求与发布

`api/webhooks.ts`复用现有同源request、取消、401清理与requestId机制。成功及非401错误响应先校验当前主体，成功再验证严格DTO和请求资源；浏览器使用Web Crypto，不导入CLI的Node依赖。配置版本与目的地代次为规范int64字符串，nullable和数组必须真实存在。

读取按服务/主体/owner/endpoint/查询代次发布；旧请求、低版本和错主体不能覆盖新视图。Endpoint读取和辅助请求共用owner发布围栏；Team归属的已确认membership role/version另约束配置、列表、秘密、管理控件及弹窗。团队目录确认降权或关系失效时，撤下旧管理员资料并失效其读取依据，迟到响应和返回该归属的缓存不能恢复旧权限；较新的限制性Endpoint或列表摘要投影也立即推进归属权限观察，不等待后续页或详情；只有主体、媒体和错误DTO均验证成立的server forbidden403才撤销该归属全部私有投影，server not_found404仅表示资源当前不可用；带403/404状态的协议损坏不构成授权或资源不存在事实，保留合法数据和草稿并允许恢复读取。撤下旧摘要和管理能力；未变化的旧管理员目录不能恢复它，新的membership身份或版本提供复权依据。原操作回执独立保留。权限披露变化使用当前值，URL=null不能回退到旧敏感值。原生dialog与草稿不因背景读取卸载。分页记录查询与已经读取的页数，同查询刷新读取相同权威cursor范围，整批成功才替换；失败保留原集合，改变查询时明确区分旧集合和新结果。

catalog首次加载决定私有读取准入；背景验证保留已展示页面并暂停新准入，成功恢复，真实错误保持可重试。新确认身份撤销旧TaskCacheScope及客户端私有状态。Webhook配置不写任务IndexedDB。

## 固定意图控制器

`WebhookIntentController`在首次实际提交时建立固定元数据与最终body，用Web Crypto计算SHA-256。一个owner内未决操作阻止冲突的新意图；重复或重入提交共享同一结果。写入在准备、认证恢复及实际fetch前检查当前准入。读取核对与写入使用不同pending种类；核对期间的新写明确拒绝，不能把旧操作的读取结果当作新写入结果。已知configurationExpansionAvailable=false时，统一准入分类阻止目的地变化、新资源/事件扩大、确认或启用，保留名称、范围收缩、暂停和删除。

状态区分idle、preparing、submitting、unknown、rejected和confirmed。确认使用原operationId、issuedAt、actor、owner、种类、目标、hash和版本关系；首次确认的operation结果作为该意图不可变的已知事实保留，后续矛盾的结果字段报告协议错误且不替换它。响应中的历史operation与当前endpoint分别解析，当前投影损坏不能否定已经匹配的原效果。

unknown自动活动仅尝试读取原GET回执，失败保留unknown和原ID，显式核对继续使用原scope。sessionStorage仅存最小prepared metadata；body只在内存。重载后没有body不能重发。只有读取、解析并绑定scope成功的prepared metadata才恢复为unknown；存储不可读或损坏时保留明确persistenceError，不宣称旧操作回滚或记录已清理，当前文档中的新明确提交仍使用完整固定意图并保留核对ID。删除pending记录核对原operationId，旧控制器不能清除另一个操作；dispose移除内存正文与私有投影。存储清理返回失败，由认证壳继续完成身份隔离并保留可重试的opaque主体记录。

回执nullable overlapUntil来自原持久化结果；逻辑到期由数据库时钟决定。GET404和重放410只说明回执当前不可确认，不能证明回滚，详见[回执决策](../../.agents/notes/implemented/bug-fix/2026-11-08-webhook-receipt-results.md)。

## 配置、资格和秘密

配置对话框将明确编辑字段与版本基线分开保存。手动查看冲突后的当前版本刷新未编辑值，保留编辑值；双方都改变的字段须明确选用当前值、保留本人修改或重新编辑，重复查看不会自动解除冲突。提交只包含已明确解决的编辑字段与观察版本；订阅dialog提交完整最终数组及显式confirmProjectIds。服务端裁决实际资格和字节边界，前端目录不替代授权。扩大与启用遵循catalog能力，暂停、删除和范围收缩仍使用管理权与原CAS。

独立secret GET只在当前capability获准时读取。返回key与当前版本匹配才展示；离开配置区域、窄屏返回列表、响应式切入列表模式、轮换、降权或账号变化撤下旧值并失效未完成秘密读取；再次进入须重新GET，隐藏面板不保留可显示秘密。复制失败提供可选中明文的当前文档操作，不写额外持久存储。历史轮换结果保持原key和截止，当前secret另读。

## 验证与交付

单元验证负责wire、版本、状态机、存储和UI生命周期边界。无头浏览器连接同一生产RegisterRoutes、真实认证和PostgreSQL，通过真实第二客户端、barrier及仅转发的故障层验证业务效果。临时fixture只接线模块，不复制业务handler或成功JSON。

内容区与dialog对照视觉输入的样式向量、局部geometry和像素，生产shell单独核对控件、响应式与导航。全页截图保留shell起点、宽度、页头及边距差异，只允许对齐外层可用内容盒。未变化背景检查同时验证节点身份、草稿、选区、焦点、滚动和分页；产品测试不导入原型或场景状态。
