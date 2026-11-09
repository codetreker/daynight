# Worker 当前监控服务端合同

认证账号可以向自己的近期 Worker 保存并读取一份当前运行观测。它表达运行、调度、容量和异常摘要，不提供日志、事件流、历史查询或补传。资源准入沿用 [Worker 快照合同](daynight-worker-snapshots.md) 的账号身份和 72 小时窗口；本接口不修改心跳、Task、claim 或执行所有权。[服务端设计](../design/daynight-worker-monitoring.md)描述实现与失败隔离。

本页规定交换合同和生产者必须满足的语义；Worker 采集和完整组合验收分别有独立责任。所有字段必需，除非类型明确为 null。拒绝未知字段、重复字段、未知枚举、错误类型和格式，不补默认值。UUID 使用规范小写形式；sequence 为 `1` 至 `9223372036854775807` 的无前导零十进制字符串；时间解析 RFC3339Nano 后规范化为 UTC。计数和毫秒为不超过 2^53−1 的非负安全整数。

## 闭合状态模型

```ts
type Coverage = "unknown" | "complete" | "partial";
type DetailCoverage = "complete" | "partial";
type Scope =
  | { kind: "worker" }
  | { kind: "project"; projectId: string }
  | { kind: "claim"; projectId: string; taskId: string; claimId: string };
type SchedulerPhase =
  | "initializing" | "configuration" | "inventory" | "project-preparation"
  | "resource-observation" | "reconciliation" | "claim-search" | "claim-request"
  | "archive-backfill" | "waiting-poll" | "stopping" | "stopped";
type ReasonCode =
  | "configuration-unavailable" | "configuration-incomplete"
  | "inventory-unavailable" | "project-unavailable" | "project-preparation-failed"
  | "resource-observation-unavailable" | "capacity-full" | "cleanup-capacity-blocked"
  | "no-projects-selected" | "no-ready-tasks" | "claim-unconfirmed"
  | "retained-resource-conflict" | "stopping";
type WaitReason =
  | "native-input" | "retry-backoff" | "task-paused" | "resource-stop"
  | "operation-lock" | "recovery-blocked" | "initializing" | "unknown";
type RetryState = "none" | "scheduled" | "running" | "manual";
type ExecutionPhase =
  | "observation" | "worktree-preparation" | "agent-start" | "agent-observation"
  | "input-submission" | "preparing" | "executing" | "verifying"
  | "completing" | "waiting" | "paused";
type CleanupPhase = "observation" | "agent-stop" | "backend-close" | "archive" | "worktree-removal";
type ActivityPhase =
  | { kind: "execution"; phase: ExecutionPhase }
  | { kind: "cleanup"; phase: CleanupPhase }
  | { kind: "maintenance"; phase: SchedulerPhase };
type StructuredCause = {
  type: string;
  code: string;
  cause: string;
  causeTruncated: boolean;
};
type Activity = ActivityPhase & {
  operationId: string;
  status: "queued" | "running" | "waiting" | "paused";
  scope: Scope;
  startedAt: string;
  lastProgressAt: string | null;
  elapsedMs: number;
  deadlineAt: string | null;
  waitReason: WaitReason | null;
  nextAttemptAt: string | null;
};
type Reservation = {
  reservationId: string;
  scope: Scope;
  roles: readonly ("active-task" | "resource-owner" | "unresolved" | "cleanup" | "pending-stop")[];
  occupied: boolean;
  observedAt: string;
};
type AdmissionReason = {
  code: ReasonCode;
  scope: Scope;
  observedAt: string;
  nextAttemptAt: string | null;
};
type Failure = {
  operationId: string;
  component: string;
  phase: string;
  scope: Scope;
  error: StructuredCause;
  firstObservedAt: string;
  lastObservedAt: string;
  occurrencesInRun: number;
  retryState: RetryState;
  nextAttemptAt: string | null;
};
type RecoverySummary = {
  operationId: string;
  component: string;
  scope: Scope;
  observedAt: string;
  explanation: string;
  explanationTruncated: boolean;
};
type DeliveryFailure = {
  observedAt: string;
  phase: "read" | "write" | "reconcile" | "shutdown";
  error: StructuredCause;
  requestId: string | null;
};
type Observation = {
  runId: string;
  sequence: string;
  capturedAt: string;
  lifecycle: "starting" | "running" | "stopping" | "stopped";
  scheduler: {
    phase: SchedulerPhase;
    coverage: Coverage;
    cycleId: string | null;
    lastCompletedAt: string | null;
    lastSuccessfulAt: string | null;
    lastOutcome: "completed" | "failed" | "cancelled" | null;
    nextPollAt: string | null;
  };
  capacity: {
    observedAt: string;
    quality: "current" | "stale";
    limit: number;
    occupied: number;
    available: number;
    detailCoverage: DetailCoverage;
  } | null;
  admission: { observedAt: string; coverage: Coverage; reasons: readonly AdmissionReason[] };
  reservations: readonly Reservation[];
  activities: readonly Activity[];
  currentFailures: readonly Failure[];
  lastRecovery: RecoverySummary | null;
  detailCoverage: DetailCoverage;
  delivery: { lastSucceededAt: string | null; lastFailure: DeliveryFailure | null };
};
```

ExecutionPhase 中的 preparing/executing/verifying/completing/waiting/paused 保留既有 WorkerPhase 拼写；CleanupPhase 完全沿用现有 WorkerCleanupStage。维护活动采用已列出的 SchedulerPhase，不能引入任意操作名称。

Failure 的 component 使用 `runtime`、`scheduler`、`configuration`、`inventory`、`project`、`resources`、`execution`、`cleanup`、`archive`、`monitoring`；phase 必须取对应组件已有阶段：runtime/scheduler/inventory/project/resources/configuration/archive 使用 SchedulerPhase，execution 使用 ExecutionPhase，cleanup 使用 CleanupPhase，monitoring 使用 DeliveryFailure.phase。诊断分类、精确固定文本、适用 scope 和来源映射由“诊断内容准入”定义，不接受任意日志消息。

operationId/cycleId/runId/claim ID 为 UUID；reservationId 为按下文方式生成的规范小写 UUID，运行内同一责任稳定。roles 非空且去重。Scope.project 能表示没有 Task 的项目准备/配置失败，不能使用 worker scope 暴露项目原因。

capacity 为 null 表示从未获得容量观测；有旧观测则保留其 observedAt 和 stale。limit 沿用配置 1–64，occupied 保留真实总数，available=max(0,limit−occupied)，不从截断后的 reservations 反推。完整搜索成功耗尽才可报告 no-ready-tasks；未知/失败/覆盖不足不能报告该原因。

lastProgressAt 为 null 表示未观测到真实进展；deadlineAt 为 null 表示原操作没有可用 deadline。elapsedMs 来自 Worker 单调时钟。nextAttemptAt 只用于真实已知退避/安排；Failure.retryState=scheduled 时必须有该时间，其他状态为 null。firstObservedAt/次数只声明本次运行实际观测，不推测跨重启历史。lastRecovery 仅保留一份最新恢复摘要。

## 字段与编码限额

PUT 完整 JSON 及规范化正文各最多 256 KiB。activities/reservations/currentFailures 上限为 128/128/32；reasons 最多 16；roles 最多 5。字符串 UTF-8 上限：component/type/code 64 bytes、cause/explanation 2048 bytes、requestId 128 bytes。诊断原因与恢复说明使用下文固定摘要，truncated 标记必须为 false；输入不能由服务端静默截断，生产者构造有界观测并置 partial。

观测器保留完整准入计数，详情按阻塞/异常优先、首次观测时间、稳定 ID 排序截取。所有时间、质量、完整计数均独立于被截取的明细。Server 在权限过滤和名称补充后按真实 Go JSON escaping 再执行响应预算，保留精确容量与无名称故障摘要，逐项加入标签/普通活动，超限明确 labelsOmitted/detailCoverage=partial。

## 诊断内容准入

保留现有 JSON 结构。`StructuredCause.type` 必须为 `operation`，`code` 必须为下表之一，`cause` 必须与对应英文原文完全一致；`causeTruncated` 必须为 `false`。这些句子是完整的分类摘要，不是截取后的原始异常。`currentFailures[].error` 和 `delivery.lastFailure.error` 共用此表。每项分类只能在对应事实确有证据时使用；未能可靠分类时使用 `unknown`，不从错误文本猜测。

| code | 精确的 cause | 采用条件 |
| --- | --- | --- |
| `cancelled` | `The operation was cancelled.` | 观察到该操作实际取消。 |
| `timeout` | `The operation timed out.` | 实际 deadline 或受控超时明确到期。 |
| `authentication-required` | `Authentication is required.` | 受控接口确认需要认证。 |
| `limit-exceeded` | `An operation limit was exceeded.` | 已知操作或接口明确拒绝超出限额。 |
| `rate-limited` | `The operation was rate limited.` | 受控接口明确返回限流拒绝。 |
| `permission-denied` | `Permission was denied.` | 受控接口的权限拒绝或可信操作边界明确给出权限拒绝。 |
| `not-found-or-inaccessible` | `A required resource was not found or is inaccessible.` | 受控接口确认的 404 可能掩盖权限拒绝。 |
| `not-found` | `A required resource was not found.` | 受控接口明确报告必要资源不存在。 |
| `conflict` | `The operation encountered a conflict.` | 受控接口或已有类型明确报告冲突。 |
| `unavailable` | `A required service or resource is unavailable.` | 受控接口明确报告服务或资源不可用。 |
| `invalid-response` | `The response was invalid.` | 已验证的协议解析明确失败。 |
| `resource-exhausted` | `A required resource was exhausted.` | 可信边界明确报告资源耗尽。 |
| `configuration-missing` | `Required configuration is missing.` | 实际确认必需配置缺失。 |
| `configuration-invalid` | `The configuration is invalid.` | 已知配置校验明确失败。 |
| `command-failed` | `A required command failed.` | 受控命令执行结果明确失败；不上传命令或输出。 |
| `io-error` | `A required I/O operation failed.` | 已知 I/O 操作边界明确报告 I/O 故障。 |
| `invalid-output` | `A required operation produced invalid output.` | 已知解析或校验边界明确报告输出无效。 |
| `recovery-limit` | `The recovery limit was reached.` | 已有恢复状态明确为 `recovery_limit`。 |
| `native-identity-missing` | `The original native execution identity is missing.` | 已有恢复状态明确为 `native_identity_missing`。 |
| `worktree-validation-failed` | `The worktree failed ownership validation.` | 现有 worktree 前置条件明确报告 `validation_failed`。 |
| `branch-mismatch` | `The worktree branch does not match the recorded owner.` | 现有 worktree 前置条件明确报告 `branch_mismatch`。 |
| `recovery-blocked` | `Recovery is blocked and needs attention.` | 既有恢复状态明确为 blocked。 |
| `outcome-unknown` | `The operation outcome is unknown.` | 操作可能已生效但结果未确认。 |
| `unknown` | `The operation failed; inspect local Worker diagnostics for details.` | 不能可靠归入其他分类。 |

Worker 在拥有事实的操作边界，从受控枚举、协议结果或已确认的错误类型构造上述三元组；不能把任意对象的 `name`、`code`、`message`、`cause`、堆栈、stderr/stdout、服务响应详情、路径、URL、环境值、prompt、项目或任务名称插入字段。现有 `WorkerCleanupError` 的 stage 是阶段事实，其拼接的消息不是安全原因；本机诊断继续沿用原有职责。通用底层错误类型本身不能证明项目、资源、超时或恢复的具体状态。真实取消与错误继续走既有处理，不为了监控改变操作结果。

分类按以下顺序决定，先命中者生效；受控类型指在本地已知调用边界创建或解析的具体类型，不能信任任意对象的同名属性：

1. 已知远端变更结果未确认（包括 `ApiError.outcomeUnconfirmed=true`）先归 `outcome-unknown`，即使底层是超时或取消；既有读回和重试策略不变。
2. 实际观测的 `OperationError.kind`：`cancelled` 为 `cancelled`，`deadline`/`request_timeout` 为 `timeout`，`request_limit`/`response_limit`/`total_limit` 为 `limit-exceeded`；`disposed` 使用 `unknown`。
3. 已确认的 API 拒绝仅按确定的状态分类：401 为 `authentication-required`，403 为 `permission-denied`，404 为 `not-found-or-inaccessible`，409 为 `conflict`，413 为 `limit-exceeded`，429 为 `rate-limited`，503 为 `unavailable`；其他状态为 `unknown`。响应解析或分页失败且无未确认写入时为 `invalid-response`。不能复制服务端错误正文或 code。
4. 本地 `WorktreePreconditionError.code` 的 `branch_mismatch` 和 `validation_failed` 分别为 `branch-mismatch` 和 `worktree-validation-failed`；受控 `RecoveryState.reasonCode` 的 `native_identity_missing`、`recovery_limit`、`recovery_blocked` 分别为 `native-identity-missing`、`recovery-limit`、`recovery-blocked`。明确的受控命令失败为 `command-failed`，已知输出解析失败为 `invalid-output`；只在可信 I/O 边界确知 I/O 失败时为 `io-error`，不能把任意未知异常当作 I/O 故障。
5. 其他情形为 `unknown`。对聚合错误不猜测其中哪一条代表整体原因；确知结果未确认时仍按第 1 条，否则用 `unknown`。`WorkerCleanupError.stage` 仅选择阶段；可在受控包装关系内检查其已知类型 cause，但不递归采用任意对象、消息或未经验证的属性。

任何其他表项仅由明确的对应操作事实构造；若捕获点没有可靠证据，则不选择它。

恢复仅在实际观测该失败对应操作恢复成功时记录。`lastRecovery.explanation` 精确为 `The operation recovered.`，`explanationTruncated=false`；保留其真实 component、operationId、scope 和 observedAt。失败消失、心跳或监控上报成功本身不证明其他操作恢复。可用详情来自 component、phase、固定分类、关联、实际观测时间、次数、retryState 和 nextAttemptAt；需要原始故障详情时查看本机诊断。这样有意牺牲远端自由文本细节，以避免将未知敏感内容当作安全信息。

## 其他文本、关联与权限

- `reservationId` 必须为规范小写 UUID。Worker 每次运行用 CSPRNG 生成独立的 32 字节密钥，只保留在内存。HMAC-SHA-256 输入依次为 UTF-8 字节 `daynight-worker-monitoring-reservation-v1`、一个零字节、准入容量投影去重使用的规范小写 `projectId`、`taskId`、`claimId` 三个 36 字节 UUID 的 ASCII 表示（固定顺序、无分隔符）。取摘要前 16 字节，按 UUID v4 设置 version 和 RFC variant 位，编码为规范小写 UUID。必须使用容量计算的三元身份，不使用包含 worktreeId 的四元 owner、路径或来源分别生成；没有可靠身份的详情省略并标 partial，不改变真实容量。截断到 128 条前检查完整投影生成的 UUID；如设置 UUID 位后发生碰撞，省略所有冲突责任详情并标 partial，不能合并责任或伪报占用。标识不包含明文身份、路径或错误文本，同一责任在一次运行中稳定，无须随任务周转增长的映射；单独的 reservationId 不提供跨运行关联，其他可见 scope 字段仍可关联。它不代表 claim 所有权。
- `delivery.lastFailure.requestId` 为 `null` 或该次失败的监控请求当时由 Worker 自己生成并实际使用的规范小写随机 UUID；不能复制任意上游响应消息或请求 ID。未取得可靠对应关系时用 `null`。该 ID 用于关联该请求的服务端诊断，不代表写入已提交。
- 项目或任务相关事件必须使用对应 project/claim scope；`project-unavailable`、`project-preparation-failed` 和 project 组件故障不能用 worker scope。若应关联项目却没有可靠 ID，则省略该详情并将对应覆盖标记为 partial/unknown，不能降级为 worker 级文本。服务端检查结构上可判定的 scope 约束；生成端保证语义关联。
- Worker 只有在实际全局准入因清理占用容量而阻塞时，才在 `admission.reasons` 独立产生最多一条 `{code:"cleanup-capacity-blocked",scope:{kind:"worker"},observedAt:<admission.observedAt>,nextAttemptAt:null}`，不含隐藏 ID 或数量。该条在 16 项上限内优先保留；若其他原因因此省略，admission.coverage 标为 partial。普通清理或仅有占用不自动构成阻塞。
- Server 读取时依据当前项目/任务权限过滤关联项及其 ID、原因、错误与名称；清理不以旧 claim 仍活跃作为条件。保留真实 Worker 总容量及上面独立上报的无身份阻塞事实，为该 worker scope 原因输出 `association:null`。Server 不从隐藏详情或占用推断或合成阻塞，不逐条匿名化；`permissionProjection=restricted` 不含隐藏数量。
- UUID 和数值限制防止可信 Worker 意外搬运原文，不能防止有上报权限的恶意 Worker 将信息编码进 UUID、计数或时间。服务端不能从输入证明自报运行事实或语义 scope 的真实性；监控不作为执行所有权证明。当前权限过滤与账号隔离仍是独立的访问边界。

PUT 对未知 type/code、错误配对、非固定文本、true 截断标记、非法 ID 或可判定的 scope 违例返回 400；不得静默修正。Redis 已存值读取时若违反合同，返回 monitoring_unavailable，而不是 absent 或原样返回。日志保留内部错误链但不记录原始状态或凭据。

既有码和固定句不得重定义或复用为新含义。新增分类须先让所有 Server 副本部署并确认支持，再部署能识别它的严格 Web 消费者，最后让 Worker 上报。新 Server 接受旧表，未知值按闭合合同拒绝。回滚到不能读取新码的 Server 前，须先停止新码生产并等待相关帧过期或安全地被旧兼容状态替换；否则保留能读取新码的 Server。不提供旧监控 Redis 帧兼容；协议演进不得依赖各组件同时升级。

## HTTP 合同

三条路由认证、resource admission 和方法拒绝沿用既有 Server 机制。请求不接受查询参数、owner 字段或未知 JSON 字段。权限与资源准入先确认账号拥有的、现有 72 小时窗口内 Worker。

### PUT /api/v1/me/workers/{workerId}/monitoring

请求为 `{expectedRevision: UUID|null, observation: Observation}`，两个字段必需。API 最终还受 REST 1 MiB 外层限制。

成功新写入与确认重复均 HTTP 200：

```json
{"revision":"<uuid>","runId":"<uuid>","sequence":"1","receivedAt":"<UTC time>","expiresAt":"<UTC time>"}
```

receipt 的 receivedAt/expiresAt 由 Redis TIME/3600 秒生成，重复返回原 receipt，不续期。

### GET /api/v1/me/workers/{workerId}/monitoring

```json
{
  "observedAt":"<Redis UTC observation time>","state":"available",
  "revision":"<uuid>","runId":"<uuid>","sequence":"1",
  "receivedAt":"<UTC time>","expiresAt":"<UTC time>",
  "data":{},"detailCoverage":"complete","permissionProjection":"current"
}
```

data 是权限投影后的 Observation。读取 DTO 的每个 scoped 明细增加 association，类型为 null、`{kind:"project",projectName:string}`、`{kind:"task",projectName:string,title:string}` 或 `{kind:"labels-omitted"}`；最后一种只用于已授权标签因响应预算省略。PUT 不接受 association。

permissionProjection 为 current/restricted。不可访问/已删除的 scoped 明细、ID、原因、关联标签和数量分解一同过滤；restricted 不包含被隐藏数量。Worker 总容量和无身份的阻塞事实保留，不能显示私有任务行。清理 scope 不要求旧 claim 仍活跃；当前任务权限决定标签，监控关联不是执行所有权证明。

Redis 键缺席时 HTTP 200 state=absent，revision/runId/sequence/receivedAt/expiresAt/data 全为 null，detailCoverage=complete、permissionProjection=current。未知、外账号或已超出现有 Worker 可见窗口返回 404。依赖/解析/存储故障不是 absent。完整编码含外壳和换行最多 512 KiB。

### POST /api/v1/me/workers/monitoring/query

请求 `{workerIds: UUID[]}`，1–100 个不同 ID。整批确认当前账号与可见窗口；重复/非法 ID 为 400，任一资源准入失败为通用 404，不枚举跨账号部分结果。

响应 `{observedAt,items:[{workerId,state,revision,receivedAt,expiresAt,summary}]}`，保持请求顺序，最大编码 256 KiB。state 为 available/absent；absent 的 revision/receivedAt/expiresAt/summary 为 null。

summary 包含 `{capturedAt,lifecycle,scheduler:{phase,coverage,lastSuccessfulAt,nextPollAt},capacity:{observedAt,quality,limit,occupied,available}|null,detailCoverage,admission}`。`admission` 必需，包含原准入观测的 `observedAt`、`coverage`、当前权限过滤后的 `reasonCodes` 和 `permissionProjection`（`current` 或 `restricted`）。原因按下列固定索引排序并去重，最多 13 个。过滤任何原因时为 restricted，不返回隐藏数量；没有 scope、项目/任务/claim ID、名称、路径、错误原文或私有数量。空原因、unknown、partial 或 restricted 不表示无就绪任务；只有原覆盖完整且确实报告 `no-ready-tasks` 才能呈现该原因。无身份的 `cleanup-capacity-blocked` 必须来自独立上报的全局事实。

查询先整批确认 Worker，再仅对已准入 ID 读取 `GETRANGE 0 2047`，不读正文、不扫描键空间；随后在一个当前权限快照中再次确认全部 Worker 并批量核对项目和任务。逐条过滤后才去重，权限或 Redis 故障整批明确失败，不变成空原因或 absent。

## 错误、CAS 与存储

错误使用 `{error:{code,message,requestId,details?}}` 外壳：409 monitoring_revision_conflict / monitoring_sequence_stale / monitoring_sample_conflict / monitoring_state_lost；503 monitoring_unavailable / monitoring_write_outcome_unknown。既有 400/401/403/404/413 和方法 405 合同保持。内部 Redis 类型、格式、网络、OOM 错误保留 cause 链并进入结构化诊断，响应不加入 Redis URL/原始 payload。

CAS 顺序：先校验旧帧/版本/key 类型；缺席+非 null revision→state_lost；同 run+sequence+digest→重复；同 run+sequence 不同 digest→sample_conflict；同 run 旧 sequence→sequence_stale；revision 不匹配→revision_conflict；其余用一条 SET EX3600 接受新状态。所有拒绝/重复不写状态和 TTL。

存储 key 为 `dn:worker-monitoring:{userId:workerId}`。首行 JSON 包含 formatVersion=2、revision、runId、sequence、bodyDigest、receivedAtMs、expiresAtMs、summary；连换行最多 2 KiB。正文是 Go 规范 JSON Observation，最多 256 KiB；完整值最多 258 KiB。digest 为规范 Observation JSON 的 SHA-256，不包含 expectedRevision。Lua 只解析首行，sequence 用规范十进制字符串的长度/字典序比较。

首行私有 StoredSummary 包含原摘要和 `admission={observedAt,coverage,reasons}`，最多 16 个 `[codeIndex,scopeToken]`。索引按下表固定；worker scope 为 null，project 是 16 字节 UUID 的规范无 padding base64url，claim 为 project 与 task 各 16 字节拼接后同样编码。claimId 不用于权限核对。token 仅能解码为 16 或 32 字节，必须重新编码逐字一致；非法类型、索引、字段或长度明确拒绝；`no-ready-tasks` 仅配完整覆盖，项目不可用或项目准备失败不得使用 worker scope。私有引用不进入 HTTP 或日志。公共和存储摘要使用独立闭合 codec，原正文保留完整 scope。

| 索引 | ReasonCode |
| --- | --- |
| 0 | configuration-unavailable |
| 1 | configuration-incomplete |
| 2 | inventory-unavailable |
| 3 | project-unavailable |
| 4 | project-preparation-failed |
| 5 | resource-observation-unavailable |
| 6 | capacity-full |
| 7 | cleanup-capacity-blocked |
| 8 | no-projects-selected |
| 9 | no-ready-tasks |
| 10 | claim-unconfirmed |
| 11 | retained-resource-conflict |
| 12 | stopping |

MonitoringStore 提供 CompareAndSet(identity,expectedRevision,candidate) / Read(identity) / ReadSummaries(identities)。identity 是 UserID/WorkerID 类型，不是任意 key。CAS result kind 为 accepted/duplicate/revision-conflict/sequence-stale/sample-conflict/state-lost，成功/重复带 receipt；冲突可带内部 metadata。缺席是明确 missing result，Redis/格式/类型错误为 error。驱动/命令只归 Redis adapter，所有操作总 deadline 200 ms；PG 事务不覆盖 Redis。

没有运行注册、租约或持久历史。响应丢失不证明写入失败，客户端必须先读回状态，不得自动重放旧观测。

## 格式切换

正式首行 codec 和 CAS 只接受 v2，不提供旧格式兼容。独立确认存量为空且旧写入已排空时可以直接切换；存量存在或未知时，关闭并排空全部旧 monitoring 写入，以 Redis TIME 为起点等待至少 3600 秒，使合法旧帧按原 TTL 自然过期，再完整部署和验证 v2 Server 并恢复监控，随后部署 Web。监控维护窗口明确返回 503，心跳、Task、claim 和清理保持独立。回滚采用同一排空和自然到期条件；不扫描、迁移或删除键，不延长 TTL。无法确认写入已排空或 Redis 时间达到门槛时，监控保持关闭。操作细节见 [Server README](../../packages/daynight-server/README.md#monitoring-format-transition)。
