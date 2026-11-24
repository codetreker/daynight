# Goal 验收关系服务

## 职责与数据

Goal 验收语义由[Goal 需求](../spec/daynight-goals.md)定义。`core/task` 拥有关系编辑、完成约束和投影规则，`service/task` 协调快照、Project 写事务与 Team 图锁；`core/store` 定义关系读取与编辑能力，PostgreSQL DAO 实现 SQL 和持久化。关系操作使用独立入口，不经过普通 Task 元数据 mutation；真实改边同事务推进下游 Goal 的 Task 版本和更新时间。TaskSync 摘要批量包含项目内直接验收前置；跨项目关系及验收阻塞仍由独立关系读取提供。

Goal 边复用 `task_dependencies` 中固定的 `dependency_type='goal'`，每条边持有独立随机 `goal_edge_id`。保留一条边会保留其 ID；删除再新增产生新 ID。`goal_dependency_revisions` 独立保存下游关系修订，初始逻辑值为 1，实际变化推进一次，空操作保持，清空保留已写修订。修订耗尽拒绝整次编辑。项目清理继续遵循[原子清理机制](daynight-server.md#项目生命周期中的-goal-边清理)。

## 授权读取

读取在同一 repeatable-read scope 中取得源 Goal、当前权限、修订、前置及后继。前置最多 30 条，按边 UUID 排序；完成阻塞由全部真实前置状态决定，包括隐藏前置。可读目标包含实际 Project、Goal、标题、状态和 internal/external 类别。隐藏前置的 target 为空，只有编辑者获得 opaque edge UUID；只读投影省略 edge UUID 和修订。

后继查询先通过 Project access 关系和有效删除条件过滤，再按下游 UUID 排序、游标续页及 lookahead。默认 20、最多 50 条，不计算或暴露隐藏下游总数。游标绑定调用者身份、源 Project、Goal、页大小及排序位置；续页重新授权，不代表冻结的图快照。直接 Project grant 和 Team membership 均参与访问。

## 项目内前置批量读取

`TaskReader.TaskSyncGoalDependsOn(ctx, projectID, goalIDs)` 为摘要消费者提供同项目 Goal 前置的批量读取。在已有只读快照的 callback 内，调用方先用 `TaskSyncTasks` 选择完整或更新时间窗口内的摘要，再传入该批次的 Goal ID；查询不另建快照或时间水位。调用方负责项目读取准入。

PostgreSQL 查询限定所选源 Goal 和前置 Goal 均为本项目、有效且 `type='goal'`，只读取 `dependency_type='goal'` 的边。目标不受摘要更新时间窗口限制，因此本批次有变化的 Goal 仍能取得未变化的直接前置。返回 map 仅包含选中的有效源 Goal，每项为按 UUID 排序的完整直接前置 ID；无边为非 nil 空数组。空输入返回非 nil 空 map；普通 Task、外项目、缺失及有效删除的源不产生条目。读取只投影 ID，复用现有下游关系主键，不新增索引或锁。

公开 TaskSync 通过 `core/task.ReadSync` 组合摘要和此批量结果。`TaskSyncTasks` 先返回原 typed 摘要，`ReadSync` 在同一个读取快照中只收集本批次 Goal ID，调用一次批量读取并覆盖对应 Goal 的 `dependsOn`；没有 Goal 时跳过。Goal 的 `externalDependsOn` 始终为 `[]`。snapshot 和 delta 都返回选中 Goal 的完整前置，无项目内边明确返回 `[]`；实际改边推进下游 Goal 的 Task version/updatedAt，删除最后一条边因此可由正常增量观察。`TaskSyncDependencyStates` 和 ordinary graph 仍只处理普通执行依赖。跨项目 Goal 关系继续由上述独立关系读取提供。服务端输出与浏览器 schema 14 的一次旧摘要重建共同启用，部署顺序和详情字段覆盖遵循[摘要同步设计](daynight-task-sync.md)。取舍见[批量读取决策](../../.agents/notes/implemented/architecture/2026-11-23-goal-prerequisite-batch-reader.md)和[Goal 摘要决策](../../.agents/notes/implemented/architecture/2026-11-23-goal-summary-admission.md)。

## 写入事务

独立编辑操作先校验 principal、UUID、正 int64 修订及 edit/replace 的结构和容量。edit 至少有一项添加或移除；replace 必须给出整个 prerequisites 集合，允许空数组。保留臂使用当前下游的 edge UUID，新增臂使用 Project/Goal UUID。重复项、相互冲突的操作和其他下游的边均拒绝。

事务先锁本地 Project，再取得其当前 owner Team 图锁。取得图锁后，一条 SQL 同时读取下游读写授权、所有新增目标的读取权限、端点有效类型、状态和两侧当前 owner Team。单条语句保证这些事实曾同时成立；先读本地权限再分语句读目标，会把撤权前的权限与项目移入后的归属拼接成不存在的授权时点。权威读取不取得远端 Project 或 Task 行锁。

core 先比较原关系修订，再建立最终边集合。新增目标必须可读、为未删除 Goal，且属于同一 owner Team；不可用目标使用统一故障。递归查环覆盖真实图，包括隐藏端点，并排除本次删除的边。最终前置不得超过 30 条，已完成下游的全部最终前置必须完成。所有检查通过后，DAO 原子保存最终边和下一修订，并使用锁后数据库时间推进下游 Goal 的 Task 版本和更新时间；任一版本耗尽或写入失败回滚整个事务。真正空操作不写。Team 图锁同时约束状态、删除及项目清理，避免两次跨项目编辑闭环或完成与新增未完成前置并发提交。

编辑继承调用方取消并有有界事务预算，涵盖连接池和锁等待。只在确认 committed 后返回 goalId、revision、changed。拒绝、已确认未提交和提交未知保留各自语义；未知结果不能推断回滚或重放。后续读取仅证明当前状态，不能恢复丢失的写回执。

## 协议适配

独立 `GoalDependencyRoutes` 注册 GET/PATCH 及认证的方法拒绝，使用窄的读取／编辑服务接口。`internal/protocol/goaldependencies` 通过共享纯函数解析 edit/replace 的字段存在性、嵌套引用和精确修订，并映射显式 DTO。HTTP 只负责请求预算、query、认证、调用和错误／回执编码，不在 handler 重做图准入。现有错误分类器只有在事务结果可靠时才公开领域拒绝，提交未知继续由共享写入分类处理。完整字段和错误码归[REST 协议](../spec/goal-dependencies.md)。

## Web 只读关系

`GoalInformation` 的首节使用 `GoalDependencies` 展示服务投影，桌面位于描述右侧，窄屏跟随描述堆叠。可读条目使用真实 Project/Goal URL 和四态标签，外部条目显示 Project；隐藏前置仅显示无法访问，阻塞直接使用 `completionBlocked`，不从可见条目推断。关系只读，原有 Goal 状态操作独立提交，依赖拒绝后刷新关系并在右栏反馈。

关系资料的独立内存读取与普通 Task detail、sync 和图分开；真实关系编辑推进源 Goal 的元数据版本。描述页可见时使用现有同步轮询节奏读取，隐藏时取消，保留仍获准的页和内容。下游的上一页／下一页保存游标路径，每次只读取当前页；每页重新授权。瞬时刷新失败保留已准入内容及重试入口，首次失败与空集合分别表达。

请求绑定当前账号、源项目 history generation、源详情资格及 AbortSignal；发布前重新检查准入。项目权限事件撤回失权目标并作废先前响应，源失权退役关系读取，较旧响应不能恢复身份和状态。账号检查等待保持已有界面，实际身份切换清理旧范围。响应主体仅在 principal 验证后准入；旧服务 router 的无 `Daynight-User-ID` JSON 404 在关系解析前识别为能力不可用，保留已获准源详情。有 principal 的领域级 403/404/410 沿用源权限观察。

普通关联点击经过 `BrowserNavigation` 的草稿保护，修改键保留原生链接行为。外部 Goal 弹窗中的关联若指向当前独立页的根资源，使用 `setView` 原子提交目标 URL 和空的嵌套阅读选择，新增历史条目以保留原弹窗供后退恢复；相同 URL 也必须清除遮挡的弹窗。`goal-dependency-reading` 在账号作用域的内存中按浏览器 entry 和源 Project/Goal 分别保存 history generation、当前下游游标与上一页路径；同一 entry 内并存的阅读器不能覆盖彼此位置。成功准入的读取更新该 entry 的位置，首次进入同一 Goal 的新页签 entry 继承当前阅读坐标，再次访问已知 entry 则重新读取其各自位置，即使 Goal 组件未卸载。位置持续独立于一次性的焦点恢复，前进／后退多次往返都读取该 entry 最近确认的分页；不保存或继承关系资料。源失权、history 改变或账号作用域退役使保存位置失效，包括阅读器未挂载期间。

关联点击记录该 entry 最近的来源链接，只有实际进入对应目标才激活返回焦点；取消草稿导航后改去无关路由会清除链接意图并保留阅读位置。返回取得当前授权投影后聚焦原关联链接，链接已不在该页时回退 Goal 标题。焦点恢复仅消费本次意图，随后原生前进到同一目标再后退可重新恢复焦点。返回后翻页会更新源 entry 的位置，下一次返回使用新位置。瞬时读取失败保留返回位置和焦点意图，重试仍读取该页，不能用第一页提前消耗返回意图。取舍见[Web Goal 依赖决策](../../.agents/notes/implemented/feature/2026-11-19-web-goal-dependencies.md)。

## 项目 Goal 验收图

`goal-acceptance-graph` 是 Goal 节点的验收关系视图，`GoalGraphDialog` 和 `GoalTaskGraph` 继续承担普通子 Task 的整体执行图。项目 Goals 工具栏打开独立的验收图浮层；项目现有 `useTaskGraph` 所有者以 `syncedSnapshot` 暴露未经详情回执投影的摘要基线，`GoalAcceptanceHost` 将其交给画布。最后显示的基线只保持呈现，当前已获准同步基线另行决定关系请求和详情资格。图不建立第二个同步读取生命周期；请求、epoch/since、水位与轮询继续由[任务同步](daynight-task-sync.md)拥有。

`projectGoalRelations` 从完整已同步 typed 摘要构造项目内 Goal 元数据及直接前置／下游索引；`projectGoalAcceptance` 再选择 `todo` 和 `in_progress` Goal 根及其直接项目内前置作为画布范围，保留孤点与终态前置，省略无关终态。项目内边只从同步 Goal 的 `dependsOn` 生成，不从普通 Task 索引推断，也不以独立关系页覆盖。检查栏使用完整项目 Goal 索引，项目内关联的标题和状态同样取自同步摘要，画布之外的可读直接关系不因局部绘图而消失。原始关系贡献只补充外部及检查上下文，不覆盖较新同步的项目内关系或元数据；检查内容不扩大画布，高亮仍按当前可见图计算。子 Task 摘要只提供项目内 Goal 的进度。外部节点保留 `RelatedGoal` 实际提供的 Project、Goal、标题和状态，不合成 Task version、更新时间、权限或子 Task 进度。

`GoalRelationSession` 直接调用既有 `getGoalDependencies`，不复用带轮询和详情资格的描述关系 hook。开图立即绘制项目内结果，并为获准活跃根调度直接关系。最多四个源同时读取，一个源的后继页按游标顺序前进并按 Goal ID 去重；重复游标或不一致的前置／关系修订页是协议错误。每页通过既有身份校验及 scope/history fence 后才使用，30 秒读取期限从真实请求派发起算。首次读取可逐页发布已验证的完整前置和累积后继；已有贡献时，重复遍历将新页暂存为候选，直到全部后继页读取并通过一致性、权限和环检查后才一次替换该源贡献。新遍历的部分页不能提前移除仍获准的旧后继，读取期间的阶段反馈继续更新。贡献只保存在图会话内；隐藏前置保留不可访问提示，不暴露身份，终态下游供检查而不作为默认画布根。

关系会话以 `GoalRelationSource.mode` 的 `root`、`inspection` 和 `expanded` 分别保存活跃根、检查源和显式展开源。未覆盖节点的检查调用其实际 Project/Goal 的既有接口，结果只提供检查详情；显式展开才将相应贡献接入画布。按源 Goal ID 复用读取，检查和展开共享已读页及在途请求，展开晋升不重读已覆盖关系，重复操作不重复生成节点或边。只有沿已获准可读关系到达的外部节点可以成为新源。可达性以 TaskSync 当前活跃 Goal 及其当前直接前置为起点，再沿 root／expanded 的合法外部贡献继续发现。源和目标都属于图所属 Project 时，原始关系贡献不提供可达路径；项目内路径只由同步基线决定，旧 API 边不能保留已从同步范围移除的终态检查源。外部源返回图所属 Project 的目标仍是跨项目上下文，以完整同步索引中的真实本地身份和状态准入；外部终态下游继续只供检查，除非独立成为可见前置。根或关系变化后，画布和检查立即按当前可达范围过滤，会话核对同步取消并移除断开的检查／展开源及排队、在途请求；请求收尾释放并发名额后立即派发仍可达或新增的根，不等待已取消的旧响应到达。旧反向关系不能维持分支。可信拒绝保留无内容的重试状态，但不保留卡片或后续分支；未覆盖、失败或失权不等同于空邻接。

外部节点及边的范围按图所属 Project 判断。接口 target.kind 只描述目标相对请求源 Project 的类别，不决定画布是否显示该关系；展开来自另一 Project 的源时，同一外部 Project 内的真实 Goal 边仍被采用。项目内两端的边继续由 TaskSync 提供，关系检查保留接口返回的完整直接项，不把未展开检查贡献当作布局边。

源的 queued、loading、partial、ready、failed、unavailable、denied、conflict 和 interrupted 状态分别表达覆盖及读取结果。重复遍历失败、候选冲突或接口能力不可用均不证明旧结果失权，保留仍获准且相对当前同步基线合法的旧贡献，并显示实际失败阶段；初次不可用不产生贡献，初次冲突只能保留已验证且仍通过当前环检查的合法前缀。接口不可用和首次失败不能显示为空关系。实际历史、访问权限失效及可信 403／404／410 立即撤回旧贡献，不等待候选完成。未读取或未完成覆盖的检查明确保持全局待核验，已知未完成或取消前置仍可显示阻塞，最终完成资格由服务端写入检查。关系会话没有 interval；活跃根版本／范围变化、未覆盖检查、外部展开、恢复获准阅读和显式重试驱动读取，关闭会话取消排队及在途请求，不写入项目缓存或同步水位。

请求组合会话取消、scope 与主体冲突信号，并在每次发布时检查源读取代次、主体和历史。权限或历史撤回取消在途页，清除相应 Project 的贡献及检查内容；当前项目不再获准时不派发新读。可信源拒绝撤下相应节点和关系，迟到响应不能恢复；源 Goal 拒绝不是整个 Project 不可读的证明。经核验的新页若将已知前置边 `edgeId=E` 的可读目标 X 改为 `target:null`，E 与该源先前记录准确对应时便证明 X 已不可读：立即撤下图会话中的 X 卡片、身份、关系上下文和检查内容，清理其他保留贡献对 X 的旧引用，不等待暂存遍历完成。此前保留或在途的数据即使随后读取为 partial、failed 或 conflict 也不能恢复 X；可读源及同 Project 的其他目标仍保留。目标撤回代次在真实请求派发时取样，撤回前派发的页不能重新准入 X；撤回后新派发且通过当前 scope 核验的可读响应可以重新准入。公开引用清理后，该源私有的 edgeId→最近已核验目标 ID 对应记录仍保留，不进入卡片、关系检查或其他公开上下文；因此 X 被新的可读响应重新准入后，同一 E 再返回 `target:null` 仍能准确撤回 X。没有 edgeId 或无法对应已知边的隐藏项只显示不可访问，不按页位置、缺项或其他目标推断身份。普通候选中的关系缺席及状态变化仍等待完整合法替换，不作为此类撤回。外部贡献按真实端点 ID 去重；候选集合与已同步项目内边一起检查环，独立读取的边反转若形成环则拒绝冲突贡献并保留合法图与重试。更新后的同步基线同样重新核对外部贡献。

`GoalAcceptanceGraph` 与专属 Goal 卡片复用中立布局、几何缩放、边绘制、检查配色及工具栏，保持 Goal 自身四态、外部 Project 标记和独立 Details 动作。检查栏的关系按钮切换到另一 Goal 时，将焦点以 `preventScroll` 移到持续挂载且 `tabIndex={-1}` 的检查标题；标题随选择原位更新，不进入普通 Tab 顺序。关系按钮可能因新选中项而卸载，标题承接焦点使图层保留 Escape 与全屏 Escape，同时保持滚动位置。选择不参与拓扑键，状态或标题变化只更新内容；拓扑变化通过已有节点位置锚定新几何，保留有效选择与视口。方向或显式全图动作决定新的 framing，手机检查栏按布局断点置于画布下方。

验收图使用 `TaskGraphDialogShell` 的 portal、全屏、焦点约束及分层 Escape。`GoalAcceptanceHost` 将图内 Goal Details 交给既有详情与草稿阅读层，保留背景列表和关闭回焦。同步失败沿现有项目反馈保留仍获准内容，关系读取失败在图内按源提供重试；账号、项目或历史准入失效仍撤销相应阅读资格。项目图与现有普通 Task 图的地址和范围分别拥有各自语义。需求由[Goal 验收依赖图](../spec/daynight-goals.md#goal-验收依赖图)拥有，取舍见[验收图决策](../../.agents/notes/implemented/feature/2026-11-23-project-goal-acceptance-graph.md)。

## 验证归属

core 测试拥有编辑规则和隐藏投影，service 测试拥有 scope、授权快照调用及 completion 处理。真实 PostgreSQL 测试证明 ACL 过滤先于 LIMIT、修订持久化、无远端行锁的图串行化、跨项目闭环、完成与新增竞争，以及撤权和项目移入交错。项目转出再转回及边集恢复原样后，旧修订仍须拒绝；隐藏边可单独移除并保留其他关系。普通 Task detail、sync、图及 ready 继续由各自协议与存储测试保护。
