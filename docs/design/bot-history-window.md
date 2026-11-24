# Bot 近期历史窗口与资源检查点

[窗口规格](../spec/bot-session-view.md#近期历史窗口合同)定义可读边界、预览与兼容要求。Controller 保存近期展示内容，服务端保存边界、条目摘要和资源引用。浏览器可以重用此前在有权访问时保存的快照。新设备首次读取需要 Controller 在线。

## Controller 本地缓存

Worker 的 Bot 票据标识本地展示窗口的所有者。Controller 在该 Bot 的 SQLite 写入事务中更新展示条目、字节统计、稳定序列、窗口版本和待清理资源。普通 Task 和独立 Test Session 使用自己的内容策略。

每个 Bot 最多保留 500 条、16 MiB 展示内容，计入存储的条目、预览和相关 Markdown 投影。检查点还有独立的 2 MiB 编码上限，Controller 按实际资源和图片出现元数据计量，并为身份字段预留空间。按用户消息划分可识别的轮次，先淘汰较早的完整轮次。当前轮次超限时，对输入和输出应用字节上限，并将较早工具详情压缩为带条数的摘要。用户与助手正文按 UTF-8 字符边界截断，并附省略号。压缩不足以降至预算时，从最早展示位置继续淘汰。保留轻量条目身份和历史上界，原 ID 的迟到修订无法恢复已经淘汰的内容。

操作、待决审批和原生恢复资料各有持久生命周期。展示资源的释放候选随窗口事务提交，Controller 确认该窗口检查点后再核验本地引用、媒体准备和读取租约，完成物理删除。短暂保留的资源在后续维护中重新检查。数据库页和 WAL 会被 SQLite 重用，原生记录和独立媒体证据也占用本机存储。16 MiB 是展示内容预算。

## 能力与读取

Controller 在 `hello` 中显式声明 `botHistoryWindowVersion: 1`，服务端仅对真实 Bot Session 接纳该能力，并在 `welcome` 中回显。普通 Task 和独立 Test Session 不能通过声明能力变成 Bot。未声明能力的连接维持原协议；启用窗口后，旧 `timeline`、`inspect_page`、`entry_chunk` 完整历史读取明确返回 `upgrade_required`。

`GET /api/v1/test-sessions/{sessionId}/bot-history-window` 接受 `mode=tail|before|changes`、`cursor` 和 `limit`。尾页默认 50 条，每页最多 200 条。读取复用现有 Controller content broker 的容量、超时、源水位和执行身份检查；网络等待结束后重新验证权限、完整 fence、历史代次与检查点的源代次。离线返回不可读状态，不能用空结果代替。

响应使用独立 `bot_history_window` 格式，包含完整 Controller fence、`historyEpoch`、`windowRevision`、`retainedFromSeq`、`throughSeq`、`earlierHistoryUnavailable`、分页位置及预览条目。预览带稳定 ID、序列、修订、UTF-8 字节数、裁剪和省略事实、资源 ID。`tool` 为 null 或包含工具名、命令、工作目录、状态及退出码的结构；未知字段保留 null。非工具条目的 `tool` 必须为 null。预览不提供完整原文的 `body` 或 `contentRef` 承诺。所有数字水位使用精确十进制字符串。

单条预览文本最多 32 KiB，工具名、命令、工作目录和状态分别最多 256、8192、4096、256 个 UTF-8 字节，退出码为可空 int32。页面实际不转义 HTML 的 JSON 编码不得超过 256 KiB，Controller 还要为服务端生成的游标预留字节。这些入口上限不替代 Controller 对整个窗口的总内容预算。

服务端根据已提交检查点验证响应条目与规范 JSON SHA-256 摘要，并生成游标。游标绑定 Session、执行代次、连接代次、历史代次、窗口版本、方向与扫描位置。向前分页允许窗口推进后仍被覆盖的范围继续；位置已被淘汰时返回携带当前边界的 `reset_required`。

游标是无 padding 的 base64url JSON 字符串数组：`["bot_history_window", sessionId, testExecutionId, executionGeneration, connectionEpoch, historyEpoch, windowRevision, mode, sequence, throughSeq]`。空上界编码为 `"0"`。`before` 的 `sequence` 是当前页第一条序列；`changes` 为 `"0"` 时表示该版本已经扫描完成，非零时是尚未完成扫描的最后一条序列。Controller 按此位置返回连续的前缀或后缀，服务端重建输出游标，不采用未经验证的 Controller 续页位置。

增量读取在窗口版本变化后扫描当前有界检查点，因此同 ID 的新修订不会被仅按条目序号的过滤漏掉。分批扫描期间版本再次变化，或旧游标无法证明覆盖时，要求重置。相同版本且扫描已经完成时返回空增量；这只说明没有变化，不说明历史从未存在。已经淘汰的历史通过保留的上界与 `earlierHistoryUnavailable` 明示。

## 持久检查点与引用

Controller 使用原连接凭据向 `PUT /api/v1/test-sessions/{sessionId}/bot-history-window/checkpoint` 提交窗口检查点。检查点包含完整 fence、历史代次、单调窗口版本、保留边界、必需的 `sourceEpoch` 与源事件确认水位 `sourceThrough`，以及至多 500 个条目的 ID、序列、修订、摘要、资源引用和精确图片出现身份。`sourceEpoch` 为规范 UUID，随检查点持久化并在提交回执中回显。图片出现元数据继续核验 source revision、来源摘要、part 与调用位置，不能仅凭 entry ID 准入采集。预览正文仍在本机。

更新在原 Session 锁和数据库事务内验证当前 Bot、连接、源代次和源水位，并保存检查点及窗口引用。相同版本只能重现相同内容；旧版本、回退低水位、已淘汰条目的迟到修订及不一致资源必须拒绝。窗口全部淘汰时仍保留已观察上界与省略事实。连接或历史身份变化要求重新建立相符检查点，不能混用旧响应。

同一连接的 `source_reset` 可以改变源代次并从零重新计数，而逻辑历史代次保持不变。仅比较数字水位无法区分这些来源：迟到的旧源提交必须拒绝，旧的持久检查点不能在新源达到相同计数后重新用于窗口读取或图片准入。新源须重新提交匹配当前源代次的检查点；可以重新绑定同一逻辑窗口，但不能借此回退窗口版本、保留边界或改写同版本内容。读取在等待 Controller 响应期间发生源切换时要求重置，不能把等待前的响应用于新检查点。游标仍按逻辑历史连续性判断，不把源事件重新计数等同于展示历史清空。

窗口资源采用独立引用用途，与待决操作、审批、原生恢复及归档引用分开。每次提交在修改引用前，根据保留的精确图片 occurrence 查询已提交采集回执，要求对应资源出现在该条目的 `resourceIds` 中。该闭包检查独立于旧引用用途：首次提交把 `message` 引用转为 `bot_window` 后，后续修订仍不能保留图片 occurrence 却遗漏原件。窗口推进只释放归属于展示历史的引用。资源仍被其他所有者引用或有在途读取租约时保留字节；清理不削弱原有资源授权。普通 Task 归档继续沿用自身保留规则。

检查点提交回执与物理回收结果分开表达。`cleanupPending` 表示仍有清理需要完成，不否定已经提交的边界。资源回收先核验引用与实际读取租约，再释放文件和存储记录；错误保留待清理事实，不能报告已经删除。持久回收队列由既有清理运行器在启动及周期扫描时继续处理，并使用独立游标和期限；普通 Task 归档清理失败不阻止 Bot 回收扫描。结束运行器时取消并等待在途工作，最后读取租约释放也可触发清理。

## 验证职责

Go 和 TypeScript 协议测试证明严格字段、十进制范围、UTF-8 预览及跨语言摘要一致性。core 测试证明窗口推进、重复与迟到修订、游标重置、身份切换、旧客户端拒绝及等待后撤权。DAO 测试使用隔离 PostgreSQL 证明检查点与引用事务；文件生命周期测试使用真实文件与租约证明在途读取保护。HTTP 测试证明原 Controller 认证、参数解析、错误边界与能力回显。

Controller 模块测试用真实 SQLite 和文件系统验证插入、修订、事务回滚、低水位、清理重试及清空展示后的恢复证据，并通过真实本地 HTTP 和 WebSocket 校验检查点和读取行为。独立压力测试测量主库、WAL、媒体文件及首屏耗时。浏览器呈现和真实 Provider 续跑由各自的验收入口验证。
