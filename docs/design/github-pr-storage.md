# 项目 GitHub PR 存储

GitHub 连接和 PR 观测是 Project 的独立资源，不改变 Project 设置、Task 的手工 PR 引用或 Task 缓存。每个 Project 单独持有数据，即使多个 Project 指向同一仓库。存储本身不提供连接路由或后台同步。

## 身份与状态

`project_github` 以 Project ID 为主键，保存连接配置及同步事实。缺失行表示虚拟未连接资源：`version=1`、`generation=0`、`revision=0`、`enabled=false`、`sync_enabled=false`、轮询间隔为 5 分钟、访问状态为 `unknown`，其余可空事实为空。读取不会创建行。`enabled` 表示连接，`sync_enabled` 表示独立的同步意愿；开启同步需要连接，但升级保留的意愿可以暂时没有连接。首次实际管理写入在 live Project 写事务内创建版本 2；配置变更推进 version，连接、重连、断开和同步开关的实际变化推进 generation，对外可见状态或 PR 观测提交推进 revision。三者分别保护管理配置、运行代次和读取新鲜度，不能互相代替。

连接保存本地 App UUID、授权 UUID、凭据版本以及 GitHub App、installation 和仓库的稳定数值身份；名称仅用于展示，仓库可见性未知时为 null。领取及其期限、种类可为空。管理写先在 Project 锁作用域内读取并锁定既有 GitHub 行，再根据该事实决定并执行明确字段与预期条件的写入；这样广播对同一行的更新不会被陈旧决定覆盖。缺失行由 Project 锁保护首次管理写入，而广播只匹配已启用的行。数据访问层不决定业务状态转换。提交结果沿用 `committed`、`not_committed` 和 `unknown`；未知结果不能当作回滚或自动重放。

`project_github_repositories` 按 Project ID 和稳定 repository ID 保存已验证来源及最后验证的全名。`project_github.legacy_repository_id` 在迁移或首次连接时固定；旧接口始终使用该来源，连接状态不影响历史可读性。`project_pull_requests` 以 Project ID、repository ID 和 PR number 唯一标识记录。作者、head 仓库及其 ref 可以缺失；不能用 base 仓库或其他身份补齐。description 保留原始 Markdown，空字符串和 null 不合并。GitHub 时间与本地观测时间分别保存。列表摘要不读取 description，详情读取完整正文。

## 首次发布覆盖期间

`project_github_coverage` 按 Project、稳定仓库 ID 和开始时间保存覆盖期间。时间为 UTC 整秒，左闭右开；同一 Project 与仓库最多有一个开放期间。开启同步时开启期间，停用、主动断开或清除同步意愿时关闭；暂时失去访问、限流、重启及凭据变化不关闭。切换在配置或连接锁后取得数据库时间，同秒多次切换以该秒最后状态为准：删除空期间，重新启用时合并该秒刚结束的期间。关闭后的旧领取仍由 generation 和 token 栅栏立即拒绝。

首次发布未知 open 可以直接满足资格，未知终态的 `merged_at` 或 `closed_at` 必须落在保留期间内；已保存记录继续按既有规则更新。发布事务重新核对当前授权、仓库、领取及覆盖事实，提示发布与原 request ID 确认同事务。GitHub 网络读取在事务外完成。

## 读取与一致性

Project 权限、连接状态、计数及列表或详情可在同一只读 Repeatable Read snapshot 中读取。列表按 number 降序，以固定上界及锚点进行有界 keyset 分页；向前查询恢复降序。作者 ID、状态和标题或编号条件在分页前组合；缺失作者只属于无作者条件的读取。标题搜索按字面匹配，编号搜索使用十进制文本；用户输入不作为 SQL 结构。一次聚合读取目标作者范围的状态计数和包含缺失作者的全项目总数；状态计数不随搜索或状态条件缩小，完整组合总数不受分页锚点或上界限制。计数和页面共享 snapshot，跨请求分页不冻结后续观测。

部分索引 `project_pull_requests_author_number` 按 `(project_id, repository_id, author_id, number DESC)` 索引有作者的记录，支持具体作者的编号导航；全项目聚合仍需检查项目范围的记录，索引也增加同步写入成本。

## 同步协调

`project_github_pending_prs` 以 Project ID 和 PR number 标识待刷新项；新提示替换 request ID，完成时只删除捕获的同一 request ID。运行代次变化清除旧提示、领取和 access hint。关闭同步清除调度期限，保留 `not_before`、绑定、PR 及历史尝试、成功和错误事实。

候选查询有界返回已连接、同步开启且到期的 Project，实际领取、续持、观测发布和完成均在 App-aware 工作事务内执行。各操作核对活 Project、App、凭据版本、原 grant、owner Team 与 ownership version；领取另校验连接、同步开关及已有期限，续持和发布另校验原 token、generation 与数据库时间。数据库只保存调用方指定的状态和时间，不决定重试或同步成功。完整轮询以 `seen_poll_id` 标记观测，并在有效领取的仓库内有界查询未见的 active 编号；缺席本身不会改变 PR 状态。

Webhook 提示事务按活 App、当前授权及连接身份锁定并重新检查候选，不反向取得 Project 锁。关闭期间不积累提示或推进接收时间。项目连接、执行与清退的锁顺序和权限分别由[项目连接](github-app-project-connection.md)、[执行](github-app-execution.md)和[资源清退](github-app-resource-retirement.md)拥有。事务失败回滚全部操作，提交结果未知仍按未知处理。

## 迁移

迁移 `073_project_github_sync.sql` 为已有行设置默认关闭，推进 version、generation 和 revision，清除调度、领取、access hint 与 pending PR；绑定、PR、历史事实和 `not_before` 保留。缺失行不补建。溢出或数据库错误使迁移失败。升级须先停止并 drain 全部旧服务副本，完成迁移和替换后再启动；旧代码不识别同步开关，不能与新版混跑。

迁移 `076_github_apps.sql` 为独立 App、管理员、邀请和 Team 授权准备存储，并增加连接授权字段；它删除同步意愿依赖连接的 CHECK，但不修改既有连接、领取、同步意愿或 PR。迁移 `077_github_app_cutover.sql` 将旧连接转换为未连接状态，清除活动 App、installation、授权、领取、提示和日程，推进 version、generation 和 revision，保留同步意愿、仓库与 PR。溢出使数据和迁移账本一起回滚；缺失行不补建。应用 077 前须停止并 drain 所有旧副本，不得混跑；二进制回滚须恢复匹配的数据库备份。独立资源的存储与证明见 [独立 GitHub App 登记](github-app-registration.md)。

迁移 `078_project_pull_requests_author_number.sql` 仅建立作者部分索引，不改写保存数据。索引与迁移账本在同一事务中提交，失败时一起回滚。迁移后不直接运行不认识该账本的旧二进制；向前修复，或使用保留当前迁移集合的回退构建。

迁移 `088_github_coverage.sql` 在单个 UTC 整秒为已有同步意愿且保留仓库的连接开启覆盖期，保留 PR、提示、历史、授权退避和 generation。可用连接安排近期轮询并清除旧完整轮询 generation，公开变化推进 revision。升级前停止并排空旧服务副本，迁移完成后启动新服务；回退须使用匹配数据库备份。

迁移 `093_github_repository_sources.sql` 检查所有历史 PR 的连接仓库 ID 和全名，无法归属时报告 Project ID 并回滚，旧表和迁移账本保持可读。可信身份回填目录、固定旧来源和 PR 来源，再替换主键及状态、作者索引。升级前停止全部旧 Server 写入者并排空 GitHub worker，完成迁移后统一启用新写入者；旧写入者的冲突键不能与新主键混用。失败时修复身份后重新迁移；新写入开始后用前向恢复，不以旧二进制回滚新数据。迁移与索引持有表锁，维护窗口须按实际数据量和测量决定。
