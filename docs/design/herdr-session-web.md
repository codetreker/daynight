# Herdr Session 页面与只读回放

## 页面与身份

`TaskSessionHost` 按任务生命周期承接共同入口，不保存执行记录选择。活动 Web claim 使用 `TaskAgentSession`；完成的 Web claim 通过 native current 解析原 Session，再交给固定归档阅读器。旧 Herdr claim 无论状态如何，仅在 history 分页中按原 claimId 和模式精确匹配；空页有 cursor 时继续读取，全部耗尽仍无匹配则显示不可用。重复 cursor 是协议错误。Web 不连接旧终端或提供控制、输入，不能用其他 claim 的记录替代。没有 claim 时，主入口使用目录首个实际条目作为只读历史。

`FixedSessionRecording` 接收原 sessionId、claimId、executionGeneration 和模式；历史条目的归档元信息也是校验约束。固定归档读取不创建实时连接，pending 状态通过有界间隔的只读请求继续观察。Web current 仍为 active/draining 时暂时 unavailable 表示尚在准备；current 确认 archived 后 unavailable 保持终态和人工刷新入口。后台检查保留已有阅读器和已验证内容；实际身份、归档状态或权限变化分别处理，权限拒绝撤下内容。Web 归档沿用按账号和 Session 绑定的 Display 偏好，Herdr 使用终端回放。主入口只移除本功能拥有的旧选择键，草稿与其他会话存储保持各自所有权。具体取舍见[只读历史决策](../../.agents/notes/implemented/simplification/2026-11-17-web-terminal-history.md)。

普通附件继续使用原文件树、上传和删除流程。受管 Session 记录在同一侧栏中独立于文件树展示。记录目录与确认空结果按用户、项目和任务持久缓存，打开或重新激活时复用合格缓存并后台重读首页；历史 API 没有目录版本合同，任务业务版本不决定目录是否新鲜。确认空目录在后台刷新期间继续隐藏，有记录时保留可读内容，内容变化后更新。首次未知状态提供加载提示；空首页仍有 nextCursor 时，只有全部后续页耗尽才能独立确认完整空目录，缓存保留原首页与 cursor 及该空证明。重读已确认空目录时，若首页仍为空且有 cursor，后台继续读取后续页，直到发现记录或真正耗尽。读取失败不作为空结果保存，已有内容保持可读并提供重试，首次失败也有可恢复入口。缓存仍可读但刷新或分页事务写入失败时保留已有内容、显示可恢复错误，不发布无法排序的新成功响应；完全不可读写时沿用下述有限降级。direct 目录仅在实际 principal 已核验的拒绝或现有 401 会话失效路径中撤回内容并传播负向提示；可信拒绝的错误正文畸形仍保留其 HTTP 状态语义。不同、缺失或畸形 principal 是协议错误，不能依据其状态撤回目录或通知其他读取者。完成任务的自动 Session 发现遇到可信不同 principal 时通知账户 owner 并丢弃该结果，不改变已有选择或发布错误。缓存和响应通过共享身份及项目生命周期准入；正常存储时旧 scope、撤权或过期请求不能重新发布内容。存储完全不可用时，跨标签提示和重启后的撤权记忆有[有限降级](daynight-task-sync.md#5-indexeddb-与去重)。缓存只用于目录展示，不能授权实时连接、控制或归档正文。具体取舍见[记录目录缓存决策](../../.agents/notes/implemented/architecture/2026-11-05-session-records-cache.md)。

历史存在与归档 ready 是不同条件，pending、failed、unavailable 记录也保留入口。附件中的记录选择使用原阅读区打开只读记录，不能借普通附件操作覆盖、删除或重命名权威归档。两类内容共用阅读区的可用高度，避免短窗口中的正文被额外记录区域挤空。普通附件预览在回放时保持挂载并隐藏、禁用交互，上传草稿与 iframe 状态保留；选择普通文件、上传成功或导航到附件时退出受管记录选择。

## Task Current 的实际读取时机

Task 详情仅在所选 Session tab 且文档可见时发起完整 native current，未选中的 native reader 保持挂载且健康 channel 保留。完成 Web claim 的 current 发现和旧 Herdr claim 的历史发现均在身份准入后及每次等待后检查可见性和请求归属；隐藏取消读取，未 settle 的请求保留名额，迟到结果不能发布到新 owner。无 claim 时用于确定入口存在性的目录读取保持独立规则。具体 native 读取职责见[Task Current 设计](task-session-protocol.md#task-current-的读取可见性)。

## 归档验证与播放

v2 reader 对固定归档状态、finalizationId、原始文件字节的 hash/size 和严格 schema 进行验证，再核对项目、任务、原 claim、Session、最终运行代次、服务源和完整性。共享 decoder 校验每帧、索引、段、gap 和停止归属。任一不一致拒绝展示，不跳过坏帧。

v1 历史沿用原格式及服务端文件 hash 校验；浏览器核对固定状态的 hash/size、正文身份和内嵌资源完整性。v1 的 HTTP JSON 包装会重新编码正文，因此不将重建 JSON 的 hash 冒充上传原始字节的 hash。

回放使用受限文本 renderer，内容只进入文本节点，样式来自经过校验的有限字段。时间轴按段序号累计单调时长，使用 bigint 避免序号或时长取整。每帧独立，可直接定位；段内 gap 和段间边界都是播放节点，自动播放停在缺口，只有明确继续才读取下一段。partial 始终显示。缩放和终端内横向滚动支持窄屏与长行，不把长内容扩展到整个页面。`TerminalRecordingView` 的缩放字段采用[公共原生选择组件](native-select.md)的 `filter/content`，选项与本地受控缩放值保持原语义；公共组件拥有皮肤和箭头，播放器保留时间轴与画面比例。全屏中的原生缩放菜单按 Escape 时，只取消菜单并保留全屏与缩放值；共享 `useSessionFullscreen` 负责 popup、IME 和已消费事件判断，后续普通 Escape 退出并恢复原焦点。

## 验证边界

接口和客户端测试覆盖身份拒绝、权限、延迟响应、分页发现以及不可变文件验证。播放器测试覆盖随机定位、段间与段内缺口、隐藏暂停和文本安全；现有 web Session 与附件回归继续执行。浏览器和跨层验证的具体 revision、环境及结果属于交付证据，模拟接口不代表原生 Provider 验收。
