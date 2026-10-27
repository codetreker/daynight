# Worker 任务认领与执行归属

状态：服务端认领、归属更新、释放、移交、人工接续及 CLI/Web 读取模型已实现。本文拥有认领基础能力的协议和事务；[Worker 需求](../spec/daynight-worker.md)拥有产品行为，[整体架构](daynight-worker.md)拥有调度、资源和恢复的职责划分。[决策记录](../../.agents/notes/implemented/architecture/2026-10-24-worker-claim-foundation.md)保存选型及限制。本机身份、实例锁与 projects/tasks SQLite 记录已由[本机记录模块](../../packages/daynight/src/commands/worker/store.ts)提供，[工作区模块](../../packages/daynight/src/commands/worker/worktrees.ts)负责实际 Git 仓库与 task worktree，[Herdr 适配](../../packages/daynight/src/commands/worker/herdr.ts)提供私有实例及原生资源操作；前台 [worker run 与人工管理命令](daynight-worker.md#agent-完成与人工操作)组合这些能力；完整三平台运行时验收保留独立证据边界。

## 资源和属性所有权

完整 Task 的 `properties` 必须包含 `pullRequests` 与 `worker`。`worker` 为 null 表示没有执行归属记录；非 null 时是最后一条认领记录，`state` 为 `active`、`released` 或 `completed`。历史任务通过迁移取得显式 null，读取器不以缺失字段代替 null。图保持原有精简投影，不包含属性。

```json
{
  "claimId": "536f264f-83a1-49e1-a585-a0c9024c0402",
  "state": "active",
  "userId": "f9d4965d-8585-4012-bf2a-0274ac47173b",
  "workerId": "cdd892c2-2c10-495a-b7ee-a94aa3d3c1fd",
  "machine": {"id": "3475decc-e9e4-4615-857f-c5f31a2259e1", "name": "build-machine"},
  "platform": "linux",
  "agent": "codex",
  "worktreeId": "45dd8ec8-a8ea-4ac9-a72d-c2ed98fc66f5",
  "phase": "preparing",
  "herdr": null,
  "nativeSessionId": null,
  "claimedAt": "2026-10-24T12:00:00Z"
}
```

`platform` 为 windows/linux/macos，`agent` 为 codex/copilot。`phase` 为 preparing/executing/verifying/completing/waiting/paused，是执行摘要，不是第二套 task 状态。Herdr 关联未取得时为 null，取得后是包含非空 `session`、`workspaceId`、`paneId` 的对象；原生会话未取得时为 null。认领创建时阶段为 preparing，会话字段为 null。

初始认领和人工接续的 userId 来自服务端认证用户；移交的目标 userId 由服务端校验为当前项目成员。`claimedAt` 使用数据库时间。机器、实际平台和资源关联由调用方报告，不构成机器认证、在线保证或硬件证明。released/completed 保留最后身份、工作区及会话信息作为历史，不自动过期；字段存在不证明原资源仍存活，也不要求新执行复用它们。

存储/读取 codec 与公共属性写入 codec 分开。普通 create/PATCH 提供 worker 字段时，即使为 null 或与现值相同也返回 invalid_input。PR 列表修改保留 worker，worker 操作保留 PR 及其他任务资料。016_task_worker.sql 在规范 JSON 文本末尾插入 worker:null 并调整默认值，保留版本和时间；不经过 PostgreSQL JSON/JSONB 转换，以保留既有 PR 字符串中的 NUL 转义和 Unicode 语义。

## HTTP 操作

以下路径均位于 `/api/v1/projects/{projectId}/tasks/{taskId}`。全部写入要求正 int64 `version`，成功返回 200、完整 Task 与 no-store；沿用严格 JSON、重复/未知字段及请求体限制。`claimId` 是 UUID，不能把旧 ID 用作另一次执行。自动初次认领生成新 ID；稳定 workerId、原服务范围/项目仓库映射及 projects 中具体未决 claimAttempt 先持久保存。实际远端 claim 确认后才登记本机 pending，不预建 task 行或新增表；未知请求被原标识约束，不自动重放。Transfer 则在 source 管理意图中先持久保存新 targetClaimId，再调用远端。

| 方法和后缀 | 输入与结果 |
|---|---|
| POST `/worker-claim` | version、claimId、workerId、machine、platform、agent、worktreeId；自动认领，终止后重新认领使用新 claimId/worktreeId。 |
| PATCH `/worker-claim` | version、claimId，及 phase/herdr/nativeSessionId 中至少一个字段；只更新当前执行摘要。 |
| PUT `/status` | version、status；只有 done 目标可附带 claimId，以完成当前 active 归属。 |
| POST `/worker-claim/release` | version、claimId、stoppedConfirmed:true；释放已停止的执行，返回 todo。 |
| POST `/worker-claim/transfer` | version、claimId、newClaimId、target、worktreeId、stoppedConfirmed:true；以目标的新执行原子移交并保持 in_progress。 |
| POST `/worker-claim/resume` | 自动认领的身份字段，加 previousClaimId；显式人工安排已释放 task 的新执行。 |

Transfer 的 target 必须包含 userId、workerId、machine、platform、agent。调用者是原 owner 或项目管理员；目标成员不因被指定为接收者而获得提交移交的权限。Source 完成原 agent/workspace/worktree 清理后，授权调用者提交目标新执行描述；目标执行方确认服务端实际新归属后，按普通 pending→active 创建新的工作区与原生会话。授权方与目标可以是同一用户。

### 自动认领和终止后新执行

项目写事务取得锁后重新核验当前成员、精确版本、todo、全部前置完成、allowAgents=true、平台兼容和无 active 归属。成功同时进入 in_progress 并安装 active 记录，只增加一次任务版本。候选快照不替代事务校验。

没有记录时创建初始归属。存在 released/completed 历史时，新的 claimId 与 worktreeId 均须区别于最后执行；completed task 仍须先合法重开。Agent 可明确选择为 codex/copilot，与 source 类型独立。接口严格拒绝已废弃的 continuityConfirmed，不兼容忽略。服务端校验新身份及资格；仍有效同一 claim 的原 worktree/native history 恢复由运行时核对，终止后新执行不依赖这些源资料。

人工 resume 只处理 released、todo 且全部前置完成的任务。调用者必须仍是项目成员，并是原 owner 或管理员；previousClaimId 必须匹配保留记录，claimId/worktreeId 必须为新的执行身份。它创建归属于认证调用者的新 active claim，允许本次明确 agent，保留普通人工安排不受自动许可/平台过滤限制的语义。自动调度不能失败后退入该入口；普通 daemon 跳过 released 候选并继续后续分页。公开 resume 命令使用本次有效配置，实际取得 claim 后才登记 pending。

### 更新、完成和状态保护

执行摘要更新要求 active 记录及匹配 claimId，且认证用户为当前 owner。身份、平台、agent、工作区、状态和认领时间不可通过该入口改写。精确版本同值更新保留版本、更新时间和执行时间；旧版本同值请求仍冲突。

普通从未由 worker 管理的任务继续使用九种三状态组合。状态设置先核验成员和精确版本，再处理同状态 no-op；no-op 不释放归属或改变计时。实际转换遵循以下保护：

| 当前归属 | 状态转换规则 |
|---|---|
| active | done 必须提供匹配 claimId 且由 owner 提交；同时标记 completed。回到 todo 必须使用 release。 |
| released | 普通 todo→in_progress/done 被拒绝；通过满足资格的自动认领或显式人工 resume 开始新执行。 |
| completed 或 null | 普通三状态设置保持原行为；completed 历史记录不会因状态重开而变成 active。 |

非当前 claim 引用不能完成或更新执行。管理员可以 release/transfer，但不以管理员身份代替 owner 完成当前执行。metadata PATCH 没有 status，也不能写 worker。[显式解除引用并删除其他目标](daynight-task-deletion.md)允许源任务仍持有 active claim：只移除其指向目标的依赖并增加源任务版本，保留 claim、状态和计时。源 worker 的下一次写入须核对新版本，该操作不表示 release、停止或移交执行；active 目标任务自身仍禁止删除。

### 释放、移交和计时

Release 要求当前 active claim、原 owner/admin 权限和停止确认。它将记录置为 released，task 返回 todo并按现有计时规则清空起止时间；许可、平台和最后资源资料作为历史保留。重新认领或 resume 开始新的执行区间。

Transfer 要求原 owner/admin 和当前目标成员，重新核验自动许可、目标平台和全部前置；newClaimId 与目标 worktreeId 必须区别于当前记录，目标 agent 可明确变更。它保持 task 的 in_progress 和起止时间，安装目标 active 记录，以数据库时间记录新的 claimedAt，阶段恢复为 preparing、会话为 null。旧执行方的 claim 写入失效。

stoppedConfirmed 表达授权调用方已核实原 agent 真实停止，不代表服务端远程停止了进程。主动管理命令先持久保存 source 意图，完成原 agent 有界清理、停止、关闭 workspace 和删除 worktree，才提交远端；未知结果保留原意图，不能重建 source。Daynight fencing 只能拒绝旧的业务写入，不能撤销 Git 凭据或终止原 agent。不确定原执行是否已停时保留原归属，不提交 release/transfer。

## 事务、错误和身份范围

全部写入复用现有 Tasks 服务和项目行锁，同一事务内核验成员、版本、依赖、归属并写入属性、状态、计时和版本。失败、取消或数据库错误完整回滚。许可或平台编辑与认领同版本竞争只能提交一个有效结果。无需归属查询投影、索引或独立 claim 表。

真实 worker 修改沿用同一事务的 task.version 与 updatedAt；[时间窗口摘要](daynight-task-sync.md)因此能观察到其业务版本变化，同值 no-op 保持原值。摘要只读且不包含 properties，不携带 worker 归属；需要核对执行身份时仍按已知 taskId GET 完整 Task。现有同步窗口和更新时间索引继续由摘要能力拥有，不增加 worker 查询投影或反向索引。

沿用 invalid_input、认证/forbidden/not_found、version_conflict、dependency_unsatisfied、invalid_transition，并用 claim_conflict 表达非当前归属。非成员读取和写入按现有规则隐藏任务。错误保持原有链和诊断，不转换为空候选或成功。

服务端保存最后一条归属并拒绝再次使用其 claimId；完整的历史执行保留在调用方 SQLite。任务版本保护每次写入，新 ID 由调用方按从不复用的规则生成。该模型不建立历史 claim ID 注册表、另一个版本计数器或秘密执行凭据。

## 进程内客户端、候选和恢复

Worker 直接调用 CLI 进程内 typed ApiClient。claimWorkerTask、updateWorkerClaim、releaseWorkerClaim、transferWorkerClaim、resumeWorkerTask 和 completeWorkerTask 使用各自明确的 200 响应校验；completeWorkerTask 通过现有 PUT status 提交 done 与 claimId。普通 setTaskStatus 保持 version/status 输入。公开 CLI 的 task set-status done --claim-id <claim-id> 显式选择 completeWorkerTask，并保留精确 --if-version 和同一结果校验；不从 task/environment 推断 claim，不在失败后回退普通 setter。Worker 自身调用 typed API，不启动 daynight 子进程；原生 agent 可使用这一公开完成入口。

Typed ApiClient 的 `getCurrentUser()` 复用既有 GET /api/v1/me，解码 User 的 id、email、emailVerified、name、avatarUrl 五字段；它不增加服务端 API。可选 expectedUserId 在成功响应正文准入前核对既有 Daynight-User-ID，空分页同样受约束。Worker 在读取项目/清单前固定启动凭据的认证 UID，并将实际 claim 的原 userId 保存在本机任务及未决请求；只有匹配原账号的完整清单能授权新的缺席清理/恢复。换号不改变 workerId，也不能把另一账号的空结果当作原账号归属结束；未知范围和已提交收尾的规则由[运行时设计](daynight-worker.md#前台循环与-worktree)拥有。

listTaskPage 保留 nextCursor，供运行时有界推进候选；许可、ready 和实际平台在服务端排序和分页前组合。active 记录对应 in_progress，天然不属于 ready todo。普通 daemon 跳过 released 候选并继续后续游标，不能据此把仓库判为空。

`GET /api/v1/projects/{projectId}/tasks?workerId=<uuid>` 提供当前认证用户及指定 worker 的有效 active claim，历史记录不属于清单。UUID 规范化后与隐式 userId 一起绑定游标；不附加 status/ready/allowAgents/compatiblePlatform 才是该项目完整归属查询。服务端在既有 TEXT 解码后筛选，匹配先于最终分页，不新增 claim 表或投影。

Typed ApiClient 的 TaskFilters/TaskPageQuery 支持 workerId；listTasks 成功读到末页才返回完整数组，后页失败、重复身份或游标循环抛出错误，不返回部分成功。listTaskPage 仍是显式分页接口；响应不匹配 active/workerId 时拒绝协议，不本地丢项。调用者汇总全部项目后按原 claimId 是否在清单对账，不读取 task 状态分类缺席原因。

自动初次认领结果未知时不重放；成功完整的自己 claim 清单找回实际 claim 后再登记 pending，失败或部分清单不建立归属结论。显式管理的精确版本及未知写入结果仍按具体 taskId 读取核对原 source claim 与保存的 targetClaimId；该读取不用于自动清理的缺席原因分类。只有明确拒绝的提交可由新明确决定替换，该决定须重新读取 task 并核对精确 if-version 与本次观察相同；拒绝未修改 task 时，数值相同的版本仍有效。Unknown 提交不因读到旧值解除 fence。一次 HTTP 超时、取消或 5xx 不能证明写入未发生；现有 ApiError.outcomeUnconfirmed 保留不确定结果，调用方不能自动重发。

每次轮询、写入或核对使用独立有界 Operation，并继承运行时取消信号。客户端基础不启动常驻循环，不把普通单命令的五分钟期限套到整个 worker 生存期。完整 Task 的 CLI/Web 读取器严格保留 worker；公共创建/更新输入仅暴露可写的 PR 属性。

## 关联与诊断

服务端复用现有 RequestID、请求 context 和任务资源 logger，日志关联键为 user_id、project_id、task_id、request_id。worker-claim 系列操作成功时记录 component=worker_claim、phase、claim_id、worker_id、state；claim-bound 完成沿用状态接口的 set_status 阶段和 changed/unchanged 结果。错误进入现有 LogFailure，保留已知错误码、cause 和脱敏 diagnostic，不记录凭据、请求正文或驱动敏感信息。

按响应的请求 ID 和已知任务定位一次认领写入，例如：

```sh
jq 'select(.task_id == "<task-id>" and .request_id == "<request-id>")' server.jsonl
```

请求日志用于定位操作，不能代替权威归属读取。自动初次认领的未知结果由成功完整的自己 claim 清单找回；显式管理写入按已知 taskId 直接 GET 核对当前 claim、用户、worker 和资源绑定，后续 GET 有自己的 request_id。此能力复用服务端 JSON 日志，没有新增日志子系统；常驻 worker 的本地执行日志与原生恢复遥测由运行时拥有，服务日志不构成其验收证据。

## 验证边界

服务基础验证包括真实 PostgreSQL 同版本竞争、权限/目标成员、许可/平台变化、所有状态旁路、旧 claim、释放/移交/接续、事务回滚，以及属性迁移的 NUL/Unicode 保全。客户端验证覆盖完整读取、写保护类型、200 操作、精确 int64、未知结果不重发和候选游标推进。

这些检查证明服务端和 typed client 的归属基础，不代替本机 SQLite、Git 或原生 agent 的独立证据。当前资源适配的 Linux 针对性结果及限制由[运行时验证边界](daynight-worker.md#验证与当前证据)拥有；前台协调与人工管理各有自己的验收，完整三平台交付仍须最终验证。[人工管理决策](../../.agents/notes/implemented/architecture/2026-10-27-worker-manual-control.md)保存终止后新执行和唯一控制者的取舍。
