# Webhook 保留与维护

## 历史资料

独立维护器由运行 owner 显式启动和停止，发送开关不控制清理。每次激活最多影响 500 行并以两秒 context 限制数据库工作；满批或明确有更多工作时一秒后继续，空闲时一分钟后轮询。等待事务屏障或跳过忙锁时可能进入空闲轮询。回执、配置和历史轮流优先执行，历史中的关闭、载荷和子记录清理也轮换，避免忙锁或积压阻塞其他类别。进程退出后重新扫描持久状态，不依赖唤醒或内存游标。

维护器公开最近一次激活的确认行数、清理进度、未知结果及已观察候选的最老滞后下界；没有样本时滞后为未知。容量有限的事件流不阻塞维护，队列满时累计丢弃数。运行 owner 在维护激活之外消费事件并输出脱敏 `slog`；事件只携带实际存在的身份和安全错误类别，不携带正文或密钥。

载荷以捕获时保存的原截止时间判断。有效 lease 或仍在期限内的 pending 责任保护原 body；到期且不再需要时仅移除 body 并记录 `payload_removed_at` 和 `expired` 原因，保留原长度、摘要与目标快照。共享 Event 的事实字节在所有关联 Delivery 都不再持有 body 后清除。Event 保留至最后一个 Delivery 删除；独立扫描按引用索引回收无引用 Event。

元数据候选先锁 Delivery，再按顺序锁 Attempts；最后活动时间合并正常完成和晚到观测，并按原 policy 计算期限。有效责任不关闭；到期时同一事务设置 `purging_at` 和所有 Attempt 的 `retention_closed_at`。后续事务按预算分批删除 Match 和 Attempt，子记录清完才删除 Delivery。晚到写只锁自己的 Attempt，关闭后不再写入；关闭前的新观测会延长保留。提交回复未知时先在下一次有界激活读取原对象，再进行新的候选扫描，不把未知结果记为确认删除。

## 配置与回执

回执清理先取得与管理写入相同的 operation advisory 围栏，再锁定原回执并以数据库时钟复查截止。[管理模块](webhook-management.md#写入与回执)的逻辑到期检查独立于清理进度；围栏的先后顺序只影响物理回收，不能延长回执查询或重放有效期。过期回执的缺失不能证明原操作未提交。回执、墓碑、退役订阅与 binding、旧等待及过期 overlap key 各自复核实际引用和有效状态；系统清理不授予资料读取权。签名秘密的全局过期扫描使用 `webhook_signing_keys_overlap_expiry`，键为 `(overlap_until, endpoint_id, id)`，条件为 `slot = 'overlap'`；当前时间只用于查询，未写入索引条件。单 endpoint 的有界 key 集合仍由 `(endpoint_id, slot)` 唯一索引支持。

捕获先写入来源事务再冻结 audience，使用 Read Committed 且已有顶层事务 ID。配置清理读取已退役候选后分配并提交一个事务 ID 作为屏障，等待新快照的最小活动事务 ID 到达该屏障，再按来源、owner、endpoint、订阅和 binding 的既有顺序取得锁并重查引用。冻结旧 audience 的在途事务因此必须先结束；已提交的责任在重查中可见。长事务会延迟清理，重启后重新取得屏障。清理不反向锁来源，也不将已退役身份替换成新身份。

明文目标快照随所属 Delivery 保留并在该 Delivery 回收时删除；删除 endpoint 不会绕过历史责任保留。当前签名秘密和未过期 overlap key 由配置生命周期保护，过期 overlap key 在引用与状态复查后回收。完整应用生命周期与公开管理接口的组合见[运行设计](webhook-runtime.md)，明文存储的成本见[存储决策](../../.agents/notes/implemented/simplification/2026-11-08-webhook-plaintext-storage.md)。
