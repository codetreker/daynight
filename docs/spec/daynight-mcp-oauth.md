# MCP 连接发现与浏览器授权需求

## 安装说明

直接访问 `/mcp` 的普通 GET 返回无需凭据的 UTF-8 Markdown 安装说明，状态为 200。
未设置 `Accept`、`*/*` 和浏览器常见的 Accept 均可读取说明。普通 HEAD 返回相同响应
headers 且无正文。说明包含服务配置决定的 canonical endpoint、Codex 与 Claude Code
安装命令、其他 remote HTTP 客户端的配置示例、OAuth 授权与连接验证步骤。agent 可据此
完成连接配置；账户持有人仍须参与浏览器登录和授权。说明中的地址不得由请求 Host 或
forwarded headers 改写。

显式列出 `text/event-stream` 或携带 MCP protocol、session、method、name、resume
headers 的 GET/HEAD 保留 MCP 协议行为：未认证时返回 401 及 OAuth discovery challenge，
认证后由 stateless endpoint 返回 405 和 `Allow: POST`。所有 POST 均须认证。
普通说明读取不调用认证、业务操作或数据库；Host、Origin、禁止缓存和 shutdown 准入检查
仍须执行，响应发送失败须保留错误记录。

## 浏览器授权

MCP 客户端可从未认证协议请求发现授权信息，通过既有 Daynight 账户登录并决定是否授予
`daynight:mcp` 访问权限。OAuth access token 仅适用于精确的 `/mcp` 资源，业务操作仍按
当前账户权限判断；它不能用于普通 REST 或 Worker 入口。

授权页面展示当前账户、客户端名称和来源、实际回调主机、资源及访问内容。客户端名称由
客户端提供，不表示经过验证。HTTP loopback 回调还展示端口及返回本机客户端的含义。
用户可以允许、拒绝或切换账户；无效、过期请求不得授权。桌面和窄屏、中英文、键盘与焦点
操作均须可用。后台检查期间保留已显示内容和交互状态；账户实际变化后重新确认。

授权决定只提交一次。连接中断不能证明决定失败，也不能证明已生效授权被撤销。结果未知时
可检查原请求状态；已批准只证明决定，不证明授权码送达或客户端连接成功。丢失授权码时
用户须从客户端发起新请求，不重发决定或生成替代授权码。

客户端使用 authorization code、S256 PKCE 和精确资源绑定交换令牌，支持 refresh 和
撤销。错误绑定不得消费有效授权码；正确绑定的重放使已发行的凭据 family 失效。秘密不
进入日志或任务材料。服务端机制见[架构](../design/daynight-mcp-oauth.md)。
