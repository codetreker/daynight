# Task Session 观察设计

## 职责与依赖

[需求](../spec/task-session-observation.md)规定任务摘要、工作分组和 inspection 的可观察行为。共享状态和发送资格由 `core/session` 拥有，分组选择、游标和摘要投影由 `core/task` 拥有；`service/task.Observations` 协调 Task 快照、Session 来源和 live 观察。HTTP 与 MCP 只适配输入、结果及协议包络，CLI 使用同一 DTO，不重算业务状态。

`core/store.SessionReader` 提供按最多 200 个已选 Task ID 读取的 `TaskSessionSources`，以及按明确项目、Task、Session 读取的 `TaskSessionInspectionSource`。来源只有 Task 版本和状态、Worker 绑定、Session 身份、fence、生命周期、心跳、连接有效期及归档标量，不加载历史、controls、操作正文或终端帧。DAO 在授权快照中读取，接口不提供写入能力。

`core/session.Engine` 通过 `ObserveTaskSessions` 和 `InspectTaskSession` 投影协议对象。应用组装注入现有共享 Engine，避免独立实例产生不同的 live 事实。既有 TaskSync 保留精简状态 map；它与新摘要复用同一 indicator 规则，既有 Web 字段和显示行为保持不变。

## 快照与 live 观察

普通 Task 读取先在一个只读快照中完成真实凭据与项目授权、原 Task 查询、观测时刻和轻量 Session 来源选择。退出快照后才采样 Engine live 状态，再开启新快照重新授权并读取来源。重新检查比较 Task 版本和状态、Worker claim/owner/state、Session ID、fence 和生命周期；发生变化时将该 Task 标为 `unavailable/execution_changed`。

这一顺序避免同时占有两个连接池连接，也避免在数据库事务内等待 live mutex。持有原 repeatable-read 快照再重读只能看到旧状态，无法发现采样期间已提交的新执行；因此必须在原快照释放后取得新快照。该流程提供可解释的观察窗口，不声称 PostgreSQL 与所有 live cell 构成一个原子时刻。

Engine 先取得 registry 引用，再在短 cell 锁下复制已提交标量；registry 重新检查发生在 cell 解锁后，保持现有锁顺序。live fence 与持久来源不符时不使用该 live 数据。新鲜度来自持久心跳和连接到期；客户端不能延长它。发送判断共享现有 permission 规则，并额外使用真实 actor、当前 Task 绑定和生命周期；它不授予后续写入许可。

共享 Engine 将 `observedAt`、`lastSeenAt` 和 `freshUntil` 投影为 UTC 时间值，使批量观察与指定 Session inspection 均输出 CLI 可解析的 `Z` 表示。持久来源可能携带数据库本地时区；转换只作用于输出副本，保留原始时刻、精度与空值，心跳及连接到期的比较仍按实际时刻执行。

批量读、live 采样或 fresh 读的普通失败可形成不可用观察；原 Task 仍存在。凭据或项目拒绝与请求取消中止整次结果。新快照完成失败同样不能发布成功观察。异常内部详情不进入局部错误正文。

## 普通 Task 输出

`ObserveGet`、`ObserveList`、`ObserveGraph` 和 `ObservedMCPList` 保留各自既有 Task 读取规则，只附加观察。每个来源批次最多 200 个 Task；普通结果仍可完整包含多个批次，不新增通用读取字节限制。MCP full view 继续取得完整 Task，summary view 保留原摘要表示。

HTTP 使用 `include=session` 显式选择新表示，show 在原 Task 顶层增加 `session`，list 保持原 `items/nextCursor` 并增加 `observedAt/partial`。HTTP 投影以无方法的 Task 字段别名组合 Session，避免旧 Task 自定义 `MarshalJSON` 吞掉附加字段。Worker protocol 仍控制旧 Worker claim 表示、inventory 拒绝和候选过滤。

合法 Goal 没有执行 Session；普通读取将其执行观察标为 `observed/not_applicable`，不查询或注册执行 Session，也不因此将结果标为部分失败。目标或 Parent 有效删除后，普通 Session 读取、连接和输入不可用；原 owner 仍可按既有身份与停止证明完成 ledger、recording 和归档收尾。父 Goal 完成或取消不构成删除。

Graph 每节点附加 `session/relation`，顶层附加 `sessionSummary/partial`。relation 从请求 Task 沿普通依赖的无向连通分量计算；直接外部前置保留为 `external`，不参与进行中汇总。内部 GraphTask 读取版本用于绑定检查，不改变旧 Graph API 字段。`--depends-only` 使用原查询，不触发 Session 观察。

## 工作分组与稳定遍历

PostgreSQL 从匹配负责人的 `in_progress` Task 出发，通过普通依赖的两个方向计算连通成员，并以最小 Task UUID 合并重复种子。查询一次选择所需组数及一个 lookahead；根和标题在 DAO 以预览字段返回，不为分组加载完整描述和属性。外部依赖始终不参与递归。

组选择记录 `TaskSearchFence{Epoch,Count,VersionSum}`。随后的每批目标读取在独立授权快照内验证同一 fence、查询最多 200 个进行中目标并加载对应 Session 来源；释放快照后才采样、重验并累计摘要。只保留最多 20 个目标预览，整组统计则扫描所有进行中成员。最后再验证 graph fence，防止发布变化前后的混合遍历。

游标以规范 JSON 和 URL-safe Base64 编码，严格校验字段、十进制 fence、ID、actor/project/assignee 以及组或目标位置。组位置为 `startedAt/groupId`，目标位置为 `groupId/taskId`。Task 变化要求重置；Session 活动不纳入 graph fence，因此刷新观察不改变目标遍历位置。目标续页仍扫描整组以更新统计，只跳过游标之前的展示目标。

该结构限制单次来源批量和返回数据，完整聚合成本仍与所选组的进行中成员数相关。重复目标续页会重新计算整组摘要；这是保持真实聚合与稳定目标分页的成本，不是持久聚合缓存。

## 专用响应预算

`internal/protocol/taskwork` 统一定义组、根、摘要和目标的 JSON 类型，core 与协议适配共享编码形状。`WorkRequest.ResponseOverhead` 只由适配层提供，不接受客户端直接输入。HTTP 为末尾换行保留 1 字节；MCP 依据实际 request ID、响应协议、refs 和完整观察元数据计算包络开销，时间字段保留最大 RFC3339Nano 长度。

`FitWorkPage` 将 Page 编码限制在 `256 KiB - ResponseOverhead`：优先删除末尾组并重设组 cursor；单组仍超预算时缩短目标预览并设置 contributor cursor。所有续页边界指向最后实际返回的元素；不能装入一个结果时返回确定错误。该规则只属于工作概览，不改变[普通资源读取决策](../../.agents/notes/implemented/simplification/2026-11-09-canonical-resource-pages.md)的完整字段及 MCP 成功读取编码规则。

## 指定 Session inspection 与扩展入口

`service/session.Inspection` 使用同一观察授权和共享 Engine，读取显式 Session 的持久来源并保留原 fence。它返回当前绑定、live/archive/unavailable 来源和发送资格，支持识别历史 Session，但不加载其内容或推进生命周期。采样后的 fresh 授权与绑定检查防止将过期 currentBinding 或发送资格作为当前事实；目标不会改投新的 Session。

HTTP inspection、CLI API 方法和公共 session 命令注册壳是后续消费者的依赖。注册壳不展示未实现的命令，MCP 公共注册入口同样只连接实际工具。当前 Task 概览无需调用每个 Task 的完整 current、请求历史或建立 WebSocket。

## 验证边界

核心测试构造受控 Task、Session 和能力事实，验证纯投影、游标及预算；service 测试 mock 直接调用的规则和 DAO，控制授权、快照完成、live 采样期间的身份变化与批次顺序。DAO 测试使用隔离 PostgreSQL 观察真实 SQL、映射和分页，不能以 service mock 替代。协议测试通过真实 HTTP/MCP 编码和 CLI 解析验证公开 schema、显式 null、控制字符、旧查询兼容及 partial。运行证据随具体源码版本保存，文档不宣称测试替代真实 Provider 或多平台接收证据。
