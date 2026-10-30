# Task 预定义属性设计

状态：服务端通用属性模型、独立存储、属性 HTTP 资源和客户端读取适配已实现。[属性需求](../spec/daynight-task-properties.md)拥有行为与验收；[属性行决策](../../.agents/notes/implemented/architecture/2026-10-30-task-property-rows.md)保存取舍，并链接不可变的[原属性列决策](../../.agents/notes/archived/architecture/2026-10-21-task-properties-design.md)。[交互预览](mockups/task-properties.html)继续拥有只读 PR 区域的视觉示例。

## 职责与数据流

属性定义由服务端代码拥有。通用 API、领域值容器、存储和客户端解析保留名称到完整 JSON 值的映射；PR 展示、Worker 执行与 Session 访问只在业务边界读取所需类型。

~~~mermaid
flowchart LR
  Client[CLI / Web 通用属性对象] --> HTTP[属性与任务 HTTP]
  HTTP --> Registry[静态定义 / native validator]
  HTTP --> Service[任务候选 / version]
  Service --> Tx[项目写事务 / 父任务锁]
  Tx --> Tasks[(tasks)]
  Tx --> Values[(task_properties)]
  Read[一致读取快照] --> Tasks
  Read --> Values
  Read --> Client
~~~

core 使用通用 TaskProperties map。internal/taskproperties 依赖 core 并拥有静态注册表、值 codec、规范化与 typed business accessors；core 不反向依赖 codec。HTTP DTO 使用同样的属性对象，不增加每属性字段。服务端添加一个预定义属性只需定义与对应业务消费，不要求更改 SQL schema、通用命令或完整资源字段投影。

定义提供名称、说明、readOnly、值 schema 和 native decoder/normalizer。初始属性为 pullRequests 与 worker。schema 用于发现和说明，实际验证由 native codec 负责；没有运行时属性插件、数据库定义表或通用 JSON Schema 执行引擎。契约测试覆盖 schema 与 validator 的类型、必填、枚举、nullable 和保护规则。

properties:{} 表示没有属性。存在的 pullRequests 必须是有序数组，存在的 worker 必须是合法归属对象；整个属性值均不允许 null。worker 内部 nullable 字段不受此规则改变。

## 值解析与规范化

公共写入查找定义并拒绝未知或 readOnly 名称。字符串定义将合法 JSON 字符串解码，其它输入原样编码为字符串；非字符串定义严格解析一个 JSON 值，再校验结构。空文本和数值样式文本均原样到达服务端，不由 CLI 判断属性类型。

JSON 对象的重复键与未知字段在普通 unmarshal 前被拒绝。PR 字符串只使用原有 JSON 字符串解码，不复用标题、仓库 URL 或 Worker 文本限制；空值、控制字符、NUL、顺序和重复项均保留。规范化只统一值的 JSON 表示，保留旧系统已经解码的字符串语义，包括错误 surrogate 的既有替换行为。

存储读取同样通过定义的 native decoder/normalizer，语义比较和 DTO 输出使用规范值。不能把旧 JSON 原始片段直接透传，从而改变客户端看到的字符。属性名和结构非法产生可识别的属性校验错误；数据库故障保持原错误链。

TaskProperties 作为不可变值使用。修改创建候选 map 并复制变更值，不原地修改当前任务或共享快照。属性 map 的存在键参与比较，缺失与 [] 不相等；对象键序、缩进和等价转义不构成值变化，有序数组仍按顺序比较。

## 独立表与读取

~~~sql
CREATE TABLE task_properties (
    task_id uuid NOT NULL,
    name text COLLATE "C" NOT NULL CHECK (name <> ''),
    value text NOT NULL,
    PRIMARY KEY (task_id, name)
);
~~~

task ID 已是全局 UUID 主键，属性行不重复 project_id。授权先定位父项目和任务，再以准入后的任务 ID 读取值。属性行没有独立版本、时间或删除标记；父任务软删除保留其属性，业务读取只从可见父任务派生 ID 集合。不增加 foreign key。

value 保存完整 JSON 文本，PR 数组和 worker 对象各占一行，不继续拆分嵌套字段。NUL 以 JSON 转义存在，不把 NUL 字节送入 PostgreSQL text。[PostgreSQL JSON 类型说明](https://www.postgresql.org/docs/18/datatype-json.html)解释了 JSONB 与 JSON 处理函数的 Unicode 转换限制；存储和读取都不对既有 opaque 字符串做 SQL JSON 转换。

完整单项、分页和事务读取先取得所需任务，再关闭 pgx rows，批量加载 task_id = ANY($1::uuid[]) 的属性并组装 map。任务与属性使用同一 REPEATABLE READ snapshot，版本与内容属于同一状态。LIMIT 作用于任务筛选结果，不能在一对多属性 JOIN 后分页。空集合得到 {}，非法值使整个读取失败。

Worker inventory 在原 keyset 顺序中读取唯一 worker 属性并匹配 active/userId/workerId，之后才应用最终 page limit/lookahead；选中任务再批量载入完整属性。Worker reporting 对其引用的 task IDs 批量读取 worker 值并核对项目、当前 owner、worker、claim 和状态，不扫描其他项目，也不把观察快照当作认领权威。

## HTTP 与任务事务

| 资源 | 所有权 |
|---|---|
| GET /api/v1/task-properties/schema | 认证后读取全服务定义目录，不触发项目发现 |
| GET /api/v1/projects/{projectId}/tasks/{taskId}/properties | 父项目读取权限，返回完整 PropertyResource |
| PUT .../properties/{name} | version/valueText，服务端解析后设置完整单值 |
| DELETE .../properties/{name} | version，真正删除一项可写属性 |

PropertyResource 包含 projectId、taskId、version 和完整 properties；两个 mutation 均返回 200。目录按名称排序，包含真实 worker 完整结构和 readOnly，不声明读时 default。GET/HEAD、no-store、Daynight-User-ID 和方法拒绝沿用现有认证与 HTTP 机制。

~~~json
{
  "version":42,
  "valueText":"[{\"url\":\"https://github.com/owner/repo/pull/123\",\"title\":\"修复同步\"}]"
}
~~~

valueText 外壳复用正 int64 version、UTF-8 application/json 和严格字段解码。完整外壳沿用 1 MiB 请求限制，二次转义计入实际字节。该限制不等于一个属性可保存 1 MiB 内容；原生 JSON create/PATCH 保留一次事务修改普通字段、依赖和属性的能力，不重新解释 native JSON 字符串。

写入在取得项目行锁后，先对父任务取得 FOR UPDATE，再读取当前属性和版本，验证完整候选并判断 no-op。实际变化在同一事务写属性差异、任务 version/updated_at，以及生命周期相关 Session 变化。任何一步失败完整回滚；新任务先创建父行，再写显式提供的属性。

公开 PATCH 的 omitted key 保留值，提供 key 替换完整值，properties:{} 没有修改意图；null 不承担删除语义。DELETE 的已缺失可写属性为 no-op，但仍先检查版本。相同值设置不改版本，陈旧等值请求仍冲突。未知或只读属性即使不存在也拒绝移除。

## Worker 与 Session fence

没有保留归属时没有 worker 行。Claim/resume 创建 active 对象，摘要更新替换其值，release 与 claim-bound complete 分别保留 released/completed 对象；withdraw 删除 worker 行并原子完成状态、计时及自动许可重置。公开属性入口不能制造、覆盖或移除归属。[认领架构](daynight-worker-claims.md)拥有完整生命周期。

Session relay 先锁父任务 FOR SHARE，再读取 worker 和对应 Session。所有属性写入必须先取得不兼容的父任务锁，不能仅锁属性行：缺失 worker 没有可锁行。项目行锁自身不能替代这一 fence。锁序保持项目（如有）→ 父任务 → 属性 → Session/freeze，不出现 Session→父任务的反向顺序。该约束覆盖注册、控制、状态、claim/release/withdraw/complete 与属性修改。

## 迁移与发布

旧属性列最初通过 003_task_properties.sql 增加；016_task_worker.sql 曾插入显式 worker:null。它们和已应用 checksum 保持原字节，原始决策仍保留其当时合理性。属性行迁移使用冻结的旧格式 decoder/normalizer 和事务内数据转换，转换源与 SQL 一并进入新迁移 checksum，不依赖会继续演进的当前 registry。

迁移锁住父任务，在同一事务创建表，分批遍历全部旧任务（含软删除），验证并规范化每个值。所有既有 pullRequests 值保留，包括不能判断来源的 []；非 null worker 保留全部 claim/session/worktree 身份，null 转为无行。旧可选控制模式按旧模型解释并写出新规范形式。未知或损坏数据中止，不填值或丢弃。

每批读完关闭 rows 后再写，避免连接忙。新旧业务值核对、旧列删除和 migration ledger 提交均属于同一事务。任务 version、created_at、updated_at 和执行时间不变化。失败回滚全部结构和数据；运行时只读取新表，不保留旧列或 null 兼容分支。

属性缺失改变完整资源契约，服务端与 CLI/Web 必须协调更新。模型切换使 Web IDB schema 1→2，重建可再生的项目/摘要/详情并轮换 user fence，清理旧必填/null 详情和旧水位；否则旧详情与新值会在相同版本产生冲突。旧客户端需要更新，不通过读时默认值延长旧格式。数据库提交后的回退需恢复数据库或经验证的反向迁移，不能仅更换旧二进制。

## 客户端与现有入口

CLI/Web generic parser 保留所有属性键，业务访问通过 typed PR/Worker reader。缺失返回明确 absent 状态；存在但格式非法暴露错误。完整材料比较覆盖完整属性对象，具体 Worker 操作只排除其获准改变的 worker 键。

CLI 的既有 PR 配对选项仍生成完整 pullRequests 值，--clear-pull-requests 设置 []。它们的参数形状与当前命令由 [CLI 设计](daynight-project-task.md)拥有。文本资源使用通用属性输出，JSON 不补默认值或显示标记。外壳版本的精确解码只处理资源规定的位置，属性内部同名 version 不被递归改写。

Web PR 卡、分页、链接策略及焦点保持不变，缺失与空 PR 都显示已有空态。PR 引用按全局下标保留独立条目，不能以 URL 去重或作为吞掉重复项的唯一键。一次合法写入可包含数万条短引用，因此每页最多挂载 100 行，为 DOM/accessibility tree 提供独立上限；完整数组仍留存，原生前后页与页码控件使全部项可访问，不依赖可变行高或额外请求。

完整属性仍不进入普通图和 task-sync 摘要投影；摘要中的版本变化使详情失效，执行身份核对继续 GET 完整任务。缓存内容不授予 live 读取或写入权限。

## 错误与观测

非法输入与非法存储属性值统一映射为 400 invalid_input；数据库连接、查询、事务和其他内部故障为 500 internal_error。服务层通过可识别的属性校验错误区分两类原因，store 包装保留错误链。批量读取不返回部分结果，修改不因坏值部分提交，迁移错误则中止启动迁移。

复用 request context 与 slog JSON 的 request_id/user_id/project_id/task_id、route pattern 和阶段。属性操作记录 component=task_property、phase=schema|get|set|remove；写成功的 outcome 为 changed/unchanged。property_name 只在定义匹配后记录，错误包含固定分类和受限的路径/规则，不记录值、PR 内容或令牌。

可以用响应 X-Request-ID 关联同一请求的属性阶段、清洗原因和最终 HTTP 状态。请求取消传到 service/store；提交后的响应丢失仍是结果不确定，客户端只读回核对而不自动重放。

## 备选与验证

每属性一行对应设置/删除单位，付出的成本是批量装配；整任务 JSON 行仍耦合写入单位，继续拆 PR 项又会引入独立项身份和顺序机制。文本值保留既有字符语义，当前没有任意 JSON 内容 SQL 查询需求。静态 native validator 明确业务规则，schema 只负责发现；对动态属性、全文查询或属性级版本的支持需要独立契约。

验证由需求 TP-V1–TP-V8 约束，覆盖真实 PostgreSQL 的迁移、快照、并发与回滚，HTTP 的 schema/版本/严格值/400 与 500，CLI/Web 的完整对象和缺失读取，Worker inventory/reporting 与 Session 锁交错。保留现有 Go build/vet/race/go-cov、CLI typecheck/test/build 和 Web 覆盖/生产浏览器门禁，不以绿灯代替生命周期证据。文档验证包括本地链接、当前事实/历史记录的界限和新文件。
