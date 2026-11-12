# Task Session 定向发送与原操作恢复

## 目标与范围

调用者可以向明确项目、Task 和 Web Session 发送一次普通文本，并在超时、丢失回执或进程退出后查询原操作。发送只使用当前 Session owner 的真实权限；项目成员身份、Task 负责人、活动标记和过去的观察均不能替代发送时的授权。

本能力支持现有 Web Provider 的普通消息与实际允许的 steer，不创建或重启 Session，不自动等待空闲、排队、取消回合、代答审批或输入终端。斜杠开头的正文仍是普通文本。Herdr 不提供此消息入口。观察规则由 [Session 观察规格](task-session-observation.md) 所有，持久机制见[发送设计](../design/task-session-send.md)。

## 输入与目标

CLI 的 `task session send TASK SESSION` 必须明确选择 `--text`、`--file` 或 `--stdin` 之一，支持 `--project`、`--operation-id`、`--wait-seconds` 和 `--json`。文件必须是有界、可取消读取的 regular file。正文精确保留 Unicode、BOM、LF、CRLF 和末尾换行，不 trim；拒绝 NUL、非法 Unicode、全空白、超过 1 MiB 的 UTF-8 正文以及超过 2 MiB 的完整编码 command。无效输入在恢复记录写入和 POST 之前失败。

首次提交观察显式指定的 Session，冻结项目、Task、Session、claim、executionGeneration、expectedTurnId 和精确正文哈希。idle 的 expectedTurnId 为显式 null；working 只有实际支持 steer 且拥有真实当前 turn 时可发。Submit 和实际派发再次验证原执行及回合，变化即拒绝，不能查询新 current 后改投。

发送使用现有 command execution fence，即 sessionId、claimId 和 executionGeneration。inspection 的 connectionEpoch 作为连接观察保留，不是 command 的额外条件；同一执行重连不等于选择新 Session。当前连接有效性仍由接受及派发时的业务规则核定。

## 恢复与防重

CLI 在首次 POST 前持久保存按规范 origin、当前 actor 和 operationId 隔离的最小记录。记录包含原目标、expectedTurnId、正文哈希和操作事实，不保存正文、token 或任意 Provider 错误正文。真实私有权限、同 ID 的跨进程锁、文件同步、原子替换及父目录同步是发送前置条件；任一失败均零 POST。

记录必须先进入持久的 dispatch_unknown 状态，再允许一次 POST。进程可能在落盘后、实际请求前退出；这时仍按未知处理，不能把可见记录解释成补发许可。任何既有本机记录，包括 prepared，都会使相同 ID 的 send 只核对原目标和正文哈希，然后查询原操作。不同目标或正文明确冲突；恢复不重新观察 current、不重新冻结 turn。

未提供 ID 时，CLI 生成新的 operationId。调用者提供 ID 且没有本机记录时，send 表示该调用者明确选择新 ID 的首次提交入口，先查询原目标上的 receipt。已有 receipt 只能证明原操作存在，不能证明本次正文已受理；返回原身份和查询指引，不 POST。只有明确 not_found 且属于首次提交时才冻结新意图。not_found 本身不能证明过去没有发送；先前结果不明及跨机器恢复必须使用 operation 查询，不能调用 send 猜测原意图。

`task session operation TASK SESSION OPERATION` 始终查询显式原目标；只提供 `--operation-id` 时，从当前 actor/origin 的本机记录定位。不同账号或服务不读取彼此记录。Task 已更换 claim 后，授权调用者仍可查询原 Session 的持久 receipt，结果标明 currentBinding；读取不恢复旧队列，也不修改原操作。

## 结果与等待

服务 202 仅表示已受理；accepted、offered 和 dispatching 是等待中的操作。provider_accepted 表示 Provider 接受，confirmed 表示原操作已确认，两者均不证明 Agent 完成了正文要求的工作。rejected、failed、expired 和 unknown 保留各自事实。查询不存在仍为结果未知，不能转成自动重发。

发送默认等待最多 30 秒，允许 0–60 秒，仅轮询原 operation；每次在途请求也受剩余等待预算和取消约束。等待结束或用户中断后，仍尽力输出原目标、operationId、实际状态及可复制的查询命令。输出拥有独立的有界预算，不能将 pending 或 unknown 伪装成 confirmed mutation。

send 和 operation 的退出码按原操作状态表达：provider_accepted/confirmed 为 0，确定拒绝/失败/过期以及协议、鉴权或输出失败为 1，参数错误为 2，accepted/offered/dispatching/unknown/not_found 或等待超时为 3，用户中断为 130。正文和原操作结果的文本输出转义终端控制字符；JSON 保持数据边界。stdout 只有结果，诊断写 stderr。

服务已经返回的实际 receipt 不因本地保存、输出或清理失败而撤销。失败信息保留原操作身份；任何本地失败都不能触发第二次 POST。

## HTTP、MCP 与授权

HTTP 沿用原 Task Session commands POST 的 202 合同；其他 POST 的成功码不变。原 operation GET 返回 operation 和 currentBinding。MCP 的 task_session_send 要求显式 projectId、taskId、sessionId、operationId、claimId、executionGeneration、expectedTurnId 和 text；不接受 file/stdin 或 connectionEpoch。task_session_operation 要求原四个资源 ID，只读查询。

MCP 的 WriteOutcome 表示本次服务写入事实，data.operation.state 表示原生操作事实，不能相互代替。unknown、输出失败和 not_found 都保留原资源 refs，并指引查询原 ID；只读 receipt 查询不制造写提交结果。严格公开 schema 与实际协议输出相符，读取遵守仓库既有编码规则。

PAT 与 OAuth 保留真实凭据、scope、有效期、撤销、项目权限和 Session owner 约束。固定 API OAuth profile 可进入现有用户 Session 命令、控制、内容与回执用途；MCP OAuth 仍仅按原 Task 普通 send_message 与 receipt 用途进入命令路径。两者均不获得 Controller 注册、grant、生产 channel 或归档上传及完成权限。已受理但未派发的操作以持久原 Actor 的 user UUID、access UUID 和 kind 重新授权；用途由实际操作确定，不能继承外层 Controller 或当前请求的权限。Refresh 后的新 access 可以按原用户和意图规则查询 receipt，不能替换原 Actor、恢复失效凭据或重放原命令。撤权后不得继续派发，已经发生的派发事实不能被撤权抹去。

## 验证职责

CLI 使用受控 HTTP 验证正文、请求、状态、退出码、等待和取消；真实文件、原生权限与子进程验证锁、持久屏障、丢回执和重启后只读恢复。Go 核心验证资格、原意图幂等与授权；真实隔离 PostgreSQL 验证凭据读取、锁序、撤销和持久 receipt。HTTP/MCP 使用直接业务依赖 mock 验证协议、身份透传、输出失败和没有重复提交。真实 Provider 接收与受控故障证据分别陈述，不向生产任务发送验收文字。
