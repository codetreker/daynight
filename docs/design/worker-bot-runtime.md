# Worker Bot 执行层设计

[需求](../spec/worker-bot-runtime.md)定义启动、维护和恢复保证，[决策记录](../../.agents/notes/implemented/architecture/2026-11-05-worker-bot-runtime.md)说明隔离、共享机制与停证取舍。

## 数据与句柄

`bots/store.ts` 保持冻结定义和首次注册意图；`bots/execution-store.ts` 在同一个 Worker SQLite 中维护独立 `bot_executions` 表。`009-bot-executions.sql` 引入执行证据；`010-bot-recovery.sql` 将 Worker 格式升级到 10，为旧意图补充当前 `controllerInstanceId`，并初始化恢复计数、正常关停来源、阻止原因、前代停证及保留路径。旧 Worker 拒绝打开不理解的格式，不能忽略恢复字段后重复启动。

执行行按服务、账号、Worker、Bot 隔离。首次 `registration` 保持不变，`intent.controllerInstanceId` 表示当前代 Controller；换代只改变当前 generation、launchId、Controller instance 和对应 ticket 路径。Session、testExecutionId、initialOperationId、已知 native ID、角色及冻结配置延续原身份。

执行写入在即时事务中重新核对库存中的当前 intent。未知提交不能回退为未提交；同代已知 native ID 与进程出生证明不能更换或丢弃。`beginRecovery` 同时更新库存意图与执行证据，避免崩溃后出现新 intent 配旧代提交状态。它要求原代完整 stopped snapshot、native ID、Controller process proof 与允许的恢复预算，保存前代停证及原 launch/别名路径后，产生一个未提交的新目标。普通 patch 不能修改恢复计数或关停来源。

删除投影不会删除这些责任。Task 表、maxConcurrent、收尾期限和容量计算不读取 Bot 执行行；保留的私有路径也不授予删除普通 cwd 或共享 native home 的权限。

## 启动与授权

`createBotProcess` 按 Bot 串行化启动、续期和停止。首次预检先验证参数及目标配置环境，再持久化身份和 `selectBotRole` 选择的角色。这样预检失败报告导致的 Bot 版本递增不会提前固定一个失效的注册版本。

`bots/session-api.ts` 用 Worker 正常 PAT 调用 Bot register/grant/report；响应必须携带相同账号，字节数与请求时间有界。注册传递首次 `botVersion`，之后的 grant/report 使用当前观察版本。HTTP 客户端不自动重复 POST；运行时先 GET 原 Bot，再核对或继续原请求。ready 报告前读取服务端 Session，核对完整 fence、同步状态和 native identity。

ticket 复用 Controller 的私有不可变 launch 文件和原路径规则，为独立 Session，不含 Task/claim/worktree，角色与初始输入分别编码。Controller 自身仍负责 Provider 适配与原生权限。准备出的环境和别名责任保留到原执行停止；提交前失败可以释放当前准备资源，提交后未知结果不能清理仍可能使用的目录。

`backends/controller-process.ts` 被 Task 与 Bot 实际共享：日志准备、持久提交回调、detached spawn、process proof、认证 IPC 观察和按执行串行化。Task 的 worktree、claim、cleanup prompt、归档及回收仍由原 backend 持有。明确 OS 启动拒绝先持久化，再报告服务端；Provider 快速拒绝后 IPC 可能已关闭，此时只允许读取同 fence 的 journal 失败证据，旧 ready 记录不能作为当前在线证明。

## 原会话恢复

对已提交执行，先用原 ticket 观察 Controller。可观察且仍在 starting、ready 或 working 的执行继续复用，并撤销先前未完成停机的来源标记，避免后来异常退出获得正常重启豁免；无法观察时读取同一 journal 和持久进程证据。恢复路径不为了获得停证主动杀死一个可能存活的 writer。`confirmControllerProcessesStopped` 核对原进程实例及所属进程组或 Windows Job Object，随后通过 journal 的停证写入和 snapshot CAS 固定原 generation 已停止。缺失证明或 native ID 时保留责任并报告，不能新建空白会话。

`beginRecovery` 将正常关停与异常恢复区分。`markShutdown` 只从停止前新鲜、健康的认证观察建立 `restartAfterShutdown`，既有阻止原因不允许该标记覆盖。异常换代递增 `recoveryCount`，正常来源且 stopped snapshot 没有 error 时不递增；两条路径均不重置此前异常次数。达到预算的健康执行仍可正常停止和恢复，异常停止则持久阻止继续恢复。

新目标写入后重新验证 CLI owner/server 和运行环境，恢复 ticket 沿用前代 native home，固定 `resumeNativeSessionId`，保持 `initialInput: "none"`。同一 journal 继续持有旧操作及回执；不会因重启再调用旧用户操作。旧 ticket 和各代别名目录保留为精确清理输入。

grant 接收持久前代的 generation、Controller instance、recordId 和 stoppedAt。客户端先检查直接相邻代、不同 instance、已知 native ID 和完整停证，再读取服务端原 Session。服务端仍是精确前代时，提交 `previousGeneration` 和 stopProof；已是目标代时，只提交目标 fence 的 reconnect grant。未知响应不改变目标身份；其它代、instance 或 native ID 一律拒绝，服务端仍执行版本、权限和 fence 检查。

## 发现、授权维护与退出

`createManagedAssistantRuntime` 提供单轮 `tick`、持续 `run` 和显式 `shutdown`。持续发现调度独立的每 Bot 工作，正在启动的 Bot 不重复进入；发现循环不等待慢启动完成，因此其它 Bot 仍可被发现。每次启动及结果报告读取权威单项；清单失败保持旧库存但不启动陈旧定义。

通用 `maintainControllerGrants` 同时供 Task 和 Bot 使用，按执行隔离错误并抑制重复诊断；每个执行最多一个在途刷新，慢执行不延迟其它执行下一轮调度。Bot 的维护循环与发现循环并行运行，续期前检查当前绑定和凭据有效期，在相同 generation 下更新私有凭据文件。

取消 `run` 或显式 `shutdown` 先关闭调度并取消在途管理操作，等待发现、续期和启动 job 全部结束，再对本地责任清单中每个 Bot 进行有界停止。停止不依赖远端可用性，按原 ticket 尝试 IPC stop，并通过原进程证明停止进程树；IPC 回执或 timeout 单独不决定结果。恢复子进程可能已提交，而共享 journal 尚未替换前代 snapshot；此时不把前代 snapshot 当作当前原生进程证据，仍依据父进程已保存的当前子进程出生证明尝试停止。当前代 journal 停证缺失仍报告失败并保留责任，不能借前代已停止状态宣称完成。OS 确认与 journal 停证完成后才返回成功，不调用 StopTest、归档、cleanup prompt 或删除接口。每个 Bot 独立完成停止尝试，全部错误一并交给调用方；stores 与 Worker 实例锁必须保留到这些尝试完成。

`shutdownWorkerExecutions` 汇总 Task 和 Bot 的执行所有者，等待每项停止尝试并保留失败。Task 退出仍由 coordinator 和原 backend 完成，不把 Bot 停机规则注入 Task 归档及容量逻辑。正式 `runWorker` 尚未启用 Bot 调度或 `assistantHost` 广告；调用者的组合及 Bot 精确删除仍由各自生命周期入口负责。
