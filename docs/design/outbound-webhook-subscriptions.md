# 出站 Webhook 订阅与管理

## 职责与入口

Webhook 管理模块为个人和团队保存出站 endpoint、显式项目订阅、事件选择、签名资料与配置操作回执。业务规则位于 `internal/core/webhook`，共享模型位于其 `model` 子包，数据访问合同位于 `internal/core/store`，PostgreSQL 实现位于 `internal/core/store/postgres/webhook`。service 协调授权、配置、加密和同一事务内的效果；server 只适配认证及 HTTP。

管理路由可以使用实际数据库独立挂载。应用公开 mux 的接入需要事件捕获和投递后端完整履行通知责任；仅有配置模块不能对外宣称已经可以发送通知。管理模块本身不启动 dispatcher，也不在业务写入后进行网络调用。

事件目录为 `task.created`、`task.status_changed`、`task.paused`、`task.deleted`、`task.step_updated` 和 `task.thread_posted`。目录拥有可订阅的逻辑类型，不把目录存在当作事件生产者已经接入的证据。

## 所有权与资料权限

Personal endpoint 归稳定的 User UUID 所有；它不归 Personal Team，也不归一个 PAT 或会话。只有本人可管理和读取其资料。订阅必须显式选择当前可读项目，包括参与的团队项目及通过独立 grant 获得的项目。

Team endpoint 归 Team 所有。当前成员可以读取经过筛选的管理资料，Team admin 才能修改配置和读取签名秘密；只有独立 Project admin 不等于 endpoint 的 Team admin。共享订阅还要求项目当前归该 Team 所有。创建 endpoint 的 admin 离开或被降级不使 Team 所有的订阅变成个人资源。

当前管理权和项目资格分别判断。项目失权后，owner/admin 仍可暂停、删除 endpoint 或移除失效订阅。清理操作不会恢复完整目标、载荷或发送资格。当前权限读取失败必须暴露存储或依赖错误，不能伪装为已撤权。

## 稳定订阅与授权连续性

Subscription 有稳定 UUID、不可编辑的 projectId 和持久化的授权 epoch。事件选择使用独立 binding UUID；保留仍选中的事件保留其身份，移除后重加产生新的 binding。更换项目等价于移除原订阅并建立新身份。

项目读取资格是当前所属 Team 成员关系与独立 Project grant 的并集。Team 成员、独立 grant、邀请接纳、项目转移和项目删除在原来源事务内刷新受影响的保留订阅。有效授权的连续交接保留 epoch；确实失去资格会推进 epoch 并要求明确重新确认。后来重新获得权限不自动激活旧资格。

刷新包含暂停 endpoint 和已失效订阅。Team 删除还覆盖归该 Team 所有的保留订阅，即使项目已经转走。新建 User、Team 或 Project 的初始关系没有可提前存在的合法订阅，后续关系变更仍参与相同刷新合同。

配置扩大或重新确认先锁 Project 根、ownership、排序的 Team 根与真实成员/grant，再锁 endpoint、subscription/binding 和升序配额桶。来源容器锁保护缺失关系和新订阅的并发插入；仅锁已存在关系不足以证明资格。

预读取只用于规划锁集合。新操作在旧回执不存在后先检查管理权；目标写入的调用者版本必须与规划时观察的版本相同，取得 endpoint 锁后还要再次核对当前版本与规划版本。规划已经失效时拒绝该操作，不能因为调用者猜中了新的版本而使用旧锁集合增加订阅，也不能在 endpoint 或订阅锁之后补取来源锁。已保留回执仍先按原身份核对，读回原操作不重新要求曾经的管理权。

ACL 刷新先沿用来源事务锁，再按 ID 排序锁保留订阅，等待结束后用新的 Read Committed 语句重新读取有效权限并集。该语句不取得新的来源锁；在订阅锁之后调用会锁 ownership/member/grant 的授权 helper 会倒置顺序。Project 删除使用独立删除作用域，Thread 的独立事务和 Task-first 锁序保持。

## 配置版本与操作回执

`configVersion` 覆盖名称、启停、订阅、目的地和秘密轮换的真实配置变化；无变化保持版本，但旧版本的同值写入仍冲突。`destinationRevision` 只覆盖实际 URL、adapter 或确定渲染配置的变化；名称和密钥轮换不修改它。HTTP 上的 int64 为规范的正十进制字符串，UUID 和枚举严格校验。

每次管理写入携带固定 operation UUID、原始 issuedAt 字符串和 expectedUserId。服务端保存规范化语义指纹及从实际请求字节计算的 requestSha256；二者用途不同。回执与配置效果在同一事务提交，重放先检查已有回执，再处理新操作的时间围栏。

新操作允许五分钟历史时间和一分钟未来偏差。回执独立保留三十天，每 owner 最多 1,024 份，每存储桶最多 8,192 份，每份预留 4 KiB。容量必须在效果之前原子预留；回执读取和已有操作的幂等返回不再消耗槽位。首次应用过期与无法找到旧回执都不能证明原操作未提交。

确认原意图需要匹配 actor、owner、种类、目标、issuedAt 和实际 body hash。复用 ID 但改变正文不能凭旧回执声称新意图成功。COMMIT 结果未知、HTTP 响应丢失和明确业务拒绝分别表达，错误链保持原事务完成事实。

重放先在操作 fence 内匹配不可变历史回执，结束该事务并释放连接后，再以同一个只读一致快照重新验证当前凭据、owner 和回执读取权，读取当前 endpoint、项目资格及其可见视图。Read Committed 中较早读取的管理员权限不能授权较晚出现的新配置；降权后必须返回当前只读视图，不能泄露新 URL。回执证明与当前配置读取分别保留各自事实，后者失败不把已匹配的原操作改写为未提交。HTTP 错误响应不输出回执或配置资料。

快照读取不嵌套在仍占连接的管理事务内，单连接池也能完成重放。正常 GET 和重放使用相同的快照投影规则，避免两套权限逻辑漂移。

轮换回执保存当时的 key ID 和重叠期限；后来的轮换或 endpoint 删除不会重写原操作结果。重叠期限作为内部效果元数据保存，公开回执形状保持稳定；不能从当前 key 列表推断旧操作的期限。

## 秘密与目的地加密

AES-256-GCM keyring 的 active master 在 runtime 生命周期内固定，保留旧 key 用于恢复已有记录。key ID 与三十二字节的规范 Base64 严格校验，配置错误不包含密钥内容。部署文件读取及 master rekey 的生命周期由应用组装负责。

每次写入使用新的十二字节随机 nonce。secretbox 在调用者的资源上下文之外认证 envelope version 和 master key ID；业务上下文使用固定版本、字段顺序和 NUL 分隔，绑定 owner、endpoint、记录种类以及目的地版本或签名 key ID。不能交换不同资源、目的或 key ID 的密文，即使两个保留 key 含相同字节。

目的地配置与签名秘密只以认证密文保存。普通视图使用安全 origin 展示；完整 URL 和签名秘密经过各自的当前权限判断。缺少旧 key、认证失败或随机数失败会暴露，不能重新生成秘密或回退到明文。

Endpoint 签名轮换与 master rekey 是不同操作。Endpoint 默认保留旧签名 key 二十四小时重叠，可立即撤销，重叠上限七天；最多一份当前 key 和一份有效重叠 key。再次轮换须明确结束原重叠。

## 容量、查询与验证

配额由数据库中的不可变 policy 版本提供，全副本使用同一上限。每 owner 最多二十个 endpoint，每 endpoint 最多五十条订阅，每条最多六个事件 binding；配置限制不能通过未加锁的 COUNT 或单进程 semaphore 实现。每份 endpoint、subscription、binding 和签名 key 的非密文元数据逐条序列化验证，包含父级标识和实际公开目的地元数据，必须符合 2 KiB 记录包络才能按固定费用记账；密文按实际持久化字节额外计费。元数据超限在预留和效果之前拒绝，URL 的普通路径与查询仍使用其独立容量约束。配置与回执预算拒绝发生在效果之前，限制性清理的当前资格不因存储失败而被错误地改写为无权。

读取使用当前 owner 及资料权限，游标绑定 owner、过滤与可见性；搜索不得使用调用者看不到的 URL。严格 JSON 处理未知及重复字段、非法 Unicode、显式 null 和超限请求；管理正文上限为 256 KiB。正常响应不包含密钥或加密输入，日志只保留有界关联身份。

验证区分纯规则与实际事务：DAO mock 检查输入和转换，隔离 PostgreSQL 检查回执/效果原子性、版本、配额、缺行围栏与撤权竞态；独立 HTTP fixture 使用真实身份及数据库，检查 redaction、响应丢失和原 body hash。签名发送及完整客户端的组合验证需使用相应实际后端结果。
