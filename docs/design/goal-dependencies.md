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

`goal-acceptance-graph` 是 Goal 节点的验收关系视图，`GoalGraphDialog` 和 `GoalTaskGraph` 继续承担普通子 Task 的整体执行图。项目 Goals 工具栏打开独立的验收图浮层；项目现有 `useTaskGraph` 所有者以 `syncedSnapshot` 暴露已经提交且未经详情回执投影的摘要基线，`GoalAcceptanceHost` 将其交给画布。图不建立第二个同步读取生命周期，也不以详情回执的临时投影更新边。请求、epoch/since、水位与轮询继续由[任务同步](daynight-task-sync.md)拥有。

`projectGoalAcceptance` 从 typed 摘要选择 `todo` 和 `in_progress` Goal 根及其直接项目内前置，保留孤点与终态前置，省略无关终态。图边只从 Goal 的 `dependsOn` 生成，不使用普通 Task 索引推断验收关系。局部前置和下游索引供检查及高亮使用；检查栏按真实状态区分已满足与已知阻塞，同时明确本项目覆盖和全局待核验。TaskSync 不包含跨项目关系或权威验收阻塞，不能由已知边推导全局可完成。

`GoalAcceptanceGraph` 与专属 Goal 卡片复用中立布局、几何缩放、边绘制、检查配色及工具栏，保持 Goal 自身四态和独立 Details 动作。选择不参与拓扑键，状态或标题变化只更新内容；拓扑变化通过已有节点位置锚定新几何，保留有效选择与视口。方向或显式全图动作决定新的 framing，手机检查栏按布局断点置于画布下方。

验收图使用 `TaskGraphDialogShell` 的 portal、全屏、焦点约束及分层 Escape。项目详情 owner 将图内 Goal Details 归入同一阅读层，保留背景列表和关闭回焦。同步失败沿现有项目反馈保留仍获准内容；账号、项目或历史准入失效仍撤销相应阅读资格，最后显示的数据不能重新授权详情。项目图与现有普通 Task 图的地址和范围分别拥有各自语义。需求由[Goal 验收依赖图](../spec/daynight-goals.md#goal-验收依赖图)拥有，取舍见[验收图决策](../../.agents/notes/implemented/feature/2026-11-23-project-goal-acceptance-graph.md)。

## 验证归属

core 测试拥有编辑规则和隐藏投影，service 测试拥有 scope、授权快照调用及 completion 处理。真实 PostgreSQL 测试证明 ACL 过滤先于 LIMIT、修订持久化、无远端行锁的图串行化、跨项目闭环、完成与新增竞争，以及撤权和项目移入交错。项目转出再转回及边集恢复原样后，旧修订仍须拒绝；隐藏边可单独移除并保留其他关系。普通 Task detail、sync、图及 ready 继续由各自协议与存储测试保护。
