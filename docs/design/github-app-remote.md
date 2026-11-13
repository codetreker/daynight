# GitHub App 远端读取

`service/github/remote` 以服务端 GitHub App 读取 installation、仓库与 PR 的事实，返回 `core/model/githubpr` 的纯观测结构。该组件不检查 GitHub 操作者身份、角色或安装授权来源，也不执行状态标准化、存储、连接写入或后台调度。

## 配置与认证

`github.enabled` 默认为 false。启用时必须提供正整数 `app_id`、RSA PEM 文件 `private_key_file` 和非空 `webhook_secret`；服务启动时检查本地配置和私钥，错误不输出凭据。相对私钥路径基于服务配置根目录。环境变量覆盖 YAML，未知 GitHub 配置字段被拒绝。

客户端使用 RS256 App JWT，`iat` 回拨 60 秒，`exp` 为当前时间后 9 分钟。安装 token 只请求 Pull requests read 权限，并按 installation ID 缓存到到期前 60 秒；并发调用共享一次获取，等待者可取消。token 仅在内存中保存。一次读取操作至多对 401 清除实际失败的 token 并刷新一次，旧响应不能清除已更新的 token。

## 读取合同

GitHub API 固定使用 `https://api.github.com` 和 `X-GitHub-Api-Version: 2026-03-10`。每次 HTTP 请求最多 15 秒，调用方的 context 可以更早取消；重定向和分页链接只能指向同一 API origin。安装发现使用 App JWT；安装访问验证分别读取仓库身份和最小 open PR 页，不能只凭仓库信息推断 PR 权限。

仓库 ID 是稳定身份；当前名称可从 installation repositories 全部分页按 ID 查找，不能把同名新仓库视为原仓库。open PR 按创建时间正序读取并逐页交付，遵循全部 Link next；单项读取可取得已关闭 PR。读取不根据 `updated_at` 丢弃观测，保留同秒 head 变化、原始正文及可空作者和 fork。缺失必要字段或无效响应返回错误，不伪造空结果。

403 的权限拒绝与 403/429 限流分别表达；限流错误携带根据 `Retry-After` 和剩余配额重置时间计算的恢复时间，无时间提示的 secondary limit 至少等待一分钟。调用方负责调度及保留已存数据。错误不包含响应正文、token、私钥或 secret；该组件不记录正文或凭据。
