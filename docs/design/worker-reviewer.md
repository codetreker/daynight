# Worker Reviewer 设计

`worker run` 在认证原账号和 Worker 后启动独立宿主。宿主按 reviewer 的默认节奏读取 `review-pull-requests`，一个有界 Operation 覆盖全部页面。只有完整成功的名单可供新审查；任何页面明确关闭时立即撤销资格。读取失败显示诊断并等待下轮，不把未读取的页面当成移除，也不停止已经运行的审查。服务端持有分配及默认分支资格，[分配设计](pr-review-assignment.md)定义列表合同。

协调器以仓库稳定 ID 和 PR 编号合并候选，继续通过 GitHub 检查真实仓库、目标、CI、反馈及发布身份。独立 SQLite、实例锁、clone、worktree、日志和 Copilot 状态位于配置根的 `reviewer/` 子目录。新库沿用现有 schema 和恢复机制，旧独立 reviewer 根目录不参与初始化或清理。Worker 重启时先恢复已有责任，完整名单取得前不准入新执行。

在预留前并行读取 Reviewer 的 user、project 和 worker prompt。资源按账号和 ID 保存在进程内；临时读取失败复用已确认值，明确失权或候选项目移除使对应代际失效。相同 PR 属于多个项目时，使用排序最前的合格项目；捕获的三层正文按顺序追加在内建 prompt 后，通过 stdin 发送，不写入 SQLite 或命令参数。协调器在启动意图和真实 spawn 前复核当前候选与代际。资源合同见 [Prompt 设计](worker-prompts.md)。

停用或完整名单移除取消相关准备和执行。已可能发布的 attempt 保留原身份；确认原进程排除后查询 GitHub，匹配的发布结算，未知结果继续只读查询，确认没有匹配结果才按预算决定重试。终态 PR 的 worktree 由既有所有权与停证检查回收。宿主与开发 Task 和心跳独立，Worker 退出时等待 reviewer 收尾；无法证明停止时保留 reviewer 锁。设计取舍见[决策记录](../../.agents/notes/implemented/architecture/2026-11-20-worker-reviewer.md)。
