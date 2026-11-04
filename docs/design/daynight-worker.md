# Worker 架构设计

`daynight worker run` 是持续对账的前台进程：领取配置仓库中的合格任务，在稳定 Git worktree 中按冻结的 herdr/web 模式运行 Copilot、Codex 或 Claude，并在原 claim 结束后按 backend 的停止与归档条件收尾。[需求](../spec/daynight-worker.md)拥有产品行为，[认领架构](daynight-worker-claims.md)拥有服务端归属协议，[本机记录决策](../../.agents/notes/implemented/simplification/2026-10-27-worker-claim-records.md)记录存储简化的理由与代价。账号级运行观测的[客户端采集与调度](daynight-worker-reporting.md)及[服务端存储与查询](daynight-worker-snapshots.md)各有独立职责，与本机执行协调及 claim 归属分离；它不授权资源清理或任务状态变更。完整平台验收仍需独立的运行证据。

## 总体结构

```mermaid
flowchart TB
  S[Daynight 服务端：资格、权限、唯一 claim]
  W[worker：对账、调度、资源管理]
  D[(SQLite：项目与认领/会话索引)]
  H[专用 Herdr：当前 workspace 与 agent]
  G[Git：实际 worktree 与任务分支]
  A[Agent：业务交付与最终 done]
  S <-->|typed ApiClient / REST| W
  W <--> D
  W <--> H
  W <--> G
  H --> A
  A --> G
  A -->|claim-bound done| S
```

服务端提供当前 claim 归属，SQLite 主库保存本机认领和原生会话索引，macOS Herdr 的独立 lifecycle 库保存原运行身份与停止证据；Git 与 Herdr 提供实际资源。[Herdr 生命周期设计](herdr-worker-lifecycle.md)拥有该持久机制，Linux/Windows 使用既有共享私有 daemon 路径。顶层 assignedTo 是独立人的责任归属，所有 worker 服务端写入保留它；自动候选使用 assignedTo=me，自动 claim 事务要求当前负责人等于认证账号 userId；未分配或他人任务不具备自动领取资格。既有 claim、Session 或 archive 权限保持原执行归属。Agent 完成实现、验证、PR、审查、授权合并和任务验收，最后提交原 claim 的 done；worker 按自己的完整 claim 清单决定资源生命周期，不再次解释业务验收。

## 配置与目录

共享配置根（`DN_CONFIG_DIR`，缺省 `~/.daynight`）中的 `config.yml` 的根字段 `workerId` 是首次生成并原子保存的稳定 UUID。创建复用配置锁，持锁后重读，写入只声明拥有根字段 workerId；共享保存入口在锁内核对全部非归属解码值，根循环 alias 等导致未知或其他字段变化时拒绝保存并保留原文件。已有合法身份只读复用，非法值明确拒绝。Worker 使用该根目录下的 `worker/`，配置、身份、SQLite、锁与 Controller 状态均随根目录选择；真实 HOME 和 Provider 原生目录保持不变。

```text
~/.daynight/
  config.yml
  worker/
    state.sqlite       # projects、tasks
    herdr-executions.sqlite # macOS Herdr 运行与停止证据
    instance.lock
    logs/
    tmp/
    h/                 # legacy 私有 Herdr 配置与状态
      r/<instance>/    # macOS 每个实际运行代次的独占实例
<local_path>/.worktrees/daynight/<task_id>/
```

每个配置根目录一个 worker；不同根目录不应管理同一任务 worktree。Run 和人工管理命令使用同一个实例锁，以同一 SQLite 作为取得/释放锁时的 gate；不添加锁表。失效 worker 锁可回收，但不能据此认定原生进程已停。

独立的 worker mapping 包含 repositoryRoot、maxConcurrent、pollIntervalMs、recoveryLimit、agentControlMode、agent、model、args 和 repositories。默认值依次为 `~/daynights`、1、60000、3、herdr、copilot、null、[] 和 []。省略配置文件、worker 或可选字段使用这些默认值；显式 null 只对 model 有清除语义。根节点、review、worker 及其仓库条目的未知字段在运行时忽略，CLI 编辑保留其原 YAML 节点；已知字段的类型和值、YAML 结构、重复键、读取故障和取消继续严格校验。stateDirectory 等未知 YAML 字段不能改变状态根；覆盖入口仅为环境变量 DN_CONFIG_DIR。读取配置不重写文件。pollIntervalMs 的单一默认值由 workerConfigurationDefaults 提供；runtime 在每轮检查完成后按配置间隔等待，默认 60 秒。显式合法值直接保留，不迁移已有的 5000 配置。

Repository entry 需要 remote/path，可提供 projectId、agent/model/args 覆盖。路径相对 config.yml 目录或为绝对路径，不依赖启动 cwd，不展开 tilde；重复项目、重叠仓库和与状态根重叠均拒绝。相同 agent 类型逐字段继承；切换类型清除未显式给出的 model/args。Args 整体替换，不能覆盖 worker 拥有的 cwd/session/model/mode 参数或固定 full access 策略。普通 model、reasoning、日志和附加配置参数仍由原生工具解释。

`worker repo list` 只读本地注册。Add/remove 选择远端现存可访问 Project；显式 --project 支持非交互，否则多选显示名称、完整 UUID 和 repoUrl。新注册使用 worker.repositoryRoot 计算绝对路径，已有注册保留传输 URL、路径和覆盖，remote-only 项只补 projectId。Remove 只改变后续领取范围，不删除 clone、claim、worktree 或原生历史。repositoryRoot 与 review 独立，改变根不移动已有注册。

项目选择使用同一份捕获的服务凭据及 worker 配置，网络与提示不持配置锁。解码后的选择基线覆盖服务凭据、根的原始存在性与值、仓库列表，setup 另覆盖全局 native 字段；深比较支持未知字段的循环 alias 并检测并发变化。Repo 更新拥有 repositories 及保留条目的 projectId，setup 拥有 agent/model/args/repositories 及确认重置的仓库原生选项；repositoryRoot 和保留条目的未知字段始终受保护，显式删除拥有整个所选条目。保存时锁内重读并检查所有非归属解码值，拒绝相关变化及共享 alias 引起的无关变化，保留其余 YAML 节点、注释和安全 alias。空配置的交互式 run 先引导选择；非交互给出 repo add --project 指引。选择、取消或远端失败都不能启动部分任务。

`worker setup` 拥有交互编排：验证 stdin/stderr 为终端，读取当前同源配置快照，汇总公共环境报告，单选 Copilot/Codex，读取完整可访问 Project 清单并预选已有注册，再校验候选配置及每组实际 native model/args。最终摘要展示保留的传输 URL/路径、删除的注册和不兼容参数重置，确认后通过 repositories 模块一次原子保存。所选 agent 应用于全部选中 Project；切换类型清除不兼容的全局或项目级 model/args，兼容值保留。

Setup 复用 Herdr preflight 的原生版本、目录、运行时、hook asset、有效 SessionStart 及固定启动参数能力检查。Codex 要求至少 0.135，并支持 `--no-daemon`、权限及 hook trust bypass；两个 provider 都通过带固定参数的只读 `--help` 探测验证原生解析能力。公共报告检查平台、Node、Git、Herdr 版本、私有端点和随包 managed 技能；候选 integration 状态通过只读 herdr integration status 获取，不启动私有实例。运行时的 integration 修复由独立的 preflight 编排负责，共享的 prerequisite checks 保持只读；运行时在 task cwd 验证有效 hook，并由原生命令报告恢复错误。Setup 检查不证明 provider 登录、真实 hook 执行或 live 协议能力。

独立环境探测返回通过、缺项或未验证的结构化结果，所有已启动探测用 allSettled 等待收尾。普通缺项可给修复指引并保存配置；命令清理的 AggregateError 及其 cause 链始终优先于普通缺项或取消，未确认进程收尾使 setup 明确失败。Setup 不安装、登录、clone、打开 worker SQLite、取得 claim 或启动 worker/Herdr/native agent。

配置在启动或重启时加载，不热重载。同一 claim 保留 agent 类型、模式和 session_id；Herdr 需要重新启动时使用当前适用于该 agent 的 model/args，Web 恢复沿用已冻结的执行配置。另一工具的配置不会套到原工具。移出配置的项目仍由已有 projects 映射参与对账，使用当前全局适用设置。

一个状态目录属于当前配置的单一服务、账号和 workerId。切换这些身份前先结束旧执行，再重建本机状态；认领索引不承担跨服务或跨账号的旧执行自动接续。

## SQLite：项目映射与认领索引

```sql
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  repo_url TEXT NOT NULL,
  local_path TEXT NOT NULL
) STRICT;

CREATE TABLE tasks (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'done')),
  agent TEXT NOT NULL CHECK (agent IN ('copilot', 'codex', 'claude')),
  session_id TEXT,
  agent_control_mode TEXT NOT NULL DEFAULT 'herdr' CHECK (agent_control_mode IN ('herdr', 'web')),
  PRIMARY KEY (project_id, task_id, claim_id)
) STRICT;

CREATE UNIQUE INDEX tasks_one_active_per_task
  ON tasks(project_id, task_id) WHERE status = 'active';
```

| 本机状态 | 责任 |
|---|---|
| pending | 已实际取得或找回 claim，等待启动 |
| active | 承担启动、运行、恢复或收尾责任，占用名额 |
| done | 原 claim 的本机执行已结束；macOS Herdr 的 worktree 与 archive 责任仍由独立 lifecycle 保留 |

`agent` 来自实际取得的 claim；`agent_control_mode` 是服务端冻结的模式；`session_id` 是原生会话 ID，尚未取得时为 NULL。macOS Herdr workspace/pane/terminal 与原进程身份由独立 lifecycle 库保存并与当前观察核对；其他平台从当前资源发现。启动资源前先提交 active，终止清理全部完成后才提交 done；失败保留责任，结束行保留。

Projects 在远端认领前保存仓库映射。有未结束任务或实际受管资源时不能改变该项目绑定。存储使用实际 SQLite 事务、STRICT 表和唯一约束；主索引没有配置快照、启动回执、PID、恢复次数、清理进度、管理意图或时间列。macOS Herdr 的原运行、输入准入、停止 journal、Session 连接和段边界由独立 lifecycle 库保存；配置选择、累计恢复次数和通用人工管理意图仍不写入该主索引。其他平台保留进程内运行进度。Web 的执行证据由独立 backend 保存，不能当作 Herdr 的恢复来源；日志只用于诊断。

主索引以此结构作为独立版本 5 的基线。五个既有非 lifecycle 业务库的版本 0 统一在既有准入后丢弃原 schema 和数据，再执行各自基线与编号升级；已有空文件和查询访问同样初始化。旧详细执行 schema 的非零版本 1–4 仍明确拒绝并保留原库，要求停止旧 worker 后自行移除该库。独立 Herdr lifecycle 库的现存无版本或不兼容数据必须保留并拒绝，不能按上述规则重置。workerId 与原生历史保持各自原有位置。[SQLite 升级设计](cli-sqlite-migrations.md)拥有同步重置、非零来源检查和单库原子性。

## 启动、发现与周期对账

启动先取得实例锁、稳定身份并核验账号，再创建独立的运行快照 collector/reporter，随后解析当前配置的 Project 并保存 projects。CLI 显式注入运行包 version 和启动时捕获一次的 workingDirectory；reporter 的首次采集不等待仓库准备或 tick，之后由独立 30 秒 timer、完整清单及确认 claim 驱动。首次完整清单查询范围为当前配置项目与已有 projects 的并集；空数据库也先完成映射，才能找回原 worker 已有的 claim。完整清单发布只包含不可变引用和来源时刻，位于资源观察与较长操作之前；报告无额外 inventory 查询或 SQLite 字段。[上报设计](daynight-worker-reporting.md)拥有单飞、合并、采样、缓存及传输机制。

```text
完整读取自己的远端 claim 清单，补齐 SQLite 中的实际 claim
→ 观察专用 Herdr，优先排队推进仍归属的本机 active 和已确认的收尾责任
→ 完整发现 Herdr/Git 资源，核对遗留执行并汇总实际容量
→ 发现成功且有空闲名额时，优先启动 pending，再领取新任务
→ 可取消的轮询等待
```

自有清单只使用 workerId 归属条件，不混入 assignedTo、ready、allowAgents 或候选平台筛选。新候选单独组合 assignedTo=me、ready=true、allowAgents=true 和实际平台条件，在服务端排序和分页前过滤并绑定游标；每页保持相同选择。负责人不匹配的直接 claim 在项目写事务内拒绝，既有 claim 的恢复和显式人工 resume 仍按原执行权限处理。分页、认证或项目读取失败不产生可用于缺席清理的集合。完整性只对成功查询的项目成立；Herdr 中未映射的项目资源报告错误并保留，恢复项目配置后再纳入对账。Herdr/Git 读取失败保持错误，不解释为空资源。

每个 task 的操作在进程内串行，不同任务的有界 RPC、恢复和清理可并行。容量按 claim 去重计算 active 行、实际归属资源、已确认的 ending 收尾责任和适配器尚待确认的停止责任的并集。即使某个孤立执行没有本机行，关闭 pane 后尚未完成 Git 删除或进程停止确认，其名额和同 task 启动屏障仍保留至清理完成。macOS Herdr 的原运行停止、封段及 ledger 同步确认后释放执行槽，但保留 worktree 仍维持同 task 屏障；已排队恢复的 job 继续计入容量。降低 maxConcurrent 不抢占已有任务。已有 pending 优先，项目内按稳定 task_id 顺序选择；新候选保持服务端 ready 顺序。Pending 启动和新领取均以一次成功的名额分配为轮转单位，每分配一个名额就从下一个项目继续选择；一个项目持续有候选时也不会一次占满所有空闲名额。

仍属于自己的本机 active 已占名额，先为这些任务排队，在各自串行操作内读取当前 Herdr 并恢复；全局 Git 发现中其他工作区的文件系统错误不阻塞它们。新的 pending 启动和新 claim 分配仍等待完整全局资源发现成功，确保未计入的遗留资源不能释放出假名额。

每轮 Herdr 快照只用于调度和容量判断。实际启动或恢复在该 task 的串行操作内部重新读取 Herdr，再选择连接、重建 workspace 或启动原生进程。等待前一个操作期间，原 pane 可能已从 inactive 变为存活 agent；使用当轮旧快照不能授权重建或替换它。macOS 还须通过持久准入核对原运行，旧快照和空 pane 都不能替代原始停止证据；legacy 路径只依据当前资源检查。

新领取在远端写入前跳过仍有同 task 旧资源的候选，再直接调用进程内 typed ApiClient：原子 claim 成功后登记 pending；macOS 随即保存该新 claim 的空运行记录，证明资源尚未启动，再确认名额和旧执行收尾后提交 active、准备资源。请求结果未知时记录 Warning，不创建资源、不重发原请求；后续完整清单找回实际授予。macOS 不把这种库存找回解释为 fresh launch provenance；缺少原 lifecycle 记录时保留未知，不因远端 native 摘要为空而补建运行。服务端精确版本与唯一 active claim 控制竞争。并发上限约束本机 active 资源数，迟到授予可以留下等待名额的 pending。

现有远端 phase、Herdr 和 nativeSessionId 字段是当前观察的展示投影。每次基于新读到的 task/claim 与精确版本更新，未知响应记录日志后重新读取；投影不决定本机资源动作，也不保存待提交摘要回执。

## Git 工作区与资源身份

每 task 使用分支 `daynight/<task_id>` 和目录 `.worktrees/daynight/<task_id>`。新分支从仓库 HEAD 创建，保留分支从原 tip 使用。已有目录必须与仓库、Git 注册、静态 claim/worktree 身份及精确 .git 指针匹配；正常恢复保留 dirty state，不 reset/clean。原生会话已知而原 worktree 丢失时报告错误并保留 active。

统一的资源身份为 `projectId/taskId/claimId/worktreeId` 四项 canonical UUID。Herdr 标签后缀和 Git locked-worktree 所有权标记使用同一份身份；服务地址参与 API 请求和 managed assignment；macOS lifecycle 的完整 owner 另绑定 serverOrigin、workerId、ownerUserId 和 provider，不能与四字段展示标记混为一谈。动态执行进度与 title 不进入 Git 标记。实际 pane、cwd、Git 注册和目录每次读取。Device/inode 只作辅助核对；符号链接、外来路径、缺指针或歧义注册不能授权破坏性删除。

仅在 backend 允许终态删除时，清理先确认进程停止、workspace 关闭及必要归档，再删除已核对的 worktree 内容，保留 .git 指针至内容删除完成，最后移除目录与 Git 注册。中断后只根据仍存在的实际资源继续；仍存在但缺指针的路径保留并报告。分支和提交历史保留。

资源发现检查未结束行、done 行和遗留资源。Git 标记只含 project/task/claim/worktree 身份及物理校验信息，不含 workerId；必须关联本机行、专用 Herdr 或当前自有 claim，才能认定由本 worker 管理。仅有 Git 标记、无法证明属于本 worker 的资源报告并保留，不因自有清单缺席就删除，也不猜测 agent 构造任务行。已知项目仓库和专用 Herdr 是扫描范围，不进行全磁盘发现。

## Workspace 名称与身份

Herdr 的 label 同时承担 workspace 显示名称。名称以经过终端安全转义的完整 title 开头，随后是 ` | daynight:` 与四字段 canonical JSON。解析器只读取最后一个分隔符之后的严格身份 JSON；标题可包含相同分隔符或 JSON 片段，不参与归属比较。读取时只按身份后缀识别，展示标题为空或含未转义字符不改变归属；身份格式不符返回 null，忽略该 workspace；Git 注册扫描同样跳过缺失或格式不符的 marker，并从待核对目录集合移除该注册的目标。两处只容忍格式解析失败，IO 与已识别资源的完整性校验继续报错。Unicode Cc、行分隔符和双向显示控制字符转为字面量 `\u{hex}`；其余文本包括 emoji 的 ZWJ 保留。完整 title 和身份不在 CLI 中截断，Herdr 决定当前终端宽度内的显示。

Agent name 为 `dn_` 加四字段 canonical JSON 的 SHA-256 前 24 位十六进制字符，与 title 无关。创建、发现、观察、停止和清理比较四项身份，再核对实际 workspace/pane/terminal/cwd；清理不需要可读取的 task title。名称与归属分离的选择和 Herdr API 限制见[命名决策](../../.agents/notes/implemented/architecture/2026-10-28-worker-workspace-names.md)。

现有 own-claim inventory 已提供完整 Task。协调器把最新 title 作为展示输入传递，复用 task 的串行操作，在下一轮成功清单后按实际 label 差异调用 `workspace.rename({workspace_id,label})`。活 workspace 与恢复超限任务仍有同步机会；不新增查询、SQLite 列或后台任务。请求前后核对稳定身份与实际 workspace ID；取消后不提交新请求，已发送请求的迟到结果不授予归属或允许重新创建。Herdr 的 `workspace_info` 响应只确认内存名称更新并安排保存，重启仍依据最新 title 与 snapshot 再对账。

只有 rename RPC 或回执故障属于 `workspace-name-error`，保留原 cause，留待后续重新观察且不计入执行恢复预算。binding/身份冲突及取消仍是生命周期错误。title 不进入 prompt 或 agent 输入，因此不能改变任务指令。

运行资源使用当前四项身份格式，启动和人工管理直接执行正常的配置、实例锁、资源观察与执行流程，不读取迁移清单或转换历史 label、Git marker。发现时跳过格式不符的候选；针对明确目标的所有权和物理绑定检查保持严格。删除格式转换、备份、回滚及启动阻塞机制的决定见[迁移机制移除决策](../../.agents/notes/implemented/simplification/2026-10-28-remove-worker-workspace-migration.md)。

## Web backend 与执行证据

配置的 `worker.agentControlMode` 省略为 herdr，只影响新 claim。同 claim 始终沿用服务端模式；普通 summary 与 properties 更新不可改写。Web 运行 Codex stdio app-server、Claude Agent SDK 或 Copilot SDK 私有 runtime；其初始输入、原生控制、停止和恢复契约由 [Task Session 设计](task-session-protocol.md)拥有。

主协调器仍从完整自有 claim 清单和实际资源对账，为两种模式合并计算容量与同 task 启动屏障。macOS Herdr 使用独立持久 lifecycle 与进程内 jobs，其他平台保留最小索引路径；Web 在独立版本 1 的 `worker/web-executions.sqlite` 保存自己的冻结配置、初始输入回执、恢复预算和清理期限，在 `controller/` 保存 ticket 与版本 6 的原生 journal。Web 版本 0 重置原 schema 和数据，因此其旧 completed 行不进入补归档库存；此重置不删除独立 execution 目录中的 ticket、journal 或待归档文件。当前版本 1 的 CRUD 保持既有 JSON parser 与缺省字段语义，不增加更严格的字段验证。Worker 持原实例锁分别打开两库，两者成功后才创建 coordinator；一库失败不回滚已提交的另一库，下次按各自版本恢复。原始 Web 执行状态缺失时保留责任并报错，不能使用 legacy Herdr 的 NULL ID 新建语义代替连续性。

Web 普通终止清理使用持久化的同一 cleanup 操作与期限，确认 Controller 和原生进程停止后封存并上传 Session 文件归档，服务端确认 ready 后才删除 Git worktree。归档失败保留源和收尾责任，只重试上传；每轮有界补传旧 completed 执行并对失败退避，已删除的 cwd 不妨碍从原 execution 目录补归档。Task 软删除后，仍具有效 PAT 和项目成员资格的原 Session owner 通过专用归档收尾接口取得 ready 回执后释放执行容量；身份失效或上传失败继续保留源和责任，不将访问拒绝当作归档成功。文件格式、完整性与只读读取由 [Task Session 设计](task-session-protocol.md#完成后的文件归档)定义。worker 退出直接停止拥有的执行并保留未完成责任。强制撤回先在服务端冻结原 Session 的普通写权限，worker 后续完整清单再收尾；没有立即停止的保证。

## Herdr 与原生会话

macOS 每个实际运行代次独占一个现有 Herdr daemon；Linux/Windows 共享各自 Worker 的私有 daemon。专用 Herdr 保持 `resume_agents_on_restore=false`，由 worker 唯一决定 agent 启动或恢复。复用私有端点、XDG 隔离、原 native 认证环境、shell history 与 attach；原 task pane 环境不会因客户端连接被改写。

Fresh/resume 原生启动前，runtime preflight 通过同一私有 daemon 的 `integration.list` 获取所选 agent 的唯一有效记录。`current` 不产生安装写入；只有明确的 `not_installed` 或 `outdated` 才调用官方 `integration.install`，参数仅为 `{target: agent}`，随后重新读取并要求状态为 `current`。缺行、重复行、畸形数据或未知状态明确失败，不据此推断可以安装。官方安装器拥有 provider home 中 integration 配置与 hook asset 的更新；worker 不自行实现另一套配置写入器。

Codex 修复在安装 RPC 之前要求当前 worker 启动的私有 daemon 子进程仍存活，保证所核对的 native 环境来自本次启动；复用既有 daemon 时 API 不提供原始环境证据，因此在写入前拒绝自动 Codex 修复，正常停止并重启 worker 后可重新建立环境关系。随后读取 daemon 版本并要求已核对的 Herdr 0.9.5，再有界读取 provider home 中的 `config.toml`；只有文件不存在视为空配置，读取错误直接传递。只读保护按该版本官方安装器的逐行规则预测改写，用 TOML parser 解析原文和预测文本，并比较完整配置语义；只允许启用 `features.hooks` 和删除 integration 拥有的废弃键 `features.codex_hooks`。非法 TOML、重复表、inline/dotted/quoted features 布局或多行字符串被破坏等情况，在任何安装写入之前明确失败。日期/时间值和 parser 不支持精确比较的结构同样拒绝，避免精度折损掩盖语义变化。worker 不自行规范化或回写 native 配置。未核对的 installer 版本拒绝自动 Codex 修复；已 `current` 的路径和 Copilot 不执行此 TOML 保护。此检查不承诺保留注释，也不锁定外部客户端对配置的后续修改。

每次启动独立发出 integration 请求，由私有 daemon 的事件循环逐个同步执行官方 handler；安装由其中的 integration handler 拥有。这里的串行处理针对单个 daemon 请求，整个 preflight 序列不构成一个原子操作。各次 preflight 使用本次调用的取消与 deadline；安装与核对失败或取消保留错误，不启动该次 native agent。未知写入结果不自动重放，后续尝试先重新观察；取消或响应丢失不撤销已经到达 daemon 的安装。

安装后仍在实际 task cwd、原 native 环境和本次配置下验证有效 hook feature、SessionStart 命令、hook asset 与运行时，完成后才可 `agent.start`。静态检查与安装回执不证明 hook 已执行；官方原生 session ID 绑定与输入 readiness 仍使用既有机制。存活 agent 的直接重连不触发重新安装。Setup 继续通过离线 `herdr integration status` 及共享只读检查报告缺失依赖，不创建 daemon 或修复 integration。决定与代价见[integration 修复决策](../../.agents/notes/implemented/bug-fix/2026-10-28-worker-integration-preflight.md)。

macOS 的原运行必须有持久来源。原 agent 仍存活时接入同一 Session，只增加 connectionEpoch 并建立显式间断的新段，不重发 assignment。需要重新启动时，必须已有原运行的可靠停止证明、原 nativeSessionId 和已确认的首次输入结果，再以同一 Session/native conversation 建立下一 executionGeneration。prepared 运行只有在原 daemon、shell 和端点身份一致时才能继续原启动；launch_requested 恢复、未知输入或停止保持阻断。nativeSessionId 可以在首次输入后补齐，不作为取得原生进程身份的前置条件。

Linux/Windows 保留 legacy 恢复：存活 agent 直接观察；需要重新启动时，停止并关闭 inactive workspace，以当前 native 环境重建后按索引 session_id 选择 resume 或 fresh。inactive pane 的遗留原生引用不能填入索引；已知非空 ID 不可被不同观察覆盖。NULL 可用于 legacy 新会话，也可能覆盖 ID 尚未保存的中断窗口；macOS 不能沿用这个窗口新开对话。

首次启动的完整 managed assignment 显式提供 worker-managed、using-daynight、autopilot-managed-task 及 task/claim/worktree 上下文和执行配置。Prompt 要求在已有授权和任务范围内自主决定；确需人工介入时先核验原 assignment、设置并读回 paused，问题解决且获准后清除暂停再继续。Review/CI 的普通等待由 agent 持续处理，不因此结束执行。Legacy 明确恢复仍使用完整 assignment；macOS 已确认传输后恢复只发送继续原任务的输入，不重放首次正文。适配层不选择业务任务或解释验收。

巡查在每个 task 的串行操作内读取当前 agent。原 claim 仍有效、当前 task 未暂停周期输入、agent 存活且 interactiveReady、未在启动、没有首次输入待递交时，idle/done 触发继续原任务的 ping；working、blocked、unknown 或尚未就绪只观察。workerPingPrompt 将完整正文包在字面量 `<system remider>` 与 `</system remider>` 标签内，沿用原任务、claim、worktree 和授权，要求自行等待 review/CI；agent 的 idle/done 不作为业务完成凭据。进入终止清理后只推进收尾。

暂停使用可写布尔 task property paused。缺席与 false 在周期 ping 决策中均表示未暂停，但存储与通用读取保留两者差别；存在的错误类型必须暴露。该值不复制为 SQLite 状态，也不改变 worker.phase、task 状态或新 claim 资格。Web backend 当前没有周期 continuation ping，此标记不增加新的 Web 输入或控制流程。

Herdr 适配层为周期 ping 接收独立的发送前检查，在 workspace 串行操作及原生输入界面就绪检查之后、agent.prompt mutation 之前读取服务端当前 task，核验原 active claim、workerId 和 worktreeId，再检查 paused。原库存快照不能授权该次输入。读取失败保持原错误链且不递交，归属不再匹配时不接管新 claim。最终检查之后与原生 mutation 之间没有跨系统原子事务；已发送或已受理的输入不会因随后暂停而撤回。

暂停返回明确的未递交结果与当前观察，不作为输入失败或已提交回执，也不更新上次输入基线。解除暂停后，仍然 idle/done 的同一观察可成为新的正常 ping 决策。Legacy 的首次及待递交 assignment、恢复和 cleanup 输入不使用这个周期门禁。macOS durable adapter 在所有自动输入的最终递交边界核对 paused、原 claim、进程身份和 admission；暂停保留观察、原运行停止与人工 attach。取舍由[暂停周期输入决策](../../.agents/notes/implemented/feature/2026-11-02-task-paused-worker-pings.md)拥有。

macOS 由 durable adapter 分离 launch 和 input：先保存 preparation 与 launch_requested，启动后持久保存原 shell/native agent 的出生证明，再开放 active admission。首次输入保存 pending/dispatching/transport_completed 或 unknown；重启遇到未确认提交时阻断重放。Session 注册、同代重连、停止证明与采集段通过独立事务边界恢复，详情由 [Herdr 生命周期设计](herdr-worker-lifecycle.md)拥有。

Legacy 的首次 assignment、上次输入观察与提交回执仍由执行驱动的内存 pendingInput 和基线管理。明确未递交时等待匹配 pane 的输入就绪；成功回执通过 onPromptSubmitted 在后续观察前建立基线。观察未改变时不重复递交；未知结果先观察核对，不盲目重放。这些 legacy 基线不跨进程保存；macOS 的未知输入限制不能被内存基线重建覆盖。巡查选择依据见[agent 巡查决策](../../.agents/notes/implemented/bug-fix/2026-10-27-worker-agent-patrol.md)。

每次 fresh/resume 启动都由同一个参数构造器施加固定 full access 策略，配置中的 model/args 不能降低权限或重新启用确认。Copilot 在配置参数后追加 `--allow-all --no-ask-user --no-sandbox`；创建该任务 workspace 及运行只读原生探测时，最后覆盖 `COPILOT_ALLOW_ALL=true`、`COPILOT_ASSISTED_APPROVAL=false`。精确的字符串 `true` 同时免除 Copilot 的交互式目录信任；关闭 assisted approval 避免继承环境恢复权限确认。

Codex 保留 `--no-daemon [resume <session_id>]` 前缀，在配置参数后追加 `--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust`，随后追加两个独立参数 `-c`、`check_for_update_on_startup=false`，覆盖配置参数中的同名设置，使 fresh/resume 启动均免除更新检查及其交互提示。Herdr 的 `agent.start` 接收结构化 argv，回执逐项核对；任务 prompt 通过独立的 `agent.prompt` 递交，配置覆盖不拼入 prompt。该调用级设置不写用户全局 `config.toml`，也不改变 Copilot；依据见[启动更新检查决策](../../.agents/notes/implemented/bug-fix/2026-10-28-worker-codex-startup-update.md)。最后通过 `-c` 注入 `projects` inline table，各路径 key 的值均为 `{trust_level="trusted"}`。任务路径先取 realpath，再生成与 Codex 原生查询一致的 trust key：Windows 将 ASCII 大写转为小写，并在同一个 table 中写入去重后的普通路径与 extended/namespaced 路径两种拼写，以覆盖 Node 和 Codex 对 drive/UNC 前缀的差异；非 ASCII 字符大小写保留。Linux/macOS 使用一个保留原大小写的 key。

使用原生归一化 key 可覆盖同一路径已有的 untrusted 设置，避免其精确匹配优先于混合大小写的覆盖。各 key 编码为 TOML 字符串；inline table 将含点号、引号或 Unicode 的路径保留为完整 key，避免 dotted override parser 拆分 `.worktrees`。两个 bypass 开关不免除目录信任，因此 trusted 配置是同一启动策略的一部分。Codex 的有效 features 检查使用相同真实 cwd 和最后的 trusted 覆盖，保证检查实际会被加载的项目配置。参数与版本选择的依据由[full access 决策](../../.agents/notes/implemented/architecture/2026-10-27-worker-full-access.md)拥有。

参数校验在启动 RPC 前拒绝 Copilot 的 assisted approval、sandbox、deny/tool restriction，以及 Codex 的 approval/sandbox 控制和重复的系统 bypass 开关。缺少原生能力明确失败。策略只作用于本次命令和任务 workspace，不写全局 native 配置；认证、业务授权及组织/操作系统策略保留各自归属。

保留当前输入 readiness 与 Codex composer 检查，启动输入只提交到可用的业务 composer。需要业务人工输入时通过 worker attach 在原终端处理。Legacy 的启动回执、输入提交状态和停止观察只留当前调用；macOS 保存原运行和输入结果，未知结果阻断重放，但传输完成也不证明模型恰好处理一次。原生历史可用性由原生命令报告，不额外扫描 provider 数据库或会话 manifest。

自动恢复计数及超限等待只在当前进程中维护，重启清零。达到 recoveryLimit 后保留 active 与错误，可用人工 retry 或重启重新尝试。

## 结束、清理与退出

正常对账发现原 claim 不在成功完整自有清单中时进入对应 backend 的终止收尾，无需再按 done/release/强制撤回分类。

macOS Herdr 通过持久 journal 保存 stop_intent 和 close_requested，使用原出生身份与 audit token 停止独占运行，保存 stopped_confirmed、封段并确认 ledger。不能凭 pane 消失、PID 或命令行变化、内存 Map 为空判断停止。替代实例和未证明资源保持 unknown，不接管、不删除。journal 写失败只允许依据已有证据尽力停止，不能在重启后补写意图来追认同一 boot 中已消失 daemon 的完整停止。

当前 Herdr 注册能力 observe/control/archive 均为 false，没有最终 archive finalization。终态停止不发送 cleanup prompt；即使原运行停止及同步已确认，可结束本机执行行并释放执行槽；worktree 和独立 archive 责任仍保留，保留工作区继续阻止同 task 后继覆盖。Web 则继续以 ready 归档回执作为工作区删除门槛。

Linux/Windows 保留 legacy 顺序：通知 agent 清理可归属的工作区外临时资源，最多等待本次尝试十分钟，停止进程、关闭 workspace，再删除经过核对的 worktree 并写本机 done。成功通知后的后续 idle 观察可结束清理轮；通知前 idle、发送回执或未知通知结果不替代该观察。清理期限在同进程内不重置，重启可重新通知并计时。未知停止和失败保留资源及责任，分支历史始终保留。

Ctrl+C 的根取消信号同步停止报告、新领取和调度，并取消全部 job；先等待报告和 job 收尾，再停止原执行，不发送清理 prompt、不等待清理轮、不删除 worktree、不将未完成行置 done。macOS 仅封闭原运行与段，保留 claim 和同一 Session，不发布最终 ready；下次根据原停止与 native 身份决定恢复。未完成的终态责任继续收尾。工作区外临时资源可能遗留，不能声称覆盖任意后台服务。

Legacy 关闭 orphan workspace 前先保存已证明的 agent 类型及存活 native ID 到 pending 索引，以免移除最后的归属标签；未知类型保留并报错。macOS 依据独立 lifecycle 责任，不用远端摘要或现存 foreground 覆盖原始证据。已知目标的停止独立于其他仓库或同项目 sibling worktree 的错误；删除仍按原 Git 物理身份检查。

历史共享 daemon 的直接退出理由见[直接退出决策](../../.agents/notes/implemented/bug-fix/2026-10-28-worker-direct-shutdown.md)；macOS 的独占停止与恢复边界由 [Herdr 生命周期设计](herdr-worker-lifecycle.md)拥有。

## Agent 完成与人工操作

Agent 完成全部交付和证据后，使用显式 claimId 与观察版本通过 task set-status done 提交现有完成操作。普通与 managed 技能各自负责其生命周期，缺失 assignment 不回落普通执行；待人验、必要 PR 未合并或验收不足时保持未完成。

人工 retry/release/resume 要求先停止 worker run，取得同一个实例锁后同步处理指定 claim。锁占用时明确提示停止 runner；命令没有后台队列或持久意图。

| 命令 | 同步动作 |
|---|---|
| retry | 核验仍属于本 worker 的 active claim，尝试一次重连或恢复；保持 claim、agent、worktree；macOS 不绕过持久 unknown 或缺失原 ID，legacy NULL 按 info 后新建。pending 留给 run 正常调度。 |
| release | 核验 owner/admin、原 claim 和指定版本；按 backend 确认原停止后提交 release；legacy 继续删除并写 done，macOS Herdr 可结束本机执行行，但保留 worktree 与 archive 责任直到归档条件满足。 |
| resume | 核验 released previousClaimId 和指定版本，按当前配置申请 fresh claim/worktreeId；确认授予后写 pending、session_id=NULL；macOS 同时登记新 claim 的启动来源，申请前拒绝尚有旧 Herdr archive/worktree 责任的 task，随后 run 按资源门槛调度。 |

Release 在远端确认前保留 worktree，拒绝时仍可恢复原执行；确认成功后尚未完成本机收尾时，下一次 run 按原 claim 缺席继续处理；macOS Herdr 的归档前保留不因 release 而豁免。远端操作保留既有权限、精确版本、release 的 stoppedConfirmed 和 resume 资格检查。

新 claim/worktree ID 在提交前生成并输出。未知响应只 GET 核对、不自动重放。仍未知或命令中断时，操作者先核对远端结果，再启动 runner；没有跨进程原管理意图接续。管理期间 runner 停机是这一单控制者方案的操作代价。

Web 的“强制撤回”是独立的 owner/admin 操作，针对当前 active 或 released claim，以原 claimId 和观察版本在同一事务中清除 worker、返回 todo、清空任务起止时间并设置 allowAgents=false。它无需本机实例锁或 stoppedConfirmed，不启动目标执行，也不承诺远端 agent 立即停止或撤销外部凭据。原 worker 下次成功完整自有清单发现 claim 缺席后，按普通终止流程收尾。自动领取须等新的明确许可操作。Transfer endpoint、typed operation 和 CLI 命令已移除；受控 release 和 fresh resume 保持各自语义。详情归属展示与确认交互由[认领架构](daynight-worker-claims.md#web-归属展示与撤回)拥有。

## 观测关联和错误

沿用 stderr 与 JSONL，日志携带 workerId、实际平台、projectId/taskId/claimId、agent 和已知 sessionId。运行快照按字段和传输子系统输出清洗后的故障转换及恢复，原始采集错误只在内存保留，不进入日志；同类连续故障去重，详细规则由[上报设计](daynight-worker-reporting.md#失败与可观察性)拥有。RPC、并发 job 与清理显式传递取消和关联信息。记录认领、重连/恢复、NULL 新会话 info、资源错误、清理和人工操作结果，保留错误类型及 cause，脱敏凭据且不记录完整 prompt。

诊断模块先对凭据脱敏，再统一渲染终端日志：上下文、消息及错误链中的完整连字符 GUID 仅显示首段 8 位十六进制字符，保留原大小写，非 GUID 文本原样保留。缩写只作用于终端输出，JSONL 的字段、消息和错误仍保留完整 ID，供精确检索。事件生产者、API、prompt 与持久化继续使用完整 ID。该 GUID 展示规则由[日志 GUID 缩写决策](../../.agents/notes/implemented/bug-fix/2026-10-28-worker-log-guids.md)拥有。

执行驱动按 projectId/taskId/claimId 在内存保留最近一次报告的观察：等待/执行阶段、Herdr session/workspace/pane/terminal、agent、已知原生 sessionId 和延后首次输入状态。首次连接及这些信息变化时才报告，忽略 idle/working 切换和序列计数变化。实际启动始终报告并建立同一观察基线，避免下一轮重复提示重连；忘记原 claim 时一并清除基线。资源发现按完整成功观察比较保留警告，稳定警告只报告一次，确认消失后再出现则重新报告；失败或不完整观察不能确认警告消失。真实操作与失败尝试继续报告。去重在事件来源完成，stderr 与 JSONL 共用结果；状态只存在当前进程，日志不参与恢复。选择依据见[日志决策](../../.agents/notes/implemented/bug-fix/2026-10-27-worker-log-transitions.md)。

运行时在完整清单和私有实例就绪后提示 worker attach。该命令不读取业务凭据、不持 worker 锁，也不启动 daemon。macOS 有 lifecycle journal 时只读校验并选择未停止的原运行，验证原 daemon 与 API/client 两个端点后连接；不迁移、恢复或增加 epoch，暂停任务仍可接入。没有 journal 时保留 legacy attach；不可读 journal 不回退未知实例。Detach 保留正在执行的任务。Workspace 命名失败使用 `workspace-name-error`，沿用 task/claim 和原 error cause，具体消息包含 rename 阶段、workspaceId 与 worktreeId。按具体 claim 核对日志：

```bash
jq 'select(.taskId == "<task-id>" and .claimId == "<claim-id>")' <worker-log.jsonl>
```

## 验证边界

主索引验证精确列、枚举、nullable ID、历史行与唯一 active。macOS lifecycle 验证严格 schema、原 owner/binding 不可更换、先身份后输入、未知提交不重放、Session 注册与 ledger 丢响应读回、普通重连与 generation 换代、停止/封段/同步崩溃及归档前保留；原进程替代和 socket 变化必须拒绝。只读 attach 验证多候选选择、暂停接入、schema/权限失败与替代实例保护。

Legacy 与 Web 回归分别覆盖原恢复、周期输入、清理期限、归档门槛和人工锁。共同退出验证根取消先于报告 join、所有 job 收尾、不发送清理 prompt、不删除工作区、不把未完成行写 done。Git 验证 dirty state、静态归属、资源发现和安全删除。原生参数与 hook 检查、macOS 真实 daemon/出生身份实验和三平台完整业务验收分别提供证据，不能相互代替。

命名验证覆盖创建与活 workspace 改名、同名/长标题/中文/emoji/分隔符/终端控制字符、无变化不请求 rename、未知回执再观察、执行超限仍同步、改名与 claim 结束竞争及冷恢复；四项身份和原 native session 不得因展示变化而改变。迁移验证覆盖各阶段故障/中断、启动阻塞、持久读回、原子 marker、恢复快照、全组回滚与重入，不用成功退出码替代持久状态观察。

Legacy 清理原截止、Herdr 恢复累计次数、当前 model/args 选择及通用人工管理意图仍是进程内语义；macOS 原运行、输入准入和停止证据具有独立持久责任。既有详细状态模型的原始理由与替代方案保存在[简化决策](../../.agents/notes/implemented/simplification/2026-10-27-worker-claim-records.md)及其前驱记录中。
