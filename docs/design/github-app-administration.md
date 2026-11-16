# 独立 GitHub App 管理员与邀请

## 权限与职责

独立 App 管理员关系只授予该 App 的管理能力，不改变 Team 成员、Project 权限或账号身份。登记与首位管理员的原子创建由[登记组件](github-app-registration.md)负责。管理员和邀请的业务规则在 `core/github`，共享模型在 `core/model/githubpr`，数据库中立能力在 `core/store`，事务和 SQL 在 `core/store/postgres`，用例预算与编排在 `service/github`，HTTP DTO 和协议适配分别在 `api` 与 `server/github`。

管理员列表仅向当前 App 管理员返回已有账号资料和 membershipVersion。移除指定成员必须匹配其原 membershipVersion；陈旧版本不因当前成员相同而成功。每次加入从独立 sequence 取得新版本，移除后重新加入不能恢复旧关系。未接受邀请不计入管理员人数，最后一名管理员不能被移除。成功自我移除返回有限回执与 `actorIsAdmin=false`，不追加依赖已失去权限的管理读取。

## 邀请身份与有效性

邀请固定授予 App admin。token 为 `dn_gai_` 加 32 个随机字节的无 padding base64url，存储仅保存完整 token 的 SHA-256。创建时间来自数据库，七天到期。邀请记录绑定创建者的精确 `issuerMembershipVersion`；检查与接受时要求 App 仍活、邀请未撤销或消费且未到期、创建者仍具有同一管理员关系。创建者失权后再加入不会恢复旧邀请。

检查仅返回 App 最小身份、到期时间和接收者自己的可空 membership，不返回管理员名册、Team 授权、项目或秘密。接受先检查邀请有效，再判断接收者是否已经是管理员；已有管理员保留原 membership 且不消费邀请。实际加入与邀请消费在同一事务提交，不创建外部身份或全局账号目录。

## 事务、读取与失败

接受、撤销、管理员移除和邀请创建先取得 App 根锁，再读取管理员或邀请。根锁覆盖当前管理员资格、人数与邀请状态之间的跨行决定；单个成员或邀请的版本不能单独保护这些事实。锁不跨远端请求或输入读取持有，等待接受 context 取消与 deadline。邀请 token 的定位查询只用于确定 App，取得根锁后重新读取有效性所需事实。只读列表使用共享快照及有界 keyset 分页，cursor 绑定操作者、App 和列表类型。

无效、过期、已消费、撤销、创建者失权或版本变化以及 App 删除统一表达为 `invitation_unavailable`。普通管理读取对无权资源使用隐藏式 404。写入保留 committed、not_committed 和 unknown，未知结果不自动重放；当前成员或列表事实不能证明某次未知写入的历史结果。

## 协议与采用边界

管理 API 使用 `/api/v1/github/apps/{id}` 下的 `/admins`、`/admin-invitations` 及精确成员移除、邀请撤销路径。检查和接受使用独立 `/api/v1/github-app-admin-invitations/inspect` 与 `/accept` POST，token 仅由 JSON body 传入。邀请链接使用可信 PublicOrigin 与 `/github-app-admin-invitations#<token>`，不放在 query 或路径中。响应设置 `Cache-Control: no-store`；列表不能恢复原 token 或链接，日志不记录 token、摘要或 fragment。

本地管理的 15 秒预算从 HTTP 输入读取开始贯穿业务和提交，更短父期限优先；客户端响应 context 与内部操作期限分开，内部超时或 unknown 可以明确响应，客户端取消不重试写入。HTTP adapter 未挂载生产 mux；实际接收页面、立即清除 fragment、仅内存保存 token 和 Go HTML GET/HEAD 路径与公开注册一同采用。在此之前没有生产邀请入口返回不可访问链接。
