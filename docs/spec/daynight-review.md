# Daynight review 需求

状态：产品范围已确认。已实现范围和可用命令见[仓库 README](../../README.md)。

`review` 是 `daynight` 客户端命令工具包中的 GitHub PR 审查模块。它监控配置的仓库，
在符合条件的 PR 需要审查时启动 review agent，维护仓库副本、worktree、会话和持久化
调度状态。agent 审查代码并自行将结果发布到 GitHub。本文中的 daemon 指
`daynight review run` 承担的前台持续运行角色。

本文档负责 review 的必需行为和验收场景，使用 R1–R16 作为 review 需求标识。
[客户端需求](daynight.md)定义安装、命令组合、依赖隔离、自更新和 shell 补全；
[review 设计](../design/daynight-review.md)解释满足这些需求的机制。

## 需求

### R1. 命令与运行方式

`daynight review`、`daynight review --help` 和 `daynight review -h` 显示 review 帮助，
不启动监控。`review run`、`review list`、`review ls` 和 `review add-repo` 分别提供
前台审查、本地状态查询和仓库配置登记；各操作在唯一参数为 `--help` 或 `-h` 时
显示对应帮助。
工具在 Linux、macOS 和 Windows 上通过 `daynight review run` 以单个前台 CLI 启动，
并持续运行直到被停止。CLI 负责轮询、维护 SQLite 状态、管理 worktree，并直接将
Copilot 作为子进程启动。
三个平台必须支持相同的仓库、监控、会话、worktree、完成判定和恢复行为。必须在每个
平台上验证子进程调用、输出处理和正常退出。review agent 按前台程序契约执行，
返回前必须结束自己启动的工具和服务；异常退出后不能仅凭保存的 PID 推断旧执行已停止。

### R2. 仓库配置

配置文件固定为 `~/.daynight/config.yml`，使用 YAML，通过远程地址和本地仓库路径
指定每个需要监控的 GitHub 仓库。所有 review 专属配置归属 `review` mapping：
`repositoryRoot`、`repositories`、`pollIntervalMs`、`maxConcurrentWorker`、`agentTimeoutMs`、
`maxAttempts`、`retryDelayMs`、`copilotModel` 和 `copilotReasoningEffort`。
旧顶层 review 字段须整体移入 `review` 并删除原条目；旧结构明确报错，不自动迁移。
`~` 表示当前操作系统用户的主目录，路径由程序解析；
从不同工作目录启动都读取同一份配置。手写的仓库路径为相对路径时，相对于配置文件
所在目录解析；每个仓库必须具有 `path`。并发审查 Worker 数量的配置项名为
`maxConcurrentWorker`。每个配置的仓库分别维护自己的初始化状态和 PR 状态。

`review` 中的可选字段 `copilotModel` 和 `copilotReasoningEffort` 分别为本次进程的全部审查
仓库指定 Copilot 模型与推理强度。两者相互独立，均可省略，也可只配置任意一项或
同时配置；省略的字段不传对应参数，保留 Copilot 自身的选择。配置在启动时固定，
修改后下次启动生效。每个显式值必须是含非空白内容且不含 NUL 的字符串；null、
其他类型、空串和纯空白须报错，合法字符串原样保留。模型名称、强度等级及两者
兼容性由 Copilot 判断，不使用静态枚举；`auto` 可用于交由 Copilot 选择模型。
交互引导及仓库登记保留这两个字段和注释；server 投影识别 `review` 节点，但不校验其
内部值。

同一文件可包含已登记的其他客户端字段，例如 `serverUrl`；review 只校验自己的
字段值。缺失或无效 server 地址不阻塞 review，YAML 语法、重复键、未知顶层字段和
未知 `review` 字段仍须报错。`review` 显式为 null、数组或标量也须报错。
运行和列表需要已登记 review 仓库；缺少文件、`review` 或 `review.repositories` 时，
按[客户端 C6](daynight.md#c6-按需配置引导)在 TTY 中引导登记，保存后继续原命令，
无需设置服务地址。空列表和其他无效 review 值仍须报错。非交互环境缺配置时给出
`daynight review add-repo <remote>` 指引。添加命令和交互引导可向仅含 server
或 worker 配置的文件登记首个仓库，保留已有字段、注释及原有 review 字段语义。

`daynight review add-repo <remote> [--path <path>]` 负责读取、校验和保存配置。配置不存在时
自动创建；已有配置中的其他设置和 YAML 注释须保留。命令不执行 clone、认证检查、
GitHub 查询、SQLite 初始化或 PR 初始化。运行中的 daemon 在下次启动时读取新配置；
添加成功只表示配置已保存。交互首次引导复用同一登记和路径规则；引导只保存配置，后续的原 `review run`
才启动正常审查生命周期。

`review.repositoryRoot` 默认是 `~/daynights`，仅在添加仓库且省略 `--path` 时用于决定
路径。命令按规范化的 host/owner/name 生成路径，并将结果作为绝对路径写入该仓库的
`path`。显式 `--path` 相对于命令的当前工作目录解析，同样保存为绝对路径。
修改 `repositoryRoot` 不改变任何已有仓库的路径；运行时只使用每个仓库的 `path`。

重复添加同一规范化仓库时，省略 `--path` 就复用已保存的路径，不受根目录变更影响；
显式指定同一实际路径同样成功且不修改配置，显式指定不同路径则报错。必须校验完整
结果并防止并发添加覆盖另一项修改。校验或替换前的写入失败须保留已有配置；替换后的
清理错误仍须明确可见。

### R3. 本地仓库与认证

启动时，daemon 确保每个配置的仓库都已 clone 到指定的本地路径。仓库缺失时，daemon
负责 clone。本地克隆和 review worktree 是本系统专用的审查环境，不承担人工开发或
其他工具的用途。GitHub CLI 认证由运行环境在 daemon 启动前准备好。

### R4. 永久初始化边界

每个仓库首次初始化时，daemon 将已有 PR 的最大编号记录为该仓库的 `Start PR No`。
这个边界涵盖所有状态的已有 PR，包括 Draft、Open、Closed 和 Merged。

编号小于或等于 `Start PR No` 的 PR 永久排除在审查范围之外。后续提交、ready 状态
变化、目标分支变化或重新打开，都不会使这些 PR 获得审查资格。边界只持久化一次，
daemon 重启后复用原值；重启不会建立新边界。

### R5. 轮询与审查资格

daemon 按间隔持续轮询配置的仓库。只有同时满足以下条件的 PR 才能被审查：

- 编号大于所属仓库的 `Start PR No`。
- 状态为 Open。
- 不是 Draft，即已 ready for review。
- 当前 PR 提交的 CI 已全部结束并通过；没有任何 CI 检查时允许直接审查。
- 没有未解决的原生 review conversation。所有作者的 `PullRequestReviewThread` 都纳入
  判断；`isOutdated` 不等于已解决，行级和文件级 thread 同样适用。已证明所属 review
  仍为 `PENDING` 的未发布草稿 thread 不属于已提交 conversation，不要求作者 resolve
  不可见的草稿；无法确认归属或发布状态时不能推断已解决。

通过状态包括 `success`、`skipped` 和 `neutral`。正在等待、运行、失败、取消、超时或
需要人工批准的 CI 都不得放行；已登记但尚未创建 jobs 的 workflow 同样需要等待。
同时检查 head 和可用的测试合并提交，覆盖 check runs 与旧式 commit statuses。
API 查询失败或结果不完整不能视为没有 CI 或没有未解决的 conversation。
conversation 必须完整分页；普通 PR issue comment 和 review 正文没有 resolution 状态，
不能替代可 resolve 的 review thread。

daemon 会跟踪 Draft PR，使其转为 ready 后能够获得审查资格。PR 处于 Draft 或关闭
状态时，不得启动审查。等待 CI 不得消耗审查 Worker、尝试次数，也不应创建审查记录、
会话或 worktree。CI 转为通过后，自动继续原先待处理的审查，无需新增提交。

每次启动模型，包括同一轮的确认和重试，都重新确认当前目标与 CI。新一轮还须确认
conversation 状态。准备 worktree 期间资格不满足时，保留既有会话及尝试预算并继续
等待。只有远端证据证明同一捕获轮次已发布 `APPROVED` 或带自身 thread 的
`COMMENTED`，或存在可由同一发布者继续的有效匹配 `PENDING` 草稿，才允许绕过
conversation gate 进行对账；已有失败尝试不能单独构成例外。
已完成修订的 CI 后续变化不单独触发再次审查；已启动审查不因之后新登记或重跑 CI
而自动取消。

### R6. 审查轮次与触发条件

对于编号超过边界的 PR，以下事件产生待审轮次：首次发现 ready PR、head SHA 变化、
Draft 转 ready、目标分支名变化，以及上一轮 `COMMENT` 反馈全部解决。head 和目标分支
仍用于确定审查目标及对应 CI；反馈解决后不要求新增 commit，也不要求修改 description。

新一轮只有在 R5 资格满足、当前目标尚未获得 Daynight approval，且没有正在执行或
不确定的审查操作时才能启动。每一轮成功的 `COMMENT` 都保存远端 review 和实际 thread
身份，只能消费一次反馈解决信号；不依赖先观察到未解决数量再观察到零。作者在 agent
结束前就 resolve 反馈也必须能够唤醒下一轮。若已有新 head 或目标分支的待审轮次，
反馈解决事件与该轮次合并，针对最新目标执行一次。

仅目标分支新增提交或仅 PR 标题、description 变化不触发审查。当前目标已经获得
Daynight approval 时保持完成，修改 description 不撤销或 dismiss approval。新 head
或目标分支变化仍需审查。复用先前 approval 来结束新的待审轮次时，必须通过新鲜
远端快照确认所保存的 review ID 仍为 `APPROVED`，发布者、捕获 head 和稳定审查身份
均匹配；历史上已 dismissed 的批准不能抑制这轮审查。PR 处于 Draft 时保存变化，
转为 ready 后再按资格执行。

### R7. 单个 PR 的执行顺序

同一 PR 在任一时刻最多运行一个由 daemon 管理的主 review agent 会话。主 agent
按 R10 委派的审查 subagents 属于同一次 attempt，共享固定目标、worktree、超时和
尝试预算，不构成另一轮 daemon 审查。正在审查时观察到的、需要审查的新变化，必须
保持待处理状态，留待后续审查。待处理变化可以合并，使后续审查针对最新且符合审查
资格的状态进行。

### R8. 持久化 agent 会话

daemon 调用 Copilot CLI 作为本地 review agent。每个被审查的 PR 对应一个持久化的
CLI 会话。该 PR 的每次后续审查，以及每次确认或重试，都必须恢复同一个会话，以保持
审查上下文连续。会话标识在 daemon 重启后保留。

每次正式审查都把已配置的 `copilotModel` 作为 `--model` 与原始值两个独立 argv
参数传入，把已配置的 `copilotReasoningEffort` 作为 `--reasoning-effort` 与原始值
两个独立 argv 参数传入；新会话、恢复、重试及后续修订使用同一规则。skill 发现
不添加这两个覆盖参数，子进程继续使用 `shell: false`。型号或强度不支持、不可用
或组合不兼容时，由 Copilot 的既有失败结果和审查错误流程暴露，不改写会话或任务
状态协议。

### R9. Worktree 管理职责与生命周期

每个被审查的 PR 使用独立的 Git worktree，放在所属仓库根目录的 `.worktrees/` 下。
daemon 在首次审查时创建 worktree，并在该 PR 的后续审查中复用。daemon 负责这些
worktree 的创建、准备、更新和清理；review agent 不负责 worktree 管理。

PR 合并或未合并就被关闭时，daemon 清理其 worktree。deprecated PR 指未合并就被
关闭的 PR。worktree 内的文件、嵌套仓库及其所属管理数据均为可丢弃的审查内容；
新修订准备和关闭清理可以清除这些内容，同一目标的确认或重试保留已有上下文。

### R10. 审查判断与结果发布

主 agent 负责完整审查和结果汇总，并直接将结果发布到 GitHub。每次新审查都必须先
检查固定 merge-base 到 head 的完整 diff，再根据实际修改、相关约束和风险选择至少
两个互补角度，实际委派独立 subagents 审查，宜并行执行。角度必须说明与该 PR 的
关系，不要求每个 PR 使用相同领域清单；纯文档 PR 也适用。主 agent 继续对完整 diff
和两项 PR 质量门槛负责。

每个 subagent 都必须获得确切的 PR 身份、head SHA、目标分支、捕获的 base SHA、
merge-base SHA、diff 范围、交付目标、适用仓库指示、相关需求、指定角度和证据标准，
以及共享 worktree、临时文件归属、前台进程、超时与清理规则。审查职责只读，不修改
源码或 Git 状态；有边界的 probe 只写获准临时目录。subagent 只能向主 agent 返回
覆盖范围、候选问题的引入证据及位置、修复/延后/不成立建议、验证限制及执行失败，
不得管理 worktree、修改 GitHub review 或 thread、独立发布或输出完成标记。

主 agent 必须等待所有必要角度完成，独立验证候选问题、处理分歧并按根因去重，区分
修复、延后及不成立。在本次 attempt 输出中汇总所选角度及其依据、已完成覆盖、验证
限制、候选处置和确认的阻断问题；GitHub 评论只保留简洁的可操作 findings。工具不可用、
subagent 失败或必要覆盖未完成属于执行失败，可在当前预算内重试或重新委派；无法完成
时不得发布 review 或完成标记，不得伪装为质量 finding。核对已有合法匹配的已提交
结果时直接确认，无须重新委派。仅主 agent 可以发布最终 GitHub review 和完成标记。
仍需发布的 pending 草稿不属于已提交结果，提交前必须完成新审查的委派与汇总。

批准必须同时满足以下条件：

- PR description 清楚说明要解决的一个具体问题、预期结果和修改范围。PR 只能有一个
  交付目标，不能把独立目标打包为超级 PR；同一宽泛主题不能取代明确的问题。范围应当
  支持有效审查，按独立目标及其依赖关系拆分，不以固定行数或文件数判断。
- 完整 diff 中的每项修改都属于原定范围。agent 读取当前标题、description 及其链接的
  相关需求来确定边界，并检查所有捕获的差异。实现同一结果所必需的结构调整、测试和
  文档同步属于范围；独立能力、无关修复和顺手清理必须移出。事后扩大 description
  不能单独证明无关修改属于原定范围。
- 没有需要处理的 Critical 或 Major 代码问题。

前两项是独立于代码缺陷严重程度的 PR 质量门槛。任一门槛不满足时，agent 必须拒绝
批准，即使没有发现 Critical 或 Major 代码问题。成功完成的审查必须二选一：提交
`APPROVE`，或提交 `COMMENT` 并包含至少一条实际可 resolve 的 review thread；不提交
`REQUEST_CHANGES`。越界修改和 Critical/Major 代码问题在适合的相关 diff 行发布
inline comments。description 或无适合代码行的 PR 级问题，锚定到主要修改文件的
文件级 conversation，并明确标注它是 PR 级问题及需要修正的内容。review 正文或普通
PR comment 不能单独满足阻断发布要求。没有真实问题时不得为满足协议伪造 finding；
执行或发布失败沿用 R12 的有限重试。仅当三项批准条件全部满足时，才能 `APPROVE`。

新发布前，agent 重新读取当前 PR 标题和 description，结合相关需求重新判断质量
门槛，并按固定审查目标重新确认发布资格。同一轮恢复先核对既有结果；匹配捕获目标
的 Daynight approval 不因 description 变化而重新评判或撤销。resolve 只表示作者提交了
反馈处理信号，不代表问题已修复，下一轮 agent 必须重新验证。daemon 不代替 agent
判断门槛或发布结果，也不解析 JSONL 或结构化 findings 来决定发布内容；它通过 GitHub
远端证据核对结果类型、审查身份、提交、发布者和实际 conversation。

### R11. 文本完成协议

agent 完成审查及所需的 GitHub 发布操作后，标准输出的最后一个非空行必须严格为：

```text
PR <number> Review Completed
```

`<number>` 是当前审查的 PR 的十进制编号，例如 `PR 123 Review Completed`。这一行
必须独立存在，不附带其他格式。daemon 在 agent 进程结束后检查此行，并核对 R10 的远端发布证据。标记本身不能证明
approval 或可 resolve 反馈已经存在。其他 PR 的标记、
不完整的标记，或者标记之后还有其他非空行，都不满足协议。agent 只能在所需的 GitHub
操作成功后输出标记。

### R12. 确认与重试

agent 结束时如果缺少所需的完成标记，daemon 恢复同一个会话，请求确认或重试。
恢复的 agent 优先核对同一轮已经存在的 GitHub 发布，避免重复发布。已有匹配捕获目标的 approval
保持有效，description 编辑不能要求撤销；匹配的 `COMMENT` 必须有实际 review thread。
绕过 conversation gate 必须有该捕获轮次的真实提交结果，或同一固定发布者可继续
的有效匹配草稿。没有发布的失败重试仍须等待其他未解决 conversation，且等待不
消费尝试。固定发布者为 A 而当前读取账户为 B 时，B 可核对 A 的真实已提交结果；
没有结果或只有 pending 草稿时等待恢复 A，不能以 B 发布或消费模型尝试。

完成标记已接受后，daemon 持久化待核对状态，再以只读方式取得完整远端证据。核对
失败、限流或响应不完整时保存错误并重试核对，重启后继续，不重新调用模型，也不消费
agent 尝试预算。完整查询成功但没有合法匹配结果属于协议失败，回到原有限模型重试，
耗尽时明确失败；它与网络或不完整查询的只读重试分别处理。远端结果必须与稳定
Daynight 审查身份、捕获 commit 和启动前固定的发布者
相符；只有核对成功后才能原子记录完成及 approval 或下一轮反馈屏障。GitHub 发布与
SQLite 更新仍不是同一个原子操作。

执行、模型或发布失败使用有限尝试和退避；耗尽后明确记录失败。不能把缺少权限、
工具失败或无法判断问题伪装成可 resolve 的质量 finding。

### R13. 持久化状态与重启

既有 YAML、状态路径和身份继续使用，不增加命令分区或另一份数据库。运行时通过
显式数据库迁移保存审查结果、远端发布身份与反馈轮次；版本 1 数据必须保留既有永久
边界、修订、尝试预算、会话、进程证据、日志和 worktree 归属。迁移明确区分旧发布
身份格式：已完成旧记录进入远端结果对账；未完成活跃记录保留旧格式和未知发布者，
不能以当前账户伪造历史身份。恢复先按旧审查 token 和捕获 head 查找真实发布者，
找到后固定该 actor。匹配的 approval 保持完成；没有有效 approval 的当前已完成旧
记录可消费一次采用轮次。旧格式识别只适用于明确迁移的记录，新轮次及所有新发布
均使用严格的独立行或 HTML 注释身份。只读列表接受版本 1 和 2，不得执行迁移。

SQLite 数据库位于 `~/.daynight/state.sqlite`。数据库、会话文件、实例锁、日志、缓存
和临时文件统一保存在 `~/.daynight/`。PR worktree 按 R9 放在所属仓库根目录的
`.worktrees/` 下，仓库克隆位置由配置中的本地路径指定。SQLite 保存恢复仓库监控和
审查执行所需的持久化状态，包括仓库初始化边界、已观察到的 PR 状态、目标分支和
head SHA、已审查版本、CLI 会话标识、worktree 标识、执行状态、确认或重试状态，
以及已核对的远端 review/thread 身份和已消费的反馈轮次。

重启后，daemon 根据这些状态恢复待处理或被中断的工作，同时保留 R4 规定的永久排除
规则和 R8 规定的单个 PR 会话连续性。不得仅因 daemon 已经重启，就将被中断的尝试视为
完成。

同一状态目录只允许一个 daemon 实例运行。daemon 启动时已有 `instance.lock`，必须检查其记录的
CLI 进程是否仍存活。仅在确认该进程不存在时自动接管失效锁；进程仍存活、访问被拒绝、
锁元数据无效或无法判定时，保留锁并明确报错。文件年龄不能证明进程已经结束。

自动接管锁只确认旧 CLI 已停止，不能证明其 agent 或工具已停止。存在被中断的审查或
待清理资源时，必须保留相关会话和 worktree，阻止这些资源的恢复执行、复用及清理，
报告所需的人工确认。PR 重新打开不能清除未解决的清理状态及其错误；只有清理操作已
确切停止并排除相关 agent、工具后，才能解除该状态。被中断的审查及未确定的待清理
资源仅阻塞对应 PR 的执行、复用及清理；仓库继续轮询，同一仓库中的其他 PR 和其他
仓库仍可正常处理。只有明确排除旧 CLI 及其全部 agent、工具后，
才能恢复这些工作。没有未确定工作的异常退出必须能够直接重新启动，
不要求人工删除失效锁。

### R14. 审查版本归属

每次审查尝试及其完成状态，都关联到该次尝试被要求审查的 PR 版本。完成针对某个 head
SHA 的尝试，不能满足另一个 head SHA 的待处理审查。同样，完成一次尝试也不会清除
后续 ready 状态转换、目标分支变化或反馈解决产生的待处理触发事件。同一 head
可以具有多轮审查；每轮评论反馈只产生一次可合并的后续轮次。

### R15. 本地审查状态列表

`daynight review list` 与 `daynight review ls` 是等价命令，按当前配置的顺序分组打印
仓库，并按 PR 编号排序，列出本地最近完整观测中仍为 Open 的已跟踪 PR，包括 Draft。
PR 已完成审查或审查最终失败，只要仍被观测为 Open，就继续显示；已关闭 PR 和已从
当前配置移除的仓库不显示。

每个仓库显示最近成功完整轮询的 `Last observed` 时间和已保存的轮询错误。初始化
完成但没有已跟踪的 Open PR 时显示 `No tracked ongoing PRs.`；数据库不存在、仓库
尚未登记或尚未完成初始化时显示 `Not initialized.`。跟踪范围遵循 R4 的永久边界，
不能声称列出所有 GitHub Open PR。输出代表本地保存的快照，不保证反映此后的远程
变化或当前 daemon、agent 的存活状态。

表格包含 `PR`、`PR STATE`、`REVIEW` 和 `ATTEMPTS`。审查状态覆盖 `Preparing`、
`Running`、`Pending`、`Retry waiting`、`Completed`、`Failed`、`Interrupted`，
Draft 显示 `Paused`。下次重试时间和已保存错误归属到对应审查记录。PR 的最新待审
修订、head 和目标分支与旧审查独立：旧版本仍活跃时，最新版本显示待处理，并另行显示
旧版本的状态、尝试预算、重试时间和错误。不得把旧版本的尝试次数、失败或完成状态
归到新版本；仅目标分支的 base SHA 变化不会使完成状态失效。

待清理资源与审查状态分别显示，包括 PR 重新打开后仍保留的清理屏障。详情显示
`Worktree cleanup: Pending` 和已保存的清理错误；没有当前审查的非 Draft PR 显示
`Pending (cleanup blocked)`，Draft 仍显示 `Paused`。旧活跃审查继续单独列出，
命令不解除屏障或执行清理。

完成必要的配置引导后，命令读取当前配置和 SQLite 的一致快照，可与运行中的 daemon
并行执行。列表操作本身不启动
监控、不执行 Git 或网络调用、不获取 review 实例锁、不创建缺失的数据库、不迁移
表结构、不恢复审查，也不修改应用状态。读取已有 WAL 数据库时，SQLite 自身可能
创建或更新协调使用的伴随文件。配置引导按 C6 处理缺少文件或仓库字段；配置无效、
已有数据库无法读取或损坏、表结构版本不受支持时，必须显示错误并以非零状态退出。

### R16. 随客户端发布的审查 skill

客户端安装包必须包含 `daynight-review` skill，定义审查方法、证据标准和问题范围，
包括 R10 的按 PR 内容选择多个互补角度、独立委派及主 agent 汇总要求。
daemon 启动时固定本次运行使用的完整 skill 内容；运行中的客户端更新不能改变
后续尝试采用的内容。每次启动 review agent，包括同会话的后续审查、确认和重试，
都必须确认 Copilot 选择了该内容对应的已启用 skill，并显式要求加载它。

资源缺失或无效时，daemon 明确启动失败。skill 不可发现、被其他同名 skill 覆盖、
被禁用或发现结果无效时，该次尝试明确失败并使用现有的重试预算和超时限制，不能
继续不带此 skill 的审查。发现与正式审查之间也必须维持单个 PR 的顺序、取消和
进程排除保证。skill 发现本身不改变配置、状态位置或 PR 会话身份；审查轮次的持久化升级遵循 R13。

skill 的方法不能取代本次审查目标、发布资格、远端结果对账或完成协议；只有正式
审查满足 R10–R12 才能记录完成。Copilot 发现成功不表示已经审查或发布。

## 验收场景

| 场景 | 必需结果 | 对应需求 |
|---|---|---|
| 无配置、无数据库和外部工具时执行 review 组或操作帮助。 | 帮助成功，既不解析用户主目录，也不加载配置、SQLite 或审查运行时。 | R1 |
| 使用重构前格式的 YAML 和独立构造的版本 1 SQLite fixture。 | 列表只读原位置和原有记录；运行显式迁移，保留永久边界、修订、会话、预算、进程证据、清理屏障及 worktree 身份，并记录完成与未完成轮次的旧身份来源。 | R2, R4, R8, R13, R14 |
| 版本 1 未完成轮次已用带前缀的旧审查 token 发布 APPROVED 或带实际 thread 的 COMMENT，但丢失完成标记。 | 仅该迁移轮次按旧 token、捕获 head 和实际历史 actor 恢复对账；保留预算与会话，不重复发布或改用当前读取账户。 | R12, R13 |
| 新建轮次或迁移轮次需要新发布。 | 新发布身份严格使用独立行或 HTML 注释；旧格式读取资格不能放宽其他新轮次的匹配规则。 | R10, R13 |
| 在 Linux、macOS 或 Windows 上执行 `daynight review run`。 | 前台 CLI 通过直接启动 Copilot 子进程支持所需工作流程，并已验证命令执行、输出处理和正常退出。 | R1 |
| 从不同工作目录执行启动命令。 | 读取同一份 `~/.daynight/config.yml` YAML 配置，使用 `~/.daynight/` 中的同一份运行状态；仓库相对路径按配置目录解析。 | R1, R2, R13 |
| 首次在 TTY 执行 `review run`、`review list` 或 `review ls`，缺少文件或仓库字段。 | 仅引导仓库登记，保存后继续原操作；无 server 地址也可使用 review。 | R2, R15 |
| 非交互环境缺少 review 仓库，或已配置空列表、无效字段及损坏 YAML。 | 缺配置给出 `review add-repo` 命令；无效已有配置明确失败，不覆盖配置或启动运行时。 | R2 |
| 配置不存在时执行 `daynight review add-repo <remote>`。 | 自动创建 YAML，使用默认 `~/daynights` 根目录和规范化仓库身份生成绝对 `path`；只保存配置。 | R2 |
| 添加仓库后修改 `repositoryRoot`，再添加另一个仓库。 | 只有后添加仓库使用新的根目录；原条目的 `path` 保持原值。 | R2 |
| 从任意目录执行带相对 `--path` 的添加命令。 | 按命令当前目录解析并保存绝对路径，保留已有配置设置与注释。 | R2 |
| 重复添加同一仓库，或两个添加命令并发执行。 | 同仓库省略路径时复用已保存路径，显式同实际路径保持幂等，显式不同路径报错；并发写入不会丢失另一项修改，锁冲突明确失败。 | R2 |
| daemon 运行时添加仓库。 | 当前进程保留已有配置，下次启动后按正常启动流程克隆并初始化新增仓库。 | R2, R3, R4 |
| 两个模型选项均省略、仅配置 `copilotModel`、仅配置 `copilotReasoningEffort` 或同时配置，包括在运行中修改配置。 | 正式 argv 只包含已配置字段对应的独立 flag/value，不为省略项增加覆盖；本次进程使用启动原值，下次启动才读取修改。交互引导和仓库登记保留字段及注释。 | R2, R8 |
| `copilotModel` 或 `copilotReasoningEffort` 为 null、其他类型、空串、纯空白或含 NUL 的字符串。 | review 配置明确失败且不被引导覆盖；server 命令仅校验自己的配置值，未知顶层字段仍须报错。 | R2 |
| 执行 `daynight review list` 或 `daynight review ls`。 | 两者输出相同的本地一致快照，按配置仓库顺序及 PR 编号排列，包含 Draft 与仍然 Open 的已完成或失败审查。 | R15 |
| 已初始化仓库没有已跟踪的 Open PR，或仓库尚未初始化。 | 分别显示 `No tracked ongoing PRs.` 或 `Not initialized.`。 | R4, R15 |
| 较新 head 的待审修订等待旧版本审查结束。 | 最新版本显示待处理，旧版本的保存状态、尝试预算、重试时间及错误单独显示；仅 base tip 变化仍保留已完成状态。 | R6, R14, R15 |
| PR 重新打开且保留未解决的清理屏障时读取列表。 | 显示待清理状态及保存的错误；没有当前审查时显示 `Pending (cleanup blocked)`，Draft 仍暂停，并保留旧活跃审查的独立详情。 | R13, R15 |
| daemon 运行中或异常退出后读取列表。 | 不获取实例锁、不启动恢复、不执行 Git 或网络请求；`Running` 仅表示保存的状态，成功轮询时间和已保存错误显示数据时效。 | R13, R15 |
| 数据库不存在，或已有数据库损坏、为空文件或使用不支持的表结构版本。 | 缺失时只显示未初始化且不创建状态；已有无效数据库明确失败，不迁移或修复。 | R15 |
| 启动时，配置的本地仓库不存在。 | daemon 在使用该仓库进行审查前，将其 clone 到配置的路径。 | R2, R3 |
| 仓库初始化时发现已有 PR 的最大编号为 100，其中包括已关闭和 Draft PR。 | 保存的边界为 100。编号不超过 100 的 PR 永远不会被审查，包括后续发生变化的情况。 | R4 |
| daemon 在边界记录后重启。 | 复用已有边界，不会通过重新初始化将较新的 PR 排除。 | R4, R13 |
| 边界为 100，PR 101 出现时为 Open 且 ready。 | daemon 安排其首次审查。 | R5, R6 |
| PR 的 CI 尚未结束、失败或等待批准。 | 不启动 agent，不占审查 Worker 或尝试预算；已登记但没有 jobs 的 workflow 也阻塞。 | R5 |
| 同一提交的 CI 后来通过，或该 PR 没有 CI。 | 自动开始待处理审查；`skipped` 和 `neutral` 也视为通过。 | R5 |
| 等待期间 PR 更新 head，或启动前 CI 退回未通过。 | 旧目标的通过结果不用于新目标；保留会话与预算，重新等待当前 CI。 | R5, R8, R14 |
| CI 查询失败、响应不完整或被限流。 | 保持等待并报告错误，不能当作没有 CI。 | R5 |
| PR 101 出现时为 Draft，之后收到新提交。 | 跟踪该 PR，但不启动审查；转为 ready 时需要审查。 | R5, R6 |
| 符合审查资格的 PR 出现新的 head SHA，或被 force push。 | 新版本需要审查。 | R6, R14 |
| 符合审查资格的 PR 修改目标分支。 | 目标分支变化需要审查。 | R6 |
| 只有目标分支收到新提交。 | 仅此变化不会安排审查。 | R6 |
| PR 在审查期间收到新提交。 | 同一 PR 不会同时运行第二个 daemon 管理的主 agent 会话；同次 attempt 内的审查 subagents 不另起轮次，最新且符合审查资格的版本保持待处理状态。 | R7, R14 |
| 首次审查符合条件的 PR。 | daemon 在该仓库根目录的 `.worktrees/` 下创建此 PR 的独立 worktree。 | R9 |
| PR 需要再次审查，或需要从未完成的尝试中恢复。 | 只要 PR 仍然 Open，daemon 就恢复已有的 Copilot CLI 会话，并使用已有的 worktree；配置的模型与推理强度继续分别作为独立 argv 传入，skill 发现保持原调用。 | R8, R9, R12 |
| 从实际安装包启动 daemon，随后安装包内容被替换。 | 安装包包含完整 skill；同次 daemon 后续尝试继续使用启动时固定的内容，配置和已有状态格式保持一致。 | R16 |
| 首次审查、同会话重试或更新后的 daemon 恢复已有会话。 | 每次确认已启用的 `daynight-review` 对应本次固定内容，并显式要求加载当前版本；PR 会话 UUID 保持一致。 | R8, R16 |
| skill 缺失、禁用、被同名项目 skill 覆盖，或发现响应无效。 | 资源问题阻止启动；尝试中的发现问题阻止正式审查并按原预算重试，错误及日志可见。 | R12, R16 |
| skill 发现与正式审查之间取消、超时，或发现进程无法确认排除。 | 不启动正式审查；不确定执行保留进程证据和实例锁，不允许资源复用或清理。 | R7, R13, R16 |
| 对符合资格的固定目标执行新审查，包括纯文档 PR。 | 主 agent 检查完整 diff，按内容实际委派至少两个互补角度，向各 subagent 传递固定目标、适用指示、范围、证据和资源规则；全部完成后验证、去重并在 attempt 输出汇总覆盖、限制、处置和确认阻断项，仅由主 agent 发布。 | R7, R10, R16 |
| 必要审查角度的 subagent 工具不可用、执行失败或覆盖不完整。 | 在当前预算内重试或重新委派；仍无法完成则明确执行失败，不发布 review 或完成标记，不把失败伪装成 finding。 | R10, R12, R16 |
| 恢复时存在捕获轮次的合法匹配已提交结果。 | 直接确认既有结果，无须重新委派；保持原发布身份与远端证据要求。 | R10, R12 |
| description 未说明具体问题、预期结果或范围，或 PR 包含独立目标或无法有效审查的组合范围。 | 即使没有 Critical/Major 代码问题，agent 也以明确标注 PR 级问题的文件级 conversation 说明阻断理由，不批准、不提交 `REQUEST_CHANGES`。 | R10 |
| 完整捕获 diff 包含原定范围之外的独立能力、无关修复或清理。 | agent 拒绝批准，在适合的 diff 行评论越界修改；单独扩大 description 不能使其通过。 | R10 |
| 跨模块的实现、必要结构调整、测试与文档共同服务于同一个明确结果。 | agent 依据必要联系判断范围，不因文件数、行数或跨层修改本身拒绝。 | R10 |
| 审查发现 Critical 或 Major 代码问题。 | agent 以 `COMMENT` review 发布相关 inline comments，不批准、不提交 `REQUEST_CHANGES`。 | R10 |
| description 和范围两项质量门槛均通过，且没有 Critical 或 Major 代码问题。 | agent approve 该 PR。 | R10 |
| 审查后、发布前 PR 的 description 改变，head 和目标分支未变。 | agent 重新读取并评估 description 和相关需求，再依据当前门槛结果发布。 | R10 |
| 当前目标已经获得 Daynight approval，之后只修改标题或 description。 | 保持完成，不撤销 approval，也不触发新审查。 | R6 |
| 当前目标的 CI 通过，但任意作者仍有未解决的行级或文件级 conversation。 | 保持待审；outdated 但未 resolved 的 thread 同样阻塞。 | R5, R6 |
| `COMMENT` 的反馈全部 resolve，未新增 commit。 | 合并并消费该轮反馈信号，针对当前目标自动审查一次；resolve 不代表问题已经修复。 | R6, R10, R14 |
| 作者在 agent 结束前就 resolve 该轮全部反馈，或 daemon 随后重启。 | 持久化 review/thread 身份仍能唤醒一次后续轮次，无需先观测 open count。 | R6, R12, R13 |
| conversation 查询失败、分页不完整或数据无效。 | 不能认定没有未解决 conversation，保持 gate 关闭并报告错误。 | R5 |
| 发布成功，且输出的最后一个非空行是 `PR 101 Review Completed`。 | daemon 接受执行完成标记，核对匹配的远端 approval 或实际 conversation 后才记录完成。 | R11, R14 |
| agent 退出时缺少严格匹配的最终标记。 | daemon 不记录协议完成状态，并恢复同一个会话进行确认或重试。 | R11, R12 |
| 进程结束时缺少标记，但发布可能已经成功。 | 核对捕获轮次的真实远端结果或可恢复匹配草稿后才绕过 conversation gate；避免重复发布，必要时恢复同一会话。 | R10, R12 |
| 失败尝试没有发布，且其他 reviewer 的 conversation 未解决。 | 保持等待，不因已有 attempt 而绕过 gate，也不消费额外模型尝试。 | R5, R12 |
| 固定发布者 A 的尝试缺少 marker，当前读取账户变为 B。 | B 可以核对 A 的真实已提交结果；没有结果或只有 pending 草稿时等待 A，保持会话及尝试预算。 | R12, R13 |
| 新待审目标与历史批准的 head 和目标分支相同，但该远端 review 已 dismissed。 | 该历史批准不能满足新的待审轮次；仍按资格执行，daemon 不自行 dismiss approval。 | R6 |
| 远端 approval 已成功，但本地确认前 description 改变。 | 核对到匹配捕获目标的既有 approval 后保留批准，不因描述编辑撤销或新建反馈轮次。 | R6, R10, R12 |
| 完成标记已接受，但远端核对失败，或失败发生在最后一次 agent 尝试。 | 保存待核对状态并只读重试；重启保留它，不额外消费模型尝试预算。 | R11, R12, R13 |
| `COMMENT` 只有正文或普通 PR comment，没有实际 review thread。 | 不能记录成功反馈结果；保留明确失败及有限重试，不能伪造 conversation。 | R10, R12 |
| 已审查的 PR 被合并，或未合并就被关闭。 | daemon 清理该 PR 的 worktree。 | R9 |
| daemon 重启时存在待处理或被中断的审查工作。 | 保存的边界、PR 版本、会话、worktree 和执行状态支持恢复，且不会错误地宣告完成。 | R13, R14 |
| 已有实例锁记录的 CLI 仍存活，或其状态无法确认。 | 保留实例锁并明确拒绝启动，不接管既有运行。 | R13 |
| CLI 异常退出后，其实例锁仍存在，但记录的 CLI 进程已确认不存在。 | 自动接管失效锁并启动；未确定的审查及待清理资源阻塞对应 PR，轮询及同一仓库内的其他 PR 仍可处理，没有未确定工作时无需人工删除锁。 | R13 |

## 策略归属

上述需求不规定轮询间隔、不同 PR 之间的并发、重试上限和退避、进程超时，也不规定
编号超过边界的 PR 在 worktree 被清理后重新打开时的行为。架构和运维文档必须明确所选
策略及其限制，但不能将这些策略表述为额外的产品需求。
