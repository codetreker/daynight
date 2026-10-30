# Project 与 Task 客户端需求

状态：共享配置、HTTP、仓库关联基础及 `project create/list/show` 已实现；
Task 命令、安装产物、真实 Go/PostgreSQL 联调及默认预算验收已完成，并通过三原生
平台及 Go 托管验证；集成状态见[PR #55](https://github.com/codetreker/daynight/pull/55)。本文保留完整交付要求，当前可用命令见
[仓库 README](../../README.md)。

`daynight project` 和 `daynight task` 是 `daynight-server` 的客户端入口，供开发者
在终端管理项目及任务，也为脚本提供 JSON 查询结果。它们与 `review`、`update`
并列，使用现有 HTTP API。本文拥有命令、配置、仓库关联和输出要求；服务的数据、
状态约束及错误语义由[服务需求](daynight-server.md)拥有，机制见
[客户端设计](../design/daynight-project-task.md)，决策见
[方案决策](../../.agents/notes/archived/architecture/2026-10-20-project-task-cli-design.md)。

[预定义属性需求](daynight-task-properties.md)的 server 接口、CLI 通用属性命令和
完整资源输出已实现。[架构](../design/daynight-task-properties.md)拥有属性机制。完整 Task 读取保留通用属性对象及键缺失；没有保留执行归属时没有 worker 键，公开属性写入由服务端定义与保护。进程内 typed ApiClient 的认领及分页操作由[归属架构](../design/daynight-worker-claims.md)拥有；worker 人工管理命令由 [Worker 需求](daynight-worker.md#w-08人工介入与强制撤回)定义。

[附件需求](daynight-task-attachments.md)定义的 `task attachment put/list/read/remove`
及原始字节读取已实现，复用本文的服务配置和 project 选择。
[架构](../design/daynight-task-attachments.md)拥有文件与流传输机制；
Web 附件管理亦已实现。

[执行计时需求](daynight-task-timing.md)的任务起止字段与数据库图时钟已有严格 CLI 读取契约。
JSON 保留真实时间或明确的 `null`；Project JSON 同步保留项目阈值及其精确嵌套版本。
这些计时事实不增加可读输出字段。Web 实时卡片消费同一计时与项目阈值事实，不增加 CLI 命令。

[外部依赖需求](daynight-external-dependencies.md)的存储及读取准备已实现。完整 task 和图节点
都保留必填 `externalDependsOn`，它是全部 `dependsOn` 的无重复排序子集；CLI 严格读取并输出，
缺失、null、非法 ID 或越界子集作为协议错误拒绝，不补空数组。
--depends-on 与 --external-depends-on 分别声明普通、外部前置，任一出现就完整替换关系及分类。

[鉴权需求](daynight-auth.md)定义完整的个人访问令牌、项目成员授权和私有项目发现。
CLI 的令牌配置与 HTTP 传输已实现；[凭据决策](../../.agents/notes/implemented/architecture/2026-10-22-cli-server-credentials.md)
记录其机制。[架构](../design/daynight-auth.md)拥有服务组合；生产服务对全部项目、任务、图和附件请求强制鉴权。
使用 `daynight login` 通过浏览器设备授权后即可访问默认生产服务；自动化仍可显式配置 PAT。
仓库关联只选择项目，不授予访问权限，也不保存认证凭据。

## PT1. 范围与命令边界

交付包含 project 创建、列表和详情，以及 project 内 task 的创建、列表、有界 ready
选择、详情、更新和任务链图查询。命令复用服务的 project/task 资源与任务链图接口，不增加数据库字段、project 唯一
约束或任务执行能力。凭据复用既有 Bearer 请求通道；配置允许省略令牌，但业务命令在本地无凭据时
直接提示登录。设备授权接口由[鉴权需求](daynight-auth.md)拥有。地址配置不改变服务现有的 loopback 监听边界。

顶层、命令组和操作帮助必须先于配置加载、Git、文件写入和网络访问执行。裸
`project`、`task` 显示各自帮助。新增业务依赖不得成为 review、自更新、帮助或版本
的启动前提；这些命令继续遵守[客户端需求](daynight.md)及各自的业务要求。

## PT2. 服务配置

全局配置继续使用 `~/.daynight/config.yml`。配置文件或 `serverUrl` 省略时使用
`https://daynight.cc`，普通生产使用无需设置地址或进入配置引导。`serverUrl` 保留为测试服务器覆盖：

```yaml
serverUrl: http://127.0.0.1:8787
```

明确提供的地址包含协议、主机和可选端口，允许结尾根斜线；拒绝凭据、非根路径、query、fragment、
空值和错误类型。省略端口采用协议默认值，客户端添加 `/api/v1`。非法值与读取错误继续暴露，
不得回退到默认服务。

同一配置中的 `serverToken` 为可选的非空 opaque visible ASCII。业务命令没有本地凭据时，在请求前
报错并提示 `daynight login`；已有凭据被服务拒绝为 401 时同样提示登录。CLI 不自动登录或重试写请求。
普通用户通过显式 `login` 完成设备授权并自动保存凭据，通过 `logout` 撤销并清除；
[鉴权需求](daynight-auth.md)拥有完整流程。自动化可通过受控配置文件提供 PAT 及对应服务 origin；
省略 origin 仅表示凭据属于生产服务。准备文件本身不验证连通性、令牌或成员权限。

凭据只允许 HTTPS，或 host 为字面量 `localhost`、`127.0.0.0/8` 数值 IPv4、`::1` 的 HTTP。
未知主机解析到 loopback 也不获得例外。令牌不进入命令参数、仓库关联、任务、附件或诊断。
外部更换 origin 时必须移除或替换旧凭据；手动编辑不执行 CLI 凭据清理。CLI 登录/退出在锁内共同
核对 origin 与令牌。配置锁、并发比较、POSIX `0600` 和 YAML 诊断的完整要求由[客户端 C6](daynight.md#c6-按需配置引导)拥有。

project/task 不要求 `repositories`、review 路径、SQLite、GitHub CLI 或 Copilot。
共享层严格读取 YAML 并要求根节点为 mapping，各能力只校验自己的业务投影。
未知字段在运行时忽略，配置编辑保留原字段。project/task 不因无关 review 值而失败，
review 也不要求服务配置；语法错误、重复键、已知字段的非法值和读取错误仍须暴露。
review 配置、状态格式和路径保持原有语义。

## PT3. 仓库地址正规化

省略 `--repo` 的 project 创建及未显式指定 project 的 task 操作，必须定位调用目录
所属的 Git worktree 根目录，并读取经 Git `insteadOf` 展开后的 `origin` fetch 地址。
从子目录调用使用同一根目录；linked worktree 分别保存自身关联，submodule 使用
自身的根目录及 origin。非 Git
目录、bare repository、缺少 origin 或读取失败应报告具体原因。

当前 origin 和服务返回的 `repoUrl` 必须使用同一正规化规则比较。普通 hosted repo
的 HTTPS、字面用户名为 `git` 的 SSH URL 和 SCP 写法在默认端口下视为相同：

```text
https://github.com/codetreker/day-night.git
ssh://git@github.com/codetreker/day-night.git
git@github.com:codetreker/day-night.git

→ github.com/codetreker/day-night
```

正规化将主机名转小写，移除仓库路径末尾斜线；仅在移除后仍有非空仓库路径时移除一个
`.git` 后缀，单独的 `.git` 路径保留为字面值。保留任意层级及路径大小写。不得根据
未经验证的 provider 规则将路径转小写。非默认端口、特殊 SSH
用户、缺省 SSH 用户、SSH alias 的主机名和显式相对路径必须保留有意义的区别；
不得展开任意 SSH 配置或猜测 alias 的真实主机。百分号编码保持原样，不把编码路径
解码为另一仓库标识。精确算法与边界 fixture 由设计拥有。

## PT4. Project 选择

除 `task properties --schema` 外，task 操作接受可选的 `--project <id>`，按以下顺序选定目标。schema 模式直接读取认证服务的全局定义，不读取 Git、项目或本地关联，也不接受 --project：

| 条件 | 必需行为 |
|---|---|
| 显式传 `--project` | 使用指定 project，在 Git 仓库之外也可执行；不读取或改写自动发现关联 |
| 本地关联的 server、repo 与当前值一致 | 按 project ID 读取远端详情，校验 repo 关联后使用 |
| 本地关联缺失或 server、repo 已变化 | 遍历服务完整 project 列表进行 discover |
| 缓存 project 返回 404，或详情 repo 不再匹配 | 重新 discover 一次 |
| discover 无匹配 | 报 `Project does not exist`，执行失败 |
| discover 唯一匹配 | 保存关联后使用该 project |
| discover 多个匹配 | 报匹配歧义，列出匹配 ID 并提示显式 `--project` |

discover 必须读取全部分页才可判定匹配数量。唯一匹配保存前也必须按 ID 读取并验证
目标详情；读取失败按实际错误处理。网络、超时、500、无效 JSON 和响应结构错误
不得触发 rediscover 或被解释为 project 不存在。

有效缓存的绑定在同 repo 后来增加其他 project 时保持稳定；每次按 ID 校验即可。
显式 `--project` 仅决定本次调用，不改变该绑定。首次 discover、缓存失效及重新发现
均不得在目标不明确时执行 task 写入。GET 校验与后续 task 请求之间仍可能发生服务
侧变化，最终结果由 task API 的原子校验决定。

## PT5. 仓库本地关联

仓库专属信息放在 worktree 根目录 `.daynight/` 中，关联保存为
`.daynight/project.yml`：

```yaml
serverUrl: http://127.0.0.1:8787
repoIdentity: github.com/codetreker/day-night
projectId: 8cb7af59-133e-4dc4-a9e6-c8a4b2429762
```

首次保存时确保根 `.gitignore` 包含 `/.daynight/` 且忽略规则实际生效，保留已有
内容。关联记录中的 server 地址与正规化仓库标识共同界定 project ID 的适用范围。
本地状态使用锁及原子替换写入；已有锁立即报告竞争失败，不等待、自动重试或
自动回收。锁记录进程 ID 和所有权 token，异常退出后须确认写入者已经停止，再
人工移除残留锁。释放时核对持有的文件身份及内容，替换后的锁必须保留。损坏
数据、锁失败、ignore 规则无法生效和写入失败均是操作失败，不可伪装成未发现。
远端 task 写操作必须晚于所需本地准备成功。

## PT6. Project 命令

```bash
daynight project create "Day Night"
daynight project create "Day Night" --repo https://github.com/codetreker/day-night.git
daynight project list
daynight project list --json
daynight project show <project-id>
daynight project show <project-id> --json
```

创建必须提供一个位置参数 `<name>`；`--repo` 可选。省略时按 PT3 读取当前 worktree
的有效 `origin`；显式提供时原样使用该地址，不读取工作目录或 Git，因此可在 Git
仓库之外执行。含空格的名称须作为同一个 shell 参数传入；前导 `-` 的名称可使用
`daynight project create -- -name`，或在终止符前指定 `--repo`；`--` 后的词均为位置参数。
`--name` 不再是有效选项，名称缺失或多余位置参数均为参数错误。名称必须为
不含 NUL 的合法 Unicode 文本，且不能全部由 Unicode `White_Space` 组成；保留原始
字符及空白，不以 JavaScript `trim()` 改写。U+FEFF 单独作为名称有效，U+0085 单独
作为名称无效。名称和详情 UUID 的参数错误必须在配置读取及网络访问之前拒绝。

创建在写入前必须读取配置 server 的全部 project 分页，将选定 repo 地址与每个
`repoUrl` 按 PT3 的同一规则比较。零匹配时提交原始名称与所选原始地址；唯一匹配
时成功输出 `Project already exists.` 和既有 project，不发送创建或修改请求，保留
其名称与地址。多个匹配时报告歧义及全部匹配 ID，不创建。任一分页、响应验证、
Git、取消或期限错误均按实际原因失败，不得把查询失败视为零匹配；完整预检成功
并确认剩余预算后才能发送创建请求。该客户端预检不承诺并发创建的原子唯一性，
服务继续允许同一仓库有多个 project。

所有 project 操作均不读取或改写当前仓库关联、不写 ignore 规则、不 clone 仓库、
不启动 review。列表查询配置 server 中的全部 project，不按当前仓库筛选。详情使用
显式的连字符 UUID，接受大小写输入并使用规范 ID 查询。列表及详情可在 Git 仓库之外
执行，不查询当前工作目录；命令组及操作帮助遵守 PT1 的依赖隔离。

Project 创建、详情、分页条目及图中的 Project 必须包含 `settings.version` 与 `settings.executionWarningMinutes`。
前者为完整正 int64，后者为 `1..2147483647` 的整数分钟，初始分别为 `1` 和 `60`。
缺失或不合法字段是协议错误，不能由 CLI 补默认值；JSON 必须无损保留超过 `2^53` 的嵌套版本。
可读 Project 输出保留既有字段，当前没有新增设置修改命令，设置通过 Web 或既有服务 API 修改。

## PT7. Task 命令与更新语义

```bash
daynight task create --title "实现登录" --description "支持 OAuth 登录"
daynight task create --title "实现登录页面" --depends-on <task-id>
daynight task list
daynight task ready
daynight task ready --limit 5 --json
daynight task ready --allow-agents true --json
daynight task list --allow-agents false --ready
daynight task list --ready
daynight task list --all --json
daynight task list --status in_progress
daynight task show <task-id>
daynight task update <task-id> --title "新的标题"
daynight task update <task-id> --allow-agents true --if-version 3
daynight task update <task-id> --description ""
daynight task set-status <task-id> in_progress
daynight task set-status <task-id> todo
daynight task set-status <task-id> done
daynight task update <task-id> --depends-on <task-a> --depends-on <task-b>
daynight task update <task-id> --clear-dependencies
daynight task set-status <task-id> done --if-version 3
daynight task delete <task-id> --if-version 3
daynight task delete <task-id> --remove-depends --if-version 3
daynight task properties <task-id> --json
daynight task properties --schema --json
daynight task set-property <task-id> pullRequests '[{"url":"https://github.com/owner/repo/pull/123","title":"修复同步"}]' --if-version <observed-version>
daynight task remove-property <task-id> pullRequests --if-version <observed-version>
daynight task graph <task-id> [--depends-only]
```

除 properties --schema 外，上述命令均接受 `--project <id>`。`list`、`ready`、`show`、`graph` 和属性读取接受 `--json`。标题、
描述、repo 地址、ID、状态和版本等 text 选项同时接受 `--option value` 与
`--option=value`。内联形式只按第一个 `=` 分隔，保留值内后续 `=` 和前导 `-`；
分离形式的选项值以 `-` 开始时拒绝，须使用内联形式。描述允许空字符串，可写 `--description ""` 或 `--description=`；set-property 的 value 位置参数也允许空字符串。开关不接受内联值；目录选项的
`--path=value` 继续拒绝。附件上传的 `--path` 是 text 选项，接受内联赋值。
`project create`、属性 set/remove 和附件 `put/read/remove` 接受独立 `--` 结束选项解析；该终止符用于保留前导连字符的位置参数，选项必须放在终止符之前。其他操作继续使用其声明的语法。

创建必需符合 PT6 文本规则的非空 task 标题，可选描述、`--required-platform windows|linux|macos`、重复的 `--depends-on` 和 `--external-depends-on`。省略描述与依赖分别为空字符串与空集合，平台省略为 null，不限制执行平台；未显式设置的属性缺失。新 task 总为 `todo` 且 `allowAgents=false`，create 不提供许可或属性专用选项。任务响应解码接受 `todo`、`in_progress`、`done`，列表默认选择
所有未完成任务；`--all` 选择所有未删除任务的业务状态，
单个 `--status` 选择指定状态，包括 `done`。`--all` 与 `--status` 互斥，组合使用
属于参数错误；列表状态值为 `todo`、`in_progress`、`done`，共享语法负责校验和静态候选，
帮助显示选项说明。`--ready` 表示 `ready=true`，与所选状态按 AND 组合，支持
`--all --ready`。`list` 与 `ready` 接受 --allow-agents true|false 与 --compatible-platform windows|linux|macos。严格拒绝其他值，省略不筛选；兼容包含null和同值要求，全部过滤先于服务排序、分页和ready上限，不在本地丢项。列表读完全部匹配分页后，按 `in_progress`、ready、其余 `todo`、
`done` 分组排序；组内保留跨页的服务顺序，文本和 JSON 使用同一顺序。详情按选定
project 和 task ID 查询。[软删除需求](daynight-task-deletion.md)定义 `task delete` 的精确版本、一次预读、不重试及数据保留规则。`--remove-depends` 是可选开关：省略时无未删除引用者即可删除，有引用者则 409 拒绝；传入才明确解除全部传入引用并原子软删除，不要求无引用任务也传开关。显式 project ID、show/update/set-status/delete 的 task ID、标题、描述、状态、
版本及修改字段组合的参数错误必须先于配置读取、Git 和网络访问拒绝；两类依赖 ID 在本地正规化并排序，
非法 UUID、列表内及跨列表重复（包括大小写等价）先拒绝，服务继续验证引用、项目、环及状态条件。

`ready` 供日常选择下一项工作，返回当前 project 按服务顺序排列的前 N 个 ready task；
默认 `N=10`，可通过 `--limit <N>` 指定。limit 仅接受十进制整数字符串且数值为
`1..100`；拒绝符号、小数、指数、非十进制形式、空值及越界值。limit 参数错误
必须在配置读取、Git 和网络访问之前拒绝。该操作只发送一次 task GET，查询固定
`ready=true`、所选 `limit` 及可选的 `allowAgents`、`compatiblePlatform`；响应中的合法 `nextCursor` 不触发续页，不提供 `--status` 或 `--cursor`。`task list --ready` 保持遍历全部匹配页的行为。

ready 沿用服务定义：task 为 `todo`，且每个直接依赖均为 `done`。服务按
`createdAt ASC, id ASC` 排序；CLI 保留该顺序，不重新排序。返回项数不得超过所选
limit，每项必须为 ready，且 task ID 不得重复；响应违反任一条件时作为协议错误
拒绝，stdout 保持为空。正常的候选选择使用此有界操作，完整依赖关系可按需使用
`graph` 查看。

`set-status <task-id> <status>` 接受三状态目标、可选 project、精确 `--if-version` 和 done 专用 `--claim-id <claim-id>`。显式 claim UUID 在配置/网络前规范化，其他状态目标拒绝；携带时调用已有 claim-bound 完成接口，省略仍为普通 setter，不推断 claim。通过专用 PUT status 提交版本、目标及明确提供的 claimId。九种状态对均支持；当前版本同状态 +0，实际改变 +1，
过期同状态先冲突。实际进入 in_progress/done 检查全部直接前置；done 退回要求没有进行中或已完成直接后继。
拒绝返回原错误及稳定排序的阻塞 ID，不级联。成员与管理员均可设置，状态不授予执行或交付权限。
显式版本不预读；省略时提交前只读一次。基于已审阅资料的决策必须带其版本，不能用临时 GET 替代。
不自动重试写入；不确定结果先 GET 核对，不将取消解释为回滚。输出完整 Task 并保留所有非状态资料。
[三状态要求](daynight-task-status.md)拥有时间、迁移、依赖和版本细节。旧四动作删除且无别名。

元数据 update 至少提供标题、描述、普通/外部依赖、自动执行许可或平台要求中的一个字段；属性由专用通用命令维护。`update --allow-agents true|false` 显式设置许可，省略保留，false 关闭；服务在 in_progress 拒绝实际切换，同值精确版本不改版本或时间。该选项不改变 ready；明确指定执行不要求开启许可。--required-platform windows|linux|macos 设置，--clear-required-platform 发送null，二者互斥；省略均保留。
精确版本同值不写，旧版本冲突，in_progress实际变化整体拒绝；普通人工setter不按平台筛选。
`task update --status`
作为不支持的选项拒绝，帮助引导使用 set-status。省略字段表示保持，空描述表示
清空描述。两类依赖选项分别形成普通 N 和外部 E，任一出现就提交完整 D=N∪E 及精确 E。
只给普通选项会显式清空外部子集，只给外部选项会把完整关系替换为这些外部边，不是追加或仅标记。
--clear-dependencies 提交两个空数组，与任一依赖声明互斥；两类声明可共同使用。
ID 逐项提供、不执行 CSV 拆分，正规化及排序后拒绝列表内/跨列表重复，不静默去重或合并旧关系。
重复关系选项逐项声明 ID，其他元数据选项只允许一次。服务继续验证引用、状态、环和项目范围，
所有普通与外部前置仍参与执行，拒绝保留原错误码与相关 task ID。

通用属性命令的 property 是完整字面名称，点号不是对象路径。独立名称 . 或 .. 无法在现有 URL 传输中保持同一资源路径，客户端作为传输错误拒绝且不发请求；可表示的名称仍交由服务端判断。CLI 不维护属性白名单、不获取 schema 作为设置前置，也不解析 value；原始参数作为 valueText 提交。默认 JSON 与字符串 shorthand、可写性、类型和结构都由服务端判断。当前公开可写属性为 pullRequests；其完整数组保留顺序、重复、空白与空字符串。worker 只读保护不因通用命令改变。

properties 仅允许 task ID 或 --schema 一种模式，均缺失、同时给出或 schema 附 --project 在 I/O 前拒绝。schema 一次 GET 全局定义，不读取项目或工作目录。值读取一次 GET 属性资源。set/remove 显式 --if-version 只提交一次写；省略时一次 GET 属性资源取得任务版本，再写一次；显式 --project 直接作用于该属性请求，不额外读取 project。未显式 project 才使用既有 discover。

set-property 替换一个完整属性值，remove-property 删除记录并省略键；设置 [] 与移除不同，null 从不作为删除标记。空 value 允许原样提交，位置参数 -- 后的短横线文本/负数不被解释为选项。未知名、错误 JSON、类型错误和只读写入由服务端返回 400 invalid_input，CLI 不改成用法错误，也不重新获取版本重试。

未传 `--if-version` 时，CLI 先读取 task 的当前 `version`，再将该版本与更新字段
一起提交。显式指定时，使用该正整数作为期望版本，不用最新版本覆盖它。版本范围为
`1..9223372036854775807`，客户端必须保留完整精度，HTTP 与 JSON 输出仍使用数字。冲突必须
报告失败，不自动读取新版本重试。无变化更新、版本递增和时间戳遵循服务语义。

`graph <task-id>` 必须指定目标 task，查询其普通依赖无向连通分量的全部成员，包含
所有状态、兄弟分支、分叉和汇合，再补充成员直接声明的 external 前置任务一层。
只依赖本链的外部任务不进入结果，补充的外部节点不继续展开。原始依赖、外部子集、
阻塞及 ready 保持服务事实，外部节点的依赖 ID 可以指向结果之外；不能裁剪为诱导边集合。
同一链的任意成员得到同一节点集合。无参数调用属于语法错误，不读取全项目图。
查询范围、返回集合的节点及依赖引用上限由
[服务端需求](daynight-server.md#任务链图查询)拥有。

普通 graph 输出呈现所选节点的三种状态、依赖、阻塞和汇总。summary 统计本链与补充的
外部节点；文本汇总只包含三状态，JSON summary 为 total、todo、inProgress、done、ready、blocked，满足
`total = todo + inProgress + done` 与 `todo = ready + blocked`。ready 只来自全部前置完成的 todo；
列表、show、graph 均拒绝旧状态，状态写入只通过 set-status。标题预览、快照边界、
节点和边上限均继承服务要求。完整任务和图节点严格读取必填布尔 allowAgents 及必填nullable requiredPlatform；缺失/非法类型拒绝，不补默认。JSON保留原值，可读输出显示平台，null为any。有许可或平台筛选的 list/ready 同时验证返回项符合条件。图响应还必须包含数据库时间样本 `observedAt`；full task 和图节点均有必填可空的 `startedAt`、`completedAt`。缺失或错误类型作为协议错误拒绝，不从创建、编辑或客户端时间补值。超限时报告数量及上限，不返回部分图。

附件 `put/list/read/remove` 继承相同的 project 选择，逐文件处理完整相对路径。
目标 basename、MIME 推导、目录拒绝与原始内容输出的完整要求由
[附件需求](daynight-task-attachments.md#cli)拥有。

## PT8. 输出、分页与错误

普通元数据查询提供可读结果；`project list` 和 `task list` 自动遍历全部匹配分页，
`task ready` 只读取所选的前 N 项。每个操作在其全部必要读取、结构验证、渲染及
最终期限检查成功后输出结果。Project 列表逐个输出完整的带标签资源块，包含 ID、名称、
原始 repo 地址及创建、更新时间；空列表明确说明没有 project。详情和创建结果使用
相同字段，创建结果另表明服务已确认创建。Task 列表逐个输出带标签的资源块，包括
ID、所属 project、标题、状态、ready、依赖、外部依赖、阻塞及完整属性 JSON；列表文本
不显示描述、版本及创建、更新时间，空 task list 明确说明没有 task。详情、ready、
创建和更新结果显示完整 task 资源，包含上述字段、描述、完整版本及创建、更新时间。
ready 空结果输出 `No ready tasks.`，创建和更新结果另表明服务已确认操作。属性读取及 set/remove 成功结果包含 task/project ID、精确版本和完整属性；schema 模式保留全部定义与 schema 关键词，按名称输出。
普通图输出显示 project、全部 summary 字段及每个节点的状态、标题预览、截短标记、ready、
依赖、外部依赖、阻塞和时间。依赖区统一输出 `External dependencies (N): ...`，
计数与列表只包含显式外部子集，空值显示 none。所有文本完整显示，资源边界保持清楚，输出空间随字段内容总量
线性增长。

`graph --depends-only` 使用相同任务集合，每个任务只输出完整 ID、完整 dependsOn 与
externalDependsOn，不输出项目、统计、标题、状态或阻塞字段。文本按任务输出三个标签：
`ID`、`Depends on`、`External dependencies`；空依赖显示 none。与 `--json` 组合时返回
对象数组，每个对象恰好含 `id`、`dependsOn`、`externalDependsOn` 三项；没有 graph envelope。
两种格式均保留全部原始依赖引用，包括外部节点指向本次未展开任务的 ID。

可读资源字段中的 C0/C1 控制字符及 Unicode 行、段分隔符必须转义为可见文本，
普通 Unicode 与 emoji 保持原样。`--json` 将详情输出为一个完整资源对象、project list
输出为所有匹配资源的完整字段数组、task list 输出为所有匹配 task 仅省略
`description` 的数组、ready 输出为所选完整 task 的数组、属性读取输出完整 PropertyResource、schema 输出完整定义目录、普通图输出为服务的任务链图响应对象，
并以换行结束。Task list 的默认、`--all`、`--status`、`--ready` 及其合法组合
均使用同一 JSON 字段规则；其余 API 字段全部保留，包括原始 PR 字符串、完整 int64
版本、创建/更新时间和明确可空的 `startedAt`、`completedAt`；图 JSON 另外保留顶层 `observedAt`。
这些计时字段不增加命令参数或改变可读输出的字段选择；外部依赖数组作为已知字段保留。
ready 不添加分页 envelope，空列表为 `[]`。JSON 保留所输出
API 字段的名称、类型和原始字符串，不应用终端显示转义或插入诊断文字。写操作
成功后输出服务确认的资源 ID 及结果；服务未确认成功时不得输出成功结果。

结果写入 stdout，错误及诊断写入 stderr。成功退出 `0`，参数错误退出 `2`，操作
失败退出 `1`。诊断须标识操作及相关 project/task；服务错误保留 `code`、`message`、
`requestId` 和有关 details。401 追加 `daynight login` 指导，不回退匿名、不执行
登录预检或重放原请求。403、404、409 继续既有结果及重新发现规则。
不得输出凭据、请求环境或数据库细节；YAML 诊断仅含安全类别、代码和位置，不
携带标量或原始解析器错误链。

## PT9. 请求生命周期

执行命令必须具有覆盖配置读取、Git、缓存验证、全部分页、本地锁、HTTP 及结果
输出的共享总期限，HTTP 请求还须有单次期限。JSON 元数据响应的读取和累积必须有
字节上限；附件原始内容使用有界缓冲流，不套用 JSON 字节上限，仍受共享取消和期限
约束。客户端机制常量由设计定义，不增加公开配置项或 CLI 参数。超限明确失败，
不能静默截断或换用猜测目标；失败的原始内容读取允许已输出的部分字节，不能返回
成功。既有服务分页、图或业务约束保持不变。

业务执行必须处理 SIGINT、SIGTERM，并在 Windows 处理 SIGBREAK；执行结束后
移除自身监听器并释放期限资源，保留同一信号上的其他监听器。取消须传入配置读取
和后续共享操作；元数据操作在业务失败、最终取消或超限时不得输出结果。附件字节
输出必须可等待且支持背压，取消、超时或下游管道关闭时终止本次拥有的输出执行并
回收资源。原始流可能已有部分 stdout，退出状态仍必须反映失败。

超时、连接失败、取消、解析失败和服务拒绝必须区分；取消或预算用尽后停止翻页、
本地保存与后续写入。准备阶段超限不得保存发现结果或发送 task mutation。写请求
不自动重试；响应丢失、超限或取消发生于请求发送后时说明结果未确认，不能声称
远端没有写入。失败列表不输出看似完整的部分结果，失败缓存读取不使用猜测目标。

## PT10. 验收要求

| 编号 | 必须提供的证据 |
|---|---|
| V1 | 配置文件或 `serverUrl` 省略时默认 `https://daynight.cc`；无本地凭据在业务请求前提示 `daynight login`，401 同样提示且不重试；配置令牌校验可见 ASCII 与 HTTPS/字面量 loopback HTTP，已有请求附加 Bearer且不跟随重定向；review、帮助、版本及 update 保持依赖隔离 |
| V2 | 从真实 Git 仓库根目录、子目录、linked worktree 和 submodule 正确读取有效 origin；缺少仓库或 origin 时错误可辨 |
| V3 | HTTPS、SSH、SCP 等价 fixture 得到同一身份；单独 `.git` 路径有可比较身份，路径大小写、自定义端口、特殊用户、alias 和显式相对路径不被误合并 |
| V4 | 受控 HTTP 验证创建预检与 task discover 跨全部 project 页区分零、唯一、多匹配；创建唯一匹配保留原资源，多匹配列出 ID；后续页失败不保存关联、不输出成功、不发送 project POST 或 task 写入；project 操作不写绑定或 ignore |
| V5 | 首次唯一发现创建正确元数据和有效 ignore；并发写入不损坏记录，本地失败发生于 task mutation 之前 |
| V6 | 缓存每次通过远端详情验证，后增重复 project 不改变有效绑定；server 或 origin 任一变化均重新发现；404 或 repo 不符仅重新发现一次，网络及结构错误保持原因 |
| V7 | 显式 `--project` 在 Git 外可执行且不改自动绑定；显式 ID 缺失、无权限或读取失败不进入自动发现 |
| V8 | project 创建、列表、详情与 task 创建、筛选、详情、更新、图查询通过真实 Go server 联调；创建覆盖省略 repo 的 Git 发现，以及省略与显式 repo 再次创建均复用原资源且不改名称、不写本地绑定；所有写入遵循现有服务规则 |
| V9 | 更新覆盖读取版本、显式期望版本、并发冲突、空描述、依赖替换及清空；服务拒绝保留 task ID 且没有隐式重试 |
| V10 | 多页查询与 `--json` 仅完整成功后输出；task list 默认排除 done，支持 `--all` 和显式状态、互斥参数在 I/O 前拒绝、ready 交集及跨页稳定分组；文本列表省略描述、版本和时间，所有筛选形式的 JSON 列表仅省略 description 且保留其余全部字段、原始 PR 字符串、精确版本和时间戳，其他 task 资源输出保持完整；图保持完整响应字段并正确报告超限，stdout 可直接由 JSON parser 读取 |
| V11 | 单次期限、持续推进 cursor 耗尽总期限、单响应和累计字节超限、锁竞争、用户取消、错误响应、无效 JSON、损坏缓存及磁盘失败分别给出正确 stderr 和退出码；超限无部分输出或后续副作用，写响应未确认不产生虚假失败确定性 |
| V12 | CLI 既有 `pnpm typecheck`、`pnpm test`、`pnpm build` 及相关安装验收通过；Linux、macOS、Windows 的 Git、锁及文件替换有原生证据 |
| V13 | `task ready` 的默认和显式 limit、参数在 I/O 前拒绝、单次 `ready=true` 查询、合法 cursor 不续页、稳定服务顺序、完整 int64 JSON、空结果及超量/非 ready/重复 ID 响应拒绝均可观察；`task list --ready` 仍完整翻页，真实服务证明选择前 N 项及依赖完成后的 ready 变化 |
| V14 | `--allow-agents true/false` 的 update/list/ready 路径、静态补全、非法值在 I/O 前拒绝、字段必填严格读取、分页前筛选及跨页保留、返回筛选不符拒绝、精确版本/同值/运行锁与响应丢失不重试、JSON 及可读许可输出通过适用安装入口验证 |
| V15 | 平台 create/update 设置、update 清除与互斥、list/ready 兼容筛选、全部 shell 补全、非法值在 I/O 前拒绝、必填 null/枚举资源严格读取、兼容条件跨页保留和响应校验、精确版本/同值/运行锁/拒绝不重试及 JSON/可读平台输出通过适用安装入口和真实服务验证 |

配置、HTTP、仓库关联基础及 Project 命令已提供对应模块验证；Project 的实际编译
入口已在受控 HTTP 条件下验证创建、完整分页、详情、参数错误、服务拒绝、
取消、原始 JSON 与依赖隔离。Task 已通过参数、操作、渲染、仓库选择及实际编译
入口的受控 HTTP 验证；共享补全保留既有场景，并在真实 Bash/zsh 验证 Task 语法。
V1–V15 继续约束完整 CLI 交付。CLI 必须通过三原生平台的安装 CLI 受控 HTTP/Git
验收，以及实际安装 CLI 与真实 Go 1.27.2/PostgreSQL 18.6 的完整流程、重启和版本
竞争。生产默认值必须保持单次请求 30 秒、总操作 5 分钟、单响应 128 MiB 和
累计响应 256 MiB，并由测试单独断言。期限行为通过公开安装命令与流式 HTTP
验证；测试应仅对期限注入合理的较小值，覆盖响应开始后停顿，以及每页均在单次
期限内且 cursor 持续推进仍耗尽总期限。回执必须标明实际期限与 mock 状态。
响应和累计解码字节使用真实生产上限，均须提供精确边界成功及增加 1 字节拒绝的
配对证据，使用合法 gzip JSON 和空白补齐以保留小型结果输出。既有 review/update
安装验收和 Go 覆盖率门槛全部保留；完整 Go 工作负载与预算探针分别运行，后者
不占用 Go 默认 10 分钟计时器。

原生安装结果写入仓库根 `.tmp/project-task-evidence.json`，服务及预算结果写入
`.tmp/project-task-service-evidence.json`；每份证据标识源码、pack/安装身份、场景
和清理。Go 原有 receipt 及 raw coverage 保留其归属，CLI 要求编号使用 `PT.V*` 命名
空间。[PR #55](https://github.com/codetreker/daynight/pull/55) 保留真实 Go/PostgreSQL 联调及真实默认预算的历史源码验证结果；期限 mock 及验证成本的取舍记录在
[CI 验证效率决策](../../.agents/notes/archived/testing/2026-10-21-ci-validation-efficiency.md)，
逐次结果随对应 PR 与 CI 保存。受控 HTTP、真实服务与原生平台证据分别证明其对应要求，不能互相替代。
