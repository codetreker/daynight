# PR reviewer 服务端分配

分配器消费 [GitHub 同步](github-sync-executor.md)已提交的快照。分配与 GitHub 读取、轮询完成及 webhook 确认独立。分配循环随 GitHub App 服务启动和停止，每 5 秒尝试最多 32 次单 PR 分配，没有候选或发生存储错误时结束本轮。后续轮次重新读取事实，因此 Worker 恢复在线或开启参与时，无需等待 PR 再变化。

## Worker 资格

`GET/PUT /api/v1/me/workers/{workerId}/review-settings` 读写账号自有 Worker 的 `enabled` 开关。设置存于 Worker 行的独立布尔字段，现有 Worker 配置和上报协议不承载这项设置。分配以数据库时间核对现有 Worker 120 秒在线窗口，并读取目标 Worker 配置中的 Project 和当前 Project 访问关系。

Project 连接需已启用同步且访问状态为 available。按 PR 创建时间和稳定标识处理等待中的 Open PR，同一 PR 的候选按各自已负责的该 Project 的 Open PR 数量升序选择，平局按持久身份排序。长期归属计数仅用于选择排序，开发配置中的并发和 Task 数量均不参与选择。

## 归属原子性

`project_pull_request_reviewers` 以 `(project_id, github_id)` 唯一标识归属，记录账号、Worker 和分配时间。候选可从普通快照选择。写入事务先按既有顺序锁定 Project 和实际授权来源，再重新核对并锁定当前 PR 行、连接行和 Worker 行。条件插入使用唯一键处理并行分配，GitHub 同步操作独立更新其观察表。

[PR 读取接口](github-pr-reading.md)按同一身份关联归属。PR head、同步 revision 和归属分别反映各自的变化。Worker 重新上线、设置变化和 PR 重开都沿用已保存的归属。
