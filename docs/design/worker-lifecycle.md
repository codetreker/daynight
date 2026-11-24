# Worker 生命周期设计

## 所有者和一致性

[需求](../spec/worker-lifecycle.md)定义持久停用、协议及结果语义。领域状态转换位于 `core/worker/lifecycle.go`，共享实体位于 `core/model/worker_lifecycle.go`，协议精确解析与请求摘要位于 `protocol/worker/lifecycle.go`。`core/store/worker_lifecycle.go` 定义数据库中立能力；SQL 位于 `postgres/worker/lifecycle.go`，独立事务作用域由 `postgres/lifecycle_scope.go` 提供。

生命周期不复用 configuration JSON 或 Task properties。配置导入、整包替换和旧协议投影各有独立规则，不能隐式覆盖停用。生命周期意图使用独立版本和操作账本，但与现有 Worker 准入复用同一行锁。

`service/worker/lifecycle.go` 协调认证、事务和领域操作；`server/worker/lifecycle.go` 适配 HTTP，限制请求大小与期限，保存既有错误 envelope 和 request ID。服务端只在事务提交得到确认后返回成功回执。未知完成结果保留安全错误及原操作查询路径，不把 callback 已产生回执当作提交证据。

## 持久数据

Worker 生命周期由三个子资源表持久化：

| 表 | 责任 |
|---|---|
| `worker_lifecycle` | 当前意图版本、desired/admission、当前意图 ID、管理实例 UUID、能力、bootstrap 消费事实和 reconnect 资格 |
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

新实例只撤销旧观察及服务端准入，不能替代旧进程停止证明。注册前 desired=enabled 且准入已开放或已有 reconnect 许可时保留该许可；新的意图和成功激活清除许可。本机状态从空库建立时也可以按服务端许可 reconnect。bootstrap 只允许没有意图历史且未消费的初始资源。

## Web 状态消费

Web 的 `api/worker-lifecycle.ts` 独立协商并严格解析生命周期 v1，不改变旧 Worker list/detail 的解析合同。读取和操作都校验响应 principal；账号作用域、Worker 身份、意图版本、管理实例 UUID 与报告序号共同限制结果发布。跨实例按服务端观察时间排序，同实例同意图内按报告序号排序。`useWorkerObservation` 保留后台检查期间的视图，并用服务端 `observedAt` 加浏览器 monotonic 时间推进时效。生命周期读取在请求开始前记录时间锚，将整个请求耗时保守计入观察年龄，响应传输不能延长停止证明的有效期。稳定时每 30 秒读取；未知原操作、正在停用或恢复、尚待本机观察的新意图每 2 秒核对。隐藏页面停止轮询。

`useWorkerLifecycle` 在同一账号作用域内共享原操作记录和提交互斥。派发前先在同源 `sessionStorage` 保存 service origin、账号、Worker、原精确请求和域分隔 SHA-256 摘要。无法保存时不派发新意图，保留内存请求供核对；存储读取失败或记录损坏时禁止新操作。显式核对可以重新读取恢复后的存储。刷新只查询原 operationId；GET 404 后使用原请求 resolve，核实回执的 Worker、操作、阶段和摘要。查询与 resolve 都不重放业务请求，未知结果不能更换 ID 猜测成功。账号作用域结束时清理其恢复记录；退出账号也按账号前缀清理当前页面从未挂载过的 Worker 记录，失败沿账号私有状态清理提示及显式重试入口处理。

卡片提供摘要和确认入口，详情拥有停止接收、停止执行、关键保存、同步四阶段及逐资源恢复资格。当前安全停止结论要求同实例、同意图、同操作的新鲜完整聚合停证和关键保存证明，且 desired=disabled、admission=closed，observation.errorCode 只能为 null 或 upload_failed；上传失败不推翻本地停止和持久保存证明。恢复资格与此展示结论分别判断，并由提交和面板共享同一事实函数：准入关闭且有当前新鲜完整的 disabled 观察时，错误码除 null 和 upload_failed 外仅额外允许 resume_interrupted；该例外不产生安全重启结论，其他 observation.errorCode 即使聚合计数完整也同时阻止安全结论和恢复资格。满足恢复条件时，即使 desired=enabled，也允许用户再次显式恢复中断的握手；该状态显示为受阻，不显示为持续恢复中或可重启计算机。明细只传前缀不推翻完整聚合证明；库存未知不能显示为零。恢复请求一旦建立，旧的 disabled 观察不再产生当前安全结论；受理与 activation 均不替代本机 accepting 的新鲜观察。上传失败与本地停止分开，个别会话恢复受阻与 Worker 接受合格工作分开。

确认面板复用共享对话框的焦点约束、Escape 和返回焦点机制，保留机器、别名、Worker、报告时间及已观察范围。Task 数量不作为资源总数；无 Bot 总数时显示未知。面板说明助手租约风险、独立暂停保留和同机其他 Worker 的隔离范围。中英文使用等价保证和共享字号；控件保留至少 44px 触控高度。

## 验证责任

协议测试验证必填 null、判别联合、规范 ID/精确 int64、未知字段、完整聚合条件、明细限制和确定摘要。领域测试验证所有状态转换、幂等、墓碑、观察时效及实例 ID 不匹配拒绝。service 验证当前凭据、事务绑定、锁后时间与 Completion；HTTP 验证真实路由、解析、错误码、取消和响应失败。

真实隔离 PostgreSQL 验证迁移、持久化、行锁竞争、首次缺行、CAS、rollback、取消、跨连接重读以及原请求和 resolve 两种提交顺序。正常 API 集成贯穿注册、停用、观察、恢复和激活。平台本机停止证明和 UI 行为不由服务端单元测试代替。

Web 模块通过受控 API 验证严格解析、原操作恢复、未知结果、版本竞争、撤权及各阶段事实映射。独立 frontend-only 浏览器验证真实产品组件的窄屏、双语、放大文本、键盘焦点、后台草稿和滚动连续性。Web 验证不启动 Go 或 PostgreSQL，也不代替真实跨端与平台停止验收。

[独立生命周期决策](../../.agents/notes/implemented/architecture/2026-11-20-worker-lifecycle-authority.md)保存替代方案和成本。
