# 独立 GitHub App 的同步执行

`service/github.AppExecutor` 与 `AppRunner` 提供跨独立 App 的后台执行组件。生产运行时使用数据库中的当前 App、凭据版本与 Team 使用授权；客户端借用不提供授权。App 登记、凭据资源与 Team 使用授权分别见[登记设计](github-app-registration.md)、[远端读取](github-app-remote.md)和[授权设计](github-app-team-grants.md)。

## 原始执行身份

领取在短事务中捕获本地 App UUID、外部 App ID、credentialVersion、grant UUID、当前 owner Team 及 ownership version、connection generation 与独立 lease token。连接、同步意愿和 installation/repository 身份必须有效。后续事务携带原始授权身份，不能把重新授权、新凭据或转移后恢复的 owner Team 当作旧工作的授权；ownership version 拒绝 A→B→A 转移后的原领取，即使 connection generation 尚未改变。候选扫描仅提供提示，领取再次验证当前事实。

`GitHubAppWorkWriter` 在 Read Committed 事务内按 Project、ownership、Team 共享锁、App 共享锁、grant 共享锁、connection、pending 的顺序取得锁。读取候选绑定时不先锁 connection；获得上游锁后重新读取当前绑定。授权解除或 App 更新只按 App 到 connection 的顺序处理，不反向取得 Project 根，因此可以与执行事务串行化。

所有工作 DAO 操作复用同一授权检查：活 Project、活 App、当前凭据版本、未撤销的原 grant、grant 的 App 与当前 owner Team 一致、原 ownership version、有效连接与同步意愿。领取另查 generation、到期计划与无活动领取；检查点、续约、PR 和仓库观察发布、提示确认与重排、运行状态写入均另查原 generation、token 和数据库时间中的有效 lease。

## 远端操作与结果

确认领取后，执行器按捕获的 App UUID 与 credentialVersion 从 provider 借用 client。借用操作有独立的 15 秒期限，返回时立即取消该操作 context；后续同步仍使用原工作 context，所有使用退出后释放 client。凭据读取或连接池等待不能无限占用 runner 槽位。每次实际 HTTP 请求前通过 context 检查点验证并续约原领取，包括 token 获取、重试与重定向。数据库事务不跨远端请求。停止前已通过检查点的请求可能继续完成；停止后的检查点和旧结果发布均须拒绝。

[同步算法](github-sync-executor.md)负责访问检查、完整轮询、提示处理、标准化和失败调度；算法接收明确的远端、snapshot 与工作事务能力，不决定授权来源。执行入口使用 App-aware DAO。

领取、发布及完成分别保留 committed、not_committed 与 unknown。独立 App 领取结果未知时停止本轮，数据库中的领取按原期限到期；不重放未知写入。续约或发布失败同样停止，不把旧远端响应表达为已发布。日志携带 App、凭据版本、grant、Team、Project、generation 和 lease 标识，不记录秘密或 PR 正文。

## 调度与生命周期

单个 AppRunner 跨 App 扫描，每秒最多读取 32 个候选，最多同时执行四个不同 Project；每次执行派生自己的 context。数据库领取在不同服务实例之间提供同一 Project 的排他性。单个 App 的远端拒绝只结束对应工作。执行错误保留原因链；扫描与执行日志选择安全分类、数据库阶段和 SQLSTATE、事务阶段和提交结果、远端状态与 request ID，不写原始驱动或传输错误正文。扫描失败在后续周期重试。

停止领取与取消在途工作分别受控。异常退出通过 failure 通道与 readiness 暴露并停止新领取、取消工作；正常关闭等待所有执行退出。drain 超时返回错误并保留仍在使用的依赖，调用方在工作退出后再关闭 provider。构造不会自动启动后台任务，公共服务装配负责唯一 runner 和依赖关闭顺序。
