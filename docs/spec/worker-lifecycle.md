# Worker 服务端生命周期

## 目标与边界

Worker 所有者可以保存持久停用意图，并查询原操作和本机报送的停止、保存及同步事实。生命周期独立于配置版本、在线状态、Task 状态和容量。服务端重启不能清除停用，旧配置更新不能重新开放准入。

服务端保存意图并封闭业务准入，不证明本机进程已经停止。只有完整升级的 Worker 才能声明生命周期能力；本机持久门禁、全部资源库存、原生停止证明和 Web 操作体验由相应客户端实现。服务端能力存在不表示已完成三平台产品验收。

## 身份与权限

资源归当前认证账号的 Worker，路径为 `/api/v1/me/workers/{workerId}/lifecycle`。项目权限不授予其他账号 Worker 的控制权。没有资源返回 `404 not_found`，不能解释为允许执行。

身份使用小写非零 UUID。所有版本、epoch、generation、sequence 为正 int64 十进制字符串，未知值为 `null`。`instanceEpoch` 由服务端递增，`intentVersion` 仅在用户意图改变时递增；本机 `localEpoch` 和 `scopeGeneration` 不与云端版本混用。所有成功响应带 `X-Daynight-Worker-Lifecycle: 1`，缺少该 Header 的 GET 仍返回 v1 独立表示；显式不支持的协商版本拒绝。旧 list、detail 和 report 形状保持兼容。

当前凭据和所有者授权保留。启用 scoped service 时，读取需要 `worker:read`；意图修改需要 `worker:configure` 和 `worker:read`；实例、观察及激活需要 `worker:report` 和 `worker:read`；resolve 按原请求类别使用同样的权限。权限检查与写入绑定同一事务。

## 接口

所有请求拒绝未知字段、遗漏的必填字段及多余 query。精确字段与判别类型由 [协议校验](../../packages/daynight-server/internal/protocol/worker/lifecycle.go) 和 [共享类型](../../packages/daynight-server/internal/core/model/worker_lifecycle.go) 定义。

| 方法与后缀 | 请求与结果 |
|---|---|
| `GET` 根资源 | 返回 `LifecycleResource`，包括当前意图、准入、实例、能力及带接收时间的完整观察包 |
| `POST /instances` | `LifecycleInstanceRequest`；注册实例，原子关闭准入，返回 `LifecycleInstanceReceipt` |
| `POST /operations` | disable 或 resume 判别请求；返回 202 `LifecycleIntentReceipt`，只确认意图提交 |
| `GET /operations/{operationId}` | 返回原意图、实例、内部激活或未提交墓碑的判别结果 |
| `POST /operations/{operationId}/resolve` | 使用原请求及 `requestKind` 封闭未知结果，绝不执行原请求 |
| `POST /observations` | 接收当前实例、意图和递增序号的观察；返回原始或新接收回执 |
| `POST /activations` | 普通 resume 激活绑定原 resume ID；内部 bootstrap/reconnect 使用独立 ID，返回准确激活回执 |

disable 绑定 `expectedVersion`，web 来源的 `localEpoch` 和 `originOperationId` 必须显式为 null；local 来源携带本地 epoch 和原本地停用 ID。resume 绑定最新版本、实例 epoch 及新鲜已停止观察中的本地 epoch。

实例注册绑定 `previousInstanceEpoch`，首次为 null。新注册关闭云端门禁并撤销旧观察，不改变意图版本，也不代表旧实例的进程已停止。同 operationId 和相同请求返回原回执，不重新注册或执行。

## 停用、恢复与观察

停用在 Worker 行锁内递增意图版本、保存原请求和回执、关闭准入并清除旧观察。离线且历史上支持完整能力的 Worker 可以接受停用，但只能表示等待本机确认。

resume 仅接受当前新鲜的 disabled 观察：完整库存、停止 confirmed、保存 durable，全部资源已停止，pending 和 blocked 均为零。受理后 `desired=enabled`、`admission=closed`。本机准备新 scope 并报送同意图的安全 resuming 观察后，activation 才能原子开门。服务端激活不等于本机已开门；本机仍须核验原 epoch、持久状态及最新意图。

没有停用或恢复历史的首次启用可以 bootstrap 一次。正常已开放状态注册新实例时可获得 `reconnectAllowed`，完成同实例的新鲜安全观察后 reconnect。新的停用、恢复或已关闭状态下注册均不能保留这项许可。中断握手需要重新核对并显式恢复。

观察分别保存 phase、stop、save、sync、完整库存摘要、全量计数、有限资源明细和逐执行恢复资格。接收时间由服务端生成，`freshUntil=receivedAt+30s`。同序号相同内容返回原接收时间，不能刷新时效；旧实例、旧意图、旧序号及相同序号的不同内容拒绝。

单次请求最多 256 KiB，资源与恢复明细各最多 512 项。超过明细预算时 `detailsComplete=false`，全量计数和完整库存摘要不截断；安全判定依据完整聚合证明，不能从明细前缀推断全部停止。上传失败不推翻已经持久保存的停止事实，未知库存不能当作零。

## 业务准入与保留通道

没有生命周期行的旧 Worker 保持既有行为。一旦建立生命周期资源，即使调用旧业务协议，也必须遵守当前门禁。

Task claim、Session 新业务输入及派发、Bot 新承载和执行恢复在原业务事务内检查 Worker 准入。停用先提交时明确拒绝；业务准入先提交时保留准确原身份，属于本机停止对账责任。已接受但尚未派发的 Session 输入因停用终结为 `worker_disabled`，恢复不自动重新发送。

原操作结果查询、停止、回执、归档和管理报送继续可用。同一 Bot 承载和执行的 reconnect 授权续期在停用后仍可进行，并保持原凭据、Controller、执行及本机身份校验，避免授权过期切断停止和回执通道。新承载和新执行代际仍检查目标 Worker 的准入；有合法停止证明的 takeover 不要求已经停用的旧 Worker 重新开放。停用不释放 claim，不改变 Task 的完成、取消或人工暂停，也不延长 assistant-task 租约。恢复仍受原业务权限、归属、容量及独立暂停约束。

## 冲突和未知写入

请求摘要为 RFC 8785 规范 JSON 的 SHA-256，域前缀是 `daynight.lifecycle.v1/<requestKind>\n`。同 ID 不同摘要返回 `409 operation_conflict`。版本冲突、旧实例、旧意图和旧观察分别返回 `version_conflict`、`stale_instance`、`stale_intent`、`stale_report`。未停止返回 `disable_incomplete`，安全阻塞返回 `safety_blocked`，能力不全返回 `422 lifecycle_unsupported`，业务门禁返回 `423 worker_disabled`，权威不可用返回 `503 lifecycle_unavailable`。

超时、取消、损坏响应或未知 commit 均须保留原 operationId 和请求，先查询原结果。GET 404 和 intent 的 `activationOutcome=not_started` 都不能证明迟到原请求不会提交。resolve 在同 Worker 锁下返回已保存结果，或保存未提交终结墓碑；迟到原请求随后返回 `operation_resolved_not_committed`，不能再执行。

resume 意图与 activation 子阶段共享 operationId，但分别保存请求摘要和 resolution。封闭 activation 不得抹掉已接受的意图。只有确定未提交结果才允许基于当前状态独立决定新操作；不能自动重发未知写入。
