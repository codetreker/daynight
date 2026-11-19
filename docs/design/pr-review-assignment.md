# PR Reviewer 长期归属

## 范围和资格

服务端根据 GitHub App 同步保存的当前项目仓库 PR 观测，为每个账号的 Open PR 保存长期 Worker 归属。Draft 属于 Open；没有归属的 Closed 和 Merged PR 不首次分配。同步失败不会生成新观测，关闭同步也不改变最后保存的事实。分配不联系 GitHub 或 Worker，不受开发任务名额或既有归属数量限制。Worker 领取、review 执行、名额、手动改派和反馈投递不属于此机制。

候选 Worker 必须属于目标账号，开启[参与设置](worker-review-participation.md)，其最近保存的目标配置 `projects` 包含该 Project，且账号当前具有 Project 读取权限。在线使用 Worker 的最后成功上报时间和数据库观察时间：差值在 `[0,120s)` 内，未来时间不算在线。目标配置尚未应用不妨碍分配；项目权限和 Worker 资格在分配事务内重新检查。

## 数据、对账和并发

`project_pr_review_assignments` 以 `(user_id, project_id, repository_id, github_pr_id)` 为主键，保存 `worker_id` 和数据库分配时间。repository ID 和 GitHub PR ID 是稳定身份，PR number 仅用于定位保存的观测；head 仓库、名称和 SHA 不参与身份。表没有级联或自动改派：同步刷新、PR 关闭或重开、Worker 离线或关闭参与设置都不替换已有归属。访问被撤销或 Project 删除后，普通 Project 读取权限阻止访问历史归属。

App 启动一个有界周期对账循环，关闭时取消并等待循环退出，再关闭数据库。每遍固定 Worker 扫描起点时间和键上界，以 `(user_id,worker_id)` 分页扫描参与 Worker，按其目标配置项目读取当前仓库的 Open PR，并按 number 降序分页。每个项目首次取页固定 PR 上界；账号已有归属的标记随原始 PR 页返回，页内未尝试项目跨批保留。项目或单项失败被记录并移过，后续遍次重新观察；重启从头扫描。部分索引 `workers_review_participants` 服务参与 Worker 键序扫描，既有 PR 状态编号索引服务 PR 页。不同实例可同时扫描，持久主键限制竞争结果。

单项写入在短事务中依次取得活 Project 写锁、授权来源锁、当前连接共享锁和候选 Worker 共享锁。锁后核对仓库、授权、Worker 开关、目标项目覆盖、在线时间及同一 GitHub PR 仍为 Open，再以 `INSERT ... ON CONFLICT DO NOTHING` 保存归属。已有归属不被覆盖。提交未知时不推断回滚或重放结果，后续遍次按主键重新观察。日志按扫描遍次记录故障分类及可用身份，不包含 PR 正文、远端响应或凭据。

## 归属查询

`GET`、`HEAD` `/api/v1/projects/{projectId}/pull-requests/{number}/review-assignment` 使用现有 PR 详情的参数和 Project 读取权限，响应 `Cache-Control: no-store`。可选 `repositoryId` 是规范正十进制 int64，必须是该 Project 保留的来源；省略时使用固定的 legacy 来源，不随当前连接变化。对账扫描当前连接仓库；若当前仓库不是 legacy 来源，查询该仓库时须显式传 `repositoryId`。不存在的 Project、来源或 PR 沿用详情的未找到语义。

项目权限、所选 PR、调用账号持有的归属及 Worker 状态在同一只读快照取得。无归属的 Open PR 返回 `{"status":"waiting","assignment":null}`，无归属的 Closed/Merged 返回 `{"status":"not_applicable","assignment":null}`。存在归属时返回 `{"status":"assigned","assignment":{"workerId":"…","assignedAt":"…","online":false,"reviewEnabled":true}}`，终态仍保留归属。按账号和精确 Worker ID 读取状态，不受 Worker 列表 72 小时窗口裁剪；Worker 行缺失时仍返回身份和分配时间，`online` 和 `reviewEnabled` 均为 null。

迁移 `095_pr_review_assignment.sql` 创建归属表和参与者部分索引，并更新 schema snapshot。旧 PR 列表、详情与 Worker 上报协议保持原样；新消费者单独调用归属查询。设计选择及其成本见[决策记录](../../.agents/notes/implemented/architecture/2026-11-19-pr-review-assignment.md)。
