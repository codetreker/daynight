# 独立 GitHub App 登记

独立 App 使用客户端生成的本地 UUID 标识，外部 GitHub App ID 在活资源中全局唯一。登记先用提交的私钥向固定 GitHub origin 证明 App 身份，再以单个事务插入 App 和首位管理员；证明期间不持有数据库锁。重复外部 ID 不授予已有 App 的管理权，本地 UUID 永久占用。

App 公开元数据与凭据分离。当前管理员才能读取元数据；列表在分页前按当前管理员过滤，并按创建时间和 UUID 排序。管理员、有效 Team 授权和连接项目数量从实际存储计数。读取不返回私钥、Webhook secret 或其摘要；Webhook URL 使用可信公开 origin 构造，不表示 Webhook 已验证。

迁移 `076_github_apps.sql` 建立管理员关系和独立 membership sequence、邀请及授权墓碑，并为项目连接准备授权字段。删除后的 App 和授权身份不能复用；活外部 ID 或 App/Team 授权的唯一性由部分索引保证。[管理员与邀请](github-app-administration.md) 拥有管理员读取、精确移除和邀请生命周期的机制；[Team 授权与影响预览](github-app-team-grants.md) 拥有使用授权和撤权组件。项目连接采用与公开路由由相应组件负责；现有服务仍使用原有全局 App 配置和连接准入，独立 App adapter 尚未挂载生产 mux。

登记的 45 秒预算覆盖输入、GitHub 请求和提交；本地读取使用 15 秒预算。事务返回 committed、not_committed 或 unknown，未知结果不得自动重放。客户端可使用原 UUID 查询当前可见元数据，但同值读取不能证明未知秘密写入已提交。
