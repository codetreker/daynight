# 助手定义与管理

## 当前范围

Bot 是当前用户拥有、绑定已有 Worker 的独立定义，不属于项目，也不生成 Task、claim 或 worktree。当前实现提供名字创建的默认解析、幂等定义存储、查询和删除意图，以及供生命周期事务调用的成功偏好提交方法；尚不提供原生执行、Session 绑定、历史清理或助手页面入口。创建成功只表示定义已持久化，启动状态为 `pending`。

公开 `POST /api/v1/me/bots` 接受调用方先生成的 ID 和名字，可选显式 Worker、目录和 Provider；服务端解析并冻结配置。不能通过管理接口传入 model、args 或 resolvedConfiguration。Worker 的实际目录访问与 CLI/Provider 启动仍需执行前预检，服务端接受普通绝对目录不证明其存在。

## 定义与身份

- Bot ID 由调用方在提交前生成。名字去除首尾空白后须为 1–40 个 Unicode 字符，拒绝控制字符及非良构 Unicode。
- 所属用户来自当前有效登录或 PAT。托管身份为 `(owner_user_id, worker_id)`；另一用户可以拥有同 UUID 的 Worker，但不能因此访问当前用户的 Bot。
- 保存显式覆盖项和首次解析得到的 Worker、绝对目录、Provider、model、args。覆盖项省略与显式输入保持区别；后续默认变化不改写已有配置。
- `version` 和 `creationOrder` 为正 int64；HTTP 使用十进制字符串，不能经浮点数转换。时间为 UTC RFC3339。
- 尚未登记时 `roleConfiguration` 和 `sessionId` 为 null。`startupResult.state=pending` 不证明原生进程已启动或 Worker 当前在线。

## 默认值与成功偏好

Worker 按显式选择、最近成功显式 Worker、首次登记时间与 Worker ID 的稳定顺序解析。自动候选必须有新鲜的托管报告及可用的目标 Provider；不能默认写死某个 Provider，也不能偷偷把失败的 Provider 替换成另一种。显式 Worker 不可用时直接返回原因，不换机；自动候选可以跳过不可用 Worker。

目录和 Provider 分别采用当前请求显式值、该 Worker 最近成功的显式偏好、该 Worker 报告默认值。model 与 args 只来自选中 Worker 的选中 Provider 报告；切机器或 Provider 不继承另一组参数。目录须符合目标平台的绝对路径规则，不由服务端创建或检查本机同名目录。

托管观测使用服务端时间：最近报告与 assistantHost.observedAt 均须不在未来且年龄严格小于 120 秒。旧 Worker 为 unsupported；报告失联为 offline；探测过期为 stale；全部 Provider 失败为 unavailable。目标 Provider 单独失败时保留具体原因。defaults 只提供观察，不预留资源或承诺未来启动成功。

读取默认值、取消未提交的表单、创建 pending 定义和启动 failed 均不提交偏好。只有生命周期事务验证绑定 Worker、当前 native Session 身份与同步事实、持久化 ready 后，才可调用内部成功提交方法；没有公开的“保存成功”管理入口。用户 Worker 偏好及每 Worker 的目录、Provider 偏好各自保存服务端 creation_order 水位；旧创建晚成功不能覆盖新成功显式选择，没有显式选择的字段不重写偏好。配置和偏好失败时与同一生命周期事务一起回滚。

## 创建幂等性

创建内核以规范化名字和显式覆盖项计算请求指纹。同一用户以相同 ID 和指纹重放时返回原定义及其冻结配置；重新解析的默认值不构成另一次创建。相同 ID 的不同指纹返回冲突；另一用户不能接管该 ID。失败的数据库事务不留下部分定义。

提交结果未知时，调用方按原 ID 查询并核对，不能自动生成新 ID 重试。已标记删除的 ID 不复活，也不能用重复创建移除清理责任。

## HTTP 管理契约

所有接口使用现有登录/PAT、浏览器写入 Origin 校验、`no-store` 和 `Daynight-User-ID` 响应身份。没有项目参数。分页采用现有 `limit`（1–100）和 `cursor`，游标绑定用户及普通/Worker 清单范围。

| 方法与路径 | 结果 |
|---|---|
| `GET /api/v1/me/bots` | `{items,nextCursor}`，按创建时间及 ID 稳定排序，排除删除意图 |
| `GET /api/v1/me/bots/defaults` | 可选唯一 `workerId`；返回当前用户候选、选中配置或不可用原因，不写偏好 |
| `POST /api/v1/me/bots` | `{id,name,overrides?}`，overrides 只允许 workerId/cwd/provider；200 返回原始或新建定义的真实状态 |
| `GET /api/v1/me/bots/{id}` | 未删除时返回定义；删除后仅返回 ID、Worker ID、版本及删除责任 |
| `GET /api/v1/me/workers/{workerId}/bots` | 当前用户该 Worker 的定义和未完成清理责任；普通列表隐藏不移除 Worker 责任 |
| `DELETE /api/v1/me/bots/{id}` | 请求 `{ifVersion,deletionId}`；`ifVersion` 为正 int64 十进制字符串，`deletionId` 为 UUID；返回真实删除意图 |

defaults 响应为 `{observedAt,workerId,configuration,reason,workers}`。未找到可用自动候选时 workerId/configuration 为 null、reason 为 no_available_worker；显式不可用 Worker 保留 workerId，configuration 为 null 并提供原因。workers 按稳定顺序列出当前用户已登记 Worker，包含 workerId、machine、platform、state、reason、configuration 与 providers；离线记录也能解释显式选择失败，不输出任务库存。state 表示主机观测，configuration/reason 表示该机器目标配置是否可用；providers 不取代新鲜度判断。reason 包括上述主机状态、invalid_cwd、provider_unavailable 或带 provider_ 前缀的预检原因。所有可空字段显式为 null，数组为空时为 []。

创建与默认查询拒绝未知/重复字段、非法 query 和 null 覆盖项。显式 Worker 不属于当前用户时为 403；新创建无可用配置时为 409 resource_conflict，信息包含失败原因。同 ID 重放先核对持久定义，不因后来 Worker 离线或默认变化而再次解析。

定义响应包括 `id`、`ownerUserId`、`workerId`、`name`、`version`、`creationOrder`、`requestedOverrides`、`resolvedConfiguration`、`roleConfiguration`、`sessionId`、`startupResult`、`deletion`、`createdAt` 和 `updatedAt`。内部请求指纹不向 HTTP 输出。

删除责任包含 `deletionId`、原 `requestedVersion`、`workerCleanup` 和 `serverCleanup`。两个清理结果分别包含 `state` 和可空 `code`。本阶段两者均为 `pending`，不返回伪造的 completed。删除后的 HTTP 响应不含名字、启动配置、角色或 Session 内容。

无效输入为 400，未认证或失效凭据为 401，非 owner 或不属于当前用户的 Worker 为 403，不存在的 Bot 为 404，版本或幂等请求冲突为 409。读库失败保持错误，不转换为空列表。

## 删除意图

删除在当前版本保护下原子记录意图并递增版本；从普通列表隐藏，保留精确的删除 ID 和原请求版本。相同删除 ID 与原版本重放返回已存结果，不再递增版本；不同请求发生冲突，不能据此盲重试。

删除意图不停止原生进程、不删除历史、不清理 cwd 或 native home，也不修改任何独立任务。当前内核拒绝删除已绑定 Session 的定义；在提供 Bot → Session 原子删除屏障前，不允许利用这条路径绕过会话授权。隐藏定义不能作为清理已完成的证据。

## 验证要求

真实隔离 PostgreSQL 测试覆盖名字创建、稳定候选、显式离线拒绝、跨机器和 Provider 参数隔离、默认观测时效、反序成功偏好、失败不提交、偏好事务回滚、并发重复 ID、不同指纹、组合 Worker 归属、失效凭据、事务回滚、分页、精确 int64、删除重放和任务不变。HTTP 测试覆盖认证、严格请求解析和删除后响应隐藏。完整服务端检查使用 [服务端验证命令](../../packages/daynight-server/README.md)，包含 race 与覆盖率门禁。这些检查不证明真实 Provider、Worker 托管或完整助手交互已交付。
