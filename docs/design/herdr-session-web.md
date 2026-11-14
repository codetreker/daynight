# Herdr Session 页面与只读回放

## 页面与身份

`TaskSessionHost` 按任务生命周期承接共同入口，不保存执行记录选择，也不渲染记录选择器和列表刷新行。活动 claim 继续使用 `TaskAgentSession` 或 `TerminalSessionView`，由各自 current 读取和连接逻辑核验原 claim；历史目录出现同一 Session 不再产生第二个主入口。完成或已释放的 claim 通过对应协议的 current GET 解析真实 Session，再交给固定归档阅读器；该读取只确定身份，不创建 native conversation、提交 assignment 或恢复输入。任务完成信号立即撤下写界面，归档是否可读仍取决于真实状态和内容校验。

服务端 `task_sessions` 对 project/task/claim 保持唯一约束，Web 与 Herdr 使用同一 Session 命名空间。两种 current 均按 Worker claim 查询，completed Worker 仍保留身份；release 清除当前 Worker；没有 Worker 时 current 为 not_applicable。无 claim 的主入口使用历史 API 中按创建时间和 Session ID 降序排列的首个实际条目，作为只读历史。当前 claim 尚未注册时不向旧历史回退。无 claim 的目录发现随可用任务详情读取，不依赖先打开尚未确定是否存在的 Session 页签；空页仍有 cursor 时继续读取，直到找到实际记录或确认完整为空。首次读取、失败与拒绝均保留可恢复状态；仅完整确认无 Session 时隐藏页签。

`FixedSessionRecording` 接收由原 sessionId、claimId、executionGeneration 和模式构成的 `SessionRecordingReference`。历史条目已有的归档元信息继续作为校验约束，current 发现无需补造创建时间或历史条目。固定归档读取不创建实时连接或持有输入接口，pending 状态通过有界间隔的只读请求继续观察。Web 的 current 仍为 active/draining 时，暂时 unavailable 表示尚在准备，继续观察原 current 与归档；current 确认 archived 后，unavailable 保持真实终态和人工刷新入口。普通后台检查保留已有阅读器和已验证内容；相同身份和归档内容不因新的响应对象而重新挂载。实际身份、归档状态或权限变化分别处理，权限拒绝撤下内容。Web 归档沿用按账号和 Session 绑定的 Display 偏好，Herdr 使用原终端回放能力。主入口不恢复旧 `daynight:recording:<userId>:<projectId>:<taskId>` 选择键，只移除对应键，草稿与其他会话存储保持各自所有权。具体取舍见[自动 Session 入口决策](../../.agents/notes/implemented/simplification/2026-11-06-automatic-task-session-entry.md)。

普通附件继续使用原文件树、上传和删除流程。受管 Session 记录在同一侧栏中独立于文件树展示。记录目录与确认空结果按用户、项目和任务持久缓存，打开或重新激活时复用合格缓存并后台重读首页；历史 API 没有目录版本合同，任务业务版本不决定目录是否新鲜。确认空目录在后台刷新期间继续隐藏，有记录时保留可读内容，内容变化后更新。首次未知状态提供加载提示；空首页仍有 nextCursor 时，只有全部后续页耗尽才能独立确认完整空目录，缓存保留原首页与 cursor 及该空证明。重读已确认空目录时，若首页仍为空且有 cursor，后台继续读取后续页，直到发现记录或真正耗尽。读取失败不作为空结果保存，已有内容保持可读并提供重试，首次失败也有可恢复入口。缓存仍可读但刷新或分页事务写入失败时保留已有内容、显示可恢复错误，不发布无法排序的新成功响应；完全不可读写时沿用下述有限降级。direct 目录仅在实际 principal 已核验的拒绝或现有 401 会话失效路径中撤回内容并传播负向提示；可信拒绝的错误正文畸形仍保留其 HTTP 状态语义。不同、缺失或畸形 principal 是协议错误，不能依据其状态撤回目录或通知其他读取者。完成任务的自动 Session 发现遇到可信不同 principal 时通知账户 owner 并丢弃该结果，不改变已有选择或发布错误。缓存和响应通过共享身份及项目生命周期准入；正常存储时旧 scope、撤权或过期请求不能重新发布内容。存储完全不可用时，跨标签提示和重启后的撤权记忆有[有限降级](daynight-task-sync.md#5-indexeddb-与去重)。缓存只用于目录展示，不能授权实时连接、控制或归档正文。具体取舍见[记录目录缓存决策](../../.agents/notes/implemented/architecture/2026-11-05-session-records-cache.md)。

历史存在与归档 ready 是不同条件，pending、failed、unavailable 记录也保留入口。附件中的记录选择使用原阅读区打开只读记录，不能借普通附件操作覆盖、删除或重命名权威归档。两类内容共用阅读区的可用高度，避免短窗口中的正文被额外记录区域挤空。普通附件预览在回放时保持挂载并隐藏、禁用交互，上传草稿与 iframe 状态保留；选择普通文件、上传成功或导航到附件时退出受管记录选择。

## Task Current 的实际读取时机

Task 详情仅在所选 Session tab 且文档可见时发起完整 current，涵盖活动 claim 与 completed claim 的原会话发现。未选中的 native reader 保持挂载但不抢先读取；其健康 channel 在隐藏期间保留，重新可见恢复既有 current 观察。读取可见性不替代当前执行、访问权限或身份准入；原生 60 秒身份 suspension 与应用的隐藏/离焦暂停仍保持。

completed automatic 的原 claim 发现，在 `scope.ready` 后、发 HTTP 前和每次等待结束后检查实际可见性及请求归属。隐藏取消读取，未 settle 的请求保留名额；重开或 claim 更换等其 settle 后恢复原有发现，迟到结果不能发布到新 owner。归档内容仍由固定原 Session 阅读器校验，准备期间仅在可见 tab 内延续原 current 观察。无 claim 时用于确定入口存在性的历史目录读取保持其独立规则。

Herdr 继续采用下面的 channel/control lease 生命周期，不套用 native 的健康连接保留策略。其完整 current 发现已有同一 tab/document 门禁；终端画面、控制、回执和归档业务保持。具体读取职责见[Task Current 设计](task-session-protocol.md#task-current-的读取可见性)。

## 实时连接与人工输入

终端客户端的订阅由页签可见性、文档可见性、当前任务和访问权限共同决定。隐藏页签和离开页面关闭该浏览器的 channel；服务端撤销相同 browserClientId 的租约或尚未完成的取得控制请求。录制由 Worker 独立负责，不依赖浏览器是否订阅。

当前 Session 的发现和重连由终端客户端串行调度。重复的可见性通知不会启动额外读取或绕过等待；`not_registered` 保持稳定空态，并按重连间隔继续发现同一 claim 的注册，`not_applicable` 则停止自动发现。显式刷新和重新进入可以再次读取。后台发现不反复显示加载状态；失败仍显示错误，权限失效和身份不一致会隔离客户端。发现 registered 后沿用原 Session 的状态准入和 channel 生命周期，不用历史记录替代当前连接。

已确认的终端画面和业务控制状态与传输就绪状态分开保存。隐藏或身份检查时停止 channel、自动回执查询和续约，立即禁止输入，但保留画面、草稿、同一控制身份的确认及其布局。恢复时的状态 GET 不单独授予输入权限；须等当前连接上与运行 fence 和控制代次匹配的新鲜 channel 状态。首次无有效内容时才显示加载；实际断线、权限失败及其他错误仍按原语义显示。显示的控制归属使用已确认状态，不能把临时输入禁用解释成其他浏览器占有。

`suspendForAccountRefresh()` 提供不依赖当前准入的即时停止入口：先永久禁止该客户端的远程操作，再关闭 channel、取消在途请求并清除续约、回执、核对和重连 timer。已显示 Session、画面和本地草稿保留；在途操作按原规则收敛为 unknown，不自动重放。后续可见性通知和显式刷新不能恢复该客户端，本地编辑不因该入口新增锁定。普通隐藏及临时身份检查仍按原规则恢复；真正撤权、失效和关闭保留各自的清理语义。

状态读取与 channel 的控制观察不一致时，客户端暂停控制并通过有界的只读状态核对等待一致；不为消除分歧关闭 channel，因为关闭会释放该浏览器的 lease。隐藏或失去准入时取消核对，短暂身份检查使核对调度中断后由可见性同步恢复，真实读取失败沿用错误处理。

页面默认只读。当前认证用户只有与经过校验的 `owner.ownerUserId` 相同时，才能取得控制、续约、释放、处置初始提交、恢复自动执行或提交人工输入；其他具备项目访问权的成员保留实时观察与历史阅读。客户端在统一写入准入和租约可用性判断中核对 owner，服务端的空动作投影不能被原生 capability 或本人 holder 值替代。owner 属于控制确认身份，归属不一致时旧确认不能继续授权。取得控制、续约、释放、处置初始提交和恢复自动执行均通过严格 v2 请求，只有 Worker 确认状态才改变可用动作。文字粘贴与有限逻辑键使用原 Session、运行代次、connection/control epoch、段与终端绑定，不发送任意终端寻址或 resize。输入结果未知时保留原 operationId，只查询原操作，不重发原正文。浏览器写前保存不含输入正文的操作身份，刷新后恢复未知提示；用户明确核对后才允许新的人工操作，原回执仍保持未知。这项本地确认既不修改 Worker 的原结果，也不恢复自动执行。传输完成不代表 Agent 已受理。

运行隔离身份由 Session、claim、运行代次、connection epoch 和实际终端地址共同组成。`nativeSessionId` 是独立的单向补齐字段：相同运行身份内允许 `null` 补齐为已知值；已知值之后返回 `null` 的旧状态整条丢弃，另一非空身份则使客户端失效。首次状态读取、刷新和重新连接共用状态准入规则；重新连接仍等待 channel 确认后才允许控制。

同一运行身份内，control epoch 与 segment/frame 序号分别保持单调，身份补齐不能绕过任一检查。旧初始状态缺少 control 时，不能清除已经确认的控制状态。保留较新帧时同步合法补齐的原生身份元数据，避免画面与后续输入使用不同绑定。正常身份补齐保留未决操作、原截止时间和回执读取；真实运行、连接、终端地址或输入控制代次变化仍使原未决输入保持 unknown，并隔离迟到结果。

输入的 `leaseSeq` 在相同 leaseId/controlEpoch 下严格递增。原生身份补齐不会创建新租约，不能重置输入序号；只有租约身份变化才开启新的序号空间。

提交与后续回执查询共用从提交开始计算的 10 秒截止时间，pending 时主动检查也不延长它。超时中止请求并保留 unknown；即使底层传输没有响应取消，页面也会结束等待。unknown 后的显式回执检查使用新的 10 秒只读窗口，不重启原操作或自动重发。

经过身份和正文校验的提交响应若为 HTTP 409，且错误码为 `input_busy`、`stale_fence`、`lease_expired` 或 `automation_suspended`，表示该新操作在服务端操作账本写入前被明确拒绝。客户端显示 rejected、清除该 pending 身份并刷新当前控制状态；不查询不存在的回执，也不自动重试。用户之后另行操作时使用新的 operationId，并继续接受当前权限、lease 和 fence 检查。其他错误、未知冲突、正文校验失败和丢失响应仍保持 unknown；回执查询失败不能套用这项提交拒绝规则。

回执查询的 404 可能表示操作尚未写入，不能单独证明 Session 已失效。客户端在同一读取窗口内核对原 sessionId 的状态；原 Session 可访问时保留 unknown 和人工核对入口，不经 current 重定向。原 Session 的实际访问拒绝仍关闭查看与控制能力。迟到结果必须同时匹配查询代次、原操作和当前执行绑定，不能覆盖新操作。

任务暂停不禁止合法 owner 通过此页面取得、续约或释放控制，也不禁止满足原 lease、epoch 和目标检查的人工输入；这些动作不修改任务暂停属性。未知初始提交使用 `resolve_initial_assignment` 按原条件记录人工处置，仍保持 suspended。`resume_automation` 是另一项显式确认，要求任务已解除暂停且用户已处理终端草稿；它不能夹带未知初始提交处置。解除任务暂停不自动释放 lease 或交还控制。确认绑定打开时的运行身份与 control epoch，未知结果确认还绑定原 operationId；提交时重新核对当前客户端状态。控制身份或原操作改变后必须重新确认，正常画面更新和原生身份补齐不取消同一上下文的确认。旧环境未公布相应动作时，页面不尝试替代控制。

## 归档验证与播放

v2 reader 对固定归档状态、finalizationId、原始文件字节的 hash/size 和严格 schema 进行验证，再核对项目、任务、原 claim、Session、最终运行代次、服务源和完整性。共享 decoder 校验每帧、索引、段、gap 和停止归属。任一不一致拒绝展示，不跳过坏帧。

v1 历史沿用原格式及服务端文件 hash 校验；浏览器核对固定状态的 hash/size、正文身份和内嵌资源完整性。v1 的 HTTP JSON 包装会重新编码正文，因此不将重建 JSON 的 hash 冒充上传原始字节的 hash。

实时与回放共用受限文本 renderer，内容只进入文本节点，样式来自经过校验的有限字段。时间轴按段序号累计单调时长，使用 bigint 避免序号或时长取整。每帧独立，可直接定位；段内 gap 和段间边界都是播放节点，自动播放停在缺口，只有明确继续才读取下一段。partial 始终显示。缩放和终端内横向滚动支持窄屏与长行，不把长内容扩展到整个页面。`TerminalRecordingView` 的缩放字段采用[公共原生选择组件](native-select.md)的 `filter/content`，选项与本地受控缩放值保持原语义；公共组件拥有皮肤和箭头，播放器保留时间轴与画面比例。全屏中的原生缩放菜单按 Escape 时，只取消菜单并保留全屏与缩放值；共享 `useSessionFullscreen` 负责 popup、IME 和已消费事件判断，后续普通 Escape 退出并恢复原焦点。

## 验证边界

接口和客户端测试覆盖身份拒绝、权限、延迟响应、Worker 确认、未知输入以及不可变文件验证。播放器测试覆盖随机定位、段间与段内缺口、隐藏暂停和文本安全；现有 web Session 与附件回归继续执行。浏览器和跨层验证的具体 revision、环境及结果属于交付证据，模拟接口不代表原生 Provider 验收。
