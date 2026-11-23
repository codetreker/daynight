# Task 直属父项读取与领取

## 关系事实与表示

`tasks.parent_id` 保存同项目的真实直属父项。统一资源视图提供直属 `parent_type`，store 将两者传入 Task、图节点、同步记录及搜索项；锁定物理行的读取在同一语句取得父类型。转换集中在 `internal/protocol/task`，公开适配器不逐项查询父资源。

默认表示中的 `parentId` 始终是直属 Goal UUID。普通父项在该表示中得到 `parentId: null`。HTTP 请求使用 `Daynight-Task-Relations: task-parent-v1`，MCP 参数使用 `taskParentView: "v1"`，显式选择包含 `parentTaskId: UUID | null` 的表示。两字段最多一个非空；无直属父项和直属 Goal 的扩展表示均保留 `parentTaskId: null`。未知选择值被拒绝。

此选择适用于完整 Task、列表与 Ready 摘要、图节点、同步记录和搜索项，以及完整 Task 写回执。最小回执、Task Chain、工作引用和 My Tasks 保留各自的字段集合。My Tasks 的 Goal ID 与标题取自同一次直属 Goal join；普通父项通过普通 Task 详情访问。HTTP 保留 `no-store`，使用 `Vary: Daynight-Task-Relations` 区分表示，CORS 接受该请求头。写入响应准入使用请求选定的表示计量新增字段，保留默认表示的精确字节边界。

搜索内部批量读取本页真实直属父项标题。默认 `context` 只与非空 Goal `parentId` 配对。普通父项仅在扩展表示使用 `parentTaskContext: {taskId,title}`，与 `parentTaskId` 配对；默认响应不增加这两个字段。

## 直属筛选与分页

REST 列表与搜索、MCP 列表、搜索和 Ready 接受非空 UUID `parentTaskId`，只匹配同项目可见普通 Task 的直属孩子。它与旧 `parentId` 筛选互斥，也不能选择 Goal 类型。筛选语义与表示选择独立。

旧 `parentId` UUID 仅匹配直属 Goal；列表的 `none`、搜索和 MCP 的 null 匹配没有直属 Goal 的普通 Task，包括普通父项的孩子。省略两种筛选均不限制直属关系。所有条件在排序、分页和 lookahead 前执行；游标绑定规范化后的两种筛选，修改筛选须重新开始。五态选择、Task Chain 的依赖关系和 Goal 的直属进度含义保持独立。

## 祖先 Goal 与 Worker

自动候选与领取事务共用同项目递归祖先查询。查询从目标的真实 `parent_id` 向上，通过 `UNION` 按完整节点事实收敛，存在 `done` 或 `cancelled` 的 Goal 即拒绝新领取。候选筛选不改变普通 `ready`、`blockedBy` 或自有 active claim 库存；已有执行继续遵守原 claim 规则。

项目写锁稳定父链和状态。实际开始 Task 前，DAO 计划目标及本次可能启动的直属 todo Goal，按 UUID 升序一次取得 Task 行锁，再进入 Worker configuration 与 execution 检查，保持 Project → Task → Worker 的顺序。手动进入 `in_progress` 与 Worker 领取共用该启动路径。`PrepareParentStart` 遇到普通父项立即保留其状态；只有直属 todo Goal 随实际 Task 启动在同一事务推进，更高层 Goal 保持原状态。任一写入失败整体回滚。

## 验证职责

协议测试验证默认精确字段集合、显式 null、搜索上下文配对、缓存头、非法选择及写回执计量。真实 PostgreSQL 的内部关系夹具覆盖五态直属分页、搜索、图、同步、Ready、My Tasks、祖先隐藏和权限；Worker 夹具开放实际执行准入，读回开放 Goal 下的深层新 claim 提交，核对普通父项和更高层 Goal 未改变，验证终态祖先拒绝新 claim 且保留原库存，以及直属 todo Goal 启动与 claim 同事务。关系夹具最多使用五条普通 Task 父边。公开创建普通父边由独立写入准入负责。
