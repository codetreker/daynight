# Daynight review skill 设计

状态：内置 skill 打包、固定快照、发现校验和两阶段执行已实现。验证命令与证据边界见
[仓库验证说明](../../README.md#validation)，逐次运行结果随对应 PR 与 CI 保存。
需求归属见[review 需求](../spec/daynight-review.md)，执行与恢复模型见
[review 架构](daynight-review.md)，选择依据见
[内置 skill 决策](../../.agents/notes/archived/architecture/2026-10-20-bundled-review-skill.md)和
[PR 质量门槛决策](../../.agents/notes/archived/process/2026-10-21-review-pr-quality-gates.md)及
[conversation 轮次决策](../../.agents/notes/archived/architecture/2026-10-21-review-conversation-cycle.md)。
[多角度审查决策](../../.agents/notes/implemented/process/2026-10-22-pr-specific-review-perspectives.md)
记录独立委派与汇总的选择依据。

## 目标与边界

`review run` 的每次 Copilot 审查都使用随客户端发布的 `daynight-review` skill。
skill 定义审查方法、按 PR 内容选择多个互补角度的独立委派、主 agent 汇总、证据标准、
PR description 与原定范围的质量门槛，以及代码 finding 的范围；每次调用的提示词保留 PR 身份、固定的 head/base、当前 PR 信息的
读取要求、发布前校验、重试对账和最终完成标记。两者共同构成一次审查的输入。

skill 的打包与发现保留配置、已有数据位置和每个 PR 的会话 UUID；审查轮次和远端结果
由 review 状态模块显式迁移持久化。skill 目录
由 review 模块持有；仓库根目录的 `.agents/skills/` 继续管理开发本仓库的工作流。
不增加用户可配置的 skill 注册目录或通用插件扩展 API。

## 源码与安装资源

```text
packages/daynight/
  src/commands/review/
    skill.ts
    skills/daynight-review/
      SKILL.md
  dist/commands/review/
    skill.js
    skills/daynight-review/
      SKILL.md
```

构建清理 `dist/` 后，将完整的 `skills/daynight-review/` 目录复制到相同的构建目录，
包括将来由 `SKILL.md` 相对引用的资源。npm 包的 `dist` 发布规则覆盖这些文件。
客户端外壳已有的 `CliContext.packageDirectory` 是安装资源的定位依据；`review`
命令将它传入运行时，资源位置不依赖调用目录、源码目录或用户环境。

`SKILL.md` 使用标准 YAML frontmatter，名称固定为 `daynight-review`，description
说明它适用于 Daynight 管理的 PR 审查。正文使用英文，保持可独立理解。它要求先从
PR description 和相关需求确定一个明确问题、预期结果及原定范围，再检查完整捕获
diff 是否围绕该结果且可以有效审查。多个独立目标、无法明确边界的 description，
以及越界改动都是阻断批准的 PR 质量问题；必要实现、结构调整、测试和文档同步按其
与同一结果的关系判断，不设置固定行数或文件数限制。扩大 description 本身不能把
无关修改变为原定范围。

代码审查继续追踪调用者及行为约束，用有边界的独立验证证明引入的问题，只发布需要
处理的 Critical/Major 英文行级 findings；更小和无关的代码改进延后。质量门槛不借用
Critical/Major 来判断是否阻断批准。所有阻断发布都必须形成实际可 resolve 的
conversation：越界修改和代码问题使用适合的 diff 行；description 和无合适 diff 行的
PR 级问题使用主要修改文件上的文件级 thread，并明确标注问题属于 PR 级。review
正文或普通 PR comment 不能单独满足反馈要求。skill 不包含特定 PR 的值；动态提示词
持有读取时机、发布结果选择、资格校验和重试确认协议。

## 多角度审查与汇总

每次新审查由主 agent 先检查捕获 merge-base 到 head 的完整 diff，并结合当前 PR
信息、相关需求和风险选择至少两个互补角度。选择依据是本次修改中需要验证的具体
问题；纯文档修改也要选择相互补充的角度，不用固定领域清单替代内容判断。主 agent
实际调用独立 subagents，宜并行执行，继续对完整 diff 和 PR 质量门槛负责。

每个委派任务携带确切的 host、仓库、PR、head、目标分支、捕获 base、merge-base 和
diff 范围，以及交付范围、相关需求、适用仓库指示、指定角度和证据标准。特殊用途的
subagent 不一定继承仓库指示，主 agent 必须显式传递。资源指示包括共享 worktree、
获准临时目录及避免冲突的 probe 归属、前台进程、超时和清理要求。subagents 只读源码
及 Git 状态，有边界的 probe 仅写获准临时文件；不另建 worktree、不修改远端 review
或 thread、不发布结果或完成标记，结束前停止自己启动的工具和服务。

subagent 返回角度与覆盖范围、候选问题的触发条件、调用者影响、引入证据和具体位置，
以及修复/延后/不成立建议、验证限制和执行失败。没有候选问题也要说明检查范围和
限制。主 agent 等待所有必要角度，独立验证候选、处理分歧、按根因去重，并把选择
角度的理由、已完成覆盖、限制、候选处置及确认阻断项写入 attempt 输出。汇总位于
最终标记之前，随既有 stdout 日志保留；GitHub 仅接收简洁、可操作的 findings。

subagents 是一个正式审查进程内的委派，受同次 attempt 的截止时间和预算约束，不是
daemon 的独立 Worker、审查轮次或持久化 PR 主会话。daemon 仍只登记一个正式审查
直接子进程，沿用既有前台进程与清理契约；不解析委派对话或 findings 来断言方法已执行。
工具不可用、必要角度失败或覆盖不完整时，主 agent 可在剩余预算内重试或重新委派；
仍无法完成则报告操作失败，不发布 review 或完成标记。已有合法匹配已提交结果的
恢复仅核对原结果，无须重新进行委派；仍需提交的 pending 草稿必须先完成新审查的
委派与汇总。

## 固定运行时快照

运行时取得实例锁后、启动任何审查前，读取安装包内的完整 skill bundle。准备过程
校验 `SKILL.md` 的名称和非空 description，目录树只允许目录和普通文件，拒绝符号
链接及其他文件类型，并按规范化相对路径排序。将捕获内容包在固定的本地 plugin
目录中，生成名称为 `daynight-review-bundle`、版本为 `1.0.0` 的 `plugin.json`，
skill 放在其 `skills/` 下。wrapper 版本描述固定的资源结构，与客户端发布版本无关。
对完整 wrapper 的条目类型、相对路径和文件字节使用带边界的编码计算内容哈希，
包括生成的 manifest，避免不同文件划分产生同一输入。全部安装资源只读取一次，
同次 daemon 的后续审查共享这份捕获内容。

快照布局为：

```text
~/.daynight/cache/review-skills/<digest>/
  plugin.json
  skills/
    daynight-review/
      SKILL.md
```

准备者先在缓存目录内写入本次拥有的唯一临时目录，完整写入后以 rename 发布为
`<digest>`。已经存在的同名快照必须重新校验其内容与捕获内容一致；内容缺失、额外、
损坏或类型不符时明确失败。准备失败清理本次临时资源并使启动失败，不使用其他目录
或旧内容继续审查。已发布目录按内容寻址且不再修改。

快照使同次 daemon 不受 `daynight update` 替换安装资源的影响。历史会话或无法确认
已停止的进程仍可能引用旧目录，因此不自动删除快照。清理策略作为独立能力添加时，
必须保留尚可能被引用的内容；本次交付承担缓存随不同 bundle 内容增长的代价。

## 每次启动的发现与显式加载

审查适配器在每个子进程中通过单个参数 `--plugin-dir=<digest 目录>` 加载本地快照，
不会安装用户全局 plugin。路径可以包含逗号、空格和 Unicode。子环境清除所有大小写
写法的继承 `COPILOT_SKILLS_DIRS`；既有 `COPILOT_HOME`、认证环境和会话 UUID
继续使用原有机制。`COPILOT_SKILLS_DIRS` 是 CSV 目录列表，包含逗号的状态路径
不能由一个列表项完整表达；命令参数使完整快照路径保持一个值。

每次新会话、重试和 `--resume` 都先在已准备的 PR worktree 中执行：

```text
copilot -C <worktree> --plugin-dir=<digest 目录> --no-auto-update skill list --json
```

发现和正式审查使用相同 worktree、环境及快照。发现响应必须是完整且有大小上限的
UTF-8 JSON 数组。`name` 为 `daynight-review` 的条目必须恰好一个，`enabled` 为
`true`，并且其 `path` 经 `realpath` 解析后等于当前快照的 skill 目录。项目中的同名
skill 覆盖、禁用条目、意外路径、无效 JSON、截断或超限输出均使本次尝试失败。
仅提供 plugin 目录不能证明 Copilot 选择了内置版本，因此不能省略此检查。

正式审查提示词显式要求调用 `/daynight-review`，给出本次快照的绝对 `SKILL.md`
路径和 digest，并要求加载该路径的当前内容后才开始审查。恢复会话也带上这组输入；
不能依赖对话历史里已经出现过同名 skill。Copilot 的标准 skill 调用负责加载内容，
程序不解析其会话历史，也不将工具调用文本作为新的完成条件。

提示词同时显式要求使用已加载 skill 的原生 subagent 委派与汇总，不重复定义角度、
数量或方法细节。确认合法匹配的已提交结果仍只对账，不重新委派；需要新发布时适用
完整方法要求。该调用指示让加载 skill 与执行其委派方法的要求同时出现在当前输入中。

动态提示词要求 agent 读取当前 PR 标题、description 和链接的相关范围需求，并审查
固定 head/base 对应的完整 diff。新发布前再次读取当前标题和 description，并结合
相关需求重新评估。只有 description 与范围两项门槛通过
且没有 Critical/Major 代码问题时才能 `APPROVE`；否则使用带实际可 resolve thread 的
`COMMENT`，不使用 `REQUEST_CHANGES`。执行或发布失败不能通过虚构 finding 满足该
二选一要求。已有匹配捕获目标的 approval 保持有效，description 编辑不能要求撤销。

同一轮恢复先核对已发布结果，避免重复发布。只有捕获轮次的真实 `APPROVED`、带
自身 thread 的 `COMMENTED`，或同一固定发布者可恢复的有效匹配 pending 草稿，才
允许绕过 conversation gate。失败尝试本身不能构成例外。账户变化后可只读核对原
发布者的已提交结果；没有结果或仅有草稿时等待原发布者，不消费模型尝试。daemon
不解析质量判断，而是核对稳定审查身份、捕获 commit、
发布者和真实 review/thread 证据。接受完成标记后，远端核对失败只进行可重启的只读
重试，不消费模型尝试预算。完整查询成功但没有合法结果时，回到有限模型重试；
耗尽明确失败。成功 `COMMENT` 保存一次性反馈屏障；全部已提交的原生 review
conversation resolve 后，在当前目标 CI 通过时进入下一轮，无需新 commit。resolve
是请求再验证的信号，skill 仍要求检查问题是否实际修复。已批准目标保持完成；仅元
数据编辑不产生新轮次。持久化和调度的机制归属见[review 架构](daynight-review.md)。

## 两阶段尝试与进程归属

一次持久化 attempt 覆盖顺序执行的发现进程和正式审查进程，计数只增加一次，两阶段
共用一个 `agentTimeoutMs` 截止时间。已有进程监督器继续保证同一 attempt 同时只
登记一个直接子进程。阶段顺序为：

1. 保存尝试意图，启动发现进程，并持久化它的 PID 与进程身份。
2. 将发现 stdout、stderr 分别流式写入该 attempt 的
   `skill-list.stdout.log`、`skill-list.stderr.log`。JSON 捕获使用独立的有界缓冲；
   捕获失败、发现命令失败与业务校验失败保留各自的错误原因。
3. 直接子进程关闭且输出捕获完成后，调用已有 `processes.exclude` 排除该阶段的
   进程及其受支持的后代。只有取得 `ProcessesExcluded` 证明，才能清空当前登记。
4. store 只允许在当前 running attempt 且 PID、进程身份仍精确匹配时，清空
   `process_id` 和进程身份；保留尝试状态、预算、日志目录和会话意图。
5. 再检查取消与整体截止时间，校验发现条目，才启动正式审查进程并持久化新身份。
6. 正式审查继续使用 `stdout.log`、`stderr.log`、会话检查和原有完成协议。

进程排除失败时保留不确定执行证据，不启动后续审查，也不提前释放实例锁。两阶段
之间收到取消时，已排除的发现进程登记可以清空，但不得再启动正式审查。会话历史
存在性检查只用于正式审查，发现命令不会建立或恢复 PR 会话。

进程结果类型分离直接子进程执行证据与审查业务结果，使发现失败也能复用现有的
终止与排除机制。两阶段对 ENOENT 和 Windows 命令包装器使用相同的确定性证据。
协调器在正式审查最终排除后保存完成断言，再核对远端发布；资源排除和完成标记
不能互相替代，也不能替代真实 review/thread 证据。

## 失败与可观察结果

安装资源缺失或 bundle 无效属于启动失败，不消费某个 PR 的尝试预算。发现阶段的
命令、输出或匹配失败属于该 PR 当前 attempt 的失败，使用现有重试和上限策略。
所有失败保留对应日志和具体原因，不能退回不带 skill 的审查。发现成功也不表示
审查完成；正式审查的精确末行产生执行完成断言，实际发布还须由完整远端证据确认。

## 验证

单元和受控进程验证覆盖资源定位、完整 bundle 哈希及复制、已有快照损坏、原子发布、
发现响应及同名覆盖、子环境隔离、同一会话的恢复提示词、两阶段预算与截止时间、
阶段间取消、PID 清空的匹配规则，以及排除失败时不启动后续进程。提示词回归检查
断言新发布前重新评估当前标题和 description、`COMMENT` 必须包含实际可 resolve
thread、同一轮恢复避免重复发布，以及两项质量门槛通过且没有 Critical/Major 才能
批准。conversation 和发布对账的状态测试覆盖同 SHA 重审、完成前 resolve、重启后
消费一次反馈、核对失败不重复调用模型、没有发布的失败重试继续等待其他 feedback，
以及 description 编辑保留已有 approval。
初次读取 PR 信息、相关需求、检查完整 diff、按内容独立委派及汇总的要求由加载的
skill 正文提供。打包、资源与提示词检查不证明模型实际完成委派或在任意 PR 上的判断
质量；实际委派、固定目标传递、返回结果和汇总须由相应原生执行证据观察。

安装包验收从打包产物启动，确认 `SKILL.md` 及相对资源实际存在，帮助和其他命令仍
不加载 review 运行时。真实 Copilot 验收分别观察新会话和同 UUID 恢复时的原生 skill
调用，特别覆盖 bundle 内容变化后使用新快照的恢复场景。该观测证明所测 Copilot
版本的行为，不引入生产环境的 transcript 解析或版本兼容猜测。

Copilot CLI 1.0.100 使用实际编译的内置 skill、生产快照准备函数和适配器加载指令，
已验证含逗号、空格和 Unicode 路径下的原生 skill 调用，以及内容变化后的同 UUID
恢复。恢复结果读取了只存在于更新正文、未出现在提示词中的校验值。原安装资源和旧
快照保持不变。同路径恢复可能复用旧内容，新内容寻址路径与显式当前路径指令共同
约束恢复行为。该探针只证明实际加载，完整 stdin、文本完成协议和发布行为由各自的
受控或真实服务验收覆盖。所依赖的标准目录、
发现和调用机制见 GitHub 的
[CLI 参考](https://github.com/github/docs/blob/4dd188c2c92f0b57e7f7ec863fd9cca1e093b09b/content/copilot/reference/copilot-cli-reference/cli-command-reference.md)
及[添加 skill 指南](https://github.com/github/docs/blob/429304ea1e53a2f32b598abdf58c9a80458738a1/content/copilot/how-tos/copilot-cli/customize-copilot/add-skills.md)，
本地 wrapper 遵循[plugin manifest 与目录规则](https://github.com/github/docs/blob/2d0a7bedfba3fec537f96da6e4188165ca25c252/content/copilot/reference/copilot-cli-reference/cli-plugin-reference.md)。
