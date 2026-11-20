# 凭据 Scope 内部合同

## 目录与授权事实

`internal/core/scopepolicy` 定义稳定的业务 Scope ID、有序展示组、文案键、
PAT 与 MCP grant 的适用性以及操作所需的权限。目录返回独立副本；选择必须
是非空、适用且不重复的明确 ID 集合，规范化后按 ID 排序。目录按当前可用项
计算默认值：Team 仅选 `team:read`，MCP 不选择 Worker 执行组；Agent 执行
许可是独立组。已保存的权限不随目录增长而变化。

策略快照保留凭据类型、规范化集合和正版本。读取非法或非规范集合时必须
拒绝，组合操作需要全部权限；空策略不能代表无限权限。Principal 仍仅表示
用户与凭据身份，策略快照与可持久化 actor 分离。固定 OAuth 等原有 profile
继续由其原有绑定及授权规则处理，不能把缺失的受限策略解释为固定授权。
Scope 检查与现有凭据有效性、资源访问、角色和业务条件共同生效。

## Tag 目录准入

`service/tag.NewScoped` 提供显式接收 `model.CredentialAuthorization` 的目录
操作，复用原有项目快照和写事务。`core/tag.RequireAuthorization` 校验 profile
与共享操作要求；项目可见性和原有写入角色通过后，在读取 Tag 数据、用量、
目录 epoch 或修改关联前检查 scope。缺失或不匹配的策略明确失败。

| 操作 | 所需 scope | 响应 |
| --- | --- | --- |
| Get、List、Resolve、ResolveColors | `tag:read` | 原有目录、引用、颜色及用量投影 |
| Create、Update、Rename | `tag:write` 与 `tag:read` | 原有完整 Tag 投影 |
| Delete | `tag:delete` | 原有 projectId、tagId、deleted 最小回执 |

REST 的目录 `GET /api/v1/projects/{projectId}/tags`、单项
`GET /api/v1/projects/{projectId}/tags/{tagId}` 及其自动 HEAD、
`POST /api/v1/projects/{projectId}/tags/resolve`、
`POST /api/v1/projects/{projectId}/tags/colors/resolve` 对应读取。
目录 POST 与单项 PATCH 对应写入，单项 DELETE 对应删除。
方法回退保留认证与原有 405 响应，不执行目录业务。
MCP 的 `tag_list`、`tag_show` 对应读取，`tag_create`、`tag_rename`、
`tag_update` 对应写入，`tag_delete` 对应删除；工具发现和 schema 保持原合同。

完整写回执包含用量或未修改字段，因此必须在写入前同时通过读取准入。
不具备要求的组合权限时，整个操作拒绝，不读取目录内容，不修改 Tag、
关联、关联条目版本或目录 epoch。同值更新仍经过准入和原始版本检查。
删除引起的关联清理和条目 touch 属于原删除动作，不增加 `task:write` 要求；
Task/Goal 主动变更标签关联仍由任务写入准入负责。项目资源访问检查不隐含
额外的 `project:read` scope。

REST 与 MCP 的显式 scoped 注册入口共享现有解析、业务操作和响应映射。
REST 对可靠的权限拒绝保留 HTTP 403 与 `forbidden` 错误对象，附加
`Daynight-Scope-Status: insufficient_scope`。MCP 沿用业务 envelope，返回
`insufficient_scope`，写入拒绝为 `not_committed`。提交未知和清理失败继续
使用原有完成语义，不能表述为确定的权限拒绝。

## Team 准入

`service/team` 的 scoped 构造入口接收明确的凭据授权提供器；Team 不可见时
保留原有拒绝，确认可见后检查实际操作的 scope，再判断原角色、版本和其他
业务条件。已有事务内凭据复核的成员操作使用同一事务或快照中的当前授权，
并在原复核点重新检查。缺失或不匹配的授权不能放行。

Team 和成员读取需要 `team:read`；创建和改名需要 `team:write`，改名的
完整响应还需要 `team:read`。成员管理使用 `team:members`，返回既有成员
投影的操作还需要 `team:read`；本人退出使用 `team:leave`，删除使用
`team:delete`。已发邀请使用 `team:invitations`，本人邀请查看与接受分别
使用 `team:invitation-read` 和 `team:invitation-accept`。原有完整接受响应
还需要邀请读取权限；最小服务回执只需接受权限，两者都不要求 `project:read`。
MCP 的 Team 项目列表同时要求 Team 读取和项目读取，预读与变更分别执行准入。

Team REST 使用受保护服务时保留原有解析和响应；MCP 提供显式 scoped 注册，
保持原工具 schema。权限拒绝沿用上文的 HTTP 和 MCP 错误合同。原角色和资源
规则仍独立生效，不因 scope 获得成员或管理员身份。

## Bot 定义准入

`service/bot` 的 scoped 构造入口接收授权事实来源；读取使用当前快照，创建和
删除在各自写事务中取得与原 Principal 绑定的当前策略。OAuth 事务按 grant、
access 的顺序锁定，原凭据、归属和删除协调检查继续生效。缺少策略、身份
不匹配或所需 scope 时不能作为固定 profile 放行。

| 操作 | 所需 scope | 响应 |
| --- | --- | --- |
| 定义 Get、List、ListWorker | `bot:read`、`session:read` | 原完整 Bot 投影，包含 Session 标识和启动结果 |
| Create、CreateResolved | `bot:write`、`bot:read`、`session:read` | 原完整 Bot 投影；在解析及写入前检查，并在写事务内复核 |
| Delete | `bot:delete`、`bot:read` | 原删除责任和清理状态；沿用 Session 准入撤销及清理协调 |
| Defaults | `bot:read`、`worker:read` | 原 Worker 和默认配置投影；主动模型发现另需 `worker:inspect` |
| Observation | `bot:read`、`session:read` | 原 Bot 与 Session 运行观测；采样前后复核 |

HTTP 请求显式携带 `Daynight-Bot-Attention: 1` 并请求完整定义投影时，另需
`assistant-task:read`；创建在写入前复核该权限。MCP 的 `bot_list`、`bot_show`、
`bot_create`、`bot_delete` 保留既有输出，不请求该投影。创建所需的内部模型
发现遵守 Bot 准入及原 Worker 资源检查，并在每次发现前复核当前权限；它不把
独立 Worker 检查能力授予 Bot 定义凭据。

既有 Bot 或指定 Worker 的可见性检查先于 scope 拒绝，分页读取、定义写入和
删除屏障在授权后执行。可靠的 scope 拒绝在 REST 保留 403 `forbidden` 并附加
`Daynight-Scope-Status: insufficient_scope`；MCP 返回 `insufficient_scope`，确定
拒绝的写入标为 `not_committed`。提交或清理结果不确定时保留原错误语义。

## 装配边界

生产仍使用原有 `tag.New`、REST 和 MCP 注册，尚未启用受限凭据签发或
scoped Tag 或 Team 装配。scoped 入口只接受显式授权事实，不以缺失 policy 放行。
凭据持久化、认证时读取最新策略、完整入口分类、迁移和公开启用由相应
实现接入；Tag 的直接操作使用调用方已认证的策略快照。生产 Bot 组装也保持
原有入口；scoped Bot 授权事实来源由启用阶段接入事务绑定的权威读取。

目录准入的取舍见[决策记录](../../.agents/notes/implemented/architecture/2026-11-20-tag-scope-admission.md)。
