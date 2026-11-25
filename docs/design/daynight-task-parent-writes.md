# 普通 Task 父子写入事务

普通父子关系的读取投影和祖先领取规则见[父项读取设计](daynight-task-parent-reads.md)。`tasks.parent_id` 保存真实直属父项；服务内部通过 `CreateTask.ParentTaskID` 区分普通父项与既有 Goal 父项。普通父项必须属于同一项目、可见且未结束，只有新建 Task 可以指定它。已有普通父边不能移出或改挂，普通根与 Goal 的既有归属操作保持不变。

## Team 嵌套策略

Team 的 `allowNestedSubtask` 默认关闭。独立 settings API 的权限、版本和失败合同由[鉴权需求](../spec/daynight-auth.md#team-生命周期)拥有。共享创建准入先验证普通父项；只有父项自身已有普通父项时，在持有 Project 写锁的事务中通过 `project_ownership` 和 Team 主键读取当前所属 Team 设置。关闭返回 `invalid_input` 和 `Nested subtasks are disabled for this Team.`；存储失败如实传播。一级普通子任务和 Goal 直属 Task 的子任务不受限制。关闭或项目转移不修改历史关系，后续创建按当前所属 Team 判断。

该读取使用 READ COMMITTED 语句快照，不锁 Team 行；并发保存以读取语句开始时已提交的设置为准。Project 锁与转移共享，保证读取归属与创建的顺序。升级时先暂停写入口并排空旧 Server 写入，执行迁移并启动全部新 writer，核对版本及迁移账本后恢复写流量。旧 Server 不重新检查迁移账本，混跑会绕过策略。回退使用能读精确账本且保持策略的 Server；恢复旧 Server 必须同时恢复配对数据库与附件。

## REST 与 MCP 写入

`POST /api/v1/projects/{projectId}/tasks` 和 `task_create` 接受可选非空 UUID `parentTaskId`，与非空 Goal `parentId` 互斥；Goal 不能指定普通父项。解析后交给共享服务，使用既有 `task:write`、`task:dependencies` 及所选状态、指派要求。`PATCH` 和 `task_update` 不接受 `parentTaskId`；既有 `parentId` 输入继续交给服务检查普通父边不可变，不能借 null 清空该边。

`PUT /api/v1/projects/{projectId}/tasks/{taskId}/status` 和 `task_set_status` 接受严格布尔 `cancelDescendants`。字段仅可用于普通 Task 的 `cancelled` 操作，包括显式 false；适配器保留字段存在性，core 在同状态判断之前检查目标类型。省略或 false 只取消目标，true 明确授权同一事务取消可见未结束后代。目标精确版本和既有 claim 条件继续适用，使用 `task:status`，不新增工具或确认令牌。

完整写回执默认保持 Goal-only `parentId`。REST 的 `Daynight-Task-Relations: task-parent-v1` 和 MCP 的 `taskParentView: "v1"` 选择扩展表示；最小回执不增加关系字段。业务输入计入既有请求预算。MCP 在提交前按选定表示检查实际 UTF-8 编码预算，默认表示仍允许恰好达到原 512 KiB 上限，扩展表示计入新增字节。

新拒绝沿用 Fault 适配：`task_unfinished_children`、`task_parent_terminal`、`task_parent_immutable` 为 HTTP 409；阻塞 ID 通过 HTTP `error.details.taskIds` 或 MCP `error.refs.taskIds` 返回。缺少 `task:read` 时共享服务移除 ID，协议正文也不得携带这些 ID。已经确认未提交与提交结果未知沿用各自现有错误形态。旧服务严格拒绝新增字段，调用者不得移除新字段自动重试；读表示支持不证明写能力已启用。

## 生命周期准入

所有检查在项目写事务中执行。普通 Task 实际进入 `done` 或 `cancelled`、以及删除之前，查询可见直属普通子项，若有未结束项则返回 `task_unfinished_children` 和阻塞 ID。已完成子项重开时，直属普通父项必须未结束。Worker 的带 claim 完成与手动完成共用同一准入；拒绝不改变 claim。项目锁使创建、重开与父项完成、取消、删除按提交顺序观察彼此结果。普通删除沿用[删除事务](daynight-task-deletion.md)的完整写集合与可见性传播。

## 确认取消

事务在取得首个 Task 行锁之前遍历可见子树，穿过已结束节点，计划目标与未结束后代并按 UUID 顺序锁定。校验目标精确版本和每个待改变 Task 的当前状态、执行归属与取消条件。任一拒绝发生在写入之前；应用阶段的错误使整个事务回滚。已结束后代保留原状态和历史，已隐藏分支不参与。

每个实际变化沿用状态写入、Session 冻结和真实来源 actor。Webhook 捕获为同项目不同 Task 的状态事件冻结一次受众，再分别保存事件及投递；无匹配受众时不保存事件。根 Task 的响应准入也在提交前完成。项目锁等待、计划、捕获和提交受同一 5 秒上限约束；未确认的 COMMIT 沿用现有事务未知结果模型，调用方必须读回当前事实后决定下一步，不能自动重放。日志记录目标数、写入数与结果，不记录子树内容。

## 验证职责

REST/MCP 模块验证严格输入、存在性、scope、版本与默认/扩展/最小形状，拒绝、阻塞引用、预算及响应丢失。core/service 与真实 PostgreSQL 测试负责生命周期和整批回滚机制。真实 Server API 集成使用普通 REST/MCP 创建、完成和确认取消，再从公开 HTTP 读取同一 Task 的真实父项、状态和版本，验证完整组装。
