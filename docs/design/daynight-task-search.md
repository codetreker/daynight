# 项目内 Task 搜索设计

[搜索接口需求](../spec/daynight-task-search.md)定义表达式、投影和可观察结果。服务端是语法与匹配的唯一权威；CLI 和 Web 消费同一个只读接口。

`internal/core/model/tasksearch/` 定义共享的纯表达式数据合同；`internal/core/tasksearch/query/` 解析表达式，保存原始 Unicode 位置并将否定下推到叶节点，不展开 DNF。解析器、Go 证据计算与 PostgreSQL 编译器使用同一合同，store 根包不依赖搜索业务。搜索操作位于 `internal/core/tasksearch/`，通过 `internal/core/store/task_search.go` 的无驱动合同读取；PostgreSQL SQL 位于 `internal/core/store/postgres/task/`。HTTP 路由、专用 DTO 和服务组装分别由 `internal/server/task/`、`api/` 和 `internal/service/` 持有。

SQL 先按项目和结构化条件限定候选，用物化的 `folded` 和 `atom_hits` 分别对需要的文本每行折叠一次、对每个唯一字段和词计算一次命中；用户词仅作为参数。匹配、完整 ID 精确命中和标题优先级从同一 NNF 生成。排序和总数先于 keyset 分页；cursor 使用完整 ID 精确命中、标题命中、更新时间和 ID 四键定位。Task 自身 ID 的完整、前缀和中间片段匹配与标题、描述共同参与表达式；未成立分支、否定条件和非完整 ID 片段不增加精确 ID 优先级。

`Matches` 一次返回完整保存的标题、描述和分页排序元数据。Go 对原文计算成立分支中的正向证据，只生成实际返回项的唯一描述摘录。SQL 不为每个 atom 构造展示字符串，也不以读取字节上限截取标题或描述。自然查询、扫描、计算取消和响应编码错误继续传播。

只读 repeatable-read 事务依次读取实时权限、由项目 epoch、全部 Task 行数及精确版本总和构成的围栏、匹配页与完整上下文。v2 游标绑定主体、项目、原始查询摘要、规范筛选、围栏和四个排序键，严格拒绝旧格式、缺值和非规范编码，不保存服务端搜索会话。任意正式 Task 变化导致续页拒绝，避免把不同快照拼为一个结果；无变化的回滚和 no-op 不改变围栏。

本页全部命中 IDs 共同传入一次 `ContextGraph` 批量操作，分别读取完整普通依赖弱连通闭包的轻量节点和内部普通边。外部边不合并分量，不逐分量重复计数或查询，也不复查存储节点或边容量。Go 按普通入度为零、`createdAt` 和 ID 选择代表，再批量读取去重的代表标题；SQL 不复制代表选择规则或用 NUL 哨兵表示超大标题。[批量读取决策](../../.agents/notes/implemented/simplification/2026-11-09-task-canonical-batch-reads.md)记录职责与查询成本。

独立 5 秒搜索期限覆盖解析到组装，事务仍使用独立有界 rollback，原操作、提交和清理故障不会变成成功。原始表达式、筛选、请求分页及 cursor 限制保留。结构化日志保留请求、项目和主体关联，不记录表达式、正文、摘录、游标或驱动文本。

当前方案以项目范围线性扫描换取短词、纯否定和 Markdown 字面匹配的一致语义；未引入 FTS、搜索索引、搜索会话或全项目描述同步。读取直接使用规范存储表示，不重复结构或容量校验，也不设置领域读取响应字节预算；既有写入规则不转化为新的项目累计配额。存储优化必须保留同一表达式、证据和分页合同。
