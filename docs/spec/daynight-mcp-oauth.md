# MCP 连接发现与浏览器授权需求

## 安装说明

直接访问 `/mcp` 的普通 GET 返回无需凭据的 UTF-8 Markdown 安装说明，状态为 200。
未设置 `Accept`、`*/*` 和浏览器常见的 Accept 均可读取说明。普通 HEAD 返回相同响应
headers 且无正文。说明包含服务配置决定的 canonical endpoint、Codex、Claude Code 与 Copilot CLI
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
进入日志或任务材料。授权所有者可读取最后已记录的合格使用时间；其可空语义及版本化列表
合同见[身份认证需求](daynight-auth.md)。服务端机制见[架构](../design/daynight-mcp-oauth.md)。

## 客户端 metadata 与回调

客户端按 configured → DCR → CIMD 顺序识别。DCR、已保存 DCR 和 configured clients
只接受既有支持的 grants/response types；不能因 client ID 是 URL 而放宽。
仅 HTTPS CIMD 文档采用能力交集准入：grants 取 `{authorization_code, refresh_token}`，
response types 取 `{code}`，并必须同时有 authorization code 和 code。未知额外能力可过滤；
device-only、refresh-only、未知-only 或无 code response 均拒绝为 invalid client。

两个能力字段分别缺省为 authorization code/code，不隐含客户端声明 refresh。
显式空数组、null、非数组、非字符串/null/空字符串元素、重复 JSON 字段、非法 Unicode、
错误身份和其他不合法 metadata 均拒绝，不能当作缺省。结构有效的能力重复项按集合处理，
有效 grants 固定按 authorization code、refresh 顺序输出，response 为 code。
其他身份、redirect、scope 和 public `none` 校验不放宽。

HTTPS redirect 逐字节匹配；字面量 loopback HTTP IP 保留仅端口可变的规则。
精确 `http://localhost` 注册项只有在未显式声明端口时才允许请求选取合法端口
1–65535，原始 path/query suffix 必须逐字节相同。固定 localhost 端口仍只允许完整
字符串匹配；不替换 localhost/IP，不接受相似主机、userinfo 或 fragment，不归一化
编码、query、空 path 或显式端口。共享规则适用于三种客户端来源。

授权冻结实际完整 redirect，换码仍精确绑定该 URI（含所选端口）、client、resource、
scope 和 S256。CIMD 能力交集只用于 code-flow 入口和 metadata 规范化，不是逐客户端
refresh 权限系统：现有 code 换码仍同时发行 access/refresh，保留 family 轮换和撤销。
不新增 device flow，发现仍仅声明 authorization code/refresh。合法编码、必填字段齐全、
精确 MCP resource 的 device 或其他未知 grant 返回 400 `unsupported_grant_type`，
不调用 code/refresh 发行；缺字段、错误 resource 和预算拒绝保留较早错误语义。

CIMD 下载保留 HTTPS、公网地址检查、已验证 IP 拨号与原 hostname TLS、无代理/重定向、
读取后的正文 64 KiB、5 秒、4 个并发槽，以及 1024 项/1 小时缓存限制。失败不缓存，
缓存命中仍验证；无效客户端不得收到向其不可信 redirect 的错误跳转。
固定文档与受控 TLS 测试不代替真实客户端授权、刷新和只读工具验收，也不证明生产
部署 SHA、服务侧官方 CIMD 可达性或原故障的全部原因。
