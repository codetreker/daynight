# Webhook 应用运行与部署

## 组装和生命周期

应用使用共享 PostgreSQL 事务、身份认证及同一个管理路由模块组装 Webhook 配置、历史和重投。启动前检查明确支持的不可变 policy、当前 endpoint 的签名密钥和 revision 等待行，以及所有 endpoint、签名密钥和 Delivery 目标密文的 master 引用与认证。数据库仍有引用时，即使发送关闭也必须提供全部所需密钥；缺失、读取或认证失败使启动失败。密钥环是严格 JSON，包含 `activeKeyId` 和 `keys` 对象，值为标准 Base64 编码的 32 字节密钥；通过 `DAYNIGHT_WEBHOOK_KEYRING_FILE` 指向仅服务进程可读的私有文件，不把内容写入镜像、源码、API 或日志。

`DAYNIGHT_WEBHOOK_ENABLED` 默认为 `0`，所有使用同一数据库的实例须采用一致开关和受支持的 policy 版本。关闭时不领取新网络请求，不允许新建或扩大配置；按当前权限读取和限制性清理仍可用。既有有效 endpoint 的来源事务继续捕获责任，恢复和维护继续运行，原期限和预算不会暂停。endpoint 自身暂停期间不匹配的新历史不会在恢复时补发。目录的 `dispatchEnabled` 表示配置，不能代替运行健康。

构造不启动 Webhook goroutine；应用运行根启动发送和维护并监督其永久故障。readiness 同时检查数据库和后台故障。关闭先停止领取，随后 drain HTTP 和 Session，取消并等待在途投递及维护，最后释放共享依赖；所有阶段共用最多十秒预算。无法确认使用者停止时返回错误并保留依赖；进程被强制终止后未确认的 Attempt 依原 lease 恢复，不能推断外部请求的结果。网络策略、持久 lease 和 late 观测见[投递设计](webhook-delivery.md)，清理锁序见[保留设计](webhook-retention.md)。

以下 Compose 片段仅展示 Webhook 的私有文件挂载；实际部署仍须提供服务、数据库、身份、存储和网络配置：

```yaml
services:
  server:
    environment:
      DAYNIGHT_WEBHOOK_ENABLED: "1"
      DAYNIGHT_WEBHOOK_KEYRING_FILE: /run/secrets/webhook-keyring.json
    volumes:
      - type: bind
        source: ${DAYNIGHT_WEBHOOK_KEYRING_HOST_FILE:?Set a private keyring file}
        target: /run/secrets/webhook-keyring.json
        read_only: true
    stop_grace_period: 20s
```

关闭发送并不删除挂载：数据库仍有密文引用时，进程仍需读取相应密钥。更新 keyring 文件后应按部署屏障重启实例；运行实例使用启动时读取的密钥集。

## 隔离上线与回退

在隔离环境记录所有仍可写来源业务的实例、二进制和 source revision，并阻止清单外写者启动。停止并等待全部不具备捕获与 ACL 合同的旧实例退出；仅新实例 ready 无法证明未知写者已升级。以相同 schema、开关和所需 keyring 启动完整新版本，在关闭 dispatch 时验证读取、来源捕获及维护，再一致启用并用受控 HTTPS 接收方核对事件、签名和数据库责任。部署控制面须保持实例清单和阻止旧版本重启的屏障。生产密钥使用私有只读文件挂载，只挂载服务所需文件，并在容器编排中保留至少 20 秒停止宽限以容纳内部预算及进程退出。

回退发送时在所有实例一致关闭开关，保留具备捕获与 ACL 合同的二进制、数据库责任和有效密钥。不要删除责任或切回无捕获合同的旧二进制。恢复时使用隔离数据库和保留 keyring 重建运行实例，核对固定 body、hash、目标、版本和原期限，再验证真实投递和历史；缺失所需旧密钥必须失败。主密钥轮换、备份清单及独立恢复验证条件由[主密钥维护设计](webhook-key-maintenance.md)规定，在线零引用不能代替备份和生产者排空证据。
