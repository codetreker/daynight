# Webhook 安全投递

## 投递与准入

捕获事务保存固定 body、目标密文、原匹配和原自动计划；投递不重新渲染资源或替换原证明。运行器显式从应用运行根启动，最多八个发送 worker；构造本身不启动 goroutine。每次领取只占本实例空闲容量，按已到期、可执行且未锁定的 Delivery 的 `queue_order, id` 选择，跳过锁定行和已知未来的接收方等待。领取使用 45 秒 lease；网络完成的顺序不承诺与领取相同。

独立准入事务按资源存在性、归属和权限来源、endpoint、原 subscription/binding、Delivery、Attempt、等待叶子的顺序检查当前资格。原匹配数量及摘要、事件和目标身份、授权 epoch、目的地 revision、期限、lease 和 generation 均须成立。准入在同一事务写入 Attempt 和次数；只有明确收到 COMMIT 成功的调用才发网。权限读取错误是内部错误，不作为撤权。HTTP 不持数据库锁；准入先提交的请求可以在后续撤权后完成。

自动计划最多十次准入，原发生时间后 72 小时截止。错过多个机会时只选择一个当前机会；失败至少等待五秒并遵守计划和有效的接收方等待。重试取得新 FIFO 票据，等待不移动原截止时间。`(endpoint_id, destination_revision)` 的等待是独立叶子，完成时单调提高；目的地变更不继承旧等待。缺当前 revision 的等待行是错误。

## 请求、结果与恢复

`protocol` 对捕获的原 body 生成 Standard Webhooks v1 HMAC-SHA256 签名；有效的当前和重叠密钥分别签名，尝试时间与事件内容分离。通用 HTTP 的 2xx 表示接收确认而非外部业务完成；410 结束该责任，429/503 可携带 `Retry-After`。不保存原响应正文或认证头。

受控 HTTPS 客户端不继承代理、不跟随跳转、不复用连接。每次连接解析候选并按固定 IANA special-purpose 数据及地址规则过滤，再直接拨获准 IP，同时以原 hostname 验证证书和 SNI。请求 URL 上限 4 KiB、body 上限 64 KiB，响应头上限 16 KiB、分类正文读取上限 2 KiB；连接及 TLS 各限五秒，响应头限十秒，总限十五秒。生产 endpoint 不能自行放宽地址策略或 TLS 校验。

完成事务按 Delivery、Attempt、等待叶子锁序保存真实观测并比较 token、Attempt 和 generation，不重新授权抹掉在途结果。租约过期后，已准入但未完成的 Attempt 记录恢复未知，新的发送使用新的 Attempt；单纯领取不生成 Attempt。旧执行者的晚到观测只写自己的保留 Attempt，不清新 lease 或改新代调度；关闭保留后不重建历史。lease 保护本地状态，不能保证接收方 exactly-once。

数据库时钟用于准入、租约、等待和截止判断，本地单调时钟用于耗时。关闭发送时仍执行恢复和逻辑到期；永久 worker 错误通过运行器通知 owner。停止时先取消并等待 worker，再由调用方释放底层依赖。公开应用的完整组装及手动重投由各自模块负责。
