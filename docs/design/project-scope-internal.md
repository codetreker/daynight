# Project 管理的凭据 Scope 准入

[凭据 Scope 内部合同](credential-scope-internal.md)定义共享的权限目录和授权事实。

`service/project` 的 scoped 入口显式接收凭据授权，与原有 Project、成员和
邀请操作共用业务实现。项目可见性和适用的角色检查先于 scope 拒绝，受限
预览与写入在对应准入之后执行。生产 REST 和 MCP 使用 scoped 接入；请求使用认证时取得的策略快照，
不将策略保存在 Principal 中。

项目读取与成员名单需要 `project:read`，普通创建和设置需要
`project:write`；原有完整写响应还需要 `project:read`。按 Team 筛选项目
另需 `team:read` 和 Team 可见性。仓库切换及其预览需要
`project:repository`；转移预览需要 `project:transfer`，返回既有访问
数据的完整转移回执还需 `project:read`。删除需要 `project:delete`，删除
预览还需要 `task:read`、`attachment:read` 和 `worker:read`，以保护其中的
任务、附件与 Worker 投影。

成员管理与候选查找需要 `project:members`，包含现有成员和访问数据的完整
写响应还需要 `project:read`。已发邀请管理需要 `project:invitations`；
收到邀请的检查和接受分别需要 `project:invitation-read` 和
`project:invitation-accept`，完整响应中的现有访问数据还需要
`project:read`。内部最小邀请视图和接受回执不返回这些访问数据。
成员候选查找在原快照内重新取得当前凭据授权，直接添加成员在原事务中的
两次凭据复核点重新取得授权；缺少对应事务绑定读取能力时拒绝 scoped
调用。版本、角色、凭据有效性和事务完成语义继续适用。

联合装配必须将请求授权提供器绑定到同一次认证的凭据事实，并为需要复核的
操作提供同一快照或事务内针对原 Principal 的权威读取；`ScopeProtected` 等
构造状态标记不能证明提供器的身份绑定或读取来源。只读快照的策略读取不能
使用要求行锁的写事务接口。生产装配为这些边界提供对应的当前凭据读取能力。

决策及权衡见 [Project 准入记录](../../.agents/notes/implemented/architecture/2026-11-20-project-scope-admission.md)。
