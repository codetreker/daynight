# Task Steps 资源契约

状态：持久化结构、完整集合与单项 HTTP 读取、集合添加、单项内容更新、独立状态设置、位置移动、记录删除、CLI list/show 读取及 Web 阅读已实现。本文拥有当前可用的 Steps 行为；Task 的常规读取、列表、图和同步保持各自资源投影。

## 所有权与模型

Steps 是父 Task 拥有的有序记录，保留独立名称、Markdown 说明、通用状态和内容时间。记录独立于 Session、Controller 和 Worker，在服务重启后保持。项目决定其名称、粒度和流程；系统不会生成默认阶段，也不从步骤状态推导 Task 可交付性或 review 结论。

| 字段 | 资源结果 |
|---|---|
| `id` | 恰好 8 位小写十六进制字符串，在一个 Task 内唯一；保留前导零，`00000000` 合法。 |
| `title` | 完整原值，至少包含一个非 Unicode `White_Space` 字符；允许重复名称。 |
| `description` | 完整 Markdown 原值，空说明为 `""`。 |
| `status` | `todo`、`in_progress`、`done` 或 `skipped`。 |
| `createdAt` | UTC RFC 3339 时间，精确到持久化的微秒。 |
| `updatedAt` | UTC RFC 3339 内容或状态更新时间，精确到持久化的微秒。 |

标题和说明必须是无 NUL 的有效 UTF-8，原有空白、换行和 Unicode 字符保持。U+FEFF 是合法标题字符，只有 U+0085 的标题无效。读取不得补造字段、改写空白或跳过损坏行。存储位置只由集合数组顺序公开，不是身份或执行时间。四种 Step 状态独立于 Task 的三种整体状态，`done` 不表示业务审查通过。

## 独立 HTTP 资源

以下 `T` 表示 `/api/v1/projects/{projectId}/tasks/{taskId}`。Project 与 Task 使用完整 UUID，Step 输入接受大小写并规范化为小写；完整 UUID、短前缀和展示编号均不能作为 Step ID。Step 身份与位置锚点只在指定 Task 中解释，不跨 Task 查找同值 ID。

| 方法与路径 | 输入 | 成功结果 |
|---|---|---|
| `GET T/steps` | 无 query。 | `200`，完整有序 `StepsResource`。 |
| `GET T/steps/{stepId}` | 无 query。 | `200`，完整 `StepResource`。 |
| `HEAD` 对应上述路径 | 无 query。 | 相同状态、类型及身份回执，不返回正文。 |
| `POST T/steps` | `version`、`id`、`title`；可选 `description`、`status`、`before` 或 `after`。 | `201`，完整有序 `StepsResource`；`Location` 指向新增项的规范单项路径。 |
| `PATCH T/steps/{stepId}` | `version`；`title`、`description` 至少提供一个。 | `200`，完整有序 `StepsResource`。 |
| `PUT T/steps/{stepId}/status` | `version`、`status`。 | `200`，完整有序 `StepsResource`。 |
| `PUT T/steps/{stepId}/position` | `version`；`before`、`after`、`position` 恰好一个，`position` 为 `first` 或 `last`。 | `200`，完整有序 `StepsResource`。 |
| `DELETE T/steps/{stepId}` | JSON 正文仅含必填 `version`。 | `200`，删除后的完整有序 `StepsResource`，末项删除返回 `steps: []`。 |

所有 Steps 请求均不接受 query，包括尾部空 `?`。集合的其他方法返回认证后的 `405` 和 `Allow: GET, HEAD, POST`；单项的其他方法返回认证后的 `405` 和 `Allow: GET, HEAD, PATCH, DELETE`；状态与位置子路径只接受 `PUT`，其他方法（包括 `HEAD`）返回认证后的 `405` 和 `Allow: PUT`。所有响应使用 `Cache-Control: no-store`，沿用认证、Cookie 写请求的 Origin 检查、principal 回执及 request ID。

完整集合如下，`version` 是父 Task 的正 int64 精确十进制整数，不能转为丢失精度的浮点数：

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "taskId": "00000000-0000-4000-8000-000000000002",
  "version": 9007199254740993,
  "steps": [
    {
      "id": "00abcdef",
      "title": "Review 第 1 轮",
      "description": "## 结果\n需修改的问题保留在说明中。",
      "status": "done",
      "createdAt": "2026-11-03T10:11:12.123456Z",
      "updatedAt": "2026-11-03T11:12:13.654321Z"
    }
  ]
}
```

单项结果具有相同 `projectId`、`taskId` 和 `version`，以 `step` 字段返回一个完整记录。空集合必须为 `steps: []`，不能为 `null`、缺失或读取失败的替代结果。Task 的 show/list/ready/graph/task-sync 不内嵌完整 Steps。

## Web 阅读

弹窗与独立 Task 详情始终提供位于概览之后的 Steps 页签，不依赖 Session、自动执行许可或 Task 状态。`tab=steps` 支持独立深链接、刷新和 Back/Forward；保留附件路径的 Steps 链接仍使用同一 Task 身份。页签沿用 roving tabindex、Arrow/Home/End 和隐藏面板的 `inert`。

Steps 首次激活才读取完整集合。加载、合法空集合、首次错误和保留内容的刷新失败分别表达；错误保留安全说明与可信 request ID，并提供重读。未得到有效资源前不显示零项事实。现有 Web 能力只开放刷新、展开和分页，状态作为真实业务信息显示；添加、编辑、状态修改、移动和删除尚无 Web 入口。

列表按服务端完整顺序显示全局编号、完整标题、四状态和规范短 ID。多项可同时展开，展开身份按稳定 ID 保持，跨页、同 Task 页签往返、语言切换和刷新重排不改绑到其他记录。正文复用 Task-root Markdown、安全 URL 规则及同一个附件 controller，展示创建与更新时间；空说明明确显示空态。

完整集合只留在当前详情会话内存，不进入 TaskDetail LRU、IndexedDB、Task 投影或同步水位。摘要、父详情或父修改回执推进版本后，活动视图失效并合并重读；未激活时不为 Steps 发请求。只在同一身份与缓存 generation 下接纳不低于已知父版本下限的资源，超前响应等待摘要准入，过期或晚到响应不能替换新事实。同版本不同内容为协议错误。最后一个需要集合的视图退订时释放完整数组及未准入响应，重新激活按需读取。

集合读取的 404 先在相同身份下读取父 Task 核验；父仍可读时保留 Steps 错误，不据此撤销项目。403 表达实际拒绝，可信父 404 才沿用权限 retirement，父 410 显示已删除。确认身份、项目权限或父资源失效立即清除本项私有资源。

每页最多挂载 100 行；超过 100 项才显示全局范围、前后页和数值页码，不随总页数生成 option 列表。分页不发服务请求，不截断内存数据，刷新后页数缩小时显示仍存在的页。中英文只改变界面文案；320px 下控件可达且不撑宽页面，Markdown 代码和表格在自身区域滚动。

## CLI 读取

```text
daynight task step list <task-id> [--json] [--project <project-id>]
daynight task step show <task-id> <step-id> [--json] [--project <project-id>]
```

`daynight` 与 `dn` 使用相同入口。Task 与 Project 为完整 UUID；Step 是恰好 8 位十六进制 ID，输入大小写统一为小写，不接受完整 UUID、短前缀或展示编号。显式 `--project` 可在 Git 仓库外直接读取指定资源，不增加隐藏的项目 GET；省略时复用当前仓库的项目发现：完整发现后无匹配报告 `Project does not exist`，多匹配列出全部规范项目 ID 并提示显式 `--project <id>`；两者均终止读取，不把未选定的候选当作当前项目。诊断保留这些预期恢复结果，同时隐藏任意配置、Git、网络或清理原因文本。组与操作帮助先于配置、Git 和网络执行；参数错误使用退出码 `2`，读取或协议失败使用 `1`，成功使用 `0`。

`list` 读取一次完整集合并保留服务数组顺序，可读输出包含父 Task 版本、总数，以及每项的展示编号、完整 ID、四状态和完整标题；空集合明确显示零项。`show` 读取 Task 内指定 Step，完整显示标题、说明、状态、创建/更新时间及父作用域与版本，不截断说明。可读字段将终端控制字符和 bidi 控制符转义为可见文本，JSON 保留原字符串、字段和精确 int64 数值；`list --json` 输出完整 `StepsResource`，`show --json` 输出完整 `StepResource`，不是裸数组或正文片段。

读取结果拒绝未知或重复字段，必须具有完整的必填字段、正确的 Project/Task/Step 作用域、正 int64 父版本、唯一且已规范为小写的短 ID、合法状态、原值文本与 UTC 微秒时间字符串；不能将坏响应修成合法资源、跳过条目、重排集合或将失败显示为空集合。成功时 JSON stdout 仅包含一个完整值并以换行结束；错误写 stderr，`401` 提示 `daynight login`，不自动登录或重放。读取继承共享取消、期限与响应字节预算，单次 Steps 响应正文另受 64 MiB 资源上限约束；有效上限取配置的单响应预算与该资源上限的较小值，恰好达到上限允许，更严格的配置限制继续生效，共享默认预算不变。在完整校验与渲染成功前不输出部分资源；输出本身失败可能留下部分 stdout，必须同时非零退出并报告错误。

帮助、Bash/zsh 补全及独立 CLI 手册仅列出 `list` 与 `show` 读取能力。完整项目选择、错误和输出约定由[客户端要求](daynight-project-task.md)拥有，命令实现与验证入口由[CLI 说明](../../packages/daynight/README.md#task-steps)拥有。

## 写入输入与添加结果

所有 Steps 写入只接受一个 UTF-8 JSON 对象，正文最多 1 MiB，`Content-Type` 为 `application/json`，可附带 UTF-8 charset。拒绝未知、重复或只读字段、字段名大小写不符、尾随 JSON、`null`、错误类型、无效 UTF-8、NUL 和孤立的转义 UTF-16 surrogate。有效 surrogate pair、原文 U+FFFD 和表示字面反斜线的 JSON 转义合法。

| 字段 | 添加语义 |
|---|---|
| `version` | 必填，范围为 `1..9223372036854775807` 的精确 JSON 整数；不是字符串、小数或指数表示。 |
| `id` | 必填，提交前已确定的 8 位十六进制身份，取 UUIDv4 第一段。大小写输入统一为小写；服务不替调用者生成或更换 ID。 |
| `title` | 必填，遵守模型中的原值文本规则。 |
| `description` | 省略时为 `""`；显式空字符串合法。 |
| `status` | 省略时为 `todo`；显式值必须是四种状态之一。 |
| `before` | 可选，插入该 Task 内指定 Step 之前。 |
| `after` | 可选，插入该 Task 内指定 Step 之后。 |

`before` 与 `after` 互斥。二者均省略时追加到末尾；锚点缺失明确拒绝，不转为追加或其他位置。相同标题可创建独立项；重复现存 ID 始终为冲突，不覆盖记录，也不视为重复请求成功。

例如请求 `{"version":12,"id":"00ABCDEF","title":"Review 第 2 轮","after":"12345678"}` 返回父版本 `13`、完整新顺序和 `Location: T/steps/00abcdef`。新增项的创建与更新时间相等，采用同一个数据库 UTC 微秒时间；父 Task 的更新时间采用该时间。现存 Step 仅按插入位置平移，全部内容、状态和内容时间保持。添加总是实际变化，不存在成功的无变化添加。

## 更新内容与设置状态

`PATCH T/steps/{stepId}` 仅接受 `version`、`title`、`description`。标题与说明至少提供一个；省略字段保留原值，`description: ""` 明确清空说明，标题遵守原值文本规则。两者同时提供时作为一次原子修改保存，任何失败不能只保留其中一项。`status`、`id`、位置、时间和添加锚点均不能通过 PATCH 修改。

`PUT T/steps/{stepId}/status` 仅接受 `version` 与必填 `status`，状态值为 `todo`、`in_progress`、`done` 或 `skipped`。四种状态之间可自由切换，允许多个 Step 同时处于 `in_progress`，父 Task 为 `done` 时仍可设置。状态操作不重置标题或说明。两种操作均以 Task 内规范化 ID 定位同一现存记录，成功返回 `200` 和完整集合，不返回新增 `Location`。

更新始终先检查精确父版本，再查找目标并比较请求字段的语义原值。当前同值 PATCH 和同状态 PUT 为 no-op：返回原完整集合，保留父版本、父更新时间和全部 Step 时间，包括父版本已达最大正 int64 的情况；不采样新时间，不执行目标 UPDATE 或父 touch。陈旧同值仍返回版本冲突，缺失目标仍为子项 404，均不能通过 no-op 绕过准入。

真实变化先检查版本耗尽，再使用数据库 UTC 微秒时间保存目标内容或状态；时间字段仅更新目标 `updatedAt` 和父 Task `updatedAt`，父版本只推进一次。目标 `createdAt`、身份和位置，以及其他 Step 的全部字段和时间保持。标题、Markdown 和空白按原值保存，不因比较而规范化。两种操作均在任何数据修改前对完整候选执行相同的精确容量预检；状态字符串变长也可能导致容量拒绝，缩小说明仍按完整资源和版本规则提交。

## 移动位置

`PUT T/steps/{stepId}/position` 仅接受 `version`，以及恰好一个 `before`、`after` 或 `position`。`before` 与 `after` 是同 Task 内另一 Step 的 8 位 ID；`position` 只接受字符串 `first` 或 `last`，不接受布尔型 `first`/`last` 字段。目标与锚点均按输入 ID 规则规范化，锚点不能引用目标自身，大小写不同的同值 ID 也属于自引用。

例如 `{"version":13,"after":"6F7A8B9C"}` 将目标移到该 Task 内 `6f7a8b9c` 之后；`{"version":14,"position":"first"}` 将目标移至首项。缺失目标或锚点返回子项 `404`，不会退回首尾或跨 Task 查找；自引用为 `400 invalid_input`。成功返回 `200` 和完整集合，不返回新增 `Location`。

移动仅调整现存记录的顺序，不复制、重建或修改记录内容。所有 Step 的 ID、标题、说明、状态、`createdAt` 和 `updatedAt` 均保持；公开排列由返回数组表达。受影响区间的位置写成最终稠密顺序，唯一约束在提交时验证，区间外的行不需要修改。

目标已在首项或末项、已紧邻指定锚点，或单项集合中的有效首尾移动均为 no-op：返回原完整资源并保留父版本和全部时间，不采样时钟、修改位置或 touch 父任务，最大正 int64 父版本仍可成功。陈旧版本仍先冲突；缺失目标或锚点不能作为 no-op。真实移动仅将父版本推进一次并更新父 `updatedAt`，先完成完整候选的精确容量预检，随后才修改受影响位置及父任务。

## 删除当前记录

`DELETE T/steps/{stepId}` 仅接受一个 JSON 对象，必填字段为 `version`；不接受 query、目标 ID 副本、状态或其他操作字段。目标以路径中的 Task 内规范化 ID 定位，所有四种 Step 状态均可删除。成功返回 `200` 和删除后的完整 `StepsResource`；删除最后一个记录时明确返回 `steps: []`，不使用 `204`、`null` 或省略集合，也不返回新增 `Location`。

删除移除当前行，并将其后仍存在的记录位置压紧为稠密顺序。所有其他 Step 的身份、标题、Markdown、状态、创建/更新时间及相对顺序保持；父 Task 业务字段、计时、依赖、属性、许可及 Worker/Session 归属保持，引用的附件、PR 和 Session 均不被删除。真实删除只将父版本推进一次并更新父 `updatedAt`。

当前目标不存在时，读取或重复删除均返回子项 `404 not_found`，不作为成功 no-op；陈旧版本仍先返回版本冲突，当前版本的目标缺失先于版本耗尽拒绝。存在目标的删除总是实际变化，父版本已达最大正 int64 时返回 `409 version_exhausted`。完整剩余候选在任何删除、位置压紧或父 touch 前通过同一公共 codec 的容量预检；预检拒绝或事务确认回滚时，完整前后状态保持。

删除结束该记录的身份存续期，并释放该 Task 内的短 ID 占用。后续可用 POST 明确创建相同 ID 的新记录，按添加规则生成新的创建与更新时间，不恢复已删内容。系统不提供已删 Step 的历史读取、恢复或批量删除接口；当前集合只表达保留下来的记录。未知删除按原 Project、Task、Step ID 只读核对当前集合或单项，当前缺失不能证明由某次未知操作造成，当前同 ID 存在也不能证明是原记录；不得自动重放删除。

## 权限、快照与原子写入

admin 与 member 具有相同读取、添加、内容更新、状态设置、移动和删除能力；Task 的 `todo`、`in_progress`、`done`，自动执行许可关闭、无 Session 或有效 Worker/Session 归属均不增加 Steps 门槛。访问首先检查正常项目成员关系和父资源可见性，再检查父墓碑。Steps 写入不读取 Worker 属性来决定可写性，不改变执行归属，也不冻结 Session。

读取在同一个 `REPEATABLE READ` 快照中检查项目成员关系、父资源存在性与软删除，再读取父版本及目标内容。父版本、完整内容及顺序必须属于一个一致状态；读取不改变父版本、更新时间、执行计时、状态、依赖、属性或执行归属。

写入复用项目写事务，依次完成项目锁、成员准入、窄父任务头锁及墓碑检查，随后比较精确父版本。读取并验证当前集合后，添加先检查重复 ID，再解析锚点并构造不修改原集合的完整候选；内容与状态更新按同一现存目标变更路径查找目标、构造候选并比较语义值；移动先解析目标和相对锚点，再构造保持原内容与时间的最终顺序；删除先解析现存目标，再构造保留其他记录原内容和时间的剩余集合。合法 no-op 直接编码原资源，不进入版本耗尽、时钟或数据修改阶段。

真实变化检查版本耗尽、取得数据库 UTC 微秒时间后，使用新父版本和实际时间编码候选。通过容量预检后，添加才平移位置并插入新行，内容或状态修改才 UPDATE 唯一目标行，移动才更新受影响区间的位置，删除才移除目标行并压紧后续位置；随后均仅 touch 父任务一次。内容与状态更新不重排集合，移动不更改任何 Step 时间。位置始终稠密为 `0..n-1`，唯一约束在提交时验证最终顺序。

Task 元数据与 Steps 共享 `Task.version`。成功的真实 Steps 变化只推进父版本一次，并只改变父 `updatedAt`；Task 标题、说明、整体状态、负责人、平台、许可、属性、依赖、执行起止时间及 Worker/Session 归属保持。相同观察版本的 Steps 与 Task 元数据竞争最多一个实际变更成功；即使修改不同字段，陈旧版本也冲突。无变化请求先完成时可与后续真实变化分别成功，但只有真实变化推进版本；真实变化先完成时，旧版本 no-op 冲突。拒绝在数据修改前决定；行写入或父 touch 后的故障经确认回滚时，完整集合、排列、父版本和全部时间均零变更。

## 公开编码容量

完整 `StepsResource` 的容量上限为 **67,108,864 字节（64 MiB）**，计入实际 JSON UTF-8、默认 HTML 转义、封装及末尾换行。父版本始终按最大正 int64 的 19 位预留；因此普通父版本位数增长不会使合法集合不可读。恰好达到预留容量的合法候选必须允许提交，其资源必须完整可读；合法上限集合的同值 no-op 仍可成功。

候选检查与 HTTP 响应共用一个公共 codec；检查的时间值就是持久化和响应中的时间，编码通过后冻结响应字节。超限返回 `409 steps_limit_exceeded`，`error.details` 包含 `encodedBytes` 与 `maxEncodedBytes`，前者包含版本位宽预留，后者为 `67108864`。容量拒绝发生在任何步骤或父任务数据修改之前。错误不能通过截断、删减说明或隐藏条目规避。

## 失败、提交已知性与核对

形状与 ID 语法错误可在事务前拒绝。有效输入在事务内依次检查成员/父资源可见性、父删除、版本、Task 内身份或锚点、语义 no-op、版本耗尽和候选容量；陈旧版本先于目标或锚点错误，添加的重复 ID 先于缺失锚点，更新的目标缺失先于版本耗尽。移动先解析目标，再拒绝规范化后的自引用，随后解析其他锚点；陈旧版本先于这些语义位置检查。

| 情况 | 结果 |
|---|---|
| 未认证 | `401 unauthenticated`。 |
| Cookie 写请求的 Origin 不符合要求 | `403 forbidden`。 |
| 无项目成员权限、父资源不存在或 Task 不属于项目 | `404 not_found`。 |
| 已授权父 Task 软删除 | `410 task_deleted`。 |
| 该 Task 内没有目标 Step 或位置锚点 | `404 not_found`，不意味着父 Task 失效。 |
| 非法输入、ID、自引用位置锚点或任何 query | `400 invalid_input`。 |
| 观察的父版本过期 | `409 version_conflict`。 |
| 现存 Step ID 重复 | `409 step_id_conflict`。 |
| 父版本已达最大正 int64 且需要真实变化 | `409 version_exhausted`；同值 no-op 保持有效。 |
| 真实变化候选超过完整编码容量 | `409 steps_limit_exceeded`，包含字节 details。 |
| 非法存储、非稠密集合、读取编码超限、数据库、提交或事务清理失败 | `500 internal_error`，不返回局部集合或伪造空态。 |

业务拒绝与事务 cleanup 故障同时出现时，整体按内部故障处理，保留两条错误原因。事务完成事实分别为 `committed`、`not_committed` 或 `unknown`：确认提交成功后，响应失败仍属已提交；明确提交回滚或提交前确认回滚为未提交；未确认的 Commit 错误为未知。失败 Commit 后的 `ErrTxClosed` cleanup 不能证明该操作已回滚，取消或 HTTP 状态也不能代替提交事实。

响应使用独立的 `written`、`failed` 或 `canceled_before_body` 结果，并记录已写字节；写入网络不等于客户端确认收到。未知写入按原 Project、Task、Step ID 只读核对当前集合或单项，不自动重放 POST、PATCH、PUT 或 DELETE，不为未知新增换 ID。当前存在、缺失或版本只表达当前事实，不能归因于某次未知操作。

沿用 `X-Request-ID`。恢复 GET 可使用原请求 ID 加 `.r1`、`.r2` 等后缀关联诊断，记录 `read_kind=reconcile`、当前版本及 `found`、`absent` 或 `current_state`。该约定不参与授权、版本、身份或幂等判断。日志由 handler 记录 `add`、`update`、`set_status`、`move` 或 `delete` 操作、`changed`/`unchanged` 业务结果、prepare/persist/commit/response 阶段、独立事务/响应结果、安全原因类别和必要 SQLSTATE。no-op 不记录数据写入的 persist 阶段；业务 `unchanged` 可与事务 `committed` 同时成立，二者含义独立；固定诊断不输出标题、Markdown、URL、令牌、任意 Fault message 或数据库消息。

## 验证要求

| 编号 | 可观察结果 |
|---|---|
| ST-R1 | 新旧 Task 具有真实空集合；合法数据在实际服务进程重启后保持。 |
| ST-R2 | 顺序、Markdown、微秒时间和精确 int64 完整返回，父版本与内容属于同一快照。 |
| ST-R3 | 成员、Task 内 ID、子项缺失和父删除分别执行本文的权限与失败契约。 |
| ST-R4 | 读取保留 Task 全部字段，且不依赖无关属性、执行归属或 Session。 |
| ST-R5 | 实际 HTTP 完整返回恰好达到预留容量的资源，计入转义、换行与版本位宽。 |
| ST-R6 | HEAD、方法与 query 拒绝、非法存储及 cleanup 失败按本文暴露，不伪造空态。 |
| ST-A1 | 真实服务完成追加、before/after 插入及同名独立项，规范化身份、默认值、201、Location 和完整有序资源正确。 |
| ST-A2 | 严格输入、授权、Origin、错误顺序、版本耗尽和坏存储明确失败且零变更。 |
| ST-A3 | 同版本添加及 Task 元数据竞争最多一次实际变更；成功添加保留父业务字段、其他 Step 时间及 Worker/Session。 |
| ST-A4 | 真实 HTTP 的精确容量成功与超限一字节拒绝成立，并证明拒绝前没有数据写入；容量压力案例独立于日常 CI。 |
| ST-A5 | 行写入和父 touch 后的故障经真实事务确认回滚，完整前后状态相同；cleanup 故障优先于业务拒绝且错误链保持。 |
| ST-A6 | 确认提交、明确回滚、未知 Commit 与提交后丢响应分别保留真实事实；只读核对和日志哨兵验证没有重放或内容泄露。 |
| ST-C1 | 真实服务完成仅标题、仅说明、成对原子更新和空说明清空，保留省略字段、原值文本、目标身份及顺序。 |
| ST-C2 | 四状态自由转换、多个进行中和父 Task done 可操作；真实变化仅更新目标内容时间和父版本/时间，其他记录及 Task/Worker/Session 保持。 |
| ST-C3 | 当前同值与最大版本 no-op 返回完整原资源且无时钟采样、目标 UPDATE 或父 touch；陈旧同值冲突，真实变化版本耗尽和目标缺失遵守检查顺序。 |
| ST-C4 | 真实 HTTP 的精确容量 PATCH、超限一字节零写入、缩小说明、状态长度增加及合法上限 no-op 均使用同一完整 codec；压力案例独立于日常 CI。 |
| ST-C5 | 同版本实际变化竞争、成对内容写入/父 touch 后故障及确认回滚保持原子性；响应丢失可按原身份读取当前事实，日志区分 unchanged 与提交结果。 |
| ST-M1 | 真实服务完成首尾、前后锚点和跨区间移动，返回稠密完整顺序；大小写 ID、同名记录和跨 Task 同值 ID 不改变定位。 |
| ST-M2 | 移动保留所有 Step 身份、内容和创建/更新时间；当前相邻、首尾及单项 no-op 保留完整资源与全部时间，最大版本 no-op 无时钟、位置 UPDATE 或父 touch。 |
| ST-M3 | 严格位置输入、自引用、缺失目标/锚点、陈旧同值、权限与版本耗尽按检查顺序拒绝；同版本移动及 Task 写入最多一次实际变化。 |
| ST-M4 | 真实 PostgreSQL 的受影响位置写入和父 touch 后失败均确认回滚，完整前后状态相同；实际 HTTP 的最大合法资源移动与 no-op 使用同一完整 codec，压力案例独立于日常 CI。 |
| ST-D1 | 任意状态的指定 Step 均可删除，返回完整剩余集合，末项删除得到显式空数组；读取或当前版本重复删除目标为子项 404。 |
| ST-D2 | 删除仅推进一次父版本/时间，压紧后续位置并保留其他 Step 的身份、内容、全部时间和相对顺序，以及父业务、附件、PR、Session 和 Worker 归属。 |
| ST-D3 | 当前缺失目标先于版本耗尽，陈旧版本先于目标缺失；同版本删除及其他 Task/Steps 写入最多一次实际变化，删除和压紧或父 touch 后失败均经真实事务确认回滚。 |
| ST-D4 | 删除释放 Task 内 ID，后续 POST 相同 ID 生成新记录；丢响应只读核对当前事实，不进行重放或推断历史归因。完整剩余候选在写前通过同一 codec，最大资源删除的实际 HTTP 验证独立于日常 CI。 |
| ST-L1 | 安装后的 CLI 连接真实服务，完整读取非空、空集合和单项说明，保留保存顺序、规范短 ID、原值文本、全部字段与大于 2^53 的精确版本。 |
| ST-L2 | 显式 project 在仓库外直接读取，帮助先于配置/Git/网络；坏字段、scope、重复或非规范 ID、读取失败和未支持入口明确非零退出，不伪造空态或部分成功。 |
| ST-L3 | 可读安全转义、单个完整 JSON stdout、0/1/2 退出码、401 登录指导、共享取消/预算及仅 list/show 的帮助、补全和独立手册与安装产物一致。 |

[服务验证说明](../../packages/daynight-server/README.md#task-steps-api)拥有测试与独立压力验证命令；实际产物及运行结果随对应源码和 PR 保存。
