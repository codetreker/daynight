# CLI SQLite 数据库格式升级设计

## 结构与责任

[升级需求](../spec/cli-sqlite-migrations.md)定义自动升级和数据保留结果。各业务 store 明确选择自己的格式定义、版本序列和准入规则；公共模块复用执行与连接生命周期，不扫描数据库来选择 store，也不维护全局版本或数据库内的迁移账本。

| 责任 | 所属模块 |
|---|---|
| 版本定义、来源检查、迁移顺序和当前版本断言 | `platform/sqlite-format.ts` |
| 明确缺失判定、只读快照与重开、同步写事务和连接关闭 | `platform/sqlite-access.ts` |
| 有限的访问错误与安全诊断表示 | `platform/sqlite-error.ts` |
| 原实例锁和严格不接管的同步维护 permit | `platform/instance-lock.ts` |
| 本库基线 DDL、已交付转换、无版本接入和必要结构检查 | 各 store 的 format 模块 |

格式定义包含基线版本及建库函数、可选的无版本来源验证/接入、连续的后续迁移和按版本验证函数。迁移 callbacks 同步执行，只操作传入 Database；返回类型为 `undefined`，拒绝误传 async callback。版本由执行器统一推进，迁移不自行提交或开始事务，也不操作 Git、网络、原生进程或其他文件。

## 独立版本与起点

| 库 | 基线及迁移 |
|---|---|
| Worker | 当前七列 tasks 为基线 5。无版本六列按已有重建转换补 `herdr` 模式，无版本七列只登记；旧详细库 1–4 不接入 |
| Review | 基线 1，原 1→2 增加 publication 并保留历史发布语义；当前仍为 2 |
| Web 执行状态 | 基线 1；已知无版本表验证当前支持的记录契约后登记，保留原 data 字符串 |
| Controller journal | 基线 1，依次保留 ACK/projection、operation acknowledged、projection gap、source floor/resource 的 1→5 转换 |
| Native resume lease | 基线 1；已知无版本结构仅在无保留 lease 时登记，不重写归属记录 |

新库使用同一基线建库和后续步骤，避免另一套最新 DDL 漂移。版本范围为正的 32 位有符号整数，0 只表示尚未登记；负数、缺步、逆序和较新版本均拒绝。来源结构检查由本库维护，覆盖迁移需要的表、列、主键、必要索引、约束和 STRICT 属性，只接受有限的已交付布局；不推导任意手改 SQL 的语义等价。

接入不成为历史数据清洗。Web 记录的既有缺省处理保持，但验证后不重新序列化写回；未来收紧字段需要新增版本转换。Journal 的原有 JSON 字符串、序列、ACK、原生身份和 BLOB 保留，不把原类型断言当成已经增加全面运行时校验。

## 事务与业务启动

`inspectSqlite` 不修改数据库；`upgradeSqlite` 要求已有 immediate 写事务，并在事务内重新检查来源，不接受等待写锁之前缓存的迁移计划。空库通过基线建库，无版本库通过本库接入，随后执行全部待迁移步骤、验证目标并推进 `user_version`。

迁移及包含迁移的 startup 使用明确的同步 BEGIN IMMEDIATE、action、COMMIT 边界。action 或提交失败时，若仍有活动事务则尝试回滚；回滚也失败时保留两个错误。已有活动事务和 Promise/thenable 结果明确拒绝。该边界不嵌套现有普通业务 transaction/savepoint；已归属运行期事务只断言当前版本，不在业务回调里迁移。

Controller 的升级和原 ticket/generation 校验、writer 认领位于同一外层事务；纯升级不运行这些业务步骤。Lease 的建库/迁移、查重和首个 INSERT 同样在一笔事务内。原有异步的文件、账号和进程证明准备留在事务外，最终事务重查稳定身份与格式。

连接先以不改写文件的方式识别合法来源，再配置现有 writer 所需的 WAL/FULL，进入写事务重查。事务原子性覆盖结构、记录和版本，不承诺 journal mode 或数据库/WAL 文件逐字节回到打开前。SQLite 的单 writer 和事务语义见[官方事务说明](https://sqlite.org/lang_transaction.html)；同步 callback 的约束见 [better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb/docs/api.md)。

## 查询与维护连接

```text
明确缺失判定
  → readonly deferred 快照：版本检查与查询
  → 当前格式直接返回
  → 可升级来源：关闭读取连接
  → 所属领域的升级准入
  → fileMustExist 可写连接，immediate 事务内重查并迁移
  → 提交/回滚，确认关闭
  → 新 readonly 快照重查当前格式并查询
```

当前格式不取得实例锁、不打开写连接、不扫描全库 JSON。查询需要迁移时只写格式，不启动监控、创建 Controller、认领 native writer 或恢复审查。最终快照拒绝较新/未知格式和额外退回旧格式；锁冲突后至多再读一次，允许并发调用已完成升级的情况，不循环重放操作。

只读打开失败需要结合文件系统重新确认缺失，不能仅凭 SQLITE_CANTOPEN 返回空结果。非目录父路径、权限错误、损坏文件和未初始化空业务文件均保留错误。用于迁移的现有文件连接要求 fileMustExist，防止检查后消失却被重建。

## 领域准入与资源关闭

Review runtime 继续使用普通实例锁；旧格式 listing 的维护 permit 使用相同 gate 与锁文件位置，但拒绝接管任何已有锁。运行模式接管死 PID 会保留“前代进程未排除”的事实，纯迁移不能接管后删除它。Worker runtime 已持同一个 Worker 锁，分别升级主索引和 Web 库；两库任一失败时不启动 coordinator。

维护 permit 只在锁原本不存在时创建自己的 owner。取得 permit 前必须提交并确认 gate 连接关闭，随后才打开业务迁移连接；Worker gate 与业务库共用文件时尤其不能持有 gate 写事务再开第二个写连接。迁移连接关闭或事务结果未知时保留维护锁。释放先经 gate 核实 exact owner 并确认 gate 关闭，再核对并删除自己的锁；该同步过程中的 live owner 阻止遵守协议的 acquisition 替换它。普通 runtime 释放语义保持。

Journal 的稳定 owner_pid 从 v1 起即可在 DDL 前读取。活跃或不可确认 writer 阻止升级；纯迁移不改 owner_pid，不产生停止证明。独立 stopped writer 在事务外验证进程树，最终事务断言当前格式和原 snapshot 未变后写入 stopped。Journal close 清除 owner_pid 也是写入口，失败时仍尝试关闭并保留错误链。

Lease 的迁移准入要求没有保留行；陈旧、过期或 PID 缺失都不提供回收权限。已取得租约的 release 在同一事务内断言当前格式，按 native_key+nonce 删除并验证恰好一行，不进入自动升级路径。其业务释放仍要求原有“从未启动”或完整停止证据；未返回申请的已知提交清理由下面的独立边界约束。

首次建库或接入的事务也可能已经提交 onReady 中的本次 INSERT，却在完成 reporter 抛错后未将连接返回申请者。申请过程分别保留“已插入”和“已取得返回连接”的事实：只有提交明确成功、原连接关闭已确认且申请尚未返回、新原生执行尚不可能启动时，才用 fileMustExist 的新连接进入当前格式事务，核对本次 native_key 与 nonce 并删除这条租约。该行已不存在表示没有本次遗留；nonce 不同则拒绝删除。提交或关闭未知时不进入这条协调路径。原 reporter 错误仍是申请失败，协调或关闭再失败时聚合原始对象，不把清理成功报告成申请成功。

## 错误与诊断

格式、迁移和文件错误不能被归为无状态或 IPC 不可达。Web 的 IPC try/catch 只包含请求，随后的本地 store 更新失败直接传播。独立 Controller 的退出路径保留 journalFailure，同时继续停止自己已归属的进程；停止证明不完整时不归档、不伪造 nativeStopped，也不释放 resume lease。

连接适配层区分未开始、已提交、已回滚和未知事务结果。提交成功后 close 失败仍报告已提交；操作和回滚/关闭双失败聚合原始对象，不自动重跑。实际原因修复后，再次打开按真实版本识别。

同步迁移事件复用 stderr 与现有 Worker JSONL。数据库名称、路径、阶段、源/目标版本、步骤、migrationId 和结果采用有限字段；原 cause 留在内存。文本及 JSONL 对访问错误使用安全表示，避免 JSON parser 的原 message 或 SQL 参数泄露业务内容。日志失败不改变数据库已知提交结果，也不覆盖已有迁移错误。

## 接入与验证边界

首次接入需退出完全没有格式检查的旧 Worker、Review、独立 launcher、Controller 和 resume 父进程，保留未知归属。新代码无法使旧二进制遵守格式 guard；不承诺与这些旧版本混跑或自动降级。

来源 fixture 独立于当前 opener。真实 SQLite 验证各库新建、旧格式、行/JSON/BLOB 保留、DDL 和版本回滚；独立进程验证并发与中断后重新读取。当前格式 WAL 快照、旧锁保留、lease 阻塞、提交/关闭双失败、IPC catch 与本地停止各有行为断言。SQLite 转换不覆盖原库文件、不删除 WAL/SHM、不创建跨库分布式事务或后台迁移任务。

选择与历史取舍见[升级决策](../../.agents/notes/implemented/architecture/2026-10-30-cli-sqlite-migrations.md)。
