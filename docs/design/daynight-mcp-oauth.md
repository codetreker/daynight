# MCP 连接发现与浏览器授权架构

[需求](../spec/daynight-mcp-oauth.md)定义安装发现、浏览器旅程与可观察结果。服务以配置的
`server.public_origin` 为 issuer（可由 `DAYNIGHT_PUBLIC_ORIGIN` 覆盖），精确的 `/mcp` URL 为资源。

## endpoint 文档与协议分流

`server/mcp.Entry` 在构建时以 canonical resource 渲染随包 Markdown 安装说明，分别对
shell 命令和 JSON 配置中的 URL 编码，不读取请求 Host 或 forwarded headers。
HTTP 请求先经过既有 shutdown 准入、Host 和 Origin 校验。普通 GET/HEAD 在认证前读取
说明，GET 返回 `text/markdown; charset=utf-8` 和完整正文，HEAD 只返回相同 headers；
两者保持 `Cache-Control: no-store` 和既有响应发送错误记录。

GET/HEAD 显式列出的 `text/event-stream` media type，以及 `MCP-Protocol-Version`、
`MCP-Session-Id`、`MCP-Method`、`MCP-Name`、`Last-Event-ID` headers 标识协议请求。
判别支持多条 Accept、逗号列表、大小写及 media parameters；通配符不表示 stream 意图，
以便浏览器和 curl 直接读取说明。其余方法保留协议入口，OPTIONS 提供 CORS preflight。

协议请求各自认证 PAT 或 MCP OAuth access token，未认证时的 Bearer challenge 指向
protected-resource metadata。stateless SDK 对认证后的 GET/HEAD 返回 405 和
`Allow: POST`，不提供独立 SSE stream；安装说明指导客户端使用 Streamable HTTP。
文档分支不创建 principal、不保留凭据，也不进入业务用例或数据库。

## OAuth 发现与授权

authorization-server metadata 描述公开注册、授权、令牌、撤销、code、S256 和 `none`
客户端认证。客户端可通过动态注册、HTTPS metadata 文档或
`oauth.preregistered_clients` 配置识别；YAML 使用以 client ID 为键的 mapping，
`DAYNIGHT_OAUTH_PREREGISTERED_CLIENTS` 可用 JSON 对象覆盖，值为对应公开 metadata 文档。服务启动时校验这些文档及其 ID，拒绝无效配置。

授权入口验证客户端及回调后冻结请求参数，使用独立 HttpOnly 浏览器绑定并进入同源
`/oauth/consent`。登录返回路径只接受本地路由。浏览器读取安全展示字段；决定操作要求
当前 Session、精确 Origin、绑定和显示账户的 `expectedUserId`。浏览器不从状态读取恢复
code 或 state。账户变化触发重新读取，后台检查不应卸载稳定界面。

批准的 code 只保存 hash，一次交换在同一事务内消费 code 并发行凭据 family。匹配的重放
先提交 family 撤销再返回拒绝；错误绑定不消费 code。refresh 轮换和 public revoke 使
family 与 access 凭据保持一致。持久预算限制公开入口，统一有界维护清理过期记录。
授权和凭据响应禁止缓存，授权页面不发送 referrer。注册、token 和 revoke 的公开 CORS
不授予业务权限。

[浏览器集成决策](../../.agents/notes/implemented/architecture/2026-11-06-mcp-oauth-browser-consent.md)
记录组合与未知结果的取舍；其关联的授权码和 grant 决策拥有事务及生命周期细节。
