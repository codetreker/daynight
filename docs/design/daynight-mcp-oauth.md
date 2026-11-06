# MCP 浏览器授权架构

[需求](../spec/daynight-mcp-oauth.md)定义浏览器旅程与可观察结果。服务以配置的
`DAYNIGHT_PUBLIC_ORIGIN` 为 issuer，精确的 `/mcp` URL 为资源。未认证 MCP 请求的
Bearer challenge 指向 protected-resource metadata；authorization-server metadata 描述
公开注册、授权、令牌、撤销、code、S256 和 `none` 客户端认证。
客户端可通过动态注册、HTTPS metadata 文档或 `DAYNIGHT_OAUTH_PREREGISTERED_CLIENTS`
配置识别；配置是以 client ID 为键的 JSON 对象，值为对应公开 metadata 文档。服务启动时
校验这些文档及其 ID，拒绝无效配置。

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
