# Worker 服务端生命周期设计

## 所有者和一致性

[需求](../spec/worker-lifecycle.md)定义持久停用、协议及结果语义。领域状态转换位于 `core/worker/lifecycle.go`，共享实体位于 `core/model/worker_lifecycle.go`，协议精确解析与请求摘要位于 `protocol/worker/lifecycle.go`。`core/store/worker_lifecycle.go` 定义数据库中立能力；SQL 位于 `postgres/worker/lifecycle.go`，独立事务作用域由 `postgres/lifecycle_scope.go` 提供。

生命周期不复用 configuration JSON 或 Task properties。配置导入、整包替换和旧协议投影各有独立规则，不能隐式覆盖停用。生命周期意图使用独立版本和操作账本，但与现有 Worker 准入复用同一行锁。

`service/worker/lifecycle.go` 协调认证、事务和领域操作；`server/worker/lifecycle.go` 适配 HTTP，限制请求大小与期限，保存既有错误 envelope 和 request ID。服务端只在事务提交得到确认后返回成功回执。未知完成结果保留安全错误及原操作查询路径，不把 callback 已产生回执当作提交证据。

## 持久数据

迁移 110 创建三个 Worker 子资源表，并同步 schema 快照：

| 表 | 责任 |
|---|---|
| `worker_lifecycle` | 当前意图版本、desired/admission、当前意图 ID、管理实例 epoch、能力、bootstrap 消费事实和 reconnect 资格 |
| `worker_lifecycle_operations` | 原请求及域分隔摘要、原回执、当前意图应用状态、activation 子阶段和未提交墓碑 |
| `worker_lifecycle_observations` | 当前完整合法观察包、实例/意图/本地/scope/报告序号与服务端接收时间 |

生命周期状态的枚举、正版本、哈希长度以及 disabled 不能 open 由该持久合同的数据库约束保护。外键归原 `(user_id,worker_id)`，删除沿 Worker 的既有授权。没有行的旧 Worker 保持旧行为；注册前必须由原首报流程创建 Worker，不能借生命周期注册绕过 Worker owner admission。

操作请求身份不能被更新为另一个请求。意图的应用状态可以从 accepted 变为 applied、blocked 或 superseded，而受理时版本、门禁和时间保持原义。内部注册和激活保存其真实原回执，不能根据当前状态重建历史成功。

## 事务与锁顺序

写事务沿当前凭据授权锁取得身份，再锁目标 Worker。锁定后读取数据库时间并检查观察时效，避免等待 Worker 锁期间使旧 ready 事实获得过时的激活许可。领域函数可以在同一事务中重入 Worker 锁；不会创建独立提交。

Task claim 保持 Project/Task 原锁顺序，在业务写入之前取得 Worker 锁并读取门禁。首次缺 Worker 行沿原 owner admission 锁重读，防止首报竞争绕过准入。

Session 按原业务作用域锁定归属。Task Session 使用原 Worker 身份；Bot Session 从同事务锁定的 Bot 当前承载或恢复记录得到 Worker。`session_operations.worker_id` 和 `worker_intent_version` 保存接受时的 Worker 身份及云端意图版本；派发前两者都必须与当前归属相等，防止 Bot 更换宿主时相同版本数值误放行。旧 null 记录仅在 Worker 尚无生命周期资源时可用，首次注册后保守拒绝，避免停用后恢复隐式重送旧输入。独立非 Worker Test Session 保持原行为。新输入、accepted 到 offered、offered 到 dispatching 各自检查；原 ID 结果查询优先，不会因关闭门禁失去核对能力。

Bot 保持 credential、Bot、Session 再 Worker 的顺序。需要 Worker 互斥准入时直接取得最终锁级别，避免两个恢复事务先持 SHARE 再升级 UPDATE 的死锁。管理报告和停止授权不通过统一的业务禁用开关。同承载、同执行的 reconnect 续期保留全部身份与凭据校验，不因停用拒绝；新承载、bootstrap 或执行代际推进检查目标 Worker。takeover 的 Session grant 使用同一事务内已验证的目标 Worker 身份，不能从尚未推进的旧 Bot 承载记录反推准入对象。旧 Worker 保持关闭也可完成合法迁移，最终的 Bot 承载变更和 Session grant 共同提交。

生命周期写事务不反向锁 Task、Bot 或 Session，也不等待网络或本机进程停止，因此不会与既有业务锁形成反向环。业务先提交的 claim/指令身份不会被停用删除；本机必须把它们纳入完整停止责任。

## 原操作核对

业务写与 resolve 争夺同一 Worker 行锁。业务先提交时 resolve 返回保存的真实回执。resolve 先提交时插入不可执行的墓碑，业务随后发现墓碑并拒绝。锁等待或 commit 未知均保留 unknown，不能当作回滚。

普通 activation 是 resume 意图的子阶段。账本分别保存 `request_hash` 和 `activation_hash`，以及 `activation_outcome`。原意图存在但 activation 尚无记录时，resolve 只关闭 activation；保留原意图及精确激活请求，防止迟到请求重新开门。

新实例只撤销旧观察及服务端准入，不能替代旧进程停止证明。注册前 admission=open 且 desired=enabled 时保存 reconnect 资格；停用或恢复意图清除此资格。bootstrap 只允许没有意图历史且未消费的初始资源。

## 验证责任

协议测试验证必填 null、判别联合、规范 ID/精确 int64、未知字段、完整聚合条件、明细限制和确定摘要。领域测试验证所有状态转换、幂等、墓碑、观察时效及 epoch 拒绝。service 验证当前凭据、事务绑定、锁后时间与 Completion；HTTP 验证真实路由、解析、错误码、取消和响应失败。

真实隔离 PostgreSQL 验证迁移、持久化、行锁竞争、首次缺行、CAS、rollback、取消、跨连接重读以及原请求和 resolve 两种提交顺序。正常 API 集成贯穿注册、停用、观察、恢复和激活。平台本机停止证明和 UI 行为不由服务端单元测试代替。

[独立生命周期决策](../../.agents/notes/implemented/architecture/2026-11-20-worker-lifecycle-authority.md)保存替代方案和成本。
