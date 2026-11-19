# GitHub App 远端读取

`service/github/remote` 以服务端 GitHub App 读取 installation、仓库与 PR 的事实，返回 `core/model/githubpr` 的纯观测结构。该组件不检查 GitHub 操作者身份、角色或安装授权来源，也不执行状态标准化、存储、连接写入或后台调度。

## 配置与认证

App 管理员通过登记或凭据替换提交 RSA PEM 私钥和 Webhook secret；服务验证凭据并保存在独立 App 资源中，不使用全局 App 部署配置。凭据及错误不得泄露到日志或公开读取结果。

客户端使用 RS256 App JWT，`iat` 回拨 60 秒，`exp` 为当前时间后 9 分钟。安装 token 只请求 Pull requests read 权限，并按 installation ID 缓存到到期前 60 秒；并发调用共享一次获取，等待者可取消。token 仅在内存中保存。一次读取操作至多对 401 清除实际失败的 token 并刷新一次，旧响应不能清除已更新的 token。

## 读取合同

GitHub API 固定使用 `https://api.github.com` 和 `X-GitHub-Api-Version: 2026-03-10`。常规远端读取的每次 HTTP 请求最多 15 秒，调用方的 context 可以更早取消；重定向和分页链接只能指向同一 API origin。安装发现与安装状态读取使用 App JWT；安装状态区分确认删除、暂停与其他错误。安装访问验证分别读取仓库身份和最小 open PR 页，不能只凭仓库信息推断 PR 权限。执行器通过 context 注入请求前检查点，每次实际 HTTP 跳转（包括 token 获取、重试和重定向）均执行检查点，失败时不发送该请求。

仓库 ID 是稳定身份；当前名称可从 installation repositories 全部分页按 ID 查找，不能把同名新仓库视为原仓库。open PR 按创建时间正序读取并逐页交付，遵循全部 Link next；全状态发现每轮从头按创建时间倒序读取至多 10 页、每页 20 条，按当前仓库身份校验每页观测并接受页间重复。同源的下一页链接可以使用 `/repos/{owner}/{repo}/pulls` 或 `/repositories/{id}/pulls`，路径必须匹配本次读取的仓库，查询必须保留扫描参数并指向连续下一页。单项读取可取得已关闭 PR。读取不根据 `updated_at` 丢弃观测，保留同秒 head 变化、原始正文及可空作者和 fork。缺失必要字段或无效响应返回错误，不伪造空结果。

403 的权限拒绝与 403/429 限流分别表达；限流错误携带根据 `Retry-After` 和剩余配额重置时间计算的恢复时间，无时间提示的 secondary limit 至少等待一分钟。调用方负责调度及保留已存数据。错误不包含响应正文、token、私钥或 secret；该组件不记录正文或凭据。

独立 App 登记用提交的 RSA 私钥签发 App JWT，向固定 origin 的 `GET /app` 证明外部 App ID，并保存返回的名称和 slug。登记的 45 秒总预算包含输入读取、远端证明和事务；外部请求不持有数据库锁。认证失败或身份不匹配与上游故障分别表达，响应正文及凭据不进入错误或日志。

## 独立 App 客户端的资源所有权

独立 App provider 按本地 App UUID 与 credentialVersion 借用远端 client；每次借用读取当前活 App 的凭据快照，版本不符时拒绝。快照读取不授予使用权限，调用者仍须在执行与发布时按数据库中的当前授权和版本设置 fence。不同 App 或凭据版本使用不同 client、installation token 缓存和 transport。管理操作证明拟保存的凭据时直接使用该输入创建临时 client，不使用已保存的缓存。

provider 跟踪活动借用，最多保留 64 个零借用 client，按最近使用顺序淘汰；旧凭据不再接受新借用，最后一次释放后关闭其空闲连接。关闭时先停止新的借用并取消等待中的读取，调用方负责取消并 drain 已借用的工作。关闭期限到达时仍被使用的资源保留，返回清理失败；最后释放后才能关闭 transport。
