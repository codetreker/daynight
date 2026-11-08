# 用户登录、Team 与项目权限需求

状态：UniAuth 身份交接、本地会话/PAT、Team 生命周期 API、项目成员授权、CLI 凭据和双语 Web 已接入
正式服务入口。运行配置必填，业务请求强制认证。本文定义当前实现的行为；
[架构设计](../design/daynight-auth.md)拥有机制，
[启用决策](../../.agents/notes/archived/architecture/2026-10-22-authentication-activation.md)
记录组合、配置与验收隐私的取舍。验证结果及真实上游人工登录以对应源码和回执为准，代码接线不代表全部
组合验收已经通过。

## 目标与范围

多人使用同一服务时，通过项目成员关系控制访问。UniAuth 确认外部身份，Daynight
拥有本地用户、浏览器会话、个人访问令牌、项目成员和邀请。登录用户从 Web 或现有
CLI 创建私有项目，创建者自动成为管理员；Web 表单复用现有 project 创建 API。

覆盖现有 project、task、依赖图、属性和附件。成员使用业务读写及任务生命周期
操作；网页元数据编辑不由登录功能增加，任务操作遵守[任务生命周期](daynight-server.md#状态与更新规则)。
每个项目具有真实 Team 归属，现有资源入口统一计算 owner Team 与独立 Project grant 的有效权限。
Personal 初始化和存量归属迁移遵守下述原子性与数据完整性要求。登录用户可以通过 Team API
创建、读取、分页、改名和删除普通 Team，并通过邀请加入普通 Team；当前 owner Team admin 可预览和转移项目。Team 成员管理和转移客户端保持各自的功能边界。

可信 HTML 保持现有同源执行，复用主站会话、普通 iframe、相对资源和键盘交互。
鉴权不能把独立预览域名、预览凭据或相关设施作为前提；该约束的选择依据记录在
[附件架构决策](../../.agents/notes/archived/architecture/2026-10-21-task-attachment-storage-design.md)。

| 编号 | 必需行为 |
|---|---|
| AU1 | 使用现有 UniAuth 产品登录协议与 Go SDK，App Secret 仅保存在后端。 |
| AU2 | 稳定外部身份对应唯一的本地用户，邮箱/姓名/头像为可空资料，不用邮箱匹配身份。 |
| AU3 | 登录事务绑定发起浏览器，原子校验和消费后才领取一次性身份。重放、过期、错误绑定与领取失败明确拒绝。 |
| AU4 | Web 使用可注销/到期的主站会话；CLI 通过设备授权取得关联用户的默认永不过期、可撤销凭据，网页令牌管理器可修改到期时间。普通使用无需手工 PAT，自动化保留显式 PAT 配置；凭据明文只交付一次。 |
| AU5 | 创建项目、真实 Team ownership 与创建者 direct admin 在同一事务提交；未指定 Team 时使用 Personal。有效角色只有 admin/member，两者具有业务读写及任务 set-status 能力。 |
| AU6 | 只有有效 admin 能管理独立授权、角色和邀请；Project 可以没有 direct admin，owner Team 的继承权限仍独立生效。 |
| AU7 | 项目列表先按成员筛选再分页；详情、任务、图、属性、附件列表、下载及预览逐请求执行项目授权。 |
| AU8 | 邀请有有效期、可撤销、单次使用；接受者先登录再明确确认，加入角色为 member。 |
| AU9 | 移除成员后拒绝新准入请求；已获授权并开始的文件传输允许完成。角色不固化在会话或令牌中。 |
| AU10 | 附件维持可信同源预览，以主站会话验证资源请求，保留脚本、模块、相对 CSS/图片/fetch、Esc/Tab 和焦点恢复。 |
| AU11 | 启用鉴权时，全部服务入口、客户端、部署健康检查和既有验收同次适配，不能依赖前端隐藏按钮。 |
| AU12 | 错误、取消及不确定写入可见；秘密不进入诊断、日志、仓库绑定或持久 URL。 |
| AU13 | 普通 Team 创建与创建者 admin 原子提交；本人列表和详情受成员资格限制，admin 按精确元数据版本改名或删除空 Team，Personal 禁止变更。 |

## 身份与凭据

配置一个 UniAuth 服务和已注册 App，使用该 App 允许的 Microsoft/Google/GitHub
入口。完整 provider-qualified id 映射到本地 UUID，不同身份不按同邮箱自动合并。
资料更新不改变本地用户和成员关系。每个用户恰有一个 Personal Team，包含其真实 owner admin 行；
规范用户建立、Personal 初始化与浏览器 session 原子提交。重复及并发登录复用相同归属，
已有 Personal 关系损坏明确失败。身份领取的实际解压响应最多 2097152 bytes，期限为 15 秒。
外部身份 ID、姓名和邮箱各最多 1024 UTF-8 bytes，头像 URL 最多 524288 UTF-8 bytes；
完整规范化 profile JSON 还须不超过 1048576 bytes，字段上限与整体上限同时生效。
可空字段保持原值；头像 data URL 原样保存，不增加 scheme 限制。上游响应协议错误（含读取、
关闭失败）或 profile 准入失败时，可响应的请求返回 502 `identity_unavailable`，不提交新用户、
资料、Personal Team 或 session，既有资料不变。
已消费的一次性登录事务保持消费，必须重新登录，不能重试同一 code。
登录页只能展示当前 UniAuth App 同时允许且
已启用的 provider。前端通过 `GET /api/v1/auth/providers` 读取 `{providers:[ids]}`；
读取失败显示可重试错误，空列表显示无可用登录方式，不能硬编码 provider 或以
全局启用状态代替 App 范围。服务使用固定版本的 UniAuth SDK 实时读取当前 App
与 registry 的交集；上游 App 配置/凭据错误返回 503，网络或协议错误返回 502，
超时返回 504，与当前用户会话的 401 分开处理。

`GET /me` 必须返回完整的 personalTeam:TeamRef，Personal 的 kind 为 personal、name 为 null，
ID 为真实且唯一的 Personal Team UUID。CLI 与 Web 严格拒绝缺失、非法或普通 Team 引用，
不能扫描列表猜测默认归属，也不能在读取时创建或修复关系。

浏览器使用服务端持久化的主站会话。生产 Cookie 为 host-only、Secure、HttpOnly、
SameSite=Lax；显式 HTTP 主站测试配置使用不带 Secure/`__Host-` 的测试 Cookie
名称，仍为 host-only、HttpOnly、Lax。它与 SDK gateway 的回环 HTTP 开关独立。
返回位置限主站内部路径，解码后的 UTF-8 内容最多 4096 bytes。首次合法登录请求缺少有效的第一方 scope Cookie 时，服务设置该 Cookie 并以 303 返回同一登录 URL，不建立交易。支持 Cookie 的客户端返回后才创建交易；每个 scope 最多有 5 条未完成且未过期的交易，全服务最多有 10000 条，期限为 10 分钟。scope 超限返回 429 `rate_limited`，全服务满时返回 503 `capacity_exhausted` 和 `Retry-After`；拒绝不撤销已有交易。scope 表示 Cookie 标识的逻辑浏览器，清除 Cookie 或并发首次请求无法关联为同一物理浏览器。注销终止当前 Daynight 会话，上游登录状态由 UniAuth 管理。
Cookie 写请求校验精确主站 Origin；明确提供无效 Bearer 时拒绝，不回退到 Cookie。

浏览器会话绝对有效期七天，与 PAT 的到期规则独立。PAT 由 Web 会话显式创建，或由该会话批准的
设备授权在领取时自动创建；默认永不过期，以 `expiresAt:null` 表达。手工创建请求必须显式提供
`name` 和 `expiresAt`，到期值为 null 或以 Z 结尾的未来 UTC 时间，不接受旧 `days` 输入。
有限时间以数据库微秒精度保存，正规化后仍须为未来。
账户页只显示用户自己的元数据，永不过期显示为“永不过期 / Never expires”；列表保持 `expiresAt` 字段，不能
用缺省字段代替 null。

令牌管理器允许将当前有效 PAT 的到期时间改为未来 UTC 时间或 null，保持同一秘密与散列，CLI
无需重新登录。修改必须绑定页面显示的账号和观察到的到期值：账号不匹配返回 403，观察值过期返回
409，已过期、撤销或不存在的令牌返回 404，不能通过编辑恢复。修改仅允许有效浏览器会话和精确
主站 Origin，PAT 不能管理其他凭据。提交期间阻止重复修改；结果不确定时只读取令牌列表核对，
读取失败保持禁写，不能自动重放 PATCH。

账户访问凭据页面还列出当前账户的 OAuth 应用授权，显示客户端、资源、范围、期限及有效、过期或撤销状态。
用户可撤销单个有效授权；该授权的访问与续期凭据随之失效，其他授权和 PAT 不受影响。确认操作展示
目标账户、客户端与资源。授权没有 PAT 的期限编辑功能。读取失败可重试；撤销结果未知时不得自动重放，
须由用户显式读取当前状态，读回结果不声称恢复了原请求的历史回执。后台身份与数据检查保留已有界面和草稿；
确认账户变化或会话失效时隔离旧账户数据。

撤销或已设置的到期时间到达后，新请求返回未认证，不影响其他会话或令牌。凭据代表用户当前全部
项目权限，不另设令牌角色。CLI 凭据绑定有效服务 origin，不进入仓库绑定、明文命令参数或日志，
重定向不得转发凭据。

CLI 在缺少配置文件或 `serverUrl` 时使用 `https://daynight.cc`，保留显式地址配置供测试服务使用。
普通业务命令不询问服务器或 PAT。本地无凭据时，业务命令在派发请求前报错并提示
`daynight login`；服务 401 也只给出登录指导，不自动登录、匿名回退或重试业务写入。
自动化通过受控配置文件提供 `serverToken` 和匹配的服务 origin，不提供顶层 setup 或令牌命令参数。
HTTPS 或字面量 localhost/numeric loopback HTTP 才能使用令牌。外部更换 origin 时必须移除或替换旧
令牌；外部文件写入不执行 CLI 的锁和凭据清理协议。CLI 登录/退出在锁内共同核对 origin 与令牌；
含凭据文件在 POSIX 上使用 `0600`，其他能力写入同样遵守。YAML 错误不泄露标量或
原始 parser cause。配置并发和持久化要求由[客户端 C6](daynight.md#c6-按需配置引导)与
[客户端配置要求](daynight-project-task.md#pt2-服务配置)拥有。

## CLI 设备授权

`daynight login [--no-browser]` 是用户主动发起的设备授权入口。默认显示验证 URL、短码和到期信息，
尝试打开浏览器；打开失败时仍可手工访问。`--no-browser` 可在另一台设备的浏览器完成授权。
业务命令与登录互相独立，首次使用、会话失效或 401 都不得自动开始授权。CLI 是公开客户端
`daynight-cli`，不携带 UniAuth App Secret；Daynight 管理设备授权，复用现有 UniAuth 浏览器登录。

一次授权有效期十分钟。设备秘密与可读短码分开，服务器只持久化设备秘密摘要。初始轮询间隔五秒，
`authorization_pending` 继续等待，`slow_down` 将间隔增加五秒；拒绝、过期或其他终止错误明确结束。
连接超时降低轮询频率，取消停止本地等待；失败不覆盖已保存凭据。创建和短码查询采用跨副本有效的
持久速率限制。请求、响应与方法拒绝保持 `no-store`，不得记录设备秘密、短码或凭据。

`/device` 允许输入短码，也接受预填短码；用户必须核对终端与网页中的短码、当前账号及访问范围后
明确批准或拒绝。打开页面、GET、登录成功和检查授权均不批准。决定提交页面展示账号的 expectedUserId，
服务端在修改前与当前 Cookie 身份核对；账号已切换时明确拒绝，授权保持 pending。检查与决定接口
仅接受当前有效浏览器会话和精确主站 Origin，PAT 不能调用。授权页沿用中英文、身份失效、前台核验和请求取消规则；
待提交期间阻止重复决定，不确定写入先检查实际状态，再允许新的用户决定，不自动重放批准或拒绝。
已决定结果只允许决定账号读取，且保留至过期后一小时的清理窗口。

批准把账号绑定到授权。CLI 在发起登录时读取一次本机 hostname，所有领取轮询通过必填
`device_name` 传递该值，`--no-browser` 或其他设备批准不改变来源。机器名必须为有效 UTF-8、
1–255 个 Unicode 字符、非空白且不含控制字符；非法或缺失值返回 `invalid_request`，不消费授权。
领取在同一事务原子消费授权并创建默认永不过期的 `Daynight CLI (<hostname>)` 凭据；
hostname 展示取前 85 个 Unicode 字符，确保完整名称不超过 100 个字符。名称只是客户端提供的展示信息，
不证明机器身份，不参与授权。已有凭据名称保持原值。
授权页说明其持续访问与撤销方式，不增加到期选择器。用户可在账户令牌管理器设置到期时间或撤销；
并发领取最多产生一条。明文只在成功领取响应中返回一次，服务器不保存可重放秘密。成功响应丢失
需要用户重新执行 login，遗留凭据可在账户页撤销。以后设置的到期时间到达或凭据被撤销后，重新
登录才能取得新凭据；修改未到期令牌的到期值无需重新登录。不增加后台续期或 refresh token。

CLI 保存前在配置锁内重读并核对授权开始时的有效 origin 与凭据观察值，防止覆盖期间完成的服务切换
或另一次登录；保存失败明确报告，不能宣称登录成功。`daynight logout` 通过当前 Bearer 撤销自身，
确认成功或当前凭据已失效后再在锁内清除该本地值；不能清除期间另一次登录取得的新凭据。网络失败和
不确定远端撤销必须可见，不能伪装为完成。此操作不注销浏览器或撤销其他凭据。

公开设备端点遵循 [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) 的 form 请求与 snake_case
字段；浏览器端点保留 Daynight JSON 错误 envelope。`verification_uri_complete` 可携带供用户核对的
短码，`device_code`、访问凭据及上游一次性身份 code 不能放入 URL。

## 认证响应的身份归属

认证成功后，所有经过 Require 的响应包含 `Daynight-User-ID`，值为实际准入的
`model.Principal.UserID`；成功、空正文写入及之后的资源错误均保留。请求头中的同名值
不能控制返回身份，Bearer 与 Cookie 并存时仍服从既有 Bearer 优先规则。认证或
Cookie Origin 准入失败不输出未经准入的用户 ID。该头用于客户端核对内容归属，
不作为凭据或项目授权，不能代替每请求的成员检查。窗口摘要及未来持久缓存使用
[任务同步合同](daynight-task-sync.md)的作用域规则。

## 当前用户资料的条件读取

GET/HEAD `/api/v1/me` 每次先按当前凭据认证，并成功读取当前用户的最小资料，再决定是否复用表示。成功响应使用 `Cache-Control: private, no-cache` 和强 ETag；标识覆盖完整公开表示中的用户 ID、nullable email/emailVerified/name/avatarUrl，不包含登录时间等无关变化。当前表示与 If-None-Match 匹配时返回无正文 304，资料变化或实际账户不同则返回完整 200；认证身份头始终来自本次实际准入。HEAD 不返回正文。认证或资料读取失败保留既有错误与 no-store，不能返回 304。

Web 只为 `/me` 使用浏览器的 no-cache 重验模式，由浏览器 HTTP 缓存保存资料与验证器。页面刷新及前台身份核验仍进行实际认证，但未变化的姓名、头像等响应正文可以跨刷新复用；缓存缺失或被浏览器清理后重新读取完整资料。该表示不写入自定义 IndexedDB，也不替代身份核验、项目授权或 foreground gate。其他认证及业务端点沿用自身缓存策略，一次性凭据不进入人员内容缓存。

## Team 生命周期

Team 的身份是规范小写 UUID，名称只用于展示。Team 元数据与当前主体真实成员关系分开版本化；
项目中的 `TeamRef` 仍只有 `{id,kind,name}`，不能作为 Team 设置或目录的读取凭据。
Team API 使用既有 session/PAT、Cookie 写请求 Origin 校验、`Daynight-User-ID`、
`Cache-Control: no-store` 和 JSON 错误 envelope。仅当前 Team 成员能读取详情；
不存在或不可见的 Team 都返回 `404 not_found`，只有项目单独授权不授予 Team 访问权。

| 方法与路径 | 输入或权限 | 成功结果 |
|---|---|---|
| `GET /api/v1/teams` | 当前主体；可选 `limit`、`cursor` | `200`，本人已加入的 Team 分页 `{items,nextCursor}` |
| `POST /api/v1/teams` | `name,expectedUserId` | `201`，新普通 Team 与创建者 admin 成员关系；`Location` 指向新 Team |
| `GET /api/v1/teams/{teamId}` | 当前 Team member/admin | `200`，Team 元数据与本人真实成员关系 |
| `PATCH /api/v1/teams/{teamId}` | 当前 admin；`version,name,expectedUserId` | `200`，保存后的 Team 与本人真实成员关系 |
| `DELETE /api/v1/teams/{teamId}` | 当前 admin；`version,name,expectedUserId` | `200`，有限回执 `{teamId,deleted:true}` |
| `GET /api/v1/teams/{teamId}/members` | 当前 Team 成员 | `200`，完整目录 `{items}` |
| `PATCH /api/v1/teams/{teamId}/members/{userId}` | 当前 admin；`version,role,expectedUserId` | `200`，`{membership,actorRole}` |
| `DELETE /api/v1/teams/{teamId}/members/{userId}` | 当前 admin 或本人；`version,expectedUserId` | `200`，`{teamId,userId,removed:true,actorRole}` |

创建、分页条目、详情和改名返回同一结构：
`{id,kind,name,version,createdAt,updatedAt,membership:{teamId,userId,role,version,createdAt,updatedAt}}`。
`kind` 为 `personal` 或 `ordinary`；Personal 的 name 为 null，普通 Team 的 name 为原始文字。
两个 version 均为无损正 int64 JSON number，时间为 UTC。membership 只表示当前主体的实际成员行，
不包含其他成员或个人资料。列表在排序与取页前按认证主体的成员资格筛选，按 `(createdAt,id)`
稳定分页；cursor 绑定该主体，跨账号续页、未知或重复参数、显式空参数及畸形 cursor 明确拒绝。
空页的 items 为 `[]`，末页 nextCursor 为 null，不增加搜索或总数。

任意登录用户可创建普通 Team；Team 与创建者的真实 admin 行原子提交。普通名称必须是合法
Unicode 文本、不含 NUL、且不全部由 Unicode `White_Space` 组成；原始文字及首尾空白完整保存，
允许重名，且同时不超过 256 个 Unicode code points 和 1024 个 UTF-8 bytes。通用请求大小限制保持。
创建或真实改名时的超限名称、未知、重复、缺失、null、错误类型字段、非法 Unicode 转义、非规范 UUID，以及非正或越界版本
返回 `400 invalid_input`；名称拒绝不改变 Team、成员关系或版本。

所有 Team 管理写入在任何领域 SQL 前核对 expectedUserId 与实际 principal；错主体返回
`409 identity_mismatch`，Team、成员和 ownership 行及版本均不变。读取权不包含管理权，
普通 member 改名或删除返回 `403 forbidden`。Personal Team 允许本人读取，改名与删除返回
`409 personal_team_immutable`。

改名先比较元数据 version，过期请求即使 name 恰与当前原文相同也返回 `409 version_conflict`。
精确版本下的相同原文是 no-op，保留版本和全部时间；这也适用于限额生效前保存的超长名称。真实名称改变使元数据版本加一。
元数据版本达到最大正 int64 时仍接受同值 no-op，真实改名返回 `409 version_exhausted`。
删除同时核对精确元数据版本和当前名称原文，任一不符返回 `409 version_conflict`；只有没有
活跃 Project 的 ownership 引用的普通 Team 可删除，否则返回 `409 team_not_empty`。删除原子移除
现有邀请、成员和 Team，不隐式转移或删除 Project，不改写独立 Project grant。

目录每项是 `membership` 的字段加 `profile:{name,email,avatarUrl}`；profile 对象必填，三个字段
均可为 null。`role` 和 `actorRole` 为 `member` 或 `admin`；退出成功的 `actorRole` 为 null。

Team 成员目录仅对本 Team 的当前成员开放，包含每位成员的可空姓名、邮箱、头像、角色、
真实成员版本和时间；只有 Project 单独授权不能读取目录。目录读取失败或用户资料缺失时整个
请求失败，不返回部分目录。普通 Team admin 可修改已有成员角色或移除成员；普通成员可自行
退出，但不能管理他人。加入只能通过邀请接受，不提供按 UUID、姓名或邮箱加人。Personal Team
成员关系固定，角色修改和退出均返回 `409 personal_team_immutable`。

角色修改和移除必须提供观察到的真实成员 version 及 `expectedUserId`，主体核对先于领域 SQL。
过期版本返回 `409 version_conflict`，即使所请求角色与当前角色相同也不例外；精确版本下的
同角色操作不改变版本或时间。降低或移除最后一名 admin 返回 `409 last_admin`；并发操作也
必须保留至少一名 admin。删除后重新加入获得新版本，旧操作不能命中新关系。成功回执包含
提交后操作者的 Team role，退出后为 null；所有成员变更不改写 Project 独立 grant。

仅确认事务提交后交付成功资源或删除回执。领域拒绝不产生领域写入；取消、SQL、rollback 和
提交错误保持原有优先级及原因链。无法确认 COMMIT 结果返回 `503 write_outcome_unknown`；
清理失败返回安全的 `500 internal_error`，不把保存的领域拒绝当作最终结果。响应丢失或提交结果
未知时只读取当前事实，不自动重放管理写入；当前值符合目标不能证明找回了原提交回执。

## 项目归属转移

`POST /api/v1/projects/{projectId}/transfer-preview` 接收 `{targetTeamId}`，只允许当前
owner Team admin 读取同一快照下的 `sourceTeam`、`targetTeam:{id,kind,name,version}`、
`ownership:{teamId,version}` 和必填可空 `actorRole`。目标以规范小写 UUID 指定，返回的
资料仅限名称和身份；不要求目标成员关系，也不提供目录或全局搜索。

`POST /api/v1/projects/{projectId}/transfer` 接收必填
`{ownership:{teamId,version},targetTeam:{id,version},expectedUserId}`。主体核对先于领域 SQL；
提交前重新检查当前 owner Team admin、归属身份和版本、目标存在和元数据版本。过期观察返回
`409 version_conflict`，不可见项目或不存在目标返回 `404 not_found`，仅有 Project admin
而非 owner Team admin 返回 `403 forbidden`。同一 owner 仍核对权限和双方版本，返回
`changed:false` 且不更新任何时间或版本；实际转移使 ownership version 加一，保留 Project
身份及所有 grant 和邀请。版本耗尽时真实转移返回 `409 version_exhausted`。

成功回执 `{projectId,changed,sourceTeam,ownerTeam,ownership,actorAccess}` 只在确认提交后
返回；`actorAccess:null` 表示操作者成功转移后失权。无法确认提交返回
`503 write_outcome_unknown`，丢失响应后即使项目读取为 404 也不能推断提交成功，不得自动重放。
所有版本是精确正 int64，响应和方法拒绝使用 `no-store`。

## 项目、成员与邀请

| 操作 | member | admin |
|---|---|---|
| 项目、任务、图、属性和成员名单读取 | 允许 | 允许 |
| 任务元数据、依赖、属性、set-status 和附件管理 | 允许 | 允许 |
| 邀请、移除成员、调整角色和撤销邀请 | 拒绝 | 允许 |
| 项目提醒阈值修改 | 拒绝 | 允许 |

新任务默认 todo，元数据 PATCH 不接受 status；set-status 使用
独立的版本化状态设置。它们均按当前项目成员关系授权，管理员额外管理成员、邀请与项目提醒设置，
不增加状态专属角色。生命周期状态、版本和依赖条件由服务需求拥有；项目访问权
不等同于 Agent 执行或交付的会话授权。

项目/任务 ID、仓库地址与本地绑定不是凭据。`GET /api/v1/projects/{projectId}/members`
返回 `{items: ProjectParticipant[],actorAccess:ProjectAccess}`。每项包含 `userId`、必填 `profile` 对象、
`effectiveRole`、必填可空 `inheritedFrom:{team:TeamRef,role}` 和 `directGrant`；profile 的 name/email/avatarUrl 三个字段必填且可为 null。
缺少规范用户行是完整性错误，整个读取失败，不能静默删去该来源或伪装成空资料。
名册是当前 owner Team 成员与独立 Project grant 的去重并集；有效角色为两种来源在
`none < member < admin` 下的最大值。只有继承权限时 directGrant 为 null；有效角色不等于可写授权记录。

独立授权的新增、修改和移除由有效 Project admin 执行，可针对本人或其他 admin；不改变 Team 角色，
也不要求保留 direct admin。新增目标必须已经是有效 ProjectParticipant，外部用户仍须本人接受邀请，
不能通过任意用户 ID 加入项目。Team admin 即使有 direct member grant，有效角色仍为 admin。

`PUT /api/v1/projects/{projectId}/grants/{userId}` 接受
`{version:null|正 int64,role:"member"|"admin",expectedUserId}`：null 要求 grant 不存在，
正版本要求已存在且与真实 grant 版本相等。成功 200 返回 `{grant,actorAccess}`，其中 grant 是
指定的完整 ProjectGrant。`DELETE` 同一路径接受 `{version:正 int64,expectedUserId}`，成功 200
返回 `{projectId,userId,deleted:true,actorAccess}`。两种回执的 actorAccess 是同一事务中变更后的
完整 ProjectAccess；本人失去项目访问时为 null，仍表示已确认成功。回执不包含项目内容或人员目录。

角色修改与移除读取 `directGrant.role/version`，不使用 effectiveRole 或合成版本。grant 版本是
独立于 task.version 的不连续正 int64 JSON number；大于 `2^53` 仍须无损。存在性或版本前置条件
不匹配返回 409 `version_conflict`，目标不是有效 participant 返回 404 `not_found`。同角色更新也须先
匹配版本，匹配后保留版本；移除后重新加入获得新版本，旧观察仍冲突。

既有 `PATCH .../members/{userId}` 接受 `{version,role,expectedUserId}` 并返回真实 ProjectGrant；
`DELETE` 接受 `{version,expectedUserId}`，成功仍为 204 无正文。旧路径只操作已有 direct grant，
不存在时返回 not_found。所有这些写入在任何领域 SQL 前验证 expectedUserId 与实际 principal；
错主体返回 409 identity_mismatch，领域行和版本零变化。客户端核对响应的 `Daynight-User-ID`，
错主体触发身份重验，不安装结果。新的 grants 路径在无法确认 COMMIT 时返回 `write_outcome_unknown`；
响应丢失同样不能证明提交结果。未确认的已发送写入不得自动重放，后续读取只证明当前事实，不能恢复
原操作的成功回执。Team 关系与 Project grant 独立，撤销一种来源不能撤销另一种来源。

创建 Project 接受原文 `name`、`repoUrl`、可选 `teamId` 和必填 `expectedUserId`。目标 Team 的
当前 member 或 admin 可创建；省略目标时使用调用者 Personal Team。Project、真实 ownership 与
creator direct admin 原子提交。身份不符在任何领域 SQL 前返回 409 `identity_mismatch`，非成员
不可创建。客户端核对响应主体，不自动重放未知写入。成功返回 Project、ownership 和同一事务中
新鲜的 access。CLI 未指定目标时使用当前身份的 Personal Team；Web 创建入口提交打开对话框时捕获的 Team。两者使用当前真实身份并保留有效名称与仓库地址原文。

既有项目按最早加入的现任 admin 的 Personal Team 回填；加入时间相同按 user UUID 稳定决定。
全部既有用户，包括仅持 PAT 的用户，预先取得 Personal。零 admin 或坏引用使迁移整体失败，
不能猜测 owner。迁移保留 grant、邀请、项目/任务内容、时间和版本，以及原 grant sequence 的
实际高水位与 is_called；删除高版本后留下的 sequence 状态不能按存活 MAX 重置。

邀请固定七天，属于项目，创建者离任不自动撤销。创建时一次显示可复制链接；列表
只显示元数据和撤销入口。有效期至消费、到期或管理员撤销。接受者必须登录并明确
确认，GET、链接预览、inspect 和登录跳转不消费。inspect 返回项目 ID、名称及当前
主体的可空 directGrant 和 access，不公开成员目录。接受与消费原子提交，并发只增加一名
新成员；已有直接授权保持原角色且不消费邀请，仅有继承权限的人仍新增 direct member。
accept 返回真实 directGrant、有效 access、joined 和 consumed，成功后进入该项目。
创建、撤销和接受携带 expectedUserId，服务端在任何领域 SQL 前核对主体；客户端核对
响应主体，不自动重放未知写入。创建结果丢失时无法恢复一次性链接。

## Team 邀请

普通 Team 的当前 admin 可创建、列出和撤销邀请。创建和撤销携带 `expectedUserId`，
在任何领域 SQL 前核对实际主体；Personal Team 拒绝创建。秘密以 `dnteam_` 开头，
七天有效，只授予 member，创建时一次返回 `/team-invitations#<secret>`；列表仅返回
元数据。发起者离任不撤销邀请。无效、到期、已消费、撤销及目标删除均返回
`404 invitation_unavailable`。

`GET/POST /api/v1/teams/{teamId}/invitations` 分别返回 `{items}` 和一次创建结果；
`DELETE /api/v1/teams/{teamId}/invitations/{inviteId}` 返回
`{teamId,invitationId,changed}`，重复撤销为明确 no-op。元数据包含 `id`、`teamId`、
`createdBy`、`createdAt`、`expiresAt`、可空 `consumedBy`、`consumedAt`、`revokedAt`；
创建结果额外包含 `link`。`POST /api/v1/team-invitations/inspect` 接收 `{token}` 并返回
`{team,membership}`，membership 可空；`POST /api/v1/team-invitations/accept` 接收
`{token,expectedUserId}` 并返回 `{team,membership,joined,consumed}`。Team 是真实
`TeamRef`，membership 是当前主体真实成员行，包含正 int64 version 和 UTC 时间。

已登录接收者 inspect 只读取 Team 身份和本人是否为成员，不公开目录；明确确认后
accept 携带 `expectedUserId`，返回本人真实成员关系、`joined` 和 `consumed`。
有效性检查先于成员检查：已有成员保持原角色且不消费，新成员与单次消费原子提交。
接受与撤销竞争由实际提交顺序决定。删除 Team 在同一事务清除邀请，旧链接不可用。
客户端核对响应主体；未知写入不能自动重放或显示成功。确认成功页面显示真实 Team 名称、ID 和本人加入结果，并提供打开该 Team 的入口；进入后同步当前 Team 上下文。

## 当前主体的项目权限

`GET /api/v1/projects/{projectId}/access` 在当前读取快照内返回本人权限：
`{projectId,ownerTeam,ownership,effectiveRole,teamRole,directGrant,canTransfer}` 全部键必填。
ownerTeam 是同快照 TeamRef，ownership:{teamId,version} 对应真实归属，版本为无损正 int64。
teamRole 为 null/member/admin，effectiveRole 是实际双来源的最大角色，canTransfer 仅由
owner Team admin 决定。Project 创建、详情、分页、图、task-sync 和客户端缓存均必填
相同内在 ownership 形状；GET Project 另带同快照新鲜 access。
directGrant 为 null 或完整的 projectId、userId、role、version、createdAt、updatedAt；
其版本是实际独立授权的正 int64 JSON number，时间为 UTC，不附带姓名、邮箱或头像。
只有继承权限时返回 directGrant:null；独立授权存在时返回其真实 role/version，
即使继承角色更高也不改写 grant。未准入和缺失项目沿用 not_found，
真实查询或事务失败不能表现为 null grant 或默认角色。响应保留认证主体头和 no-store。
成员读取返回 `{items,actorAccess}`，两者来自同一快照；participant 必含可空
inheritedFrom:{team:TeamRef,role} 和 directGrant。Team 名称和成员资料只留在当前身份与
项目的内存中，不写入任务缓存。全部当前消费者同次更新，缺字段、错误归属及损坏关系
明确失败，不使用旧形状 fallback。

Web 的项目、设置、成员、Task 弹层及独立 Task/附件页面使用同一份身份/项目绑定的
内存权限投影控制本人操作；CLI Worker 管理读取当前 access。完整成员资料只承担
名册和 claim owner 的姓名、邮箱、加载、错误重试与离任展示，不据其推断本人权限。
TaskSync 成功响应即使没有任务变化也发布本人角色；普通可见图页面每 15 秒同步。
没有同步刷新时，可见页面在距上次成功观察三十秒后读取 access，隐藏时暂停。
恢复可见、focus 和打开管理操作时重验，并合并同一作用域的并发读取。

迟到的旧身份、旧项目或较早请求不能替换较新的观察。读取失败保留明确 stale/error
与重试，管理提交等待当前 access 核验；网络失败不能视作撤权。确认失权沿现有项目
缓存撤权路径处理，包含只存在持久历史、首次同步仍在途的冷 scope。迟到的旧同步不能
在已确认失权后恢复私有详情；较早历史的 denial 也不能撤销已验证的新历史。
生命周期或存储核验失败提供错误与重试，不能授予默认权限。角色及 grant 不写入持久
任务记录，也不能代替服务端每请求授权。

成员名册、邀请列表和项目设置具有自己的资源读取状态。确认自删 grant 后先重验当前 access：只有权威 not_found 才按失权导航；仍有继承访问时保留项目页面。
自降级或自删只改变 direct grant，确认文案不能断言一定失去管理或访问。核对网络、协议或服务失败
保留错误与读取重试，不自动重放删除。

确认项目失权时，正在进行的
旧资源读取同步失效，迟到响应不能重新展示姓名、邮箱或设置；私有资源也不能在权限
unavailable 时渲染。暂时的 access 错误与资源读取结果分别保留：权限恢复后必须能够
展示已确认的资源，或明确重读缺失资源。资源尚未可用时，其错误与重试入口不能仅因
access 成功而消失；普通权限刷新保持设置草稿和未知写入的核对约束。已确认写入后的
较新设置值与成功反馈不能被较早的恢复读取倒退，已有写入也不能被读取失效取消。

## Web 交互与状态

项目设置展示真实 owner Team，只有当前 owner Team admin 可以预览和确认转移；仅有 Project admin 不足以转出。目标可从已加入 Team 选择，或输入 UUID、同服务 Team 页面链接，无需目标成员资格。确认展示目标和转移后权限，独立授权与邀请保持。归属或目标版本冲突必须重新预览并确认；已派发操作的未知结果不能自动重发，后续 404 也不能证明成功。成功回执决定结果；仍有 access 时留在项目，失权时清除项目私有缓存并按精确 source Team 访问结果返回原 Team 或 Personal。网络失败保留成功结果和可重试导航。

项目成员页区分有效角色、Team 继承和单独授权。有效 Project admin 可为仅继承的现有
participant 新增单独授权，或修改、移除真实 grant；操作前确认对象及权限变化。成功按
提交回执显示结果，本人失权时仍显示成功并提供返回入口。冲突须重读并重新审阅，未知
结果不自动重放。项目外部 admin 不需读取 owner Team 目录或设置即可管理项目授权。
成员表格在列内容超过自身容器时允许横向滚动；侧栏展开后的中间宽度仍须能操作
单独授权和移除按钮，页面本身不产生横向溢出。

正式 `Application` 在常驻 LocaleProvider 下组合公开首页、公开指南与 `AuthenticatedApp`。
公开内容由[推广页要求](daynight-landing.md)拥有；认证应用在独立 `/login` 和业务路径提供
登录、私有项目创建、设备授权、账户与令牌、项目成员、项目执行提醒设置和邀请接受界面。现有项目页签、附件页签、
渐进任务图与居中任务详情对话框继续复用。工作空间侧栏支持本地记忆的桌面折叠和独立的
窄屏覆盖导航，行为由[工作空间导航需求](daynight-web.md#工作空间导航)拥有。覆盖导航留在
认证屏障内，普通身份核验期间保持打开，实际阻塞恢复时关闭；身份恢复对话框和原有内容身份隔离保持优先。独立前端 fixture 只证明组件行为，真实
服务、SDK 协议和第三方人工登录具有各自证据。

`/projects` 是项目列表和默认登录成功目标。匿名打开受保护的项目、任务或附件时，
进入 `/login?returnPath=...` 并保留目标的路径、query 和所选页签。缺少目标才使用默认值；
已提供的目标必须是有效站内目标，外部地址、协议相对路径、反斜线、控制字符、登录循环
和不支持的页面明确拒绝。已有会话访问 `/login` 直接进入有效目标或 `/projects`，
历史返回不应反复显示中间登录页。已知登录事务的 callback 失败时，除上游响应协议错误或
profile 准入失败返回 502 外，显示独立登录错误并保留有效目标，包括建立本地 session 失败；
失败不重放可能已消费的身份 code。

邀请凭据在跳转前从 fragment 同步捕获并移出地址；以有效回跳目标识别同一邀请流程，
经过 `/login?returnPath=/invitations` 或 `/login?returnPath=/team-invitations` 和账号切换时保留，凭据不进入回跳参数。主动离开邀请
到公开首页或指南时仍清理临时凭据，清理失败保持可见。设备登录保留原 `user_code` 和授权
目标，批准继续需要明确确认。普通退出成功回公开首页，邀请或设备流程的切换账号继续
原目标；退出失败保持错误和重试入口。

会话失效和切换身份清除先前用户内容并使旧请求失效；项目 404 仅影响对应资源。
页面曾隐藏或顶层窗口失焦后返回可见且聚焦状态时，在后台重新确认身份。普通核验
等待期间保留当前正文的可见性和交互，不显示全屏等待层、不隐藏正文或打断正文焦点；
表单、秘密、详情与管理对话框、窄屏导航、滚动位置、图视口和附件 frame 在等待及恢复读取的全过程保持原状态；
同一身份、权限与数据确认不重置界面，局部编辑仍可进行。实际阻塞恢复时覆盖导航按导航规则
关闭并释放交互隔离，避免与恢复层竞争。展示保留不授予请求、发布或写入准入。每次新的有效返回
都会替换正在进行的确认，旧响应不能覆盖最新身份判断。同一用户确认成功保留组件；
确认不同用户或会话失效后清除旧内容。核验尚未完成且未另行确认资源撤权时，已经加载的内容仍可访问，
顶层隐藏或外部失焦时立即暂停新普通 API 读写；首次已离开前台的鉴权挂载也必须
在子组件请求前暂停。恢复可见性时的任务图刷新不得早于这项暂停，不受焦点与
可见性事件的先后顺序影响。返回后读写等待身份结果：同一用户成功后继续，换号或会话失效则
取消旧身份下排队的请求，不得在旧账户界面中以新账户执行操作或展示新请求结果。
身份核验和退出请求不等待自身核验；等待支持取消，失败后的恢复期间继续等待。
确认失败保留原状态并遮蔽内容，明确提供重试；重试或再次返回前台触发的恢复核验
在成功前持续遮蔽。同源 iframe 与父页之间的焦点切换不作为顶层返回。
当前身份通过核验后可以先显示本用户、项目与有效生命周期下经过完整性校验的持久任务摘要，同时后台同步；摘要展示不授予详情正文或写操作的在线准入，后者仍要求当前挂载实际用户匹配的成功项目同步。同步、详情和全部任务写响应缺失或畸形 `Daynight-User-ID` 作为协议失败，不据其错误状态清理有效缓存；可信不同用户立即清除旧认证内容再核验身份。退出、身份替换或会话失效必须同步阻止旧内存与迟到结果发布，持久清理只覆盖所属用户。普通同用户前台核验保留 scope；持久读取与正向内容发布遵守相同等待规则。已经通过同用户响应确认的 not_found 可在暂停期间立即撤回匹配项目 generation 的准入并通知其他标签页，存储清理仍等待 gate；清理失败不恢复私有正文，新的在线项目同步才重新准入。可信 `410 task_deleted` 只移除对应任务并同步项目，不撤回项目访问。缓存行为由[任务缓存需求](daynight-task-sync.md)拥有，删除行为由[软删除需求](daynight-task-deletion.md)拥有。

当前身份域中的 TaskDetailSessionProvider 共享 project/task 的待提交、冲突和未知
结果状态，关闭后重开不能重复批准；身份变化清除旧会话状态，语言切换不重建它。
成员修改和项目设置分别使用所属资源的完整正 int64 观察版本，前端解码、展示和提交不经过有损 Number。
Team 设置、成员和邀请的普通身份复核及恢复后的后台重读在等待全过程保留已显示资源、邀请区域、打开的确认、草稿和焦点，不插入加载行或禁止本地编辑。首次读取仍显示加载，真实变化和读取失败按实际结果处理。写入须等待当前 Team、成员及邀请所需的新鲜权限和版本；选中成员的版本或角色变化使待确认操作失效。显式核对保留原写入的待定、未知或确认结果及重复提交限制，当前 GET 不能证明旧写入成功，也不重放写入。
Project 设置、成员与转移在普通身份或 access 复核期间保留已确认的角色、表单、名册、邀请、打开的对话框和转移选择；同数据的检查不得重建这些界面或覆盖草稿。检查继续执行，保留的展示不授予写入权限。操作等待在途核验，恢复后重新核对当前角色、归属与所观察的版本及原操作身份；真实降权、归属变化、失权或旧身份不得提交过期操作。在途结果仍绑定原身份和资源，发布等待准入；已确认写入不重放，真实失权与失败仍按各自规则处理。
设置页按用户/项目隔离，复用同一前台身份检查和请求等待；同用户确认保留草稿，换号使旧读写失效。
设置不确定写结果须先核对 Project 与当前 access再允许新写入，核对失败仅提供读取重试，不自动重放 PATCH；
设置的详细合同由[计时需求](daynight-task-timing.md)拥有。
邀请 fragment 立即移出地址，以 tab 内临时存储跨登录；inspect 不消费邀请，只有
明确确认才 accept，结束后清理。普通 Team 成员页与项目成员页分别提供各自范围的邀请管理；只有对应 admin 可创建和撤销，Personal Team 不提供 Team 邀请，Personal 的项目仍可邀请。创建表单一次提交，撤销需一次确认，取消或 Escape 不写入。列表显示元数据而不包含链接。PAT 和邀请链接仅在创建时展示，复制失败可恢复，
关闭前提示并确认一次性秘密无法重新读取。错误保留 requestId，不伪装成空列表；未知写入不自动重放，读取当前邀请不能恢复原操作结果或丢失的链接。权限变化后仍须显示未知结果和已确认的一次性创建结果；无权读取时明确说明，不能声称已读取，也不能因此阻止普通 Team 成员退出。

全部第一方鉴权界面遵守[双语要求](daynight-web-i18n.md)：登录、项目创建、账户、
成员、邀请、设备授权、令牌、管理对话框及其文档标题、无障碍文案、错误、校验和异步通知
同时覆盖英语与简体中文。复用同一 LocaleProvider、语言选择器和原生格式化器，
语言只改变展示；输入、一次性秘密、成员观察版本、当前身份及进行中的请求保持，
切换不触发请求重试或重复提交。

## 同源附件

HTML 附件继续作为可信项目代码，拥有浏览者当前的主站权限。这沿用既有附件决策；
项目授权验证每个服务端资源请求，不提供上传代码的执行沙箱。

普通 iframe、图片、PDF、相对 CSS/JS/模块和 fetch 复用主站 Cookie。HEAD 和后续
GET 都执行鉴权。会话失效返回明确的 401，不将登录 HTML 当成文件；Web 使用已有
错误反馈引导重新登录。下载继续使用 attachment 语义，文件目录和内容不改写。
详情对话框通过现有同源文档桥处理 Esc、Tab 和焦点，不增加预览会话或消息协议。

继续一次一个文件、bucket/path 和原预算。文件系统与 PG 非原子性保留 K1，普通
IO/数据库错误可见；不承诺撤回已发送字节或中止已准入的文件操作。

## 配置与运行边界

下列五项服务端鉴权配置均必填，缺少或无效时启动失败；App Secret 不下发到前端。
数据库、存储根目录和既有生命周期配置继续遵守服务要求。

| 配置 | 要求 |
|---|---|
| `DAYNIGHT_PUBLIC_ORIGIN` | 主站的精确 canonical origin；无路径、凭据、query 或 fragment，host 小写，默认端口省略。 |
| `DAYNIGHT_UNIAUTH_URL` | UniAuth gateway origin，交由 SDK 校验。 |
| `DAYNIGHT_UNIAUTH_APP_ID` | 后端 App ID。 |
| `DAYNIGHT_UNIAUTH_APP_SECRET` | 后端 App Secret。 |
| `DAYNIGHT_UNIAUTH_CALLBACK_URL` | 与主站同源的完整精确 callback；无凭据、query、fragment，使用 canonical 非根路径。 |

服务只注册配置的 callback 路径，包括 `/auth/callback` 这样的已登记路径，不额外
挂载旧别名。路径不能与应用 API、页面、静态资源或健康检查冲突，包含使用引导的
`/login`、`/setup`、`/teams` 根及全部后代路径，以及 `/api/v1/teams` API 命名空间；
配置和启动验证必须先于路由注册拒绝冲突。已有 callback
占用该命名空间时须更换路径并同步 UniAuth 登记值。不接受编码别名、
路由通配符或 dot-segment。返回位置在建立登录事务前拒绝登录入口和实际 callback
路径，避免认证循环。callback URL 与 UniAuth App 登记值精确匹配，主站 origin
及 callback 不从 Host、转发 header 或随机 listener 推导。

生产默认 HTTPS。两个开关分别接受未设置/`0` 或 `1`，其他值明确拒绝：

| 开关 | 唯一作用 |
|---|---|
| `DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN=1` | 允许明确配置的 HTTP 主站测试 origin，按其实际 scheme 选择测试 Cookie。命名测试域名不会被当作 loopback。 |
| `DAYNIGHT_ALLOW_LOOPBACK_HTTP=1` | 启用 SDK gateway 的 literal localhost/numeric-loopback HTTP 例外；不允许普通命名 HTTP gateway。 |

两个开关互不替代。HTTPS 主站可搭配显式允许的回环 HTTP gateway；HTTP 主站测试
仍需自己的开关。Go listener 保持数值 loopback；沿用一个应用 origin、现有部署
入口和附件执行模型，没有关闭鉴权或匿名业务模式。`/healthz` 与 `/readyz` 为公开、
无业务数据的健康入口；readyz 检查数据库可用性与 Webhook 后台工作故障，不以匿名项目列表或上游登录
探测作为就绪条件。

## 错误与准入

| 场景 | 对外结果 |
|---|---|
| 缺失、无效、撤销或到期用户凭据 | 401 unauthenticated JSON |
| Team/项目不存在或当前主体没有对应成员资格 | 404 not_found JSON |
| member 调用 admin 功能、Cookie 写请求来源错误 | 403 forbidden JSON |
| Team 管理、项目创建或转移、新增/修改/移除独立项目授权或创建、撤销、接受邀请时 expectedUserId 与实际主体不符 | 409 identity_mismatch，领域行与版本不变 |
| 独立授权存在性或观察版本不符；ownership 或 Team 元数据版本过期，或删除 Team 的名称原文不匹配 | 409 version_conflict |
| 新增独立授权的目标不是有效 participant | 404 not_found |
| 变更 Personal Team | 409 personal_team_immutable |
| 删除仍有活跃 Project ownership 引用的 Team | 409 team_not_empty |
| Team 真实改名或项目真实转移所需版本已达最大正 int64 | 409 version_exhausted；经核对的 no-op 仍有效 |
| 无法确认 Team 管理、项目创建或转移、独立授权或邀请写入的提交结果 | 503 write_outcome_unknown；不得自动重放 |
| 生命周期前态不符或前置未完成 | 409 invalid_transition / dependency_unsatisfied |
| 邀请无效、已消费、到期、撤销或目标已删除 | 404 invitation_unavailable |
| provider discovery 的 App 配置/凭据错误 | 503 identity_configuration |
| provider discovery 的上游网络/协议错误 | 502 identity_unavailable |
| provider discovery 超时 | 504 identity_timeout |

每个业务 HTTP 请求读取当前凭据取得 Principal；资源服务在其读取快照或项目写锁内
检查成员关系。凭据检查和业务事务具有各自的准入时点；不承诺将凭据撤销与全部
业务提交串行化。附件读取在短快照完成成员与资源检查后准入文件 IO；附件变更与 Task
删除串行，在取得 Task SHARE 锁后以单语句读取当前授权来源完成准入。准入后的授权来源
撤销无需等待文件 IO，已准入变更允许完成；后续请求重新认证和授权。保留 K1，不在文件
IO 之后追加成员复查。

数据 API 不跳转登录 HTML。已验证并消费的 callback 在上游响应协议错误或 profile 准入失败时，
可响应的请求返回 502 `identity_unavailable`；其他失败进入 `/login` 的通用登录错误状态并保留该事务已验证的
目标，错误绑定明确拒绝。Web 处理登录状态，CLI 提示 `daynight login`；失败不得伪装成空
项目或空成员。日志及验收回执不包含 Cookie、Authorization、Set-Cookie、PAT、
App Secret、一次性 code 或邀请秘密。

## 验收标准

| 编号 | 可观察结果与验证 |
|---|---|
| AU-V1 | 实际 SDK 和 UniAuth 协议完成登录；受控 provider 可重复验收与真实上游人工联调分别留证。 |
| AU-V2 | 同邮箱不同身份、并发首次登录、callback 重放/过期/错误浏览器、取消及领取断连保持一次性语义。 |
| AU-V3 | 两名用户和部分共享项目验证双来源最大角色、只有继承权限、列表先筛选后分页、直接 ID、任务/图/属性/每种附件入口；缺失归属或规范用户必须暴露完整性错误。 |
| AU-V4 | member 可读写资源但不能管理授权；有效 admin 可撤销最后 direct admin，继承来源仍可管理；旧观察版本和删除重加 ABA 明确冲突，Team 关系不改写独立 grant。 |
| AU-V5 | 邀请 GET/inspect 不消费；明确确认、过期、撤销、并发、已有成员和创建者离任符合规则。 |
| AU-V6 | 注销、PAT 撤销/到期、成员移除覆盖 Web、安装 CLI 和文件资源；已准入传输边界有证据。 |
| AU-V7 | 同源可执行 HTML、脚本/模块/相对资源、直接预览、HEAD、图片/PDF、二进制下载、Esc/Tab/焦点及窄屏保持；未认证资源访问拒绝。 |
| AU-V8 | 最终样式原型覆盖登录、设备授权、项目、成员、邀请、令牌、预览的成功/空/加载/失败/失效/禁用/长内容；英语和简体中文均遵守原型、双语 L1–L10、状态与请求保持要求。既有 project-grants 浏览器 fixture 通过正式 Application 的 Members 路径，在 700/768/800/1280px 验证表格滚动后的完整按钮、指针命中、确认删除及单次版本化请求；768/800px 保持侧栏展开，1280px 无多余表格溢出。 |
| AU-V9 | 启用的同一版本通过原有适用 Go/CLI/Web/部署门禁、严格覆盖率、原生安装/补全、生产浏览器及资源预算。 |
| AU-V10 | 独立登录的缺失/合法/非法目标、已有会话、历史、任务/文件/query、已知 callback 失败、邀请和设备账号切换、普通退出及失败重试保持上述连续性；公开首页不成为私有授权依据。 |
| AU-V10 | 日志按请求/用户/项目关联登录、授权和错误；Cookie、PAT、App Secret、设备秘密、上游一次性 code 与邀请秘密不进入诊断或持久 URL；设备短码只用于核对和验证链接，不进入日志。 |
| AU-V11 | 缺省服务地址、无本地凭据提示、显式 login/logout、已有/新浏览器登录、短码核对、拒绝/设备授权过期/轮询限速、取消/断连/响应丢失、并发单次领取、配置冲突与凭据撤销均有可观察验证。默认永不过期、设置/清除到期、同一凭据继续使用、账号/到期观察冲突、过期或撤销不能恢复、未知修改只读取核对均须验证；迁移保留旧有限到期值，浏览器会话仍为七天。 |
| AU-V12 | Team 创建者 admin 原子性、本人过滤和跨账号 cursor、不可见/非 admin/Personal 拒绝、合法 Unicode 与原文空白、NUL/非法转义/全空白拒绝、重名、精确版本 no-op/冲突/耗尽、空删除与非空拒绝均有验证；真实 PostgreSQL 锁等待证明删除和 ownership 写入互斥，错误身份零领域 SQL，取消、回滚失败和未知 COMMIT 保持结果分类。 |

模型工具面继续使用既有 CLI，不增加 MCP 工具。保留现有请求/操作/响应预算与输出
合同，认证失败不触发自动写重试。
