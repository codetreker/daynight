# Goal 容器需求

Goal 是具有独立身份、标题、描述、负责人、状态、Thread 和附件的项目资源。普通 Task 可归属于同项目的一个 Goal，也可不归属；Goal 不嵌套，不属于依赖图。现有 Task、资料和依赖不因引入 Goal 而迁移。

HTTP 和 MCP 创建接受 `type=goal`；省略类型创建普通 Task。类型创建后不可更改。普通 Task 的 `parentId` 可在创建时指定，更新时省略保持、null 移出、Goal ID 转移；目标必须是同项目中未删除的 Goal。归属变化使用子 Task 的精确版本，不改变依赖、状态或其他 Task 的版本。父 Goal 的状态不限制归属和普通 Task 的手动修改。

Goal 默认 `todo`，负责人默认创建者；显式 `assignedTo:null` 表示未分配。Goal 可在 `todo`、`in_progress`、`done`、`cancelled` 间自由转换，同状态在版本检查后不写入。进入 `in_progress` 记录新的 startedAt；返回 `todo` 清空三个状态时间；进入 done 或 cancelled 保留可空 startedAt，分别记录 completedAt 或 cancelledAt 并清空另一终态时间。Goal 的 ready 始终为 false，不支持依赖、Steps、自动执行、平台要求或 Worker claim；可使用 `pullRequests`、Thread 和附件。

Goal 的进度按直接可见普通子 Task 汇总总数、done、cancelled 和未结束数量；进度不自动改变 Goal 状态。完成或取消 Goal 不改变、隐藏或停止孩子，但阻止后续自动领取；已有 claim 和显式 released-claim resume 沿用自身规则。删除 Goal 只软删除容器并轮换项目缓存 epoch，保留孩子的 Parent、状态、版本、依赖和执行归属；孩子及其资料从正常入口不可见，原执行由下次成功库存观察进入既有停止和归档流程。删除成功只表示删除已提交，不表示进程已停止。

MCP 复用现有 Task 工具管理 Goal，`task_list` 可按类型及 Parent 选择，`task_ready` 保持普通 Task 并可按 Parent 选择。查询 Parent 省略表示不限、null 表示未归属、UUID 表示直接孩子；续页绑定筛选条件。Goal 状态写入不需要额外确认凭证。

读取、权限、错误和不确定写入沿用 Task 资源合同。详细事务与调度机制见[服务端设计](../design/daynight-server.md)，浏览行为见[任务浏览需求](daynight-task-inspection.md)。
