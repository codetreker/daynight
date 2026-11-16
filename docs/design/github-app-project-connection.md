# 独立 App 的项目连接

项目连接管理由 `core/github` 的项目 App 规则和 `service/github` 的远端证明协调器负责。当前 owner Team 的 Team admin 可以发现安装、连接、更换和断开；仅有 App 管理员或直接 Project admin 身份不能执行这些操作。Project admin 继续管理同步开关和轮询间隔，项目读取沿用既有权限。

安装发现与连接通过 App client provider 借用所选 App 当前凭据的 client，在事务外实际证明目标 installation、稳定 repository ID 和 PR 读取能力。证明不是授权凭证：远端操作前后分别核对当前 Team 权限、ownershipVersion、App 配置版本和精确 grant UUID，连接提交还核对原连接版本与仓库地址。撤权后重新授权使用新的 grant，不能恢复旧证明。远端失败与没有可用安装分别表达，未知提交不得自动重放。

专用 Project App 写作用域按 Project 根、ownership、owner Team 共享根、权限关系、排序后的新旧 App 根、grant、connection 的顺序保护决定。锁 App 前只读连接候选身份；锁等待结束后以新语句读取当前连接。App 删除或撤权可能已清空候选连接；仍引用缺失资源属于完整性错误。App 锁不跨远端请求持有，连接集合实际变化推进相应 App 的 impactVersion。

首次连接保留默认关闭的同步意愿，普通重连保留已保存意愿。显式断开关闭意愿并清除活动 App、grant、凭据和 installation 身份、领取、提示与日程，保留稳定仓库和 PR。开启同步要求当前活 App、当前 owner Team 的精确授权、有效绑定和可用访问状态。原权限和版本先于同值判断。

状态投影增加 `canManageConnection` 和可空的最小 App 身份；连接管理响应携带 grantId，不返回秘密、管理员或其他 Team 的授权。App-aware HTTP adapter 提供项目 GitHub 子资源协议，并由生产 mux 和项目设置使用；运行时与生命周期见[连接运行时](github-connection-runtime.md)。

## 操作关联与事务结果

HTTP 日志使用 `request_id`、`user_id`、规范 `project_id` 和 `operation_phase` 关联请求。已解析的请求条件使用 `requested_`、`expected_` 字段，与经过权限检查的资源事实区分。响应阶段保留 `phase=response`；它的 `write_outcome=unknown` 只表示响应未确认交付，不能改写数据库提交事实。

`ProjectAppManager` 在连接、断开、间隔与同步写作用域返回后，依据原始 `store.Completion` 记录 `component=github`、操作 `phase` 和 `write_outcome=committed|not_committed|unknown`。事务回调中的观察器只采集既有 DAO 调用提供的安全身份，不增加读取或修改业务决定。可取得的 App、外部 App ID、grant、Team、ownership、配置及凭据版本和 generation 关联该操作；断开保留原绑定身份。事务内观察值与已提交结果分别表达，回滚或 unknown 不把拟写入 generation 声称为已提交事实。当前连接投影没有 impactVersion，日志不推算其值。

日志仅选择身份、版本和安全错误分类，不包含仓库或项目正文、私钥、Webhook secret、邀请 token/hash/fragment、原始数据库或远端错误正文。事务结果与 HTTP 响应交付各有所属边界；日志不是可重放凭证，也不能通过后续同值读取证明未知操作的历史结果。该边界的决策见[项目连接事务日志](../../.agents/notes/implemented/bug-fix/2026-11-17-project-app-transaction-logging.md)。
