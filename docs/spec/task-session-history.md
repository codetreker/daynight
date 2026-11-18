# Task Session 定位与历史读取

## 范围

本文同时定义既有历史读取和版本化的正文保存、期限及链目录要求。新增能力须由生产方明确声明后启用；规格不证明实现或容量验收完成。Bot 的近期窗口由[助手共享会话规格](bot-session-view.md#近期历史窗口合同)拥有，不应用普通 Task 的七天规则。

CLI 与 MCP 可在明确的 Project、Task 和 Session 范围内查询当前关联、历史目录、指定 Session 状态，以及 Web Session 的最近或更早 timeline entries。读取不会创建执行、恢复 Worker、改变 claim 或向 Agent 发送内容。Herdr 保留真实身份、状态与 `terminal_recording` 类型，不转换为聊天。

当前关联没有注册时返回 `not_registered`，没有适用执行时返回 `not_applicable`，不以最近历史代替当前。指定 Session 始终绑定其原始执行；Task 的新 claim 不能改变请求目标。目录明确标记 `currentBinding` 和归档事实，默认每页 20 项，最多 200 项。

## 历史页与完整条目

消息读取默认选择最近 20 条 timeline entries，允许 1–200 条。旧格式包含工具与交互事件；正文归档只包含其保存策略允许的条目。每页按旧到新排列，`beforeCursor` 继续向前读取。并发追加不改变先前页的边界；`conversation` 只过滤已选页，不追溯补齐数量。过滤后为空仍保留原页游标。

每项保留 `entryId`、`entrySeq`、`revision`、`kind`、真实可得的角色和时间。没有通用时间的条目输出 null。`body` 为完整原始规范条目；装不下时输出 `truncated=true`、有界元数据和 `contentRef`，不伪造错误消息或静默截断。资源只返回描述符和引用，不下载原件或输出二进制/base64。

消息页和正文块的完整响应均不超过 256 KiB，包括 HTTP 换行或 MCP 包络。大条目的 `entry` 读取每次返回最多 32 KiB UTF-8 字符串片段，不切开码点。引用及块携带 SHA256、总字节数、revision、epoch 与偏移；拼接可核对完整规范 JSON。版本变动返回 `content_changed`，epoch 或来源变化返回 `reset_required`，不能混拼。

MCP 历史读取分别发送独立请求，兼容仅含一个调用的 legacy batch；包含历史读取的多调用 batch 在任何工具执行前被拒绝。超大请求 ID 或错误包络也不得突破响应上限，超限返回有界的 `resource_limit_exceeded`，不能先输出半个成功对象。

live 和 archive 游标分域；首次读取按真实可用来源选择，续页保持原来源。live 转归档后必须从归档重新开始。空历史、未就绪、缺件、损坏、部分覆盖和授权失败分别表达；不能把失败包装成空页。

`coverage.state=partial` 保留原条目已截断、资源不可用或缺失、归档不完整等可见缺口。已知缺口不会因条目位于另一页、正文改为 `contentRef` 或 conversation 过滤而消失；仅为满足响应预算使用引用不构成缺口。`complete` 只说明已取得的条目与资源未暴露缺口，不证明 Provider 原生历史已被完整采集。CLI 先输出 partial 结果再以 3 退出，MCP 保留 `coverage` 并设置 `meta.partial=true`。

## 普通 Web Task 正文保存

`taskBodyHistoryVersion=1` 表示按 `TimelineEntry.kind` 在持久时间线入口选择 `user_message`、`assistant_message`，保留原正文、稳定 ID、顺序、revision、真实可得时间及正文引用资源。正文内的命令示例、错误、代码和日志不按关键词过滤。独立 `tool_call` 的参数、命令及 stdout/stderr 不进入这一持久时间线、同步正文、最终归档或其容量统计；在线工具查看仍可用。Herdr 的 `terminal_recording` 和旧格式归档保持原语义，不转换成正文格式。

执行控制、待确认操作、审批、回执、源事件确认水位及恢复证据依各自生命周期保存。过滤不能使下一条正文无法确认、重连重复派发或工具输出经另一条历史保存路径长期落盘。传输暂存须有容量与释放证据；本合同不要求新增运行时通道，也不授权重连丢失在线详情。正文引用图片继续进入归档资源闭包，工具专属资源仅在其真实引用与使用期限结束后释放。Task 附件独立保存；需要长期审阅的工具报告可显式提交为附件。Provider 自身原生日志不属于 Daynight 正文筛选保证。

既有 128 MiB／100,000 条正文保存阈值作用于筛选后的历史，不能以大量独立工具输出来耗尽正文额度。正文自身超限仍按真实缺口报告；政策排除的工具条目不构成正文 `coverage` 缺口，但必须显式显示 `contentPolicy=task_body`，不能宣称完整工具轨迹。`contentRef` 仍表示可重建的完整保留条目，不得指向已省略的工具原文。

## 七天期限与任务链目录

服务端时间为唯一期限时钟，七天为 7×24 小时。独立 Task 当前为 done 时取 `completedAt`，cancelled 时取 `cancelledAt`。任务链沿既有普通依赖连通分组；外部依赖不并入链，Goal 的 Parent 关系不替代链关系。只有链内全部普通成员为 done/cancelled 且终态时间已知时，链结束时间才为这些时间的最大值。任何未结束成员阻止到期；任一必需终态时间缺失则期限未知，不以 `updatedAt`、创建时间或其它成员的时间猜测。

每份可读且已提交的归档独立计算 `expiresAt = max(scopeEndedAt, firstArchivedAt, legacyGraceStartedAt（如适用）) + 7天`。`firstArchivedAt` 是服务端首次成功提交可读归档的时间，成功重试或重新读取不能刷新它。可读 partial 归档遵守同一期限并保留缺口；失败、待上传或未提交归档不得伪装成可读成功，也不因候选期限到达而丢弃唯一待补传来源。旧格式在启用清理时记录明确的升级宽限起点，至少再保留七天；缺少可信起点或终态时间时不自动删除。

到期清理须在撤销读取资格的事务内重新核对当前链成员、任务版本与终态、归档提交状态和引用事实。任务重开或链变化使仍可读归档重新计算期限；已物理删除的内容不可复原。逻辑过期先于物理删除，新读返回过期；已准入读写的句柄释放后才能回收独占字节。删除失败保留清理责任并可在重启后继续，不能恢复过期内容的读取资格。共享资源最后引用释放前不得删除，Task 附件及 Bot 缓存不受该清理影响。长期未结束链的滞留字节须独立统计。

目录按项目中的链或独立 Task 的结束时间倒序，时间未知项单独标识并以稳定 ID 排序；相同已知时间也以稳定 ID 决胜。展开显示成员与每次 claim 的原 Session，保留轻量过期摘要。分组、分页和权限过滤必须使用一致的图版本；翻页时图版本变化要求重新读取，不拼接不同分组。每个成员、Session 及内容请求重新验证原 Task 权限，不因链可见暴露不可访问成员。

### 版本化字段与错误

以下为新增能力的语义合同，须通过独立版本化入口或显式协商响应承载。既有 `view=inspection` 目录、CLI 严格 DTO 和未协商响应保持原字段形状，不能直接加入 `group`、`expiresAt`。归档文件版本独立于能力版本，由归档协议拥有；读取方先部署兼容，再允许生产新格式，最后启用期限清理。

| 字段／能力 | 语义 |
| --- | --- |
| `taskBodyHistoryVersion=1` | 生产方支持正文保存及显式 `contentPolicy=task_body`；缺失不推断支持。 |
| `taskHistoryDirectoryVersion=1` | 目录提供链分组与期限字段；不改变旧目录响应。 |
| `groupId`、`graphVersion`、`taskId`、`claimId`、`sessionId` | groupId 为该图版本中派生的链代表 Task ID 或独立 Task ID，不是持久组资源；图版本变化必须重置。每项保留原执行身份，不指向后继 claim。 |
| `scopeEndedAt`、`firstArchivedAt`、`legacyGraceStartedAt`、`expiresAt` | UTC RFC3339 时间或明确 null；null 的未知原因另有说明，不代表已过期。 |
| `archiveState` | `pending`、`failed`、`ready`、`partial`、`expired`；`partial` 必须可读且有缺口说明。期限未知另由 `retentionState=unknown` 表达，不覆盖归档状态。 |
| `retentionState` | `waiting`（成员未结束）、`unknown`（必需时间缺失）、`scheduled`（有期限）、`expired`；实际过期由服务端撤销资格确认。 |
| `expiredAt`、`reason` | 过期实际生效时间与可解释原因；过期摘要不携带已删除正文。 |

版本、序号和图版本保持精确十进制字符串，UUID 保持完整身份。未支持新增能力返回明确 `upgrade_required`，不得猜测响应格式或把空目录解释成支持。新入口的过期内容返回 `history_expired`（HTTP 410），未就绪返回 `history_not_ready`，图、来源、epoch 或过旧游标要求 `reset_required`；条目 revision 变化仍为 `content_changed`。旧入口保持既有错误编码，但必须拒绝过期内容，不能返回伪造空页。认证失败、无权限、损坏及缺件保留各自错误，不映射成过期或空历史。

## 正文与期限验证

| 要求 | 所属证据及反例 |
| --- | --- |
| 按类型保存 | Controller 用相同文本分别作为工具输出和用户正文，验证前者不在持久时间线／归档，后者原样保留；断线重连后下一条正文可确认。独立大输出压力记录暂存字节与释放。 |
| 归档与资源 | 归档协议验证新旧格式、正文图片引用闭包、partial、待上传及失败；工具专属资源不会成为正文依赖。 |
| 期限 | core 受控时钟覆盖晚完成成员、取消、重开、外部依赖、未知时间、晚到归档和重复成功；真实 PostgreSQL 验证图／终态／版本并发与事务。 |
| 回收 | 清理模块用真实文件句柄、共享引用与失败注入验证在途读取、上传、删除失败及重启，逐字节核对 Task 附件仍在。 |
| 目录及兼容 | HTTP／CLI 验证新旧组合、额外未知字段拒绝、稳定排序与图变化重置；Web 验证展开及过期显示不误跳新 claim。 |

规格交付仅检查需求追踪、字段一致性和文档链接，不声明上述实现行为通过。测试分层和独立压力入口遵守[测试规则](../writing_tests.md)。

## 权限与兼容

每一页和每一个正文块重新检查真实凭据、Task 访问和 Session 归属。固定 API OAuth profile 可读取现有用户 Session 内容与可读归档；MCP OAuth 保持本范围内原 Task 读取子集，归档用途仅限原 Task ArchiveV1Read。独立 Test/Bot Session 的用户读取仍要求 owner 及原 parent PAT 有效，Task 读取仍要求项目权限与原资源绑定。Controller 注册、生产上传和归档完成保留原凭据条件。历史读取不因原 claim 结束而改投新 Session。

Controller 每次 WebSocket 握手声明内容读取版本，能力只绑定该连接产生的新 fence。未声明的连接不收到新请求；重连未声明会清除旧能力。旧 Controller 的短条目可用既有显示接口读取，`display_budget_exceeded` 必须明确要求升级，不能作为完整原文。

归档读取保留权限、尺寸、摘要和格式检查。客户端只取页或块；服务端旧归档可能物化最多 64 MiB，归档句柄与相应预算保留至响应完成或取消。离线 Worker 不妨碍已有效归档的读取。

CLI 与 MCP 使用同一业务语义。文本逐行转义终端控制字符；JSON 保留正文或显式内容引用。MCP 工具发现省略 `outputSchema`，协议测试直接断言实际结构化结果；成功读取采用普通编码，不恢复共享运行时输出校验或通用读取字节准入。上述 256 KiB 限制只属于历史页与正文块。

实现机制见[历史读取设计](../design/task-session-history.md)，状态观察见[Session 观察规格](task-session-observation.md)。
