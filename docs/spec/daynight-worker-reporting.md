# Worker 运行快照上报

本文定义 `daynight worker run` 作为运行快照生产者的行为。[整体需求](daynight-worker.md)拥有执行与资源生命周期，[快照接口](daynight-worker-snapshots.md)拥有报告格式及服务端时间规则，[采集与调度设计](../design/daynight-worker-reporting.md)拥有客户端机制。

## 身份、范围与时机

Worker 复用已持久化的稳定 workerId、实例锁及启动时固定的认证账号。运行资源与认证就绪后立即触发报告，随后每 30 秒独立触发；成功取得完整自有 claim 清单和确认新 claim 也触发报告。报告不等待候选任务查询、执行 tick 或原生任务结束。空闲、满并发、较大的 pollIntervalMs 和 tick 内长操作均不停止定时报告。

报告在 Herdr 和 Web 执行模式中使用同一机制。采集 Herdr 版本只观察私有端点，不能启动 daemon、调用 ensureInstance、修复 integration 或初始化延迟的 Herdr 执行 backend。纯 Web Worker 无须安装或启动 Herdr。

CLI 将当前运行包的 version 及启动时捕获一次的绝对 workingDirectory 显式交给 runtime。磁盘只表示该目录所在文件系统；不使用任务 worktree、repositoryRoot、home 或系统根目录代替。上报没有独立公开命令或配置开关，也不修改任务、claim、凭据或执行资格。

## 调度、期限与关停

同一进程最多进行一次报告尝试，并合并最多一个待执行触发。进行中的尝试结束后，待执行尝试重新采集；多个触发不积压报告正文。单次尝试总预算 15 秒，其中采集最多 5 秒、HTTP 最多 10 秒。探测命令的终止、进程树清理及输出流关闭等待计入采集预算。

失败后等待后续触发，以新的观测发送完整报告。HTTP 写入结果未知时不重放旧请求。单个字段失败仍可上报其余字段；采集整体失败、传输失败、响应格式或 principal 校验失败使该次报告失败，不改变任务执行。

退出先停止触发、取消并等待进行中的尝试收尾，再进入既有任务资源、存储、日志和实例锁的清理。超时本身不能证明原生进程已退出；无法确认命令收尾时保留原始错误用于退出失败，并禁止本进程为该工具启动替代探测。其他字段及后续部分报告继续工作。

## 采集口径

每份报告包含 sampledAt；每项 Probe 包含 checkedAt。字段状态使用快照接口规定的 `ok`、`error`、`not_installed` 和 `not_running`，错误携带闭合 code，不用空值或旧成功伪装新结果。

| 字段 | 必须报告的事实 |
|---|---|
| OS | Node OS API 的 type、release、version、arch；系统及内核文本不推断为发行版名称 |
| CPU | 实际型号、逻辑处理器数及所有逻辑处理器累计计数的差分使用率；首次同样经过约 200 毫秒的两次真实采样，不伪造为 0，不推断物理核心数 |
| 内存 | totalmem 与 totalmem-freemem，单位为 bytes |
| 磁盘 | 启动目录文件系统的 `blocks*bsize` 总量和 `bavail*bsize` 可用量，单位为 bytes；可用量表示调用身份可用空间 |
| Daynight | 当前运行 CLI 包注入的版本 |
| Herdr | 当前私有 daemon 的只读 ping 版本；端点确证不存在或拒绝连接为 not_running，权限和协议错误保持 error |
| Codex、Copilot | Worker 原生环境中纯 `--version` 的版本；仅确证 executable 不存在为 not_installed，权限、命令、输出或超时故障为 error |

资源计数必须是非负安全整数，容量关系和 CPU 差分必须有效。越界、未推进或不一致的采样明确失败，不使用截断值。磁盘计算先使用 bigint，再验证可精确表示范围。底层 statfs 无法取消；某次超时后最多保留一个未完成调用，之后的磁盘探测在其完成前报告 timeout，不继续排队 I/O 或追加等待监听。

Codex/Copilot 的成功、缺失及失败结果在进程内最多缓存 60 秒，并保留原 checkedAt；到期探测失败替换旧成功。版本展示不执行启动 preflight 的最低版本或功能要求，已安装但版本较旧的 CLI 仍报告实际版本。Herdr 每次报告重新 ping，不复用旧实例版本。

## 任务观测

报告复用 coordinator 的成功完整自有清单，不增加 inventory 请求或 SQLite 字段。清单只传不可变的 `{projectId,taskId,claimId}` 引用与原 observedAt，服务端提供权威标题、项目名、状态、阶段和 agent。

首次完整清单成功前为 `taskInventory:null`；成功观察到无任务为 `{observedAt,claims:[]}`。清单同步失败保留最近一次成功清单及其时刻，不把失败解释为空闲。恢复清单不按 maxConcurrent 截断。

确认新 claim 后立即触发；已有完整观测时，按 taskId 将确认的引用加入该观测，并保留完整清单原 observedAt。完整观测尚未知时仍保持 null，新 claim 不构造未经完整同步的清单。

## 传输与诊断

客户端使用现有 typed ApiClient 和认证准入向 `POST /api/v1/me/workers/{workerId}/report` 发送完整报告，只接受 `200` 与有效的 `{observedAt,lastReportedAt}`，并验证既定账号。在线状态由服务端最后有效报告时间决定，客户端 sampledAt 或定时器触发不能续活。

日志对采集字段和传输分别记录故障状态转换及恢复；连续相同故障不重复输出。诊断只暴露清洗后的阶段、子系统、闭合 code 和错误类别，不记录原生命令、stdout/stderr、环境变量、完整遥测或凭据。原始错误仅在内存保留，供清理失败传递，不参与日志或跨进程恢复。

## 验证

调度验证覆盖即时报告、独立周期、长 tick、空闲与满并发、合并触发、单飞、取消和关停。清单验证覆盖初始未知、真实空清单、部分读取失败、超并发恢复及新 claim。采集验证覆盖首次 CPU、单位与安全整数、启动目录磁盘、未完成 statfs、版本缓存和过旧已安装版本；原生清理失败不得引起替代探测积累。

实际平台采集验证使用真实 OS、CPU、内存、statfs 及原生版本命令，分别记录 Linux、macOS、Windows 的环境与状态。fixture 证明分支行为，不能代替实际平台结果；完整原生执行、恢复与业务交付仍遵守整体 Worker 验收边界。
