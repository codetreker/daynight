# PR Reviewer 长期归属

## 范围和资格

服务端根据 GitHub App 同步保存的当前项目仓库 PR 观测，为每个账号保存长期 Worker 归属。只有目标分支与当前仓库已同步默认分支精确相等的 Open PR 可以首次分配。Draft 属于 Open；没有归属的 Closed 和 Merged PR 不首次分配。同步失败不会生成新观测，关闭同步也不改变最后保存的事实。分配不联系 GitHub 或 Worker，不受开发任务名额或既有归属数量限制。Worker 领取、review 执行、名额、手动改派和反馈投递不属于此机制。

候选 Worker 必须属于目标账号，开启[参与设置](worker-review-participation.md)，其最近保存的目标配置 `projects` 包含该 Project，且账号当前具有 Project 读取权限。在线使用 Worker 的最后成功上报时间和数据库观察时间：差值在 `[0,120s)` 内，未来时间不算在线。目标配置尚未应用不妨碍分配；项目权限和 Worker 资格在分配事务内重新检查。

## 数据、对账和并发

`project_pr_review_assignments` 以 `(user_id, project_id, repository_id, github_pr_id)` 为主键，保存 `worker_id` 和数据库分配时间。repository ID 和 GitHub PR ID 是稳定身份，PR number 仅用于定位保存的观测；head 仓库、名称和 SHA 不参与身份。表没有级联或自动改派：同步刷新、PR 关闭或重开、Worker 离线或关闭参与设置都不替换已有归属。访问被撤销或 Project 删除后，普通 Project 读取权限阻止访问历史归属。

Project [实际切换仓库](daynight-server.md#项目仓库改址)时，切换事务退役旧连接并移除 Worker 目标配置中的该项目选择，但保留参与开关、历史 PR 和归属。新旧仓库即使 PR number 相同也分别归属；切回原稳定仓库后，同一账号和 PR 的既有归属仍可读取。切换与分配先取得相同的 Project 写锁：切换先提交时，分配锁后复核当前仓库和 Worker 项目选择，不以过期事实创建归属；分配先提交时，其归属作为历史保留。

App 启动一个有界周期对账循环，关闭时取消并等待循环退出，再关闭数据库。每遍固定 Worker 扫描起点时间和键上界，以 `(user_id,worker_id)` 分页扫描参与 Worker，按其目标配置项目读取当前仓库中目标分支等于已同步默认分支的 Open PR，并按 number 降序分页。每个项目首次取页固定 PR 上界；账号已有归属的标记随原始 PR 页返回，页内未尝试项目跨批保留。项目或单项失败被记录并移过，后续遍次重新观察；重启从头扫描。部分索引 `workers_review_participants` 服务参与 Worker 键序扫描，既有 PR 状态编号索引服务 PR 页。不同实例可同时扫描，持久主键限制竞争结果。

对账使用当前保存的仓库 ID、已验证的默认分支和该来源最后成功保存的 PR 事实，不要求连接或同步当前启用。默认分支存于 `project_github.repository_default_branch`；历史行从 NULL 开始，成功仓库观测缺少有效分支时置为 NULL，临时读取失败保留最后成功观测。实际切换仓库同事务清空默认分支，同一稳定仓库改名不清空。默认分支未知或仓库身份未知时不首次分配，等待后续仓库观测。

单项写入在短事务中依次取得活 Project 写锁、授权来源锁、当前连接共享锁和候选 Worker 共享锁，再锁定 PR 行。锁后核对仓库及默认分支、授权、Worker 开关、目标项目覆盖、在线时间及同一 GitHub PR 仍为 Open 且目标分支匹配默认分支，再以 `INSERT ... ON CONFLICT DO NOTHING` 保存归属。已有归属不被覆盖。提交未知时不推断回滚或重放结果，后续遍次按主键重新观察。日志按扫描遍次记录故障分类及可用身份，不包含 PR 正文、远端响应或凭据。

## Worker 轮询

`GET`、`HEAD` `/api/v1/me/workers/{workerId}/review-pull-requests` 以当前账号和已注册 Worker 定位名单。响应包含 `reviewEnabled`、`pullRequests` 和 `nextCursor`；每项的 `projectId` 为规范 UUID，`repositoryId` 和 `number` 为规范正十进制字符串，`repositoryUrl` 使用当前已验证的 GitHub 仓库名称。未知或其他账号的 Worker 返回 404；参与开关关闭时返回空名单和 null 游标。响应禁止缓存。 Worker 对完整名单的消费与本地审查恢复见 [Worker Reviewer 设计](worker-reviewer.md)。

每页在同一只读快照中读取 Worker 开关和目标项目选择，再按当前 Project 读取权限、当前仓库、Open 状态及已同步默认分支过滤长期归属。Draft 保留；改向、终态、权限撤销或换仓使候选退出名单，但不删除归属。默认 20 条、最多 100 条，以 `(project_id, repository_id, github_pr_id)` 升序 keyset 查询多一条判断后页。游标绑定账号、Worker 和页大小，每页重新核对资格；跨页变化可在下一轮才被观察。调用方须成功遍历所有页后才应用本轮名单。

迁移 `107_review_poll_indexes.sql` 的 Worker 归属键序索引和 Open PR 身份索引支持过滤及分页。索引增加写入和存储成本；迁移在数据库事务中建索引，部署时须考虑建索引期间的写入等待。

## 归属查询

`GET`、`HEAD` `/api/v1/projects/{projectId}/pull-requests/{number}/review-assignment` 使用现有 PR 详情的参数和 Project 读取权限，响应 `Cache-Control: no-store`。可选 `repositoryId` 是规范正十进制 int64，必须是该 Project 保留的来源；省略时使用固定的 legacy 来源，不随当前连接变化。对账扫描当前连接仓库；若当前仓库不是 legacy 来源，查询该仓库时须显式传 `repositoryId`。不存在的 Project、来源或 PR 沿用详情的未找到语义。

项目权限、所选 PR、调用账号持有的归属及 Worker 状态在同一只读快照取得。无归属的 Open PR 返回 `{"status":"waiting","assignment":null}`，无归属的 Closed/Merged 返回 `{"status":"not_applicable","assignment":null}`。存在归属时返回 `{"status":"assigned","assignment":{"workerId":"…","assignedAt":"…","online":false,"reviewEnabled":true}}`，终态仍保留归属。按账号和精确 Worker ID 读取状态，不受 Worker 列表 72 小时窗口裁剪；Worker 行缺失时仍返回身份和分配时间，`online` 和 `reviewEnabled` 均为 null。

迁移 `096_pr_review_assignment.sql` 创建归属表和参与者部分索引；`106` 增加可空默认分支列，`107` 添加轮询索引，均反映在 schema snapshot 中。旧 PR 列表、详情与 Worker 上报协议保持原样。设计选择及其成本见[长期归属决策](../../.agents/notes/implemented/architecture/2026-11-19-pr-review-assignment.md)和[默认分支资格决策](../../.agents/notes/implemented/feature/2026-11-20-review-assignment-default-branch.md)。
