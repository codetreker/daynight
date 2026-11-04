# Worker Bot 库存设计

[需求](../spec/worker-bot-inventory.md)拥有可观察行为，[决策说明](../../.agents/notes/implemented/architecture/2026-11-04-worker-bot-inventory.md)记录取舍。Bot 库存与现有 Task coordinator 并列；它提供数据与对账接口，不负责 Controller 启动或周期调度。

## 持久边界

`worker/sqlite/008-bot-inventory.sql` 在现有 `state.sqlite` 添加独立 `bots` 表。复合主键为 `server_origin / owner_user_id / worker_id / bot_id`；JSON 记录保存完整观察、最后一个非删除定义、观察时间及可空启动意图。读写复用 `workerStoreFormat` 的版本和 schema 验证、即时写事务及现有迁移机制。数据库调用者须在整个访问期间持有原 Worker 实例锁。

`bots/store.ts` 的 `observe` 验证 owner/Worker、版本单调性、冻结配置、角色和稳定 Session 绑定。删除观察替换当前投影并保留旧定义与意图。`prepare` 仅初始化一次注册及 launch 身份，保存首次 `botVersion`，并用现有 Controller 路径函数计算 ticket、journal 与 credential 路径；不创建这些文件。已存在意图直接复用，服务端已绑定但本地没有意图时拒绝生成替代执行。`freezeRole` 保存第一次角色全文、revision 和 SHA-256 digest，相同值可重试，不同值拒绝。

服务端生成 sessionId。后续权威观察确认绑定时，只有匹配原 testExecutionId 才能写入原意图。`executionId` 与独立 `testExecutionId` 相同；与 Task claim、worktree 无关。当前观察版本可能因绑定或状态报告递增，而原注册版本保持不变，以支持整个首次请求的精确重放。

## 权威读取与对账

`bots/remote.ts` 使用绑定服务及正常 PAT，读取 `/api/v1/me/workers/{workerId}/bots` 的所有分页和 `/api/v1/me/bots/{botId}` 单项。解析器保留 int64 十进制字符串，校验 owner/Worker、冻结配置、Session 成对身份和删除投影。HTTP 失败与格式失败直接传播，只有单项 404 返回缺失。游标重复拒绝，避免无限分页。

`createBotInventory({owner,store,remote,now}).reconcile(signal)` 核对 remote 与本地 owner；一次实例只允许一个对账。完整清单读取后收集重复 ID 与本地缺失 ID，全部完成权威单项读取后才逐项持久观察。任一读取失败不修改库存。单项 404 在结果的 `missing` 中报告，不删除旧记录；成功观察在 `observed` 中报告。写入按单 Bot 事务执行，写入失败保留已提交观察并暴露错误，不宣称整轮原子更新。

## 与运行时的关系

`worker run` 不再隐式选择仓库，从同一配置快照读取服务和 Worker 设置。认证、实例锁、报告、原 Task 对账和关闭流程继续执行；空仓库只意味着不从配置选择新的任务项目。全新库存无配置仓库、旧项目映射或原 Herdr 责任时，全局默认模式不触发 Herdr 启动；保留的项目映射仍可触发旧资源发现，不能用空配置跳过孤儿资源与收尾责任。

Bot 库存不进入 Task coordinator、Task 遥测库存、maxConcurrent 或终态清理预算。[Controller 执行层](worker-bot-runtime.md)在有效账号与环境下调用 prepare、冻结角色及原身份注册，并提供独立发现节拍与授权维护。本模块不调用 register/grant/spawn，不广告 `assistantHost`，也不把库存观察当作 ready 或停止证据。删除记录不包含递归删除普通 cwd、共享 native home 或任务 worktree 的行为。
