# Worker PR review 参与设置

## 目标与资源

认证账号可以独立读取和修改自己 Worker 的 PR review 参与设置。默认关闭，
读取和修改不要求 Worker 在线，也不受 Worker 列表最近 72 小时窗口限制。
本资源保存 Reviewer 候选所需的参与意愿；[自动分配和归属读取](pr-review-assignment.md)
使用该设置，review 执行由独立机制负责。

| 方法 | 路径 | 请求或响应 |
|---|---|---|
| GET、HEAD | `/api/v1/me/workers/{workerId}/review-participation` | `{"enabled":false,"version":"1"}` |
| PUT | 同一路径 | 请求 `{"enabled":true,"expectedVersion":"1"}`，响应 `{"enabled":true,"version":"2"}` |

Worker ID 使用现有规范 UUID 规则。认证沿用 PAT、浏览器会话与 Cookie 写入的
Origin 校验；成功响应采用 `Cache-Control: no-store` 和认证账号响应头。
请求不接受查询参数。PUT 必须是受限 JSON 对象，两个字段均必填；`enabled`
必须是布尔，`expectedVersion` 必须是规范的正十进制 int64 字符串。未知、重复、
缺失、null、错误类型、越界版本和尾随 JSON 均按现有规则拒绝为 `400 invalid_input`。
未支持方法返回带 `Allow: GET, HEAD, PUT` 的 405。

## 所有权、版本与失败

资源键为认证 principal 的账号 ID 与 Worker ID。不存在和属于其他账号的 Worker
统一返回 `404 not_found`，不泄露开关或版本。每次 PUT 都检查实际观察版本，
包括同值写；过期版本返回 `409 version_conflict`。版本匹配的同值写保持版本，
真实变化递增一次。版本达到 `9223372036854775807` 时，同值写仍可成功，
状态变化返回版本冲突并保留原值。

读取在同一个只读快照中完成。写入在独立 Worker 事务中读取账号所属资源、
由 core 计算新状态，再由 DAO 按账号、Worker ID 和预期版本条件更新。
同值写也执行条件更新，防止读取后发生的并发修改被误报为成功。
事务提交未确认时遵守现有 Worker 写入错误规则，调用者不得自动重放未知结果。

## 存储与协议共存

迁移 `094_worker_review_participation.sql` 为 `workers` 增加
`review_enabled boolean NOT NULL DEFAULT false` 和
`review_version bigint NOT NULL DEFAULT 1`。既有行和新登记 Worker 均从关闭、
版本 1 开始。迁移与 schema snapshot 维护沿用[服务端维护入口](../../packages/daynight-server/README.md#schema-snapshot-maintenance)。

参与设置 DAO 仅更新上述两列，不修改目标配置版本、应用观测、最后上报时间、
telemetry、别名或 Task claim。注册、心跳、配置和领取继续保有原字段写入所有权。
现有 Worker 列表、详情、上报和配置 JSON 不增加参与字段，也不增加协商头；
已有客户端继续使用各自协议，新消费者单独调用本资源。

HTTP 层负责认证接入、严格输入、响应投影与错误映射；`core/worker` 负责所有权、
版本与状态变化；`service/worker` 组织快照和事务；`core/store` 声明独立的
`WorkerReviewParticipationReader`、`WorkerReviewParticipationWriter`，由 PostgreSQL
Worker DAO 实现。候选对账在自己的事务作用域中读取并重新检查这些设置。

## 验证职责

core 验证身份、版本、同值、上限和错误传播；service 验证绑定的 DAO、事务完成与
结果抑制；HTTP 验证真实路由、严格正文、方法、响应和错误映射。真实 PostgreSQL
测试验证既有库迁移、新行默认值、持久读回、账号隔离、并发 CAS，以及设置、
报告和配置互不覆盖。正常 API 集成顺序驱动真实服务开启、读回、报告、配置与关闭。
版本共存验收将候选服务响应交给固定旧客户端解析器读取。

独立版本和增量资源的取舍见[决策记录](../../.agents/notes/implemented/feature/2026-11-19-worker-review-participation.md)。
