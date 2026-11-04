# 助手定义的存储与管理

[需求规格](../spec/assistant.md)拥有当前支持的行为。实现分为 `core.Bot`、PostgreSQL store、`service.Bots` 和 HTTP 投影；不借用项目或 Task 生命周期。

## 数据拥有者

追加迁移 `033_bots.sql` 创建 `bots`。主键为调用方生成的 UUID；`owner_user_id` 引用用户，`(owner_user_id,worker_id)` 引用现有 Worker 组合主键。数据库 identity 生成独立 `creation_order`，它允许后续按服务端创建顺序提交偏好，不依赖用户时钟或请求结束时间。

`requested_overrides` 保留显式输入，`resolved_configuration` 保存解析后的固定启动配置。两者不合并：默认值变化不能修改原请求身份。`request_fingerprint` 为规范化请求的 SHA-256，不包含可变的解析结果。名字和覆盖项先验证，再形成指纹；原始空白不产生额外定义。

`role_configuration`、`session_id` 预留为空；本模块不登记独立 Session。启动结果仅初始化为 pending。删除责任独立于启动配置，保存原删除 ID、请求版本及 Worker/服务端两方清理状态。

## 创建事务

`service.Bots.Create` 是已解析配置的内部入口。验证当前 principal 和输入后，通过 `Store.WriteBot` 在 ReadCommitted 事务中校验凭据、既有 ID 和 Worker 归属。凭据共享锁保护写入期间的撤销交错，并在等待后检查自然过期。

插入使用 `ON CONFLICT(id) DO NOTHING`。冲突后用独立 SQL 语句读取并锁定原行，才能观察另一个事务刚提交的结果；不能用同一语句的快照兜底假定一定可见。相同 owner/指纹返回原行；不同请求冲突，删除中的行不恢复。数据库错误保留 `store.Error` 和事务结果信息，不将未知提交解释成回滚。

后续默认解析消费者应先按原 ID 核对已提交请求，再决定是否需要重新解析。冻结结果来自首次创建，不随相同请求的重放变化。当前内部入口只检查配置的格式和归属，不承诺 Worker 在线、目录存在或 Provider 实际可启动。

## 查询与授权

查询使用现有 snapshot 和分页游标，范围包含当前用户及可选 Worker ID。普通列表过滤所有删除意图；Worker 清单保留任一清理阶段尚未完成的行。排序为 `(created_at,id)`；`creation_order` 另用于比较创建先后，不用作当前分页游标。

`Get` 先确定资源是否存在，再验证 owner。Worker 清单检查组合身份，不以 Worker UUID 推导跨用户权限。服务层重新核对持久凭据；HTTP 外层继续使用现有 Authentication middleware，保留浏览器 Origin 检查和 PAT 生命周期。

HTTP DTO 将版本及创建序号编码为字符串。删除后整体省略 `BotDefinition`，仅保留最小责任，避免单独漏删某个配置或角色字段。内部数据库对象不直接序列化为管理响应。

## 删除边界

删除事务先锁 Bot，核对 owner、原请求身份和当前版本，再存入删除责任。精确重复请求返回原结果；新的删除请求不能覆盖已有责任。达到 int64 上限时拒绝版本递增。

当前仅支持未绑定 Session 的删除意图，两个清理阶段均保持 pending。已绑定 Session 必须拒绝，直到会话模块能在同一事务按 Bot → Session → archive metadata 的顺序冻结所有新读写。禁止在本模块新增先锁 Session 再反向锁 Bot 的入口。实际进程停证、SQL/归档删除及 Worker 私有资料清理由各自生命周期实现接入，不能由列表隐藏推断。

Bot 表不保存 Task 关系，删除操作没有 Task 更新 SQL。普通目录、共享 native home、Task worktree 和其它任务均不属于定义删除的副作用。

## 扩展约束

公开创建必须消费已确认的默认解析机制，不能临时要求用户填写全部内部配置作为替代。Session 绑定必须原子冻结角色与稳定会话身份；历史清理必须扩展删除事务并保留重复请求对账能力。当前不注册公开 create、Provider 启动或 UI 入口，避免将定义内核暴露为完整托管功能。

详细取舍见[管理定义决策](../../.agents/notes/implemented/architecture/2026-11-04-bot-definition-storage.md)。
