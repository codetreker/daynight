# Worker 个人 prompt 服务端设计

[接口需求](../spec/worker-prompts.md)拥有资源、权限、同步结果与错误合同；[决策记录](../../.agents/notes/implemented/feature/2026-11-09-worker-personal-prompts.md)保存选择和备选。

## 存储与单资源操作

`worker_prompts` 以 `(user_id,scope,scope_id)` 为主键，保存正文、正 int64 revision 和数据库更新时间。user scope 的 scope_id 是用户 ID；其余是项目或 Worker ID。没有行时生成虚拟版本 0；清空不删除行。首次创建依靠唯一键与条件插入，并发更新依靠完整 key 和 expected revision 条件；零命中为冲突，不自动重试。先比较版本再判断 no-op；no-op 在线性化读取时返回原资源，不修改时间。

读取在同一个只读 Repeatable Read 快照中检查外层权限并读取资源。项目写入在专用 Read Committed 事务内按 live Project、ownership、Team member、direct grant 的既有顺序取得授权共享锁并等待后复查，持锁至提交；正文 CAS 独立保护版本。Worker 身份按用户和 Worker 精确检查，不依赖近期窗口。只有确认提交才返回写入成功；提交未知和回滚错误保留内部错误链。

## 配置报告

HTTP 层在原报告调用前验证协议和有限 selector；service 先执行原 Worker 报告事务，确认提交后才以请求上下文派生最多五秒的只读快照。批次在同一快照中逐 key 检查权限和小型版本元数据；仅未知或不同版本读取正文。任一只读失败放弃批次结果并给每项安全错误，已确认的原生回执不变。失权是单项 `unavailable`，不泄露版本或正文。旧格式保持原结构，prompt 不进入持久化 Worker report、desired 或 observation。

完整报告 JSON 保持原 1 MiB 限额，selector 使用有界 header。最多三份正文以及原生配置的最坏 JSON 转义仍在协议 2 的 48 MiB 消费预算内；服务端不截断、不查询项目全集。快照结束后撤权不回收已经开始读取的字节；后续请求重新检查权限。

## 验证边界

core 单元验证正文、版本和状态转换；HTTP 和 service 验证身份先决条件、协议格式、原生提交与只读失败的独立结果。真实隔离 PostgreSQL 验证唯一创建、条件并发、授权锁与版本/正文同快照。一条真实 API 链路覆盖编辑、配置报告、unchanged 和清空。服务端确认下发不证明 Worker 已应用正文。
