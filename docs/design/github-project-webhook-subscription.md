# 项目 GitHub Webhook 订阅管理

项目订阅配置保存在 `project_github`，与 App 连接、PR 同步设置使用独立版本。首次配置要求当前仓库连接；断开、撤权和项目归属转移保留配置，项目实际删除在同一事务清除配置及 secret。订阅管理能力和 HTTP adapter 可独立使用；生产路由尚未挂载该接口。

## 存储与事务

`hook_repository_id`、`hook_version`、`hook_enabled`、`hook_secret` 和 `hook_last_received_at` 分别保存批准的稳定仓库 ID、独立版本、启用状态、HMAC secret 和当前配置的最近有效收件时间。无配置时可空列为空且停用；已配置时仓库、版本和 secret 必须存在，停用时收件时间为空。业务层校验状态和 secret，普通状态读取不携带 secret，只检查其是否存在及长度；配置写入和验签的窄凭据读取校验 UTF-8。首次版本为 1，实际变更递增并清除收件时间；同值保留版本和收件状态，版本耗尽拒绝实际变更。

管理事务先验证有效 Project 管理员，锁活 Project 再锁连接行，之后以新语句读取活动绑定和 App/grant。连接锁与这些绑定失效路径共享，使配置写与撤权按提交顺序生效；单独的订阅版本不足以保护跨行授权事实。首次、换库、启用和更换 secret 要求当前有效绑定；停用可在断开时执行。预期版本在同值判断之前校验，SQL 使用预期版本条件，只有确认提交才返回成功。未知提交不得自动重放，安全投影无法证明 secret 是否写入。

## 收件与提示

独立收件操作接受绑定项目、配置版本和仓库身份的验签快照，拒绝与目标项目不一致的快照；在 Project 写事务锁活项目和连接后重新检查配置及当前绑定、App 和 grant。配置停用或版本变化时拒绝旧快照；投递仓库或活动绑定仓库不匹配时不写入。有效 `ping`、同步关闭或 App 无法入队时的有效 PR 只更新当前配置的收件时间。连接、同步及授权均有效的 PR 同时更新订阅收件时间、原 PR Webhook 收件状态和 revision，并按项目及 PR 编号合并现有提示。数据库时间在取得连接锁后读取，避免收件时间回退。

提示包含当前连接 generation、新 request ID、delivery ID 和到期时间；现有执行器按 request ID 确认，不能以旧确认删除较新的提示。队列 request ID 是独立生成的 UUID；收件日志同时记录 HTTP request ID 和队列 request ID，以关联请求和后续执行。收件和提示共用事务，只有确认提交才返回收件结果，未知提交不表示回滚。

## HTTP 合同

可选的 `projectWebhook` 对象与连接状态在同一读取快照取得，字段为 `version`、`enabled`、`repositoryId`、`lastReceivedAt`、`webhookUrl` 和 `state`。版本及仓库 ID 是十进制字符串或 null，时间为 UTC。状态按顺序为 `unconfigured`、`disabled`、`repository_mismatch`、`waiting` 或 `received`；仅当活动连接指向不同仓库时出现 `repository_mismatch`，断开本身不表示仓库不匹配。`received` 只表示当前配置收到有效投递，不表示 PR 已同步。URL 使用可信 Public Origin 和项目 UUID，不从请求头推导。

`PATCH /api/v1/projects/{projectId}/github/webhook` 接受 `expectedUserId`、`version`、`enabled` 及可选的 `repositoryId`、`secret`，返回相同安全对象。`version` 必须存在，首次为 null，此后为规范的正 int64 十进制字符串；`repositoryId` 如提供则同样为规范的正 int64 十进制字符串。`enabled` 必须为布尔值，未知或重复字段以及无效 Unicode 会被拒绝。首次绑定及换库要求当前仓库 ID 和 secret；secret 是 1 至 4096 字节的有效 UTF-8。项目成员可读取安全状态，只有有效 Project 管理员可写。响应和日志不包含 secret。

旧 GET 保持既有响应；生产路由接线由后续能力负责。项目连接和权限机制见[项目连接](github-app-project-connection.md)。

独立接收 adapter 提供 `POST /api/v1/github/projects/{projectId}/webhook`，读取项目窄凭据快照，以原始正文验证 `X-Hub-Signature-256`，再解析 `ping` 和 `pull_request` 并调用该项目的收件操作。正文上限为 25 MiB，请求预算为 8 秒。确认收件返回 202，已验签但无关或仓库不匹配返回 204；未配置或停用返回 404，签名失败返回 401，相关事件正文无效返回 400，超限返回 413，状态变化、期限到期或提交失败及未知返回 503。签名、secret 和正文不进入日志。生产路由尚未挂载接收入口。

## 项目设置界面

Web 项目 GitHub 设置消费可选的订阅对象，旧服务省略对象时仍保留连接、轮询和 PR 同步设置。订阅写入使用独立版本；连接和轮询写入的响应不替换订阅状态。读取和写入按项目、登录身份及请求顺序接纳，冲突或未知提交后重新读取而不重发；安全投影不能证明 secret 是否已保存。界面分别呈现有效收件与 PR 同步结果。项目管理员可输入或生成随机 secret，并由用户主动复制草稿；关闭或保存成功后清除草稿，普通成员只读。
