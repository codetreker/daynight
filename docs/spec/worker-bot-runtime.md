# Worker Bot 启动与授权维护

Bot 执行层消费[持久库存](worker-bot-inventory.md)与[角色及环境](bot-role-environment.md)，提供普通目录内的独立 Controller 启动、原身份观察和授权维护。调用者持有 Worker 实例锁，使用当前服务、账号与 Worker 绑定；Bot 不占 Task `maxConcurrent`，不创建 Project、Task、claim 或 worktree。

## 启动与身份

首次预检成功后，先持久化注册身份和角色全文、revision、digest，再提交 register。首次请求的版本、配置和角色不得因重试或 Worker 升级改变。服务端同一事务冻结角色并绑定 Session；响应未知后先读取原 Bot，已经绑定时核对原执行，尚未绑定时仅可重放同一注册身份和指纹。缺失本地身份的已绑定 Bot 不创建替代会话。

Controller ticket 使用 `initialInput: "none"`、空 `initialPrompt` 及独立 `instructions`，保留原生权限、模型、args、真实 HOME 和 native home。环境使用目标 Worker 的 `DN_CONFIG_DIR`，普通 cwd 必须存在；不支持的 Provider 参数和配置错误明确失败。角色不成为用户 turn。

spawn 前必须持久记录 `unknown`，随后保存进程出生证明和认证 IPC 观察。重开数据库后，`unknown` 或 `acknowledged` 只能观察同一 launch；IPC 失败或缺少 native ID 都不允许再次 spawn。进程未知时保留 ticket、journal、别名目录和执行责任。明确启动拒绝必须持久化；服务端报告失败后，下次按原对象核对并补报，不能永久降为未知。IPC 关闭后的原 journal 可以证明初始化拒绝，不能凭旧 ready 证明当前在线。

ready 必须同时具备原 Controller 的初始化结果、正确无初始输入状态和服务端相同 native identity 的 active、connected、synchronized Session。spawn 回执、清单状态或本地 IPC 单独均不能证明 ready。零用户 turn 时 Provider 尚未分配 native ID 可以显式为 null，不能伪造身份。

## 节拍与失败

Bot 清单发现间隔为 `min(pollIntervalMs, 5000)` 毫秒，授权维护独立每 30 秒执行一次，凭据有效期剩余不超过 120 秒时续期。它们不依赖 Task 默认 60 秒轮询。单 Bot 的慢启动和错误不阻塞其它 Bot；同 Bot 不并发启动。读取失败不清空本地责任，也不从旧清单启动新执行。

每次生命周期写入前核对当前版本；版本冲突及响应未知先读取原对象。授权续期保持原执行 generation、Controller 及已知 native identity；拒绝更换身份或把 relay token 当 CLI PAT。页面关闭不调用执行层停止接口。

## 集成边界

执行层提供可调用的 `ManagedAssistantRuntime` 和持久句柄。本层不启用产品入口或 `assistantHost` 广告，不实现新 generation 恢复、Worker 停机策略及删除清理。调用方取消运行循环只取消并等待管理工作，不代表原生进程停止；后续生命周期集成必须使用同一证据与进程证明，并承担所有私有资源的清理责任。

验证覆盖原登记响应丢失、未知 spawn、错误身份、角色保持、普通 cwd、三 Provider ticket、真实共享 spawn/IPC 路径、独立节拍与旧 Task cleanup/容量/native PATH 回归。受控 Provider 与网络测试不能替代整个产品的真实三 Provider、浏览器或生产验收。
