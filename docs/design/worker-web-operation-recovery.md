# Worker Web 执行恢复后的异常结算

状态：设计。本文规定 Worker 如何在取得原执行的健康观察后结算旧监控错误，不修改任务执行、归档或原生进程恢复策略。

## 问题与目标

Worker 的 activity 和 currentFailures 表达不同事实：activity 描述当前步骤，currentFailures 保留尚无恢复证据的操作失败。不能因为 activity 变为 running 就清除任务的所有失败。

Web 执行目前存在两条缺失结算的路径：

- Controller 启动请求结果未知时，持久 launchSubmission 已为 unknown。后续 launch 正确避免重复提交，但不会再经过首次提交的 agent-start 成功通知。即使随后能观察到原 Controller，旧启动失败仍可能显示正在重试。
- IPC 不可达且无法证明原进程停止时，失败归于 web-recovery-proof。原 Controller 后续恢复可达会绕过该失败分支，只报告 agent-observation 成功，留下旧 preparing 失败。

目标是在取得足够证据后清除这两个确已恢复的异常，使页面和 CLI 的当前监控准确，同时继续保留真实失败及原执行身份。

## 责任与证据

Web backend 拥有启动、IPC 和 Controller 观察的事实，因此由它报告对应操作恢复。Coordinator 继续按 claim 与 operationKey 精确结算；monitoring observer 继续负责 currentFailures 和 lastRecovery。无需新增服务端 API、存储 schema 或 Web 状态推断。

健康观察复用 healthyOriginalGeneration 的完整校验：task/claim、Session、execution、generation、controllerInstance、nativeSession 与进程证据匹配，lifecycle 为 ready 或 working，startup 为 ready，原生进程未停止、没有错误，初始输入已 confirmed。单纯收到 IPC 响应或 activity=running 不满足条件。

健康证明须与本次写入观察前保留的执行与进程身份比较，不能先覆盖原证明再把新值与自身比较。成功保存观察后才能报告恢复。

已取消的尝试不得产生恢复通知。starting、failed、paused、stopping、stopped，以及输入尚未确认、身份不匹配或进程证据不足，都不通过这项健康证明。它们继续遵循既有启动、等待、拒绝及恢复逻辑。

## 结算机制

正常 advance 和原执行 orchestration 恢复路径，在完成既有身份校验、持久观察与健康证明后，报告两个操作的成功：agent-start，以及 preparing 阶段的 web-recovery-proof。初始输入提交后只有已确认的同一执行健康快照才可提供同样证据。

成功通知只结算该 claim 的对应操作；没有旧失败时保持幂等。不能清除 grant 刷新、输入提交、归档、worktree 删除、另一个 claim 或其他执行身份的失败。monitoring 回调失败也不能改变真实执行结果。

沿用现有同 claim 执行互斥、Controller 请求身份校验及 generation 推进规则。若实现中存在可能使旧 generation 的延迟结果结算新 generation 失败的路径，必须先补齐该路径的身份隔离；不能以监控属于辅助功能为由接受错误恢复。

实际证明原进程停止并按既有授权推进 generation 的路径，仍按其自身操作成功结算。不得因监控错误存在而额外启动 Controller、重放输入、清理 journal、解除暂停或更改 recovery budget。

## 验证

使用真实 Web backend、Worker store、Coordinator 和 monitoring observer 的对应测试边界，控制启动与 IPC 结果，证明：

1. 启动结果未知后，同一 Controller 健康可达，旧 agent-start 从 currentFailures 消失，lastRecovery 有依据，并且没有第二次原生启动或重复输入。
2. IPC 不可达且停证不足后，同一 Controller 恢复健康，旧 web-recovery-proof 消失；普通观察与 orchestration 恢复路径都覆盖。
3. 初始输入确认前不清除，确认后的健康观察可以结算。
4. 取消、非健康 lifecycle、缺失进程证明及身份不匹配都不产生上述恢复通知。
5. 其他 operationKey、其他 claim 和真实归档失败仍保留；重复健康观察不产生重复恢复记录。

回归应先在旧实现中失败，再验证修复。测试必须观察实际 currentFailures 或明确的 backend 成功通知及 Coordinator 精确结算结果，不能只断言 activity 为 running。

## 范围边界

此修复纠正“已经恢复但仍展示当前异常”的监控缺陷，不证明所有现存异常都是残留。archive_incomplete 是历史完整性拒绝，必须保留；暂停任务不自动恢复。服务端 Session 通道断连、HTTP 409、网络重置及真实 IPC 故障仍需各自的原因与修复证据。

发布前的源代码测试不代表正式 Worker 已更新。实际验收应分别记录发布版本、Worker 使用版本，以及对应操作恢复后页面和 CLI 的监控读回。

## 替代方案

**任务 running 时批量清空。** 会隐藏仍未恢复的归档、授权或其他操作错误，拒绝采用。

**按时间自动过期。** 经过一段时间不等于操作已恢复，可能隐藏持久故障，拒绝采用。

**在网页过滤旧错误。** 会使网页与 CLI 不一致，并掩盖生产者遗漏，采用 backend 提供恢复证据的方案。
