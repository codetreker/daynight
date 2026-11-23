# Worker 活跃认领索引

## 事实来源与读取

`task_properties` 中的 `name='worker'` 行是任务认领的唯一事实来源。认领、释放、完成、Session 准入和监控沿用[认领设计](daynight-worker-claims.md)的事务和身份规则。索引只提供候选定位，不增加独立认领表或改变属性原文。

`task_properties_worker_active_claim_idx` 是非唯一部分 B-tree，键为 `userId`、`workerId` 的文本提取表达式及 `task_id`。两个文本键使用 `COLLATE "C"`，保留原 Go 读取器的大小写精确比较；不把属性内 UUID 转为 PostgreSQL UUID。谓词固定为 `name='worker'` 且 `state='active'`。每个 JSON 提取表达式都通过 `CASE WHEN name='worker' THEN value::jsonb END` 隔离其他属性，普通属性中的转义 NUL 不进入 JSONB 转换。

当前 Worker 清单继续运行已有 Go 筛选路径。包含索引迁移且保留该路径的构建可以在同账本数据库上重启，作为查询切换后的回退构建。未来查询切换须复用完全一致的键表达式及静态谓词，并独立验证权限、分页和查询收益。

## 冻结迁移

迁移 115 的 SQL 首先在账本事务中对 `task_properties` 取得 `SHARE` 锁。普通读取可以继续，属性写入等待；锁等待、扫描、提取和建索引均服从启动 context。随后冻结的 Go transform 核对全部 Worker 行，包括历史 Herdr 与 completed 记录。

冻结校验保持迁移制定时的存量 Worker 形状规则，并独立用旧清单读取器的普通 Go JSON 解码核对 `state`、`userId`、`workerId`。这三个值必须与 PostgreSQL 实际提取逐值一致。未知字段、重复键、非法形状、不可转换 JSONB 或提取差异使迁移失败；诊断标识 Task ID 和原因，保留错误链，不输出属性载荷。

校验成功后，同一 transform 执行固定索引 DDL，再由迁移框架写入账本。锁 SQL、全部冻结解码和转换源码、索引 DDL 都进入迁移校验和，不依赖会随业务演进的当前 codec。已发布迁移不可改写；新规则或已提交索引的修复使用后续迁移。

迁移不改属性字节、Task 版本、更新时间或 Project Sync epoch。索引和账本一起提交或回滚。空库以包含同一索引的当前 schema snapshot 初始化，并写入相同迁移校验和；完整历史与 snapshot 的等价性由现有真实 PostgreSQL 测试验证。

## 部署预算与恢复

部署前在代表性旧库测量锁等待、全量校验、索引构建、写入维护成本及 listener 启动总时间，并与实际 `DAYNIGHT_STARTUP_TIMEOUT` 比较，默认预算为 10 秒。目标规模超预算时，部署方先确定维护窗口和启动配置，以该配置演练通过后部署。隔离合成样本的时间不能证明生产数据分布下的预算。

启动取消、迁移失败、提交确认丢失或迁移后 listener 绑定失败时，使用新连接查询迁移 115 的版本、校验和，以及索引定义、谓词和有效性：

| 实际状态 | 恢复方式 |
|---|---|
| 账本和索引均缺席 | 查清失败原因后重新运行匹配的迁移构建。 |
| 账本和索引均符合预期 | 迁移已提交；用了解相同账本的构建恢复启动，保持旧读路径的索引构建也可使用。 |
| 两者混合、校验和或定义不符 | 停止滚动并调查实际状态；不得删账本、假定回滚或盲目重放。 |

迁移前二进制不能识别新账本，不能作为已提交迁移后的重启回退。查询切换后的回退须记录确切构建 SHA，并保持迁移 115 的完整内容和校验和。部署恢复不绕过既有启动、访问权限或认领检查。

## 验证责任

DAO 迁移测试使用真实 PostgreSQL，覆盖历史存量、大小写、非 Worker 转义 NUL、非法 Worker、原始属性及 Task/Sync 围栏保持、锁等待和取消、索引维护及事务回滚。命令生命周期测试证明迁移已提交但 listener 失败后的新连接核对及同构建重启。大规模启动与读写成本探针独立于常规 CI，证据绑定候选 SHA、对照 SHA、种子和实际配置。

选择与成本由[决策记录](../../.agents/notes/implemented/architecture/2026-11-23-worker-active-claim-index.md)拥有；执行命令和 schema snapshot 维护由[Server 指南](../../packages/daynight-server/README.md#schema-snapshot-maintenance)拥有。
