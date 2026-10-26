# Worker 架构设计

状态：自动执行许可、平台要求及唯一 worker claim 的服务端/typed client 基础已实现；前台 worker、SQLite 执行存储、Herdr 和人工管理命令仍待运行时交付。本文拥有机制；[需求](../spec/daynight-worker.md)拥有产品行为，[设计决策](../../.agents/notes/implemented/architecture/2026-10-22-worker-design.md)保留真实备选方案。

## 目标与当前基础

`daynight worker run` 是一个前台常驻 CLI：通过 REST 领取多仓库中允许 Agent 执行的任务，使用系统管理的稳定 worktree 与专用 Herdr 执行，持久化状态并完成恢复和清理。Agent 负责完整交付、验收和最终 claim-bound done，worker 负责归属清单对账、资源与恢复。

设计初始源码基线为 `e533b8610ec38522fd5387e4715b573734bd16c2`。交付核对基线为 `2d7fdd1e4e178db17e46da5d3b6c0e4050edf730`：主线具有命令组合、严格 YAML、REST client、任务/属性、项目写事务和 review 的 Git/SQLite 基础；当时鉴权与显式动作生命周期已交付；当前状态由[三状态架构](daynight-task-status.md)拥有，认领基础由[归属架构](daynight-worker-claims.md)拥有，worker 运行时仍待实现。任务的服务端起止时间及图时钟遵循已交付的[执行时间契约](https://github.com/codetreker/daynight/blob/2d7fdd1e4e178db17e46da5d3b6c0e4050edf730/docs/spec/daynight-task-timing.md)，worker DTO 与生命周期扩展须保留该契约。

| 当前基础 | 复用点 |
|---|---|
| [命令组合](../../packages/daynight/src/commands/review/command.ts) | definition → command → runtime，业务按命令懒加载。 |
| [项目写锁](https://github.com/codetreker/daynight/blob/e533b8610ec38522fd5387e4715b573734bd16c2/packages/daynight-server/internal/core/store/project_tx.go#L29-L39)、[版本检查](https://github.com/codetreker/daynight/blob/e533b8610ec38522fd5387e4715b573734bd16c2/packages/daynight-server/internal/service/task.go#L100-L120) | 同一事务中检查资格、权限、版本和归属。 |
| [属性 codec](../../packages/daynight-server/internal/taskproperties/codec.go) | 新增预定义属性，保留已有 PR 属性；读与写权限分开。 |
| [REST client](../../packages/daynight/src/api/client.ts)、[分页范围](../../packages/daynight-server/internal/service/page.go) | 复用认证、int64、游标和不确定写入分类；新任务使用许可/平台候选筛选，已有执行按 SQLite 中的 taskId 读取详情。 |
| [review store](../../packages/daynight/src/commands/review/store.ts)、[worktrees](../../packages/daynight/src/commands/review/adapters/worktrees.ts) | 复用必要的持久性、Git/路径原语；worker 自己拥有状态和可提交分支。 |

## 总体结构

```mermaid
flowchart TB
  S[daynight-server: 资格与唯一 claim] --- P[(PostgreSQL)]
  S <-->|HTTP REST| W[daynight worker run]
  W --- D[(SQLite: 当前状态与恢复检查点)]
  W --> G[每 task 一个稳定 worktree]
  W <-->|本地 JSON API| H[专用 Herdr]
  H --> A[Copilot / Codex]
  A -->|实现与交付| G
  A -->|PR / CI / review / merge| R[仓库托管平台]
```

| 组件 | 唯一职责 |
|---|---|
| 服务端 | 任务自动执行许可/平台、ready、认证权限、原子 claim、归属更新、完成与移交。 |
| Worker | 轮转与名额、worktree、Herdr 启停、状态观察、恢复、自有 claim 清单对账及清理。 |
| Agent | 实现、测试、提交、PR、CI/review 修复、授权合并、任务验收及最终 claim-bound done；维护正常 task 资料。 |
| Herdr | PTY、agent 启动/输入/状态及原生会话引用。 |

不增加 agent report 命令、结果文件、callback 服务、报告事件流或通用开发流程引擎。Worker 读取 Herdr 最新状态与现有 task PR/验收资料。Review 保留自己的 PR revision、publication 和 coordinator；只在第二个真实调用方需要时提取窄的共享原语。

## 配置与目录

共享 `config.yml` 增加独立 `worker` mapping；当前 review 根字段保持原义。服务连接复用 CLI
默认 `https://daynight.cc` 与已保存凭据，`serverUrl` 只在连接测试服务时显式覆盖。配置示意：

```yaml
worker:
  stateDirectory: /workspace/automation/.daynight/worker
  maxConcurrentTasks: 2
  pollIntervalMs: 60000
  maxRecoveries: 3
  retryDelayMs: 30000
  agent:
    type: copilot
    model: auto
    args: []
  repositories:
    - remote: https://github.com/owner/repository.git
      path: /workspace/repository
      agent:
        type: codex
        args: []
```

`stateDirectory`、仓库地址/路径和 agent 类型是明确配置；目录使用工作区或项目内的绝对路径。并发为正整数，轮询/重试间隔为正整数，自动恢复上限为非负整数。表中数值是建议默认值，配置错误明确拒绝。仓库可给出 `projectId` 解决服务端仓库绑定歧义，不能猜测同仓库多个 project。

Agent 类型不变时仓库字段覆盖全局字段；切换类型时按新类型解析，不继承另一类型的模型和参数，未指定模型使用其原生命令默认。Worker 管理的 session/cwd/恢复参数不能由普通 `args` 覆盖。领取时保存最终配置，不保存认证 token；运行启动时加载配置，重启使修改作用于新领取任务，旧执行继续使用其快照。

```text
<stateDirectory>/
  state.sqlite
  instance.lock
  logs/
  tmp/
  h/                   # 专用 Herdr config/state，所有目录由此 worker 拥有
<repositoryPath>/.worktrees/daynight/<taskId>/
```

配置文件沿用既有共享配置所有者。新增任务状态、Herdr 数据和临时文件留在明确的工作区路径，不迁移 review 的数据库或锁，也不静默写入其他用户目录。保护目录不与 disposable worktree、Git 元数据或另一 worker 状态目录重叠。

每个 stateDirectory 一个前台实例；复用实例锁的排他和失效处理原则。Worker ID/机器 ID 生成后存 SQLite，重启保留；复制整库不能作为跨机器移交方式。

## 服务端模型与资格查询

`allowAgents` 与 `requiredPlatform` 已在完整 task、图投影、普通 PATCH 与列表筛选中实现；持久化、可空字段存在性、锁定和版本事务见[服务架构](daynight-server.md)。worker claim、执行归属和状态保护已接入同一事务；[归属架构](daynight-worker-claims.md)拥有具体字段、endpoint 与授权。运行时资源启动和恢复是独立能力。

任务顶层字段：

```text
allowAgents: boolean
requiredPlatform: null | windows | linux | macos
```

旧任务经各自迁移取得 `allowAgents=true`、平台 null，保留其他数据、版本和时间；新任务为 `allowAgents=false`，未指定平台时为 null。创建输入拒绝 `allowAgents`，平台接受省略、null 或三个枚举之一。普通 task PATCH 中许可未提供保持、显式 false 关闭、null 和其他类型拒绝；平台未提供保持、枚举设置、null 清除。资源必须显式输出 requiredPlatform，严格 DTO 不以缺字段 fallback 兼容旧数据。许可和平台变化均在 in_progress 锁定，精确版本同值请求不增加版本或时间；普通人工状态设置保持不受两字段限制；released 执行通过显式人工 resume 接续原成果。

Web 在任务详情标题下的同一状态行中，左侧显示状态、ready 与可选平台信息，右侧显示单一“自动执行” / “Automatic execution”标签与开关组合。组合控件同时表达服务端已确认的许可状态并提供操作入口；详情仅保留此组合控件，自动执行状态不另设 badge 或下方 Overview 开关。列表中的自动执行状态标记保持其原有用途。实际任务标题直接用于详情顶栏并保留有界的完整文本键盘阅读，长标题与窄屏不覆盖状态或开关；平台等左侧信息仅在左组内换行，右侧控件保持右对齐并与第一行状态顶部对齐。锁定原因通过支持悬停与键盘聚焦的控件 tooltip 展示；错误、未知结果和等待人工输入的反馈由[详情提示层](daynight-web.md#任务详情提示)展示为限时浮动气泡，恢复入口与会话写入保护保持可达。成功反馈由详情中观察到的 pending→confirmed 转换触发，以不参与布局的浮动气泡展示 3 秒；持久 mutation 状态继续归属任务会话，关闭重开不重播已确认结果。

每次开启或关闭都打开对应确认框；确认按钮直接提交目标值及打开确认框时观察到的精确 version。取消、Escape 或关闭不提交，开关保持服务端已确认值；请求成功后安装完整返回 task 并刷新图。修改与 status 共用单 task 写入控制，提交或结果不确定期间阻止重复写入；确认拒绝保留原值，版本冲突读取最新状态并要求重新决定，断连/5xx/协议错误先核对实际结果，不自动重发。任务切换、关闭详情和后台刷新保持请求归属，已提交操作不依赖弹框仍然挂载。

开启框说明 worker 可在任务处于 todo、依赖完成并符合运行条件时自动领取；关闭框说明 worker 将不再自动领取。自动执行许可与 ready 独立，手工 set-status 与普通元数据修改均保留许可。实际切换在 `in_progress` 拒绝；权限和版本检查先于同值判定，精确版本同值 PATCH 返回原 task，不增加版本或更新时间。关闭许可不隐式停止执行或移交资源。

确认表示明确操作意图，不能从 session/PAT 类型推断物理人工。CLI/skill 禁止自动 worker 自行启用许可，操作沿用现有项目成员写权限。Web 的双向确认、状态展示和失败交互遵循本节的布局与操作规则，具体组件与工作空间请求归属由[看板设计](daynight-web.md#自动执行许可与确认)拥有。CLI update/list/ready 的 `--allow-agents true|false` 映射到该普通更新或查询字段；随包自动候选同时使用 true 与实际平台兼容筛选，领取前从最新完整详情重验许可、ready 和平台；明确由用户指定的单任务执行沿用人工状态设置；已有 released 归属时使用显式人工 resume，自动选出的 ID 不属于人工例外。

平台兼容查询已接入现有列表。随包 autopilot 从实际 process.platform 映射 win32/windows、darwin/macos、linux/linux（含 WSL），不确定或不支持时等待；ready 与补充 list 均传同一实际平台，领取前完整详情重验绑定精确版本。后续 worker daemon 以自身真实运行平台消费该接口：

```http
GET /api/v1/projects/{project}/tasks?ready=true&allowAgents=true&compatiblePlatform=linux&limit=10
```

查询可按 `allowAgents=true|false` 筛选，缺省保留现有全量任务语义。`allowAgents=true` 与 ready、`compatiblePlatform` 在排序/limit 前组合过滤，并加入游标范围。`compatiblePlatform` 包含 null 与相同平台，CLI list/ready 的 `--compatible-platform` 直接映射该查询并保留至每页；客户端拒绝不满足声明条件的响应，不在本地删项。Web 平台确认与既有许可和状态设置共用任务会话，界面与请求机制由[看板设计](daynight-web.md#平台要求与确认下拉框)拥有。沿用服务端创建时间/UUID 顺序。后续 Worker 按空闲名额读取候选，合法冲突后考虑下一个；空页/无兼容候选不占名额。已有未完成 worktree 的候选还需确认本机持有原执行资料，否则跳过并显示需要人工移交，不能在另一机器新建空 worktree。

### 受保护的执行属性与操作

完整 Task 的 properties 包含 pullRequests 与 worker:null|WorkerClaim。worker 记录 state=active/released/completed、用户、worker/机器、实际平台、agent、worktreeId、阶段和已取得的 Herdr/原生会话；普通 create/PATCH 不能写该字段。PR 与归属更新相互保留，图仍不包含属性。

[归属架构](daynight-worker-claims.md)拥有严格 DTO、文本迁移和完整 HTTP 契约。自动 POST worker-claim 在项目写锁内重验成员、精确版本、ready、allowAgents、平台和无 active claim；PATCH 只允许当前 owner 更新当前 claim 的执行摘要。调用者在请求前生成并持久化新的、从不复用的 claimId，服务端保留最后记录并拒绝其 ID 被重新使用。

完成使用现有 PUT status 的 done 目标及匹配 claimId，要求当前 owner；普通 setter 不能释放 active 执行，也不能开始或完成 released 未完成成果。同版本同状态仍是不修改的成功。没有 worker 记录或仅有 completed 历史的任务保留普通三状态行为。

Release 要求原 owner/admin 与停止确认，返回 todo、清空任务起止时间并保留原 worktree、身份和会话。自动重新认领须保留 worktreeId/agent 并确认连续性；显式人工 resume 仅允许原 owner/admin 接续 released 成果，保留人工安排不受自动许可/平台过滤的规则。Transfer 由原 owner/admin 提交，服务端核验目标当前成员、平台及原工作区，保持 in_progress 和任务计时，安装新的目标 claim。目标身份与授权提交者分别校验。

服务端只校验身份、标识及明确确认，不远程证明机器状态；停止、原成果和会话资料仍须由执行方核实。Daynight fencing 拒绝旧 claim 的写入，不能撤销 Git 托管凭据或终止原进程。失联不自动释放归属。

## SQLite：两个业务表

复用现有 SQLite WAL、`synchronous=FULL` 和短事务原则，worker 独立 schema。无需报告收件箱、事件表或独立仓库 registry。

| 表 | 主要字段 |
|---|---|
| `worker_state`（单例） | worker_id、machine_id/name、platform、Herdr session/实例关联、下一个仓库轮转位置；pending_action 仅保存专用 Herdr 服务本身的 start/stop。 |
| `executions`（保留结束记录） | execution_id、server_origin/project_id/task_id、claim_id、worktree_id/路径/分支/所有权、仓库物理身份、冻结配置、Herdr/native session、phase、pause_reason、最新状态/观察时间、恢复次数/上限、retry_at、一次人工恢复授权、pending_action、最后错误、交付引用、创建/结束时间。 |

同一任务最多一个未结束本地执行，claimId 唯一。已释放/移交的记录结束但保留原 worktree 信息；新执行只有在确认同一 worktreeId 和原成果可继续后引用它。任务键包含 server origin，不能配置换服后把旧执行发送到新服务器；认证用户变化同样需要核对。

`worker_state.pending_action` 只属于专用 Herdr 服务的 start/stop，串行推进；未核实该服务动作前不启动新的 pane/agent。它不承载任何 task 级动作。

`executions.pending_action` 分别属于各自执行，覆盖 claim、worktree、pane/agent 启动、prompt、完成及清理。同一执行只推进一个动作，不同任务可各自有未决动作；服务 start/stop 不覆盖或清空它们。恢复先核对服务级动作，再核对各 task 动作。两个执行并发及服务退出交错必须验证互不覆盖。

每条检查点只需保存当前动作：

```json
{"id":"uuid","kind":"start_agent","expected":{"claimId":"...","paneId":"..."},"startedAt":"..."}
```

先提交检查点，再调用外部系统，观察结果确认后清除。未知结果保留并核对，不覆盖成下一动作。只记录 worker 控制的 claim/worktree/Herdr/完成/清理动作；agent 自己的 PR/merge 通过 task 引用和远端读取核对，不声称 SQLite 与所有 agent 工具具有原子事务。

## 前台循环与 worktree

```text
claiming → preparing → executing → verifying → completing → cleaning → finished
                         ↑             |
                         └─────────────┘  交付未完整时继续原会话
```

等待原因、暂停与恢复时间是当前 phase 的字段，不创建第二套 task 生命周期。claiming 结果不确定也暂占名额；preparing 到 completing、等待及暂停占名额；远端完成确认后 cleaning 不占交付名额，清理只需单独重试。降低并发不抢占已有执行。

启动顺序为锁/SQLite → 完整自有 claim 清单对账 → 专用 Herdr 实际资源核对 → 调度。当前用户/worker 的清单通过 task list workerId 条件逐项目读完分页，不附加候选资格筛选；原 claimId 不在成功完整清单就触发同一清理，不 GET 单 task 解释状态原因。同 task 新 claim 不能保护旧执行，清单失败或部分页不能用于删除。新任务仍按资格和仓库顺序原子认领，并发失败方不启动资源。

归属查询的 workerId 与隐式认证 userId 绑定 cursor 范围，store 在既有 TEXT codec 解码后、最终 limit/lookahead 前匹配，无需投影列或 claim 表。Typed ApiClient listTasks 成功穷尽所有页后才返回，失败不返回部分集合；listTaskPage 是显式部分页。新领取在本轮清单对账之后登记，避免旧清单清理新 claim。

同一执行的恢复仍需要原 worktree、会话及冻结配置，清单只恢复身份；缺原资料时暂停。显式管理写入的版本和未知结果可读具体 taskId，不作为自动清理分类。每次请求直接调用进程内 ApiClient、独立有界并参与取消，常驻命令不套普通五分钟总期限。

稳定分支和目录由 task 身份决定，不由 attempt 决定。创建前持久化预期路径/worktreeId，Git 所有权标记关联它；恢复核对实际 Git common directory、分支及持有标记，禁止套用 review 的 reset/clean。删除前必须确认执行已停、归属正确且交付完成。

## Herdr 与 agent

支持基线选择 Herdr 0.9.5，并检查实际 API 所需能力/字段，不只依赖内部 protocol 数字。缺失版本/能力时启动前给出错误；原生 session 恢复所需的官方集成与历史可用性也须预检。不自动下载、升级或修改全局集成。

专用实例的数据在 stateDirectory 内隔离，短 session 名为 `w`，由私有 config/state root 和稳定 workerId 共同识别。清理继承的 Herdr endpoint 环境，使用明确 session/endpoint。人工进入时打印同一私有环境对应的 Herdr attach 命令。

| 需要的 API | 用途 |
|---|---|
| `workspace.create {cwd,label,env}` | 使用已准备 worktree，创建任务终端；label 绑定 execution 身份。 |
| `agent.start {kind,pane_id,args}` | 在已就绪 shell pane 中启动 copilot/codex。 |
| `agent.prompt`、`agent.get` / `agent.wait` | 提交输入并观察最新状态和 native session 引用。 |
| `pane.process_info`、`pane.close`、`server.stop` | 观察并停止本 task 或专用服务，核实运行资源已结束。 |
| `session.snapshot` | 识别重启后的已有 workspace/pane，避免重复创建。 |

API 是本地换行分隔 JSON；Unix 使用 domain socket，Windows 使用 named pipe。启动前校验 API 和 client 两个实际端点的字节长度/平台约束，路径过长要求缩短 stateDirectory，不静默切换目录。

Worker 同一时刻只向一个 task 的同一已就绪 agent 提交一轮输入。超时/断连不证明输入未送达，先观察已有执行和 task 资料；不得盲目重发工作。Herdr idle/done 只表示执行观察，blocked 展示人工入口，unknown/不可达先核对并按恢复策略处理。

Prompt 加载随包 using-daynight，传入明确 project/task/claim、worktree/branch/session 与冻结配置。Worker 控制领取、资源和下一任务选择；agent 验证给定上下文后复用已开始执行，不重认领或重建工作区，完整交付和验收后最后显式 claim-bound done。Agent 维护既有 PR/证据，不输出新报告协议，等待时仍保留原任务。

## Agent 完成与人工操作

业务完成由 agent 按任务及仓库规则验证和记录。它满足全部必要交付、人验和授权条件后，最终重读原 task/claim/version，通过公开 CLI 显式 --claim-id 的 done 提交当前执行完成；未满足时在原任务/会话等待，不选下一任务或删除系统工作区。普通手工任务仍沿用原 setter。

Worker 不再核对 PR 合并、解析业务验收或再次 done。它仅按原 claimId 是否还在成功完整自有清单中决定资源收尾；缺席不分类 task 状态，部分/失败清单不用于删除。原生托管验证、完整验收和证据由 agent 负责，不增加报告或验收解释器。

服务端和 typed client 已提供受控 claim 管理；运行时计划提供以下人工命令和资源准备流程：

- `worker run`：启动并恢复、观察、调度和显示。
- `worker retry <task-id>`：只为已暂停的本地执行授权一次额外恢复，不清空计数，不换会话、不释放 claim；请求落 SQLite，前台实例消费。
- `task release <task-id> --claim-id <id> --stopped-confirmed`：显式释放已停止的 worker claim，沿用 `--project` 与 `--if-version` 语义。
- `worker transfer <task-id> --source-state <sqlite-snapshot> --stopped-confirmed --continuity-confirmed`：接收方准备原资料与目标身份，source-state 是可只读打开的一致 SQLite 快照；提交移交须使用原 owner/admin 的授权，接收者身份本身不授予提交权限。跨机器资料准备由人工完成。
- Release/transfer 复用服务端权限和事务。接收方先准备原 worktree/native history，并将选定执行记录从原 SQLite 只读导入本地；保留 worktreeId/冻结配置，不复制 worker_state。操作记录 pending transfer 后调用服务端，再核对新归属完成导入。字段/路径缺失时拒绝而非重做。

Transfer 后，目标 worker 从已导入 execution 取得已知 taskId，直接读取该任务详情，确认新 claim、目标归属与工作区绑定后继续原执行。这是显式移交后的恢复，不是绕过 ready 的新自动 claim。原用户或项目管理员仍需持有现有项目权限，普通成员不能借此更换他人归属。

## 退出、恢复与清理

| 情况 | 恢复动作 |
|---|---|
| Worker 死亡、Herdr 存活 | 重连专用实例，核对 pane/native session 后继续观察，不重复启动。 |
| Herdr/机器重启 | 按保存关联恢复原会话；需要证明原执行停止且 history 可用。不能取得时暂停。 |
| claim/启动/完成响应丢失 | 按 pending_action 查询服务端、Git 或 Herdr 的实际结果，确认前不重复动作。 |
| 异常/基础设施故障 | 在原 worktree/会话有上限恢复；计数不因重启清零，超限保留名额待人工授权。 |
| Ctrl+C | 停止新领取，停止 agent/专用 Herdr 并等待核实，保存检查点；不明确时保留错误和待恢复状态。 |
| 完成但清理失败 | 保留 completed/cleaning 记录，重启后只重试清理。 |

原生会话恢复优先使用 Herdr 自身保存的引用；若其配置会自动恢复，worker 不能同时手工启动同一 native session。支持版本的无客户端恢复必须通过实测门禁，不能把 client attached 当作无人值守的隐含条件；失败时实现方需在同一 Herdr 公开 API 能力内证明可行方案，再交付该能力。

## 观测、关联和错误

相关性以 server/project/task、executionId、claimId、workerId、Herdr session/pane 和 native session 为主。领取前生成 execution/claim ID 并落库；每个调度并发分支显式携带执行上下文，REST/Herdr/后台等待继承取消信号，错误回到所属执行，不创建无归属的 detached Promise。

前台显示仓库、task、agent/平台、phase、最新 Herdr 状态、等待/暂停原因及原会话入口。使用既有诊断和文件原语写入 worker JSONL 日志，记录 `subsystem`、`phase`、错误类别、原因和可用关联 ID；不记录 token、完整敏感 prompt 或凭据参数。数据库保存最后具体错误，不用空值吞掉错误；日志不参与授权判断。

部署后按一次具体 task 过滤 `taskId` 与 `claimId`，核对 claim→pane→核验→完成/清理日志及 SQLite 当前记录；示意：`jq 'select(.taskId == "<task-id>" and .claimId == "<claim-id>")' <worker-log.jsonl>`。日志结构须保留这些可查询字段。

## 验证与当前证据

Linux 本地 Herdr 0.8.2 的隔离无原生 agent 冒烟已验证：原始 JSON API、headless workspace 创建、人工模拟 working/idle、普通 shell/子进程关闭和 shell 工作区重启恢复。发现 134 字节 client socket 路径启动失败，缩短后 API/client 路径分别 100/107 字节成功。这些是该平台和版本的观察，107 不是三平台通用限制。

它没有运行 Copilot/Codex、没有验证原生检测、native history 恢复、原生 agent 脱离子进程或 macOS/Windows。运行时交付必须通过下面的独立门禁。

| 门禁 | 必须证明 |
|---|---|
| 服务端与迁移 | 许可默认/双向确认/取消/核对、平台清除/分页、属性写保护、同版本单赢家、旧 claim、权限、release/transfer 及手工路径。 |
| 本地状态与 Git | WAL/事务、动作结果不确定、稳定 worktree、所有权核对、冻结配置、恢复计数、结束记录和清理。 |
| Herdr 原生 | 支持基线、两 agent、三平台 API/输入/blocked、停止、无客户端 native restore 及真实历史保留。 |
| 端到端 | 安装 CLI、两 worker 竞争、多仓库轮转、PR/CI/review/合并/验收、人工介入/移交、各崩溃窗口与重启。 |

不得以模拟 lifecycle 或文档说明替代原生证据。实现通过适用 CLI/Go/Web 门禁，保留严格覆盖率、原生平台和实际服务证据。

## 模型入口大小

Agent 的模型入口使用随包 `using-daynight` 与既有 task CLI；Worker 自己的任务操作直接调用进程内 typed ApiClient。启动上下文传 task/claim/session/worktree 标识及技能路径，不复制完整 Goal 或全部交互资源。初始设计对三个代表性输入的测量中，简介为 1708～3067 个 UTF-8 字节，主 Markdown 为 7588～15259 个字节；这些是当时输入的测量范围，后续资料修改不受该大小约束。

已知任务先读取完整详情，再按正文入口读取实际必需资料、UI 和证据；正文完整时不强制读取主附件。共享内容规则由随包 `references/task-content.md` 拥有，调用次数取决于真实引用与阶段输入，不能假定固定为三次。保留完整要求，不截断来制造固定 token 上限；具体 token 随 agent/model、仓库指示变化，原生验收记录实际模型使用量。未增加 report tool、模型 RPC 或通用 MCP 服务。

## 选择与范围

| 真正比较过的方案 | 选择理由 |
|---|---|
| Agent 交付/验收并最终 done，worker 管资源/对账 | 保留任务现有流程，明确单一生命周期所有者。 |
| Worker 编排完整 PR/CI/review 引擎 | 需要重复每个仓库开发流程和非代码任务规则，未采用。 |
| report CLI/SQLite inbox 或结果文件 | 需要新消息、去重和恢复协议；现有状态与 task 资料足以承载观察，未采用。 |
| 共用 review coordinator/store | PR revision/发布与长任务的名额和恢复语义不同，采用窄基础原语复用。 |

包含自动执行许可/平台、唯一归属、前台执行、原生 agent、恢复、人工管理与完整验收。通用插件引擎、报告系统、自动跨机器文件搬运、基于失联超时抢占及通用自然语言验收引擎不在交付内。相应情况保留明确错误/暂停及人工入口；唯一归属、状态隔离、原成果连续性和错误传播是本次必须成立的保证，不作为后续补丁。
