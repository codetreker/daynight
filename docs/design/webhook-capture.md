# Webhook 事件捕获

## 事务与接收资格

Task、Step 和 Thread 的真实写入在其原事务中捕获事件。Task 状态和暂停可在一次变更中分别形成两个事实；Step 的一次集合逻辑变化和 Thread 的最终消息各形成一个事实。Thread 保持独立事务，捕获不反向取得 Project 根锁。无变化或业务拒绝不产生事实；删除使用数据库返回的最终墓碑版本和时间。

捕获器在一个 Read Committed 语句快照中读取全部合格的 endpoint、订阅、绑定和当前授权来源，不增加这些资源的行锁。冻结前来源事务必须已有顶层事务 ID；隔离级别或事务 ID 不满足时捕获失败。[配置回收](webhook-retention.md)以此等待可能看到旧资格的捕获事务结束。相同事件和 endpoint 的所有原匹配归入一份 Delivery，保留每个订阅、绑定、项目、事件类型及授权 epoch。快照后的新订阅不补发历史，零目标不保存 Event。事实、全部责任和源变更同事务提交；渲染、目标解码、数据库写入或提交错误不会变成部分成功。

## 固定内容和证明

`internal/core/webhook/protocol` 校验六类 `wire v1/schema 1` 事实并生成固定字段序的 CloudEvents structured JSON。Task 和 Step 使用最终 Task 版本；Thread 使用最终消息 ID 和时间，不改变 Task 版本。数据仅含固定的最小字段。Task 状态字段接受 proposed、todo、in_progress、done、cancelled，状态变化事实校验原值与新值及其不等关系；创建默认 proposed 的事实同样由严格渲染器与 schema 验证。渲染验证发生在目标匹配之前，没有接收目标也不能掩盖非法事实。机器 schema 与严格解码共同验证结构、身份及跨字段约束；任意位置的相等关系由解码器检查。原始事实 codec 1 保存捕获时的完整 structured JSON，Delivery 保存相同的确定 body，均保存长度和 SHA-256。动态签名与网络发送由[投递模块](webhook-delivery.md)负责。

原匹配摘要将匹配按 subscription ID、binding ID 升序排列，编码为无空白的 JSON 数组；每项依次为 subscription ID、binding ID、project ID、event type 和十进制 authorization epoch 字符串。对 UTF-8 字节计算 SHA-256；原数量另存正 bigint。后续读取须验证完整集合及其与 Event、Delivery 的关联，不能用新订阅替代原证明。

当前通用 HTTP 请求固定为 POST、`application/cloudevents+json` 和空的确定头数组。捕获器严格解码冻结的 endpoint 目标配置并核对 kind、adapter version 和 origin，然后复制规范化 JSON 明文字节到 `webhook_deliveries.destination_configuration`；该 `bytea` 字段非空，长度为 1–262144 字节。每份 Delivery 保存独立固定快照，后续目标修改、重试和重投均不替换它。签名秘密保留在 endpoint 的签名 key 行中，在发送准入时读取有效的当前和重叠 key；Delivery 不复制签名秘密。目标存储格式由[管理设计](webhook-management.md)规定。

## 调度登记

捕获使用固定 policy 1，保存十个自动机会、72 小时自动期限和七天 payload 期限。首机会等于发生时间，后续间隔施加持久化随机抖动并保持递增及期限内。首次排队由数据库 sequence 分配 `queue_order`；领取按到期条件和票据执行。捕获不创建 Attempt，也不发送 HTTP。事件、责任、原证明和票据持久保存后才随源事务提交；提交结果未知不生成替代事件。
