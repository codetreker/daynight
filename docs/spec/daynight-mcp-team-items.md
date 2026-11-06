# MCP Team 列表项完整读取需求

## 目标与范围

标准 MCP 客户端能够遍历 `team_list`、`team_member_list`、`team_projects` 的全部结果，并完整读取超过列表预算或单次完整响应容量的项。读取保留现有账户、Team 和 Project 权限、完整项边界、字段的 null 语义及精确业务版本。

普通目录分页反映各次请求的当前快照，不冻结整个目录。分块读取同一个项时，不能把不同内容拼接为一个完整项。读取期间内容变化应明确拒绝继续，调用方重新读取当前项。

## 列表与超大项

成功页的 `items` 包含完整列表项；`nextCursor` 来自最后实际返回的项，并保留现有账户、列表种类及作用域绑定。条数和编码预算共同限制页大小。

超大项之前有正常项时，先返回这些完整项及其续页游标。超大项成为首个待返回项时，返回 `payload_too_large`，错误引用必须包含对象身份、`readTool:team_item_read`、可直接调用的 `readArguments` 和 `cursorAfterItem`。数据库原始字段超预算与 JSON escaping 后超预算遵守相同合同。

调用方读取该项后，可以把 `cursorAfterItem` 作为下一次列表 cursor。该位置来自被明确报告的项，而不是数据库额外预读的后续项。引用不表示内容已读取，游标不提供授权或读完证明。连续超大项逐项报告；超大末项读取后，续页得到空列表及 `nextCursor:null`。

## 有界读取工具

`team_item_read` 通过普通 `tools/call` 提供读取，目标 Team 必须明确指定。

| 参数 | 合同 |
|---|---|
| `kind` | `team`、`member` 或 `project` |
| `team` | Team 的规范 UUID；Personal Team 同样使用其 UUID，不读取 CLI 本地默认值 |
| `userId` | member 目标的规范 UUID；其他 kind 不接受 |
| `projectId` | project 目标的规范 UUID；其他 kind 不接受 |
| `action` | `inspect` 或 `chunk`，缺省 inspect |

`inspect` 返回 `projection:metadata`、`contentIncluded:false`、固定字段的 `header`、不透明 `revision` 及全部可变长度字段的描述。header 保留原列表 DTO 的其余字段，包括角色、时间、嵌套 settings/ownership 和完整十进制业务版本。

| kind | 分块字段 |
|---|---|
| team | `name` |
| member | `profile.name`、`profile.email`、`profile.avatarUrl` |
| project | `name`、`repoUrl` |

字段描述包含 `field`、`isNull` 和源 UTF-8 字节数 `sizeBytes`。null 与空字符串必须区分；空字符串字节数为零。字段没有全部读取前，metadata 不能被视为完整对象。

例如，先检查成员资料；revision 由这次 inspect 返回，后续 chunk 原样回传：

```json
{"kind":"member","team":"11111111-1111-4111-8111-111111111111","userId":"22222222-2222-4222-8222-222222222222","action":"inspect"}
```

```json
{"kind":"member","team":"11111111-1111-4111-8111-111111111111","userId":"22222222-2222-4222-8222-222222222222","action":"chunk","revision":"<inspect 返回的 revision>","field":"profile.name","offset":"0","format":"base64"}
```

`chunk` 必须携带同一身份、revision、白名单 field 和 offset。offset、sizeBytes、readBytes、nextOffset 均为 canonical 非负十进制字符串，不能经过不精确的数字转换。`maxBytes` 为 `1..524288` 的整数，缺省 8192；format 缺省 text，也可显式选择 base64。inspect 不接受 chunk 参数。

成功块返回同一 revision 和 field，以及 offset、readBytes、nextOffset、eof 和内容；满足 `nextOffset = offset + readBytes` 及 `eof ⇔ nextOffset = sizeBytes`。offset 超过字段长度时拒绝；等于长度时返回空内容、零 readBytes、原 nextOffset 和 eof true。null 字段拒绝 chunk，空字符串允许 EOF 读取。

text 起点必须是合法 UTF-8 码点边界，末尾只能包含完整码点。源字节预算或编码结果预算不足以容纳一个码点时明确报错，不能返回零进度的非终态。base64 允许任意合法字节起点；调用方逐块解码再拼接字节，不能直接拼接带 padding 的 base64 字符串。

调用方检查偏移连续、总长度和 EOF，把读取完成的字段放回 header 对应位置，恢复原列表项的语义和字段 UTF-8 字节。该保证不要求不同 JSON encoder 产生相同空白或字段顺序。

## 变化检测与权限

变化检测复用现有修改时间，不新增 profile 版本列。revision 绑定对象身份、作用域及相关记录的完整修改时间元组。时间保留数据库微秒精度，由调用方原样回传；不能通过 JavaScript Date 等毫秒表示重新序列化，也不能以元组的最大值代替分别比较。

实际可见内容变化必须使所属记录 `updated_at` 严格前进，即使写入赋入相同或较早的时间。Team 项覆盖 Team 和当前账户成员关系；member 项覆盖目标成员关系和用户资料；Project 项覆盖 Project 和 ownership。原 DTO 中的业务版本与原有修改命令规则保持。

每次调用检查当前凭据、Team 成员资格、目标成员关系或 Project 当前归属。直接 Project grant 不替代 Team 目录资格。读取内容和检查 revision 使用同一请求内快照；读取和可能等待结束后，在返回内容前重新检查当前 PAT 或 OAuth token/grant/resource/scope、Team 资格和目标存在性。授权失效或事务完成失败时不能返回块。

revision 不符返回 `version_conflict`，不带块内容；调用方重新 inspect 并丢弃该项已累计内容。删除、成员移除、离开、Project 转移或撤销按当前权限和不存在规则拒绝。成功授权判定后的撤销不能召回已经准入的内容，后续调用仍须重新检查。

## 容量与终止

`team_list`、`team_member_list`、`team_projects`、`team_item_read` 的成功和工具错误均提供等价的 structuredContent 与完整序列化 TextContent。只消费文本的客户端也能从列表开始，读取超大项并继续分页至终止。

默认完整 `CallToolResult` JSON 编码上限为 16 KiB，计入两种表示、escaping、metadata、错误及必需引用。仅显式 `maxBytes > 8192` 的 chunk 使用 8 MiB 编码上限；format base64 本身不升级预算。实际返回源字节可以小于 maxBytes，nextOffset 按实际字节推进。

上述结果预算不包含 SDK 外层 JSON-RPC ID 和 HTTP batch framing。不能将单结果 16 KiB 宣称为整个 HTTP body 上限。其他业务工具的结果策略保持各自合同。

元数据和块读取在数据库及 Go 中的物化量随固定头部和最大块大小受限，不随字段总长度增长；不得先读全字段再截取。大于 128 MiB 的合法成员资料仍应可逐块完整读取。请求之间不保留数据库事务、连接或历史快照；取消停止查询并释放请求资源。

## 验证

常规验证覆盖完整项前缀、连续超大项、超大末项、相同创建时间排序、跨账户和作用域 cursor 拒绝、原始大小与 escaping 超预算。逐种类核对全部 DTO 字段，包含 Personal Team name null、profile null/空串、大整数版本、多字节和控制字符。

读取变化和授权等待验证覆盖同一微秒写入、较早时间在等待后提交、元组较早分量变化、角色和 profile 修改、Team 改名、Project 设置/转移/删除，以及 credential/grant 撤销和到期。两种格式均验证非法 offset、UTF-8 起点、EOF、重复块、版本冲突不返回内容及取消清理。

大容量、内存和吞吐测量单独运行，不进入常规 CI。校验客户端流式比较重建字段，避免自身累计完整字段影响服务端测量；分别记录 inspect 和早、中、末块的 Go heap、数据库私有内存、字节与耗时。标准 Go/TypeScript MCP 调用和只消费 TextContent 的完整遍历均须验证。机制、迁移成本与观测方法见[设计](../design/daynight-mcp-team-items.md)。
