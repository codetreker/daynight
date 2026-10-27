# Daynight 客户端架构设计

状态：`packages/daynight/` 是通过 `@codetreker/daynight` 分发的 TypeScript 客户端
命令工具包，支持 Linux、macOS 和 Windows。`review` 提供 GitHub PR 审查，`worker` 提供前台任务认领与资源对账，`update`
管理当前 npm 全局安装，`login/logout` 管理 CLI 凭据，review 拥有仓库配置和首次引导，`completion` 生成 Bash 和 zsh
的原生补全脚本并安装启动配置；`skill` 提供公开 `using-daynight` skill 的交互安装。project/task
CLI 的共享配置、HTTP、仓库关联基础及 project/task 命令已完成，安装产物、真实服务
与默认预算验收已通过托管验证；集成状态见[PR #55](https://github.com/codetreker/daynight/pull/55)。
[专属设计](daynight-project-task.md)拥有项目任务机制，[worker 设计](daynight-worker.md)拥有持续执行机制。行为归属见[客户端需求](../spec/daynight.md)及
[review 需求](../spec/daynight-review.md)，结构选择见
[命令组合决策](../../.agents/notes/archived/architecture/2026-10-20-client-command-composition.md)。
[补全设计](daynight-completion.md)拥有共享语法描述、脚本生成和 shell 加载机制，
[Agent skill 设计](daynight-agent-skill.md)拥有公开资源、交互安装、scope 与覆盖机制。

## 命令与职责

```text
daynight                            # 顶层帮助
daynight --help                      # 同 -h
daynight --version                   # 同 -v
daynight update
daynight login [--no-browser]         # 浏览器设备授权
daynight logout                      # 撤销并清除当前 CLI 凭据
daynight worker                     # worker 帮助
daynight worker setup               # 环境检查、agent 与 Project 选择
daynight worker run
daynight worker attach
daynight review                     # review 帮助
daynight review run
daynight review list                 # 同 review ls
daynight review add-repo <remote> [--path <path>]
daynight completion                 # 补全帮助
daynight completion bash
daynight completion zsh
daynight completion setup [--shell bash|zsh] [--rc-file <path>]
daynight skill                       # skill 帮助
daynight skill install               # 多选 Agent，再选择 User 或 Project scope
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
daynight task graph [--json] [--project <project-id>]
daynight task attachment
daynight task attachment put <task-id> <file> [--path <relative-path>] [--project <project-id>]
daynight task attachment list <task-id> [--tree | --json] [--project <project-id>]
daynight task attachment read <task-id> <relative-path> [--project <project-id>]
daynight task attachment remove <task-id> <relative-path> [--project <project-id>]
```

各组和操作在该层唯一参数为 `--help` 或 `-h` 时显示帮助。顶层无参数显示帮助，
未知命令与无效参数退出 2，业务执行失败退出 1 并保留原因。旧的 `--daemon-review` 和顶层 `add-repo` 不再是
有效命令。review 操作沿用[review 设计](daynight-review.md)的配置、持久化和运行保证。

以上命令和后文源码树描述当前实现。project/task 的业务机制与完整联调要求由
[专属设计](daynight-project-task.md)拥有。

客户端外壳处理顶层帮助、版本、命令选择及通用退出结果。每个命令模块负责自己的
定义、参数、帮助、依赖和执行生命周期。`review` 再按配置登记、本地列表、前台运行分派，
避免查询或配置操作初始化审查运行时。`update` 属于包安装生命周期，不属于 review。
`skill` 拥有已安装 Agent 检测、终端选择、scope 规划和 bundle 覆盖，独立于服务及
review 配置。独立 Go 服务与浏览器应用保持各自的数据和生命周期。已确认的 project/task 设计
通过独立客户端模块使用现有 HTTP API，业务数据仍由 Go 服务持有；HTTP 客户端、仓库上下文和 project 入口已实现，
task 入口已实现。

## 源码组织

```text
src/
  main.ts
  cli/
    application.ts
    commands.ts
    context.ts
    byte-output.ts
    byte-output-helper.ts
    prompts.ts
    cancellation.ts
    schema.ts
  config/
    paths.ts
    document.ts
    files.ts
    errors.ts
    server.ts
  api/
    index.ts
    types.ts
    operation.ts
    json.ts
    parse.ts
    client.ts
  repository/
    index.ts
    identity.ts
    git.ts
    binding.ts
    context.ts
  commands/
    skill/
      definition.ts
      command.ts
      agents.ts
      targets.ts
      install.ts
      skills/using-daynight/
        SKILL.md
        references/handbook.md
        references/run-task.md
        references/execute-task-in-managed.md
        references/task-execution.md
        references/create-task.md
        references/goal.md
        references/task-content.md
        references/handoff.md
    task/
      definition.ts
      command.ts
      rendering.ts
      attachment.ts
      attachment-rendering.ts
    project/
      definition.ts
      command.ts
      rendering.ts
    server/
      runtime.ts
    worker/
      definition.ts
      index.ts
      config.ts
      runtime.ts
      coordinator.ts
      execution.ts
      cleanup.ts
      remote.ts
      prompts.ts
      diagnostics.ts
      identity.ts
      instance-lock.ts
      paths.ts
      types.ts
      store.ts
      herdr.ts
      herdr/
      worktrees.ts
    review/
      definition.ts
      command.ts
      config.ts
      configuration-guide.ts
      paths.ts
      repositories.ts
      listing.ts
      model.ts
      polling.ts
      coordinator.ts
      runtime.ts
      skill.ts
      skills/
        daynight-review/
          SKILL.md
      store.ts
      instance-lock.ts
      processes.ts
      adapters/
        github.ts
        worktrees.ts
        copilot.ts
    update/
      definition.ts
      command.ts
      updater.ts
    completion/
      definition.ts
      command.ts
      setup.ts
      bash.ts
      zsh.ts
  platform/
    skill-bundle.ts
    diagnostics.ts
    filesystem.ts
    files.ts
    terminal.ts
    text.ts
```

`main.ts` 是稳定的可执行入口，向应用传递包版本和从该入口确定的包目录；编译后仍为
`dist/main.js`。包的 `bin` 将 `daynight` 和短命令 `dn` 同时指向该文件，
两者共用分发、配置和生命周期；帮助及诊断沿用 `daynight`。根命令树的 `aliases`
登记 `dn`，供两种补全生成器使用。`cli/context.ts` 只描述客户端上下文：版本、包目录、输入输出，以及
用户主目录和工作目录的惰性查询函数；不放入已解析的 review 路径、配置或运行函数。
`cli/commands.ts` 组合各命令的轻量定义并保存异步执行入口；`cli/application.ts`
只在选中命令时调用加载函数。`cli/schema.ts` 定义命令、别名、选项和值类型、位置
参数及固定候选；选项元数据表达 required、allowEmpty、choices 和 repeatable，
并由它完成参数校验与帮助渲染。各 `definition.ts` 不导入业务实现、
配置、文件系统探测、原生数据库或适配器；根分发可以读取这些定义而不加载业务。
Bash 和 zsh 生成器消费同一命令树，避免解析、帮助和补全分别维护语法。增加业务
命令需要登记入口和实现自己的模块，顶层分发不认识该命令的业务依赖。

命令组先完成参数和帮助分派，再按操作加载默认实现。裸命令、帮助、版本及无效参数
无需解析用户主目录、打开数据库或调用外部程序。补全生成同样不查询工作目录、
review 状态或网络。`review add-repo` 加载配置保存能力；服务业务读取默认或显式
origin 并要求本地凭据，未登录时提示 `daynight login`。review 业务在缺少仓库配置时完成
引导，随后列表加载配置与只读快照，`review run` 才加载运行时、信号处理、实例锁和适配器。
`login/logout` 的轻量定义与执行实现位于 `commands/auth/`，client 拥有有界协议请求，
credentials 拥有配置观察值核对，browser 拥有平台打开器。命令不进入项目发现或业务执行，
授权提示和登录/退出结果写 stderr，stdout 只用于帮助。
该顺序也使自更新进程不加载待替换的 SQLite 原生 addon。

`worker` 的轻量 definition/index 先完成命令解析与帮助分派，再加载对应业务。setup 与 repo 入口拥有配置路径、读取/保存及 Project 选择；需要远端项目时使用 typed ApiClient，repo list 保持本地只读。setup 复用有界原生前置检查，环境诊断和配置确认不取得执行实例锁、不打开 SQLite 或启动 Herdr/native agent。attach 入口使用已有私有会话的客户端描述，不进入任务控制器。

run 的 runtime 组合固定状态、实例排他、SQLite、Git 与 Herdr 的前台生命周期。人工管理入口保存具体控制意图，需要独立推进时复用既有排他与资源控制。coordinator 拥有轮询/名额/任务串行推进，execution 与 cleanup 分别消费原执行事实；这些生命周期使用 worker 自己的状态所有权。安装包路径由稳定入口传入，managed prompt 指向同一包的绝对技能入口。具体持久化和未知动作处理由[worker 设计](daynight-worker.md)拥有。

`config/` 拥有共享配置路径、严格 YAML 和保留注释的文件保存协议；未知字段在运行投影中
忽略并在文档中保留。`files.ts` 的写入描述必须声明字段归属，锁内保存入口统一比较非归属
解码值，`ownership.ts` 提供同一纯比较规则供保存和预览复用。`server.ts` 提供独立 server 字段投影。`api/` 拥有服务 DTO、精确数值 JSON、
命令级期限和字节预算、HTTP 错误、完整分页及有界 ready 查询，供业务命令组合。共享层不导入
worker、review 或 update；服务器客户端也不依赖 YAML、SQLite 或 Git。`repository/` 将有效 origin、通用
仓库身份、远端 project 校验与本地关联组合；原子文件替换由 `platform/files.ts`
复用，配置保存和仓库元数据各自拥有锁、路径校验及调用顺序。

review 的配置和路径类型明确以 `ReviewConfiguration`、`ReviewPaths` 命名。
`commands/review/model.ts` 持有领域和安全恢复证明类型，store 专注持久化；
`polling.ts` 组合远端只读观测与本地原子状态提交，GitHub 适配器专注远端查询。
[review 模块职责表](daynight-review.md#单进程与普通模块)解释具体职责及执行不变量。
共享的 `platform/` 承载诊断、文件系统和无业务副作用的 bundle 捕获/entrypoint 校验；
这些函数不导入命令模块。review 继续拥有快照、哈希和执行协议。

源码测试按 `test/cli/`、`test/config/`、`test/api/`、`test/commands/review/`、
`test/commands/update/`、`test/commands/completion/`、`test/commands/project/`、
`test/commands/server/`、`test/commands/task/`、`test/repository/` 和 `test/platform/`
镜像职责，构建与版本策略测试位于 `test/tooling/`，共享 fixture 与帮助函数保持明确
归属。使用普通函数和具体类型；外部命令、时钟与故障点只在有实际
验证需求的边界注入，不增加通用插件框架或依赖注入容器。

## Shell 补全

`commands/completion/` 通过共享命令树生成 Bash ≥4.2 和 zsh 的原生脚本；有效生成请求
只向 stdout 写入脚本。裸 `completion` 及其帮助只显示使用说明，错误 shell 或无效
参数沿用状态码 2。脚本生成不读取配置和状态，不加载 review 或更新业务。
`completion setup` 在参数校验后才加载 `setup.ts`，检查调用 shell 并安装持久启动
配置。启动块只在 `daynight` 与 `dn` 均注册预期的可调用补全函数时跳过加载；
任一入口失效都会重新加载共享脚本。安装器独立拥有 shell 检测、默认或显式文件
选择、完整管理块识别及保留原文件身份的写入，不改变生成操作的无 I/O 保证。
review 配置引导由 review 模块拥有；[客户端 C7](../spec/daynight.md#c7-补全启动配置安装)拥有其行为。
普通子进程不能修改父 shell 的函数注册，`completion setup` 输出既有 source 命令
供当前会话启用。

脚本在 source 时为 `daynight` 和 `dn` 注册同一组补全函数，Bash 检查版本下限，zsh 要求调用者已完成
`compinit`，缺少初始化时明确报错并加载失败。按 Tab 时只使用 shell 内存中的语法
和本地目录枚举，不启动 Node、
daynight 或网络请求。参数语法保留原有唯一帮助参数、remote 前后一次 `--path`、
不接受 `--path=value` 或 `--` 的规则。目录候选保留实际参数边界，且不限制尚未
创建的路径输入。生成和加载机制、引号与光标处理由[补全设计](daynight-completion.md)
统一说明，启用命令由[README](../../README.md#shell-completion)拥有。

[补全决策](../../.agents/notes/archived/feature/2026-10-20-shell-completion.md)
记录 Bash 下限、zsh 原生集成和本地执行的成本；
[setup 决策](../../.agents/notes/archived/feature/2026-10-21-completion-setup.md)记录
启动文件安装及当前会话边界。脚本输出用于 source；zsh `fpath`
自动加载需要不同的装载形式，未包含在该输出的使用承诺中。

## Server 命令执行

`project/definition.ts` 声明 create/list/show、创建的必填位置名称、可选 `--repo` 与查询 JSON 标志。
`command.ts` 在帮助和语法校验后才加载共享 server runtime；show 的 UUID 校验
先于配置读取。list/show 及显式 `--repo` 的 create 不查询工作目录或 Git；省略 repo
时 create 复用 Git 发现以取得当前 worktree 的有效 `origin`，不加载关联保存流程。
两种创建路径都先完整列举 project，以共享仓库身份规则比较：零匹配才 POST 原始名称
和地址，唯一匹配返回既有 project，多匹配报告 ID。查询失败、取消和期限错误阻止
后续创建。该预检保持服务允许重复 repo 的边界，不提供并发创建的原子唯一性；
project 操作不读写仓库绑定或 ignore 规则。`rendering.ts` 使用完整项目标签块，
输出大小随字段内容线性增长；JSON 保留 API 字段和值。

`commands/server/runtime.ts` 在首次配置读取前建立操作和信号取消源，配置完整时，
读取、HTTP 和渲染共享期限与字节预算。仅识别出结构化的必要配置缺失时，释放初始
操作的期限，在同一取消信号下完成引导；保存后的重新读取建立新操作及完整业务
预算。回调返回 `string | void`：元数据操作返回完整字符串，在最终检查取消和期限后
一次写 stdout；附件 read 通过 `CliContext.stdoutBytes` 逐段输出并返回 void。
结束时先等待 `closeStdoutBytes` 关闭并回收已创建的输出辅助进程，再移除本次的信号
监听器并释放操作，清理失败保留原因。SIGINT/SIGTERM 以及 Windows SIGBREAK 均
进入这一取消源；配置读取接受同一 AbortSignal。Task 复用此执行层；它不控制 Go
server 的启动或关闭。

Task 的 definition、command 和 rendering 分别拥有共享语法、操作组合和
可读/JSON 输出。`list` 在命令层选择状态并对完整分页结果稳定分组，默认排除
`done`，互斥的 `--all` 与 `--status` 调整所选状态，`--ready` 与之取交集；
文本列表使用精简标签块；JSON 列表在输出层仅省略 `description`，保留其余字段和
精确 int64 版本，API DTO 与 ready、详情、写入结果继续使用完整资源。`ready` 的
`--limit` 在任何配置、Git 或 HTTP 访问前校验为十进制整数 `1..100`，默认 `10`。它调用 `api/client.ts` 的 `listReadyTasks`，仅发送一次带
`ready=true` 和所选 `limit` 的 task GET；合法 `nextCursor` 不触发续页。该 API
操作在返回前验证数量不超限、每项确为 ready 且 task ID 不重复。`list` 仍使用完整
分页。完整的请求、排序和输出机制见
[project/task 设计](daynight-project-task.md#api-映射与更新机制)。

Task 的 `attachment.ts` 单独组合单文件上传、完整分页列表、原始读取和删除。
API 客户端分别消费 JSON、字节流与 204 空响应，字节流不经过 UTF-8/JSON 解析或
元数据字节上限。二进制输出延迟创建本次命令拥有的子进程，以有界 frame 和写入
确认传递背压，使父进程在 stdout 阻塞时仍可响应取消和期限。详细的流、关闭及错误
契约由[附件设计](daynight-task-attachments.md#cli)拥有。

描述通过 `value.allowEmpty` 保留空值；状态通过 `value.choices` 统一参数校验和补全
候选，帮助使用选项说明；重复依赖通过 `repeatable` 从首次出现起形成保留输入顺序及重复值的
数组。text 内联赋值按首个 `=` 分隔并支持前导连字符，目录与开关继续拒绝内联。
参数验证先于配置、Git 及 HTTP；显式 project 直接读取远端详情，自动分支才加载
`repository/`，并在 task 写入前完成关联验证与保存。

`platform/text.ts` 按 Unicode White_Space、有效 Unicode 和无 NUL 校验服务文本，
CLI 参数与 API DTO 共用该规则并保留原值；`platform/terminal.ts` 仅负责可读输出中的
终端控制字符转义。JSON 不经过可读格式化；task list 的描述省略只作用于该操作的
JSON 输出投影。

## 按需配置引导

参数和业务值校验先于配置引导，帮助、版本、补全和自更新保持各自独立入口。
review run/list 在缺少文件、`review` 或 `review.repositories` 字段时使用
`commands/review/configuration-guide.ts` 引导，`config/errors.ts` 区分缺失与非法配置；
`cli/prompts.ts` 拥有终端输入，`cli/cancellation.ts` 共享输入、信号和关闭生命周期。
review 仓库登记复用现有更新函数，不复制保存路径。顶层没有 setup 模块或兼容入口。

server 投影在文件或 `serverUrl` 缺省时返回 `https://daynight.cc`；明确提供的 origin
与可选 `serverToken` 严格校验。业务执行层在缺少本地凭据时直接失败并提示登录，不进入配置引导。
测试服务和自动化通过外部受控配置文件提供这些现有字段；准备者负责配对 origin 和凭据、替换目标时
移除旧令牌、保护文件权限并保留其他设置，外部编辑不执行 CLI 的原子保存或凭据清理协议。
review 只校验自己的字段，不要求服务配置；YAML/schema、当前能力非法值、读取错误和空 review
仓库列表保留错误。新安装的普通服务使用不需要地址初始化，配置损坏也不会被视作首次运行。

review 交互引导只询问远程地址和可选路径，要求 stdin/stderr 为 TTY，提示与保存消息写 stderr。
非交互缺配置诊断指向 `daynight review add-repo <remote> [--path <path>]`。收集完成后持配置锁
重读文档，检查选中的 review 字段与观察值，合并无关字段的已完成修改，再校验并原子替换。
注释、其他能力字段与已有路径保持；凭据文件统一使用 POSIX `0600`，无令牌文件保持原有权限。
写入拒绝符号链接与非普通文件；锁冲突、校验、替换和清理失败明确暴露。

取消或 EOF 不保存部分值，也不进入业务。review 配置引导不联网、不认证、不 clone、不初始化
SQLite 或审查运行时。引导完成后以原参数调用原操作一次，人工输入不计入业务期限；后续失败保留配置。
服务命令从配置读取开始共享五分钟业务期限，设备登录拥有独立十分钟期限。
[客户端 C6](../spec/daynight.md#c6-按需配置引导)拥有行为，
[配置引导决策](../../.agents/notes/archived/feature/2026-10-21-guided-configuration-setup.md)
保留配置事务理由，[设备登录决策](../../.agents/notes/implemented/architecture/2026-10-25-cli-device-login.md)
拥有默认服务、登录和退出的生命周期；
[顶层 setup 移除决策](../../.agents/notes/implemented/simplification/2026-10-25-remove-top-level-setup.md)
拥有配置入口收敛。

## 配置与持久化

review 的配置仍为 `~/.daynight/config.yml`，SQLite 仍为 `~/.daynight/state.sqlite`；
会话、锁、日志、缓存和临时文件仍在同一状态目录，PR worktree 仍位于各仓库的
`.worktrees/`。共享 YAML 的根节点由 `serverUrl`、`serverToken`、`workerId`、`worker`
和 `review` 组成；全部 review 设置位于 `review` mapping，详见
[review 配置](daynight-review.md#使用方式与配置)。状态路径和持久化身份保持不变。
review 运行时通过显式 SQLite 迁移从版本 1 升到版本 2，保存远端发布证据和一次性
conversation 后续轮次，保留旧边界、预算、会话、进程证据及 worktree；只读列表接受
两个版本并不执行迁移。业务模块归属与磁盘目录归属分别管理，源码整理本身不改变
持久化身份。详细格式、验证、锁及恢复规则由
[review 设计](daynight-review.md#本地数据与-sqlite)统一定义。

[project/task 配置设计](daynight-project-task.md)定义同一 YAML 中可省略的 `serverUrl` 和
`serverToken`。共享解析器保留完整 YAML 文档，业务投影分别读取并校验已知值，忽略未知字段。
服务 origin 缺省使用生产地址，凭据由 login 保存或由外部受控配置文件提供；review 不校验服务业务值，添加
首个 review 仓库时保留它们。含令牌文档的 `0600` 规则属于共享写入者，不能由某个
能力绕过。所有配置变更通过带归属声明的 write 描述或明确的 unchanged 描述返回共享保存入口；
write 在锁内比较原配置与候选配置，拒绝改变非归属值的 alias 写入。workerId 创建也遵守该规则。
YAML 语法错误只携带安全类别、代码和位置，禁止原始标量及原始 parser
cause 进入错误对象；通用诊断格式化器与其他错误链保持原职责。

Git worktree 根目录 `.daynight/project.yml` 保存 server、仓库身份和 project ID 的
本地关联。它与主目录下的 review 状态用途不同；关联模块在命中时验证远端 project，
失效时完整发现并在有效忽略规则下原子保存。Task 命令在任务读写之前调用该模块；
目录、锁、忽略规则和缓存寿命由[专属设计](daynight-project-task.md)定义。

## npm 全局自更新

`commands/update/command.ts` 在参数校验后按需加载 `updateSelf`，先于用户主目录解析、
配置加载和 review 运行时加载。review 各操作的依赖只在对应操作中动态导入，因此更新
进程不会加载 SQLite 原生模块，避免它自身占用待替换的 addon。帮助和参数错误同样
无需进入运行时；更新不接触配置、SQLite、实例锁或 Copilot 会话。`updateSelf` 返回
`current`、`ahead` 或 `updated`，携带原版本和查询目标版本；这些结果要求已安装
skill 同步成功。CLI 据此打印包结果，更新成功时提示重启运行中的 reviewer。

更新模块使用稳定入口 `main.ts` 传入的包目录，通过 `realpath` 和包清单确认
`@codetreker/daynight` 及 `dist/main.js` bin，再按平台推导实际全局 prefix。POSIX 的包路径必须为
`<prefix>/lib/node_modules/@codetreker/daynight`，启动器为 `<prefix>/bin/daynight`；
Windows 的包路径必须为 `<prefix>/node_modules/@codetreker/daynight`，启动器为
`<prefix>/daynight.cmd`。POSIX 启动器解析到当前包的绝对入口；Windows 使用
`read-cmd-shim` 解析 npm 生成的命令包装脚本，再确认相同的实际入口。包结构或启动器
不符就拒绝，保留源码、本地依赖、`npx`、pnpm 和链接安装原有的包管理权。
[npm 的目录规则](https://github.com/npm/cli/blob/b888cc9a9ff34a8b023ff47b784692396635397b/docs/lib/content/configuring-npm/folders.md)
定义全局包与启动器的位置；
[read-cmd-shim](https://github.com/npm/read-cmd-shim/blob/9887cf0f2416f05b41cd3318b8fce08d21a20d4e/lib/index.js)
负责解析 npm 包装脚本。

模块定位 npm 的 JavaScript 入口并用当前 `process.execPath` 启动，避免 PATH 中的其他
Node.js 决定目标 engine。查询和安装都使用 `--global --prefix <实际 prefix>`，子进程
工作目录固定在 prefix，处于待替换包外部。保留 npm 的环境、用户配置与全局配置，让
registry 和认证沿用该全局安装上下文；不读取调用目录的项目 `.npmrc`。
[npm 配置规则](https://github.com/npm/cli/blob/b888cc9a9ff34a8b023ff47b784692396635397b/docs/lib/content/configuring-npm/npmrc.md#L61-L77)
明确全局模式排除项目配置。

`npm view @codetreker/daynight@latest version --json` 的标量或单元素数组输出必须
解析出唯一的规范 SemVer。用 `semver` 比较优先级，当前或领先版本保留安装包；更新时将已解析的确切版本传给
`npm install`，不会再次让可变的 `latest` 选择目标。需要安装前检查调用目录的实际路径，
位于当前包内时要求从外部目录重试，避免替换使调用进程的工作目录失效。安装显式使用
`--engine-strict --force=false`，沿用 npm 的权限和错误，不调用 sudo，也不改变 Node.js
运行时要求。

安装输出直接转发，查询输出受限且用于解析；查询、安装和新进程版本验证均有时间上限。
npm 成功退出后，重新读取安装包的身份、bin 和确切版本，重新验证启动器，最后使用同一
Node.js 和新安装 CLI 的绝对路径执行 `--version`。该新进程报告的版本必须与目标严格
相同，才完成 npm 更新验证。接着由同一 Node.js 启动已安装包中的
`commands/skill/refresh-installed.js`，以原调用目录定位当前 worktree，在新进程中
捕获 bundle 并刷新已有 skill。当前或领先版本也运行该同步步骤。
[公开 skill 设计](daynight-agent-skill.md#cli-更新时的自动同步)拥有检测、去重和替换机制。
同步输出实时转发并设置时限；所有目标成功才能返回包结果。任一阶段失败保留错误原因
并非零退出；skill 失败明确说明 npm 包实际状态，不回滚已成功的包更新。

npm 管理替换、安装恢复和并发安装行为，模块不引入另一套包替换或回滚机制。更新失败
不承诺原安装文件完整保留；需要按 npm 的错误处理安装。命令不控制已运行的 reviewer 或 worker，
其内存和已加载模块保持原版本，操作者须重启后使用新版本。Windows 上被占用的原生
addon 可能阻止替换，npm 失败直接可见。
[自更新决策](../../.agents/notes/archived/feature/2026-10-20-cli-self-update.md)
记录包管理权、范围选择和拒绝其他安装方式的依据。

## 构建、安装与交付

发布包的 `engines.node` 为 `>=22`，无主版本上限；运行时依赖允许 Node.js 22 的当前 LTS patch。
SQLite 使用 Node-API 10，实际运行需要 Node.js 22.14.0 或更新版本；安装文档推荐当前 patch。
源码开发和发布使用 Node.js 24 LTS、pnpm 11.28.6、TypeScript ESM 和固定依赖版本。
开发工具与直接执行的 TypeScript 脚本有独立于发布产物的运行要求。构建先执行
`node scripts/clean-dist.ts` 删除包的 `dist/`，再通过 `tsc -p tsconfig.build.json`
生成产物，防止模块移动后保留旧的可执行文件。构建还将 review 的完整内置 skill
bundle 复制到 `dist/commands/review/skills/daynight-review/`，由既有 `dist` 发布规则
纳入安装包。清理和资源复制脚本从自身位置定位目录，调用者工作目录不会改变目标。
包的 `daynight` 和 `dn` bin 及发布入口均为 `dist/main.js`。资源定位沿用稳定入口传入的包目录；
[review skill 设计](daynight-review-skill.md)定义捕获、快照和加载流程。

独立的普通测试及安装验收命令各自先构建包，既验证源码职责，也通过编译产物验证
公开命令。原生 CI 先 typecheck 并构建一次，再直接运行普通和安装验收的 Vitest
配置，两个阶段使用同一份编译产物。`pnpm typecheck`、
`pnpm test`、`pnpm build`、独立 `pnpm acceptance` 和 `pnpm completion:acceptance`
的实际入口由
[README](../../README.md#cli-development)维护。资源复制回归验证从无关工作目录执行实际
脚本，在隔离包的全新目标下检查完整 bundle；重复排他复制必须失败且保留既有内容，
缺少源码时同样明确失败。原生矩阵每次解析最新可用的 Node.js 24 patch，验证开发工具链。
独立的运行时矩阵先在 Node.js 24 下构建 tarball，再分别使用 Node.js `22.14.0`、最新 `22`、
最新 `24` 和当前 `node` 安装该产物。全新 npm consumer 启用严格 engine 校验，并验证
CLI 命令、交互提示依赖和 SQLite，避免包元数据接受版本而实际依赖无法安装或运行。
源码、包元数据、构建或依赖输入变化
需要更高 SemVer；构建清理脚本也属于发布输入。[CI 路由](../../README.md#ci-selection)
选中 CLI 时，全部原生检查、运行时兼容检查和独立 shell completion 检查必须成功，
PR 的 Linux CLI 任务还检查包版本；main push 保留全量应用门禁。最终 `checks` 只接受所有前置 job 的
`success` 或 `skipped`，失败、取消及其他结果使汇总失败。
发布在验证 CLI 与安装项目依赖前检查精确版本的 tag 和 npm 记录；任一存在则成功跳过。
新版本在冻结的源码提交上独立执行 `@codetreker/daynight` 的类型检查、测试、安装验收和
发布包安装检查。发布不依赖全仓 `checks.yml` 的结果，Go server 与 Web 检查不会阻止
npm 发布；[CLI 发布验证决策](../../.agents/notes/implemented/process/2026-10-22-cli-publication-validation.md)
维护验证范围。
npm 元数据统一由固定版本的 npm 12.2.0 执行 `npm view <package>@<version> --json`
读取完整包记录并选择版本，仅 JSON `E404` 表示版本不存在。鉴权、网络、超时和格式
错误继续暴露。每次发布尝试，包括失败重跑，都会在下载产物前重复预检；发布脚本也会
在上传前检查。已有版本不再比较源码与字节，不下载旧包或补齐缺失的 tag。上传失败后
若重新查询确认精确版本存在，也成功跳过；确认不存在时保留原上传错误。
上传由独立安装的 pnpm 11.28.6 执行，采用 Borgee 已验证的 OIDC 实现。
发布命令直接接收已验证的 tarball，并使用 `--pm-on-fail=ignore` 保持该发布器版本；
开发、构建、CI 与 Docker 统一使用 pnpm 11.28.6；`pnpm-workspace.yaml` 维护
`engineStrict`、`storeDir` 和依赖构建权限。npm 12.2.0 继续负责元数据查询。`setup-node` 配置 npmjs
registry，发布子进程继承其配置与 GitHub OIDC 环境。公开仓库保留 provenance。
[pnpm OIDC 发布决策](../../.agents/notes/implemented/process/2026-10-22-pnpm-oidc-publication.md)
维护客户端选择与配置职责。
新上传仍要求同一份产物、源码和公共字节验证成功后才创建不可变 tag，元数据与 tarball
共用十分钟验证期限。npm 查询限制三十秒，GitHub 与 tarball HTTP 请求限制二十秒，
并受剩余总期限约束。
[npm CLI 发布检查决策](../../.agents/notes/implemented/process/2026-10-22-npm-cli-publication-checks.md)
维护查询、跳过与重复发布规则；发布授权、npm OIDC、产物身份及公共验证的选择依据
记录在[发布决策](../../.agents/notes/archived/process/2026-10-20-npm-trusted-publishing.md)。

## 验证与交付

根入口与每个命令的参数验证需覆盖正常调用、裸组、帮助、版本和错误结果；构建后入口
必须保留 shebang、bin 路径和版本输出。依赖隔离验证通过不可用的 SQLite 加载、缺失的
review 工具、无效或缺失配置，观察帮助、版本、补全生成和更新仍独立工作；配置保存不能进入
运行时，完成必要引导后的列表不能创建缺失状态、执行网络访问或获得 review 实例锁。
引导验证覆盖 TTY 与重定向 stdout、按能力提问、一次恢复、非交互诊断、取消与 EOF、
全部收集后保存、锁内重读及失败保留，并确认输入时间不消耗业务期限。

review 的原生 Git、SQLite、进程终止、APFS、调度与安装后完整生命周期工作负载保持
原有验收标准。独立构造的既有 YAML/SQLite fixture 验证命令重组后继续使用原有数据；
fixture 不能通过当前 store 生成基线，从而避免现有实现为自己证明兼容。具体业务验证
见[review 设计](daynight-review.md#验证与交付)。

自更新验收使用真实 npm、任务内隔离全局 prefix 和受控 HTTP registry，将 fixture 包从
`1.0.0` 更新为 `1.0.1`，检查安装归属、默认 prefix 改变、调用目录配置隔离、确切目标、
当前或领先版本、错误及 review 配置/状态保留。仅 fixture 安装被替换；不更改操作者的
全局 CLI。必须观测启动器、清单和新进程版本，验证搬迁后的 updater 仍从稳定入口接收
正确包目录。registry 访问和安装错误保持可见。

补全验证包括共享语法回归、编译后入口依赖隔离、脚本语法检查和真实 shell 交互。
`pnpm completion:acceptance` 在隔离启动文件的 PTY 中驱动 Bash 4.2、现代 Bash 和 zsh
的 Tab，检查实际插入文本、引号、后缀、描述和光标位置。它独立于 review 与自更新
安装验收。`completion setup` 验收在独立主目录中安装真实启动文件，检查 Bash 登录文件优先级、
zsh 目录选择、重复安装及启动后的注册与 Tab；使用任务内的 fixture，不修改
操作者的 shell 配置或全局安装。

GitHub Actions 保留原生 Linux、macOS、Windows 的普通测试与既有 review/update
安装验收，并在独立 Linux 作业中执行补全的真实 shell 验收。独立
project/task 安装 suite 以受控 HTTP 和真实 Git 证明三个原生平台的仓库选择与
文件行为；真实 Go/PostgreSQL 流程复用 Go command-package 的 fresh race binary。
服务验证的编排层只安装一次 CLI，原样执行 Go 覆盖率 gate，再在 Go 默认 10 分钟
计时器之外运行期限与真实解码字节预算探针。期限场景通过测试侧 preload 使用
1 秒单次、3 秒总期限，生产默认 30 秒/5 分钟单独断言；字节场景保留真实
128/256 MiB 边界和 +1 字节拒绝。职责与证据见
[project/task 设计](daynight-project-task.md#验证与交付证据)。
[仓库验证说明](../../README.md#validation)定义本地及原生 receipt 的源码身份、
受控 GitHub/Copilot 行为与真实服务验收的证据边界。运行结果随对应 PR 与 CI 保存；
历史通过记录不能代替当前源码的验证结果。
