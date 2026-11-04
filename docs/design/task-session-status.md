# 任务链的 Session 文字状态

任务链头与 Goal 子任务的“进行中”旁显示当前关联会话的文字角标，辅助定位需要响应或检查的会话。任务状态、暂停标记、标题入口及依赖关系保持各自语义；角标不修改任务，不创建或启动 Session。依赖图卡片、独立任务列表和助手会话不使用此摘要。

## 状态与入口

只有进行中的任务、已授权的当前任务摘要及成功读取的当前 Session 才能提供入口。`sessions/current` 由服务端选择任务当前 Worker claim；浏览器还核对返回的 project、task、claim、worker 和 worktree 身份。无关联、不适用模式、未注册、未知活动、无权限、失败或超过 15 秒的结果不产生角标或空入口。

| 可靠的当前会话状态 | 角标 | 含义 |
|---|---|---|
| 非 active 生命周期或明确 disconnected | warning（红） | 任务仍在进行中，会话需要检查 |
| connected 且 synchronized，activity 为 waiting_input | notice（黄） | 会话需要响应 |
| connected 且 synchronized，activity 为 idle 或 stopped | warning（红） | 任务仍在进行中，会话需要检查 |
| connected 且 synchronized，activity 为 working | working（绿） | 会话正在工作 |
| 初始化或同步中 | 无 | 已确认可访问时仍可进入 Session |

生命周期与明确断线优先于残留活动。HTTP 失败不是离线证据，只隐藏摘要。Provider 已将待处理审批、问题和表单归一为 `waiting_input`；`operations.canRespond` 表示能力，不能证明存在待处理交互。绿色不代表任务完成或整链所有成员均被观测。

子任务所有有效状态入口使用 `taskDetailUrl` 的 `tab=session` 导航到相应任务页面，随后复用详情的权限、claim 和会话检查。标题仍打开概览。链状态入口仅展开成员，不选择任意 Session；链标题仍负责展开或折叠。

## 摘要与聚合

`features/task-session-summary/` 拥有页面内共享摘要。Provider 绑定 `TaskCacheScope` 和 project，从已授权的 `TaskSummary.properties.worker` 取得 claim，不把缺少属性的 `GraphTask` 当作执行身份。单任务和链头读取同一份摘要，不缓存 timeline，不建立列表 channel，也不持久化会话摘要。

每个可见链通过 IntersectionObserver 注册完整 `component.memberIds`，包含根任务，排除仅由外部前置边引用的其它链。折叠和负责人筛选不缩小聚合范围。取 warning > notice > working；全部没有角标则隐藏。成员删除、完成、撤权、claim 变化和过期都会撤销旧贡献。

并发最多四个未完成请求，每个任务在上一次请求结束至少五秒后再读。取消中的请求在 transport settle 前仍占并发名额，旧请求不能覆盖新 claim。切页、离开可视范围、隐藏文档、切换外层 Overview 或账户失效时撤销摘要并取消读取；重新可见立即刷新。任务缓存通知触发身份复核，请求提交结果前再次核对当前身份。失败不显示全局错误，下次正常刷新可恢复。

## 视觉与可访问性

进行中状态保持无背景和边框的正文。角标使用 Georgia 斜体，回退 Times New Roman/serif，字号 8.5px、行高 12px、字距 0.03em；没有背景、边框、图标或动画。固定状态区域预留右侧余量，绝对定位角标，显隐和词长变化不改变标题、状态坐标或行高。

标题与状态入口为同级控件。有效入口至少 44px 高，鼠标、触屏和键盘使用同一动作。悬浮或键盘焦点提供具体状态说明，aria-label 同时包含任务名、状态和动作；文字与颜色共同表达语义。

## 验证边界

摘要测试覆盖状态顺序、当前身份、权限、迟到响应、并发上限、刷新间隔、新鲜度和可见性。组件测试覆盖链全成员聚合及兄弟控件交互。真实服务浏览器验收验证实际 current 数据、直接 Session 导航与桌面及窄屏几何。原型只表达设计，不能替代这些集成证据。
