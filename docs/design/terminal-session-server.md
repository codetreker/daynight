# Herdr Session 服务端

## 责任与兼容

服务端使用同一 `task_sessions` registry、项目成员权限、Session URL 和
`session-archives` 存储。`backend` 区分 Web 与 Herdr；Herdr 的 `terminal_state`
保存运行和控制元数据，不构造虚假的 v1 timeline snapshot。录制画面留在 Worker
本机，最终包进入文件存储。完整帧实时缓存只服务当前连接，不作为录制证据。
服务端同事务保存最近接受帧的运行、段、序号与内容摘要，拒绝同段序号回退；
这些排序元数据不包含画面正文，也不依赖缓存回调的发布时间。

[Session v2 契约](session-v2-contract.md)拥有交换字段、限额和摘要规则，
[行为规范](../spec/session-v2.md)拥有结果和失败语义。服务端实现不证明 Worker
已经具备真实采集、持久日志、严格输入或停止观察能力，也不自动启用网页产品。

HTTP 用 `Daynight-Session-Protocol: daynight.session.v2` 显式选择，WebSocket
必须协商同名 subprotocol。无选择保持 v1；显式未知版本或矛盾选择拒绝。
旧客户端查询 Herdr 当前 Session 仍得到 `not_applicable`。
`GET /api/v1/session-capabilities` 的 v2 结果标明
`recordingResponsibilityVersion=1`、`controlDispatchVersion=1` 和
`workerCapabilitiesRequired=true`。这些表示服务端支持，不表示特定 Worker 可用。
Web producer 和既有 v1 archive 继续使用原协议与读取路径。

## API

以下路径均以 `/api/v1/projects/{projectId}/tasks/{taskId}/sessions` 为前缀，
且要求 v2 选择。所有 ID 按路由与协议严格核对；所有读取重新检查凭据和项目准入。
Web 与 Herdr 共用 [Session 项目准入](task-session-protocol.md#relay-与恢复)，
在原事务中读取 canonical `ProjectAccess`，不长期锁定授权来源。
Herdr 的状态、历史、归档、capability 与派发沿用此入口；浏览器 channel 每 250ms
重验完整凭据与当前读取资格。应用浏览器的 v2 marker、精确 Origin、固定 API profile、连接
effective-expiry deadline 与 best-effort 关闭遵循[鉴权设计](daynight-auth.md#应用用户-websocket)。
其他有项目访问权的成员和管理员只读；人工输入和控制请求必须由
持久 Session owner 提交。项目或 Team 角色不替代原 owner、当前 claim、控制租约
或 connection epoch 检查。非 owner 状态投影清空 `control.availableActions`，保留
画面、历史和控制归属。

| 方法与相对路径 | 输入与结果 |
|---|---|
| `POST /` | registration/register 或 reconnect 消息，返回 registration_ack |
| `GET /current` | 当前 claim 的 registered/not_registered/not_applicable 状态 |
| `GET /?cursor=...&limit=50` | task 历史列表，1–200 条，`nextCursor` 分页，包含 Web/Herdr |
| `GET /{sessionId}/state` | 固定 Session 状态，包含 owner、binding、connectionEpoch、capabilities、control、snapshot、ledger、recording、archive |
| `POST /{sessionId}/commands` | 原 Session owner 的 operation 或 control_request；其他项目读者 forbidden；HTTP 202 返回 operation_result，仅表示已受理 |
| `GET /{sessionId}/operations/{operationId}` | 原操作的持久结果，不重新派发 |
| `POST /{sessionId}/worker-messages` | generation_ledger、recording_responsibility/evidence、finalization、snapshot、control_state/ack、operation_result |
| `GET /{sessionId}/worker-channel` | Worker WebSocket，首条为 registration/reconnect；随后传入 Worker 消息并接收 control_dispatch/operation |
| `GET /{sessionId}/channel?browserClientId=...` | 浏览器只读 WebSocket，推送完整 Session 状态，完整帧可替换待观察旧状态 |
| `GET /{sessionId}/recording-evidence/{evidenceId}?generation=...` | 读取原证据提交身份与摘要，核对响应丢失后的结果 |
| `GET /{sessionId}/archive` | archive_status 消息 |
| `POST /{sessionId}/archive` | pending/failed 的 archive_status，或 unavailable 的 receipt 候选 |
| `PUT /{sessionId}/archive` | 原始 archive v2 JSON；返回服务端不可变 receipt |
| `GET /{sessionId}/archive/state` | 原 owner PAT 专用归档读回，包含原 ledger、recording 和 archive；任务删除后仍可使用，不授予控制操作 |
| `GET /{sessionId}/archive/receipt` | 固定 receipt；尚未形成时 archive_pending |
| `GET /{sessionId}/archive/content` | 验证后的原始 JSON 文件，仅 ready 可读 |

Worker HTTP 消息必须携带 `Daynight-Connection-Epoch`。WebSocket 从握手固定
该值；旧连接不能更新新连接状态。控制 HTTP 请求必须携带 UUID
`Daynight-Browser-Client`，与 control_request 或 lease 的 browserClientId 一致。
它用于浏览器实例关联，不是抵抗同一认证用户主动伪造的秘密凭据。
浏览器订阅捕获建立时的 claim 与 Worker connection epoch；该身份改变即结束旧订阅，
不跟随替代连接。断线清理还须匹配所属 relay 实例，旧回调不撤销新连接的租约或操作。
同一连接内合法推进 generation 不改变该订阅责任。

状态读取是 HTTP 主机响应，消息输入输出使用 v2 严格联合。归档 PUT 限额
64 MiB；在线消息限额 4 MiB；帧、输入和元数据继续遵守共同契约的更小限额。
不支持的 timeline、resource 或 Web controller 操作不会降级为终端输入。

## 注册、运行账本和连接

注册核对当前 claim、原 owner、真实 Worker/worktree/provider 和规范 serverOrigin。
相同注册请求幂等返回原 epoch；reconnect 必须携带当前 epoch，并在同一 Session
中增加连接代次。物理 Worker channel 对 epoch 只能绑定一次；关闭后必须使用
reconnect 获得新代次，不能用重复注册同时拥有两条有效输入通道。
原实例心跳仍有效且任务执行仍活动时，发往另一实例的当前状态、固定状态、操作结果
或新控制请求返回 `relay_instance_unavailable`（HTTP 503），不改变原租约、控制代次
或待处理操作。实例不匹配不是失联证据；真实心跳超时或执行失效仍触发原有失效规则。

运行账本从 generation 1 连续增长。已有 owner、启动时间、绑定和段归属不能替换；
nativeSessionId 只允许一致补齐。停止后的运行不可改写。新 generation 以前一运行
已停止且经校验的账本已确认原生身份为前提；身份可以首次出现在 stopProof.binding，
不要求回写冻结运行的 binding 或额外重连。后继运行必须沿用该原生身份，并更新
原 Session 的当前绑定。正常网络重连不创建运行。

所有相关事务保持 task-before-session 锁序。finalization 核对 claim 已不能继续、
所有运行已停止且录制证据已闭合，在同一锁下冻结 finalizationId。新 generation
授权与冻结互斥；固定 ID 可重试，不得替换封存。Worker WebSocket 将新运行账本交给
同一事务校验，成功后推进该通道的轮询与断线清理 fence；其他消息仍只能使用当前代次。
停止证明由可信 Worker 提供，
服务端校验结构、原 owner、绑定和运行归属，不远程探测操作系统进程。

## 录制责任与终态

每代运行先登记 recording_responsibility，再由 Worker 将责任身份可靠保存到
本机日志后采集。服务端接受 recording_evidence 的稳定 evidenceId、递增修订、
选中/登记计数、错误、日志摘要、来源摘要和 closed 状态。已观察计数不得减少，
错误不能清空，同 ID 不得换正文；closed 证据不可变。收到的画面是正向观察，
不能用后续零计数否认已观察内容。未收到画面不构成零帧证明。

责任日志由可信 Worker 维护。初始登记后不要求运行期持续联网；收尾同步固定证据。
日志丢失、缺少可信关闭证据或来源损坏时不能创建一份空日志来获取 unavailable。
`journalSha256` 标识原本机固定日志，不能单独证明采集事实或检测整个本地状态被
回滚到自洽旧版本。服务端比较其已知责任、历史提交、运行和最终包；真实日志
顺序与崩溃恢复由 Worker 验收负责。

ready 包必须与冻结运行账本完全相符，每代文件数量、来源摘要与 closed 证据
匹配。明确的合法间断只能形成 partial；缺少选中/登记文件不能改成 gap。所有
运行零帧时，只有无采集错误且证据支持正常关闭才可 unavailable。会话内有任何
运行启用录制时，合法零帧原因是 ended_before_first_sample；全部未启用时才是
recording_not_enabled。每代证据独立核对。

服务端通过共享 `sessionarchive.Namespace` 将 Task Herdr 正文写入
`session-archives/projects/<projectId>/<sessionId[:2]>/<sessionId>/<sha256>.json`。
该地址与 Web Task 归档共用归属及分片规则；独立 Test/Bot 归档使用用户分组。
新写入使用此布局，既有文件与元数据保持原状。读取继续打开持久 `object_path`，
上传重试和回执沿用原语义，不根据目录布局增加拒绝条件。
[共享归档设计](task-session-protocol.md#服务端归档布局)拥有物理地址规则。 [归档操作占用](task-session-protocol.md#归档操作占用)覆盖上传、内部读回及原始正文发送。

写入保留原始字节，重新打开并核对大小和 SHA-256 后持久保存 receipt；下载再次
校验文件和身份，并直接发送原始存储字节，不重新编码 JSON。ready/unavailable
的不同正文、原因或 finalizationId 不能覆盖已有终态。failed 不产生允许清理的
回执。正文 SHA-256、来源摘要、日志摘要与 dispositionDigest 各自具有明确对象，
不能互相替代。

普通附件的替换/删除只能操作 task-attachments，不能改变权威归档。历史分页按
created_at/id 稳定排序，不依赖当前 claim。成员撤销后拒绝读取；任务删除后拒绝
页面和内容访问，仍具项目权限的原 PAT owner 可按原身份完成历史收尾。

## 控制与不确定结果

控制要求原 actor 等于持久 Session owner，且当前凭据和项目访问仍有效，同时
满足当前执行、有效连接、完整 Worker 能力、已初始化录制责任和 Worker 控制状态。
服务端持久保存请求摘要、原 fence、actor 和 pending 结果，再转发
control_dispatch。只有匹配请求摘要和 operationId 的 durable control_ack，且
holder、browser、epoch、到期时间和动作转换均有效，才使 lease 对浏览器可用。
单纯转发成功或未关联的 control_state 不能授予、续约或恢复自动执行。派发、
有效租约重检和 ACK 授租均重新验证原 actor 的 owner 资格；旧非 owner 租约
失效，已排队请求和迟到 ACK 不能借管理员权限继续执行。

lease TTL 为 30 秒，客户端每 10 秒以 renew_control 请求续约。释放、断线、
撤权、过期和停止使控制进入 suspended/closed，不能自动恢复 prompt。服务端失效会推进 controlEpoch 下限；Worker 必须持久确认
更高代次后才能恢复动作可用性，不能以旧状态复活 lease。相同 browserClientId 的实时连接不能重叠；旧连接完成撤租后才允许替代连接进入。

操作去重记录保存至执行封存后仍可查询。相同 ID 不同正文拒绝，原操作结果不会
被新 claim 接管。原始 paste 正文只放在有界内存中；数据库保存摘要与路由元数据。
`session_operations_terminal_pending` 以 `(session_id,operation_seq)` 索引 receipt 状态为
`queued` 或 `dispatching` 的操作，服务终端到期和队列读取；Web Session 的 accepted
队列保留独立的 `session_operations_pending` 索引。
预览按同连接心跳维护存活时间，新分配时回收已过期且无待提交写入的缓存。
输入正文使用与持久操作相同的 deadline，到期后不能再被读取或占用新操作容量。
提交失败和控制暂停时，只清理各自捕获的正文 reservation；事务释放行锁后，
同 operationId 重试安装的新正文不受旧请求或暂停回调的延迟清理影响。
这两类本地回收不依赖归档成功或旧凭据仍然有效；断线只清理原 owner、claim、
generation 和 connection epoch 匹配的数据，不清除新连接或仍有效的待提交内容。

转发前先持久写 dispatching。内存丢失且可证明未转发则 rejected；转发后断线或
超时为 unknown，不自动重放。结果最多 transport_completed，不声称 provider
接受、命令成功或业务完成。Worker 仍须在原生写入前持久记录同一操作责任。

## 验证

验证分别覆盖共享字节契约、真实隔离数据库中的事务/权限/去重、文件存储读写和
HTTP/WebSocket 路由。并发测试检查新 generation 与 finalization 不可同时成功；
权限矩阵检查 owner 保留交互、其他 admin/member 与 Team 继承读者可读但不能
提交输入或控制；撤权、旧非 owner 操作/租约、迟到 ACK 和连接替换测试检查旧输入
失效；归档测试覆盖 closed 证据、缺文件、hash、
不可变回执、重领历史和删除边界。Go 完整 gate 与 CLI 测试采用仓库标准命令。
测试 Worker 不证明真实 Herdr 采集、输入或进程停止，组合验收需实际后继实现。
