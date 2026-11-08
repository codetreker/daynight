# Worker Bot 运行、恢复与删除

Bot 执行层消费[持久库存](worker-bot-inventory.md)与[角色及环境](bot-role-environment.md)，提供普通目录内的独立 Controller 启动、原身份观察、授权维护、退出停止、同一会话恢复与私有资料删除。调用者持有 Worker 实例锁，使用当前服务、账号与 Worker 绑定；Bot 不占 Task `maxConcurrent`，不创建 Project、Task、claim 或 worktree。

## 启动与身份

首次预检成功后，先持久化注册身份和角色全文、revision、digest，再提交 register。首次请求的版本、配置和角色不得因重试或 Worker 升级改变。服务端同一事务冻结角色并绑定 Session；响应未知后先读取原 Bot，已经绑定时核对原执行，尚未绑定时仅可重放同一注册身份和指纹。缺失本地身份的已绑定 Bot 不创建替代会话。

Controller ticket 使用 `initialInput: "none"`、空 `initialPrompt` 及独立 `instructions`，保留原生权限、模型、args、真实 HOME 和 native home。环境使用目标 Worker 的 `DN_CONFIG_DIR`，普通 cwd 必须存在；不支持的 Provider 参数和配置错误明确失败。角色不成为用户 turn。

spawn 前必须持久记录 `unknown`，随后保存进程出生证明和认证 IPC 观察。重开数据库后，`unknown` 或 `acknowledged` 优先观察同一 launch；IPC 失败或缺少 native ID 都不允许再次 spawn。进程未知时保留 ticket、journal、别名目录和执行责任。明确启动拒绝必须持久化；服务端报告失败后，下次按原对象核对并补报，不能永久降为未知。IPC 关闭后的原 journal 可以证明初始化拒绝，不能凭旧 ready 证明当前在线。

ready 必须同时具备原 Controller 的初始化结果、正确无初始输入状态和服务端相同 native identity 的 active、connected、synchronized Session。spawn 回执、清单状态或本地 IPC 单独均不能证明 ready。零用户 turn 时 Provider 尚未分配 native ID 可以显式为 null，不能伪造身份；这样的执行停止后不能恢复成空白替代会话。

## 节拍与失败

Bot 清单发现间隔为 `min(pollIntervalMs, 5000)` 毫秒，授权维护独立每 30 秒执行一次，凭据有效期剩余不超过 120 秒时续期。它们不依赖 Task 默认 60 秒轮询。单 Bot 的慢启动和错误不阻塞其它 Bot；同 Bot 的启动、续期、停止和删除串行执行。读取失败不清空本地责任，也不从旧清单启动新执行。

每次生命周期写入前核对当前版本；版本冲突及响应未知先读取原对象。授权续期保持原执行 generation、Controller 及已知 native identity；拒绝更换身份或把 relay token 当 CLI PAT。页面关闭不调用执行层停止接口。

## 退出与恢复

取消持续运行或调用 `shutdown` 时，先停止发现与续期调度，取消并等待已开始的管理工作，再独立停止每个 Bot。一个 Bot 的失败不能跳过其它 Bot 的停止；调用者收到汇总错误，无法确认的执行仍保留完整责任。退出不递交 cleanup prompt，不调用 StopTest，不以归档、删除 Bot、清理对话或删除普通 cwd 为前置条件。

停止针对原 ticket 和进程出生身份，认证 IPC stop 回执仅表示请求结果；原 Controller 及原生进程树须经 OS 核验确已停止，并在同一 journal 保存匹配 fence 的停止证据。恢复子进程已经提交但 journal 仍为前代时，必须继续依据当前子进程的已持久出生证明尝试停止；前代 journal 不能证明当前代停止，缺失当前代完整停证仍报告失败。IPC 不可达、进程查询失败和停止超时都不等于已停止。ticket、journal、操作回执、原角色、原生身份及各代私有路径保留，供恢复和精确删除使用。

重启先复用仍可认证观察的原 Controller，不为健康执行发新 generation。只有原 writer 完整停证和原 native ID 均存在时，才可分配直接下一代，保持 Bot、Session、testExecutionId、首次 registration、角色、配置和 native home，并恢复原 native Session。原 stopProof 与新 launch/Controller instance 身份在提交 grant 前持久保存。grant 响应未知后读取同一 Session：仍是精确前代时沿原停证申请同一目标；已是精确目标时续接该代；其它 fence 均拒绝。不得因未知响应继续递增 generation。

未提交 spawn 的持久意图可以继续原首次启动或原恢复目标；`unknown` 不能回退为未提交。`never_started` 不构成换代停证，也不能绕过 native ID 缺失。未知用户操作保留原 journal 与 operation identity，恢复不得重新发送旧请求。

正常关停来源必须来自停止前新鲜且健康的认证观察。若停机失败后重新接管仍运行的原 writer，则取消该次停机来源，后续异常退出仍受预算限制。该来源允许恢复原会话而不增加异常 `recoveryCount`；已有异常计数和阻止原因不能因退出、重启或成功观察清零。异常恢复受冻结的 `recoveryLimit` 限制，耗尽时保留可诊断原因、原身份和私有资料。旧 ready journal、已失败或已停止的观察不能将异常恢复改记为正常重启。

## 删除与私有资料

只有当前服务、账号和绑定 Worker 的权威删除投影才能启动清理。删除责任固定到原 `deletionId` 和执行身份；清单遗漏、404、网络失败或权限失败都不能当作清理授权。运行时必须接入删除管理器，发现删除投影后推进同一责任；单 Bot 的清理失败不阻塞其它 Bot，下次权威对账后继续重试。删除状态阻止新启动、恢复和续期，但已提交子进程的出生证明及观察仍须保存，不能因删除先到而遗失停止原 writer 所需的证据。

删除与原执行共用同一串行化入口，等待在途启动结束后停止原 writer。IPC stop 成功回执不能替代 OS 进程树停证；停止未确认时，ticket、journal、pending 内容和操作回执保持完整。停证须匹配原 generation、Controller instance 和 Session；不能借前代停证清理可能仍运行的新代。`never_started` 仅用于确证从未启动执行的收尾，包括未提交和明确 OS 启动拒绝且没有任何进程或 snapshot 证据的首次执行；不能把未知 spawn 或未知恢复 grant 降为未启动。

停止确认后，先在 Worker SQLite 持久保存停证、受限清理目标和精确完成回执，再删除执行私有资料。删除责任不能放在即将删除的 journal 内。中断和部分失败须保留同一责任并允许重试，已确认清理的目标不再重新删除；旧 `deletionId`、旧执行或被替换的文件身份不得成为清理新实例的依据。

清理范围仅包括该 Bot 的私有执行目录（journal、pending 内容、操作回执、日志及 relay 凭据）、本次与保留各代的 ticket 及其原子写入临时文件、认证 IPC 端点和已登记的独占 CLI 别名目录。临时文件只接受原 launch 对应的 `<launchId>.json.<uuid>.tmp`，不清理共享 launch 目录中的其它文件；正式 ticket 须核对原 Bot 执行归属。路径须由原执行身份和配置根核对，拒绝越界、符号链接及归属冲突，也拒绝以 cwd、native home 本身或包含它们的目录作为清理目标。普通 cwd、共享 native home、Bot 创建的 Task 及其 worktree 均保持不变；不调用 Agent cleanup prompt、Task worktree removal 或 StopTest，不以归档上传为前置条件。

只有全部本地私有目标清理成功才提交 `workerCleanup=completed`，同时从本地库存与执行记录移除不再需要的定义、角色和会话资料，保留不含对话正文的最小删除责任。服务端回执必须匹配原 `deletionId` 和精确停证；响应丢失后先读取原删除状态，再决定是否重放相同回执。不能用新的 proof 或 `deletionId` 掩盖未知结果，也不能把服务端仍为 pending/failed 的阶段当作整体删除完成。

离线或权限错误保留责任并显示实际失败；停证缺失、执行代际不明和文件清理失败不得报告完成。已保存注册意图却没有确认 sessionId，或恢复目标尚未提交而服务端 grant 是否换代无法确认时，均保留原执行资料，不能把未知注册视为从未绑定，也不能猜测一个可被接受的 stopProof。

首次持久意图之前的 preflight 资源只有在当前进程仍持有其清理句柄时才能重试释放。历史 Worker 崩溃前未登记的孤立 preflight 别名目录不保证被发现，不据此宣称整个预检生命周期都具有持久删除责任。Provider 自身历史不在清理范围内，不承诺共享 native home、离线浏览器缓存或用户导出副本的物理擦除。[助手需求](assistant.md)拥有跨服务端与 Worker 的整体删除语义。

## 集成与验证边界

执行层提供可调用的 `ManagedAssistantRuntime`、持久恢复句柄和汇总停止接口。调用方须等待停止结果后才关闭 stores、释放 Worker 锁；停止失败不能包装成成功退出。Task 原有 claim、容量、归档及 worktree 收尾规则保持独立。

正式 `runWorker` 组合 Bot 调度、恢复、停止和私有资料删除，并发布当前托管能力。产品入口消费该能力；广告只证明预检观测，不代表后续原生执行必定成功。

验证应覆盖未知 spawn、不可达 IPC 但进程仍活、完整停证及缺失 native ID、至少四次正常重启不耗预算、异常计数与耗尽阻止跨重启保留、grant 响应丢失、未知操作不重发、停止与启动交错、单 Bot 失败隔离及旧 Task 退出路径。删除验证还须覆盖 IPC 已回执但进程未停、删除与 spawn 出生证明交错、注册结果未知、部分清理失败和跨重启重试、回执响应丢失、原 launch 临时文件范围、正式 ticket 归属、路径替换与符号链接拒绝，以及 cwd、native home、独立 Task 和 worktree 逐项保留。受控 Provider 与网络测试不能替代整个产品的真实三 Provider、浏览器或生产验收。
