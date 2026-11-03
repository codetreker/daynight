# Task 负责人服务端契约

状态：服务端负责人字段、普通 HTTP 读写和任务数据生产者已实现。本文拥有责任归属的数据与事务行为；[设计](../design/daynight-task-assignment.md)拥有机制。

## 数据与读取

`AssignedTo` 表示负责的人，与具体 worker 领取归属独立。SQL 使用 `tasks.assigned_to uuid NULL`，Go 使用 `AssignedTo *string`，HTTP 使用必填顶层 `assignedTo`。它不属于 `properties`。

完整 Task、任务分页、task-sync snapshot/delta 和任务链图节点都显式返回 `assignedTo: null` 或规范本地用户 UUID。字段缺失不是未分配。姓名、头像和成员资格不进入该版本化字段。

新任务省略或明确提供 null 时未分配。迁移 028 为全部既有任务（包括软删除任务）增加 NULL 值，保持任务版本、业务时间、properties、依赖、worker 与 Session。服务不推断历史创建者或执行者。

## 创建与更新

| 输入 | 行为 |
|---|---|
| POST 省略 assignedTo 或提供 null | 新任务未分配，自动执行仍为 false |
| POST 提供 UUID | 在项目事务内验证目标访问权限，创建已分配但不自动执行的任务 |
| PATCH 省略 assignedTo | 保留当前负责人 |
| PATCH assignedTo:null | 清空负责人 |
| PATCH assignedTo:UUID | 设置负责人 |
| 空字符串、非法 UUID 或非字符串非 null | 400 invalid_input |

PATCH 仍要求精确正 int64 version 和至少一个可修改字段，单独清空也是有效输入。非 null UUID 在服务边界规范化，大小写不同的同一 UUID 按等值处理。

修改负责人沿用任务编辑权限。新的非 null 目标必须在同一项目事务内拥有有效访问权限；目标缺失返回 invalid_input，内部查询失败保持原错误链和内部错误类别。分配不授予项目访问权，也不转移 worker、Session 或归档控制权。

## 变化、许可与版本

实际负责人变化包括 null→人、人→另一人和人→null，必须在同一次任务更新中令 `allowAgents=false`。组合 PATCH 即使同时请求 `allowAgents:true`，最终仍保存新负责人和 false。任务状态、起止时间、平台、标题/正文、完整属性及依赖保持请求所要求的合法候选，不由负责人规则隐式改写。

`in_progress` 禁止实际负责人变化，整个组合写入返回 409 invalid_transition，原数据保持。精确版本下的相同负责人不重置许可、不增加版本或时间；等值不触发重新核验历史负责人的成员资格。它不豁免同一请求对其他字段的既有约束。陈旧版本即使等值仍返回 version_conflict。

负责人失去项目访问权限后，字段保留。普通元数据、状态、属性和全部 worker 生命周期写入保留负责人；同状态和相同 worker 摘要等 no-op 不构造空负责人写入。

## 并发与执行归属

负责人写入、状态、许可、worker claim 和成员修改共享项目锁及任务版本。实际竞争只有一个同版本变更提交；等值请求先完成时可与后续 claim 均成功，但只有 claim 增加版本。目标先被移除则新分配拒绝；有效分配后再移除目标则保留该 UUID。

负责人不成为自动领取条件。开启许可后，其他人的合格 worker 仍可领取；自动发现、人工恢复、完成、释放、撤回和 Session/archive 权限沿用[认领设计](../design/daynight-worker-claims.md)。

## 当前交付边界与验证

本契约的服务端字段和普通 POST/PATCH 已实现。负责人筛选与人员目录、CLI 负责人选项、Web 编辑和新字段缓存消费不属于当前已实现能力。现有客户端继续使用其已实现的数据投影。

验证覆盖原始 JSON 字段存在、三套同快照投影、nullable 及规范化、实际/等值/陈旧版本、执行中拒绝、全部保留写入、真实项目锁竞态及后续写入失败回滚。迁移验证全部历史事实及重复启动；适用 Go 门禁和严格大于 90% 的总语句覆盖率由仓库验证命令拥有。
