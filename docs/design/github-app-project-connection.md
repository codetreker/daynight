# 独立 App 的项目连接

项目连接管理由 `core/github` 的项目 App 规则和 `service/github` 的远端证明协调器负责。当前 owner Team 的 Team admin 可以发现安装、连接、更换和断开；仅有 App 管理员或直接 Project admin 身份不能执行这些操作。Project admin 继续管理同步开关和轮询间隔，项目读取沿用既有权限。

安装发现与连接通过 App client provider 借用所选 App 当前凭据的 client，在事务外实际证明目标 installation、稳定 repository ID 和 PR 读取能力。证明不是授权凭证：远端操作前后分别核对当前 Team 权限、ownershipVersion、App 配置版本和精确 grant UUID，连接提交还核对原连接版本与仓库地址。撤权后重新授权使用新的 grant，不能恢复旧证明。远端失败与没有可用安装分别表达，未知提交不得自动重放。

专用 Project App 写作用域按 Project 根、ownership、owner Team 共享根、权限关系、排序后的新旧 App 根、grant、connection 的顺序保护决定。锁 App 前只读连接候选身份；锁等待结束后以新语句读取当前连接。App 删除或撤权可能已清空候选连接；仍引用缺失资源属于完整性错误。App 锁不跨远端请求持有，连接集合实际变化推进相应 App 的 impactVersion。

首次连接保留默认关闭的同步意愿，普通重连保留已保存意愿。显式断开关闭意愿并清除活动 App、grant、凭据和 installation 身份、领取、提示与日程，保留稳定仓库和 PR。开启同步要求当前活 App、当前 owner Team 的精确授权、有效绑定和可用访问状态。原权限和版本先于同值判断。

状态投影增加 `canManageConnection` 和可空的最小 App 身份；连接管理响应携带 grantId，不返回秘密、管理员或其他 Team 的授权。App-aware HTTP adapter 提供完整项目 GitHub 子资源协议，尚未挂载生产 mux；现有全局 App 的公开装配保持原有行为。生产采用须同时切换运行时、生命周期与客户端，见[连接运行时](github-connection-runtime.md)。
