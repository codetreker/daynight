# 助手定义的存储与管理

[需求规格](../spec/assistant.md)拥有当前支持的行为。实现分为 `core.Bot`、PostgreSQL store、`service.Bots` 和 HTTP 投影；不借用项目或 Task 生命周期。

## 数据拥有者

追加迁移 `033_bots.sql` 创建 `bots`。主键为调用方生成的 UUID；`owner_user_id` 引用用户，`(owner_user_id,worker_id)` 引用现有 Worker 组合主键。数据库 identity 生成独立 `creation_order`，它用于按服务端创建顺序提交偏好，不依赖用户时钟或请求结束时间。

`requested_overrides` 保留显式输入，`resolved_configuration` 保存解析后的固定启动配置。两者不合并：默认值变化不能修改原请求身份。`request_fingerprint` 为规范化请求的 SHA-256，不包含可变的解析结果。名字和覆盖项先验证，再形成指纹；原始空白不产生额外定义。

`role_configuration`、`session_id` 预留为空；本模块不登记独立 Session。创建时启动结果仅初始化为 pending。删除责任独立于启动配置，保存原删除 ID、请求版本及 Worker/服务端两方清理状态。

## 创建事务

`service.Bots.CreateResolved` 是公开创建使用的默认解析入口；`service.Bots.Create` 保留已解析配置的内部入口，两者共享创建事务。验证当前 principal 和输入后，通过 `Store.WriteBot` 在 ReadCommitted 事务中校验凭据、既有 ID 和 Worker 归属。凭据共享锁保护写入期间的撤销交错，并在等待后检查自然过期。

首次读取前取得按规范化 Bot ID 命名的事务 advisory lock，串行化同一 ID 的查回与默认解析；否则两个初次读取都为空时，后到的环境失败可能掩盖另一请求已经提交的结果。锁也覆盖已解析内部创建入口，与后续 Bot 行锁保持一致顺序。哈希碰撞只会增加等待，不改变归属或请求身份。插入仍使用 `ON CONFLICT(id) DO NOTHING`。冲突后用独立 SQL 语句读取并锁定原行，才能观察另一个事务刚提交的结果；不能用同一语句的快照兜底假定一定可见。相同 owner/指纹返回原行；不同请求冲突，删除中的行不恢复。数据库错误保留 `store.Error` 和事务结果信息，不将未知提交解释成回滚。

默认解析在事务确认 ID 尚不存在后执行；原请求重放直接返回冻结结果，不依赖当前 Worker 可用性。冻结配置的格式和组合归属在插入前再次校验。HTTP 创建只接受名字与显式覆盖，不开放已解析配置内核；内部已解析入口只检查格式和归属。

## 默认解析与偏好事务

`service/bot_defaults.go` 统一 defaults 预览与首次创建的解析规则。`Snapshot.BotDefaults` 在读取快照中提供服务端时间、Owner Worker 列表与偏好；`BotTx.BotDefaults` 在原创建事务中读取同样的数据。默认解析的时效判断时间在 Worker 与偏好读取后由数据库取得，避免 ReadCommitted 的新心跳晚于先前时间而被误判为未来；该时间只用于时效判断，不代表跨多次 SQL 的快照边界。列表按 `(created_at,worker_id)` 排序，不套用普通 Worker 列表的 72 小时隐藏或 Task 库存投影，因此过期的显式 Worker 仍能返回具体不可用原因。

解析先处理显式 Worker；没有显式 Worker 时尝试成功 Worker 偏好，再按稳定顺序选择可用配置。每个候选先经过 `WorkerAssistantHostState` 的托管版本、在线及观测时效检查，再为该机器选择目录与 Provider。每项使用显式值、该 Worker 偏好、报告默认的顺序。只读取目标 Provider 的 model/args。失败目标保留原因，不在同一 Worker 上另猜一个 Provider。目录按 Worker 平台验证；真实文件系统与启动预检由绑定 Worker 负责。

迁移 `035_bot_defaults.sql` 增加 `bot_worker_preferences` 和 `bot_configuration_preferences`。前者按用户保存最近成功显式 Worker；后者按用户与 Worker 保存目录和 Provider，各字段独立记录 creation_order。只选择 Provider 的新成功创建不能阻止另一请求的目录偏好首次提交；同时旧 Provider 选择也不能覆盖新成功 Provider。每个字段使用条件 upsert，不依赖 HTTP 完成时间或 Worker 时钟。

`store.CommitBotPreferences(ctx, pgx.Tx, botID)` 加入调用方已有事务，不自行开启或提交。它重新读取持久 Bot，要求未删除、已绑定 Session 且 startupResult 为 ready，只提交持久显式项对应的冻结值。生命周期调用方必须先按 Bot → Session 锁序验证凭据、绑定 Worker、当前 native fence 与同步事实，再同事务持久化 ready 并调用该方法。该内部方法的 ready 检查不替代 native 同步验证；尚无公开 register/report 入口。数据库故障回滚整个事务，不留部分偏好。重放以原 creation_order 为条件，无额外写入效果。

默认查询无写入副作用；创建只写 pending Bot。后续生命周期接入无需把偏好变成独立的客户端确认请求，也不能在 spawn 回执或表单提交后提前调用成功方法。

## 查询与授权

查询使用现有 snapshot 和分页游标，范围包含当前用户及可选 Worker ID。普通列表过滤所有删除意图；Worker 清单保留任一清理阶段尚未完成的行。排序为 `(created_at,id)`；`creation_order` 另用于比较创建先后，不用作当前分页游标。

`Get` 先确定资源是否存在，再验证 owner。Worker 清单检查组合身份，不以 Worker UUID 推导跨用户权限。服务层重新核对持久凭据；HTTP 外层继续使用现有 Authentication middleware，保留浏览器 Origin 检查和 PAT 生命周期。

HTTP DTO 将版本及创建序号编码为字符串。删除后整体省略 `BotDefinition`，仅保留最小责任，避免单独漏删某个配置或角色字段。内部数据库对象不直接序列化为管理响应。

## 删除边界

删除事务先锁 Bot，核对 owner、原请求身份和当前版本，再存入删除责任。精确重复请求返回原结果；新的删除请求不能覆盖已有责任。达到 int64 上限时拒绝版本递增。

当前仅支持未绑定 Session 的删除意图，两个清理阶段均保持 pending。已绑定 Session 必须拒绝，直到会话模块能在同一事务按 Bot → Session → archive metadata 的顺序冻结所有新读写。禁止在本模块新增先锁 Session 再反向锁 Bot 的入口。实际进程停证、SQL/归档删除及 Worker 私有资料清理由各自生命周期实现接入，不能由列表隐藏推断。

Bot 表不保存 Task 关系，删除操作没有 Task 更新 SQL。普通目录、共享 native home、Task worktree 和其它任务均不属于定义删除的副作用。

## 扩展约束

公开创建消费默认解析机制，未组合托管能力前不启用完整助手 UI 入口。Session 绑定必须原子冻结角色与稳定会话身份；历史清理必须扩展删除事务并保留重复请求对账能力。Provider 启动、Session 登记、成功报告与 UI 入口仍由对应生命周期消费者接入；公开创建返回 pending 不表示完整托管功能可用。

默认与偏好取舍见[默认解析决策](../../.agents/notes/implemented/architecture/2026-11-04-bot-default-resolution.md)。管理定义取舍见[管理定义决策](../../.agents/notes/implemented/architecture/2026-11-04-bot-definition-storage.md)。
