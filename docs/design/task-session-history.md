# Task Session 历史读取设计

## 职责与入口

`core/session` 拥有当前关联、历史目录、读取授权、Controller 内容请求及归档验证。`service/session.History` 根据共享 `Inspection` 的明确 Session 身份协调 live 或 archive 读取，并返回持有归档句柄的 `ReadResult`。HTTP 与 MCP 只解析输入、传递真实 principal、预算包络和输出结果；CLI 通过 HTTP 读取，不能访问 Worker 的文件。

`GET /api/v1/projects/{projectId}/tasks/{taskId}/sessions/current?view=inspection` 返回当前关联；同目录的 `?view=inspection` 返回历史页。默认视图保持浏览器既有协议。`/{sessionId}/inspection` 返回指定身份、`currentBinding`、来源与本次连接的 `contentReadVersion`。`/{sessionId}/messages` 与 `/{sessionId}/message-content` 分别读取一页和一个正文块。

当前关联先取权威执行身份，再观察同一个 Session；关联在此期间改变时返回 `execution_changed`。目录在一个权限作用域内取得当前关联与历史页，不逐项重新观察。旧 Session 不因新 claim 改投另一执行。

## Controller 原文与来源屏障

`PendingContent` 保存的原始条目和 journal 是 live 原文来源。`inspect_page` 与 `entry_chunk` 使用独立读取投影，不经过 `sessionDisplayEntry`。现有 `sourceThrough` 顺序屏障保证返回内容与确认事件边界相符，响应仍绑定完整 Controller fence 和 history epoch。

Controller 每次连接发送 `X-Daynight-Content-Read-Version: 1`。服务端只把本次握手值绑定到成功 Connect 创建的 live connection；缺少声明为版本 0，不继承持久注册或旧连接。版本 0 只收到旧 timeline 请求；短条目可读取，显示预算占位返回 `upgrade_required`。重连的能力变化不修改 Web timeline 合同。

`inspect_page` 必须携带 `coverage`。Controller 从原始条目和资源集合计算已知缺口：工具原文的 `truncated=true` 对应 `entry_truncated`；没有此类缺口时，非 available 资源、缺失资源、明确不可用的图片或尚未解决的图片投影对应 `resource_unavailable`。资源闭包复用统一归档遍历，包含消息、工具、Markdown、reasoning 和 retained 绑定。覆盖事实先于条目分页、正文引用和 conversation 过滤确定；服务端按原值传递，空过滤页仍可为 partial。归档先通过格式、引用及完整性校验，合法内容的投影应用同一覆盖规则，并保留归档自己的完整性事实；悬空资源引用仍作为损坏拒绝。

## 页、引用与正文块

历史页默认取 20 条、最多 200 条，先按稳定序列选页，再应用 conversation 过滤。页内从旧到新排列，before 边界基于未过滤页。live cursor 绑定 Session、epoch 和边界序列；archive cursor 同时绑定归档 SHA256。来源或 epoch 改变须重置，不在续页时自动切换来源。

每项完整正文使用规范 JSON；超预算项返回有限元数据和 `contentRef`，其边界仍推进。资源描述符只包含标识、名称、类型、大小、摘要和可用性，预览数量有界且明确标记缺省；名称保留统一图片资源允许的最多 1024 UTF-8 字节。图片几何信息不进入这六字段元数据预览；原始资源引用保留在完整正文内。

正文引用固定 entryId、revision、epoch、来源版本、SHA256 和 UTF-8 字节数。块读取校验全部身份，从指定字节偏移返回最多 32 KiB，块尾退到完整 Unicode 码点。所有数字序列、大小和偏移以十进制字符串表示。原文重建后可用摘要和字节数校验；变化返回 `content_changed`，不拼接不同版本。

页与块生产方计入完整编码响应预算。HTTP 传入换行开销；MCP 计入实际请求 ID、协议版本、批次边界与 meta 等包络开销。此专用 256 KiB 预算不会恢复普通资源读取的通用预算。MCP 成功结果使用普通 JSON 编码，公开 schema 由协议测试验证。

MCP 在 SDK 执行前拒绝包含历史读取的多调用 batch 和无法容纳的请求 ID，避免其他结果或 ID 回显突破历史响应预算。独立读取及单调用 legacy batch 使用最多 256 KiB 的专用响应缓冲；完整编码后才提交，分次写入或错误包络超限时统一返回有界 `resource_limit_exceeded`。其他工具保留既有编码路径。归档许可持续持有到缓冲结果最终写出或取消。

## 归档与权限生命周期

首次读取通过 inspection 确定可用来源；带 cursor 的请求必须维持其来源。归档走 `ArchiveContentReserved` 的权限、预留、大小、摘要及格式检查，然后只投影请求页或块。schema3 在同一个归档操作中验证 manifest 并读取其独立 timeline，不生成 schema1 兼容副本；共享归档许可和 timeline 读取 lease 均随结果句柄保留到响应交付完成或取消。旧格式仍可能完整物化最多 64 MiB，因此 MCP read/entry 选择 `BudgetLarge`。预检与驻留许可随结果句柄保留到 HTTP 响应完成或取消；MCP 绑定请求交付作用域，不能在工具 callback 返回时提前释放。

Task 内容读取使用单独的授权目的，允许真实 PAT、browser Session 以及固定 API/MCP OAuth binding，并逐页、逐块重新检查。SessionDAO 在原事务中委托 family DAO；API 必须匹配配置 Origin 下的 API resource、daynight:api scope 和 societas-bot client，MCP 保留原 Task 读取子集。可读归档预检保留原 WriteSession 的 READ COMMITTED 事务作用域，其中 ReadOAuthCredential 使用无行锁查询；API 可进入既有用户可读归档，MCP 仅可进入原 Task ArchiveV1Read。实际 IO 准入再次使用原 scope、权限及锁序；独立 Session 保留 owner 与 parent PAT 检查。Controller 注册、生产 channel、归档上传与完成仍使用原生产者条件。网络内容等待后再次授权，并拒绝变化的 fence/epoch。pending、缺件、损坏、来源变化、空历史与可证明的覆盖缺口保留独立结果，不把无法判断的完整性当作已验证事实。

## 客户端与验证

CLI 的 current/list/show/read/entry 每次读取一页或一块，文本先按 LF 分行再执行 `terminalText`，JSON 保留完整 body 或显式引用。历史内容是被观察数据，不成为指令或新的授权。MCP 对应工具复用相同用例及身份字段，输入 schema 拒绝未知参数；正文不会经过 shell。

Controller 用真实 journal 验证分页与大条目，协议测试核对跨语言规范 JSON、Unicode 和版本错误。core 验证权限、来源与内容规则，service 用直接业务操作 mock 验证编排与句柄生命周期，HTTP/MCP 用直接用例 mock 验证协议、实际包络大小、取消与交付后释放。DAO 的真实锁和跨调用读取保留隔离 PostgreSQL 证明。

要求见[历史读取规格](../spec/task-session-history.md)，取舍见[决策记录](../../.agents/notes/implemented/feature/2026-11-10-task-session-history.md)。
