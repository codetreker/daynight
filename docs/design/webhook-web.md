# Webhook Web 管理与投递架构

## 组件与导航

`AuthenticatedApp`在已认证的TaskCacheScope下提供独立`WebhookCatalogProvider`，与侧栏默认Team选择解耦。`WorkspaceSidebar`只有验证过当前service/principal的catalog后展示入口；`/webhooks`的查询明确表达owner、teamId、endpointId和configuration/subscriptions/deliveries。deliveryId必须配合endpointId及deliveries；非法查询保留错误，不作为另一个归属读取。筛选按主体、owner和endpoint隔离在内存中，不扩展URL或Task IndexedDB。

`WebhooksPage`组织配置、订阅、秘密和投递页签；`useWebhookData`管理配置列表与详情，`useWebhookDirectories`读取实际Team/Project目录。`WebhookDeliveriesPanel`拥有Delivery列表、详情dialog、Attempt分页、独立payload及重投确认；`useWebhookHistory`共用历史读取、页数和错误保留逻辑，`useScopedState`隔离筛选。正常配置GC在Delivery仍引用endpoint时保留墓碑，页面可挂载只读投递页签。有效归属的deliveries地址在配置GET返回真实404且配置未加载时，使用`WebhookHistoryEndpoint`的`{kind:"retained-history",id}`分支挂载独立历史读取。它只持有endpoint ID，不合成配置名称、版本、capabilities或活跃endpoint；历史自身的200/403/404由严格读取处理。`{kind:"checking-configuration",id}`另表示配置尚在核验且当前管理投影已撤下，仍按独立历史读权保留资料；它与真实配置404后的retained-history分支有不同提示。两者都是客户端上下文，不是合成的Endpoint DTO，均不添加名称、版本或capabilities。授权历史的生命周期按service/principal/owner/endpointId/readKey隔离，与当前配置渲染分支及配置请求成败无关。管理缓存已撤下或配置404后的非权威配置500保留同一ID-only上下文、在途Delivery/payload读取及详情交互，错误在配置区域单独显示。缺失配置事实保留到同scope新的权威配置观察；500不撤销它，也不能恢复旧管理投影。身份/owner可读性、导航、历史404及已知载荷期限仍执行各自清理。墓碑、缺失配置及配置核验上下文均无重投入口资格。页面保持生产shell，Webhook组件使用独立作用域样式。可见结果由[Web规格](../spec/webhook-web.md)拥有，服务端管理和历史机制分别见[管理设计](webhook-management.md)与[历史设计](webhook-history.md)。

页面的空状态从当前已经验证的资源集合派生：endpoint 的空 subscriptions 产生独立 code 图标和订阅提示，项目目录的空集合只在项目选择中表达；读取未完成或失败不替换为这些空状态。 状态图标在 Webhook 样式范围内明确采用正常 grid 轨道分布，避免其他页面的同名 state-icon 规则将内部轨道收缩成 SVG 宽度。范围摘要的空集合使用 tiny 样式的“—”，保留与非空字段一致的结构。数字 SPAN 只包含计数；标签与尾部分隔空格形成同一外部文本节点，保留参考的字符 shaping 与窄屏徽标换行。固定页面/列表标题及数字计数采用原型的正常换行，动态资源名称继续允许长内容换行。

新建按钮保留原生事件目标与禁用语义，并在未设样式的 SPAN 内参与页头布局；按钮自身处于普通内联上下文，避免直接 flex item 的 blockification 改变 resolved display/min-width。新建配置 form 使用 webhook-create-form 标记，其 fieldset.form-field 采用 min-content 最小尺寸；编辑和订阅 form 保留各自现有尺寸规则。该标记只表达表单布局类型，不改变创建、版本或请求逻辑。

接收端点状态 `select.filter` 使用专属定位包装，隐藏浏览器绘制的箭头并叠加不接收指针事件的装饰 SVG；原生 select 仍拥有名称、焦点和选择行为。箭头盒为 10px，距右框 9px、垂直居中，select 为文字预留 29px 右内边距。包装与 select 在工具栏交叉轴拉伸，沿用页面自身的宽度限制及桌面和 450px 以下的字体、边框与其余内边距；窄屏规则保留箭头所需空间。箭头不参与固有宽度计算，搜索框继续收缩，团队选择器不受专属样式影响。浏览器箭头与文字 padding 分别受浏览器控制，故单调 padding 无法固定右边距；取舍记录于[状态筛选箭头决策](../../.agents/notes/implemented/bug-fix/2026-11-14-webhook-status-select-spacing.md)。

## 请求与配置发布

`api/webhooks.ts`复用现有同源request、取消、401清理与requestId机制。成功及非401错误响应先校验当前主体，成功再验证严格DTO和请求资源；浏览器使用Web Crypto，不导入CLI的Node依赖。配置版本、destinationRevision和generation为规范int64字符串，nullable和数组必须真实存在。历史参数、顺序、重复ID与cursor严格验证；UTC筛选按服务端纳秒精度比较，Attempt代次使用BigInt。

显式 endpoint 路由决定窄屏列表与详情的可见区域，已读取的 endpoint 投影只决定其中可展示的资料。选中路由的集合读取错误与配置读取错误在详情区显示；无显式选择时，集合错误在列表区显示。当前资料被撤下后，详情框架仍提供返回列表入口，分别表达已确认的 Team 失权、实际读取错误或加载状态。返回仅清除 endpoint 选择并保留原 owner；不通过更换归属掩盖失败。

读取按service/principal/owner/endpoint/查询代次发布；旧请求、低版本和错主体不能覆盖新视图。提交及原回执核对确认后使用`useWebhookData.refreshCurrent`，从当前路由引用取得owner、endpoint与筛选；创建确认引发的导航不被await前捕获的旧选择再次刷新覆盖。原操作确认和当前视图刷新各自保持原有身份与发布围栏。Endpoint读取和辅助请求共用owner发布围栏；Team归属的已确认membership role/version另约束配置、列表、秘密、管理控件及弹窗。团队目录确认降权或关系失效时，撤下旧管理员资料并失效其读取依据，迟到响应和返回该归属的缓存不能恢复旧权限；较新的限制性Endpoint或列表摘要投影也立即推进归属权限观察，不等待后续页或详情。

只有主体、媒体和错误DTO均验证成立的server forbidden403才推进拒绝观察：配置及原回执读取拒绝撤销该归属全部私有投影；秘密读取或管理写入拒绝仅撤销管理员资料与能力、关闭编辑器、清除秘密、失效旧读取围栏并刷新权威Team目录，保留成员脱敏读取准入。辅助请求拒绝绑定发起时的owner与authorizationKey，切换归属或新权限代次后不发布旧拒绝。server not_found404只表示对应资源当前不可用；带403/404状态的协议损坏不构成授权或资源不存在事实，保留合法数据和草稿并允许恢复读取。未变化的旧管理员目录不能恢复已被否定的管理权，新的membership身份或版本提供复权依据。[管理拒绝决策](../../.agents/notes/implemented/bug-fix/2026-11-08-webhook-management-denial.md)记录该区分。

`403 webhook_project_ineligible`只表示所选Project不能加入、扩大、确认或启用该Webhook范围，意图保持rejected并保留编辑器；它不推进Team权限观察。页面按机器码区分资格拒绝与管理权拒绝，不匹配服务端message，也不依赖后续旧管理员目录恢复权限。

归属资格分别提供管理观察key与可读membership readKey。持续admin→member保留Team Project资料读权，管理观察变化撤销旧Endpoint、秘密、管理缓存及Admin标签，readKey继续隔离仍获准的Delivery与payload。原操作回执独立保留，nullable披露值不能回退到旧敏感值。原生dialog与草稿不因未变化的背景读取卸载。配置分页记录查询与已经读取的页数，同查询刷新读取相同权威cursor范围，整批成功才替换；失败保留合法集合，改变查询明确区分旧集合与新结果。

catalog首次加载决定私有读取准入；背景验证保留已展示页面并暂停新准入，成功恢复后仅重新读取。确认身份变化撤销旧TaskCacheScope及客户端私有状态。准入暂停不卸载dialog、载荷、重投确认或草稿；身份失效、离页及确认的权限、资料或期限变化按实际范围清理。

## 投递资料的共同观察

配置版本和投递generation不随每次资料权限变化推进，单独给列表与详情分配请求序号不足以隔离跨请求迟到披露。`WebhookDeliveryObservations`为同一endpoint内的每个Delivery保存读取观察代次、generation及当前投影。列表和详情在发起GET时记录代次；metadata_only、载荷不可用、target.url=null的独立目的地脱敏、有效payload403/410/404、同scope所选Delivery的Attempt GET404及已知载荷逻辑到期推进同一个限制观察。full事件的target.url=null触发`directories.observeManagementRestricted(owner, managementAuthorizationKey)`，撤销旧管理观察及Endpoint/secret/管理员缓存，同时独立可读membership key保留当前获准的事件资料和已显示payload；不能把URL=null回退成旧URL，也不能把管理降权当作Project读权丧失。早于该观察开始的读取返回当前受限投影，不能重新安装旧full资料；新发起的获权读取可以恢复完整视图，并保留新的观察水位以拒绝更旧响应。低generation不能覆盖较新的事实。

列表在每页响应和最终组装时经过共同投影；追加或后续页失败也使用当前已经脱敏的集合，不能从读取开始时捕获的旧页恢复内容。详情限制同步对应列表、payload显示依据和当前操作投影；payload403只限制Delivery资料，URL脱敏另收缩归属管理观察，两者均不撤销仍有效的owner资料读权。同scope所选Delivery的详情、Attempt或payload GET返回已验证404时，共同撤回该Delivery、正文、重投确认与控制器当前投影，推进观察并隔离在途详情及列表读取；配置GET404不触发这项撤回，而是保留独立历史读取资格。原不可变回执始终保留，后到的控制器结果同样经过当前限制检查。

payloadExpiresAt是已知载荷截止，响应发布时读取新鲜Date.now()，并为未来载荷期限安排本地定时撤回；迟到且已经跨该期限的正文不能发布。元数据保留会受到活动、Attempt和保留状态影响，HTTP投影没有精确元数据截止，客户端不能用occurredAt加retention秒数计算删除时间。历史通过权威GET持续核验，以真实404或限制投影撤下对应资料；载荷本地清理和历史权威撤回均不宣称数据库已物理GC。发送后续结果与历史新鲜度检查只使用GET。准入可用且投递页签可见时，所选pending/leased每两秒核验详情、Attempt与列表，终态每30秒核验；未选择详情时列表每30秒核验。focus/visibility触发同一读取，离页或准入暂停清除定时器，背景检查保留未变化节点、焦点、滚动和选择。

历史分页保存查询与已读页数，同查询刷新沿当前权威cursor读取相同范围，整批成功才替换；失败保留当前合法集合，改变查询明确区分旧集合和新结果。保留策略与historyMayBeIncomplete一直表达历史可用范围，不把空页或404推断为从未发生。Attempt的正常结果、recoveredUnknownAt和lateResult各自呈现；配置最新摘要、过去lastAcknowledgedAt和后来失败保持独立。

## 原载荷验证

payload只在明确请求时调用独立GET，不能凭endpoint可见性或已有历史DTO跳过授权。包装先验证owner、endpointId、deliveryId及已观察eventId、媒体、编码、规范Base64、字节长度和65,536字节上限；Web Crypto对解码原字节计算SHA-256，随后严格UTF-8解码。取消、身份或资源变化继续约束发布，校验完成前没有可显示正文。

`pre`使用文本子节点展示原内容，原字节及hash单独保留用于核对。资源名称和错误同样使用文本；没有可执行frame、innerHTML、Task回填或目标重构。离开详情、身份变化、限制或期限到达取消未完成payload请求并删除内存正文。URL、sessionStorage和日志不保存payload。

## 固定意图控制器

`WebhookIntentController`在首次实际提交时建立固定元数据与最终body，用Web Crypto计算SHA-256。一个owner内未决操作阻止冲突的新意图；重复或重入提交共享同一结果。提交验证输入后冻结`WebhookIntentTarget`的owner、endpointId、deliveryId、ifVersion、ifGeneration和destinationRevision；`canSubmit(kind,target)`在operationId生成前、认证ready恢复后和实际fetch前核验同一目标。页面按owner/endpoint注册原Delivery准入校验器，读取其固定deliveryId、版本、代次和原目标资格；当前选中另一条可重投记录不能替代原意图。读取核对与写入使用不同pending种类；核对期间的新写明确拒绝，不能把旧操作的读取结果当作新写入结果。准入按操作种类区分配置扩张和重投：已知configurationExpansionAvailable=false时阻止目的地变化、新资源/事件扩大、确认或启用，保留名称、范围收缩、暂停和删除；delivery.redeliver另检查dispatchEnabled及当前Delivery资格。

状态区分idle、preparing、submitting、unknown、rejected和confirmed。页面观察当前意图的确定管理拒绝以及原回执核对拒绝，权限撤销不改变原已确认回执，也不把unknown转为成功或回滚。确认使用原operationId、issuedAt、actor、owner、种类、目标、hash和版本关系；首次确认的operation结果作为该意图不可变的已知事实保留，后续矛盾的结果字段报告协议错误且不替换它。响应中的历史operation与当前endpoint/Delivery分别解析，当前投影损坏或随后读取失败不能否定已匹配的原效果。

delivery.redeliver descriptor固定endpointId、deliveryId、ifVersion、ifGeneration和原destinationRevision，请求body只添加操作元数据。仅202进入重投登记确认：configVersionAfter不变，generationAfter为原ifGeneration+1，目标revision不变。当前Delivery可已到更高generation，不能要求它等于原回执；页面分别显示原登记generation和当前generation，实际发送通过后续GET读取。原事件、body、目标、计划与手动机会由服务端[历史设计](webhook-history.md#重投与执行)裁决，浏览器不生成替代事件或重置预算。

每次写入或核对拥有独立取消信号，停止和dispose可结束摘要、准入或网络等待并接收迟到错误；尚未派发的操作按拒绝结束，已派发未确认保留unknown，已匹配回执继续为confirmed。停止后的原工作不能发布当前投影或启动核对，收尾只释放原pending。页面把后续读取绑定原操作及身份暂停代次，暂停、新操作和卸载取消该读取；控制器停止会通知其结果发布工作取消，并递增停止代次阻止已停止结果再创建延迟工作。跨暂停的已确认结果由页面持有可取消的延迟发布；恢复准入后仅在原操作、编辑实例、草稿和导航仍匹配时刷新、撤回、关闭或导航。现有临时身份暂停不主动停止在途写入，账户刷新入口负责在最终启用时调用停止入口。unknown自动活动仅尝试读取原GET回执，失败保留unknown和原ID，显式核对继续使用原scope。sessionStorage仅存最小prepared metadata，body只在内存；重载后没有body不能重发。只有读取、解析并绑定scope成功的prepared metadata才恢复为unknown；存储不可读或损坏保留明确persistenceError，不宣称原操作回滚或记录已清理，当前文档的新明确提交仍保留完整固定意图和核对ID。删除pending记录核对原operationId，旧控制器不能清除另一个操作；dispose移除内存正文与私有投影。存储清理失败由认证壳继续完成身份隔离并保留可重试的opaque主体记录。

回执nullable overlapUntil来自原持久化结果；逻辑到期由数据库时钟决定。GET404和重放410只说明回执当前不可确认，不能证明回滚，详见[回执决策](../../.agents/notes/implemented/bug-fix/2026-11-08-webhook-receipt-results.md)。[浏览器管理决策](../../.agents/notes/implemented/architecture/2026-11-08-webhook-web-management.md)记录共有基础，[投递资料决策](../../.agents/notes/implemented/architecture/2026-11-08-webhook-web-deliveries.md)记录共同观察与原字节验证的原因。

## 配置、资格和秘密

配置对话框将明确编辑字段与版本基线分开保存。手动查看冲突后的当前版本刷新未编辑值，保留编辑值；双方都改变的字段须明确选用当前值、保留本人修改或重新编辑，重复查看不会自动解除冲突。提交只包含已明确解决的编辑字段与观察版本；订阅dialog提交完整最终数组及显式confirmProjectIds。创建dialog对已选但不在当前权威目录中的项目保留可取消复选框，仅显示原ID，复用订阅选择的不可用项目回退方式；目录刷新不擅自改变用户选择或保留旧名称和归属标签。服务端裁决实际资格和字节边界，前端目录不替代授权。扩大与启用遵循catalog能力，暂停、删除和范围收缩仍使用管理权与原CAS。

独立secret GET只在当前capability获准时读取。返回key与当前版本匹配才展示；离开配置区域、窄屏返回列表、响应式切入列表模式、轮换、降权或账号变化撤下旧值并失效未完成秘密读取，再次进入须重新GET，隐藏面板不保留可显示秘密。复制失败提供可选中明文的当前文档操作，不写额外持久存储。历史轮换结果保持原key和截止，当前secret另读。

## 验证与交付

单元验证负责wire、版本、状态机、存储和UI生命周期边界，包含跨列表/详情/payload限制、仅目标URL收缩、Attempt404与在途读取竞争、跨载荷期限迟到响应及权威历史失效。无头浏览器连接同一生产RegisterRoutes、真实认证和PostgreSQL，通过真实第二客户端、barrier及仅转发的故障层验证业务效果；接收结果与签名使用实际发送器和受控HTTPS接收方。临时fixture只接线模块，不复制业务handler或成功JSON。合法边界载荷fixture只证明独立原字节接口与浏览器上限，不把安装的边界内容冒称实际事件渲染输出。

内容区与dialog对照视觉输入的样式向量、局部geometry和像素，生产shell单独核对控件、响应式与导航。全页截图保留shell起点、宽度、页头及边距差异，只允许对齐外层可用内容盒。未变化背景检查同时验证节点身份、草稿、选区、焦点、滚动和分页；产品测试不导入原型或场景状态。局部模块验证不替代完整应用生命周期与物理保留清理的组合证明。

状态与 Team 筛选采用公共 `NativeSelect` 的 filter 变体，订阅 Project 和投递筛选采用 form/fill；页面仅负责外部宽度和布局，公共层负责箭头、间距、焦点及禁用外观。选项、归属与提交时序仍由页面管理，投递筛选变更只更新草稿。公共接口和几何见[原生选择组件](native-select.md)。

选择字段的定向浏览器回归挂载生产页面并控制 API 响应，测量箭头与选择框几何、响应式布局，操作原生选择并核对查询与背景复核连续性；这项局部视觉和交互检查不替代真实服务的业务效果验证。
