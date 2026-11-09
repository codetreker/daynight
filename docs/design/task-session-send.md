# Task Session 发送与恢复机制

## 职责与现有协议

CLI 消费 [Session inspection](task-session-observation.md) 冻结原目标，通过既有 commands HTTP 入口发送普通 send_message。Go Session 核心拥有 Submit、意图哈希、owner、活动/连接/回合校验和派发；HTTP 与 MCP 只适配各自输入输出。完整行为由[规格](../spec/task-session-send.md)所有。

Submit 的意图包含 Session execution fence、operationId、kind 与规范 payload，expectedTurnId 和精确正文均在 payload 内；requestId 不作为幂等身份。相同 operation 与意图返回原 receipt，不能重新装载旧正文或恢复队列。连接 epoch 属于 Controller 连接租约，发送继续沿用现有 execution fence，避免把连接观察字段误加进严格 command wire。

## CLI 恢复文件

恢复记录位于 `DN_CONFIG_DIR/session-operations/<originHash>/<actorId>/<operationId>.json`。origin 先规范化，actor 来自真实认证身份；记录内同时校验这些身份和原目标，不能只信目录名。记录是严格、版本化的最小元数据，正文只保留 UTF-8 SHA-256。安全的 receipt 枚举与身份可以持久保留，任意正文、凭据和错误文本不进入该记录。

发送按同一 actor/origin/ID 加锁并重新读取记录，防止两个进程同时判断为首次。已有记录只允许核对后查询。首次发送的顺序为：

1. 校验正文和完整 command 容量，验证调用者与原目标的发送资格。
2. 私有创建并验证所需目录，持久写入 prepared。
3. 持久替换为 dispatch_unknown。
4. 至多一次 POST；已确认 receipt 可更新本地最小事实。

每次替换使用同目录独占临时文件，完成写入与权限检查后同步文件、原子 rename，并同步父目录；新建目录及其父条目同样需要屏障。rename 成功而目录同步失败时，保留可能可见的最终记录，本次不发请求，未来也只查询。文件锁释放和临时文件清理不能删除防重证据。读取原操作不需要取得新的派发许可。

POSIX 用实际 owner、0700 目录与 0600 regular file 验证私有性。Windows 使用本机当前用户 SID 的受保护 DACL，在创建时附加并从句柄验证；文件 flush、同卷 write-through rename 和父目录同步由原生 API 完成。不能用 Node mode 参数或省略目录同步代替保证。底层环境无法完成权限或同步时明确失败，发送次数保持零。

## 等待、输出与错误

首次请求、恢复查询和等待都保留同一个 operationId。每次 GET 使用原资源路径；轮询使用单调时钟的剩余预算约束在途请求。网络失败和查询不存在不会创建新 ID 或触发 POST。

CLI runtime 的 known-session-operation 输出与普通读取、confirmed-mutation 分开。它保存真实操作事实与最终退出码，允许等待取消后使用独立 5 秒预算输出原身份；输出失败返回失败并保留可恢复诊断，不把未知状态包装为成功写入。文本按行转义控制字符，机器结果不混入进度日志。

## 历史 receipt 与 OAuth

原 Task operation 查询按原 project/task/session 读取持久 receipt，验证当前凭据与项目访问，计算 currentBinding；它不依赖原 claim 仍为当前，不执行过期归档写入或队列恢复。原生结果保持原 Session 身份，不能从新的 current 合成。

OAuth 按操作用途进入 Task send_message 或 receipt 作用域。提交与派发均使用真实 Actor，派发还检查持久凭据当前的 token、grant、scope、有效期、撤销、项目成员与 owner。每次凭据检查先取 grant 共享锁，再取 access-token 共享锁，最后用独立语句与数据库时钟重新检查完整凭据状态。准入仍先完成凭据与项目授权，再加载 Session；派发在持有 Session 锁时重新检查原 Actor。

Refresh 轮换保留尚未过期的旧 access token。同一 family 内的共享 grant 锁让撤销在删除任何 token 前等待准入事务，避免撤销已经删除旧 token、等待新 token 时与 Session 锁形成循环。排队的撤销不阻止兼容的派发共享锁；撤销提交后，旧、新 token 均不得再次准入。并发回归通过真实轮换与 PostgreSQL 锁等待屏障验证这一协议，具体取舍由[锁决策](../../.agents/notes/implemented/bug-fix/2026-11-10-task-oauth-family-locks.md)记录。

MCP 的发送成功元信息保留服务写入结果、阶段和 refs；原生状态仍位于 data.operation.state。读取 not_found 保留错误码和原 refs，明确它不能证明原操作未发送。HTTP 202、MCP committed 和 Provider 接受分别由自己的所有者证明。
