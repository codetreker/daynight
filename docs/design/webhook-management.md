# Webhook 管理模块

## 职责与组装

Webhook 管理模块处理 Personal User 和 shared Team 的 endpoint 配置、签名秘密和操作回执。`internal/server/webhook` 将认证后的请求映射到 `internal/service/webhook`；调用方提供模块、认证和日志依赖后，通过 `RegisterRoutes` 将其挂载到自己的 mux。模块构造不启动通知运行器，主应用的公开挂载由完整后端组装负责。事件目录提供固定的六项 Task 事件及当前 typed policy。

业务校验位于 `internal/core/webhook`，中立事务合同位于 `internal/core/store`，PostgreSQL 实现负责锁与持久化。显式订阅绑定项目和固定事件类型；[捕获模块](webhook-capture.md)在来源事务内协调事件，[投递模块](webhook-delivery.md)负责发送与恢复，[投递历史与重投](webhook-history.md)使用当前权限和保留数据。Personal owner 从主体派生；Team 当前成员只能读取脱敏配置和本人原回执，当前管理员才能管理和读取秘密。读取在同一数据库快照内重新检查凭据与成员关系。

## 写入与回执

操作身份由 owner 和客户端提供的 operation ID 确定。写事务先取得操作围栏并查询现有回执；新操作检查权限和时间，在来源锁和 endpoint 锁后重新核验，再把效果和回执共同提交。回执保存规范化意图指纹、实际请求正文摘要、原时间及结果版本，不保存 URL 或秘密。匹配重放不重复效果；事务释放连接后，以新的授权快照读取回执和当前视图。提交结果未知时调用方使用原操作身份核对；回执不可读取不能证明回滚。

每份回执都有可空的 `overlapUntil`。重叠轮换保存该次操作产生的原截止时间，立即轮换与非轮换操作为 `null`；`keyId` 和截止时间不随之后的轮换、秘密回收或 endpoint 删除而改变。轮换响应的 `signing.activeKeyId` 与 `signing.overlapUntil` 必须分别等于原回执的 `keyId` 与 `overlapUntil`，不能用当前 endpoint 状态替代原结果。

回执有效期独立于物理清理，以授权快照的数据库时钟比较 `expiresAt`。到达截止的 GET 返回 `404 not_found`；原意图与仍占用身份的过期回执匹配时，管理及重投重放返回 `410 operation_expired`，不重复效果。DAO 保留原始查询能力，因此过期但未清理的身份仍不能用于不同意图。未过期回执的匹配重放先于首次准入的五分钟检查；物理清理后原请求仍须通过首次准入时间围栏。当前 owner 权限、回执 actor 可见性与意图冲突检查先于过期结果披露。提交后的回执投影也复查有效期，投影无法确认的新提交仍返回未知结果。

配置版本仅在真实变化时递增，目的地版本仅在目的地变化时递增。订阅采用完整数组替换，保留的订阅及事件绑定保持身份；删除后重新添加产生新身份。个人资格是项目所属 Team 成员关系与独立项目授权的并集，Team 资格由当前项目归属确定。失权时在来源事务内推进授权 epoch 并要求明确确认；重新获权不会自动恢复，连续来源交接不会中断资格。配置写入先按项目和 Team 根及关系的固定顺序取得来源锁，再锁 endpoint 和订阅；锁后重新检查权限及配置版本。来源变更只在订阅锁后以新语句读取权限并集，刷新失败使来源事务回滚。操作和配置没有数量或存储配额；存储失败使整个事务回滚。删除清除目标配置和签名密钥，保留最小墓碑与有保留期限的回执。

## 目标配置与签名秘密

`webhook_endpoints.destination_configuration` 以 `bytea` 保存规范化 JSON 的 UTF-8 明文字节；活动 endpoint 必须保存 1–262144 字节，删除墓碑为空。当前 HTTP 配置结构为：

```json
{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/path?token=example"}}
```

配置读取严格检查大小、已知字段、重复字段、版本和 URL，并与行内 kind、adapter version 和 origin 核对；损坏数据暴露为错误。目标变化才替换这些字节并递增目的地版本；改名、启停和订阅修改保留原目标和签名秘密。既有 Delivery 的目标由[捕获模块](webhook-capture.md)单独保存为固定快照，配置修改不会改写它。

`webhook_signing_keys.secret` 保存恰好 32 字节的随机明文 HMAC 秘密。秘密通过独立授权接口以 `whsec_` 加标准 Base64 返回；普通配置读取只返回签名方案和 key ID。轮换生成新秘密，最多保留一份当前 key 和一份有效重叠 key；签名算法见[投递设计](webhook-delivery.md)。目标配置、URL 中的 token 和签名秘密对有数据库或备份读取权限的主体可见。应用的权限检查、配置脱敏和安全日志仍独立执行；存储取舍见[明文存储决策](../../.agents/notes/implemented/simplification/2026-11-08-webhook-plaintext-storage.md)。
