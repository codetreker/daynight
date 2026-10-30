# Task 预定义属性需求

状态：服务端通用属性模型、独立存储、属性 HTTP 资源与客户端读取适配已实现。本文拥有属性的行为与验收；[架构设计](../design/daynight-task-properties.md)解释机制与取舍。现有 [server](daynight-server.md)、[CLI](daynight-project-task.md) 和[看板](daynight-web.md)需求继续拥有各自入口。

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
| TP7 | 服务端提供认证的属性定义目录及项目范围的属性读取、设置和移除资源；值解释与属性校验只由服务端负责。 |
| TP8 | worker 有记录时必须是合法归属对象，没有保留归属时缺失；公共创建、PATCH、属性设置和属性移除均不能写 worker。 |
| TP9 | 完整单项、分页列表和修改结果保留全部属性；图与时间窗口摘要继续使用各自精简投影。 |
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

现有 task create/update 继续使用成对的 --pull-request-url 与 --pull-request-title，按出现位置组成完整 PR 列表，字符串不拆分、不去重、不 trim。update 的 --clear-pull-requests 写入显式空数组，不等同于删除属性。现有版本、配对、互斥和终端参数规则由 [CLI 需求](daynight-project-task.md)拥有。

CLI 通用属性数据读取和资源输出保留全部键；业务字段解析在使用 PR 或 worker 的功能处进行。JSON 输出保留缺失状态，不加入显示占位值；人类输出使用现有终端可见转义。操作系统不能承载的进程参数可通过 HTTP API 提交，传输限制不产生 URL/title 内容规则。

## 网页详情

详情在描述后显示“关联 PR”区域、总数及有序列表。缺失 pullRequests 与空数组均显示既有空态；通用属性对象仍保留两者区别。格式非法或读取失败走错误态，不能以空列表掩盖。

完整 PR 数组保留在内存中，每页最多挂载 100 项；超过时提供范围/总数、前后页和直接页码选择。分页不发请求，任务或有序集合变化重置页码，相同内容刷新保留当前页及焦点。重复项分别呈现，空字符串使用展示性空值标记，长文本换行。

全部内容作为文本显示并可选择、复制；仅绝对 HTTP(S) 地址可提供隔离新标签页导航，使用 noopener noreferrer。页面不解释 HTML、不抓取 PR 信息，不改变服务端字符串接受规则。网页编辑、按 PR 筛选和远端 PR 状态同步有各自的产品契约。

## 存储与升级

每个 task/property 对应独立记录，值保存为完整 JSON 文本。属性记录没有独立版本、更新时间或删除标记，任务仍是鉴权、并发和提交单位。任务软删除保留其属性数据。

迁移包含软删除任务，保留所有已有 pullRequests 值，包括无法区分来源的空数组；非 null worker 保存归属，worker:null 转为缺失。迁移冻结旧格式验证和规范化语义，不通过运行时 fallback 读取旧列。表创建、数据转换、旧列删除及 migration ledger 原子提交，任务版本、业务时间和 Session 身份不变。

客户端通用属性解析及 Web 缓存同时升级。模型切换清理旧必填/null 详情及其水位；不能把不同属性内容伪装成同一版本的有效缓存。摘要仍不携带 properties，详情保持 live GET 的权限准入规则。

## 错误与验收

属性值校验错误保留可识别的类型与错误链。HTTP 的属性、完整任务、列表及实际读取属性的修改入口返回 400 invalid_input；查询、连接和事务等数据库故障仍返回 500 internal_error。批量读取遇到坏值时整个请求失败，不返回部分集合，不输出属性值到诊断。迁移遇到非法旧数据中止并回滚，没有 HTTP 状态码。

| 编号 | 可观察结果 |
|---|---|
| TP-V1 | 多项、重复、空字符串、控制字符、NUL、Unicode、长文本及任意 URL 文本在 HTTP、数据库、重启、CLI 与网页间保持原有已解码语义。 |
| TP-V2 | 未知/只读属性写入、嵌套未知字段、重复 key、尾随值、错误类型、非法 null 和缺失必填项由服务端拒绝。 |
| TP-V3 | 初始 {}、省略、显式 []、实际删除、重复删除、no-op、重排及过期版本符合存在性和版本规则。 |
| TP-V4 | 同版本并发写只提交一个；混合字段/依赖/属性失败完整回滚，父任务锁维持 Worker/Session 身份隔离。 |
| TP-V5 | 历史库和软删除数据迁移不丢失 PR、归属或 Session 身份，旧空数组保留、null worker 缺失，版本时间和历史校验和不变，坏行原子回滚。 |
| TP-V6 | CLI/Web 通用读取不丢键、不补默认值；精确外壳版本不影响属性内同名 version，旧详情缓存不能造成同版本冲突。 |
| TP-V7 | PR 展示覆盖缺失、空、重复、空标题、长内容和不可导航地址，以及 100/101 项分页、末页、替换重置、焦点和窄屏。 |
| TP-V8 | 完整列表保留分页和快照语义；图与摘要保持精简投影；非法存储属性返回 400，数据库故障返回 500，预算失败不截断数据。 |
