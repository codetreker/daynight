# Task 负责人契约

状态：服务端负责人字段、HTTP读写与查询，以及Web负责人交互和schema4字段消费已实现。本文拥有责任归属的数据、事务与界面行为；[设计](../design/daynight-task-assignment.md)拥有机制。

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

已确认的自动领取合同要求assignedTo非空且等于当前认证账号的本地userId，allowAgents=true本身不足以领取他人任务；运行时交付由待合并的[PR #322](https://github.com/codetreker/daynight/pull/322)拥有。既有claim库存、恢复、完成、释放、撤回、显式人工resume及Session/archive权限继续按原执行身份和[认领设计](../design/daynight-worker-claims.md)处理；新负责人不自动接管既有执行。

## 任务筛选与游标

`GET /api/v1/projects/{projectId}/tasks` 接受单值 `assignedTo=UUID|me|unassigned`。省略表示全部；空值、重复参数、非法 UUID 或其他 token 返回 400 invalid_input。UUID 在服务边界规范化，me 在游标核验前解析为认证 principal 的本地用户 ID。查询指定的已失权者不要求其当前仍是成员。

负责人条件与 status、ready、allowAgents、compatiblePlatform、workerId 等显式条件按 AND 组合，使用原生 UUID 等值或 IS NULL，在排序、LIMIT 和最终 lookahead 之前筛选。workerId 仍只表示认证调用者自己的执行归属；增加负责人条件只得到该清单子集，不能据子集缺席清理其他执行。普通任务列表省略负责人条件仍为全部范围。已确认的worker新候选使用assignedTo=me，完整既有claim库存省略该条件；本人自动领取规则由PR #322交付。

| 列表资源 | 游标格式与范围 |
|---|---|
| 项目列表 | 保持版本 1 |
| Task 列表，包括 workerId 筛选的任务页 | 版本 2，绑定项目、全部既有筛选及解析后的负责人选择 |
| 账号级 `/api/v1/me/workers` | 保持版本 1 |

Task 游标中的负责人选择明确为 all、unassigned 或 user:规范UUID。me 与同一具体 UUID 具有相同 scope；另一账号的 me 或变化后的选择不能沿用该游标。旧版本 1 Task 游标拒绝，调用者须从第一页重读；其他列表不因此改变格式。游标不代替认证和项目权限。

## 项目内人员资源

`GET /api/v1/projects/{projectId}/task-assignees` 复用项目读取权限、no-store、Daynight-User-ID、GET/HEAD 及 405/Allow。响应始终包含非 null 的两个数组，条目仅有以下四个字段：

```json
{"items":[{"userId":"11111111-1111-4111-8111-111111111111","name":null,"avatarUrl":null,"hasProjectAccess":false}],"unresolvedUserIds":[]}
```

name 和 avatarUrl 保留实际 nullable 资料，不补姓名或邮箱；响应不包含邮箱、外部身份、角色、版本或执行记录。hasProjectAccess 为明确布尔值，只有 true 条目可作为新分配候选。此资源不改变 Task 版本或访问权限。

### 完整目录

没有 userId 参数时返回当前有效项目成员，与本项目未软删除任务仍引用的负责人之并集；包括没有任务的成员，以及仍被 todo/in_progress/done 引用的离开成员。仅被软删除任务引用不保留资格。条目按规范 UUID 排序并去重，unresolvedUserIds 为空；不静默截断。完整目录供明确打开选择器、筛选器或重试时读取。

### 限定解析

提供一个或多个重复的 userId 参数时，只解析请求的最多 100 个互异规范 UUID。拒绝空值、非法或规范化后重复 ID、超限数量、错误编码及未知/大小写错误的参数名。me/unassigned 不是目录 ID。直接服务调用具有同样的模式、数量和身份校验；显式空解析集合不能退化为完整目录。

每个规范请求 ID 恰好出现在 items 或 unresolvedUserIds 中一次，两组互斥且各自按 UUID 排序。有当前访问权或仍被当前项目未删除任务引用者返回最小资料；无此资格的 ID 进入 unresolvedUserIds，不论其是否存在于全局 users，都不返回资料。unresolved 可能来自旧展示、清空或软删除，不表示失去访问权限。

自动展示消费者使用当前实际展示/选择的 ID 集合分批解析，空集合不发请求；不能省略参数而意外读取完整目录。客户端的读取节奏与界面消费由其自身实现拥有。

### 一致性与失败

项目授权、资格、任务引用和用户资料来自同一个只读 REPEATABLE READ 快照。原始成员关联或保留任务引用存在，但 users 行缺失，是内部完整性失败，不能被 INNER JOIN 丢弃、转为 unresolved 或当作 null 姓名。nullable 姓名/头像本身是合法资料。

非法输入返回 400；无项目读取权沿用隐藏式 404。数据库、取消、scan/rows、事务完成及完整性失败保留错误链且不返回部分条目。操作或事务完成故障优先于暂存的领域拒绝。日志不包含目录资料或请求 ID 集合。

## Web 交互与显示

独立任务行、任务链代表与匹配子任务行、详情都显示当前负责人。姓名来自最小人员资源；缺少已载资料或name为null时显示短UUID，不伪造邮箱。失权标记仅来自成功响应的hasProjectAccess=false，加载、失败或unresolved不制造该标记。

详情中的状态与负责人作为同一24px控制组，随后是平台和就绪状态，自动执行靠右。选择器头像16px，列表头像17px；长姓名省略但保留完整可访问名，窄屏整组换行且不溢出。菜单按姓名或UUID搜索，可清空、选择有效成员；当前负责人失权仍可显示和筛选，但不是新分配候选。

打开选择器触发完整目录，加载或失败时提交禁用且可重试。方向键移动，Enter/Space选择，文本输入保留编辑键；Escape只关闭菜单并恢复触发器焦点，Tab和外部点击关闭但不抢后续焦点。滚动、全屏与尺寸变化保持菜单锚定，任务或准入变化关闭菜单。

选择当前值直接关闭且不发写入。实际变化由TaskDetailSession通过一次普通PATCH消费完整Task，精确核验版本、许可和其他材料保持；执行中、陈旧详情或未决操作不能提交。未知结果显示旧快照和待核对状态，只GET核对、不重放PATCH；后续合法更高版本可成为当前值。

规则通过字段值、开关和disabled体现，不在新增控件、菜单或操作结果中附加规则说明。必要的错误、访问状态与恢复操作仍可理解和操作。

## Web 人员刷新与筛选

人员只保存在认证scope的会话内存。列表、详情和具体人员筛选登记需求，按当前展示/选中ID去重，每100个解析；空集合零请求。实际成功graph receipt（包括空delta）触发限定刷新，完整目录只由明确打开/重试触发。旧账号、项目历史、需求或较旧派发结果不能覆盖当前资料；失败/unresolved不清空Task负责人。

可信同用户的项目404沿当前scope/ticket撤销项目准入，不能因菜单关闭、需求变化或身份正向门禁等待而丢失；旧历史拒绝不能撤销新历史。人员读取不授予Task写权限。

项目任务列表可选择全部、分配给我、未分配或具体人员。匹配在显示分页之前，与已有近期/显示所有条件相交；改变筛选回第一页。独立任务只显示匹配项；任一链成员匹配即保留真实代表头作上下文，展开显示匹配子任务及匹配数。完整链进度、ready/blocked、图与概览继续使用完整索引，不能按负责人裁剪task-sync。概览显式定位可以清除遮挡目标的负责人筛选，不改变完整项目事实。

Web Task、summary和GraphTask严格要求assignedTo:null或规范UUID，所有相等/新鲜度/审阅键与材料保持检查纳入它。schema1/2/3直升4清除可再生项目/摘要/详情、轮换user fence和水位，随后完整重建；旧记录缺字段不能按null继续消费。

## 当前交付边界与验证

本契约的服务端字段、POST/PATCH、任务筛选、人员资源及Web交互/schema4消费已实现。当前基线的CLI负责人选项、解析和输出尚未交付，由[客户端契约](daynight-project-task.md)拥有其边界；本人自动领取的运行时由PR #322单独交付。

验证覆盖原始 JSON 字段与白名单、三套任务投影、nullable 及规范化、实际/等值/陈旧版本、执行中拒绝、全部保留写入、真实项目锁竞态及回滚。查询验证多页过滤、完整游标 scope、版本隔离和权限；目录验证两种模式的资格、覆盖、隐私、资料缺失、快照一致性及失败优先级。查询计划和响应样本绑定被测修订，不把样本量当作生产容量上限。Web还验证字段/schema4一并升级、迟到与失权fence、未知结果只读核对、完整图筛选及双语桌面/390px/320px交互。适用 Go 与Web门禁由仓库验证命令拥有。
