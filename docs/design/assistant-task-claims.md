# 助手任务的认领凭据与转交

本文定义助手任务服务端、CLI 与 Worker 共同遵守的认领合同。[服务端设计](assistant-task.md)说明 API 与持久化实现；[CLI 私有状态](assistant-task-cli.md)实现单次命令的凭据与操作恢复；[Worker 接收循环](worker-bot-runtime.md#助手任务维护)负责自动绑定、续约与认领丢失后的停止。各层的单独支持不表示跨 Worker 执行已通过验收。助手任务独立于项目 Task、Worker 执行 claim、Steps 和 Thread；本文不改变这些现有资源的协议。

## 目标与约束

助手任务属于一个用户，该用户的助手可以读取登记、手册和记录。有效认领同时只属于一个助手；转交立即改变负责助手，旧认领立即失效。接手者从已有手册、事项和记录继续，不要求用户再次批准转交。

负责助手每 60 秒续约，租约为成功认领或续约的服务端时间之后 5 分钟。暂停保留认领并继续续约，但停止应用工作；删除助手使其认领失效，保留助手任务材料。删除助手任务则删除其材料。固定时长不变。

同一用户的助手共享用户凭据，Bot 身份是协作身份，不是隔离同用户恶意进程的安全边界。服务端始终核验用户凭据、任务 owner、Bot owner 与删除状态。跨用户不得读取或改变任务、认领或操作结果。

## 凭据所有者

认领令牌由将要使用它的 CLI 或 Worker 在本机通过密码学安全随机源生成：32 个随机字节，以无填充 base64url 编码。服务端只保存解码后字节的 SHA-256，不生成或返回可供其他 Worker 使用的令牌。

发出请求前，客户端先将令牌和原操作身份持久化到该 Bot 的私有状态。目录权限为 0700，文件为 0600；写入采用原子替换及持久化同步，失败时不发送请求。状态按服务 origin、ownerUserId、botId、taskId 隔离，保存 operationId、操作类型、预期代次、请求指纹和令牌。CLI 与 bot host 共用此记录和单写者协调，不能分别生成同一次认领的凭据。

令牌只出现在相应请求体和本地私有状态中，不进入 URL、日志、CLI 普通输出、任务材料、工作记录、Session 输入或持久化事件。公开读取返回凭据绑定操作的 ID，不返回令牌或令牌哈希。私有文件丢失不能通过服务端哈希恢复；客户端停止该认领的工作，等待用户处理或租约失效，不自动伪造一次新认领。

## 认领状态与代次

任务保存 `claimGeneration`、`holderBotId`、`claimTokenHash`、`credentialOperationId`、`claimedAt`、`renewedAt`、`leaseUntil`。代次是非负 int64，公开传输为精确十进制字符串；从未认领的初始代次为 `"0"`，释放后保留推进后的代次，不能溢出或回绕。版本与其他 int64 也使用十进制字符串。时间为 UTC RFC 3339 字符串。

`claimState` 根据持久字段、Bot 删除状态与同一次权威读取的数据库时间派生：

| 状态 | 条件与含义 |
| --- | --- |
| `unowned` | `holderBotId=null`，没有负责助手 |
| `pending` | 有负责助手、Bot 未删除、租约未到期，但尚未绑定令牌；登记已转交，目标尚不能工作 |
| `active` | 有负责助手、Bot 未删除、租约未到期，且已有凭据绑定 |
| `expired` | 有负责助手，但租约到期或 Bot 已删除；允许其他助手接手 |

`claimState=active` 不覆盖任务自己的 `state=paused`。公开读取同时返回 `observedAt`；客户端不能把旧观测当作续约成功或持续有效的证明。

认领、过期接手、转交和释放推进代次。绑定凭据及续约保留代次；续约不更换令牌，也不改变 `credentialOperationId`。每分钟续约与 CLI 写入共用同一凭据，不因正常续约产生 `claim_lost`。

## 操作语义

所有变更使用客户端预先保存的 UUID `operationId`。服务端把成功操作回执与业务更新放在同一事务中，遵守[数据库规范](../daynight-server-database.md)的 `committed`、`not_committed`、`unknown` 完成语义。业务规则由 core 决定，DAO 执行条件写入，service 协调同一事务内的 Bot、任务及相关事项。

认领保护的写入同时校验 owner、holder Bot、代次、令牌哈希和租约；条件在实际写入时成立，不能用请求进入时的预检查代替。权限、Bot 删除及租约判断覆盖数据库锁等待，并在提交前用最新数据库时间复核。不能使用事务开始时的 `now()` 作为经过等待后的有效性证明。失去认领时不提交业务变化或成功回执。

### 首次认领与过期接手

调用方必须有 Bot 身份。无人负责，或者当前认领已失效时，服务端按调用方提供的版本和预期代次原子登记调用方 Bot，代次加一，保存其预先持久化令牌的哈希，并将 `credentialOperationId` 设为该认领操作 ID。

`claimedAt=renewedAt=admittedAt`，`leaseUntil=admittedAt+5 分钟`；`admittedAt` 是通过写入准入复核的数据库时间。有效认领包括 `pending`，不能被第二个 Bot 抢占；拒绝返回 `claim_held`，带负责 Bot、代次和到期时间。相同 Bot 的全新认领请求也不能替换自己的有效凭据。

接手保留任务手册、事项、记录及原外部操作身份，向新助手提供前次租约到期到接手之间的空档事实。已发出的消息或报告不能因为代次改变而重新执行。

### 转交

用户可以用 `ifVersion` 与预期代次转交；负责助手还必须提交当前有效令牌。目标必须是同一用户未删除的另一个 Bot。目标与当前负责 Bot 相同返回 `invalid_input`，不延长租约。

一次转交事务完成下列变化：

1. 代次加一，`holderBotId` 改为目标，清空旧令牌哈希与 `credentialOperationId`。
2. `claimedAt=admittedAt`、`renewedAt=null`、`leaseUntil=admittedAt+5 分钟`，认领进入 `pending`。
3. 未结束事项的跟进助手改为目标，保留事项身份、既有记录和外部操作身份。
4. 保存转交回执，并生成不含秘密的目标通知。通知只用于唤醒，目标还需读取当前权威登记。

事务提交后旧令牌失效，转交已经生效；目标绑定凭据不需要用户再次确认。网站显示目标已负责、正在等待 Worker 接收，不能提前声称它已在工作。目标离线也可以被指定，但 `pending` 不代表监控正在运行；5 分钟内没有完成绑定和续约就显示失效，随后按任务原有接手策略处理。

### 目标绑定

目标 Worker 在每 60 秒的任务扫描中同时读取分配给本机 Bot 的 `pending` 认领；目标通知不能取代这项扫描，也不应让事件漏投阻断接收。Worker 先保存自己的随机令牌及绑定操作 ID，再提交绑定。

绑定必须同时匹配目标 Bot、预期代次、尚无凭据和未过期的转交租约。它只写入令牌哈希与 `credentialOperationId`，将状态变为 `active`，不推进代次、不延长转交租约，也不重新移交事项。

绑定成功后，Worker 使用相同令牌立即续约，确认成功后才启动应用循环。若绑定提交结果未知，先核对原操作，不生成新绑定身份或改用另一令牌。两个进程同时绑定时，最多一个不同操作成功；失败方不能覆盖成功方的私有凭据。

### 续约、释放与暂停

续约仅由持有有效绑定凭据的 Bot 发起。成功时设置 `renewedAt=admittedAt`、`leaseUntil=admittedAt+5 分钟`，保留代次、令牌和 `claimedAt`。当前持久期限不因迟到的续约变短。bot host 只为健康 Controller 续约，失去凭据或收到 `claim_lost` 时停止应用循环。

释放由用户或有效负责助手发起，按预期代次废止认领，代次加一并清空 holder、凭据及认领时间字段。用户释放还校验 `ifVersion`；重复的原操作只核对回执，新操作不能把已无人负责的状态解释为原释放成功。释放不删除手册、事项、记录或历史操作回执。

暂停与恢复沿用任务的版本写入。暂停时可以接收转交、绑定和续约，但不能启动应用工作；恢复时重新读权威状态，从当前事项继续。

## HTTP 合同

以下路径以 `T=/api/v1/assistant-tasks/{taskId}` 为前缀。认证沿用用户 Session 或 PAT；带 `X-Daynight-Bot-Id` 时校验其 owner 与删除状态。`operationId` 为 UUID；`expectedGeneration`、`claimGeneration`、`ifVersion` 为精确十进制字符串；`claimToken` 为上述固定编码令牌。未知字段、空身份和类型错误按现有严格输入规则拒绝。

| 请求 | 必需请求字段 | 调用方与成功结果 |
| --- | --- | --- |
| `POST T/claim` | `operationId, ifVersion, expectedGeneration, claimToken` | Bot；200，首次认领或接手回执 |
| `POST T/transfer` | `operationId, ifVersion, expectedGeneration, targetBotId`；Bot 另需 `claimToken` | 用户或有效负责 Bot；200，转交回执，无目标令牌 |
| `POST T/claim/bind` | `operationId, expectedGeneration, claimToken` | 当前 pending 目标 Bot；200，绑定回执 |
| `POST T/renew` | `operationId, claimGeneration, claimToken` | 有效负责 Bot；200，续约回执 |
| `POST T/release` | `operationId, expectedGeneration`；用户另需 `ifVersion`，Bot 另需 `claimToken` | 用户或有效负责 Bot；200，释放回执 |
| `GET T/claim-operations/{operationId}` | 无请求体 | 同一 owner；200，已提交回执及当前认领；404，未读到该操作 |

每次成功的真实变更推进任务 `version` 一次。认领与转交使用调用方提供的 `ifVersion`，不以服务端新读版本代替；续约和绑定依靠其列出的认领条件，无需携带会被其他正常写入改变的任务版本。

回执包括 `operationId, kind, taskId, actorBotId, requestFingerprint, admittedAt, resultingVersion, resultingGeneration, holderBotId, credentialOperationId, leaseUntil`。用户操作的 `actorBotId=null`。`admittedAt` 是事务内通过准入复核的数据库时间，不宣称为精确的 COMMIT 时刻；只有确认提交后才能返回成功回执。回执描述该操作的历史提交结果；写入响应和操作读取同时返回独立的 `currentClaim`，包含当前 holder、代次、状态、绑定操作 ID、时间和 `observedAt`，不能将历史成功回执当作当前有效性。

回执唯一键为 `(owner_user_id, task_id, operation_id)`，与业务变更原子保存；指纹使用下述固定编码，不保存请求明文。

### 请求指纹 v1

`requestFingerprint` 为以下十元素 JSON 数组的 UTF-8 字节的 SHA-256，以 64 个小写十六进制字符表示：

```text
["daynight-assistant-claim/1",kind,ownerUserId,taskId,operationId,actorBotId,targetBotId,ifVersion,generation,tokenHash]
```

数组顺序固定，不使用对象属性排序。元素只能是 ASCII 字符串或 JSON `null`；序列化无空白、无 BOM、无尾随换行，字符串使用普通双引号，不对 ASCII 字符另作 Unicode 转义。UUID 请求字段只接受非零、规范小写连字符表示；版本和代次只接受无符号、无前导零的十进制字符串，只有允许初始代次的字段能取 `"0"`。`ownerUserId` 来自认证主体，不能由请求改写。`tokenHash` 为解码后的 32 个令牌字节的 SHA-256，编码为 64 个小写十六进制字符；无令牌的用户操作填 `null`。

`kind` 只能为 `claim`、`transfer`、`bind`、`renew`、`release`。所有位置均存在；下表的 `null` 是指纹数组占位，不是允许向 HTTP 请求提交多余字段或显式 null。

| kind | actorBotId | targetBotId | ifVersion | generation | tokenHash |
| --- | --- | --- | --- | --- | --- |
| `claim` | 调用 Bot | null | 请求版本 | expectedGeneration | 请求令牌摘要 |
| `transfer` | 调用 Bot；用户为 null | 目标 Bot | 请求版本 | expectedGeneration | Bot 请求令牌摘要；用户为 null |
| `bind` | 调用 Bot | null | null | expectedGeneration | 请求令牌摘要 |
| `renew` | 调用 Bot | null | null | claimGeneration | 请求令牌摘要 |
| `release` | 调用 Bot；用户为 null | null | 用户请求版本；Bot 为 null | expectedGeneration | Bot 请求令牌摘要；用户为 null |

以下仅为可公开的编码向量，不能用作真实令牌。令牌字节为 `00 01 … 1f`，`claimToken=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`。规范输入字节为下列单行文本，不含代码块换行：

```json
["daynight-assistant-claim/1","claim","11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333","44444444-4444-4444-8444-444444444444",null,"7","0","630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd"]
```

结果为 `5844a794f76443253acfeef7df9dd7b04929a37c3494def4f557dd8b33141048`。Go 与 CLI/Worker 的 codec 测试必须分别从请求字段和令牌字节构造此结果，不能仅对粘贴的规范字符串求摘要。

服务端收到重复操作 ID 时，先核对 owner、任务和指纹。完全相同则返回原回执与当前认领，不重复修改或续租；不同内容返回 409 `operation_conflict`。旧操作回执可供核对，但不能绕过当前权限或重新启用已失效的凭据。

| 拒绝 | HTTP / code | 含义 |
| --- | --- | --- |
| 输入格式错误 | 400 `invalid_input` | 不调用业务变更 |
| 无效用户凭据 | 401 | 沿用认证入口错误 |
| 非 owner 或 Bot 不属于用户 | 403 | 不返回他人的认领或操作数据 |
| 任务或当前作用域内操作不存在 | 404 | 不跨用户探测其他作用域 |
| 任务已删除 | 410 `task_deleted` | 不返回已删除材料或回执 |
| 版本不符 | 409 `version_conflict` | 保留原预期值，调用方重读后决定 |
| 有效认领阻止新认领 | 409 `claim_held` | 包括等待绑定的有效转交 |
| 令牌、holder、代次或有效期不符 | 409 `claim_lost` | 停止凭据保护的工作，不提交写入 |
| 操作 ID 对应其他内容 | 409 `operation_conflict` | 不替换原操作或重放新内容 |
| 提交结果未知 | 503 `claim_outcome_unknown` | 保留原身份并只读核对 |

## 未知结果与重启恢复

客户端在发送前保存操作 ID、令牌及完整请求意图，收到与请求身份一致的成功回执后才记录已提交。已派发请求的断连、取消或无效成功响应均可能发生在提交之后，不能被解释为回滚。

恢复只读取原 `operationId`。读到已提交回执后，核对其类型、任务、actor 与指纹；只有本地已保存的凭据绑定操作 ID、holder 和代次仍与 `currentClaim` 一致，且租约有效，才能继续使用凭据。成功绑定还要完成正常续约后才启动应用工作。

404 只表示该次读取未看见回执，可能原事务仍在执行；它不证明未提交，不授权自动重发或生成替代身份。读失败或结果仍不明确时保留待核对状态并停止新工作。认领已经过期、释放或转交时，原历史操作即使成功也不能恢复工作。客户端只在观察到当前状态满足正常认领条件、原操作已不可能授予有效认领后，按手册或用户的现有授权做新的认领决定。

所有成功认领操作回执保留到助手任务删除，不能在令牌仍可能被恢复时提前清除。任务删除后不再恢复认领。私有文件丢失不通过重新生成令牌隐式恢复；同一代次的凭据只绑定一次。

认领检查保护服务端写入的准入，不会撤回已经发给外部 Session 的消息。外部动作执行前检查当前认领；已发出的动作保留原操作身份，结果未知时继续原操作查询，不因转交而重发。接手者读取并继承这些事项记录。

## 验证职责

按[测试编写规则](../writing_tests.md)保留全部行为保证。Go API integration 运行真实服务、认证与独立 PostgreSQL 实例的正常顺序流程；拒绝、故障与竞争在其实际规则和机制所属层验证，不能因移出集成测试而删除断言。

| 保证 | 必需证明 |
| --- | --- |
| 创建、认领、续约、转交、目标绑定、手册操作、记录分页、事件确认、正常问答 | 正常 API integration 连续驱动相同资源，后续请求读回真实持久结果 |
| Bot 决定提案被拒、未注册应用规则被拒、越权、暂停与删除行为 | core 合成领域数据与窄 DAO mock 的规则证明；server 验证真实请求解析、状态码、错误数据及下层调用边界 |
| 两个 Bot 竞争只有一个成功，旧令牌失效，绑定不能被覆盖 | store 使用独立真实 PostgreSQL 实例、明确并发屏障与提交后读回；core 验证候选及预期条件 |
| 租约失效、锁等待跨越有效期、问答超时 | core 受控权威时间验证规则，store 验证真实时间读取、等待及写入拒绝，server 验证对应返回码 |
| 提交成功但响应丢失、回执与业务同事务、冲突和清理失败 | store 的真实事务证明，service 的完成语义与 HTTP 错误映射分别验证；CLI/Worker 的原操作核对使用受控响应 |
| 跨 Worker 转交及重启后使用原凭据 | Worker/CLI 的私有状态与真实文件生命周期测试；完整产品验收用两个独立 Worker 状态根证明接收、续约和旧持有者停止 |

服务端交付仍执行 `scripts/check.sh`、`scripts/startup-shutdown.sh` 和正常 `scripts/integration.sh`；覆盖率、race、隔离数据库和清理要求不降低。文档审查不能代替这些产品证明。

决策理由与被舍弃方案见[认领凭据决策](../../.agents/notes/implemented/architecture/2026-11-12-assistant-task-claim-contract.md)。
