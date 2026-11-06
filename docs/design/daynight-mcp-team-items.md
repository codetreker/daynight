# MCP Team 列表项有界读取设计

[需求](../spec/daynight-mcp-team-items.md)拥有完整读取、续页、变化拒绝和容量合同。本设计解释数据库范围读取、事务与协议分工；普通目录仍按 successive snapshots 读取，分块对象不保留历史版本。

## 结构与职责

`core/model` 保存读取目标、字段元数据和固定业务模型。`core/teamitem` 校验 kind、对象身份、字段、offset 与 revision；`service/teamitem` 组织内容读取和最终授权。`core/store` 的独立 Team item 合同不扩大所有已有快照 Reader；PostgreSQL 实现拥有 SQL、锁、事务和迁移。MCP 适配只映射固定 DTO 头部、构造可执行引用和编码有界结果。

```mermaid
flowchart LR
  L[Team 列表工具] --> P[有界目录 DAO]
  P --> B[完整项页或超大项边界]
  B --> R[team_item_read]
  R --> S[内容与修改时间快照]
  S --> A[当前授权事务]
  A --> E[有界双表示结果]
```

## 列表边界

目录 DAO 在取页前完成资格过滤，返回完整项或有界超大项描述。描述保留真实对象身份和排序键，不能直接丢弃成不含定位信息的错误。原始字符串超过 DAO 预算时不将该字段传给 Go；JSON escaping 造成的超预算由适配层发现。

普通页在完整项边界裁剪，nextCursor 始终来自最后实际包含项。首个待返回项无法容纳时，错误引用包含 `readTool`、`readArguments`、`cursorAfterItem`。成员位置使用成员关系 `(created_at,user_id)`，Team/Project 使用 `(created_at,id)`；均复用现有账户和作用域校验。该特殊 cursor 对应明确报告的超大项，不授予访问权，也不证明其内容已读。

## 字段范围读取

列表项只有六种可变长度源字段：users 的 name/email/avatar_url，teams 的 name，projects 的 name/repo_url。inspect 返回字段 null 标志和 `octet_length`，其余固定数据构成 header。chunk 只读取被选择的字段；所有分块都标识同一目标和 revision。

原始 text 的 substring 不是可证明的固定内存范围读取。UTF-8 字符偏移可能使 PostgreSQL 从开头取得前缀，压缩 TOAST 切片还可能读取或解压更大的输入。实现为源字段维护 UTF-8 bytea 投影，设置 `STORAGE EXTERNAL`，使大值不压缩并支持按真实字节位置取得所需片段。DAO 不在读路径执行全字段 convert_to、JSON 构造、hash 或 Go 扫描。

这一存储选择由 PostgreSQL 的[文本切片实现](https://github.com/postgres/postgres/blob/3d6a828938a5fa0444275d3d2f67b64ec3199eb7/src/backend/utils/adt/varlena.c#L950-L1038)、[bytea 切片实现](https://github.com/postgres/postgres/blob/3d6a828938a5fa0444275d3d2f67b64ec3199eb7/src/backend/utils/adt/varlena.c#L3074-L3131)及[未压缩 TOAST 切片路径](https://github.com/postgres/postgres/blob/3d6a828938a5fa0444275d3d2f67b64ec3199eb7/src/backend/access/common/detoast.c#L226-L234)决定。原始 text 继续是业务字段，bytea 只承担有界读取。

字段名使用固定白名单，SQL 偏移为源字节 offset 加一。范围和算术在参数转换前检查。text 用固定额外字节判断 UTF-8 起终点；base64 可返回跨码点的原字节，调用方解码后再拼接。最终 EOF 与实际返回字节相关，不与请求的 maxBytes 相等关系相关。

## 修改时间与一致性

revision 编码目标、作用域及完整修改时间元组：

| 项 | 修改时间来源 |
|---|---|
| Team | Team、当前账户的成员关系 |
| member | 目标成员关系、目标用户资料 |
| Project | Project、project_ownership |

各分量分别比较，不取 MAX。否则元组中较早的一项变化后仍可能小于另一项，导致最大值不变。客户端直接回传 revision，不将其中的时间经毫秒时间类型重新编码。

数据库写入在实际可见字段改变时，使 updated_at 至少等于旧值加一微秒，同时保留更晚的赋入时间。行更新锁串行化该判断，覆盖同一微秒赋值以及事务前采样、等待后提交的时间。Team、成员关系、Project、ownership 和用户资料遵守相同规则，不新增 profile 版本字段。业务原有版本继续用于原有修改前置条件。

内容、头部、字段长度和 revision 在同一只读 Repeatable Read 快照内取得。chunk 的 revision 不匹配时返回 `version_conflict`，不返回新块；客户端重新 inspect，清空该项的旧内容。变化频繁的对象可能多次重读，这一成本避免了历史内容保留、磁盘快照和过期清理。

## 最终授权与删除

新读取用例在内容快照中检查 Team 资格及目标关系，内容读取后再使用短 Read Committed 授权事务。最终检查取得当前凭据、Team 成员关系、目标成员关系或 Project 所属事实，不复用旧 Repeatable Read 快照作为撤销重检。授权查询只读固定事实，不加载 Team 名称或其他可变长度字段。

Project 读取沿用 Team 目录资格，外部 Project grant 不代替成员关系；同时检查当前 ownership 与 Project 删除标记。授权锁遵守既有 Project 生命周期和 Team 锁序；OAuth grant 先于其 access token，所有可能等待结束后重检 token/grant 到期、scope/resource、主体和目标。失效或授权事务完成失败均丢弃已读取块。事务仅用于授权锁定，不制造业务写入回执。

最终授权成功是本次返回的准入点。后续撤销不召回已准入内容；每个后续调用从头检查。请求结束释放事务、连接和 permit，没有跨请求后台读取、历史事务或数据快照。

## 投影维护与迁移

迁移 `045_team_item_bytes.sql` 为上述字段增加派生 bytea 列，并在填充值前设置 EXTERNAL。现有值以 256 行 SQL 批次回填，再安装字段维护与修改时间 trigger、null 对应约束和必需字段约束；整个过程与迁移登记处于同一个既有迁移事务。DDL 锁在提交前保持，中间状态不会作为新读取能力对外暴露。

INSERT 在同一事务编码对应源字段；UPDATE 只重建实际改变的投影。源字段未变化时直接修改投影会显式拒绝，避免业务值与范围读取值分离。null 源得到 null 投影，空字符串得到零字节投影。后续修改时间规则不依赖应用正确采样到一个更晚的时刻。

SQL 批次不等于分批提交，也不承诺在线无阻塞。迁移失败整体回滚，新应用在成功完成迁移后才接受请求。部署应安排相应迁移窗口并保留既有备份和恢复规则；迁移器的 advisory lock 协调迁移器，不使旧写入程序理解新合同。

bytea 投影增加接近原始 UTF-8 字节量的磁盘数据。由于 EXTERNAL 不压缩，这份数据可能显著大于已压缩 text；还须计入写入 WAL、迁移中新旧行版本、临时空间及复制积压。UTF-8 编码、text 相等比较和 upsert 的 INSERT/UPDATE trigger 路径可能物化全字段；这些是写入与迁移成本，不属于有界块读取的内存保证。

## 结果编码与准入

四工具的成功与错误均将相同 envelope 放入 StructuredContent 和序列化 TextContent。专用结果策略按真实序列化的完整 `CallToolResult` 计算 16 KiB 默认预算，覆盖嵌套 escaping、错误和必需引用。仅显式 maxBytes 大于 8192 的 chunk 使用 8 MiB 上限。适配层可缩小实际 text/base64 内容，并让 nextOffset 按实际字节前进；无法产生至少一个完整码点时明确拒绝。

内部公共 success/error schema 不增加第三种根分支，inspect/chunk 的结构在 data 内区分。超大项引用是恢复所必需的合同，不能为错误编码兜底随意删掉 refs。其他工具继续使用其原有短文本策略和容量。

纯结果编码与 SDK HTTP 输出分别测量。SDK 还回显 JSON-RPC ID，并可能包裹 batch；外层 framing 不计入单个 CallToolResult 的预算，也不因此新增长度约束。日志 request_id 继续使用已有长度限制。

准入类别由最大内部物化量决定，在证明整个 DAO 与授权路径有界前保留大对象准入。permit 持有至 handler 与响应交付结束；取消与失败都释放请求资源。

## 观测与验证边界

每次工具调用沿用独立 request scope，持有 request_id、principal 和 credential。MCP 完成/失败日志以 operation 标识工具；四工具只从返回引用提取验证过的规范 UUID，记录 team_id、member_user_id、project_id，成功 chunk 另记录 returned_bytes。其他任意引用、revision、profile、块内容和凭据不进入日志。没有新建后台工作或跨请求 tracing 生命周期。

调查成员读取时，在 JSON 日志中筛选 `component=mcp`、`operation=team_item_read`、目标 team_id 与 member_user_id，并用 request_id 关联完成或失败；查看 error_code 区分权限拒绝、version_conflict 和输出构造失败，成功返回量使用 returned_bytes。分块延迟、Go heap、数据库 MemoryContext/私有内存和编码量在独立容量验证中分别记录；不将 RSS 共享缓存映射直接等同私有分配。

普通测试覆盖接口、原始时间、触发器、权限等待、软删除和续页重建；大于 128 MiB 及接近 PostgreSQL 合法容量的样本独立运行。`TestStressMCPTeamItemCapacityAndReadMemory` 使用 4、129、900 MiB 可压缩和不可压缩 UTF-8 字段，独立 Go SDK 子进程流式核对完整字节，避免客户端分配进入服务器 Go heap。私有内存采样按 PostgreSQL 进程的 Private_Clean、Private_Dirty 和 Private_Hugetlb 计算；持有切片的 MemoryContext 探针补充采样，其结果只描述该切片机制，不替代生产查询全链路测量。

完整模式由 `DAYNIGHT_TEST_MCP_ITEM_CACHE_MODE=restart` 明确选择，只重启 `DAYNIGHT_TEST_POSTGRES_CONTAINER` 指定的专用可丢弃 PostgreSQL 集群，验证 PostgreSQL 缓冲和 backend 缓存冷/热两种条件；主机 OS page cache 仍可能是热的。`warm-only` 仅用于 smoke/debug，不代替完整模式。该集群运行时不能被其他测试共享。Go 客户端协商 `2026-07-28`；独立的 `TestStressMCPTeamItemsTypeScriptSDK` 使用官方固定版本 `@modelcontextprotocol/sdk@1.32.2`，协商其支持的 `2025-11-25`，并从 TextContent 完成三类目录的读取、重建、续页和时间变化拒绝。

两项测试均使用 stress build tag，检测到 CI 时明确失败；SDK 安装在项目临时目录的独立 private pnpm workspace，包、缓存与状态不进入用户目录或产品依赖。可复现准备和命令见[服务验证说明](../../packages/daynight-server/README.md#team-item-capacity-and-sdk-validation)。迁移和写入另量化锁、WAL、磁盘和内存，不用读路径的有界结论掩盖它们；容量结论以对应源码与独立执行记录为准。

选择背景、原始限制与替代方案见[决策记录](../../.agents/notes/implemented/architecture/2026-11-06-mcp-team-item-reads.md)。
