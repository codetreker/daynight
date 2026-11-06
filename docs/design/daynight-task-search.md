# 项目内 Task 搜索设计

[搜索接口需求](../spec/daynight-task-search.md)定义表达式、投影和可观察结果。服务端是语法与匹配的唯一权威；CLI 和 Web 消费同一个只读接口。

`internal/core/tasksearch/query/` 保存原始 Unicode 位置，解析表达式并将否定下推到叶节点，不展开 DNF。纯证据计算只合并成立分支的正向命中，生成字段与描述摘录。搜索操作位于 `internal/core/tasksearch/`，通过 `internal/core/store/task_search.go` 的无驱动合同读取；PostgreSQL SQL 位于 `internal/core/store/postgres/`。HTTP 路由、专用 DTO 和服务组装分别由 `internal/server/task/`、`api/` 和 `internal/service/` 持有。

SQL 先按项目和结构化条件限定候选，用物化的 `folded` 和 `atom_hits` 分别对需要的文本每行折叠一次、对每个唯一字段和词计算一次命中；用户词仅作为参数。匹配与标题优先级从同一 NNF 生成，原文在页确定后读取，纯证据计算独立核对返回行。排序和总数先于 keyset 分页。

只读 repeatable-read 事务依次读取实时权限、由项目 epoch、全部 Task 行数及精确版本总和构成的围栏、匹配页与闭包。游标绑定主体、项目、原始查询摘要、规范筛选、围栏和排序键，不保存服务端搜索会话。任意正式 Task 变化导致续页拒绝，避免把不同快照拼为一个结果；无变化的回滚和 no-op 不改变围栏。

普通依赖的弱连通闭包按本页命中批量读取，外部边不合并分量。先在数据库计数并检查节点与边预算，再物化轻量节点和边；按普通入度为零、`createdAt` 和 ID 选择代表，最后批量读取代表标题。独立搜索期限覆盖解析到组装，事务仍使用独立有界 rollback，原操作、提交和清理故障不会变成成功。结构化日志保留请求、项目和主体关联，不记录表达式、正文、摘录、游标或驱动文本。

当前方案以项目范围线性扫描换取短词、纯否定和 Markdown 字面匹配的一致语义；未引入 FTS、搜索索引、搜索会话或全项目描述同步。存储优化必须保留同一表达式、证据和分页合同。
