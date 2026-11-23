# GitHub 连接与同步运行时

当前 owner Team 管理员通过项目 GitHub 子资源选择已授权的独立 App，发现安装、连接、更换或断开；Project 管理员管理同步开关和轮询间隔。连接在事务外使用选中 App 的凭据证明安装、稳定仓库身份和 PR 读取能力，前后重新检查权限及原版本。远端证明和数据库提交是两个独立结果；未知提交须重读，不自动重发。项目连接权限、绑定与失败语义由[项目连接](github-app-project-connection.md)拥有。

连接与同步意愿独立：首次连接保留默认关闭；重新连接保留原同步意愿，开启时安排完整轮询。开启需要当前活 App、owner Team 的有效授权、活动绑定及 available 访问状态；不额外访问 GitHub。关闭保留绑定和 PR。修改间隔在关闭时只保存间隔；开启时不使当前领取失效，执行器完成时使用当前配置计算下一次时间。默认间隔五分钟。

`PATCH /api/v1/projects/{projectId}/github/sync` 接收必填十进制字符串 `version` 和 JSON boolean `syncEnabled`，成功返回完整状态。权限及精确版本先于同值判断；同值不递增版本。实际切换、断开或重连改变 generation、清除旧领取和提示并保留 PR；断开和 Project 删除同时关闭同步。开启前置不满足返回相应连接或访问错误；提交结果未知返回 503 `github_write_outcome_unknown`，客户端重读而不重发。

服务进程启动时立即扫描，之后每秒扫描一次，每次最多返回 32 个候选，单实例最多并行执行四个 Project。候选只是提示，执行器在短事务中重新准入；多个服务实例通过数据库领取协调。重启后继续扫描，崩溃残留的有效领取可自然到期，最长接近五分钟后恢复。执行、发布 fence 和恢复规则由[独立 App 执行](github-app-execution.md)拥有。

运行时与服务共享生命周期：停止新领取，取消在途工作，等待工作退出，再关闭 App client provider 和数据库。未完成 drain 时保留仍可能被使用的资源，并允许重试关闭。后台运行器异常退出进入服务监督和 readiness，不能静默停止同步。

部署须先在 GitHub 注册 App、授予 Pull requests read 权限，并将 App 安装到目标仓库；在 Daynight 登记 App 凭据并向 owner Team 授权后才能连接。升级到迁移 077 前须停止并 drain 所有旧副本；迁移保留仓库、PR 和同步意愿，清除旧连接、领取和提示并推进 fence。迁移和替换完成后才能启动新副本，旧服务不可混跑。详细部署与恢复步骤见[服务端说明](../../packages/daynight-server/README.md)。

将每个 App 的 HTTPS Webhook 指向 `/api/v1/github/apps/{localAppId}/webhook` 并订阅 `pull_request`、`installation` 和 `installation_repositories`。反向代理须允许 26,214,400 字节的请求体。入口使用对应活 App 的 secret 验证原始字节，并在八秒预算内持久化提示；相关事件确认提交返回 202（包括零匹配），合法无关事件返回 204，失败或提交结果未知返回 503。入口不请求 GitHub，也不保存事件正文。提示按当前绑定和授权路由；周期同步补齐丢失的事实。细节见[Webhook 接收](github-app-webhook.md)。

同步配置和执行日志关联操作身份与结果，不记录凭据或 PR 正文。关闭回执表示数据库停止准入已提交，不表示在途远端请求均已退出。

项目仓库实际切换时，项目事务先关闭旧来源覆盖区间并退役项目侧连接与同步工作，再保存新身份；其他项目和 App 安装不受影响。连接的网络证明绑定项目地址版本，地址 A→B→A 也会使旧证明失效。历史来源及 PR 保持可读；新连接由管理员手工建立。历史 PR 的 Reviewer 归属保持独立，切换与归属写入的并发规则见[归属设计](pr-review-assignment.md)。
