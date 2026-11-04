# Herdr 严格终端输入与持久仲裁

本文拥有 macOS Worker 的输入派发、人工控制与交还机制。运行、进程出生身份和停止证明由 [Herdr 生命周期](herdr-worker-lifecycle.md)拥有；消息格式、租约与容量常量由 [Session v2 契约](../spec/session-v2.md)拥有。

## 范围与准入

所有 macOS Daynight 输入由同一 `HerdrInputArbiter` 派发：首次 assignment、自动 continuation、服务端转发的 paste/keys、终态 cleanup prompt。`durable.ts` 不调用 legacy `agent.prompt` 输入路径；`launch` 只启动进程，原 daemon、shell、native agent 的身份和运行 ledger 可靠提交后才开放输入。Linux/Windows legacy 与 Web Controller 保留各自既有路径。

Session 注册继续声明 `observe=false`、`control=false`、`archive=false`。输入组件与服务端消费接口可隔离验证，但录制、网页预览、最终归档和产品组合能力尚未满足，不能仅凭输入传输成功启用完整 Herdr Session。

## 按用途读取输入状态

`inspectHerdrInput` 先核对原运行、结构化 readiness、目标绑定及实际 PTY 几何，再按 `HerdrInputPurpose` 决定可见输入的用途。读取状态不 attach，不把界面判断当成 provider ACK。

| 用途 | 可见输入规则与 composer 事实 |
|---|---|
| `automatic`、`cleanup` | Codex/Claude 以 `format=text`、`strip_ansi=true` 读取，使用共享 `nativeInputBlocker`，只拒绝明确的菜单或禁用输入；自定义或未知正常布局不等待正向识别。返回 `composer: unavailable`，不伪造空输入证据。 |
| `manual` | 跳过可见界面排除，使 lease 持有人可以处理菜单；返回 `composer: unavailable`。原目标、lease、fence、进程和传输准入仍须满足。 |
| `resume` | 显式交还和干净正常退出后的自动恢复使用专用 `hasEmptyResumeComposer`，通过 `pane.read` 的 `format=ansi`、`strip_ansi=false` 保留 renderer 属性。只有当前支持的真实空字段证据才可返回 empty，菜单、草稿、未知或样式不明的布局拒绝；可选 model、cwd、状态栏不是条件。Copilot 继续报告 unavailable，保留其显式交还责任。 |

Codex/Claude 的非人工读取须确认原 pane/workspace/tab、请求的 source/format、字符串正文及未截断事实；读取失败或目标/几何变化不授予输入。读取后重新核对目标、结构化状态和适用的最终 claim/paused 授权。一个批次已经写入 paste 后，后续帧仍核验原目标、权限和 fence，不把该批次自己的正文当作新的人工草稿而拒绝。

## 持久状态与操作身份

`worker/herdr-inputs.sqlite` 使用独立版本、SQLite WAL/FULL、事务和 CAS。记录包含原 Session/claim、运行与连接代次、segment、terminal binding、控制代次、状态、租约、序号、输入来源和规范化正文摘要。操作结果与人工处置保留至执行封存并撤销写权限之后；没有短 TTL 清除或自动淘汰。

| 状态 | 允许行为 |
|---|---|
| `automation` | 准入有效时发送 pending assignment 或新的 continuation |
| `manual` | 当前持有者按 lease/epoch/严格递增 leaseSeq 输入；Detach 不交还自动执行 |
| `suspended` | 只读状态、重新申请 lease、显式交还 |
| `closing` | 拒绝普通输入；满足原条件时发送一次 cleanup prompt，然后受控停止 |
| `closed` | 永久拒绝输入 |

每次批次在原生写入前提交 `dispatching`；写入调用前同步标记可能已写。写前取消且确定没有调用原生 Input 才能 `rejected`。自动输入在零写入时遇到已知菜单/禁用输入，先持久保存 rejected receipt，首次输入保留 pending，再保留原 `HerdrInputBlockedError`；生命周期同步清除本次 admission，首次 assignment 同样投影为 pending。Coordinator 因而保持等待而不消耗执行恢复次数，菜单关闭后仍有原输入机会。相同异常若发生在已尝试原生写入之后，结果仍为 unknown，不能伪装成未发送的等待。写后错误、断线、超时或崩溃恢复均不自动重发。正常 `Detach` 回执仅对应 `transport_completed`，不证明 provider 接收、turn 启动或业务完成。已经写出的输入无法撤回。

生命周期与输入 journal 分别提交结果。若输入 receipt 已持久为 transport_completed、生命周期仍因提交间崩溃保留 unknown，恢复按 Session/claim、原运行/段/完整绑定、连接代次顺序及初始正文摘要核验该 receipt 后使用其已完成事实；不改写生命周期的历史 unknown。输入 journal 自身结果未知、缺失或归属不符仍禁止恢复。

首次 assignment 有跨运行不变的身份和正文摘要。一次确定未写的失败保留其 rejected receipt；只有 pending 且自动准入再次有效时才生成新的持久尝试 ID。服务端接受原受校验 Worker 的 `dispatching → pending` 状态投影，使零写入拒绝之后的 heartbeat 保持通道可用；零写入证明由输入 journal 的 rejected receipt 承担。服务端不能把 `unknown`、`unconfirmed` 或 `transport_completed` 退回 `pending`，这项投影也不能将 suspended 恢复为 automation。未知尝试不会轮转 ID，也不因 idle、重启或释放 lease 重发。其他操作重复 ID 仅返回原结果；同 ID 异正文拒绝。

旧生命周期存在但输入 journal 缺失时按 `unconfirmed` 接入，不推断可继续自动输入。生命周期中的原始首次结果继续保留；人工选择 `delivered_continue` 单独记录 actor、operation 和时间，不修改 unknown 操作结果。现有 v2 `control_state.initialAssignment=transport_completed` 在这项处置后投影为可继续的进度；它不是对原 unknown 操作的 provider ACK。

## 人工控制与交还

获取 lease 只做原身份、任务权限和可用原生状态的读取，不 attach。批次进行中返回 `input_busy`，不会排队等到首次输入完成再悄悄授予。租约 TTL 为 30 秒，调用方每 10 秒续约；Worker 使用本进程单调时限，重启撤销旧 lease。普通释放、失联、隐藏页签的服务端撤权和超时均保持 suspended。

交还要求当前 fence/controlEpoch、无在途批次、明确 `draftHandled`、原生 readiness 和 `resume` 用途的输入检查。resume 使用保留 ANSI 属性的可见读取。Codex 需要当前非 DIM 的正常 prompt glyph、renderer DIM 的精确空占位符、下一空输入行及正常键盘 footer；允许一个不要求特定内容的状态行。占位文案本身不足以证明为空，相同字面的普通样式草稿、多行草稿、未知控制或样式均拒绝。RGB/indexed color 的参数值不能被当成 DIM。Claude 只接受真实空白的 bordered prompt field 及正常 footer，含 Try 文本的歧义字段拒绝。不要求 model、cwd 或状态栏；未知界面与草稿不能因自动输入布局限制已移除而被当成空字段。这是受限样式与字段几何观察，不是通用 ANSI 终端框架。Copilot 没有可用的通用空 composer 证明，记录为 unavailable；其人工草稿责任必须由显式交还承担，native idle 不会自动解除 manual/suspended。系统不擅自发送清空草稿快捷键。

服务端控制请求包含原 actor 与请求摘要，Worker 持久提交状态和关联 ACK 后才回传。每次实际写入前再读取服务端 Session 状态、任务权限和原进程证明，已撤 lease、旧连接或控制代次不能借轮询间隔迟到写入。

交互仍就绪且无 pending launch 的 `done` 可以表示已完成 turn，允许 continuation；非交互就绪的 `done` 禁止输入。自动输入与 cleanup 使用已知阻塞排除，不要求正向空 composer；交还与干净自动恢复保留各自的真实空字段检查。原目标和进程身份仍须核验，不能把 turn 完成当成进程退出或跳过准入。本地 Herdr TUI/API 仍可能并发输入，这不是全局键盘互斥。

## 严格原生传输与几何

`terminal-input.ts` 支持明确验证的 Herdr 0.9.5/protocol 22 布局。先核对 Hello/Welcome，再执行 `AttachTerminal(terminalId, takeover=false)`，等待完整基线和键盘模式。目标不存在直接拒绝，不按 pane 或 agent 名称回退。未知消息布局、版本、键盘模式或失效目标禁止输入。

paste 使用独立、完整的 bracketed-paste Input frame；Enter 为另一帧，每帧之前重新核对准入。仅支持 Session v2 的有限按键白名单，不接收任意转义字节、mouse 或 resize。单批 paste 最多 16 KiB UTF-8，总时限 10 秒。自动 prompt 同样受此上限限制，超限不截断。

API layout 或观察帧不能证明实际 PTY 尺寸。Worker 从原 pane 的 `process_info` 获取 shell PID/TTY；本机缺失 TTY 字段时，通过原 shell 的 `ps -o tty=` 读取，再只读执行 `stty -f <tty> size`。原进程出生身份与 API/client 两个 socket peer 在读取和写入准入时再次核对，尺寸或 TTY 变化拒绝。实际 attach 仍可能重应用尺寸或恢复 pending agent，因此 launchPending、未知 native 状态与非受管 foreground 禁止输入。拒绝结果只说明没有写 Input，不代表 attach 没有副作用；Detach 也不保证恢复旧尺寸。

## 连接与停止

准备运行使用 HTTP 注册；活动运行和段登记完成后，使用同一持久注册意图建立 Worker WebSocket。ACK 由生命周期 owner 提交之后才激活分派。每 10 秒发送控制状态并读取服务端撤权状态，socket 断开撤销本地控制；未知注册或消息不自动重放。实际运行 generation 与普通 connectionEpoch 分开，旧连接不能接管新运行。

cleanup 首先同步提交 closing、提升控制代次并撤销 lease，再中止旧批次。尚未写出的输入取消；已经写出的只能保留原结果或 unknown。只有此前处于 automation、无人工草稿风险/未知输入、没有在途批次且结构化状态就绪、没有已知菜单或禁用输入时，才通过同一仲裁器发送一次 cleanup prompt。其他情况跳过提示并继续原实例受控停止；外部临时资源可能因此无法由 agent 及时收尾。

正常 shutdown 的干净自动状态与人工 suspended 状态分别持久保留。输入 journal 保存每次原始 prepare 和消费请求，不覆盖旧请求。Worker 先同步持久 closing 并中止输入，在旧通道关闭前先确认已补齐 nativeSessionId 的原运行账本，再发布最后已确认的干净 automation 状态、读取服务端确认，再以原 control/connection epoch 和 stopOperationId 请求 `automation_recovery_prepare`。状态读回比较 connection/control epoch、state、lease、initialAssignment 和安全原因；availableActions 是能力过滤后的展示结果，不参与恢复授权比较。服务端同事务冻结旧控制为 closing 并保存单次许可；没有原在线控制、初始完成结果、无 lease/未决操作和当前授权就拒绝。

停止证明登记后，下一代必须仍为相邻代次和同一已知 native conversation。Worker 重新核对原进程、readiness 与 claim，并执行 `resume` 用途的真实空字段检查，再持久保存 `automation_recovery` 请求；服务端核验旧许可、对应 stopProof 和当前连接后一次性恢复 automation。Worker 读取匹配回执与当前服务状态，持久同步 controlEpoch，才允许 continuation。shutdown 准备和恢复期间的通道 hold 只暂停状态轮询；断线、过期、新派发和身份变化仍禁入。许可准备使用独立、最多 10 秒的总预算，保留原停止操作的剩余时间；许可服务不可用不消耗全部原生停止时限。

prepare 或消费响应丢失只读原 recoveryId 的回执；没有已确认结果就不重发、不发送 continuation。旧消费回执只描述当时的 connection/control epoch，不能授权后来的重连。普通断线、manual/unknown、终态 cleanup、缺许可或旧服务不支持新消息均保持 suspended，不能凭 native idle、停止证明或本地 automationBeforeClosing 解除。缺失恢复许可不阻止原运行受控停止。终态资源仍受生命周期停止证明与归档门禁约束，不能因输入通道关闭而删 worktree。

## 验证边界

真实 SQLite 与 socket 测试覆盖崩溃恢复、幂等、lease/epoch 竞争、未写与已写取消、cleanup 撤销、自动/清理/人工/交还的用途分离，以及 Web/legacy 回归。自动输入的未知正常布局放行、已知阻塞零写入持久等待、首次 pending 投影、写后未知结果不重放，与交还拒绝未知/草稿、区分 DIM 占位符与相同字面的普通样式正文、拒绝多行/歧义样式及 RGB/indexed color 伪 DIM、接受真实空字段分别验证。macOS 三 provider 的隔离界面验证覆盖 Unicode、多行 paste、Enter/Escape/Ctrl+C/方向键、同名错误目标和实际 PTY 尺寸。模拟协议、原生界面验证和完整产品组合验收是不同证据，不互相替代。
