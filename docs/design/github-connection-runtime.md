# GitHub 连接与同步运行时

当前 owner Team 管理员通过项目 GitHub 子资源选择已授权的独立 App，发现安装、连接、更换或断开；Project 管理员管理同步开关和轮询间隔。连接在事务外使用选中 App 的凭据证明安装、稳定仓库身份和 PR 读取能力，前后重新检查权限及原版本。远端证明和数据库提交是两个独立结果；未知提交须重读，不自动重发。项目连接权限、绑定与失败语义由[项目连接](github-app-project-connection.md)拥有。

连接与同步意愿独立：首次连接保留默认关闭；重新连接保留原同步意愿，开启时安排完整轮询。开启需要当前活 App、owner Team 的有效授权、活动绑定及 available 访问状态；不额外访问 GitHub。关闭保留绑定和 PR。修改间隔在关闭时只保存间隔；开启时不使当前领取失效，执行器完成时使用当前配置计算下一次时间。默认间隔五分钟。

`PATCH /api/v1/projects/{projectId}/github/sync` 接收必填十进制字符串 `version` 和 JSON boolean `syncEnabled`，成功返回完整状态。权限及精确版本先于同值判断；同值不递增版本。实际切换、断开或重连改变 generation、清除旧领取和提示并保留 PR；断开和 Project 删除同时关闭同步。开启前置不满足返回相应连接或访问错误；提交结果未知返回 503 `github_write_outcome_unknown`，客户端重读而不重发。

服务进程启动时立即扫描，之后每秒扫描一次，每次最多返回 32 个候选，单实例最多并行执行四个 Project。候选只是提示，执行器在短事务中重新准入；多个服务实例通过数据库领取协调。重启后继续扫描，崩溃残留的有效领取可自然到期，最长接近五分钟后恢复。执行、发布 fence 和恢复规则由[独立 App 执行](github-app-execution.md)拥有。

运行时与服务共享生命周期：停止新领取，取消在途工作，等待工作退出，再关闭 App client provider 和数据库。未完成 drain 时保留仍可能被使用的资源，并允许重试关闭。后台运行器异常退出进入服务监督和 readiness，不能静默停止同步。

部署须先在 GitHub 注册 App、授予 Pull requests read 权限，并将 App 安装到目标仓库；在 Daynight 登记 App 凭据并向 owner Team 授权后才能连接。升级到迁移 077 前须停止并 drain 所有旧副本；迁移保留仓库、PR 和同步意愿，清除旧连接、领取和提示并推进 fence。迁移和替换完成后才能启动新副本，旧服务不可混跑。

应用迁移 085 的准备版本前，同样须停止新流量并完整排空上一代服务及后台写入者，防止一次性清理后再次写入混用诊断。准备版本保留 App PR 接收链路，独立维护安装访问复查；项目接收入口尚未启用。规范化只清理混用显示，保留领取、队列与调度，失败时该条迁移及账本一起回滚。准备版和激活版的完整有序迁移版本及校验和必须一致。切换前排空准备版，保留已提交的同代次提示和领取；执行器继续处理提示，残留领取按原期限恢复。没有项目订阅时，周期轮询继续更新。详细部署和同库回退步骤见[服务端说明](../../packages/daynight-server/README.md)。

将每个 App 的 HTTPS Webhook 指向 `/api/v1/github/apps/{localAppId}/webhook` 并订阅 `installation` 和 `installation_repositories`；回退窗口内还须保留 App 的 `pull_request` 订阅。仓库管理员为各项目配置独立的 HTTPS 项目 URL、secret 和 `pull_request` 事件。反向代理须同时放行 App 与项目入口并允许 26,214,400 字节的请求体。两个入口分别验证对应 secret 并在八秒预算内持久化收件或提示；App 的 `pull_request` 投递返回 204，不产生新提示。入口不请求 GitHub，也不保存事件正文。周期同步补齐丢失的事实。细节见[App Webhook](github-app-webhook.md)和[项目订阅](github-project-webhook-subscription.md)。

同步配置和执行日志关联操作身份与结果，不记录凭据或 PR 正文。关闭回执表示数据库停止准入已提交，不表示在途远端请求均已退出。
