# GitHub 连接与同步运行时

Project 管理员通过 GitHub 子资源发现目标仓库的安装、连接、配置同步、修改轮询间隔和断开。发现与连接先在只读快照验证 Project 管理权限和仓库地址，再在事务外使用服务 App 读取安装、仓库身份和最小 open PR 页。连接在短 Project 写事务中重新检查权限、原始配置版本和仓库身份；不检查操作者的 GitHub 身份或安装授权来源。已保留数据的仓库 ID 不能被不同仓库替换。远端证明和数据库提交是两个独立结果；提交结果未知时客户端须重读，不自动重发。

已有绑定的仓库改名或更换安装时，发现优先检查保存的名称和安装；必要时分页扫描当前服务 App 自身的安装，并按保存的稳定仓库 ID 寻找目标。找到后仍须实际验证仓库及 PR 读取。扫描超时或部分安装不可检查时，未找到匹配不能视为完整的无安装结果。

Web 连接确认中的 installation 字段通过[公共原生选择组件](native-select.md)呈现发现返回的单个 candidate，不增加占位项或其他安装。字段保留完整标签、当前 candidate 和原有忙碌禁用条件；选择不会提交连接，只有显式确认才派发写入。`ManagementDialog` 保留原生菜单首次 Escape 的取消及未提交草稿，后续关闭与结果核对遵循[Web 管理界面](daynight-web.md)的所有权。

连接与同步意愿独立：首次连接保留默认关闭，不安排后台轮询；重新连接保留原同步意愿，开启时安排完整轮询。实际开启需要服务可用、活动绑定、当前 App ID 和已保存的 available 访问状态；不额外访问 GitHub。开启安排立即完整轮询，但保留 `not_before` 限流期限。关闭不需要 App 或远端验证，保留绑定和 PR。修改间隔在关闭时只保存间隔；开启时不使当前领取失效，执行器完成时使用当前配置计算下一次时间。默认间隔五分钟。

管理员通过 `PATCH /api/v1/projects/{projectId}/github/sync` 提交必填的十进制字符串 `version` 和 JSON boolean `syncEnabled`，成功返回完整状态。权限及精确版本先于同值判断；同值不递增版本。实际切换、断开或重连改变 generation、清除旧领取和提示并保留 PR；断开和 Project 删除同时关闭同步。开启前置不满足分别返回 409 `github_not_configured`、`github_not_connected` 或 `github_connection_unavailable`；提交结果未知返回 503 `github_write_outcome_unknown`，客户端重读而不重发。旧响应必须通过同步开关、有效领取、generation 和 live Project 检查才能发布。

启用 GitHub 时，服务进程启动时立即扫描，之后每秒扫描一次，每次最多返回 32 个候选，单实例最多并行执行四个 Project。候选只是提示，执行器在 Project 写事务中重新准入；多个服务实例通过数据库领取协调。重启后继续扫描，崩溃残留的有效领取可自然到期，最长接近五分钟后恢复。App ID 改变时旧绑定标记为需要重新连接。执行和恢复规则由[单 Project 执行器](github-sync-executor.md)拥有。

运行时与服务共享生命周期：停止新领取，取消在途工作，等待工作退出后关闭数据库和远端 transport。未完成 drain 时保留仍可能被使用的资源，并允许重试关闭。后台运行器异常退出进入服务监督和 readiness，不能静默停止同步。

部署需要在 GitHub 注册 App、授予 Pull requests read 权限，并将 App 安装到目标仓库；配置 `DAYNIGHT_GITHUB_ENABLED`、`DAYNIGHT_GITHUB_APP_ID`、`DAYNIGHT_GITHUB_PRIVATE_KEY_FILE` 和 `DAYNIGHT_GITHUB_WEBHOOK_SECRET`。服务开关不改变 Project 保存的同步意愿。私钥由部署文件挂载，不进入 Project 数据或日志。配置及远端读取见 [GitHub App 远端读取](github-app-remote.md)。迁移 073 前须停止并 drain 所有旧副本，迁移并替换所有副本后再启动，不可混跑；已有 Project 的同步默认关闭，管理员需重新开启。

将 App 的 HTTPS Webhook 地址指向 `/api/v1/github/webhook`，使用相同 secret，订阅 `pull_request`、`installation` 和 `installation_repositories` 事件。反向代理须允许 26,214,400 字节的请求体。独立入口以原始字节验证 HMAC-SHA256，在八秒预算内持久化提示；相关事件提交成功返回 202（包括零匹配），合法无关事件返回 204，失败或提交结果未知返回 503。入口不请求 GitHub，也不保存事件正文。PR 提示按绑定身份和编号合并；安装事件安排该安装下同步开启的有效连接重新检查访问。关闭期间不保存提示或推进接收事实，重新开启后的完整轮询补齐当前事实。主动断开的连接不会被事件重新启用。

同步配置日志按 `request_id`、`user_id`、`project_id`、`phase=sync_config`、`sync_enabled`、version、generation、结果码和提交结果关联后台日志；不记录凭据或 PR 正文。关闭回执表示数据库停止准入已提交，不表示在途远端请求均已退出。未知结果以重读状态核对。
