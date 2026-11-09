# Task 与任务链的 Session 观察

## 目标与边界

Task 查询应同时提供当前执行的轻量 Session 观察，让人和自动化调用方能够从任务直接定位需关注的执行。工作概览按负责人选择进行中的独立任务及普通依赖链；根任务已经结束时，链内的进行中任务仍应可见。

观察是只读操作，不创建或恢复执行，不更改 Task、claim、allowAgents、Session 生命周期或控制权。本文规定任务摘要、分组概览及指定 Session inspection；历史消息读取、消息发送、operation 恢复和 Session 用户子命令不在此能力范围内。命令用法见 [CLI 说明](../../packages/daynight/README.md#task-session-observations)，机制见[设计](../design/task-session-observation.md)。

## 单任务观察

HTTP 的 Task list、show 和 graph 通过 `include=session` 请求观察。普通字段、过滤、排序、分页和版本保持原合同；未请求观察时保持原有结果。CLI 普通 list、show、graph 默认消费观察；MCP 的相应读取使用同一业务语义。Task 写返回、Worker 内部读取、ready 查询及 `graph --depends-only` 保持各自原合同。

每个 Task 的 `session` 使用 `schemaVersion: 1`。字段始终存在，可空值使用显式 `null`：

| 字段 | 含义 |
|---|---|
| `observation`、`registration`、`reason`、`error` | 观察成功、不可用或协议不支持，以及关联、等待注册、不适用或未知的明确原因 |
| `sessionId`、`nativeSessionId` | Daynight Session ID 与 Provider 原生 ID；两者独立，原生 ID 可尚未建立 |
| `claimId`、`executionGeneration`、`connectionEpoch` | 原执行身份与连接代际；代际以十进制字符串传输 |
| `agentControlMode`、`contentKind`、`provider` | 控制模式、内容种类和 Provider |
| `indicator`、`needsAttention` | 网页相同业务语义下的关注提示，不代表发送授权 |
| `activity`、`connectionState`、`lifecycle`、`currentTurnId` | 活动、连接、生命周期及当前回合的独立观察 |
| `send.allowed`、`send.mode`、`send.reason` | 当前真实调用者发送普通消息的可用性，模式为 `start`、`steer` 或 `null` |
| `observedAt`、`lastSeenAt`、`freshUntil` | 服务观察时刻和可得的新鲜度证据；不以 CLI 本机时钟伪造 Controller 新鲜度 |

`indicator` 仅使用 `working`、`notice`、`warning` 或 `null`。进行中的当前 Web Session 正常工作为 `working`，等待输入为 `notice`，空闲、停止、断线或生命周期异常为 `warning`。初始化、同步中、未知活动或没有适用的注册执行不补造颜色。Task 已结束时不参与进行中角标；Task `in_progress` 或 Worker active 也不能单独证明 Agent 正在工作。

关注与发送资格独立。真实 owner 的 idle Session 可以同时为 `warning` 和允许 `start`；working 仅在实际支持 steer 且有当前回合时允许 `steer`。等待输入不能被解释为允许普通消息代答审批。非 owner、历史执行、失效连接、未同步或能力不符时保留具体拒绝原因；无法可靠观察则发送资格为未知。摘要始终可能在返回后过时，任何写入仍须在接受时重新授权并检查原目标身份。

Herdr 以 `terminal_recording` 表示内容，保留其真实连接和归档事实，不伪造 Web activity、结构化对话或普通消息发送能力。

## 失败、权限与兼容

Task 数据读取成功而局部 Session 观察失败时保留原 Task，返回 `unavailable`、明确原因和页级 `partial=true`。发生 Task 版本、claim 或 Session fence 变化时使用 `execution_changed`，不拼接旧任务与新执行。凭据失效、撤销、项目权限拒绝和请求取消应使整次读取失败，不能降级为成功空页或局部正常结果。

PAT 与 MCP OAuth 保留真实调用者、scope、有效期和撤销约束；观察授权不改变 Controller、机器控制或归档上传的准入。初始选择和 live 采样后的重新检查均验证实际凭据及项目权限。

旧服务明确不支持观察协议时，CLI 可以保留可读取的 Task 数据并标为 `unsupported`，输出升级提示；权限拒绝、网络故障及格式损坏不得伪装成不支持。CLI 观察部分失败退出码为 3，参数错误为 2。JSON 保持稳定字段，普通 list 仍为数组；文本转义终端控制字符，诊断写 stderr。

## 工作概览与分页

`GET /api/v1/projects/{projectId}/task-work`、CLI `task list --status in_progress --group-by chain` 和 MCP `task_work_list` 提供同一概览。负责人默认为 `me`，也可使用明确用户 UUID，不接受 `unassigned`。负责人决定纳入哪些组：组内至少有一个属于该负责人的进行中 Task。每个普通依赖连通分量只出现一次，独立任务为 `kind=task`。直接外部前置不扩展组、不计入成员或聚合。

组按匹配任务的最近 `startedAt` 降序、`groupId` 升序排列。`groupId` 为普通连通分量中最小 Task UUID；展示任务取根成员中 `createdAt` 最早者，以 UUID 打破并列。每组明确返回匹配数、总成员数、进行中成员数、根数量、最多五个根预览、截断标记、摘要及具体目标。

聚合范围为 `accessible_in_progress_members`，涵盖组内可访问的全部进行中成员，包括其他负责人。优先级为 `warning > notice > working > null`；同时返回各状态数量、未知数和 `complete`。未知不会抹去已知提示，也不能被解释为正常。目标显示自己的负责人、是否匹配筛选、Session ID、indicator、reason 和独立发送资格。组没有统一 Session ID 或发送资格。

组页默认 20、最多 50 组，以 `cursor` 续页。每组目标预览最多 20 个，按 Task UUID 升序；`groupId` 与 `targetsCursor` 必须成对提供，不能与组 `cursor` 并用。目标续页继续同一组的进行中成员，摘要仍覆盖整组。游标绑定调用者、项目、负责人和 Task 图快照；Task 图变化返回 `reset_required`，要求从头读取。仅 Session 活动变化不改变分页成员集合。

仅工作概览及目标续页采用完整编码响应不超过 256 KiB 的专用预算，包含 HTTP 换行或 MCP 协议包络。预算不足时提前结束，并返回对应最后实际输出组或目标的续页游标；连一个完整结果都无法容纳时明确返回 `resource_limit_exceeded`。普通 Task list、show、graph 继续完整返回，不引入通用响应字节上限。MCP 成功读取使用普通编码，公开严格输出 schema 并以协议测试验证，不恢复共享 wrapper 的运行时输出 schema 校验。

## 指定 Session inspection

`GET /api/v1/projects/{projectId}/tasks/{taskId}/sessions/{sessionId}/inspection` 只观察明确目标，返回 `schemaVersion`、三个资源 ID、`currentBinding`、实际 `fence`、`source`（`live`、`archive` 或 `unavailable`）和上述 `session` 摘要。必须验证 Session 的 Task、项目和执行归属。

历史 Session 保留原身份和只读事实，不因 Task 已有新 claim 而替换目标。无权访问或归属不符返回确定拒绝。只读 inspection 不执行过期归档写入，也不请求历史、正文、控制目录或终端帧。CLI API 客户端暴露 inspection 方法；公共 session 注册入口只注册实际实现的子命令。

## 验证职责

核心规则验证状态、发送资格、聚合、游标身份和预算续页；service 验证快照释放、真实授权调用、分批协调、变化检测和错误传播；真实 PostgreSQL 验证普通连通分组、done 根、混合负责人、外部前置隔离、稳定分页和 DAO 批量上限。HTTP、MCP 与 CLI 各自通过实际解析及编码验证字段、兼容、部分失败、取消和输出。受控状态测试不证明真实 Provider 已收到消息；本能力没有发送验收。
