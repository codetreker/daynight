# Worker Bot 执行层设计

[需求](../spec/worker-bot-runtime.md)定义启动和维护保证，[决策记录](../../.agents/notes/implemented/architecture/2026-11-05-worker-bot-runtime.md)说明隔离及提取取舍。

## 数据与句柄

`bots/store.ts` 保持冻结定义和首次注册意图；`bots/execution-store.ts` 在同一个 Worker SQLite 中维护独立 `bot_executions` 表。迁移 `009-bot-executions.sql` 将格式升级到 9，使不理解提交证据的旧 Worker 拒绝打开。执行行按服务、账号、Worker、Bot 隔离，记录 launch/execution/generation、单调提交状态、原 Controller process proof、最新 snapshot、初始化事实、别名目录与错误。

执行写入在即时事务中重新核对库存中的原 intent。未知提交不能回退为未提交；已知 native ID 与进程出生证明不能更换或丢弃。删除投影不会删除这些责任。Task 表、maxConcurrent、收尾期限和容量计算不读取 Bot 执行行。

## 启动路径

`createBotProcess` 使用按 Bot 串行化的启动与续期操作。首次预检先验证参数及目标配置环境，再持久化身份和 `selectBotRole` 选择的角色。这样预检失败报告导致的 Bot 版本递增不会提前固定一个失效的注册版本。

`bots/session-api.ts` 用 Worker 正常 PAT 调用 Bot register/grant/report；响应必须携带相同账号，字节数与请求时间有界。注册传递首次 `botVersion`，之后的 grant/report 使用当前观察版本。HTTP 客户端不自动重复 POST；运行时先 GET 原 Bot，再核对或继续原请求。ready 报告前读取服务端 Session，核对完整 fence、同步状态和 native identity。

首次 ticket 写入复用 Controller 的私有不可变 launch 文件和原路径规则。ticket 为独立 Session，不含 Task/claim/worktree，角色与初始输入分别编码。Controller 自身仍负责 Provider 适配与原生权限。准备出的环境和别名责任保留到原执行停止；提交前失败可以释放当前准备资源，提交后未知结果不能清理仍可能使用的目录。

`backends/controller-process.ts` 被 Task 与 Bot 实际共享：日志准备、持久提交回调、detached spawn、process proof、认证 IPC 观察和按执行串行化。Task 的 worktree、claim、cleanup prompt、归档及回收仍由原 backend 持有。Bot 的已提交状态只读取原 ticket 并观察，不隐式恢复、不重发消息。明确的 OS 启动拒绝先持久化，再报告服务端；报告响应未知后可核对并补报。Provider 快速拒绝后 IPC 可能已关闭，此时只允许读取同 fence 的 journal 失败证据；旧 ready 记录不能作为当前在线证明。

## 发现与授权

`createManagedAssistantRuntime` 提供单轮 `tick` 和持续 `run`。持续发现调度独立的每 Bot 工作，正在启动的 Bot 不重复进入；发现循环不等待慢启动完成，因此其它 Bot 仍可被发现。每次启动及结果报告读取权威单项；清单失败保持旧库存但不启动陈旧定义。

通用 `maintainControllerGrants` 同时供 Task 和 Bot 使用，按执行隔离错误并抑制重复诊断；每个执行最多一个在途刷新，慢执行不延迟其它执行下一轮调度。Bot 的维护循环与发现循环并行运行，续期前检查当前绑定和凭据有效期，在相同 generation 下更新私有凭据文件。已知 native ID 从持久 snapshot 带入 grant 核验，不能从新的远端身份推断原 writer 已被替换。

`run` 的调用者持有实例锁并负责启动、取消、等待和关闭 stores。取消循环不会 StopTest、归档、删除或声称停止原生执行。正式 Worker 启用、原会话恢复和删除清理依赖后续生命周期集成；本模块提供其所需的原 ticket、观察与持久证据。
