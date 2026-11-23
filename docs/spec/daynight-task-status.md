# 任务状态与待确认任务需求

状态：已实现。本文拥有 Task 状态、依赖、计时及统一状态设置的当前行为。[架构设计](../design/daynight-task-status.md)拥有机制与执行边界。

## TS1：状态与统一入口

普通 Task 状态为 `proposed`、`todo`、`in_progress`、`done`、`cancelled`。`proposed` 表示尚未确认的提议，`todo` 表示已确认待办，`in_progress` 表示执行中，`done` 表示完成交付，`cancelled` 表示不再需要执行。后两者均为已结束，但取消不证明交付、验收或成果保存成功。新建任务默认 proposed，创建时可显式指定 proposed 或 todo；外部提议通常保留默认值，内部已确认的多步任务可直接创建为 todo。初始版本为 1，`startedAt`、`completedAt`、`cancelledAt` 均为 null；只有 todo 且全部直接前置满足时才 ready。proposed 由使用方决定何时采用，不增加审批命令或强制流转阶段。

CLI 提供 `daynight task set-status <task-id> <status>` 与等价 `dn`，保留项目发现、`--project`、精确 `--if-version` 和补全。目标类型和身份在写入前读取，显式版本保持原值；Goal 完成或取消提示其子 Task 状态保留、后续自动领取被排除，交互确认或 `--force` 才提交。force 只跳过 Goal 提示，不绕过服务端检查。`cancelled` 通过同一入口设置。显式 `--claim-id <claim-id>` 仅用于 done，经本地 UUID 校验和规范化后调用现有 claim-bound 完成；其他目标在配置、Git 和网络前拒绝。省略不从任务或环境推断 claim。普通 task update 保持元数据职责，不接受 status。

Goal 的独立四态与时间规则见 [Goal 需求](daynight-goals.md)。状态与任务记录不授予执行、部署、交付、重开或强制撤回权限。同状态请求先核验权限与精确版本，再返回完整 Task；不修改字段、版本、updatedAt 或计时。过期同状态请求仍冲突，实际状态改变只递增一次版本。

## TS2：状态转换与数据保留

没有 active 执行归属的普通任务可在 proposed、todo、in_progress、done 之间直接设置状态，无需先经过 proposed 或 todo。进入 cancelled 不要求前置满足，也不要求交付、验收或保留成果。proposed、todo、人工 in_progress、done 的任务可以取消；done→cancelled 不撤回已有代码或外部交付，也不受已启动后继限制。

cancelled 不可恢复，不能通过普通 setter、认领、withdraw 或 claim-bound 完成改回 proposed、todo、in_progress 或 done。同状态 cancelled 请求仍遵守精确版本 no-op。既有 completed 归属和 Session/archive 历史保持真实，不改写成新一次执行。

active Worker 持有任务时不能取消，必须先完成现有 release 或其他已授权的解除 active 归属操作，再读取最新版本取消。仅停止原生进程不证明 active claim 已解除。release 后取消不要求先恢复一次执行。

取消保留 assignedTo、allowAgents、平台要求、全部 properties、依赖、描述、Steps、Thread、执行历史和附件。底层数据保留及资源清理沿用删除的既有边界；取消记录和全部资料继续正常可读，并受项目权限与身份隔离保护。取消不设置删除标记、不返回 task_deleted、不解除依赖、不删除图节点，不自动关闭 PR 或删除 Git 分支。[软删除](daynight-task-deletion.md)仍是独立操作。

数据库通过新增迁移扩展状态约束并将创建默认值设为 proposed。既有任务保持状态、版本、时间和全部资料，不根据历史提议或描述反推待确认状态。历史取消迁移及 proposed→todo 归类迁移保持原始语义，已应用迁移不可改写；新的 proposed 是当前合法状态，不是旧数据兼容别名。

## TS3：依赖、就绪与计时

普通和外部前置处于 done 或 cancelled 时均视为满足。实际进入 in_progress/done 要求全部直接前置满足；proposed、todo 和 cancelled 允许有未满足前置。proposed 不满足后继的前置条件。取消保留真实依赖边，不级联修改前置或后继。取消 A 可以使依赖 A 的 B 成为 ready，但 B 仍须满足其余前置与自动执行条件。

done 退回 proposed/todo/in_progress 时，若任一直接后继为 in_progress 或 done 则拒绝。cancelled 后继不增加重开限制，因为取消无需前置持续满足。done→cancelled 保持依赖满足，不适用重开保护。

ready 仍为 todo 且全部前置满足。proposed 和 cancelled 永不 ready，不参与自动认领。allowAgents 不改变这个状态条件。统计满足：

```text
total = proposed + todo + inProgress + done + cancelled
todo = ready + blocked
ended = done + cancelled
```

普通成员全部为 done/cancelled 时表示全部已结束，真实统计分别保留完成数和取消数；8 done + 2 cancelled 表示 10 项结束、8 项交付完成、2 项取消。链全部 done 汇总为 done，全部 cancelled 汇总为 cancelled，混合终态汇总为仅供 UI 使用的 ended；ended 不是 TaskStatus。全部取消不能标为全部交付成功。全部普通成员为 proposed 时链汇总为 proposed；proposed 与 todo 混合且无已开始或已结束成员时汇总为 todo。Goal 自身状态独立于其子 Task 汇总。Web 的完成进度排除取消项，遵守 [Web 进度规则](daynight-web.md#项目整体进度)；外部上下文不计入链进度。

startedAt/completedAt 描述执行区间：进入 in_progress 生成新起点并清空完成时间；实际退回 proposed/todo 清空两端；in_progress→done 保留可空起点并记录真实终点；proposed/todo→done 只有终点，耗时未知。取消记录数据库实际 cancelledAt，保留原执行起止；done→cancelled 保留 completedAt。当前业务结束时间由状态选择 done 的 completedAt 或 cancelled 的 cancelledAt，不从 updatedAt 推算。普通编辑与同状态不刷新任何端点。

状态、取消时间、版本及依赖规则在同一项目写事务内完成，Task 修改与 Session freeze 一致提交。拒绝、请求取消、存储或冻结失败不能留下部分结果。取消不轮换项目 epoch，也不伪造后继版本；后继就绪性由新图和查询派生。

## TS4：Web 状态交互与读取

Task 详情沿用紧凑头部及公共状态行。五种业务状态都有可区分的双语文字和视觉标识，不能只依赖颜色。未取消任务的状态菜单提供proposed、todo、in_progress、done、cancelled；已取消任务保留可读状态，不提供reopen或withdraw恢复控制。取消记录的描述、附件、Steps、Thread和执行资料保持可读。

选择cancelled使用现有状态确认窗，展示完整任务名、当前→目标，明确不可恢复、无需继续交付、资料保持可读，以及其他任务对本任务的依赖将视为满足。取消不要求填写原因。active Worker的取消项以aria-disabled表达不可提交，悬停或键盘聚焦可读取先完成release的说明；若执行归属在审阅后变化，服务端拒绝仍须准确呈现，不能将进程已停误当作claim已释放。

放弃确认、关闭确认窗或Escape零写入，保留焦点。已接受操作绑定身份、源状态、目标、精确版本和审阅cacheGeneration，异步准备和发送前继续核验原所有者及历史；冲突重读后重新确认，不替换新版本静默提交。

状态、allowAgents和requiredPlatform保存共用单任务写入会话。读取陈旧、pending、unknown、核对中或核对失败时阻止再次提交。取消保持普通status操作，不设置删除终态：成功须为精确+1、cancelledAt非空且原startedAt/completedAt和其他Task字段保留。同状态核对仍按+0及时间不变规则；无效字段或时间组合不能当作成功。未知结果只GET核对，不重发写入，也不把后来读到的取消值归因于原未知请求。关闭或重开详情不释放进行中的防重责任。

项目状态筛选提供全部/proposed/todo/in_progress/done/cancelled，取消精确筛选可与负责人条件组合；完整分量、Goal 进度范围及依赖不被筛选裁剪。独立任务页签按负责人统计未结束的未归属独立 Task；任务链页签统计未归属范围内至少有一个负责人匹配且未结束成员的链，每链最多计 1。两者均排除 done/cancelled 成员；Goal 页签统计自身负责人匹配且自身状态为 `todo` 或 `in_progress` 的容器，排除 `done` 和 `cancelled`；孩子进度不决定 Goal 的计数资格。完整链、全状态和搜索结果保留取消节点。完成进度只展示完成交付数及非取消分母；真实已结束统计仍包含取消项，最近结束窗口使用当前终态时间及全部普通成员的最大值。

取消更新沿普通摘要delta发布，不调用删除缓存路径、不清空仍可读的资料。后台核验、状态变化及错误核对保留菜单、页签、附件阅读、图布局、滚动和焦点。双语、桌面与320px、长标题、加载/空结果/失败、active拒绝、冲突、丢响应和核对失败均保持可操作。

## TS5：工作流与验收

创建只登记工作，不启动执行。明确指定的 proposed 或 todo 满足全部前置、输入与执行授权后可直接进入 in_progress；真实交付和验收成立后设置 done。取消是另一种结束结果，不代替交付接受。普通 run-task 每次只处理一个指定任务，取消任务只报告终态，不重开或选择后继。

allowAgents 约束自动发现选择和普通 claim 准入。普通 setter 不停止进程或代替 release。active 执行完成要求匹配 claimId 与 owner；release 后的新执行使用普通认领，取消后认领和撤回均拒绝。Worker 本地 pending/active/done 描述执行及清理，不新增 cancelled 本地状态。已解除归属的原资源由完整自有 inventory 和既有清理机制处理，保留停止、归档、资源归属、退避与重启责任；业务取消不证明远端资源已消失。

验证覆盖默认 proposed、显式 todo 创建与五态转换、不可恢复、release 后取消与 withdraw 拒绝、active 拒绝、同状态与大版本、普通/外部依赖、认领/withdraw 竞争、时间保全与回滚、迁移保全、所有查询/图/同步/MCP投影、资料读取与Web缓存。Web另验证取消确认、active项悬停/焦点说明与零派发、精确状态筛选、旧历史响应、超时/丢响应只GET及320px双语。使用真实 PostgreSQL、installed CLI 与生产 Web 验证跨端互读和重启；原型仅证明模拟交互。适用模块门禁与覆盖率要求保持。
