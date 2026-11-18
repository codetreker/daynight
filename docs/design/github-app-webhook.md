# GitHub App Webhook 接收

独立 App Webhook adapter 接收 `/api/v1/github/apps/{localAppId}/webhook`，以 URL 中的活 App UUID 选择 secret，外部数字 App ID 和请求头不授予身份。读取原始正文前开始八秒总预算，最多读取 25 MiB；读取正文时不持数据库锁。读取活 App 的 secret 和 credentialVersion 快照后，在事务外对原始字节执行 HMAC-SHA256 验签。秘密与正文不进入日志或持久化提示。

相关事件的提示事务先取得 App 共享锁并重新核对相同 credentialVersion，再按 grant UUID 顺序取得当前授权共享锁，按 Project UUID 顺序锁定候选连接，等待后重新判断当前 owner Team、活 Project、授权、连接、安装及仓库。事务不取得 Team 或 Project 根锁，避免与撤权、转移及删除的锁顺序相反。PR 提示按 generation 和 PR 编号合并并更新 PR Webhook 收件时间；安装提示只更新访问 hint、delivery ID 与复查时间，使旧领取失效并推进 revision，保留共享限流期限，不写 PR Webhook 收件或处理诊断。后续执行器读取 GitHub 当前事实，事件正文不直接发布 PR。访问复查与 PR 状态的职责见[同步执行器](github-sync-executor.md)。

未知或删除的 App 返回 404，签名缺失、格式错误或校验失败返回 401，正文超限返回 413，已认证的相关事件格式无效返回 400。已认证的无关事件返回 204；相关事件只有确认提交才返回 202，包括零匹配。凭据在验签后变更、存储失败、期限或未知提交返回 503，未知写入不自动重放。周期同步恢复丢失的提示。

生产路由使用该 adapter；部署与生命周期见 [GitHub 连接与运行时](github-connection-runtime.md)。
