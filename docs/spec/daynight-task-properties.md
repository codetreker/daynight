# Task 预定义属性需求

状态：服务端存储、迁移、HTTP 读写、CLI 属性操作与只读网页展示已实现。本文定义 task
预定义属性的行为；
[架构设计](../design/daynight-task-properties.md)拥有机制与取舍。
现有 [server](daynight-server.md)、[CLI](daynight-project-task.md) 和
[看板](daynight-web.md)需求继续拥有各自的已交付基线。

## 目标与范围

Task 使用 server 预定义且有明确结构的属性。pullRequests 保存任务关联的 PR，允许公共创建/更新；worker 保存服务端保护的执行归属，其中 signaling 是允许公共更新的需要处理信号，具体归属规则由[认领架构](../design/daynight-worker-claims.md)拥有。属性定义随 server 代码发布；未知属性和受保护字段的公共写入作为输入错误拒绝。

| 编号 | 必需行为 |
|---|---|
| TP1 | Task 完整资源包含 properties.pullRequests 有序数组和必填 worker:null 或执行归属；每个 PR 含字符串 url 与 title，非 null worker 必含字符串 signaling。 |
| TP2 | 每个 task 可以关联多个 PR，允许跨仓库；相同项可以重复出现，顺序属于数据。 |
| TP3 | Server 保存解码后的字符串内容，保留空字符串、空白、大小写、控制字符和重复项；不做 URL 格式、PR 存在性、仓库匹配、标题内容校验或内容转换。 |
| TP4 | 创建与更新 task 支持属性；属性、普通字段及依赖在现有 task 事务内原子提交。 |
| TP5 | 属性更新沿用 task 的 `version`，无变化更新保留版本与时间，真实变化只增加一次版本。 |
| TP6 | 单项读取、分页列表及创建/更新结果返回完整属性；完整图与同步摘要只投影 workerNeedsAttention，不携带完整属性或执行身份。 |
| TP7 | CLI 支持通用属性读取、单属性设置与移除，属性路径和输入文本由服务端按属性类型解释并校验；输出完整原始属性资源，保留未知字段与精确数值。原有 PR 列表参数保留。 |
| TP8 | 网页详情展示每个 PR 的标题和地址；非空 signaling 在列表、任务链、图节点和详情明确高亮“需要处理”，详情展示原文。 |
| TP9 | 已有 task 通过数据库迁移获得空 PR 列表，迁移保持其版本、创建时间与更新时间。 |

## 数据结构

```json
{
  "properties": {
    "pullRequests": [
      { "url": "https://github.com/owner/repo/pull/123", "title": "实现登录接口" },
      { "url": "any caller-supplied text", "title": "" }
    ],
    "worker": null
  }
}
```

`url` 与 `title` 都必须出现且类型为字符串；空字符串是有效值。每项只有这两个
已定义字段。`properties` 必须是对象，`pullRequests` 必须是数组，每项必须是对象。
嵌套的未知字段、重复 JSON key、`null`、缺失的必填项或错误类型均返回
`400 invalid_input`。这属于数据结构校验，不赋予字符串业务合法性要求。

沿用现有单个 JSON 对象、UTF-8 请求体与 1 MiB 请求字节上限；不增加 PR 条数或
字符串长度上限。字符串语义基于现有 HTTP JSON 解码结果，JSON 转义写法与对象
key 顺序不属于持久化数据；既有解码器对错误 Unicode 转义的处理保持原有语义。

## 创建与更新

创建时，省略 properties 或 pullRequests 得到空 PR 数组，并创建 worker:null。所有完整 task 响应始终返回两字段，不能缺失；只有 worker 本身允许 null。公共 create 提供 worker 时，即使为 null 也返回 invalid_input。公共 PATCH 仅允许 `worker:{"signaling":"..."}`，其他 worker 字段、null 或完整归属对象仍返回 invalid_input。执行属性更新、signaling 与普通 PR 更新相互保留；worker 的状态及会话结构由[认领架构](../design/daynight-worker-claims.md)拥有。

PATCH 继续要求正整数 `version`，并按以下规则处理：

| 输入 | 结果 |
|---|---|
| 省略 `properties` | 保留全部属性 |
| `"properties": {}` | 没有属性修改意图；单独与 version 提交时因没有可修改字段而拒绝 |
| `"properties": {"pullRequests": [...]}` | 替换完整 PR 列表 |
| `"properties": {"pullRequests": []}` | 清空 PR 列表 |
| `"properties": {"worker": {"signaling": "需要人工决定"}}` | 更新现有 worker 的需要处理信号 |
| `"properties": {"worker": {"signaling": ""}}` | 清空现有 worker 的信号 |

公共属性 patch 只接受已出现的可写字段；省略字段表示保留，worker 中除 signaling 之外的字段始终由受控归属操作维护。
不按数组项做隐式合并、追加或删除。逐项比较 `url`、`title` 及数组顺序，判定是否
真实变化；交换顺序属于变化，等值列表属于无变化。过期版本始终返回
`409 version_conflict`，即使列表值与当前值相同。

现有依赖和状态约束仍校验完整候选 task；任何拒绝、取消或持久化失败都保留原有
字段、依赖、属性、版本与时间。PR 关联本身不改变 task 状态、依赖或 ready。

## 需要处理信号

`properties.worker.signaling` 是必填字符串。空字符串表示没有需要处理的提示；任何非空字符串，包括仅含空白的字符串，都表示需要人关注。服务端原样保存内容，不 trim、不解释内容，也不根据 task 状态、allowAgents 或 worker 阶段隐藏已保存的信号。新认领的信号为空；已有非 null worker 通过数据库迁移补齐空字符串，保持任务版本与时间。worker 为 null 的任务不能设置 signaling，返回 invalid_input。

更新沿用任务精确 version；同值保留版本和更新时间，真实变化增加一次版本，过期版本始终冲突。状态、计时、PR、执行身份及其他 worker 摘要字段保持；普通进度上报不能清除信号。完整图与同步摘要返回必填布尔 `workerNeedsAttention`，严格表示 worker 非 null 且 signaling 非空。

Web 的独立任务行、任务链子行和图节点在非空时显示“需要处理”/“Needs attention”并高亮；折叠任务链仍提示成员中有需要处理的任务。详情的同一提示展示原始信号内容，作为文本换行，长内容不能撑宽窄屏。清空后撤下提示。worker 调度器从当前归属清单读取该值，非空时停止常规 ping，包括 agent 从 working 进入 idle/done 之后；清空后恢复已有巡查条件。首次任务输入、执行恢复和终止清理沿用既有规则。

## 属性资源与单属性设置和移除

以下路径位于 `/api/v1/projects/{projectId}/tasks/{taskId}`，沿用任务成员访问、no-store、请求大小限制及严格 JSON 规则。

| 方法和后缀 | 请求与结果 |
|---|---|
| GET `/properties` | 返回 `200` 与 `{version:"<正 int64 十进制>",properties:<完整属性对象>}`，包含只读 worker 字段。 |
| PUT `/properties` | 请求为 `{version:<正 int64 数字>,property:<原始属性名字符串>,value:<原始输入文本字符串>}`；成功返回 `200` 和同样的属性资源。 |
| DELETE `/properties` | 请求为 `{version:<正 int64 数字>,property:<原始属性名字符串>}`；将属性清除为声明默认值，成功返回 `200` 和同样的属性资源。 |

`property` 作为 PUT/DELETE 请求体中的原始字符串传递，由服务端解析点分路径，例如 `pullRequests` 或 `worker.signaling`。服务端以共享属性定义作为唯一可写目录、类型与移除默认值的所有者，复用类型与受保护字段校验；空路径、未知路径、受保护字段、错误类型和缺项均明确拒绝。value 必须是字符串；服务端按目标类型解释其内容：字符串属性接受原始文本或 JSON 字符串，JSON 字符串解码后保存；数组等结构化属性要求对应类型的合法 JSON，解析失败明确拒绝。设置 `worker.signaling` 仍要求已有 worker。移除将当前必填属性重置为其声明默认值：worker.signaling 为空字符串，pullRequests 为空数组，不删除响应中的必填字段。worker 整个分支、未知路径及受保护字段不能移除；移除 signaling 仍要求已有 worker。同值移除是无变化操作。一次请求只设置或清除指定属性，其他属性与任务资料保持；同值、精确版本冲突、原子提交和失败回滚沿用任务更新语义。属性资源的 version 是任务原有版本的十进制字符串，没有独立属性版本。

## CLI

`task get-properties <task-id>` 读取完整属性资源；`task set-property <task-id> <property> <value>` 设置一个属性；`task remove-property <task-id> <property>` 清除为声明默认值。三个命令使用既有项目选择与服务配置。value 位置参数作为原始文本写入请求的字符串 value，CLI 只把属性名和值做 JSON 字符串编码，不解析或校验属性名、点分路径、属性结构、值类型或 JSON 内容，由服务端统一判断。未来服务端增加属性或 worker 字段时，通用命令无需同步属性目录。

```bash
daynight task get-properties "$TASK_ID"
daynight task set-property "$TASK_ID" worker.signaling '请确认'
daynight task set-property "$TASK_ID" worker.signaling '"请确认"'
daynight task set-property "$TASK_ID" worker.signaling ''
daynight task set-property "$TASK_ID" worker.signaling '""'
daynight task remove-property "$TASK_ID" worker.signaling
daynight task set-property "$TASK_ID" pullRequests '[{"url":"https://github.com/owner/repo/pull/123","title":"登录接口"}]'
```

set-property 与 remove-property 支持 `--if-version`：提供时直接使用该精确正 int64，不读取最新值；省略时先调用 get-properties，只读取 version 元数据后提交一次 PUT 或 DELETE。冲突及不确定结果不自动重试写入。三个命令的成功响应均按原始 JSON 文本输出，不经当前客户端的属性 schema 读取或重新序列化，保留未来字段、只读归属和大整数的原始表示。

`task create` 和 `task update` 接受可重复的 `--pull-request-url <text>` 与
`--pull-request-title <text>`。第 n 个 URL 对应第 n 个标题，两者出现次数必须相等；
允许 `--pull-request-title=` 和 `--pull-request-url=`。配对检查在配置、Git 和
网络访问之前完成。选项使用既有文本传参规则，不拆分、不去重、不 trim。

提供一组或多组配对表示提交完整列表。Update 另有 `--clear-pull-requests`，与任一
配对选项互斥；没有 PR 选项时省略属性 patch。保留 `--if-version` 及冲突后不重试
的既有行为。文本输出按序显示各项的标题与 URL，控制字符沿用终端可见转义；JSON
输出包含完整原值。操作系统或原生 shell 启动器无法承载的字符串可以通过 HTTP API
提交；这些传输限制不产生 URL/title 内容校验规则。

## 网页详情

详情对话框在描述后显示“关联 PR”区域、总数量及有序列表，分别展示标题和 URL。
完整属性保留在内存中，每页最多挂载 100 项；超过 100 项时提供范围/总数、上一页、
下一页和直接页码选择，所有项均可按原顺序访问，不增加网络请求。任务或属性集合
替换时回到第一页，分页操作保持可访问焦点。重复项分别呈现；空字符串用展示性
空值标记表达，长文本换行且不会撑宽页面。全部内容作为
文本呈现，保持可选中和复制；正常 HTTP(S) 地址可另提供“打开”入口。

导航入口仅用于浏览器可以识别的绝对 HTTP(S) 地址，使用新标签页与
`noopener noreferrer`。其他字符串仍完整显示并可保存。导航资格是页面的执行策略，
不影响 server 接受、存储或返回任何字符串。页面不解释 HTML、不抓取 PR 内容。

空列表显示“暂无关联 PR”；读取失败沿用详情错误态，不能显示为空列表。详情刷新
或重新打开时读取当前属性，图刷新提示继续遵循既有快照与详情的时间比较。网页
编辑、按 PR 筛选/排序和 PR 状态同步属于独立能力。

## 验收

| 编号 | 可观察结果 |
|---|---|
| TP-V1 | 多项、重复项、空字符串、空白、控制字符、中文、长文本及任意地址文本在 HTTP、持久化、重启、CLI JSON 与网页详情之间保持约定语义。 |
| TP-V2 | 嵌套未知字段、重复 key、null、错误类型和缺失 url/title 均拒绝；请求体限制沿用既有行为。 |
| TP-V3 | 创建默认空列表；更新省略、空对象、替换、清空、无变化、重排和过期版本均符合本文约定。 |
| TP-V4 | 同一版本并发更新仅一个成功；混合字段/依赖/属性更新在拒绝、取消与数据库失败时完整回滚。 |
| TP-V5 | PR 与 worker:null 迁移保留原有字符串、版本与时间，后续重启不重复迁移；坏的属性存储值暴露读取错误，读取不默认补齐缺失 worker。 |
| TP-V6 | CLI 配对、互斥、空值、横线开头值、帮助及补全与既有参数语义一致，参数错误先于 I/O。 |
| TP-V7 | 网页覆盖空、单项、多项、重复、空标题、长文本及不可导航地址，以及 100/101 项分页边界、末页、集合替换重置和完整原值；挂载项不超过 100，任意输入都不会作为脚本或 HTML 执行，焦点、关闭与窄屏交互保持有效。 |
| TP-V8 | 图响应只携带 workerNeedsAttention 投影而不包含完整属性，列表保持分页与快照语义；既有请求、响应及命令预算仍被执行，超限明确失败。 |
| TP-V9 | signaling 设置、同值、清空、版本冲突及错误类型符合约定；迁移保留任务元数据和字符串，执行上报保留信号。Web 各入口在非空时显示需要处理并在清空后撤下，覆盖折叠链、双语和长文本窄屏；worker 在 working 转 idle/done、重启及观察等待期间收到信号后不再 ping，清空后恢复已有规则。 |
| TP-V10 | 通用 CLI 将已知/未知路径与原始值文本发送给服务端，服务端按类型统一解释与验证；字符串的原文/JSON 形式及两种空值形式等价，数组要求合法 JSON；显式版本零预读，隐式版本只读取属性版本，冲突不重试；原始响应保留未来字段和大整数。移除恢复声明默认值、同值不改版本和时间，未知/受保护/分支路径由服务端拒绝，CLI 保持原始输出。 |
