# Daynight 客户端需求

状态：客户端入口、review、自更新、shell 补全、project 命令及配置、HTTP、仓库关联基础已实现；
task 命令、安装产物、真实服务及默认预算验收已完成并通过托管验证；
worker 已提供独立前台入口，完整行为和后续管理/平台验收由其专属需求拥有；
集成状态见[PR #55](https://github.com/codetreker/daynight/pull/55)。
可用命令和验证入口见[仓库 README](../../README.md)，完整交付范围见
[project/task 需求](daynight-project-task.md)。

Daynight 是一个组合命令的客户端工具包。npm 包提供统一的 `daynight` 入口及短命令 `dn`，命令模块
拥有各自的业务行为、依赖和生命周期。`review` 是 GitHub PR 审查模块，`worker` 是按自有 claim 对账的前台任务执行模块；`update` 管理
整个客户端的 npm 全局安装；`login/logout` 管理 CLI 凭据；review 自行拥有仓库配置和首次引导；`completion` 生成 Bash 和 zsh
的原生补全脚本并安装启动配置；`skill` 安装随包分发的公开 `using-daynight` skill。独立的 Go 服务和浏览器应用保留自己的产品需求
与生命周期。

本文档负责客户端入口、命令组合、按需配置引导、自更新和 shell 补全的必需行为；
[review 需求](daynight-review.md)负责审查、review 配置字段和持久化状态；
[worker 需求](daynight-worker.md)负责前台领取、资源、恢复和清理。
[project/task 需求](daynight-project-task.md)负责已确认的 server 连接配置、仓库关联
发现和远端项目任务命令。客户端机制见[架构设计](../design/daynight.md)，补全机制见
[补全设计](../design/daynight-completion.md)。公开 skill 的分发、交互安装和任务工作流
由[Agent skill 需求](daynight-agent-skill.md)拥有；各业务文档明确实际交付状态。

## 需求

### C1. 包与平台

npm 包名为 `@codetreker/daynight`，可执行命令为 `daynight` 和 `dn`，TypeScript 应用代码放在
`packages/daynight/`。两个名称均由包的 `bin` 声明指向 `dist/main.js`，安装后可直接使用，无需手动设置 shell alias。
它们共享全部命令、参数、配置、副作用、输出和退出码；帮助及诊断使用规范名称 `daynight`。Linux、macOS 和 Windows
必须支持同一组命令和对应的业务保证；平台相关的命令执行、输出处理和退出行为必须
经过原生验证。发布包的 Node.js 要求为 `>=22`，不限制主版本上限；运行时依赖必须
允许 Node.js 22 的当前 LTS patch，使严格 engine 校验下的安装和运行均可用。Node.js 22.14
之前的旧小版本不具备 SQLite 二进制需要的 Node-API 10；安装指引建议使用当前 patch。源码开发和发布工具链的要求由
[开发指南](../development.md#cli-development)维护。shell 补全的运行环境由 C5 单独约束。

### C2. 命令组合与退出结果

客户端当前提供以下命令：

```text
daynight
daynight --help
daynight -h
daynight --version
daynight -v
daynight update
daynight login [--no-browser]
daynight logout
daynight worker
daynight worker setup
daynight worker run
daynight worker attach
daynight review
daynight review run
daynight review list
daynight review ls
daynight review add-repo <remote> [--path <path>]
daynight completion
daynight completion bash
daynight completion zsh
daynight completion setup [--shell bash|zsh] [--rc-file <path>]
daynight skill
daynight skill install
daynight project
daynight project create <name> [--repo <repo>]
daynight project list [--json]
daynight project show <project-id> [--json]
daynight task
daynight task create --title <title> [options]
daynight task list [--all | --status <status>] [--ready] [--allow-agents true|false] [--json] [--project <project-id>]
daynight task ready [--limit <N>] [--allow-agents true|false] [--json] [--project <project-id>]
daynight task show <task-id> [--json] [--project <project-id>]
daynight task update <task-id> [options]
daynight task graph <task-id> [--depends-only] [--json] [--project <project-id>]
daynight task attachment
daynight task attachment put <task-id> <file> [--path <relative-path>] [--project <project-id>]
daynight task attachment list <task-id> [--tree | --json] [--project <project-id>]
daynight task attachment read <task-id> <relative-path> [--project <project-id>]
daynight task attachment remove <task-id> <relative-path> [--project <project-id>]
```

无参数、`--help` 或 `-h` 显示顶层帮助并成功退出；帮助列出 `worker`、`review`、`update`、`login`、`logout`、
`completion`、`skill`、`project` 和 `task`。`--version` 与 `-v` 输出当前包版本。裸 `worker`、裸 `review` 和裸 `completion`
显示各自帮助；裸 `skill`、`project` 与 `task` 同样显示组帮助。组和操作在该层唯一参数为 `--help` 或 `-h` 时显示帮助，且不得执行
该操作。顶层版本选项不继承到子命令。`review ls` 是 `review list` 的别名。

`review add-repo` 的 `--path <path>` 可以位于 remote 前后，只能指定一次；不接受
`--path=value` 或 `--` 语法。未知命令、未知选项、多余参数或不完整参数必须输出
具体错误及对应帮助命令，以状态码 2 退出；操作失败以状态码 1 退出并保留具体原因。

服务命令的 text 选项接受分离值及 `--option=value`；内联形式按第一个 `=` 分隔，
保留后续 `=` 及值的前导连字符。分离形式拒绝前导 `-`；仅声明 `allowEmpty` 的
描述选项允许空字符串。标量选项不能重复，声明 repeatable 的依赖选项按输入顺序
保留全部值及重复 ID。状态候选和允许值均由同一命令定义拥有。开关、帮助和目录
选项不接受内联赋值。附件 `put` 的 `--path` 是 text 选项，接受 `--path=value`；
review 的目录 `--path` 保留原有拒绝规则。`project create` 接受一个必填位置参数
`<name>` 及可选 `--repo`；`--repo` 可在名称前后。省略时读取当前 Git worktree 的
有效 `origin`，显式提供时使用给定地址。该操作及附件的 `put/read/remove` 接受
独立 `--` 结束选项解析。前导 `-` 的名称可写成 `project create -- -name`，也可
在终止符前指定 `--repo`；附件终止符用于保留前导连字符的本地或目标位置路径。
旧的 `--daemon-review` 和顶层 `add-repo` 是无效参数，不能隐式重定向。

### C3. 命令依赖与持久化边界

顶层分发只依赖版本、包安装目录、输入输出、通用环境查询函数和轻量命令描述。
各命令可以提供不导入业务实现的定义模块，供参数校验、帮助和两种补全生成器共享
名称、别名、选项和值类型等语法事实；这些定义不能导入配置、文件系统探测、数据库、
外部适配器或运行时。只在选中的命令需要执行时加载该命令；命令内部只加载当前操作
所需的依赖。

根帮助、版本、任何命令帮助和补全脚本生成不解析用户主目录、不创建配置或状态、
不加载 SQLite，也不启动 Git、GitHub CLI、Copilot 或更新操作。补全生成还不得查询
工作目录、获取实例锁、读取审查状态或执行 npm 和网络请求。生成的脚本在按 Tab 时
遵守 C5 的本地执行要求。

`worker setup` 在参数分派后加载配置和有界只读环境检查，选择 agent 与既有 Project 后确认原子保存；它不启动 worker、Herdr 或 native agent，不创建 SQLite、clone 或 claim。`worker run` 加载前台配置、SQLite、Git、Herdr 与协调循环，读取固定状态根及启动时配置，不触发 review 配置引导。`worker attach` 只加载私有 Herdr 客户端入口，在交互式终端连接已有会话，不读取凭据、SQLite、worker 锁或调用服务端。独立有界请求、客户端连接与常驻命令生命周期分开，worker 取消先进入原任务收尾；详细行为由[worker 需求](daynight-worker.md)拥有。

`review add-repo` 与 review 首次引导只写配置。按 C6 完成必要的配置引导后，
`review list` 与 `review ls` 只读取配置及已存数据库，
`review run` 独立持有审查运行时和信号生命周期，具体保证由 review 需求定义。
`project list/show` 和显式 `--repo` 的创建只加载 server 配置和 HTTP 能力；省略
`--repo` 的创建才加载 Git 发现当前 worktree 的有效 `origin`。所有 project 操作
均不读取或改写仓库本地关联、不写 ignore 规则。创建在完整分页比较仓库身份后，
仅无匹配时提交；唯一匹配成功返回既有 project，多匹配及查询失败均拒绝创建。
共享执行层在单个操作下处理信号、期限和结果输出；元数据完整读取后输出，附件
原始内容通过支持背压的字节通道逐段输出，失败可能留下不完整内容。
`task ready` 默认选择前
10 个 ready task，`--limit <N>` 接受十进制整数 `1..100`；它只请求一页，不遍历
后续 cursor。`task list` 读取全部匹配页，默认排除 `done`，通过互斥的 `--all` 或
`--status` 调整所选状态；`--ready` 与所选状态取交集。列表按 `in_progress`、ready、
其余 `todo`、`done` 稳定分组。文本列表省略描述、版本和时间；所有筛选形式的 JSON
列表仅省略 `description`，保留其余 API 字段、原始 PR 字符串、精确版本和时间戳。
详情、ready、创建和更新结果仍保留完整 task 资源。
`ready` 的参数、服务排序及响应校验
由[project/task 需求](daynight-project-task.md#pt7-task-命令与更新语义)拥有。`task` 显式指定 project
时只需要 server 配置和 HTTP；自动选择时才加载 Git 与仓库关联模块。任务写入必须晚于本地
关联准备成功，完整行为由[project/task 需求](daynight-project-task.md)定义。
客户端的命令和源码结构调整不改变 review 配置与状态的现有格式和位置，不迁移、
重分区或重新初始化这些数据。新增命令通过自己的模块接入；它的业务依赖不能成为
其他命令的启动前提。[project/task 需求](daynight-project-task.md)规定服务 API
命令；其独立配置校验、仓库本地关联和远端操作继续遵守这些加载与数据归属要求。
附件 `put/list/read/remove` 的文件语义由[附件需求](daynight-task-attachments.md#cli)
拥有。帮助和普通元数据命令不得为二进制输出启动辅助进程；首次实际写入非空文件
内容时才加载所需输出能力，该进程在命令结束前必须退出并被回收。

### C4. 自更新

`daynight update` 查询当前 npm 配置的 registry 中 `@codetreker/daynight` 的 `latest`
版本，并在该版本的 SemVer 优先级高于当前版本时更新正在执行的 npm 全局安装。
安装使用已查询到的确切版本；查询后的 `latest` 变化不能改变本次目标。已安装版本与
`latest` 相同或优先级更高时保留已安装包，不执行 npm 安装，也不降级；仍需执行
已安装 skill 的同步，全部成功后退出。

命令必须确认当前包的真实路径符合 npm 全局目录结构，且该安装的 `daynight` 启动器
确实指向当前包。使用该安装的实际 prefix 进行查询与安装，不能因当前 npm 默认 prefix
变化而更新另一份副本。用户和该 prefix 的全局 npm registry、认证配置继续生效；
调用目录的项目 `.npmrc` 不参与全局更新。源码、本地依赖、`npx`、pnpm 及 `npm link`
安装必须拒绝自更新并给出使用原包管理器的指引，不能另外创建一份全局安装来宣告成功。

查询和安装通过当前 Node.js 运行 npm 的 JavaScript 入口。安装实时转发输出，强制校验
目标包的 Node.js engine，不能自动提升权限。需要安装且调用目录位于被替换包内部时，
必须明确要求从安装目录之外重试；仅查询得到当前或领先版本时允许在包内成功返回。
安装后必须重新读取包身份和版本、验证启动器，并通过该安装的绝对 CLI 路径在新进程中
检查 `--version`，全部匹配目标版本后才能报告更新成功。npm 负责文件替换和安装恢复；
命令不承诺原子回滚，失败也不保证原安装的全部字节保持不变。

npm 更新及版本验证成功后，命令使用已安装包中的新进程同步 `using-daynight`。
CLI 已是当前或领先版本时，同样从保留的已安装包同步。检测范围为 User 与调用目录
所属 Git worktree 的 Project skill 位置；仓库外只检测 User，不扫描其他项目，也不以
Agent launcher 是否在 PATH 判断已有安装。同步遵循
[skill 自动更新要求](daynight-agent-skill.md#as10-cli-更新时同步已安装-skill)。

`daynight update --help` 和 `daynight update -h` 显示帮助且不执行更新；其他参数以
状态码 2 拒绝。查询、权限、网络、engine、安装、验证或 skill 同步失败以状态码 1
退出并保留错误原因。skill 失败须区分 npm 包已更新或被保留及各 skill 目标的结果；
不能宣称整体成功，也不回滚已安装包。命令无需配置文件，不加载 review 配置或运行时、
不打开 SQLite、不获取实例锁、不修改审查会话，也不启动 GitHub CLI 或 Agent。
只有发现当前目录的 Git worktree 标记时才调用 Git 定位根目录；读取失败明确报错。

更新成功后，下一次 CLI 调用使用新版本；正在运行的 reviewer 必须由操作者重启。
命令不自动停止或重启它。Windows 上运行中的 reviewer 可能占用原生 addon 文件，导致
npm 替换失败；该失败必须明确报告。

### C5. Bash 与 zsh 补全

`daynight completion bash` 为 Bash ≥4.2 生成原生补全脚本，`daynight completion zsh`
为已初始化 `compinit` 的 zsh 生成原生补全脚本。成功时 stdout 只能包含可加载的完整
脚本；未知 shell、多余参数和未知选项按 C2 拒绝。脚本必须显式注册 `daynight` 和 `dn` 的
补全。zsh 缺少初始化时给出明确诊断并加载失败；Bash 低于版本下限时同样明确拒绝。
生成操作不修改 shell 启动文件。当前会话通过 `source <(daynight completion bash)`
或在 `compinit` 之后执行 `source <(daynight completion zsh)` 启用。持久安装由 C7
定义。包更新后，新 shell 使用当前安装的定义；已有 shell 重新加载脚本后刷新。
保存的脚本文件需要重新生成。

补全覆盖命令、子命令、别名、当前层的选项、`completion` 的 shell 参数和
`review add-repo --path` 的目录候选；zsh 同时展示候选说明。非重复选项使用后不再
提供，已消耗的位置参数不重复提供候选，remote 不提供远端候选或无关文件候选。
目录建议不约束运行时合法值，操作者仍能输入尚未创建的目标目录。状态的静态
列表状态候选为 `todo`、`in_progress`、`done`，分离及内联形式使用同一候选；
update 不声明 status，set-status 使用 task ID、三状态目标和可选精确版本。重复依赖选项
使用后仍可继续补全；自由文本、project/task ID 和依赖 ID 不回落文件候选。空描述
和已完成内联值之后，后续选项按共享语法继续补全。

按 Tab 只执行 shell 本地补全和目录枚举，不启动 Node 或其他 daynight 进程，不读取
review 配置或数据库，不访问网络。候选和输入必须作为数据处理，不作为 shell 代码
执行。补全必须保留空格、中文、引号及特殊字符目录，处理远程地址的冒号和光标位于
行中的情况，且不改变用户全局的分词配置或 completion style。当前脚本按 source
加载；不承诺将同一输出直接用于 zsh `fpath` 自动加载。

### C6. 按需配置引导

服务命令在缺少配置文件或 `serverUrl` 时使用 `https://daynight.cc`，无需创建地址配置。
显式 `serverUrl` 只用于覆盖测试服务，仍须严格校验；非法值和读取错误不得替换成默认值。
`project/task` 业务调用需要本地凭据，缺少时在网络派发前报错并提示 `daynight login`；
服务返回 401 时同样提示登录。两种情形均不启动自动登录或重放业务写请求。

`daynight login [--no-browser]` 主动发起设备授权，显示验证 URL 和短码；默认尝试打开浏览器，
无法打开时保留可手工使用的 URL 和短码。`--no-browser` 仅显示这些信息。浏览器核对账号和短码后明确
批准或拒绝，网页登录本身不批准。CLI 按服务轮询间隔等待，处理 pending、slow_down、拒绝、过期、取消及
传输失败，最长十分钟；该期限独立于业务命令。批准后自动保存默认永不过期的可撤销凭据，用户无需
手工创建 PAT；名称为 `Daynight CLI (<hostname>)`，hostname 来自发起命令的机器，
在其他设备批准时也保持该来源。可在网页令牌管理器修改其到期时间，修改保持原凭据有效，不要求重新登录。
`daynight logout` 撤销当前 CLI 凭据；确认成功或凭据已失效后清除本地值。网络或不确定结果必须可见。
登录/退出的配置写入在锁内重查 origin 与凭据，不能覆盖期间完成的另一次登录或服务切换。
完整身份、安全和失败语义由[鉴权需求](daynight-auth.md)拥有。

`review run`、`review list` 和 `review ls` 只要求 review 配置。配置文件、`review` 或 `review.repositories`
字段缺失且 stdin/stderr 均为 TTY 时，询问一个 GitHub 远程地址及可选本地路径，复用仓库登记规则。
共享 YAML 语法、重复键及节点结构错误、当前能力已知字段的非法值、空仓库列表和读取失败保留原错误；
根节点、review、worker 及其仓库条目的未知字段在运行时忽略，CLI 配置编辑保留原字段。
其他能力的业务字段由各自投影校验。配置完整时不询问，非交互缺少 review 配置时以状态码 1 失败并给出
`daynight review add-repo <remote> [--path <path>]` 指引。显式添加与交互引导使用相同远程身份和路径规则。

顶层不提供 `daynight setup`，不保留旧入口兼容别名；`daynight completion setup` 继续负责 shell 启动配置。
测试服务和自动化可直接准备现有配置文件的 `serverUrl` 与 `serverToken` 字段，不新增通用配置命令。
配置准备者必须将目标 origin 与对应凭据共同管理，切换目标时移除或替换旧令牌，并保留其他能力的设置。
外部文件写入不执行 CLI 的凭据清理或锁协议；POSIX 凭据文件应限制为 `0600`。服务字段仍严格校验，
令牌仅允许 HTTPS 或 host 为字面量 `localhost`、`127.0.0.0/8` 数值 IPv4、`::1` 的 HTTP。

提示、保存结果和取消诊断写 stderr，业务结果保留 stdout 格式。review 引导先收集全部输入，再持配置锁
重读、合并、校验并原子保存，保留注释、其他字段、既有仓库路径和无关字段的已完成并发修改。
所选 review 字段变化时明确报冲突。登录与退出在锁内共同核对 origin 与令牌观察值。配置锁已占用时
明确失败。CLI 写入拒绝符号链接和非普通文件；含令牌结果在 POSIX 上使用 `0600`，其他能力写入同样遵守，
无令牌文件沿用既有权限。所有 CLI 配置写入，包括首次生成 workerId，都必须保留非本次操作所拥有字段的解码值；
共享 YAML alias 会连带改变无关字段时拒绝保存并保留原文件，未受影响的合法 alias 继续保留。

EOF、Ctrl+C、SIGTERM 或 Windows SIGBREAK 取消输入，不保存部分值也不进入原业务。
review 配置引导不访问网络、不认证、不 clone、不初始化 SQLite 或审查运行时。YAML 诊断只保留
安全类别、代码和位置，不泄露标量或原始 parser cause；其他有效错误链继续保留。
review 自动引导保存后以原参数执行原命令一次，后续失败保留配置。人工输入不消耗业务期限；
帮助、版本、补全、自更新及无效参数不触发引导。

### C7. 补全启动配置安装

`daynight completion setup` 必须检查调用者的 Bash 或 zsh 启动配置，缺少加载配置时
自动安装。默认依据实际进程关系尽力识别正在调用的 shell，不能把 `SHELL` 的登录
偏好当作当前 shell。无法可靠识别时明确失败并提示 `--shell bash|zsh`；显式 shell
选择优先于自动识别。`--rc-file <path>` 指定自定义启动文件，只检查和修改该文件。
帮助及无效参数必须在启动文件 I/O 前处理；无效 shell、重复或缺失选项值按 C2
退出 2；无法识别调用者时同样给出显式选择的用法错误，进程查询或文件操作失败
退出 1 并保留具体原因。

默认 Bash 安装必须覆盖交互式非登录 shell 的 `.bashrc`，以及登录 shell 按
`.bash_profile`、`.bash_login`、`.profile` 优先级实际选择的首个可读已有文件；只有
三者均不存在时创建 `.bash_profile`。已有文件全部不可读时明确失败，不能通过创建
更高优先级文件屏蔽已有配置。
登录加载块只在交互式 Bash 中执行，语法必须允许 `.profile` 被其他 POSIX shell
读取。安装不得为启用补全而执行 `.bashrc` 的其他配置。

默认 zsh 安装使用导出的 `ZDOTDIR` 下的 `.zshrc`，`ZDOTDIR` 未设置时使用主目录；
导出空值时目标为 `/.zshrc`，相对值按 setup 当前工作目录解析，不能将空值
当作当前目录或未设置处理。之后 zsh 从其他目录启动时，其相对目录也随启动目录
改变。未导出的自定义目录通过 `--rc-file` 指定。
加载块复用已初始化的补全系统，缺少时运行保留正常安全检查的 `compinit`；不能
跳过不安全目录检查或自动接受其风险。

安装必须识别已有管理块及文档中的标准独立加载语句，避免重复添加。管理块在每次
启动时检查该 shell 中 `daynight` 和 `dn` 的实际补全注册及对应函数；任一入口
注册缺失、指向错误函数或函数不可调用时，重新加载共享脚本并恢复两个入口。
登录与非登录启动文件相互加载时，管理块不得对完整有效的注册重复生成。保留的
手写加载语句保持其原有执行语义，无条件语句在管理块之后执行时仍会再次加载。已经安装的文件再次执行
`completion setup` 时字节保持不变。既有内容的字节、换行、权限和符号链接身份
必须保留；新管理块使用 shell 可解析的 LF 换行，无末尾换行时先追加 LF 分隔。
管理块不完整或重复、目标不是普通文件、权限不足等情况必须明确失败；不能输出
安装成功来掩盖错误。安装器不自动迁移早期模板的管理块；旧块内容与当前模板
不一致时明确拒绝，操作者删除其标记区段后重新安装，或直接 source 当前生成脚本。

成功输出必须区分启动配置已安装与已存在，并明确当前会话的启用方式。
`completion setup` 只安装持久配置，不执行用户启动文件，不宣称已读取或修改父
shell 的内存状态；输出对应的既有 `source <(daynight completion bash|zsh)` 命令供当前会话启用。启动文件中的任意提前
返回、条件分支或后续清理可能阻止加载，安装检查不承诺证明这些自定义逻辑的效果。
管理块在新 shell 启动时调用当前安装版本的脚本生成入口；生成、加载或初始化失败
必须以非零状态暴露，不注册声称可用的补全。C5 的 Tab 本地执行保证继续成立。
安装不读取 review 配置、数据库或远端服务。

## 验收场景

| 场景 | 必需结果 | 对应需求 |
|---|---|---|
| 安装 npm 包后通过 `daynight` 或 `dn` 调用相同参数，包括帮助、版本及自更新。 | 两个启动器使用同一入口，输出、配置与退出行为一致；更新后两者指向同一新版本。 | C1, C2, C4 |
| 无配置、SQLite 不可加载且 PATH 缺少 review 工具时调用根帮助或版本。 | 输出帮助或当前包版本，退出 0，未解析用户主目录或触及 review 数据。 | C1, C2, C3 |
| 调用裸 `review`、裸 `completion`、组帮助或任何操作帮助。 | 显示对应帮助，退出 0，未进入业务操作或加载审查运行时。 | C2, C3 |
| 调用未知根命令、旧入口、不完整参数或未知操作选项。 | 输出错误及对应帮助命令，退出 2；未执行配置、审查或更新。 | C2, C3 |
| 在 remote 前后使用一次 `--path`，或重复、合并赋值、混用帮助及其他参数。 | 合法顺序保持等价；重复 `--path`、`--path=value`、`--` 和非唯一帮助参数退出 2。 | C2 |
| 首次在 TTY 执行有效 review 操作，或未登录时执行 project/task。 | review 仅询问缺失仓库配置，保存后以原参数执行一次；project/task 提示显式登录，JSON stdout 不含提示。 | C6 |
| 仅准备服务凭据，或只配置 review 仓库。 | 各能力独立校验；缺少服务凭据时提示登录，缺少 review 仓库时按需引导，保存保留已有字段和注释。 | C3, C6 |
| 通过 `review add-repo` 或首次交互引导配置仓库，或外部准备测试服务与自动化配置。 | review 复用登记规则与原子保存；外部配置保持 origin/凭据配对，不承诺 CLI 锁或自动凭据清理。顶层 setup 不存在。 | C6 |
| 非 TTY 缺配置、已有配置损坏、读取失败，或在引导期间取消及 EOF。 | 缺 review 配置给出 `review add-repo` 命令；损坏及读取错误保留原因；取消不保存部分值且不执行业务。 | C6 |
| 引导期间另一配置命令已写入，或配置锁被占用。 | 保存前重读并保留无关字段修改；所选字段已变更或占锁时明确失败且不执行业务。 | C6 |
| 执行 review 的配置、列表和运行操作。 | 按操作加载其依赖，复用原有 YAML 和 SQLite；审查保证见 review 的 R1–R15。 | C3 |
| 执行 `daynight update`，registry 的 `latest` 比当前版本更新。 | 更新当前 npm 全局安装至已查询的确切版本，验证清单、启动器和新进程版本，再同步 User 与当前 worktree 已安装的 skill；全部成功才报告成功，保留配置及审查状态。 | C4 |
| npm 默认全局 prefix 已变化，或调用目录包含项目 `.npmrc`。 | 仍使用当前安装的实际 prefix，保留用户/全局 registry 与认证配置，不更新其他 prefix，也不使用调用目录的项目配置。 | C4 |
| 当前版本等于或高于 `latest`，或从安装目录内部执行命令。 | 当前或领先版本不安装、不降级；需要安装且调用目录在包内时明确拒绝。 | C4 |
| 从源码、本地依赖、`npx`、pnpm 或 `npm link` 安装调用更新。 | 拒绝并给出原包管理器指引，不创建另一份全局安装。 | C4 |
| 无配置文件时执行更新帮助，或更新遇到无效参数、网络、权限、engine 或安装后验证失败。 | 帮助不更新；无效参数退出 2；操作失败退出 1 并保留原因；不触及配置、SQLite、实例锁、会话和 review 工具。 | C4 |
| 已有 reviewer 运行时更新成功，或 Windows 原生文件被占用导致安装失败。 | 成功后提示手动重启 reviewer；占用导致的 npm 错误明确失败，不宣告已经更新。 | C4 |
| 隔离 review 配置、SQLite 和外部工具后生成两种脚本，或请求未知 shell、多余参数。 | 有效请求只输出脚本，未查询用户目录/工作目录或触及业务依赖；无效请求退出 2 并指向补全帮助。 | C2, C3, C5 |
| 在真实 Bash 4.2、现代 Bash 和 zsh 中加载脚本并按 Tab。 | 命令、别名、选项和 shell 候选符合共享语法；zsh 展示说明；无需 Node、review 数据或网络。 | C3, C5 |
| 补全带空格、中文、引号、美元符号的目录，remote 带冒号，或光标位于行中。 | 插入文本、引号、目录后缀与下一参数位置正确；输入不被执行，后方参数不改变当前位置。 | C5 |
| 已使用 `--path`、已填 remote、目标目录不存在，或本地目录与命令同名。 | 选项和参数不重复；remote 不回落文件候选；不存在目录仍可手动输入；同名目录不破坏命令插入及分隔符。 | C2, C5 |
| 未初始化 zsh 补全系统或使用 Bash 3.2 加载脚本。 | 加载失败并显示对应前提，不宣告补全已经可用。 | C5 |
| 自动识别 Bash/zsh，或显式指定 shell、自定义启动文件。 | 选择实际 shell 对应的文件；识别不可靠时提示显式选择；自定义路径只管理指定文件。 | C7 |
| Bash 有不同优先级的登录文件，或安装到被其他 POSIX shell 读取的 `.profile`。 | 保留既有登录文件选择，只在交互式 Bash 中启用；非 Bash 读取不产生语法错误。 | C7 |
| zsh 使用主目录、导出绝对、相对或空 `ZDOTDIR`，或已初始化补全系统。 | 未设置使用主目录，相对值按 setup 工作目录解析，空值指向 `/.zshrc`；缺少初始化时保留安全审查，已有初始化被复用。 | C7 |
| 首次 setup 后重复安装，或含管理块的启动文件相互加载。 | 首次缺少时安装；再次安装文件字节不变；管理块对已有注册不重复加载，真实 shell 能按 Tab；保留的无条件手写语句继续按原顺序执行。 | C5, C7 |
| 已有标准手写加载语句、符号链接、CRLF 或没有末尾换行的启动文件。 | 复用标准配置，保留既有内容的字节、换行、权限和链接身份；新块使用 LF，真实 shell 可加载管理块并按 Tab。 | C7 |
| 管理块损坏、目标不是普通文件、权限不足，或用户启动逻辑提前返回。 | 文件错误明确失败；安装不执行用户配置，不将配置存在等同于当前 shell 已加载。 | C7 |
