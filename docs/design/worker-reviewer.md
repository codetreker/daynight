# Worker Reviewer 设计

`worker run` 在认证原账号和 Worker 后启动独立宿主。宿主按 reviewer 的默认节奏读取 `review-pull-requests`，一个有界 Operation 覆盖全部页面。只有完整成功的名单可供新审查；任何页面明确关闭时立即撤销资格。读取失败显示诊断并等待下轮，不把未读取的页面当成移除，也不停止已经运行的审查。服务端持有分配及默认分支资格，[分配设计](pr-review-assignment.md)定义列表合同。

协调器以仓库稳定 ID 和 PR 编号合并候选，继续通过 GitHub 检查真实仓库、目标、CI、反馈及发布身份。独立 SQLite、实例锁、clone、worktree、日志和 Copilot 状态位于配置根的 `reviewer/` 子目录。新库沿用现有 schema 和恢复机制，旧独立 reviewer 根目录不参与初始化或清理。Worker 重启时先恢复已有责任，完整名单取得前不准入新执行。

在预留前并行读取 Reviewer 的 user、project 和 worker prompt。资源按账号和 ID 保存在进程内；临时读取失败复用已确认值，明确失权或候选项目移除使对应代际失效。相同 PR 属于多个项目时，使用排序最前的合格项目；捕获的三层正文按顺序追加在内建 prompt 后，通过 stdin 发送，不写入 SQLite 或命令参数。协调器在启动意图和真实 spawn 前复核当前候选与代际。资源合同见 [Prompt 设计](worker-prompts.md)。

停用或完整名单移除取消相关准备和执行。已可能发布的 attempt 保留原身份；确认原进程排除后查询 GitHub，匹配的发布结算，未知结果继续只读查询，确认没有匹配结果才按预算决定重试。终态 PR 的 worktree 由既有所有权与停证检查回收。宿主与开发 Task 和心跳独立，但属于 Worker 的执行作用域。停止关闭共享执行 signal，并以独立 reviewer owner 等待宿主收尾；无法证明停止时保留 reviewer 锁并阻止新作用域。

Worker 内的 Git、GitHub 命令和 Copilot 的 discovery/review 阶段共用受管 launcher，先保存 prepared 与原边界 bound 事件再放行命令，输入、输出与日志 writer 全部结束后才保存 stopped。命令清理未确认时，宿主保留原关闭操作；管理侧核对原生命令责任后，再核对协调器保留的全部停止原因及 supervisor，完成原存储关闭和锁释放。Git adapter 为只读命令的纯清理失败私有保留原凭据，协调器强保留对应错误并动态核对，脱敏不会丢弃原资源关联；该元数据不替代原 owner 与持久库存的责任。只有原清理全部确认后才允许释放本地锁，`GitCommandError.completed` 和业务状态不因此改为成功。Git 变更命令的独立未知效果、语义校验失败及混合失败仍阻止释放。已实际关闭的失败执行保留历史诊断，不永久阻止新作用域；其他未知停止原因仍保留责任。重新核对不启动新的审查、不重放 GitHub 发布。独立 review 命令继续使用自己的 supervisor。作用域预算与资源库存见[Worker 设计](daynight-worker.md#管理根与执行作用域)。设计取舍见[Reviewer 决策](../../.agents/notes/implemented/architecture/2026-11-20-worker-reviewer.md)和[作用域决策](../../.agents/notes/implemented/architecture/2026-11-20-worker-execution-scopes.md)。
