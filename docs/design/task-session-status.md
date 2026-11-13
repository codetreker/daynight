# 任务链的 Session 文字状态

任务链头与 Goal 子任务的“进行中”旁显示当前关联会话的文字角标，辅助定位需要响应或检查的会话。任务状态、暂停标记、标题入口及依赖关系保持各自语义；角标不修改任务，不创建或启动 Session。项目 Goal 列表的直接成员复用同一状态和入口；依赖图卡片、独立任务列表和助手会话不使用此摘要。

## 状态与入口

列表仅消费现有项目 `task-sync` 返回的完整 `sessions` 集合，在页面可见时按 15 秒周期观察；隐藏时仍拒绝 Session 观察。每项为 Task ID 与 `working | notice | warning | pending` 之一，不读取完整 `/sessions/current`，不另建逐任务 HTTP 调度。服务端的可靠关联、live 状态和期限判断由[同步架构](daynight-task-sync.md#服务端-session-状态投影)拥有。

| `sessions[taskId]` | 角标 | 含义与入口 |
|---|---|---|
| `warning` | warning（attention） | 任务仍在进行中，会话需要检查，入口可用 |
| `notice` | notice（attention） | 会话需要响应，入口可用 |
| `working` | working（activity） | 会话正在工作，入口可用 |
| `pending` | 无 | 可靠当前会话正在初始化或同步，入口仍可用 |
| Task 键缺席 | 无 | 无可靠当前贡献，不产生该贡献的入口 |

生命周期非 active 或明确断线优先于未同步及残留活动；connected 且 synchronized 时，waiting_input 为 notice、idle/stopped 为 warning、working 为 working。active 且未断线的 unknown 活动不提供可靠贡献；缺失 live 或 live fence 不匹配沿用服务端断线归一化，仍可贡献 warning。`pending` 不表示未注册、失败或无会话。HTTP 或解析失败撤销摘要，不能解释为离线、pending 或合法空集合。Provider 已将待处理审批、问题和表单归一为 waiting_input，操作能力不用于推测待处理内容。activity 只表达实际工作，不代表任务完成或整链所有成员均被观测；attention 表达需要响应或检查，不能将 warning 的线名或断连／停止本身当作明确失败。

子任务所有有效状态入口使用 `taskDetailUrl` 的 `tab=session` 导航到相应任务页面，随后复用详情的权限、claim 和会话检查；pending 沿用同一无角标入口。标题仍打开概览。链状态入口仅展开成员，不选择任意 Session；链标题仍负责展开或折叠。完整 Current 的读取与控制准入属于详情客户端，列表状态不授予内容或操作权限。

## 页面生产者与缓存边界

`useTaskGraph` 拥有稳定的页面内 `TaskSessionSummaryStore`，并是唯一生产者。它沿用项目同步请求、身份准入、取消和请求代次，在成功接纳 Task 数据后发布对应 Session 观察。store 经 `ProjectPage → ProjectTaskWorkspace → TaskSessionSummaryProvider` 传递；Provider 只提供 context 与展示活动，不创建另一个数据源。

`api/types.ts` 的本地 `TaskSyncRead {sync, receivedMonotonic}` 保存 body 读取完成的单调时间。成功 decoder 在 `await response.text()` 完成后立即捕获 `performance.now()`，随后才执行 JSON 解码、source scan 和合同校验；历史观察、IDB 提交及渲染沿用该 receipt。非成功响应继续原错误解码流程。receipt 不是 wire 字段，不能从服务器 JSON、磁盘或其它标签页取得。

Session entry 只含四态、执行绑定与本次 receipt，并只驻留当前页面内存。它不写入 Task properties、version、updatedAt、IndexedDB 或 BroadcastChannel，不触发普通 Task 变更通知、正文失效、额外 Task 图计算或 HTTP。Task-sync 自身既有 Task 合并、图校验与持久化仍执行一次。独立的持久 Session 记录目录保持其原有所有者，与列表瞬时状态分开。

## 观察绑定与迟到响应

`TaskCacheScope.beginSync` 在原有同一 IDB 事务中读取 manifest、水位与完整 stored Tasks，返回 `TaskSyncTicket.taskBindings`。绑定由 `task-cache/execution-binding.ts` 提取，仅包括 Task status，以及 Worker 的 claimId、workerId、worktreeId、state 与 agentControlMode；缺少 Worker 明确为 null。它是本次请求的不可变本地基线，不增加持久记录或 Session 版本。

`deriveTaskSyncBindings` 对 snapshot 只使用实际响应 Tasks；对 delta 使用 ticket 基线并覆盖实际响应 Tasks。它不使用 `applySync` 最终的 max-version 合并结果给旧 Session 状态改绑：该结果可能已保留另一标签页发布的较新执行。

页面在发送 HTTP 前捕获已有 `authRequestsPauseRevision()`；历史与 Task 应用等待完成后，重新核对请求代次、取消和 scope，且仅在该 auth pause revision 未变化时发布 Session 观察。暂停时 store 已撤销贡献，即使随后恢复准入，暂停前的响应也不能重新发布它们；这一检查只约束 Session replace，原 Task 合并、图发布及 auth shell 保持各自规则。接纳同时使用结果 manifest 的 userFence、cacheGeneration 与 epoch 检查当前准入。snapshot 可以建立新 cacheGeneration，不能要求结果仍等于旧 ticket 的 generation。store 对状态值和完整集合中的缺席采用同一比较：只有 observed binding 与当前已授权 Task binding 完全匹配、且适用 Session 的任务，才能增加、替换或撤销贡献。

例如请求观察 claim C1，期间缓存接纳 C2：C1 的旧状态不能覆盖 C2，C1 的键缺席也不能删除 C2 或延长 C2 的 receipt。当前 C2 的可靠完整观察缺少该键时，正常撤销 C2。普通 Task 缓存通知只复核并撤销已失效绑定；其它 task-sync 来源和标签页不能向本页面发布 Session map。响应 Session key 不属于其 observed eligible Task binding 时为协议错误。

## 新鲜度、展示活动与聚合

观察在 `performance.now() - receivedMonotonic <= 30_000` 时有效，超过 30 秒撤销角标及该贡献入口。发布前检查期限；body 后解码、历史及 IDB 等待超过期限的响应不能短暂显示或续期。store 安排最早到期点的本地 timer，并在恢复展示或文档可见时立即复核，不依赖后台 timer 准时执行。渲染、缓存通知及其它标签页更新均不能续期。

正常可见页面的 15 秒同步等待保留尚有效的贡献。当前读取失败、auth pause、scope/项目准入失效、账户切换、任务完成或执行绑定变化撤销相应贡献；过期或已被取代的请求不能撤销较新观察。身份恢复继续沿用现有项目同步，没有本地 auth 轮询或 Session retry scheduler。

每个可见完整链通过 IntersectionObserver 注册完整 `component.memberIds`，包含根任务，排除仅由外部前置边引用的其它链；范围链注册其实际范围内成员，展示实例身份隔离登记。折叠和负责人筛选不缩小对应范围的聚合。取 warning > notice > working；pending 只贡献入口可访问性，不产生聚合角标。Goal 展开时以独立实例登记全部直接成员，收起时撤销登记，各行显示自己的观察。Provider 的活动和可见性控制展示范围，不驱动网络；外层 Overview 和任务列表继续使用同一个项目同步所有者及完整索引，重开保留仍有效的页面状态。导航、项目/身份变化与页面释放清理所属内存、timer 和订阅。

## 视觉与可访问性

配色接入必须遵循[UI 语义角色](../ui-design.md#semantic-color-roles)：working 使用 activity，notice 与 warning 使用 attention，精确色值仅由该文档拥有。观察协议保持不变，明确失败反馈仍由独立 error 角色表达。Task 的生命周期、Session 活动和 runtime 在线健康分别显示，在线绿色连接点不能替代 working 注记。

进行中状态保持无背景和边框的正文。角标使用 Georgia 斜体，回退 Times New Roman/serif，字号 8.5px、行高 12px、字距 0.03em；没有背景、边框、图标或动画。固定状态区域预留右侧余量，绝对定位角标，显隐和词长变化不改变标题、状态坐标或行高。

标题与状态入口为同级控件。有效入口至少 44px 高，鼠标、触屏和键盘使用同一动作。悬浮或键盘焦点提供具体状态说明，aria-label 同时包含任务名、状态和动作；文字与颜色共同表达语义。默认、悬停及焦点状态均须满足 UI 角色的文字对比度与焦点可见要求。状态更新不重新挂载行或改变标题、焦点和展开状态。

## 验证边界

API 所属测试覆盖必填四态 map、规范 UUID 与容量、非法输入、body→receipt→解码顺序，以及原非成功响应和关系 decoder。缓存与 store 所属测试覆盖同事务请求基线、snapshot/delta overlay、最终 scope fence、旧值与旧缺席、多标签页执行变化、30 秒精确边界、延迟发布、失败/auth pause 和恢复，并证明 Session-only 更新不写 Task 缓存或触发正文与普通通知。

生产组件测试覆盖根任务、折叠与筛选隐藏的普通成员、外部前置排除、全部优先级、pending 入口，以及标题、子任务状态与链状态三个导航动作。少量顺序浏览器流程验证列表/Overview 无 current、现有 task-sync 更新状态、实际 Session 导航、角标几何和内容/草稿稳定；完整客户端与缓存故障矩阵保留在各自模块。性能对照记录同条件请求数、字节及服务端读取工作，不能从理论调度降幅推断生产 CPU 或带宽降幅。决策及替代方案由[列表状态接纳决策](../../.agents/notes/implemented/architecture/2026-11-08-task-sync-session-list.md)保存。
