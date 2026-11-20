# 普通 Task 列表与项目汇总的 Session 状态

项目独立 Task 行、任务链展开成员、Goal 展开成员和个人进行中列表的共享普通 Task 行显示各自当前 Session 观测。任务链头和 Goal 标题另显示成员的四态汇总，辅助定位需要响应或检查的会话。普通 Task 行以统一主状态表达生命周期和当前 Session；真实任务状态、暂停标记、标题入口及依赖关系保持各自语义。Session 状态不修改任务，不创建或启动 Session。依赖图卡片和助手会话不使用此列表观测。

## 状态与入口

[Watchdog 应用](assistant-task.md#watchdog-应用)复用完整 Session 观测进行有时长的
异常判定与事项跟进。列表文字角标只表达当前观测，不执行 Watchdog 的计时、
报告或直接处理策略。

项目列表复用 `task-sync`：`taskObservations` 为每个进行中普通 Task 提供完整状态，`sessions` 是链和 Goal 汇总使用的稀疏四态集合。两者各自接纳，不把完整观测注入旧汇总。页面可见时按 15 秒周期同步，隐藏时拒绝发布 Session 观察；不读取完整 `/sessions/current`，不另建逐任务 HTTP 调度。协议与服务端投影由[同步架构](daynight-task-sync.md#服务端-session-状态投影)定义。

### 普通 Task 行

进行中 Task 的观测区分 `no_session`（无当前执行）、`not_registered`、`pending`、`working`、`notice`、`warning`、`unavailable`、`unobserved` 或 `expired`。共享行根据自身 `allowAgents` 和观测决定文字：许可为 false 且观测为 `no_session` 时不显示无当前 Session 文字；许可为 true 时保留该文字。其它观测不受许可影响。`TaskRowStatus` 只选择展示文案，不修改观测；没有可显示观测时使用真实生命周期文案，始终保留唯一主状态。许可或观测变化随现有更新重新呈现，不增加请求或定时器。

缺项或尚未准入显示未观测；单项观测不可用及整体读取失败显示不可用，非 `unavailable` 的成功观测失效显示过期。三者均不是已确认无当前执行；completed Worker 及旧 Session 是历史记录，不提供当前入口。`needsAttention` 仅在真实、有效的事实支持时展示，并独立于无当前 Session 文字的省略。可读性与活动状态独立：有效且 `canOpen` 的 pending、暂缓 warning 或活动未知的 Session 仍提供入口；过期、观测失败或身份失效不能沿用旧入口。可用入口与行主体是独立控件，只导航该 Task 的 Session，不改变链或 Goal 展开状态。

`TaskRow` 将主状态位置交给 `TaskRowStatus`，不再并排输出 Session 和生命周期标签。非进行中只显示生命周期且不提供 Session 入口。进行中按 notice → 有效关注 → 具体观测 → 生命周期选择一句文案：notice 固定为“需要响应”／“Needs a response”；其余有效关注为“需要关注”／“Needs attention”，包括带关注的 warning；无关注 warning 为“需要检查”／“Needs checking”；其余使用“工作中”／“Working”、“待同步”／“Pending sync”、会话未注册、尚未观测、不可用、状态已过期或按许可规则展示的无当前会话。无具体观测时使用“进行中”／“In progress”。中英文均无固定 Session 前缀，不拼接关注后缀或生命周期。原始状态、关注属性及入口判定不变。

进行中且 `canOpen` 并存在调用方入口时，整句为带下划线的原生按钮，悬停提示打开 Session；否则为纯文本。按钮可访问名称包含可见短语、任务标题、真实生命周期及打开动作，去除重复短语；纯文本补充未在可见短语表达的生命周期。活动或关注变化而入口仍有效时，保持同一按钮节点及焦点。入口撤回时切成纯文本，继续复用 `.session-status-action` 的行级焦点跟踪；仅原控件已消失且焦点落回 body 时，将焦点移到同一显示实例的可见标题。其他有效焦点不受影响。此展示边界不增加 API、存储、请求、后台工作或部署顺序。

项目与个人列表各自的适配器提供同一显示归一化规则所需的观测事实。个人必填 `sessionRow` 与完整 Session 由同一次 Engine 采样生成，复用项目投影规则及服务端 Task 版本、执行来源和采样后 recheck；浏览器严格解析其精确版本和组合，不从完整 Session 缺少的归档／阅读事实或没有 claimId 的轻量 Worker 摘要猜测绑定；completed Worker 和无 active claim 均不能沿用历史 Session 入口。已确认注册、绑定和有效期但活动未知时可保持独立阅读入口，观测失败或绑定未知时不可打开。

仅 warning 在真实启动后不足 120 秒时暂缓检查及关注提示，独立且有效的 Session 入口保持可用；启动时间未知时立即展示，满 120 秒后只显示仍有效的观测。重新挂载、刷新和元数据编辑不重置起点。

### 链与 Goal 汇总

`sessions` 的每项为 Task ID 与 `working | notice | warning | pending` 之一：

| `sessions[taskId]` | 角标 | 含义与入口 |
|---|---|---|
| `warning` | warning（attention） | 任务仍在进行中，会话需要检查 |
| `notice` | notice（attention） | 会话需要响应 |
| `working` | working（activity） | 会话正在工作 |
| `pending` | 无 | 可靠当前会话正在初始化或同步，不贡献汇总角标 |
| Task 键缺席 | 无 | 无可靠当前汇总贡献 |

生命周期非 active 或明确断线优先于未同步及残留活动；connected 且 synchronized 时，waiting_input 为 notice、idle/stopped 为 warning、working 为 working。active 且未断线的 unknown 活动不提供可靠贡献；缺失 live 或 live fence 不匹配沿用服务端断线归一化，仍可贡献 warning。`pending` 不表示未注册、失败或无会话。HTTP 或解析失败撤销摘要，不能解释为离线、pending 或合法空集合。Provider 已将待处理审批、问题和表单归一为 waiting_input，操作能力不用于推测待处理内容。activity 只表达实际工作，不代表任务完成或整链所有成员均被观测；attention 表达需要响应或检查，不能将 warning 的线名或断连／停止本身当作明确失败。

普通 Task 的可用 Session 入口使用 `taskDetailUrl` 的 `tab=session` 导航到相应任务页面，随后复用详情的权限、claim 和会话检查。标题仍打开概览。链和 Goal 汇总状态入口仅展开成员，不选择任意 Session；各自标题动作保持原有语义。完整 Current 的读取与控制准入属于详情客户端，列表状态不授予内容或操作权限。

## 页面生产者与缓存边界

`useTaskGraph` 拥有页面内独立的完整项目观测 store 与 `TaskSessionSummaryStore`，并是两者的唯一生产者。它沿用项目同步请求、身份准入、取消和请求代次，在成功接纳 Task 数据后分别发布完整观测和四态汇总。Provider 只提供 context 与展示活动，不创建另一个数据源。

`api/types.ts` 的本地 `TaskSyncRead {sync, receivedMonotonic}` 保存 body 读取完成的单调时间。成功 decoder 在 `await response.text()` 完成后立即捕获 `performance.now()`，随后才执行 JSON 解码、source scan 和合同校验；历史观察、IDB 提交及渲染沿用该 receipt。非成功响应继续原错误解码流程。receipt 不是 wire 字段，不能从服务器 JSON、磁盘或其它标签页取得。

两类 Session entry 只驻留当前页面内存；完整观测保留 Task 版本、执行绑定、双时钟锚点和本次 receipt，四态汇总保留其原有绑定与 receipt。它不写入 Task properties、version、updatedAt、IndexedDB 或 BroadcastChannel，不触发普通 Task 变更通知、正文失效、额外 Task 图计算或 HTTP。Task-sync 自身既有 Task 合并、图校验与持久化仍执行一次。独立的持久 Session 记录目录保持其原有所有者，与列表瞬时状态分开。

## 观察绑定与迟到响应

`TaskCacheScope.beginSync` 在原有同一 IDB 事务中读取 manifest、水位与完整 stored Tasks，返回 `TaskSyncTicket.taskBindings` 和 `taskVersions`。绑定由 `task-cache/execution-binding.ts` 提取，仅包括 Task status，以及 Worker 的 claimId、workerId、worktreeId、state 与 agentControlMode；缺少 Worker 明确为 null。它是本次请求的不可变本地基线，不增加持久记录或 Session 版本。

`deriveTaskSyncBindings` 与 `deriveTaskSyncVersions` 对 snapshot 只使用实际响应 Tasks；对 delta 使用 ticket 基线并覆盖实际响应 Tasks。它不使用 `applySync` 最终的 max-version 合并结果给旧 Session 状态改绑：该结果可能已保留另一标签页发布的较新执行。

页面在发送 HTTP 前捕获已有 `authRequestsPauseRevision()`；历史与 Task 应用等待完成后，重新核对请求代次、取消和 scope，且仅在该 auth pause revision 未变化时发布 Session 观察。暂停时 store 已撤销贡献，即使随后恢复准入，暂停前的响应也不能重新发布它们；这一检查只约束 Session replace，原 Task 合并、图发布及 auth shell 保持各自规则。接纳同时使用结果 manifest 的 userFence、cacheGeneration 与 epoch 检查当前准入。snapshot 可以建立新 cacheGeneration，不能要求结果仍等于旧 ticket 的 generation。四态汇总 store 对状态值和集合中的缺席采用同一比较：只有 observed binding 与当前已授权 Task binding 完全匹配、且适用 Session 的任务，才能增加、替换或撤销贡献。完整观测另外要求当前为进行中普通 Task，精确 Task version 和可空执行绑定均匹配；无 Worker、completed 记录和 herdr 均是合法输入。缺项或不匹配显示未观测，不得沿用旧入口。整体读取失败撤回旧入口，并在仍授权的当前 Task 行显示不可用；身份或项目准入失效清除该失败投影。

对于四态汇总，例如请求观察 claim C1，期间缓存接纳 C2：C1 的旧状态不能覆盖 C2，C1 的键缺席也不能删除 C2 或延长 C2 的 receipt。当前 C2 的可靠完整观察缺少该键时，正常撤销 C2。普通 Task 缓存通知只复核并撤销已失效绑定；其它 task-sync 来源和标签页不能向本页面发布 Session map。响应 Session key 不属于其 observed eligible Task binding 时为协议错误。

## 新鲜度、展示活动与聚合

四态汇总观察在 `performance.now() - receivedMonotonic <= 30_000` 时有效，超过 30 秒撤销角标及该贡献入口。发布前检查期限；body 后解码、历史及 IDB 等待超过期限的响应不能短暂显示或续期。store 安排最早到期点的本地 timer，并在恢复展示或文档可见时立即复核，不依赖后台 timer 准时执行。渲染、缓存通知及其它标签页更新均不能续期。

完整行观测分别以 `responseTaskAt` 和 `responseSessionAt` 加 body receipt 后的单调增量推进数据库与 Engine 时钟；解码、历史和缓存等待均计入增量。Task `startedAt` 只与数据库时钟比较，Session 期限只与 Engine 时钟比较，取 `freshUntil` 与 `observedAt + 30s` 的较早值；成功观测的 null freshness 立即过期，观测失败的 unavailable 优先于过期。响应时钟到 body 接收的处理与网络延迟仍有误差。项目 store 共享计时安排最近变化；个人列表保留每条响应各自的双时钟和 body receipt，复用执行时钟订阅触发重新判定，后续分页不借用首条时钟。两者不使用逐行定时器。个人读取、账号与项目隔离和失败保留继续由[个人列表设计](daynight-web.md#我的进行中任务)拥有。

正常可见页面的 15 秒同步等待保留尚有效的贡献。当前读取失败撤销旧贡献并在当前授权 Task 行显示不可用，成功同步重新建立观测；auth pause、scope/项目准入失效、账户切换、任务完成或执行绑定变化撤销相应贡献；过期或已被取代的请求不能撤销较新观察。身份恢复继续沿用现有项目同步，没有本地 auth 轮询或 Session retry scheduler。

每个可见完整链通过 IntersectionObserver 注册完整 `component.memberIds`，包含根任务，排除仅由外部前置边引用的其它链；范围链注册其实际范围内成员，展示实例身份隔离登记。折叠和负责人筛选不缩小对应范围的聚合。取 warning > notice > working；pending 不产生聚合角标或汇总入口，成员行入口由完整观测独立决定。Goal 容器以独立实例登记 `projectTaskScope` 的全部直接成员，标题可见时即使收起或子任务 Tag 筛选无匹配也保持登记；Goal 自身及范围外成员不参与。容器不可见时按共享生命周期撤销观察，成员及可见性变化时更新；展开的各行显示自己的观察。Provider 的活动和可见性控制展示范围，不驱动网络；外层 Overview 和任务列表继续使用同一个项目同步所有者及完整索引，重开保留仍有效的页面状态。导航、项目/身份变化与页面释放清理所属内存、timer 和订阅。

## 视觉与可访问性

配色接入必须遵循[UI 语义角色](../ui-design.md#semantic-color-roles)：无有效关注的 working 使用 activity，notice、warning 或有效关注使用 attention，精确色值仅由该文档拥有。观察协议保持不变，明确失败反馈仍由独立 error 角色表达。普通 Task 行的主状态统一呈现生命周期与 Session 活动，保留独立可访问的真实生命周期；runtime 在线健康仍独立，在线绿色连接点不能替代 working 注记。超时保留独立图标、说明及配色，不覆盖统一文案，因此有效工作观测在超时后仍显示“工作中”。图卡、详情与汇总保留各自的生命周期文字。

链与 Goal 汇总的进行中状态保持无背景和边框的正文。汇总角标使用 Georgia 斜体，回退 Times New Roman/serif，字号 8.5px、行高 12px、字距 0.03em；没有背景、边框、图标或动画。固定状态区域预留右侧余量，绝对定位角标，显隐和词长变化不改变标题、状态坐标或行高。Goal 各生命周期状态的状态区域均定位角标；状态文字及背景仍由 Goal 自身决定。

标题与 Session 入口为同级控件。鼠标、触屏和键盘使用同一动作，aria-label 同时包含任务名、状态和动作；文字与颜色共同表达语义。汇总状态入口至少 44px 高，悬浮或键盘焦点提供具体状态说明。默认、悬停及焦点状态均须满足 UI 角色的文字对比度与焦点可见要求。状态更新不重新挂载行或改变标题、焦点和展开状态。

## 验证边界

API 所属测试覆盖必填四态 map、规范 UUID 与容量、非法输入、body→receipt→解码顺序，以及原非成功响应和关系 decoder。缓存与 store 所属测试覆盖同事务请求基线、snapshot/delta overlay、最终 scope fence、旧值与旧缺席、多标签页执行变化、30 秒精确边界、延迟发布、失败/auth pause 和恢复，并证明 Session-only 更新不写 Task 缓存或触发正文与普通通知。

生产组件测试覆盖独立行、链、Goal 成员及个人行的等价完整状态与独立入口，中英文 notice、warning 和关注组合各只显示一句、生命周期回退与可访问名称、有效入口同节点更新和撤回焦点恢复、超时叠加工作中及关注色对比，双时钟、119999／120000ms 宽限、过期及绑定变化；汇总测试覆盖根任务、折叠与筛选隐藏的普通成员、外部前置排除和全部优先级，以及标题、子任务状态与链状态导航动作。少量顺序浏览器流程验证列表/Overview 无 current、现有 task-sync 更新状态、实际 Session 导航、角标几何和内容/草稿稳定；完整客户端与缓存故障矩阵保留在各自模块。性能对照记录同条件请求数、字节及服务端读取工作，不能从理论调度降幅推断生产 CPU 或带宽降幅。决策及替代方案由[列表状态接纳决策](../../.agents/notes/implemented/architecture/2026-11-08-task-sync-session-list.md)保存。
