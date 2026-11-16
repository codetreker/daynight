# 项目 GitHub PR 存储

GitHub 连接和 PR 观测是 Project 的独立资源，不改变 Project 设置、Task 的手工 PR 引用或 Task 缓存。每个 Project 单独持有数据，即使多个 Project 指向同一仓库。存储本身不提供连接路由或后台同步。

## 身份与状态

`project_github` 以 Project ID 为主键，保存连接配置及同步事实。缺失行表示虚拟未连接资源：`version=1`、`generation=0`、`revision=0`、`enabled=false`、`sync_enabled=false`、轮询间隔为 5 分钟、访问状态为 `unknown`，其余可空事实为空。读取不会创建行。`enabled` 表示连接，`sync_enabled` 表示独立的同步意愿；数据库约束同步开启时连接必须开启。首次实际管理写入在 live Project 写事务内创建版本 2；配置变更推进 version，连接、重连、断开和同步开关的实际变化推进 generation，对外可见状态或 PR 观测提交推进 revision。三者分别保护管理配置、运行代次和读取新鲜度，不能互相代替。

App、installation 和仓库使用稳定数值身份；名称仅用于展示，仓库可见性未知时为 null。领取及其期限、种类可为空。管理写先在 Project 锁作用域内读取并锁定既有 GitHub 行，再根据该事实决定并执行明确字段与预期条件的写入；这样广播对同一行的更新不会被陈旧决定覆盖。缺失行由 Project 锁保护首次管理写入，而广播只匹配已启用的行。数据访问层不决定业务状态转换。提交结果沿用 `committed`、`not_committed` 和 `unknown`；未知结果不能当作回滚或自动重放。

`project_pull_requests` 以 Project ID 和 PR number 唯一标识记录。作者、head 仓库及其 ref 可以缺失；不能用 base 仓库或其他身份补齐。description 保留原始 Markdown，空字符串和 null 不合并。GitHub 时间与本地观测时间分别保存。列表摘要不读取 description，详情读取完整正文。

## 读取与一致性

Project 权限、连接状态、计数及列表或详情可在同一只读 Repeatable Read snapshot 中读取。列表按 number 降序，以固定上界及锚点进行有界 keyset 分页；向前查询恢复降序。标题搜索按字面匹配，编号搜索使用十进制文本；用户输入不作为 SQL 结构。状态计数不随搜索条件缩小，筛选后的总数和页面共享 snapshot。跨请求分页不冻结后续观测。

## 同步协调

`project_github_pending_prs` 以 Project ID 和 PR number 标识待刷新项；新提示替换 request ID，完成时只删除捕获的同一 request ID。运行代次变化清除旧提示、领取和 access hint。关闭同步清除调度期限，保留 `not_before`、绑定、PR 及历史尝试、成功和错误事实。

候选查询有界返回已连接、同步开启且到期的 Project，实际领取、续持、观测发布和完成均在 live Project 写事务内执行。领取校验连接、同步开关及已有期限；续持和发布校验同步开关、原 token、generation 与数据库时间。数据库只保存调用方指定的状态和时间，不决定重试或同步成功。完整轮询以 `seen_poll_id` 标记观测，并有界查询未见的 active 编号；缺席本身不会改变 PR 状态。

广播事务先按 App、installation、仓库及同步开关条件锁定 GitHub 行，更新时再次检查开关，再写待处理项，不反向取得 Project 锁。关闭期间不积累提示或推进接收时间。管理写、发布及删除遵循 Project → GitHub → pending 的顺序；删除在同一更新中关闭连接与同步，使领取和计划失效并清除提示。事务失败回滚全部操作，提交结果未知仍按未知处理。授权决策、调度和实际远端读取由各自的业务组件承担。

## 迁移

迁移 `073_project_github_sync.sql` 为已有行设置默认关闭，推进 version、generation 和 revision，清除调度、领取、access hint 与 pending PR；绑定、PR、历史事实和 `not_before` 保留。缺失行不补建。溢出或数据库错误使迁移失败。升级须先停止并 drain 全部旧服务副本，完成迁移和替换后再启动；旧代码不识别同步开关，不能与新版混跑。
