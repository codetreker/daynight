# Project 与 Task 客户端设计

状态：共享配置、HTTP、仓库关联基础及 `project create/list/show` 已实现；
Task 命令、安装产物、真实 Go/PostgreSQL 联调及默认预算验收已完成，并通过三原生
平台及 Go 托管验证；集成状态见[PR #55](https://github.com/codetreker/daynight/pull/55)。
本文描述采用的结构和交付机制，当前可用命令见
[仓库 README](../../README.md)。必需行为与编号验收由
[客户端需求](../spec/daynight-project-task.md)拥有，服务行为由
[服务需求](../spec/daynight-server.md)拥有。结构决策与真实备选方案见
[决策记录](../../.agents/notes/implemented/architecture/2026-10-20-project-task-cli-design.md)及
[创建预检决策](../../.agents/notes/implemented/bug-fix/2026-10-21-project-create-repository-discovery.md)，
有界 ready 选择见[选择决策](../../.agents/notes/implemented/feature/2026-10-21-bounded-ready-task-selection.md)，
列表默认值与文本输出见[列表决策](../../.agents/notes/implemented/feature/2026-10-22-task-list-defaults.md)，
JSON 列表字段见[描述省略决策](../../.agents/notes/implemented/simplification/2026-10-22-task-list-json-description.md)。
任务起止字段与图时钟的读取机制由[执行计时架构](daynight-task-timing.md)扩展；
CLI 同步保留 `startedAt`、`completedAt`、`observedAt` 及 Project.settings，不产生本地推算时间；计时读取不新增人类可读字段。
Web 的共享时钟与卡片使用相同资源事实，展示机制归[看板设计](daynight-web.md)，不改变客户端传输或命令职责。

[预定义属性设计](daynight-task-properties.md)的 server 接口、CLI 成对 PR 引用
参数与完整输出已实现。[需求](../spec/daynight-task-properties.md)拥有扩展约定。完整 TaskProperties 包含只读 worker，公共输入使用独立的可写属性类型。Worker 直接复用进程内 ApiClient，具体认领方法、保留 nextCursor 的 listTaskPage 和已知 taskId 核对由[归属架构](daynight-worker-claims.md)拥有；不调用 task 命令包装层。

[附件架构](daynight-task-attachments.md)中的 `task attachment put/list/read/remove`
及二进制传输通道已实现，行为见[附件需求](../spec/daynight-task-attachments.md)。
Web 文件管理亦已实现。元数据查询按操作输出 JSON；
task list 的 JSON 仅省略 `description`，其他元数据查询保留各自完整资源。
文本输出选择列表摘要或完整资源，创建和更新输出完整文本资源；原始内容逐段写入
字节通道。
[CLI 决策](../../.agents/notes/implemented/feature/2026-10-21-task-attachment-cli.md)记录
流传输及输出辅助进程的选择。

CLI 默认使用 `https://daynight.cc`，显式 `login/logout` 管理通过设备授权自动取得的凭据，
共享 HTTP Bearer 传输与显式 PAT 配置继续复用；机制由
[设备登录决策](../../.agents/notes/implemented/architecture/2026-10-25-cli-device-login.md)拥有。
[鉴权架构](daynight-auth.md)和[需求](../spec/daynight-auth.md)拥有完整项目授权机制与行为；生产服务对全部
项目、任务、图和附件业务请求强制鉴权。设备登录复用现有 UniAuth 浏览器会话批准，
取得的凭据进入正常配置与 Bearer 请求通道；既有真实服务及预算验收的 PAT bootstrap 继续用于其独立验证。仓库关联不保存凭据、
不授予项目访问权；旧项目由部署者手工补齐成员关系。专用 set-status 与现有资源读写共用当前成员权限；管理员额外管理成员、邀请和项目提醒设置，不另设
状态专属角色。

## 现有基础与交付边界

本文已交付的 `project` 和 `task` 命令复用已有 HTTP API，不改服务或数据库。实现入口及字段可以由
以下现有文件核对：

| 现有归属 | 可复用事实 |
|---|---|
| [`cli/commands.ts`](../../packages/daynight/src/cli/commands.ts) 与 [`cli/application.ts`](../../packages/daynight/src/cli/application.ts) | 命令登记保留异步 `load`，应用统一处理 `0/1/2` 退出结果 |
| [`config/document.ts`](../../packages/daynight/src/config/document.ts)、[`config/files.ts`](../../packages/daynight/src/config/files.ts) | 共享严格 YAML、已知顶层字段、独立锁和原子配置保存 |
| [`commands/review/config.ts`](../../packages/daynight/src/commands/review/config.ts) | review 字段投影与 GitHub 专用 remote 身份规则 |
| [`api/index.ts`](../../packages/daynight/src/api/index.ts) | 命令级操作、服务 DTO、完整分页、有界 ready 选择、精确 JSON 与 HTTP 错误 |
| [`commands/server/runtime.ts`](../../packages/daynight/src/commands/server/runtime.ts) | 配置读取、共享操作、信号取消和完整结果输出 |
| [`commands/project/command.ts`](../../packages/daynight/src/commands/project/command.ts)、[`rendering.ts`](../../packages/daynight/src/commands/project/rendering.ts) | Project 参数、API 组合及完整资源渲染 |
| [`platform/text.ts`](../../packages/daynight/src/platform/text.ts)、[`platform/terminal.ts`](../../packages/daynight/src/platform/terminal.ts) | 与服务一致的文本验证及终端显示转义 |
| [`commands/review/paths.ts`](../../packages/daynight/src/commands/review/paths.ts) | 既有配置位置为 `~/.daynight/config.yml` |
| [`api/projects.go`](../../packages/daynight-server/api/projects.go) | project、分页及含 request ID 的结构化错误 |
| [`api/tasks.go`](../../packages/daynight-server/api/tasks.go) | task、派生字段、版本和字段可选的更新请求 |
| [`api/task_graph.go`](../../packages/daynight-server/api/task_graph.go) | 完整图、节点预览及 summary 响应 |
| [`service/repository.go`](../../packages/daynight-server/internal/service/repository.go) | 服务接受通用 HTTPS、SSH、SCP 地址，保存原始地址 |

现有 review 的 `remoteIdentity` 面向 GitHub 且把 owner/name 转小写，不能直接成为
通用 project repo 比较规则。新正规化器单独拥有服务命令的 repo 身份，保持 review
既有行为。共享读取与命令投影已经分离：review 运行解析要求非空 repositories，
server 投影只要求有效 server 地址；review 登记可向 server-only 文档添加首个仓库。

## 模块与依赖方向

`config/`、`api/`、`repository/`、共享 server runtime、Project 命令和既有
review/update/completion 及 Task 命令已实现。职责如下：

```text
src/
  cli/                     # 帮助、分发、通用退出结果
  config/                  # 全局路径、严格 YAML 读取、顶层字段登记
  api/                     # 服务 DTO 验证、请求、分页、结构化错误
  repository/              # Git 定位、repo 正规化、关联解析和原子持久化
  platform/                # 通用文件、服务文本契约及终端显示原语
  commands/
    server/                # 共享配置、操作与信号生命周期
    project/               # 参数、帮助、project 操作及渲染
    task/                  # task 与附件的参数、帮助、操作及渲染
    review/                # review 配置投影和既有行为
    update/                # 既有 npm 安装生命周期
    completion/            # 既有 Bash 和 zsh 原生补全
```

顶层通过业务无关的命令定义共享名称、描述、参数和补全语法，并保留惰性执行入口。
Project 的定义由 [`definition.ts`](../../packages/daynight/src/commands/project/definition.ts)
拥有，解析、帮助及 Bash/zsh 补全消费同一语法；补全机制由
[补全设计](daynight-completion.md)拥有。命令组先解析参数和帮助，校验名称及详情
UUID，再惰性加载共享 server runtime 和业务渲染。Task 的 definition、command 和
rendering 分别拥有语法、API/仓库关联组合及可读/JSON 输出，复用同一 server session。
`project create` 将名称声明为一个必填位置参数，`--repo` 声明为可选 text 选项。该定义声明
`allowOptionsTerminator`，使 `--` 后的词按位置参数处理，因而前导 `-` 的名称也能
原样提交。语法层只校验位置参数的存在性、非空字符串及声明的固定候选；名称的
Unicode 文本语义由 Project 命令在业务加载之前校验。
共享语法通过 `value.allowEmpty` 表达描述空值，通过 `value.choices` 表达状态允许值，
通过 `repeatable` 表达有序依赖数组；解析与静态补全消费这些事实，帮助使用定义中
的名称、值名、必填性与选项说明。
text 选项内联形式按首个 `=` 分隔并保留原值，目录及开关继续拒绝内联。
project/task 不导入 review runtime、SQLite 或外部审查适配器。`project list/show` 和
显式 repo 的 create 只需要配置与 HTTP；省略 repo 的 create 才加载 Git 发现，不
加载仓库关联保存。task 显式 project 分支也只需要配置与 HTTP；自动分支才加载 Git
与仓库状态。共享模块不反向导入命令模块。

配置共享层产出 YAML mapping 和文档上下文，拒绝语法、重复 key、非 mapping 及
未登记顶层字段。review 投影只解析 review 字段；server 投影在文件或 `serverUrl` 缺省时
使用 `https://daynight.cc`，校验明确提供的地址与可选 `serverToken`。共享层保留 YAML 格式，
不迁移 review 数据。服务调用不进入配置引导；缺少本地凭据时在网络前提示 `daynight login`。
已有无效服务值、共享文档错误及读取错误直接暴露。
review 配置可始终省略，其业务字段不参与服务校验。YAML 错误以安全类别、代码和
位置表达，原始标量及 parser cause 不进入错误对象。共享写入者在持锁重读的文档上
保存，含令牌结果使用 POSIX `0600`；无令牌文件继续既有权限行为，普通文件/符号
链接检查与原子替换不变。

[`platform/text.ts`](../../packages/daynight/src/platform/text.ts) 统一名称、标题及 DTO
已知字符串的结构验证：合法 Unicode 文本、不含 NUL；非空文本还须包含 Unicode
`White_Space` 之外的字符。该规则与 Go 服务一致，U+FEFF 可以单独构成名称，
U+0085 则不能。验证保留字符串原值，不修剪空白，也不拒绝服务允许的其他控制字符。
Project 名称参数与响应 DTO 复用同一规则，避免已被服务接受的资源阻断完整列表。

## 服务地址与 HTTP 客户端

`serverUrl` 解析为 HTTP(S) origin：协议与主机采用 URL 标准形式，默认端口省略，
末尾根斜线省略。拒绝用户信息、非根路径、query 和 fragment。API URL 从该 origin
与固定 `/api/v1/...` 构造，资源 ID 作为单一路径段编码，分页 cursor 通过 query
编码。配置值不得允许请求参数改变服务 origin。

`serverToken` 为非空 opaque visible ASCII，仅 HTTPS 或 host 为字面量 `localhost`、
`127.0.0.0/8` 数值 IPv4、`::1` 的 HTTP 允许使用。测试服务和自动化由外部受控配置文件
提供现有 `serverUrl` 与 `serverToken` 字段；省略 origin 使用生产默认值。准备者必须将凭据和目标
origin 配对，切换服务时移除或替换旧令牌；外部编辑不执行 CLI 的锁、原子替换或凭据清理协议。
CLI 登录/退出在锁内共同核对 origin/token，保留其他能力已完成的并发修改。

`login` 使用独立十分钟期限调用设备授权接口，显示短码并打开同源验证页，`--no-browser`
仅显示 URL/短码。它按服务要求轮询，批准后在配置锁内重查 origin 与凭据观察值并保存，避免覆盖
期间的另一次登录或地址变更。`logout` 通过当前 Bearer 撤销自身，确认成功或已失效后同样在锁内
清除观察到的凭据，保留并发写入的新值。完整设备授权、到期和撤销机制由
[鉴权架构](daynight-auth.md#cli-设备授权)拥有。

共享 API 请求边界为已有 project/task/graph/property/attachment 请求附加 Bearer，覆盖文件、分页
和错误路径。继续使用 manual redirect，不向重定向目标转发凭据。无本地令牌的业务调用在请求前失败，
服务 401 给出 `daynight login` 指导，不自动登录、匿名回退或重放写请求；403/404/409、精确 int64、
分页、二进制输出与既有预算保持。凭据不写仓库关联，命令定义、登录实现和业务 HTTP 分工独立。

完成参数分派后，`runServerCommand` 在首次配置读取前创建取消控制器及 `Operation`，
配置与业务共享五分钟总期限。业务预算覆盖配置读取、Git 定位、缓存验证、全部分页、本地锁、
文件准备、HTTP 和结果渲染。所有步骤共享剩余预算，不能因翻页或重新发现重置。每个请求期限为 30 秒与命令剩余期限的较小值，覆盖连接和
响应体读取；用户取消沿用同一命令取消源。请求成功、失败或取消后清理单次期限及
监听器；同步 JSON 解析后也按单次及总期限检查。分页请求串行执行，取消及任一
失败阻止后续页面、本地保存和写请求。

共享 runtime 将同一信号传给 `loadServerConfiguration`；配置读取层接受可选的
`AbortSignal` 并传入 `readFile`，同步 YAML 解析完成后再次检查操作状态。已正规化
的 server 地址、API 客户端及操作对象组成 `ServerSession`。业务 callback 返回
`string | void`：元数据命令返回完整渲染字符串，runtime 最终检查后调用一次 stdout；
附件 read 通过可等待的字节输出逐段写入并返回 void。SIGINT、SIGTERM 及 Windows
SIGBREAK 触发同一取消源。结束时先等待 `closeStdoutBytes` 关闭并回收实际创建的
辅助进程，再移除自身监听器并 dispose 操作，保留其他消费者的监听器。真实 CLI
上下文始终提供该关闭函数，注入上下文可省略它。命令和清理失败均保留原因。

每个 JSON 响应最多读取 128 MiB，单命令累计 JSON 响应体最多读取 256 MiB；MiB 为
1,048,576 字节。按解码 HTTP 内容编码后的响应体字节流计数，包含 JSON 成功与错误响应，
在 JSON 解析前累计；不能只相信 `Content-Length`。超过任一上限立即取消读取并
报告响应或累计预算超限，不解析已截断 JSON。这些常量与总期限共同限制持续推进
cursor 的扫描及累计 JSON 内存；预算不增加公开配置字段，也不改变 server 限制。
`task ready --limit` 仅选择返回任务数，不改变期限或字节预算。附件原始内容上传和
成功读取使用有界缓冲的字节流，不经过上述 JSON 字节上限；取消和请求/总期限继续
覆盖传输和等待 stdout 背压的过程，错误响应仍按 JSON 预算处理。
JSON 对象在完成有界读取后解析；下一步及最终输出前再次检查总期限与取消状态。
失败时取消并释放响应 reader；清理最多额外占用 100 ms，取消失败或清理超时与
原始失败一并保留，不能吞掉清理错误，也不能因底层取消迟迟未完成而无限等待。

读准备阶段超限时不保存绑定、不发 mutation、不输出部分结果。若超限发生于已经
发出的写请求响应，远端结果仍未确认，沿用写入不确定性诊断，不能断言写入未发生。

HTTP 层按操作消费 JSON、原始字节或空响应，只接受 API 规定的成功状态；JSON
响应继续校验结构，删除必须为 204 且响应体为空。缺失字段、错误类型、未知
状态值、无效分页 cursor 形态及不完整错误 envelope 作为协议错误暴露。验证可消费
的已知字段，服务将来添加无冲突字段无需猜测其含义。full task 与图节点读取必填、可空的
`startedAt`、`completedAt`；图另外读取必填 `observedAt`。`null` 表示未知事实，缺失不能兼容为 `null`；
已知值使用与现有资源相同的合法 UTC `Z` 时间格式验证，秒后允许 1–9 位小数，并保留原始字符串。DTO 的时间、版本、UUID 和
数组语义与现有服务契约一致。错误保留 cause，并区分网络、期限、主动取消、HTTP
拒绝和响应结构失败。

所有写请求只发一次，HTTP 层不自动重试、不自动跟随改变写入目标的重定向。写入
后的网络失败或取消意味着结果未确认；诊断明确说明这一点，并提供 project/task
目标供用户查询。读取也不自动重试，避免隐藏服务与分页失败。

## Git 定位与仓库身份

自动选择从调用目录执行 Git，使用 `git rev-parse --show-toplevel` 定位当前 worktree
根目录，并拒绝 bare repository。根目录必须是非空绝对路径，再转换为平台原生
路径形式。使用 `git remote get-url origin` 获取默认 fetch
URL，由 Git 处理 `insteadOf`；不读取 push URL、不自行实现 Git 配置优先级，也不
解释 SSH config、DNS 或 provider API。Git 命令受同一剩余总期限约束，stderr 进入保留
原因的错误链。操作不 clone、不 fetch。每个 Git 子进程最多使用 30 秒与共享总期限剩余值的
较小者，stdout、stderr 分别最多捕获 1 MiB；超限或取消时终止任务拥有的执行。
读取索引时以 `-c core.fsmonitor=false` 关闭外部 fsmonitor，避免优化工具继承管道
或启动后台工作。POSIX 使用并等待独占进程组，Windows 使用系统目录下的
`taskkill /T /F` 处理所属进程树。终止与管道收尾最多额外占用 2 秒；无法确认时
保留原始错误并报告进程终止未确认，不能无限等待继承的输出句柄。

repo 正规化对本地 origin、每个列表 repoUrl 和详情 repoUrl 使用同一函数。返回值
是可持久化的 `repoIdentity` 字符串；它不是替换原始 repoUrl 的提交字段。

### 正规化算法

1. 按服务已支持的 HTTPS URL、SSH URL、SCP 风格分类。先验证完整输入，拒绝凭据
   密码、query、fragment、空主机和空仓库路径。SCP 识别需支持括号包围的 IPv6。
   本地文件地址和不支持的协议不能成为自动发现身份。
2. 主机名转小写；IPv6 采用同一规范文本及括号表示。保留 alias 的字面主机名，
   不添加或删除主机末尾点、不把 alias 替换成其他主机。路径大小写及百分号编码
   原样保留，不进行 percent decode、Unicode 规范化、路径分隔折叠或 dot-segment
   消解。实现不能让通用 URL parser 先静默改写路径。
3. 对路径去掉末尾连续 `/`；仅在移除后仍有非空仓库路径时，才移除一个大小写精确
   匹配的 `.git` 后缀。URL 的根 `/` 不是仓库路径，因此 `/.git` 和 SCP 的 `.git`
   均保留字面 `.git`。不删除中间 `/`，不把 `.GIT` 当作 `.git`。正规化必须为每个
   服务有效地址产生身份，不能因后缀处理把有效地址变成解析错误。
4. 普通 hosted 形式要求默认端口：HTTPS 使用根相对仓库路径，SSH URL 使用用户名
   精确为 `git` 的普通仓库路径，SCP 使用默认 `git` 用户和普通仓库路径。路径不含
   空段、`.`、`..`，不以 `~` 开始。普通形式
   去掉 URL 路径的一个根 `/`，输出 `<host>/<path>`。HTTPS 默认端口 443、SSH
   默认端口 22 与各自省略端口相同。SCP 普通 `git@host:owner/repo` 按 hosted
   repo 的常见写法参与该合并；显式 `:./`、`:../`、`:~/`、`:/` 保留路径形式。
5. 非普通形式保留 transport 信息，避免误合并：HTTPS 使用
   `https://<host>[:<port>]/<path>`，其中非默认端口必须保留；SSH URL 使用
   `ssh://[<user>@]<host>[:<port>]<path>`；SCP 使用
   `scp://[<user>@]<host>:<path>`。用户名的有无及大小写、显式根路径与相对路径
   均保留。端口使用十进制规范形式；默认端口可省略，但特殊用户或特殊路径仍保留
   transport 形式。SCP 中的冒号后路径不解释为端口。

用户名编码保持原样，只有字面用户名 `git` 参与普通 SSH 合并；例如 `%67it`
仍保留 transport 身份。普通 hosted 地址是双方约定的等价表达；该规则不证明任意 SSH 服务的路径语义。
需要表达特殊 SSH 用户、根路径或相对路径时，保留形式允许仓库登记与 origin 精确
对应；若两端写法语义是否等价无法由规则证明，用户可显式 `--project`。

### 正规化 fixture

| 输入 | 身份或比较结果 |
|---|---|
| `https://GitHub.com/Org/Repo.git/` | `github.com/Org/Repo` |
| `ssh://git@github.com:22/Org/Repo.git` | `github.com/Org/Repo` |
| `git@github.com:Org/Repo.git` | `github.com/Org/Repo` |
| `https://github.com:443/Org/Repo` | `github.com/Org/Repo` |
| `https://github.com/org/repo` | 保留小写路径，与 `github.com/Org/Repo` 不同 |
| `https://git.example/Group/Sub/Repo.git` | `git.example/Group/Sub/Repo` |
| `https://git.example:8443/Group/Repo.git` | `https://git.example:8443/Group/Repo` |
| `ssh://git@git.example:2222/Group/Repo.git` | `ssh://git@git.example:2222/Group/Repo` |
| `ssh://alice@git.example/Group/Repo.git` | `ssh://alice@git.example/Group/Repo` |
| `alice@git.example:Group/Repo.git` | `scp://alice@git.example:Group/Repo`，与上一行不同 |
| `ssh://git.example/Group/Repo.git` | `ssh://git.example/Group/Repo`，保留缺省用户 |
| `git@work-github:Org/Repo.git` | `work-github/Org/Repo`，不解析为 `github.com` |
| `git@git.example:./Group/Repo.git` | `scp://git@git.example:./Group/Repo` |
| `git@git.example:/Group/Repo.git` | `scp://git@git.example:/Group/Repo` |
| `ssh://git@git.example/~/Repo.git` | `ssh://git@git.example/~/Repo` |
| `https://git.example/Org/Repo%2Egit` | `git.example/Org/Repo%2Egit`，不等于 `git.example/Org/Repo` |
| `https://git.example/Org/%52epo.git` | `git.example/Org/%52epo`，不等于 `git.example/Org/Repo` |
| `https://git.example/Org/Repo.git.git` | `git.example/Org/Repo.git` |
| `https://git.example/Org/Repo.GIT` | `git.example/Org/Repo.GIT` |
| `https://git.example/.git` | `git.example/.git`，保留非空字面仓库路径 |
| `git@git.example:.git` | `git.example/.git`，与上一行相同 |

## 自动发现与关联寿命

关联文件严格包含 `serverUrl`、`repoIdentity`、`projectId`，分别为已正规化服务
origin、repo 身份和合法 UUID。记录是本地目标选择信息，远端详情仍是事实来源；它
没有 TTL，也不保存 task 状态、列表或认证信息。文件格式错误不能等价于文件缺失。

显式 `--project` 分支不依赖 Git 或本地记录，按 ID GET project 后执行操作；错误
直接返回。自动分支执行以下状态流：

```mermaid
flowchart TD
  A[读取当前 server、worktree 和有效 origin] --> B{有效本地关联匹配 server 与 repo?}
  B -- 是 --> C[GET 关联 project]
  C -- repo 匹配 --> D[选定原有 project]
  C -- 404 或 repo 不符 --> E[一次 discover]
  C -- 网络、服务或结构错误 --> F[失败]
  B -- 否 --> E
  E --> G[读取全部 project 页并正规化比较]
  G -- 零匹配 --> H[Project does not exist]
  G -- 多匹配 --> I[歧义错误及匹配 ID]
  G -- 唯一匹配 --> J[GET 并验证 project 详情]
  J -- 有效 --> K[保存本地关联]
  K --> D
  J -- 失败或关联变化 --> F
```

列表先全量成功再判定；任何 repoUrl 无法按服务契约解析都作为响应错误，不能跳过
以免制造“唯一匹配”。详情验证发现 404 或 repo 已变化时，不递归重新发现：本次
发现已经用尽，报告目标变化并失败。有效缓存不再扫描完整列表，因此后来添加同 repo
的第二个 project 不会改变目标。跨命令没有本地存在即远端存在的承诺。

每个请求在服务中独立验证资源；CLI 的 GET 与后续请求不构成跨请求事务。GET 成功
后 task 请求可能返回 404 或冲突，按真实结果报告，不通过重新发现切换 project 后
重放写操作。

## 本地文件、锁与写入顺序

`.daynight/project.yml` 位于当前 worktree 的根目录，不放在共享 Git common dir。
该选择让不同 worktree 可以保留各自的关联，并让 submodule 保持自己的边界。
目录预留其他仓库专属文件的空间，本设计只定义 project.yml。

首次持久化或替换关联需取得仓库级元数据锁；锁保护重新读取记录、根 `.gitignore`
的读改写和 project.yml 替换。锁内再次检查当前记录，若其他进程已经保存同一有效
关联则复用；若保存了不同 project，重新验证其适用性，不能仅因锁外 discovery
较早开始就覆盖已确定的有效绑定。锁已由有效持有者占用时立即报告竞争失败，既不
等待也不重试。创建锁前及取得锁后检查取消和剩余总期限。锁文件记录进程 ID 与
随机所有权 token，释放前核对文件身份和内容。已有锁均保留并报告；异常退出后的
残留锁须确认写入者已经停止后人工移除。普通文件的读取与 unlink 不能构成原子
比较删除，因此不按 PID 或锁年龄自动回收，避免误删并发建立的新锁。

写入先检查根 `.gitignore` 中的 `/.daynight/` 及最终 ignore 结果；需要时以保持
既有内容和换行风格的方式写入该规则。后续否定规则可能使该目录重新被包含，必须
在文件末尾确保规则生效并用 Git 分别检查目录本身和 project.yml；仅 project.yml
被忽略不足以保护锁文件及后续仓库信息。已有被跟踪 `.daynight/` 内容不能通过 ignore
隐藏，需报错并提示处理索引。`.gitignore` 不是普通文件、不可写或最终规则仍不
生效时失败。

配置文件、ignore 和元数据共享 `platform/files.ts` 的原子替换原语，各自负责
锁与输入校验。元数据序列化到同目录任务拥有的临时文件，完成写入后原子 rename 替换目标，成功
后释放锁。`.gitignore` 也用同目录临时文件替换，避免截断。两个文件没有跨文件
事务：ignore 成功而 metadata 失败时保留有效 ignore 并报告失败；不回滚期间可能
已有其他进程修改的文件。metadata 从不先于有效 ignore 落地。

自动发现引起的目录、ignore 和 metadata 准备必须在 POST/PATCH task 之前完成。
即使 task 操作随后失败，有效绑定仍可保留。仅查询也可以首次发现并保存关联，这
是自动定位约定的本地副作用。显式 project 分支不发生该副作用。任何路径上的
原始读写错误和清理错误保留因果，不能降格为无缓存。

## API 映射与更新机制

| CLI 操作 | API |
|---|---|
| `project create <name> [--repo <repo>]` | 完整 `GET /api/v1/projects` 预检；仅零匹配时 `POST /api/v1/projects`，提交原始 `name`、`repoUrl` |
| `project list` | `GET /api/v1/projects`，读到 `nextCursor: null` |
| `project show <id>` | `GET /api/v1/projects/{id}` |
| `task create [--required-platform <platform>]` | `POST /api/v1/projects/{projectId}/tasks`，可选 requiredPlatform |
| `task list` | `GET /api/v1/projects/{projectId}/tasks`，保留相同筛选遍历 cursor |
| `task ready [--limit <N>] [--allow-agents true\|false] [--compatible-platform <platform>]` | 单次 `GET /api/v1/projects/{projectId}/tasks?ready=true&limit=N`，可带 allowAgents、compatiblePlatform，不提交 cursor |
| `task show <id>` | `GET /api/v1/projects/{projectId}/tasks/{id}` |
| `task update <id>` | 可选先 GET task，再 PATCH 同一路径，只写元数据 |
| `task set-status <id> <status>` | 可选先 GET task，再 PUT 同一 task 的 `/status`，body 严格包含 version/status |
| `task delete <id> [--remove-depends]` | 可选先 GET task，再 DELETE 同一路径提交精确 version；可选开关明确发送 removeDepends=true 解除全部传入引用，默认严格删除；成功 `204`，保留任务与附件 |
| `task graph` | `GET /api/v1/projects/{projectId}/task-graph`，不附加 query |
| `task attachment put <id> <file>` | `PUT /api/v1/projects/{projectId}/tasks/{id}/attachments/files/{path...}`，流式请求体，接受 200/201 元数据 |
| `task attachment list <id>` | `GET /api/v1/projects/{projectId}/tasks/{id}/attachments`，按路径身份读完分页 |
| `task attachment read <id> <path>` | `GET /api/v1/projects/{projectId}/tasks/{id}/attachments/files/{path...}`，原始字节逐段输出 |
| `task attachment remove <id> <path>` | `DELETE /api/v1/projects/{projectId}/tasks/{id}/attachments/files/{path...}`，接受 204 空响应 |

`project list` 和 `task list` 使用服务支持的 `limit`，客户端固定选择 100 以减少
请求；不提供公开 cursor 选项。cursor 是不透明字符串，逐页提交，不在 CLI 解码
或重建。每页验证后累积结果，末页才渲染；重复 cursor 或不前进的循环响应作为
协议错误终止，不能无限请求。多页读取继承服务不提供跨请求快照的边界，CLI 不
宣称列表是同一时间点的完整快照。

`task list` 的状态选择和展示顺序属于命令层。默认从完整结果中排除 `done`；
`--all` 保留所有状态，`--status` 使用既有单状态查询，两者互斥并在任何 I/O 前
拒绝。`--ready` 沿用服务筛选，与所选状态取交集，包含 `--all --ready`。`list`、`ready` 的 `--allow-agents true|false` 直接投影到服务查询；未提供、true、false 各自保留。完整分页保持该筛选，返回项不匹配时拒绝，不在客户端过滤掉一页中的任务。
命令在全部分页成功后按 `in_progress`、ready、其余 `todo`、`done` 稳定分组，
同一组保留服务按 `createdAt ASC, id ASC` 返回的跨页顺序。文本和 JSON 消费
同一选择结果，因此分页边界不会改变组间优先顺序。此机制复用既有 API 筛选和分页，
不增加服务排序或多状态查询契约。

API 响应与命令 choices 均只接受 todo、in_progress、done，拒绝旧状态。
graph summary 只返回 total、todo、inProgress、done、ready、blocked；图文本不显示旧统计。
列表默认保留未完成任务，按 in_progress、ready todo、其他 todo、done 稳定分组。
元数据 update 不声明 status，状态由专用 set-status 提交；详见[状态架构](daynight-task-status.md)。删除由专用 delete 提交精确版本，省略版本时只预读一次；可选 --remove-depends 决定是否明确发送 removeDepends=true，未提供时不解除引用。成功无需 Task 正文，不自动重试。已删除资源返回 `410 task_deleted`，业务保护与数据保留由[软删除设计](daynight-task-deletion.md)拥有。

平台 DTO 要求 requiredPlatform 字段存在且为null/windows/linux/macos，不在读取器补默认。
create/update 的 --required-platform 设置枚举，update --clear-required-platform 发送null并互斥；
省略保留。list/ready --compatible-platform 与许可、状态、ready共同投影到服务查询并绑定cursor，
先于分页/上限，客户端验证响应匹配并暴露协议错，不本地删项。平台不改变ready或人工setter。

`task ready` 将常见的下一项工作选择限制为前 N 项，避免项目积累任务后每次
选择都读取完整 ready 集合。命令校验 `--limit` 为十进制整数 `1..100`，省略时
为 `10`；无效值在配置读取、Git 与网络访问之前拒绝。它不接受 `--status` 或
`--cursor`。`api/client.ts` 的 `listReadyTasks` 独立拥有有界操作，使用既有 task
列表接口发送一次 `ready=true`、`limit=N` 和可选 `allowAgents`、`compatiblePlatform` 请求。DTO 继续验证完整分页 envelope；
合法 `nextCursor` 表示尚有候选，调用方不跟随。无论当前响应是否达到 N 项，都不
补发请求。`task list --ready` 仍执行完整分页。

服务既有查询按 `createdAt ASC, id ASC` 排序，ready 表示 `todo` 且直接依赖全部
为 `done`，许可独立于这个 ready 定义。有界 ready 保留服务顺序，在返回前验证项数
不超过 N、每项为 ready、task ID 不重复。超量、非 ready 或重复资源都报协议错误，
不截取、丢弃或修复响应。`listReadyTasks` 与完整列表复用 DTO、精确 JSON 和
同一 `Operation` 的取消、期限、字节预算及最终输出检查。完整依赖图仍供按需查看
关系使用；日常候选选择可以直接使用 ready。

创建先确定 repo：显式 `--repo` 直接使用原值，并跳过工作目录查询及 Git；省略时
直接复用 `repository/git.ts` 的 `discoverRepository`，读取当前 worktree 有效
`origin`，包含 `insteadOf` 展开。随后将该地址及全部列表结果的 `repoUrl` 交给
`repository/identity.ts` 的同一正规化器比较。零匹配才 POST 原始名称和原始地址；
唯一匹配通过既有资源渲染器输出 `Project already exists.` 及完整 project，不改名
或更新 repo；多匹配列出 ID 并失败。此路径不调用 task 的 `resolveProject`，因此
不读取或保存 `.daynight/project.yml`，也不写 ignore 规则。

Git、完整分页、身份比较和后续 POST 共用同一 `Operation`；每步完成后检查取消和
剩余期限，预检失败不能进入创建。身份比较失败保留具体错误，也不能变成零匹配。
完整扫描不是服务端事务，扫描完成与 POST 之间仍可能有并发创建；服务的重复
repo 许可、API、schema 和事务政策保持原样。原子唯一性需要独立的服务契约决策。

更新参数先转换为字段存在性明确的 patch：空描述写 `""`，未出现描述选项不写 key。
compileDependencies 只在关系选项出现时加载 UUID 校验；普通 N 与外部 E 均正规化、去重并排序，
重复选项逐项提供 ID，不做 CSV 拆分。任一声明选项出现就发送 D=N∪E 和精确 E，
普通单独声明 E=[]，外部单独声明 D=E。都省略不写关系字段；clear 发送 D/E 两个空数组并与任一声明互斥。
列表内或跨列表重复、非法 ID、无修改字段、已移除 status 或非法版本在配置、Git、网络前拒绝。
`--description ""` 与 `--description=` 均为明确的空字符串。

可重复的 `--pull-request-url` 与 `--pull-request-title` 使用 `allowEmpty`，各自
保留出现顺序，第 n 个 URL 对应第 n 个标题；次数必须相等，字符串不作内容校验。
配对值写为 `properties.pullRequests` 完整替换数组；`--clear-pull-requests` 写
空数组并与任一配对选项互斥。省略这些选项时不生成属性 patch，只有属性修改也
满足 update 的修改字段要求。次数和互斥校验在任何 I/O 之前完成。

元数据更新默认 GET task 获得 version，再带该 version PATCH；两个请求之间发生并发更新时，
服务返回 `version_conflict`。有 `--if-version` 时直接提交指定版本，不用 GET 的
最新值替代。CLI 不重放 PATCH，不将旧版本冲突改成成功；语义无变化的响应也直接
按服务返回渲染。生命周期操作复用相同 project 解析、Operation、int64 序列化和
完整 mutation 渲染器；显式版本直接 PUT status，省略时仅 GET 一次，无冲突重试。当前版本同状态 +0，实际改变 +1。
显式 project UUID、show/update/set-status/delete 的 task UUID、标题、描述、
版本及修改字段组合在配置、Git 和网络前验证；依赖选项存在时才懒加载 canonicalId，并在本地正规化、排序及拒绝非法/重复 UUID。显式 `--project` 直接 GET project，不读取工作目录或
加载仓库模块；自动分支将 `serverUrl`、同一 `Operation`、API 和工作目录交给
`resolveProject`。解析返回后才发送 task 请求，因此本地准备失败没有 task mutation。
服务负责事务内的状态、依赖及时间戳不变量。

`Task` 和 graph-task 解码要求 `allowAgents` 为明确布尔值；不从缺失、null 或字符串补默认值。`update --allow-agents` 把实际布尔放入普通 PATCH，省略时不产生该字段；create 不接受该选项。同值与 in_progress 锁定由服务判定，命令不自动重试。参数定义同时提供 true/false 的静态补全。

`requiredPlatform` 在完整 Task 与 graph-task 均为必填 null/三平台枚举。创建只在 `--required-platform` 出现时发送枚举；update 用同名选项设置，或用互斥的 `--clear-required-platform` 发送 null，二者都省略时不生成 key。静态 choices 为 windows/linux/macos，同一参数定义拥有帮助和三种 shell 补全。服务器负责同值、锁定和迁移语义；CLI 不以缺字段默认值兼容旧资源，也不把查询参数当作实际运行环境。后续 worker 根据自身运行环境选取该枚举，WSL 的 Linux 运行时属于 linux。

`Task.version` 与 PATCH 版本覆盖完整正 `int64` 范围，内部使用 `bigint`；JSON 读取
从数字原文保留精度，写入及 `--json` 使用 JSON 数字，不能转换为字符串或不精确的
JavaScript `number`。Project、分页项目及 graph.project 的必填 settings 使用同一精确版本规则，
`executionWarningMinutes` 为正 int32。CLI 既有嵌套数字原文读取保留 settings.version 的完整十进制值，
JSON 输出不转为字符串，Project 可读输出保持既有标签。未知响应字段继续由 DTO 投影忽略，
不能因未知对象中的同名 version 字段触发已知 task 或 settings 的校验。

任务及图的已知读取字段还包括必填 `externalDependsOn`。CLI 依赖解码要求正规化、升序、
不重复的 D/E，并验证 E 属于完整 D；缺字段不使用兼容默认值。JSON 保留该数组，
列表只省略 description 的规则不变。人类 task、list、ready、操作结果和 graph 复用依赖区，
输出 `External dependencies (N): <ID 列表或 none>`。HTTP 客户端保留独立可选 D/E，服务负责部分 PATCH；
命令层依赖声明则总是提交完整 D/E，与 API 单独给 D 保留存续性质的语义不同。
完整示例见[外部依赖架构](daynight-external-dependencies.md)。

## 附件命令组合

`commands/task/command.ts` 在轻量语法解析后才加载 `attachment.ts`；该模块组合现有
server session 与 project 选择，不引入 review 生命周期。`put` 打开来源并对已打开
句柄检查普通文件属性，上传使用该句柄，最后显式关闭；输入准备失败不会发出远端
写请求。`--path` 默认使用本地 basename，`mime` 4.1.1 根据最终逻辑目标路径推导
MIME，未知扩展名使用 `application/octet-stream`。

路径经过业务校验后按段编码一次。附件分页以完整 path 作为资源身份，拒绝页内或
跨页重复路径及循环 cursor，读完全部页面才返回元数据。原有 task/project 列表继续
以 UUID 为身份，task version 的无损 JSON 读写保持不变。

附件的 `--path` 声明为 text 选项；`put/read/remove` 在定义中启用 `--` 终止选项
解析，使前导连字符的位置路径可以原样传入。帮助和原生补全消费同一嵌套命令树；
没有为附件维护第二套解析或补全入口。具体二进制输出、关闭和辅助进程机制由
[附件设计](daynight-task-attachments.md#cli)拥有。

## 输出与诊断

Project 渲染由 `commands/project/rendering.ts` 拥有，与 API 数据分离。create 在
服务确认后输出创建结果及完整资源；list 按顺序输出独立的带标签资源块，每块包含
`ID`、`Name`、`Repository`、`Created`、`Updated`，show 使用同一资源格式。空列表
输出 `No projects.`。文本不截短，按实际字段长度生成，输出空间随全部字段总长度
线性增长，长名称不会为其他项目产生等宽填充。

[`terminalText`](../../packages/daynight/src/platform/terminal.ts) 将可读字段中的换行、
回车和制表符显示为 `\n`、`\r`、`\t`，其他 C0/C1 控制字符及 U+2028、U+2029
显示为 `\uXXXX`。普通 Unicode、emoji 和原有反斜线保持原样；该转换只属于终端
显示，不改变提交给服务或 JSON 输出的数据。

Task 的 `rendering.ts` 提供列表标签块与完整资源标签块，均显示 `Automatic execution` 的真实布尔值与 `Required platform`，null 平台显示为 any，其他值保留枚举；graph 的可读节点同样保留两字段。列表包含 `ID`、
`Project`、`Title`、`Status`、`Ready`、`Depends on`、`Blocked by`，以及关联 PR
数量、按顺序编号的 title/url；完整资源另外包含 `Description`、完整十进制
`Version`、`Created` 和 `Updated`，供 show、ready、create 和 update 使用。
依赖/阻塞为空时显示 `none`，空 list 为 `No tasks.`，空 ready 为 `No ready tasks.`。
PR 字符串只检查类型，保留空、重复、控制字符与原有顺序，可读输出继续使用
terminalText。创建和更新分别以 `Task created.`、`Task updated.` 表明服务确认结果。
Graph 展示完整 project、六个 summary 字段及全部节点；节点的 `titlePreview` 与
`titleTruncated`
同时展示，保留既有状态、ready、依赖、阻塞和创建/更新时间，不能把预览称为完整标题。
新增起止字段和图时钟由 JSON 保留，不为可读渲染器增加标签。所有字段
使用终端转义且不补齐等宽列，空间随资源内容总长度线性增长。

查询 `--json` 是脚本和模型调用 CLI 的稳定接口：show 为完整资源对象，project list
为所有匹配资源的完整字段数组，task list 为所有匹配 task 仅省略 `description`
的数组，ready 为所选完整 task 的数组，graph 为服务原始完整响应对象。
Task 的 `renderTaskListJson` 在命令完成状态选择和稳定分组后建立输出投影，
每个 task 只移除 `description`；默认及所有合法筛选共享该路径。其余字段保留
API 名称、类型及原始值，包括 PR 列表、完整 int64 版本、时间戳以及明确的起止 `null`；
graph JSON 保留顶层数据库 `observedAt`。这些字段不在命令层计算或省略，并继续使用
`stringifyApiJson` 精确序列化。完整 API DTO、验证、分页、服务响应及其他操作
不采用该投影，描述仍由 show、ready、create 和 update 返回。
ready 空结果为 `[]`，不输出分页 envelope 或 cursor。仅序列化 API 字段，不加入
渲染专用字符串、进度或诊断；无额外 model agent tool 或遥测框架。元数据查询在读取
完成前保持 stdout 为空，确保脚本不会消费前半段成功结果。附件 list 同样完整输出
元数据；read 输出原始字节，传输失败时可能已有部分内容，错误及非零退出仍必须
保留。写操作输出已确认的资源结果；任何失败均不打印成功文案。

stderr 错误包含操作名、已确定的 project/task ID、失败阶段和可用的服务
`error.code`、`message`、`requestId`。相关 `taskIds` 或图数量与上限应可读地展示。
保留服务 request ID 使 CLI 失败可与现有 server 请求日志关联；无服务响应的网络
失败明确标为本地请求失败。默认不记录完整配置、请求体、环境或凭据。

边界错误保留 cause，顶层统一映射退出码：参数 `2`，操作 `1`，成功 `0`。超时与
用户取消在错误文字中有区别；取消后释放客户端锁、期限及监听器，清理任务拥有的
临时文件，不控制 server 进程。若写请求已发送而无确认，说明结果未确认，
不能声称数据库未写入。

## 验证与交付证据

验证由需求 V1–V15 约束。测试按模块归属组织，避免只镜像实现分支：

| 层次 | 关键观察 |
|---|---|
| 纯数据与参数 | 正规化表和拒绝 fixture、字段存在性、依赖替换/清空、版本参数、ready limit 默认/边界/拒绝、JSON 格式 |
| CLI 依赖边界 | 缺失 Git/SQLite/review 工具、配置文件或 serverUrl 时，帮助、版本、update 与 review 保持独立；省略地址使用生产默认值，非法显式值失败，无本地凭据在网络前提示登录；显式 repo 创建、列表和详情不读取工作目录或 Git；login/logout 的浏览器和配置生命周期独立验证 |
| Git 与本地状态 | 真实仓库的 insteadOf、子目录、worktree、submodule、ignore 生效、被跟踪目录、并发锁及原子替换 |
| 受控 HTTP | 创建及 task discover 的多页零/一/多匹配、唯一匹配创建命令保留原资源、后页失败无 POST、server 或 origin 独立变化、缓存 404/不符、500/无效响应、循环或持续推进 cursor、单次/总期限、字节超限、取消及写响应丢失 |
| 真实服务 | 隔离 PostgreSQL 与 Go server 的 project/task 全流程、依赖拒绝、版本并发冲突、图快照和图超限；ready 的前 N 项及依赖完成后的候选变化 |
| 安装后跨平台 | Linux、macOS、Windows 的已构建 CLI 调用真实 Git、文件锁、rename、退出码、stdout/stderr 和信号清理 |

断言本地准备失败时服务器未收到 mutation，显式 project 从未读取本地关联，project
命令不读写绑定及 ignore，有效缓存后增加重复 project 仍使用原绑定，以及完整页
失败时 stdout 为空。有界 ready 验证单次请求、合法 cursor 不续页、顺序保留、
超量/非 ready/重复 ID 拒绝、空结果及完整 int64 JSON。List 验证完整翻页后的默认
状态选择、`--all`/`--status` 互斥及 `--ready` 交集、跨页稳定分组、精简文本，
并验证所有筛选形式的 JSON 仅省略 `description`，其余字段逐字段保留。ready、详情
及写入结果继续使用包含描述的完整资源输出。
真实服务验收保留服务 request ID 与目标 ID，便于将错误对应到 API 及数据库事实。

预算验证使用可控制时钟和流式响应，覆盖每页均在单次期限内且 cursor 唯一推进、
最终仍耗尽总期限的服务；分别跨越 128 MiB 单响应及 256 MiB 累计边界，并验证按
解码后字节计数。锁验证使用真实并发进程观察即时竞争失败，覆盖取消发生于获取前
或持有后的清理。不能用缩短线上常量、截断数据或跳过真实 Git/服务语义替代验收。

Project 命令的实际编译入口已在受控 HTTP 条件下验证创建、完整分页、
详情、原始 JSON、参数及服务错误、取消和依赖隔离。共享 runtime 测试覆盖配置读取
取消、信号清理、callback 失败后的空 stdout、渲染后的最终期限检查及多请求累计
预算。Task 的命令、API/仓库组合及完整渲染已通过本地专项和编译入口验证；静态
补全在三种真实 shell 中通过新增 Task 场景。安装验证的分层与隔离由
[安装联调决策](../../.agents/notes/implemented/testing/2026-10-20-installed-project-task-acceptance.md)
拥有；当前期限 mock 和验证成本取舍由
[CI 验证效率决策](../../.agents/notes/implemented/testing/2026-10-21-ci-validation-efficiency.md)拥有。

原生路径将 project/task 安装 suite 加入既有 `pnpm acceptance`，三个
原生平台的必选 suite 使用实际 pack/install 产物、真实 Git 和受控 HTTP 验证配置、自动发现、
缓存、锁、原子替换、错误及各操作的 JSON 字段；既有 review/update 两套 suite 保留。可复用
fixture [`installed-cli.ts`](../../packages/daynight/test/fixtures/installed-cli.ts) 统一
拥有打包、安装、launcher 身份和任务目录；原生 suite 为
[`project-task.acceptance.ts`](../../packages/daynight/test/cli/project-task.acceptance.ts)。根目录
`.tmp/project-task-evidence.json` 记录该路径的来源、场景与清理。

服务路径的 Node 编排入口为
`node packages/daynight/scripts/project-task-acceptance.ts`，由 Go 检查脚本调用；
[`project-task-budgets.ts`](../../packages/daynight/scripts/project-task-budgets.ts)
拥有期限与解码字节预算场景。
它构建并安装 CLI 一次，将安装身份传给 Go command-package 验收，复用既有 fresh
race binary、隔离 PostgreSQL schema、listener、重启和数据库等待屏障。新场景
`installed_cli_project_task_workflow` 通过要求编号 `PT.V1`、`PT.V3`、`PT.V5`、
`PT.V6`、`PT.V7`、`PT.V8`、`PT.V9`、`PT.V10` 与 CLI 验收对应，保留原有服务
场景及所属 package 覆盖率。Go receipt 的 `installedCli` 保存共享 helper 的 schema、
source、包版本、tarball/entry hash、Node 和 launcher 身份；场景记录 CLI 启停
数量、workspace 回收、拒绝 request ID 及并发请求的 200/409 结果。混合未完成和已完成
任务的 fixture 同时验证默认列表与 `--all` 的精确成员和顺序；JSON 数组与完整任务资源
仅相差 `description`，其余字段逐字段相等，保留原始 PR 字符串、完整 int64 版本
及时间戳。可读列表验证身份、状态、ready、依赖和 PR 字段，并确认省略 description、
version 与时间戳；这些完整字段仍由详情输出验证。详情与全部状态文本列表均验证
PR 控制字符可见转义及无原始终端控制字符输出。

附件 `installed_cli_task_attachment_workflow` 复用同一服务安装及进程 fixture，覆盖
原始字节、多页路径列表、拒绝、同根重启及完整 task 不变；清理 gate 同时要求存储
根实际消失。共享安装 fixture 也供完整 Web run 使用，在原生与容器页面上复用一次
安装来操作同组真实数据。机制与证据字段由
[附件跨层验收决策](../../.agents/notes/implemented/testing/2026-10-21-task-attachment-cross-layer-acceptance.md)
拥有，原有 PT 场景和六个预算探针保持完整。

编排层原样执行固定 go-cov 参数及 strict raw coverage 检查，通过后才在 Go 默认
10 分钟计时器之外运行六个公开安装 CLI 场景：持续推进 cursor 的总期限、
响应开始后停顿的单次期限，以及两组 gzip 解码字节边界配对。两个期限场景使用
测试侧 Node.js `registerHooks` preload，只包装安装产物的 `api/operation.js` 导出，
复用原有 `createOperation` 实现并注入 3 秒总期限和 1 秒单次期限。preload 先断言
安装产物的生产默认值仍为 300,000/30,000 ms 和 128/256 MiB；测试不改写安装文件、
生产源码、环境配置或 CLI 参数。preload 以编码后的 file URL 传给 Node `--import`，
保留 Windows 驱动器字母、空格和 Unicode 路径的模块解析；原生模块错误类型及其
身份保持一致。单响应精确
128 MiB 和分页累计精确 256 MiB 均必须成功，各增加 1 字节必须拒绝。合法 JSON
以空白补齐字节数；单响应成功结果为一个小型 project，累计成功结果为三个唯一
project，各页均满足列表协议，失败 stdout 必须为空。
累计场景的三页分别为 96、96、64 MiB，超限场景只在最后一页增加 1 字节，
每页均低于单响应上限。两种期限场景并行运行，四个字节边界场景依次执行；
四个字节场景使用完整生产默认值，不加载期限 mock；两个期限场景仍验证实际等待、
正确错误分类、持续分页、空 stdout 和清理。已有 20 分钟 Go 作业保留其全部 gate。
根目录 `.tmp/project-task-service-evidence.json` 记录共享安装身份、Go 命令/覆盖率
结果、解码与传输字节、探针结果和进程/socket/目录清理。每个预算场景的
`deadlines` 记录实际 `totalMs`、`requestMs` 与 `mocked`，避免将短期限行为证据
误解为实际等待了生产期限。本地 `c19b064` dirty receipt 与
[PR #55](https://github.com/codetreker/daynight/pull/55) 的干净托管 receipt 保留真实
30 秒/5 分钟预算的历史证据；它们不代表当前源码的运行结果。逐次结果随对应 PR 与 CI 保存；
[仓库验证说明](../../README.md#validation)拥有 receipt 解释。

源码、包元数据或构建输入交付时按既有版本策略提升 CLI 包版本，运行
`pnpm typecheck`、`pnpm test`、`pnpm build` 及相关安装验收。文档变更校验链接、
归属、状态说明和 diff；这些静态检查不构成运行时验收证据。
