# Task 负责人设计

状态：原生负责人列、事务与查询，以及Web负责人写入/展示/筛选和schema4缓存已实现。[需求](../spec/daynight-task-assignment.md)拥有行为，取舍由[基础决策](../../.agents/notes/implemented/architecture/2026-11-03-task-assignment-foundation.md)拥有。

## 数据所有权

`core.Task`、`store.TaskWrite` 和 HTTP Task/summary/graph DTO 使用可空 `AssignedTo`。数据库列为 `tasks.assigned_to uuid NULL`；响应的 assignedTo 不使用 omitempty。它是普通 Task 元数据，properties 的静态定义与独立行模型保持原有职责。

迁移 `028_task_assignment.sql` 增加列及 `(project_id, assigned_to, created_at, id) WHERE deleted_at IS NULL` 索引。既有行包括软删除行取得 NULL，其他任务事实与历史迁移 checksum 不变；不添加外键或历史身份推断。负责人查询直接复用该索引，不增加 DDL。

## 输入与完整候选

create 的可选 string 指针表达默认未分配和显式目标。PATCH 使用字段存在性与可空值区分省略、null 清空、UUID 设置，server/service 的至少一个字段检查包含外层存在性。HTTP 拒绝错误类型和未知字段，service 在构造与比较候选前规范化非 null UUID。

中性任务写入模块拥有 currentTaskWrite。普通 metadata 候选、状态、worker 和属性操作从同一完整当前值构造，复制 AssignedTo 并 clone properties；修改候选不改变当前快照。PATCH changed 比较包含负责人值相等性，不比较指针地址。

```mermaid
flowchart TD
  Input[严格输入 / UUID 规范化] --> Prepare[项目权限 / 精确版本 / 完整候选]
  Prepare --> Noop{明确 no-op 或删除}
  Noop -->|是| Existing[沿用已有返回或删除分支]
  Noop -->|否| Compare{负责人实际变化}
  Compare -->|否| Persist[原任务写入]
  Compare -->|是| Running{当前 in_progress}
  Running -->|是| Refuse[暂存领域拒绝]
  Running -->|否| Access[新目标非空时验证项目访问]
  Access --> Reset[候选 allowAgents=false]
  Reset --> Persist
```

## 共用规则与错误

Tasks.write 在明确 no-op/删除路径之后，只对真正 create/update 的完整候选执行负责人策略。等值状态和 worker 摘要可能没有候选 values，不能把零值解释成清空负责人。

策略只在负责人实际变化时检查执行状态和新目标资格，然后强制关闭许可；同一 SQL 写 assigned_to、allow_agents、版本与更新时间。赋值相同则保留其他合法修改，历史目标即使失权也不阻止无关操作。状态不变使既有 SQL 计时 CASE 保留原区间。

策略拒绝和候选准备拒绝使用同一错误分类。目标 Member 不存在明确转为 invalid_input，避免被外层误译为项目不存在；Fault 暂存，在事务正常完成后返回。事务提交、回滚、取消或存储失败优先于暂存拒绝并保留错误链。

## 一致读取与执行边界

完整 Task、task-sync 和图各自的 projection/scanner/assembler 直接读取 assigned_to::text；字段、版本、依赖和属性属于同一既有读取快照。summary 与图携带轻量 UUID，不嵌入可变用户资料。

锁序保持项目→父任务→属性→Session。成员变更共享项目锁，工作领取仍绑定认证调用者。负责人变化不重写 worker 或 Session/archive 身份；released/completed 历史继续保留，新的负责人不因此获得旧执行的控制权。

## 原生任务筛选与游标

HTTP 单值 assignedTo 输入在 service 边界转换为显式 all/unassigned/user 选择，零值是 all。me 先解析为 principal.UserID，user 选择仅携带规范 UUID；选择本身可比较并参与游标范围，不为被查询的人增加成员资格要求。

Snapshot.Tasks 按规范选择使用静态 SQL 片段：all 不增加条件，unassigned 使用 assigned_to IS NULL，user 使用绑定的 UUID 等值。输入值只作参数，不拼接 SQL。条件在 ORDER/LIMIT 之前；worker inventory 分支同样先应用显式原生条件，再执行既有 worker 解码、归属匹配和最终 limit+1。已确认的worker新候选选择me；完整既有claim库存仍为all。本人自动领取运行时由待合并的[PR #322](https://github.com/codetreker/daynight/pull/322)交付。

page.go 仅为 kind=tasks 编码和要求 cursor version 2，并保存必需的规范选择 all/unassigned/user:UUID。项目列表和账号级 Worker 列表继续使用版本 1，不编码任务选择字段；workerId 筛选的 Task 页仍是 tasks version 2。任务旧版本拒绝，而 me 与对应 UUID 在规范 scope 相同时可续页。项目、状态、ready、许可、平台、workerUser/workerId 和位置仍绑定原 scope。

## 项目内人员读取

Tasks 服务和 taskHandler 复用既有项目读取组合，专用 core/API 条目恰含 userId、nullable name、nullable avatarUrl 与 hasProjectAccess；响应始终有 items 和 unresolvedUserIds 两个非 null 数组。资料保持 canonical users 的实际 nullable 值，不合成姓名或邮件。

HTTP 以局部 query 解析只允许重复 userId，不放宽共用 queryValues 的单值规则。省略参数是完整目录；明确的限定模式先校验非空、最多 100 个互异规范 UUID。service 同样验证直接调用，避免空数组被当作完整模式。两个模式均在一次 ReadSnapshot 内先 RequireProjectRead，再读资格和资料。

### 完整目录

从原始 project_members.user_id 与当前项目未软删除 tasks 的 DISTINCT assigned_to 做 UNION，再 LEFT JOIN users，并读取原始候选 ID 与 nullable users.id。这样仍有原始关联但用户行缺失时可以报告完整性错误，不会被 INNER JOIN 静默删去。成员存在性给出 hasProjectAccess；只有软删除任务的引用不保留资格。结果按 UUID 排序，unresolvedUserIds 为空。

### 限定解析

从最多 100 项的 unnest(requested UUID array) 出发，以成员主键及项目内 assigned_to 索引的 LATERAL LIMIT 1 探测资格，再按资格 LEFT JOIN users。限定模式不先枚举全项目负责人，工作集合只来自请求 ID。

| 资格与资料 | 组装结果 |
|---|---|
| 无成员与当前保留任务资格 | unresolved；不暴露全局 users 是否存在 |
| 有资格且 users 行存在 | 最小资料，保留 nullable name/avatarUrl，明确访问状态 |
| 有原始资格但 users 行缺失 | 内部完整性错误，整个读取失败 |

Go 组装仍验证规范 ID、互斥和完整覆盖：items 与 unresolved 恰好覆盖规范请求一次，各自稳定排序。query/scan/rows/取消或事务失败不安装部分集合。错误不借用 ErrNotFound 表示资料缺失，避免外层误译为项目 404。

完整目录面向显式打开或重试；周期消费者使用当前展示/选中 ID 的限定模式，空集合不发请求，不能省略参数退化为全量。Web消费和刷新由认证scope内的TaskAssignees拥有，人员资料不写入Task版本或浏览器持久任务记录。当前基线CLI负责人消费者仍由其独立客户端交付。

## Web 字段与任务写入

TaskDetailSession 继续唯一拥有所有 Task mutation，assignedTo action 复用普通 PATCH helper。规范目标与previous值比较决定预期v或v+1；等值保留updatedAt/许可，实际变化要求目标/false及其他材料保持。所有其他action也核验assignedTo未变，withdraw只获准移除其worker归属。

HTTP200确认后才能抬高已提交版本下限；响应读取失败或未知结果沿既有GET核对队列，不重放PATCH。更高版本完整当前值可替代原意图，旧历史/旧owner不能发布结果。确认、摘要同步与详情持久化继续属于现有ticket/generation边界。

Web所有Task/detail/summary/graph解析和比较纳入assignedTo。schema4复用既有升级事务，1/2/3直接清除projects/summaries/details、清水位并轮换user fence；新字段消费者与此重建同时交付，不把缺字段解释为null。mutable profile不进入IDB或Task version。

## Web 人员与界面所有者

TaskAssigneesProvider在认证TaskCache边界中为当前scope提供TaskAssignees。当前挂载行、详情和具体过滤以独立symbol登记ID需求，合并、排序去重后分100项；空集合不请求。ProjectPage与独立TaskDetailPage将graph-owner symbol和正revision登记为receipt；重挂载的revision从1开始仍可触发读取，不能用全局lastRevision单调判重。

限定读取在途时合并一个后继刷新，避免慢请求每5秒被取消而永不完成。完整目录只由打开/重试触发。capture从已授权内存manifest取得userFence/cacheGeneration等ticket，不调用beginSync重复验证整项目持久摘要；scope.ready前后均检查身份、历史、需求及所有权，正结果在无await段发布。

people map按每个人最新派发序号合并，晚到catalogue不能覆盖较新限定结果；unresolved同样保留顺序fence。可信同用户404先由scope.canRevokeProject核验捕获ticket，再沿scope.signal撤权；菜单关闭或需求变化不丢失父项目失权，旧E1不能清新E2。错误与清理故障保留原状态和原因，不制造失权资料。

TaskAssigneeIdentity显示真实nullable姓名/头像，name缺失显示短UUID，图片失败使用当前身份首字形态；不生成email。TaskAssigneeSelect紧邻状态24px成组，TaskAssigneeFilter拥有all/me/unassigned/user显示状态。AssigneePicker的fixed菜单在surface的焦点所有者子树内，尺寸和12px边界按视口计算，随scroll/resize/fullscreen及进入动画稳定定位；键盘与Escape/Tab/外部点击保留现有详情层级和焦点。

ProjectPage从完整index导出匹配ID，再在显示集合和分页前相交；ChainList保留完整component进度和依赖，仅裁剪展示的子任务集合。概览与图不继承负责人过滤，显式概览定位可回到all以展示目标。新增界面不使用规则旁白，只有必要错误、访问状态和恢复入口。

## 观测与验证

复用 request_id、user_id、project_id；目录 component=task_assignee，phase=catalogue/resolve，记录数量及耗时，不记录请求 ID 集合、姓名、头像或邮箱。HTTP context 贯穿授权、快照与查询，无后台任务或新调度边界。原始错误链保留在内部，响应与日志沿用清洗分类和事务完成优先级。

真实 PostgreSQL 验证迁移保全、三套字段投影、nullable 输入、等值及失权目标、全部写入保留、竞态和后续失败回滚。原始 JSON 检查字段存在；迁移 026 的历史事实测试固定其历史 schema，现行迁移另行覆盖。

查询验证过滤先于分页、完整 scope、旧任务游标拒绝和其他列表版本不变、worker inventory组合及其独立执行归属保持；本人候选和claim事务规则由PR #322验证。目录验证两种模式的原始引用完整性、隐私、精确覆盖、100/101 边界、真实快照并发及所有失败路径。至少 10000 任务和 100 人员的生产查询 EXPLAIN ANALYZE BUFFERS 与响应样本绑定被测代码；数量样本不改变 Web 图规模限制，也不是生产容量上限。

Web验证覆盖字段/schema4升级、mutation同值/确认下限/材料保持、people需求/receipt/派发和负向撤权fence、完整链筛选、菜单焦点及双语窄屏。生产功能场景task-assignment与task-assignment-layout分别拥有真实写入/未知结果核对，以及身份/布局/完整图显示的验证；完整inventory由Web验收所有者定义。
