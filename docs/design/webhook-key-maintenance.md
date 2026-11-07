# Webhook 主密钥维护与恢复

Webhook 的 endpoint 当前目标、签名密钥和 Delivery 目标快照分别以资源身份绑定的 AES-GCM envelope 保存。运行实例的 active master 在其生命周期内固定；新捕获和配置写入使用该实例的 active master 重新包装。重包不改变明文、业务 key ID、配置版本、目标版本、请求 body 或期限。

## 轮换与在线维护

先向所有受控实例分发包含旧、新主密钥的 keyring，再启动 active 为新密钥的实例。停止并等待所有可能以旧密钥产生密文的进程，包括已冻结配置但尚未提交捕获的进程。必须从部署控制面的完整实例清单核对停止和退出；数据库中暂时没有旧引用不能证明进程已经排空。

`cmd/webhook-key-maintenance` 读取 `DAYNIGHT_DATABASE_URL` 和 `DAYNIGHT_WEBHOOK_KEYRING_FILE`，不迁移数据库。其命令在 `packages/daynight-server` 中运行：

```sh
go run ./cmd/webhook-key-maintenance --mode=inventory
go run ./cmd/webhook-key-maintenance --mode=rewrap --old-master=OLD --limit=500
```

每次重包最多检查 500 行并在两秒内取消数据库操作。它使用旧密钥索引读取候选，以原 owner、endpoint、用途和记录身份解密，再以 active 密钥和新的随机 nonce 加密。更新只在完整旧 envelope 和 AAD 身份仍相同时生效；冲突或删除不会覆盖并发结果，也不会重建行。`Examined`、`Rewrapped`、`Conflicts` 表示当次观察，错误会使命令失败；失败后重新盘点和运行，不推断已经提交的更新回滚。没有旧引用后仍需复核生产者排空，重复盘点以发现旧进程迟到的提交。

缺少 master、认证失败或随机数故障会暴露错误并保留该记录的原密文。命令不输出 URL、签名秘密或 keyring 内容。在线 `inventory` 的 `retirementSafe` 始终为 false：它不掌握部署清单与备份保留集，零引用本身不是删除密钥的授权。

## 隔离恢复验证

对每个仍保留的备份，在隔离数据库恢复实际备份，保留一份不可变的同一备份源快照和一份可重包的恢复副本。禁止将验证指向生产数据库，验证期间停止这两个快照的写入。对恢复副本使用包含旧、新密钥且 active 为新密钥的 keyring 完成分批重包，再使用不含旧密钥的 keyring 比较：

```sh
# DAYNIGHT_DATABASE_URL 指向不可变源快照；DAYNIGHT_WEBHOOK_KEYRING_FILE 包含源快照所需密钥。
# DAYNIGHT_RESTORED_DATABASE_URL 指向独立恢复副本；DAYNIGHT_RESTORED_WEBHOOK_KEYRING_FILE 不含旧密钥。
go run ./cmd/webhook-key-maintenance --mode=verify-restore --old-master=OLD
```

验证为两个副本分别建立固定连接的只读 Repeatable Read 事务，比较 PostgreSQL 的 cluster system identifier 和 database OID，二者相同时拒绝；连接串、连接池和 schema 的不同不能证明数据库独立。读取这些身份需要允许执行 `pg_control_system()` 和读取 `pg_database`，权限不足或快照连接在两秒内无法取得时验证失败。物理克隆可能保留相同 system identifier 和 database OID，此时保守拒绝，不能由此证明副本不独立。验证逐批读取全部三类实际密文，检查恢复副本不引用旧 master，并逐项比较身份、解密字节和记录总数；缺失、额外记录、缺密钥和认证失败均使验证失败。`compared` 是成功比较数，结果仍为 `retirementSafe=false`，因为该命令无法证明输入覆盖了全部保留备份或所有生产者已排空。恢复作业还须核对备份自身的其他数据与恢复要求；此命令只检查 Webhook 加密材料，不能代替完整数据库恢复验证。

只有权威部署清单上的旧 active 生产者全部退出、在线实存三类引用均为零、且完整保留备份集合的恢复验证均不再需要旧密钥时，旧密钥才可退役。移除旧密钥后，以它签发的[历史分页游标](webhook-history.md)失效，调用方须从第一页重新读取。任一清单不完整、验证失败或结果未知都保持不可退役；工具不删除密钥文件或备份。

部署和备份控制器可通过 `service/webhook.AssessKeyRetirement` 组合判据。控制器提供权威的完整实例清单、在全部写入排空后才关闭的实例退出信号，以及完整保留备份清单与每份备份的两份独立隔离恢复副本和 keyring。两个副本都必须来自当前仍保留的同一备份；旧备份仍在保留集合时，不能以其重包后的临时副本代替它。它必须在整个判定和实际退役之间持有防止旧 active 进程重启的部署屏障，并保持这些快照不可变。判定检查每个旧 active 进程的退出信号，检查每份保留备份本身已无旧密钥引用并执行实际恢复比较，随后固定在线数据库快照，确认其身份不同于每份备份副本并扫描在线引用，再重查实例和备份清单是否变化。清单为空、进程尚在运行、在线仍有引用或清单发生变化时结果为 false；读取或恢复验证出错时返回错误而不许可退役。此接口依赖控制器对清单完整性和屏障的保证；命令行工具没有这些控制器，不能自行给出 true。

可在允许创建临时数据库的隔离 PostgreSQL 实例和可运行 `postgres:18.6` 的 Docker 环境中执行独立恢复验证：

```sh
DAYNIGHT_TEST_DATABASE_URL='<isolated PostgreSQL URL>' \
  go test -tags stress -run '^TestWebhookKeyPhysicalRecoveryStress$' \
  ./internal/core/store/postgres -count=1 -timeout=3m
```

该测试使用受控旧生产者进程、实际 `pg_dump` 和 `pg_restore`，创建并清理临时数据库。它核对密文解密结果以及 body、hash、版本和期限，并检查旧备份保留与移除后的判定。测试产生隔离证据，不能证明生产部署或实际备份集合满足退役条件。
