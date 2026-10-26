# 任务三状态与统一设置需求

状态：已实现。本文拥有任务三状态与统一设置的当前行为。

[架构设计](../design/daynight-task-status.md)拥有机制、选型和执行边界；[交互原型](../design/mockups/task-status/index.html)演示最终样式及模拟交互。

## TS1：三状态与统一入口

任务仅有 `todo`、`in_progress`、`done`。新建任务默认 `todo`，初始版本为 1，起止时间为 null；依赖决定是否 ready，不存在任务审批阶段或另一套批准字段。状态与任务记录不自动授予执行、部署或交付权限。

CLI 提供 `daynight task set-status <task-id> <status>` 与等价 `dn`，保留项目发现、`--project`、精确 `--if-version` 和补全。显式 `--claim-id <claim-id>` 仅用于 done，经本地 UUID 校验和规范化后调用现有 claim-bound 完成；其他目标在配置、Git 和网络前拒绝。省略不从任务或环境推断 claim，普通 setter 不变。旧 approve/unapprove/claim/complete 公开入口删除；普通 task update 保持元数据职责，不接受 status。

没有 active/released 执行归属的普通任务支持任意状态对，包括退回和直接完成；worker 管理中的任务还受[认领规则](../design/daynight-worker-claims.md)约束。同状态请求先核验权限与精确版本，再返回当前完整任务；不修改持久化字段、版本、updatedAt 或计时。过期同状态请求仍冲突。实际改变只递增一次任务版本。

## TS2：历史数据迁移

所有历史 `proposed` 任务转换为 `todo`。只对转换行增加一次 version 并以真实数据库时间更新 updatedAt，保留其标题、Markdown、属性、PR、allowAgents、requiredPlatform、依赖端点与外部分类、附件、createdAt 和已有起止时间；其他状态行保持原值。迁移是旧状态归类，不是重新开始或退回一次执行，不重置时间。

数据库默认值与约束同时切换为三状态。已应用迁移保持不变，新增迁移执行转换；失败回滚默认值、数据、约束与迁移记录。再次启动迁移不重复修改数据。运行时和客户端拒绝 `proposed`，不增加兼容别名或读取回退。

## TS3：依赖与计时

实际进入 in_progress/done 时，全部直接前置必须完成，包括外部依赖。done 退回 todo/in_progress 时，若任一直接后继进行中或完成则拒绝，不级联修改任何后继。普通和外部边使用同样约束。

ready 仍为 todo 且全部前置完成。统计满足 `total = todo + inProgress + done` 与 `todo = ready + blocked`，不返回 proposed 统计项。迁移后的原 proposed 任务按实际前置进入 ready 或 blocked；allowAgents 保留原值。任务链全部完成时为 done；否则只要存在 done 或 in_progress 任务即为 in_progress，其余为 todo。外部上下文不计入链进度。

时间描述当前一次执行区间：进入 in_progress 生成新起点并清空终点；实际退回 todo 清空两端；in_progress→done 保留可空起点并记录真实终点；todo→done 仅记录终点，耗时未知。普通编辑与同状态不改变时间，不从其他时间戳推算历史。

状态、时间、版本与依赖规则在同一项目写事务内完成。权限、版本、依赖、取消或存储失败不能留下部分结果。状态修改保留全部其他资料和附件；claim-bound done 同一事务把当前归属置为 completed。

## TS4：Web 交互

任务详情沿用已交付的紧凑头部：实际标题在共享头部，完整 ID 与复制在概览，标题下的公共状态行将当前状态按钮与平台切换相邻放置，状态在前，ready/blocked 提示在两者之后，自动执行控件保持右侧；状态按钮打开三项菜单，当前项明确标记且可选择。选择后确认完整任务名、当前→目标和计时后果；同状态也通过版本化请求确认无修改。取消/Escape 不提交，保留键盘焦点。

状态、allowAgents及requiredPlatform平台保存共用单任务写入会话；状态/许可共用互斥确认窗口，平台选择后明确保存而无额外确认。读取陈旧、pending、unknown、核对中或核对失败都阻止三类再次提交；冲突重读后重新决策，未知结果仅 GET 核对，不自动重发写入。关闭详情不代表请求回滚。

双语、桌面与 320px、长标题、加载/空结果/失败、依赖拒绝、冲突、丢响应及核对失败可操作。状态更新保留资料页签、附件选择与阅读、图布局和焦点。界面不提供旧状态或任务审批入口。任务软删除使用独立标记与确认操作，沿用[软删除需求](daynight-task-deletion.md)，不增加第四种业务状态。

## TS5：工作流与验收

创建任务只登记工作，不启动执行。在用户已授权的任务或 Goal 范围内，ready todo 满足阶段资料后可设置 in_progress；实际验收和必要授权交付后设置 done。已有明确执行范围可持续覆盖就绪后继，无需逐任务审批，也不以其他字段重建审批机制。

allowAgents 继续只约束自动发现选择；用户明确指定的任务队列可沿用手工执行路径。普通 setter 不停止进程或代替 release/transfer。worker-managed agent 复用明确给定的 claim/worktree，不重新开始或选择后继；全部交付与验收成立后，最后以显式 --claim-id 和观察版本完成。active 执行实际完成须提供匹配 claimId 并由 owner 提交；退回 todo 须显式 release。released 未完成成果不能用普通状态设置开始或完成，原 owner/admin 通过显式人工 resume 确认原工作区连续性；该入口保留人工执行许可/平台例外。当前版本同状态仍是 no-op。completed 历史不阻止普通重开，也不会因重开变为 active。PR 审查批准和文档提案生命周期独立于被删除的任务状态。

验证覆盖九种状态组合、精确大版本与同状态、全部边类型的开始/退回竞争、时间/回滚、旧数据迁移及重复启动、旧状态拒绝、三状态统计和分页、权限、资料保全及 Web 会话。最终使用真实 PostgreSQL、打包安装 CLI 和生产 Web 验证跨端互读及重启持久化；原型检查只证明模拟交互。适用模块门禁与覆盖率要求保持。
