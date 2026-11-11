# Goal 容器需求

Goal 是具有独立身份、标题、描述、负责人、状态、Thread 和附件的项目资源。普通 Task 可归属于同项目的一个 Goal，也可不归属；Goal 不嵌套，不属于依赖图。现有 Task、资料和依赖不因引入 Goal 而迁移。

HTTP 和 MCP 创建接受 `type=goal`；省略类型创建普通 Task。类型创建后不可更改。普通 Task 的 `parentId` 可在创建时指定，更新时省略保持、null 移出、Goal ID 转移；目标必须是同项目中未删除的 Goal。归属变化使用子 Task 的精确版本，不改变依赖、状态或其他 Task 的版本。父 Goal 的状态不限制归属和普通 Task 的手动修改。

Goal 默认 `todo`，负责人默认创建者；显式 `assignedTo:null` 表示未分配。Goal 可在 `todo`、`in_progress`、`done`、`cancelled` 间自由转换，同状态在版本检查后不写入。进入 `in_progress` 记录新的 startedAt；返回 `todo` 清空三个状态时间；进入 done 或 cancelled 保留可空 startedAt，分别记录 completedAt 或 cancelledAt 并清空另一终态时间。Goal 的 ready 始终为 false，不支持依赖、Steps、自动执行、平台要求或 Worker claim；可使用 `pullRequests`、Thread 和附件。

Goal 的进度按直接可见普通子 Task 汇总总数、done、cancelled 和未结束数量；进度不自动改变 Goal 状态。完成或取消 Goal 不改变、隐藏或停止孩子，但阻止后续自动领取；已有 claim 和显式 released-claim resume 沿用自身规则。删除 Goal 只软删除容器并轮换项目缓存 epoch，保留孩子的 Parent、状态、版本、依赖和执行归属；孩子及其资料从正常入口不可见，原执行由下次成功库存观察进入既有停止和归档流程。删除成功只表示删除已提交，不表示进程已停止。

MCP 复用现有 Task 工具管理 Goal，`task_list` 可按类型及 Parent 选择，`task_ready` 保持普通 Task 并可按 Parent 选择。查询 Parent 省略表示不限、null 表示未归属、UUID 表示直接孩子；续页绑定筛选条件。Goal 状态写入不需要额外确认凭证。

读取、权限、错误和不确定写入沿用 Task 资源合同。独立 Goal 的图、子 Task 及外部 Goal 对话框支持浏览器前进和后退；项目页的图、详情及 Goal 子层也可按阅读顺序前进和后退。详细事务与调度机制见[服务端设计](../design/daynight-server.md)，阅读历史、关闭和草稿行为见[任务浏览需求](daynight-task-inspection.md)。

Web 的 Goal 列表提供创建入口；详情提供名称、描述、负责人和四态修改，以及新建或加入 Task 的入口。Task 详情提供归属选择，可移出或转移到同项目的其他 Goal。完成或取消 Goal 前确认 Task 状态保留、后续自动领取被排除且已有领取继续；删除前确认 Goal 及其 Task 不可见、Parent 保留，执行中的 Task 在后续成功观察中开始停止。取消确认不提交，未结束 Task 不阻止确认。

表单失败时保留输入并显示错误。版本冲突后应先核对当前资源再作决定；写入结果未知时只能核对当前状态，不能自动重放或把当前值当作原请求成功的证明。归属和状态变化更新实际列表与进度，并保留详情的阅读、展开和草稿状态。
