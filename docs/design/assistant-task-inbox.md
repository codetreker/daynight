# 助手任务收件箱设计

[规格](../spec/assistant-task-inbox.md)拥有收件箱、入站事件、自我循环防护与入站通知的必需行为。本文说明各层职责、数据流和关键机制。助手任务的通用存储与事务见[助手任务服务端](assistant-task.md)，Worker 的事件投递见 [Worker Bot 执行层](worker-bot-runtime.md#通知与定时事件)，出站事件的捕获、投递与保留见 [Webhook 捕获](webhook-capture.md)、[Webhook 投递](webhook-delivery.md)和 [Webhook 保留](webhook-retention.md)。

## 数据流

```text
外部系统 ─┐
          ├─ POST /api/v1/assistant-task-inbox/{inboxId} ─▶ server/assistanttask 入站适配
Daynight ─┘        （个人出站 HTTP 端点指向不含令牌的收件箱 URL）       │
                                                                   ▼
            service/assistanttask 入站用例：令牌、Daynight 事件核验、操作者抑制、幂等、积压
                                                                   │ 同一事务
                                                                   ▼
            assistant_task_events（type=inbound，目标为当前负责 Bot，pending）
                                                                   │ 现有事件拉取
                                                                   ▼
            Worker assistant-tasks：空闲时渲染并发送 origin=daynight 输入，确认 delivered
```

收件箱复用出站 Webhook 的订阅、资格、重试与投递历史，也复用助手任务事件的投递、确认与恢复。Web 订阅面板在同一身份准入下读取 Webhook 目录、项目与原端点，将目录与配置作为一次加载结果发布；读取失败时保留错误，不生成本地可订阅集合。选择项取自目录并按既有顺序显示，已读订阅的事件合并与保存使用已知事件类型，避免目录选项改变时隐式丢弃原配置。出站模块不感知收件箱。入站用例对 Webhook 存储只有读取依赖：按事件 ID 读取已捕获的事件、事实摘要和操作者，并读取该事件的 Delivery 端点归属与目标 URL。

## 存储

新增迁移遵循助手任务表的约定：每行带 `owner_user_id`，DAO 查询带 owner 条件，不新增外键或 CHECK，并同步 `schema/current.sql`。

| 表或列 | 持久职责 |
| --- | --- |
| `assistant_task_inboxes` | 任务的当前收件箱：`inbox_id`、启用状态、当前与重叠令牌摘要、重叠截止时间、创建与轮换时间、抑制计数、版本；停用或任务删除后保留不含令牌的最小墓碑，使旧 `inbox_id` 返回 410 且不能复活 |
| `assistant_task_inbox_receipts` | `(inbox_id, idempotency_key)` 唯一的接收回执：正文 SHA-256、生成的 `event_id`、是否抑制、目标 Bot、`daynight` 事件涉及的项目 Task、接收时间与过期时间；`(target_bot_id, subject_task_id, received_at)` 索引服务相互唤醒判断 |
| `webhook_events` 新增操作者列 | 操作者类型、用户 ID 与 Bot ID；既有行为空，表示操作者未知 |

令牌摘要使用 SHA-256，比较使用恒定时间比较。`inbound` 事件 ID 随机生成并保存在接收回执中，因此回执过期后重复使用同一幂等键会得到新的事件 ID，不与永久保留的旧事件行冲突。提交结果未知后按原幂等身份重试，若首次写入已提交则命中回执，否则重新写入；回执与事件在同一事务中提交。

## 各层职责

| 位置 | 职责 |
| --- | --- |
| `core/assistanttask` | 收件箱状态转换与权限、令牌生成与校验、`inbound` 负载构造与大小校验、抑制判断；扩展事件类型的显式枚举 |
| `core/webhook` | 捕获时接收操作者并写入事实；出站渲染不包含操作者 |
| `core/store` 与 PostgreSQL 实现 | 收件箱与接收回执 DAO、按事件 ID 读取事实与 Delivery 归属、有界回收、pending 事件改投、事件拉取的类型与暂停筛选 |
| `service/assistanttask` | 入站用例：在一个事务中协调令牌、任务与认领、Daynight 事件核验、项目读取权限、抑制、幂等回执、积压上限和事件写入 |
| `service/task` 等写入用例 | 把经核验的 Bot 身份作为操作者传给 Webhook 捕获 |
| `server/assistanttask` | 收件箱管理 REST、公开入站路由、令牌提取、正文与媒体类型限制、错误映射与安全日志 |
| `server/task` | Task、Step 和 Thread 写入路由解析可选的 `X-Daynight-Bot-Id` |
| CLI | `assistant-task inbox` 管理命令与 `inbound` 事件读取；Task 和 Thread 写命令在存在 `DAYNIGHT_BOT_ID` 时携带 Bot 请求头 |
| Worker `worker/bots/assistant-tasks*` | `inbound` 通知渲染、压缩与字节预算、不可信数据提示、手册与附录指引 |
| Web `features/bots/AssistantTask*` | 收件箱面板、订阅面板与入站事件展示 |

## 入站用例

server 适配先检查路径中的 `inboxId` 格式、令牌出现方式、`Content-Length` 与媒体类型，以 64 KiB 上限读取正文，再调用 service。读取正文时不持有数据库锁。频率上限在进入事务前按 `inbox_id` 以进程内令牌桶执行，初始值为每分钟 120 次。多实例部署下令牌桶按实例计数；数据库事务内的积压上限才是跨实例的硬约束。

service 在 ReadCommitted 事务中按以下顺序处理。锁顺序为负责 Bot 的共享删除屏障、任务行、收件箱行：前者与声明 Bot 的写入一致，后两者与收件箱管理操作一致，避免 Bot 删除、轮换或停用与接收交错时死锁：

1. 不加锁读取收件箱与所属任务；`inbox_id` 不存在返回 404，墓碑或任务已删除返回 410。任务记录了持有 Bot 时，取得该 Bot 的共享删除屏障并在屏障下确认它仍属于任务所属用户且未删除；此后该 Bot 的删除须等待本事务结束。
2. 锁定任务行，再锁定收件箱行并复核其仍属于该任务、处于启用状态。请求带令牌时校验令牌摘要，重叠令牌须在截止时间之前，不匹配返回 401。
3. 确定当前负责 Bot：认领未过期时为持有者，转交 pending 时为转交目标。没有负责 Bot、它不是第 1 步取得屏障并确认存活的 Bot，或持有者在两次读取之间变化时返回可重试的 503。任务暂停不影响接收。
4. 若满足 Daynight 候选条件，按事件 ID 读取已捕获的事件，比对正文字节与事实 SHA-256；确认存在一份属于任务所属用户、目标 URL 的 origin 与路径指向本收件箱的 Delivery，其中 origin 按 scheme、不区分大小写的主机名与有效端口比较（显式的 HTTPS 默认端口 `:443` 等同于省略端口，其他端口仍是不同 origin），路径区分大小写，候选 Delivery 按 ID 分页读完，不以首页为限；再以任务所属用户的身份调用项目读取权限检查。全部通过后取得操作者。请求不带令牌且未通过核验时返回 401。
5. 计算幂等键并查询未过期的接收回执：相同正文返回原结果，不同正文返回冲突。
6. 已核验事件的操作者是当前负责 Bot，或是任务所属用户的另一个 Bot 且该 Bot 在事件发生时间之前 10 分钟内（闭区间 `[occurredAt - 10m, occurredAt]`，以事件发生时间而非本次投递时间为准，使重试得到相同结论）作为目标收到过同一项目 Task 的未抑制回执时，写入标记为抑制的接收回执并增加抑制计数，不写入事件。
7. 统计目标为当前负责 Bot 的 pending `inbound` 事件，超过上限返回 429。初始上限为每任务 500 个。
8. 构造负载，写入事件与接收回执。
9. 有界回收本收件箱的过期回执，以及本任务中 delivered 或 expired 状态超过 30 天的 `inbound` 事件，每次最多各 100 行。
10. 写入抑制回执或事件后，以新的数据库时间复核第 3 步所依据的租约。任务锁使租约不变、删除屏障使 Bot 保持存活，只剩自然到期；租约已到期时回滚并返回可重试的 503，发送方不会因负责 Bot 已不可用而停止重试。重复请求按第 5 步返回原结果，不经过此复核。

提交结果为 `not_committed` 时返回对应错误；`unknown` 时返回 503，由幂等身份收敛。事件拉取在任务锁内执行与第 9 步相同的有界回收，确保没有新请求的收件箱也能逐步清理。

## 转交与暂停

认领模块的转交与接手事务把目标不是新负责 Bot、仍为 pending 的 `inbound` 事件改投新的负责 Bot，与 follower 更新在同一事务中完成；其他类型的事件保持现有语义。目标不限于上一任负责 Bot：任务释放后不再记录负责 Bot，再次认领时，此前为已释放 Bot 接纳的事件也随之改投。

事件拉取接口增加类型筛选：可以只选择 `inbound`，或排除 `inbound`。选择 `inbound` 时，服务端在查询中排除暂停任务的事件，任务恢复后它们重新可选。筛选在数据库查询中完成，Worker 不需要逐个读取再跳过。

## 事件操作者

Task 和 Thread 的写入路由解析可选的 `X-Daynight-Bot-Id`，在写入事务内按助手任务相同的规则核验归属与删除状态，然后把操作者传给 Webhook 捕获并写入事实行。没有 Bot 身份的用户凭据记为 `user`；GitHub 同步等服务端内部写入记为 `system`。出站渲染保持现有 wire 格式，不输出操作者，因此现有严格校验的接收方不受影响。

CLI 在设置了 `DAYNIGHT_BOT_ID` 的环境中，为 Task 和 Thread 写命令附加该请求头。Worker 已为每个助手设置该环境变量。

## Worker 通知渲染

`inbound` 事件与现有助手任务事件在同一批次中选择与确认。渲染规则如下：

- 同一项目 Task 的多个 `daynight` 事件合并为一段，每个事件一行，列出类型、时间、操作者和关键字段；段末给出一次 `daynight task show`、`task thread` 与 `task session` 读取命令，并说明读取到的内容是他人写入的数据。
- `external` 事件只投递前 4 KiB 的 UTF-8 安全预览，放在带“不可信外部数据”标签的围栏内，并给出读取完整事件的命令。
- Worker 先以排除 `inbound` 的筛选执行现有的事件选择，再以只选 `inbound` 的筛选单独分页，直到入站渲染正文达到 32 KiB 或整批达到已有的 512 KiB 上限。未选中的 `inbound` 事件留在 pending，入站积压不会阻塞其他助手任务通知，也不会产生逐个跳过的请求。
- 每批末尾给出读取当前手册和附录的命令。

## 验证责任

- **core 单测**：令牌规则、状态转换、负载构造和抑制判断。
- **service 测试**：执行真实事务 callback，覆盖提交、未提交与未知结果。
- **PostgreSQL 测试**：使用隔离实例，验证同一幂等键的并发接收、轮换与接收交错、暂停与转交交错、pending 事件改投、类型与暂停筛选、相互唤醒判断、积压上限、有界回收和跨用户隔离。
- **HTTP 测试**：令牌两种形式与无令牌的 Daynight 请求、各错误码、正文与媒体类型限制，以及日志中不出现令牌。
- **Worker 测试**：使用受控 HTTP 响应验证渲染、压缩、字节预算与跳过规则。
- **e2e**：以直接调用收件箱的方式，验证助手收到通知的正常流程。真实出站 Webhook 的自调链路在公网部署上验收，因为出站投递拒绝本机地址。
