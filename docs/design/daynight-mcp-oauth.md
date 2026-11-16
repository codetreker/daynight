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

`core/oauth.ParseClientMetadata` 与 `ParseStoredClientMetadata` 保持严格的注册配置解析；
`ParseCIMDClientMetadata` 是要求 expected ID 的独立入口，复用完整 JSON、身份和字段校验，
仅对能力采用确定性交集及 code-flow 准入。缺省 grants/response 分别补 authorization code/code；
显式畸形或空能力字段拒绝。未知超集不妨碍共同 code flow，但不能产生 device 或其他执行能力。
这种区分来自 metadata 来源，不从 expected ID 或品牌推断。

`service/oauth.NewClients` 显式绑定三种 parser。configured 优先，其次读取和 pin DCR；
只有 DCR NotFound 才转 CIMD。`Clients.Resolve` 的 fetch 验证回调使用 CIMD parser，
新下载与缓存命中均验证。下载失败或解析失败映射 invalid client；调用方 context 取消/到期
向上传播，fetcher 自身 5 秒上限在调用方仍有效时映射 invalid client。授权 HTTP 层向浏览器
返回既有错误页和 `X-OAuth-Error`，其他调用返回 JSON，不向未验证 redirect 跳转。

fetcher 保留公网地址集合验证、固定已验证 IP 拨号与原 hostname TLS、无代理/重定向、
读取后的正文 64 KiB、5 秒、4 并发及 1024 项/1 小时缓存。测试通过已有 lookup/dial/tlsConfig
窄依赖接入受信任 TLS listener，并验证公网 IP 和真实 hostname；没有生产测试开关或不安全 fallback。

共享 `MatchRedirect` 先验证双方 URI 和精确匹配，再处理 HTTP loopback 例外：
字面量 IP 保持仅端口可变；精确 localhost 只有注册项无端口时允许请求选端口。
原始 path/query suffix 不解码或归一化，固定 localhost 端口与 HTTPS 仍精确匹配。
`FreezeClient` 对规范化 metadata 生成 digest，冻结实际完整 redirect 和既有 snapshot 字段；
digest 不是下载原文 hash。授权与换码不重新解析 metadata，不改变存储格式或既有记录。

授权入口验证客户端及回调后冻结请求参数，使用独立 HttpOnly 浏览器绑定并进入同源
`/oauth/consent`。登录返回路径只接受本地路由。浏览器读取安全展示字段；决定操作要求
当前 Session、精确 Origin、绑定和显示账户的 `expectedUserId`。浏览器不从状态读取恢复
code 或 state。账户变化触发重新读取，后台检查不应卸载稳定界面。

批准的 code 只保存 hash，一次交换在同一事务内消费 code 并发行凭据 family。匹配的重放
先提交 family 撤销再返回拒绝；错误绑定不消费 code。refresh 轮换和 public revoke 使
family 与 access 凭据保持一致。grant 的已记录使用时间独立于 access/refresh 轮换；账户列表的
v1、v2 投影与发布恢复约束由[身份认证架构](daynight-auth.md#主站-session-与-pat)拥有。
持久预算限制公开入口，统一有界维护清理过期记录。
授权和凭据响应禁止缓存，授权页面不发送 referrer。注册、token 和 revoke 的公开 CORS
不授予业务权限。

CIMD 交集不持久化逐客户端 grants 门禁；code 换码仍发行 access/refresh，family 轮换不变。
token adapter 仅调度 authorization code 和 refresh，其他 grant 在通过既有较早校验后
返回 `unsupported_grant_type`，不调用发行。公开 metadata 额外声明 device grant 不表示
服务提供 device endpoint。完整进程 API integration 以真实 DCR 无端口 localhost 证明正常
consent/换码/refresh/MCP 协作；完整官方 CIMD 原文归 core，受控真实 TLS/fetch/parser/cache
归 service，真实客户端选路与官方域名出站另行验收，三类证明不能互相代替。

[浏览器集成决策](../../.agents/notes/implemented/architecture/2026-11-06-mcp-oauth-browser-consent.md)
记录组合与未知结果的取舍；其关联的授权码和 grant 决策拥有事务及生命周期细节。
[metadata 兼容决策](../../.agents/notes/implemented/bug-fix/2026-11-16-mcp-oauth-metadata-compatibility.md)
记录来源策略与 localhost 例外的原因及代价。
