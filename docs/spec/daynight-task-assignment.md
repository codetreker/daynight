# Task 负责人契约

状态：服务端负责人字段、HTTP 读写与查询、CLI 负责人命令、Web 负责人交互和 独立持久人员缓存，以及本人自动领取规则已实现。本文拥有责任归属的数据、事务、查询与界面行为；[设计](../design/daynight-task-assignment.md)拥有机制。

## 数据与读取

`AssignedTo` 表示负责的人，与具体 worker 领取归属独立。SQL 使用 `tasks.assigned_to uuid NULL`，Go 使用 `AssignedTo *string`，HTTP 使用必填顶层 `assignedTo`。它不属于 `properties`。

完整 Task、任务分页、task-sync snapshot/delta 和任务链图节点都显式返回 `assignedTo: null` 或规范本地用户 UUID。字段缺失不是未分配。姓名、头像和成员资格不进入该版本化字段。

HTTP 创建请求省略或明确提供 assignedTo:null 时未分配。迁移 028 为全部既有任务（包括软删除任务）增加 NULL 值，保持任务版本、业务时间、properties、依赖、worker 与 Session。服务不推断历史创建者或执行者。

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

`in_progress` 禁止实际负责人变化，整个组合写入返回 409 invalid_transition，原数据保持。精确版本下的相同负责人不触发许可重置或重新核验历史负责人的成员资格；纯等值请求不增加版本或时间。同一请求中其他字段仍按其普通规则修改并决定版本变化。陈旧版本即使等值仍返回 version_conflict。

负责人失去项目访问权限后，字段保留。普通元数据、状态、属性和全部 worker 生命周期写入保留负责人；同状态和相同 worker 摘要等 no-op 不构造空负责人写入。

## 并发与执行归属

负责人写入、状态、许可、worker claim 和成员修改共享项目锁及任务版本。实际竞争只有一个同版本变更提交；等值请求先完成时可与后续 claim 均成功，但只有 claim 增加版本。目标先被移除则新分配拒绝；有效分配后再移除目标则保留该 UUID。

自动领取要求 assignedTo 等于当前认证账号的本地 userId。Worker 使用 assignedTo=me 发现候选，服务端 claim 在项目写事务中重新校验当前负责人；未分配和分配给他人的任务即使 allowAgents=true 也拒绝自动领取。已有 claim 的完整库存、恢复、完成、释放、撤回和 Session/archive 权限仍按原执行身份与[认领设计](../design/daynight-worker-claims.md)处理；新规则不自动撤回既有执行。[本人领取决策](../../.agents/notes/archived/architecture/2026-11-03-worker-self-assigned-claims.md)保存资格规则与执行授权分离的原因。

## 任务筛选与游标

`GET /api/v1/projects/{projectId}/tasks` 接受单值 `assignedTo=UUID|me|unassigned`。省略表示全部；空值、重复参数、非法 UUID 或其他 token 返回 400 invalid_input。UUID 在服务边界规范化，me 在游标核验前解析为认证 principal 的本地用户 ID。查询指定的已失权者不要求其当前仍是成员。

负责人条件与 status、ready、allowAgents、compatiblePlatform、workerId 等显式条件按 AND 组合，使用原生 UUID 等值或 IS NULL，在排序、LIMIT 和最终 lookahead 之前筛选。workerId 仍只表示认证调用者自己的执行归属；增加负责人条件只得到该清单子集，不能据子集缺席清理其他执行。普通任务列表省略负责人条件仍返回全部负责人范围；worker 新候选显式使用 assignedTo=me，完整既有 claim 库存省略该条件。

| 列表资源 | 游标格式与范围 |
|---|---|
| 项目列表 | 版本 2，绑定主体及 all/team/shared 范围 |
| Task 列表，包括 workerId 筛选的任务页 | 版本 2，绑定项目、全部既有筛选及解析后的负责人选择 |
| 账号级 `/api/v1/me/workers` | 保持版本 1 |

Task 游标中的负责人选择明确为 all、unassigned 或 user:规范UUID。me 与同一具体 UUID 具有相同 scope；另一账号的 me 或变化后的选择不能沿用该游标。旧版本 1 Task 游标拒绝，调用者须从第一页重读；账号级 Worker 游标保持版本 1。游标不代替认证和项目权限。

## 项目内人员资源

`GET /api/v1/projects/{projectId}/task-assignees` 复用项目读取权限、no-store、Daynight-User-ID、GET/HEAD 及 405/Allow。响应始终包含非 null 的两个数组，条目仅有以下五个字段：

```json
{"items":[{"userId":"11111111-1111-4111-8111-111111111111","version":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":null,"avatarUrl":null,"hasProjectAccess":false}],"unresolvedUserIds":[]}
```

name 和 avatarUrl 保留实际 nullable 资料，不补姓名或邮箱；响应不包含邮箱、外部身份、角色、Task 版本或执行记录。必填 version 是服务端签发的 64 位小写十六进制 SHA-256 内容标识，只由 userId、name 和 avatarUrl 决定；客户端不得自行推算或用请求时观察值替代。hasProjectAccess 为明确布尔值，只有 true 条目可作为新分配候选。资料内容未变时，登录时间、角色、访问状态、任务版本或引用数量变化均不改变资料 version。此资源不改变 Task 版本或访问权限。

### 完整目录

没有 userId 参数时返回当前有效项目成员，与本项目未软删除任务仍引用的负责人之并集；包括没有任务的成员，以及仍被 todo/in_progress/done/cancelled引用的离开成员。仅被软删除任务引用不保留资格。条目按规范 UUID 排序并去重，unresolvedUserIds 为空；不静默截断。完整目录保留给明确要求完整资料的调用方；Web 选择器使用 task-sync 的完整人员版本清单与按需资料读取，遵守下述持久缓存规则。

### 限定解析

提供一个或多个重复的 userId 参数时，只解析请求的最多 100 个互异规范 UUID。拒绝空值、非法或规范化后重复 ID、超限数量、错误编码及未知/大小写错误的参数名。me/unassigned 不是目录 ID。直接服务调用具有同样的模式、数量和身份校验；显式空解析集合不能退化为完整目录。

每个规范请求 ID 恰好出现在 items 或 unresolvedUserIds 中一次，两组互斥且各自按 UUID 排序。有当前访问权或仍被当前项目未删除任务引用者返回最小资料；无此资格的 ID 进入 unresolvedUserIds，不论其是否存在于全局 users，都不返回资料。unresolved 可能来自旧展示、清空或软删除，不表示失去访问权限。

自动展示消费者使用当前实际展示/选择的 ID 集合分批解析，空集合不发请求；不能省略参数而意外读取完整目录。客户端的读取节奏与界面消费由其自身实现拥有。

### 一致性与失败

项目授权、资格、任务引用和用户资料来自同一个只读 REPEATABLE READ 快照。原始成员关联或保留任务引用存在，但 users 行缺失，是内部完整性失败，不能被 INNER JOIN 丢弃、转为 unresolved 或当作 null 姓名。nullable 姓名/头像本身是合法资料。

非法输入返回 400；无项目读取权沿用隐藏式 404。数据库、取消、scan/rows、事务完成及完整性失败保留错误链且不返回部分条目。操作或事务完成故障优先于暂存的领域拒绝。日志不包含目录资料或请求 ID 集合。

## Web 交互与显示

独立任务行、任务链代表与全部子任务行、详情都显示当前负责人。姓名来自最小人员资源；缺少已载资料或name为null时显示短UUID，不伪造邮箱。失权标记仅来自成功响应的hasProjectAccess=false，加载、失败或unresolved不制造该标记。

详情中的状态与负责人作为同一24px控制组，随后是平台和就绪状态，自动执行靠右。选择器头像16px，列表头像17px；长姓名省略但保留完整可访问名，窄屏整组换行且不溢出。菜单按姓名或UUID搜索，可清空、选择有效成员；当前负责人失权仍可显示和筛选，但不是新分配候选。

选择器按当前已授权人员版本清单展示完整候选集合，只补读缓存中缺失或内容版本变化的人员。普通重开复用成功或在途结果，失败保留错误并通过显式 Retry 恢复缺失资料读取。加载或失败时提交禁用且可重试。方向键移动，Enter/Space选择，文本输入保留编辑键；Escape只关闭菜单并恢复触发器焦点，Tab和外部点击关闭但不抢后续焦点。滚动、全屏与尺寸变化保持菜单锚定，任务或准入变化关闭菜单。

选择当前值直接关闭且不发写入。实际变化由TaskDetailSession通过一次普通PATCH消费完整Task，精确核验版本、许可和其他材料保持；执行中、陈旧详情或未决操作不能提交。未知结果显示旧快照和待核对状态，只GET核对、不重放PATCH；后续合法更高版本可成为当前值。

规则通过字段值、开关和disabled体现，不在新增控件、菜单或操作结果中附加规则说明。必要的错误、访问状态与恢复操作仍可理解和操作。

## Web 人员版本、持久缓存与筛选

每个成功 task-sync snapshot 和 delta 都包含必填的非 null assigneeVersions 数组，即使 tasks 为空也返回当前完整资格集合。每项恰有 userId、version 和 hasProjectAccess，按规范 UUID 升序且无重复；资格与完整目录相同，包含当前项目成员和未软删除任务仍引用的负责人。清单不包含姓名或头像，version 与人员 GET 对同一资料内容给出的标识相同。资料、资格、Project、任务和权限来自同一读取快照；清单失败使整个同步失败，不能发布部分人员或任务。

人员内容按 API origin、查看者、项目和资料 userId 隔离，持久保存内容 version、nullable 姓名和头像，并受 userFence 约束；不持久保存项目访问布尔值作为授权证据。刷新页面后先完成当前 /me 身份核验和项目在线 task-sync，再按新清单匹配持久 version。未变化内容直接复用，只补查当前有资格且资料缺失或版本变化的 ID，每批最多 100 个；空集合零请求。合法 nullable 姓名或头像不构成缺失。当前 hasProjectAccess 来自在线清单，访问状态单独变化不重传未变化头像。清单中无资格的 ID 不得凭旧资料恢复展示资格，也不以 unresolved 推断失权。

列表、详情和具体人员筛选共享资料所有者；重复打开任务、多个组件请求同一人、重复同步和选择器普通重开不重复传输匹配版本资料。并发需求合并并复用在途读取；同一身份和项目历史下有效结果不因组件卸载而丢弃。人员 GET 返回其自身快照实际观察的 version；若它已晚于先前清单，保留真实版本，不能标记为旧版本，也不能因这次差异立即循环重查。超前资料和临时 unresolved 的复用例外只持续到下一次新的成功 graph receipt 观测，即使清单内容版本未变也重新核验；重复 receipt 与普通展示变化保留当前观测。请求捕获所属观测，旧响应不能在新观测中恢复冲突例外。普通匹配版本的缓存资料继续复用，不因此重新读取。

IndexedDB使用独立profiles store保存资料内容，不写入 Task 版本或任务记录。历史schema5→6升级只增加资料store，保留当时兼容的Task和userFence；当前schema9为必需cancelledAt重建不兼容Task记录及水位，profiles内容仍独立保留。schema1/2/3/4历史格式的重建规则由缓存需求拥有。普通页面卸载保留持久资料。观察到项目 generation 更替时，立即撤回旧人员显示、资格、访问标记和候选目录的 ready 状态；userFence 更替则保留已显示内容并暂停远程准入直至刷新；即使跨标签页先安装了 assigneeVersions:null 的新投影，也不能保留旧清单或把未知清单当作成功空目录。已请求的目录等待当前在线清单，未请求的目录保持 idle；Task.assignedTo 原值不变。同一 userFence 下的原始资料内容可保留，只有新在线清单匹配后才恢复显示；userFence 更替不复用旧内容，旧响应不得跨 generation 发布。真实退出、会话失效或项目撤权同步释放相应内存准入，并沿既有作用域清理持久资料；观察到账户变化先保留已显示内容。缓存与读取失败保留明确错误和 Retry，不伪装成成功、空人员或丢失访问权。

可信同用户的项目 404 沿当前 scope/ticket 撤销项目准入，不能因菜单关闭、需求变化或身份正向门禁等待而丢失；旧历史拒绝不能撤销新历史。人员资料和清单只服务显示与候选选择，不能授予 Task 写权限。

项目任务列表可选择全部、分配给我、未分配或具体人员。负责人条件与状态条件必须在同一任务上同时满足，匹配在分页之前；改变任一条件使两个列表回第一页。独立任务只显示自身匹配项；任一普通链成员同时匹配即保留真实代表头作上下文，展开显示全部普通成员，链外前置不参与匹配。三个页签数字复用同一负责人条件：前两个按未归属 Goal 的未结束普通 Task 自身负责人计数，Goal 按容器自身负责人计数且只包含 `todo` 和 `in_progress`，孩子负责人和进度不决定其资格；状态筛选和分页不改变数字。完整链进度、ready/blocked、图与概览继续使用完整索引，不能按负责人或状态裁剪 task-sync。概览显式定位可以清除遮挡目标的条件，不改变完整项目事实。

Web Task、summary 和 GraphTask 严格要求 assignedTo:null 或规范 UUID，所有相等/新鲜度/审阅键与材料保持检查纳入它。schema 1/2/3/4 升级会清除可再生项目/摘要/详情、轮换 user fence 和水位后完整重建；旧记录缺字段不能按 null 继续消费。

## 当前交付边界与验证

本契约的服务端字段、POST/PATCH、任务筛选、人员资源，以及 Web 负责人交互和 独立持久资料缓存已实现。CLI 已消费必填 nullable assignedTo，创建时省略负责人默认使用当前认证账号，显式 UUID 可指定其他人；服务端不强制这个默认值。CLI 还支持设置/清空、当前 ID 展示及 UUID/me/unassigned 的 list 筛选，命令和响应验证由[客户端需求](daynight-project-task.md)拥有。本人自动领取规则已实现，其资格与既有执行授权分离的历史取舍见[本人领取决策](../../.agents/notes/archived/architecture/2026-11-03-worker-self-assigned-claims.md)。

验证覆盖原始 JSON 字段与白名单、三套任务投影、nullable 及规范化、实际/等值/陈旧版本、执行中拒绝、全部保留写入、真实项目锁竞态及回滚。查询验证多页过滤、完整游标 scope、版本隔离和权限；目录验证两种模式的资格、覆盖、隐私、资料缺失、快照一致性及失败优先级。完整规模的查询计划和响应样本由显式本地压力入口运行，绑定被测修订；常规 CI 保留查询正确性验证，不把样本量当作生产容量上限。Web 还验证 schema 6 的持久资料复用、缺失/变化项读取、访问状态单独变化、schema 5 无损升级与 schema 1/2/3/4 重建、跨标签页 generation 更替且新在线清单尚未取得时撤回旧人员/访问标记/ready 目录并在新清单验证后复用内容、迟到与失权 fence、未知结果只读核对、完整图筛选及双语桌面/390px/320px交互。CLI 验证严格 nullable 字段、设置/清空参数、list 筛选与逐页 principal 绑定、精确版本和 JSON/可读输出。适用 Go、CLI 与 Web 门禁，以及 Go 严格大于 90% 的总语句覆盖率由仓库验证命令拥有。
