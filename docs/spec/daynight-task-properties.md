# Task 预定义属性需求

状态：服务端通用属性模型、独立存储、属性 HTTP 资源、通用 CLI 命令与客户端读取适配已实现。本文拥有属性的行为与验收；[架构设计](../design/daynight-task-properties.md)解释机制与取舍。现有 [server](daynight-server.md)、[CLI](daynight-project-task.md) 和[看板](daynight-web.md)需求继续拥有各自入口。

## 目标与范围

Task 使用服务端预定义且有明确值结构的属性。属性目录随服务端代码发布；当前包含公开可写的 pullRequests 和服务端拥有的只读 worker。通用传输、存储和完整资源保留全部属性键，具体业务只读取需要的属性。

| 编号 | 必需行为 |
|---|---|
| TP1 | 完整 Task 的 properties 为 JSON 对象，属性可以缺失。新任务未提供属性时为 {}，读取不补默认值。 |
| TP2 | pullRequests 为有序数组，每项恰有字符串 url 与 title；允许多个、跨仓库和重复项，顺序属于数据。 |
| TP3 | 保存解码后的原始字符串内容，允许空白、空字符串、控制字符、NUL 和任意 URL 文本，不执行 URL、PR、仓库或标题内容校验。 |
| TP4 | 创建与 PATCH 支持已定义的可写属性，与普通字段及依赖在任务事务内原子提交。 |
| TP5 | 属性使用任务整体 version；真实变化增加一次版本，语义相等设置或重复删除保留版本和时间，陈旧版本始终冲突。 |
| TP6 | 属性移除真正删除记录，完整读取省略该键；缺失、空数组和 JSON null 是不同状态。null 仅在值定义允许时合法。 |
| TP7 | 服务端提供认证的属性定义目录及项目范围的属性读取、设置和移除资源，CLI 用 properties/set-property/remove-property 暴露它们；值解释与属性校验只由服务端负责。 |
| TP8 | worker 有记录时必须是合法归属对象，没有保留归属时缺失；公共创建、PATCH、属性设置和属性移除均不能写 worker。 |
| TP9 | 完整单项、分页列表、修改结果及 task-sync 的 snapshot/delta 保留全部当前属性；图节点继续使用不含属性的精简投影。 |
| TP10 | 数据迁移保留既有 PR 字符串、顺序及重复项，保留执行归属与任务元数据；旧空 PR 数组保留，旧 worker:null 转为缺失。 |
| TP11 | 非法输入或非法存储属性值返回 400 invalid_input；数据库故障及其他内部错误返回 500 internal_error，不返回局部成功或丢弃非法属性。 |
| TP12 | 网页保持只读 PR 展示和原有视觉；通用读取保留缺失与空值，PR 展示本身可把缺失和空列表显示为同一空态。 |

## 属性对象与值

~~~json
{
  "properties": {
    "pullRequests": [
      {"url":"https://github.com/owner/repo/pull/123","title":"实现登录接口"},
      {"url":"any caller-supplied text","title":""}
    ]
  }
}
~~~

properties:{} 表示没有属性；properties:{"pullRequests":[]} 则保留一个值为空数组的属性。当前 pullRequests 不接受 null，worker 如果存在必须是归属对象；worker 内部允许的 herdr:null、nativeSessionId:null 仍有各自业务含义。

PR 项只允许 url/title 两字段，两者均必填。嵌套未知字段、重复 JSON key、缺项或错误类型返回 400 invalid_input。结构校验不增加字符串业务要求。JSON 转义写法、对象键序和缩进不是值的差异；既有解码器对错误 Unicode surrogate 的处理保持已解码的原有语义。

## 属性 HTTP 资源

| 方法与路径 | 输入与结果 |
|---|---|
| GET /api/v1/task-properties/schema | 要求身份认证，返回全服务共享的属性定义目录，不要求项目或 Git 仓库 |
| GET /api/v1/projects/{projectId}/tasks/{taskId}/properties | 按父项目和任务可见性返回 PropertyResource |
| PUT .../properties/{name} | 正 int64 version、原始 valueText；设置一个完整属性值，返回 200 PropertyResource |
| DELETE .../properties/{name} | 正 int64 version；真正移除一项属性，返回 200 PropertyResource |

PropertyResource 包含 projectId、taskId、version 和完整 properties。目录包含属性名称、说明、readOnly 和真实值 schema，不声明读取时自动生成的默认值。所有入口沿用认证、项目权限、no-store 和 requestId 规则。

PUT 的 valueText 是未经 CLI JSON 解析的原始参数文本：

~~~json
{"version":42,"valueText":"[{\"url\":\"https://github.com/owner/repo/pull/123\",\"title\":\"修复同步\"}]"}
~~~

字符串类型的属性接受 JSON 字符串并解码；其它输入原样作为字符串，所以 123、true、null 在字符串属性上也可表达对应文本。非字符串属性要求一个完整 JSON 值，再按其定义校验；重复键、非法 JSON、尾随值和错误类型拒绝。当前没有公开可写字符串属性，通用解释规则不增加新的产品属性。

请求必须是 UTF-8 application/json，整个 JSON 外壳沿用 1 MiB 上限。version/valueText 的字段和二次转义都计入上限，这不是属性内容大小额度。不另设 PR 条数或字符串长度上限。完整读取继续受既有客户端响应预算约束，超限明确失败而不截断。

## 创建、设置和移除

创建省略 properties 或其中的键时，不创建对应属性行。普通 create/PATCH 仅接受可写定义，提供 worker 即使值为 null 或与现值相同也拒绝。worker 生命周期操作保留所有其他属性，公开属性更新保留 worker。

| 输入或操作 | 结果 |
|---|---|
| PATCH 省略 properties | 保留全部属性 |
| PATCH properties:{} | 没有属性修改意图；整个请求没有其他可修改字段时拒绝 |
| 提供 pullRequests 数组 | 替换完整数组，不隐式追加、合并或逐项删除 |
| 提供 pullRequests:[] | 属性存在，值为空列表 |
| DELETE 已存在的可写属性 | 删除属性记录，响应不包含该键 |
| DELETE 已缺失的已知可写属性 | 精确版本下成功 no-op；陈旧版本仍冲突 |
| 提供 JSON null | 只有定义允许时作为实际值保存，从不表示删除 |
| 设置或移除未知/只读属性 | 400 invalid_input，包括已经缺失的只读属性 |

所有已知有效修改先检查任务 version，再判断 no-op。对象键序、缩进和等价转义不产生变化；PR 顺序变化属于真实变化。真实变化与同次普通字段、依赖变化只增加一次版本。任何拒绝或持久化失败均完整回滚；属性关联本身不改变 task 状态、依赖或 ready。

超时或响应丢失可能发生在提交后。调用者不得自动重放修改，应读取完整任务或属性资源，再对当前值和版本作新决定。当前值只能证明当前状态，不能证明某次未知操作的历史结果。

## CLI

~~~text
daynight task properties <task-id> [--json] [--project <project-id>]
daynight task properties --schema [--json]
daynight task set-property <task-id> <property> <value> [--if-version <version>] [--project <project-id>]
daynight task remove-property <task-id> <property> [--if-version <version>] [--project <project-id>]
~~~

properties 恰好选择 task ID 或 --schema 一种模式；同时给出、均未给出或 schema 模式附带 --project 是语法错误。schema 直接使用认证服务定义，不进行项目或 Git 发现；完整 Task 仍可通过 task show 查看。

属性名称是完整、区分大小写的字面名称，点号不表示嵌套路径。独立 . 或 .. 若在 URL 规范化中改变资源路径，CLI 在发请求前报告传输错误；不把它转为另一个名称。CLI 不维护名称白名单、不下载 schema 预校验值，也不执行 JSON.parse；服务端拥有类型、结构与只读限制。公开 worker 修改仍拒绝，通用命令不开放自定义属性。

set-property 替换一个完整属性值，value 参数原样编码进 valueText 外壳。默认 JSON 及字符串属性的原始文本规则由服务端解释。空 value 可作为参数提交；以短横线开始的位置参数使用 -- 终止选项解析，选项放在终止符之前。移除真正删除属性，与设置 [] 区分。

~~~bash
daynight task properties --schema --json
daynight task properties <task-id> --json
daynight task set-property <task-id> pullRequests '[{"url":"https://github.com/owner/repo/pull/123","title":"修复同步"}]' --if-version <observed-version>
daynight task set-property <task-id> pullRequests '[]' --if-version <observed-version>
daynight task remove-property <task-id> pullRequests --if-version <observed-version>
~~~

create/update 不提供 PR 专用选项。创建后的属性通过通用设置命令维护；原生 HTTP create/PATCH 的原子多字段能力保留。设置 PR 时提交完整有序数组，保留仍需要的所有关联。

显式 --if-version 直接提交；省略时先 GET 属性资源取得任务版本，再提交一次修改。版本冲突不重试；预读不能替代先前决定所依据的版本，不确定结果只读回核对后重新决定。

读取 --json 返回完整 PropertyResource 或定义目录；普通读取按名称打印完整属性 JSON，所有输出使用既有终端安全转义。set/remove 成功后输出服务确认的当前 PropertyResource，不推测 no-op 的额外结果字段。非法属性值和非法存储属性的服务端 400 保持操作失败，不改成 CLI 语法错误；数据库故障仍保持 500。所有读取均不补默认值、不截断或静默丢键。

操作系统不能承载的进程参数可通过 HTTP API 提交；传输限制不产生 URL/title 内容规则。[CLI 需求](daynight-project-task.md)拥有共享语法、补全和完整命令契约。

## 网页详情

详情在描述后显示“关联 PR”区域、总数及有序列表。缺失 pullRequests 与空数组均显示既有空态；通用属性对象仍保留两者区别。格式非法或读取失败走错误态，不能以空列表掩盖。

完整 PR 数组保留在内存中，每页最多挂载 100 项；超过时提供范围/总数、前后页和直接页码选择。分页不发请求，任务或有序集合变化重置页码，相同内容刷新保留当前页及焦点。重复项分别呈现，空字符串使用展示性空值标记，长文本换行。

全部内容作为文本显示并可选择、复制；仅绝对 HTTP(S) 地址可提供隔离新标签页导航，使用 noopener noreferrer。页面不解释 HTML、不抓取 PR 信息，不改变服务端字符串接受规则。网页编辑、按 PR 筛选和远端 PR 状态同步有各自的产品契约。

## 存储与升级

每个 task/property 对应独立记录，值保存为完整 JSON 文本。属性记录没有独立版本、更新时间或删除标记，任务仍是鉴权、并发和提交单位。任务软删除保留其属性数据。

迁移包含软删除任务，保留所有已有 pullRequests 值，包括无法区分来源的空数组；非 null worker 保存归属，worker:null 转为缺失。迁移冻结旧格式验证和规范化语义，不通过运行时 fallback 读取旧列。表创建、数据转换、旧列删除及 migration ledger 原子提交，任务版本、业务时间和 Session 身份不变。

客户端通用属性解析及 Web 缓存同时升级。模型切换通过 schema 1→2 清理旧必填/null 详情；完整属性同步通过 schema 2→3 或直接 1→3 重建摘要、详情和项目水位并轮换 user fence。旧摘要不能把缺少 properties 解释为 {}。snapshot/delta 按任务整体版本替换完整属性，缺失键传播删除，同版本属性差异拒绝，旧响应不复活删除键；普通属性变化不轮换 epoch。图绘制投影去掉属性，详情保持 live GET 的权限准入规则。完整行为由[任务缓存需求](daynight-task-sync.md)拥有。

## 错误与验收

属性值校验错误保留可识别的类型与错误链。HTTP 的属性、完整任务、列表、task-sync 及实际读取属性的修改入口返回 400 invalid_input；查询、连接和事务等数据库故障仍返回 500 internal_error。批量读取遇到坏值时整个请求失败，不返回部分集合，不输出属性值到诊断。迁移遇到非法旧数据中止并回滚，没有 HTTP 状态码。

| 编号 | 可观察结果 |
|---|---|
| TP-V1 | 多项、重复、空字符串、控制字符、NUL、Unicode、长文本及任意 URL 文本在 HTTP、数据库、重启、CLI 与网页间保持原有已解码语义。 |
| TP-V2 | 未知/只读属性写入、嵌套未知字段、重复 key、尾随值、错误类型、非法 null 和缺失必填项由服务端拒绝。 |
| TP-V3 | 初始 {}、省略、显式 []、实际删除、重复删除、no-op、重排及过期版本符合存在性和版本规则。 |
| TP-V4 | 同版本并发写只提交一个；混合字段/依赖/属性失败完整回滚，父任务锁维持 Worker/Session 身份隔离。 |
| TP-V5 | 历史库和软删除数据迁移不丢失 PR、归属或 Session 身份，旧空数组保留、null worker 缺失，版本时间和历史校验和不变，坏行原子回滚。 |
| TP-V6 | CLI 的值/schema 模式、原始值文本、空值、-- 参数、精确版本和补全一致；读写不预取 schema，未知/只读/错误值到达服务端，完整输出不丢键。CLI/Web 不补默认值，精确外壳版本不影响属性内同名 version，旧详情缓存不能造成同版本冲突。 |
| TP-V7 | PR 展示覆盖缺失、空、重复、空标题、长内容和不可导航地址，以及 100/101 项分页、末页、替换重置、焦点和窄屏。 |
| TP-V8 | 列表保留分页和快照语义；snapshot/delta 同快照批量读取完整属性并传播删除；图节点不承载属性。非法存储属性返回 400，数据库故障返回 500；网络/配额失败不截断、局部提交或推进水位，旧摘要升级完整重建。 |
