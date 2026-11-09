# Worker 云端配置服务端设计

[接口需求](../spec/daynight-worker-configuration.md)拥有数据与可观察结果；[决策记录](../../.agents/notes/implemented/architecture/2026-11-04-worker-cloud-configuration.md)保存写入者分离、协议扩展和真实备选的理由。

## 职责与结构

配置作为现有账号级 Worker 的独立子资源。HTTP 负责认证、能力选择和严格 JSON，core/worker 负责规范配置、当前项目准入与版本决策，service/worker 组织事务，store 在 Worker 行上保存目标及应用观测。配置分支不读取或锁定任务数据，不调用认领或恢复操作。

~~~mermaid
flowchart LR
  E[云端编辑] --> T[目标 CAS]
  H[配置报告] --> I[首次候选]
  H --> O[应用观测 CAS]
  T --> W[(账号 Worker 行)]
  I --> W
  O --> W
  W --> R[当前目标与实际结果]
~~~

目标与观测分别拥有版本。目标保存不代表本机应用，观测写入不使编辑草稿失效。独立配置能力标记选择报告扩展，原报告与快照查询保持原结构。

## 持久化与表示

workers 增加 configuration_revision、configuration_updated_at、desired_configuration、configuration_observation_revision 和 configuration_observation。目标三列同时为空或存在；应用观测独立为空，观测版本初始为 0。迁移不从任务或旧机器报告推测配置。

目标和观测保存受验证 JSONB，公开 revision 为十进制字符串，避免客户端 JSON 数值解析差异。配置标量仍受安全整数和轮询期限约束。项目覆盖以 key 存在性保留继承语义，不把省略改为显式默认值。

配置 GET 按认证 userId/workerId 读取，不施加近期窗口，不续活。快照列表与详情继续使用[快照设计](daynight-worker-snapshots.md)的时间及权限规则。

## Worker 行事务

报告复用 Store.WriteWorker。机器观测 upsert 建立或更新记录后，配置分支锁定同一 Worker 行：缺失目标且有合法候选时建立初值；已有目标不被候选改写；观测比较自身 baseRevision 后保存。回执来自该事务内最终目标与观测版本。

PUT 也锁定这行，先校验目标版本，再校验新增/修改项目的准入，比较规范值并保存。保留相同项目条目或删除失权条目不要求重新取得项目权限。配置事务不进入 Project 写事务，不创建任务锁序或跨任务注册门禁。

并发导入只建立一次初值。观测 CAS 失败不覆盖结果，也不使合法 telemetry 失败；目标 CAS 失败不改变目标。数据库操作、提交与回滚错误保留原链。

## 输入与输出边界

目标、项目覆盖、观测 key 与应用值分别做闭合解析。native 原子组合保证 Agent/model/args 的表示有效，服务端不运行 native preflight。观测只接受闭合诊断字段，不把自由输出带入日志或 HTTP。

应用观测保留自身服务器接纳时间；机器报告可以更新，而应用结果仍是此前已确认状态。消费者将当前目标与每项目标版本比较，保持旧实际值和明确等待/失败含义。

旧协议不接受新正文，旧回执不附加配置字段；配置协议 1 遵循完整扩展结构。协议 2 的有限个人 prompt 批次在原报告提交后独立读取，机制由[个人 prompt 设计](worker-prompts.md#配置报告)拥有。能力仅影响配置交换，不成为 Task/claim 或 inventory 的准入条件。

## 验证边界

真实 PostgreSQL 验证并发导入、独立 CAS、相同值、规范化比较、权限变化、事务失败与持久状态。HTTP 验证认证、Origin、查询/方法拒绝、精确字段、版本和原格式。迁移保持旧 Worker 遥测及任务数据，不回填伪造配置。

服务端验证输入和账号归属，不能证明客户端真正准备了仓库或停止了进程；这些结果由本机观察并上报。配置接入不依赖任务清单同步，不改变现有任务恢复行为。
