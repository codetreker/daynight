# 独立 App 的项目与 Team 清退

`service/project.AppProjects` 提供完整项目转移和删除协调器，`service/team.AppTeams` 提供空 Team 删除协调器。它们复用既有业务规则，并通过专用事务 scope 将 Project、Team、App、授权、连接、Webhook 资格和 Session 清退绑定同一事务。当前生产调用者仍使用原公共构造器；采用新组件时须整体切换，不能将旧 `MarkDeleted` 的隐式全局 App 失效回调混入新流程。

## 项目转移

转移复用当前 Team admin、原 ownershipVersion、目标 Team version 与同值规则。实际跨 Team 转移在同一事务解除连接、关闭同步、清除旧领取、提示和日程，推进原 App 的 impactVersion；即使目标 Team 也获同 App 授权也不继承连接。同值归属保留连接。项目身份、直接授权、邀请和历史 PR 保留，转移回执沿用既有操作者剩余访问权限语义。

锁顺序为 Project 根、ownership、按 UUID 排序的来源与目标 Team 根、来源 App、grant、connection。锁 App 前读取候选身份，等待后以新语句锁定并重读当前连接。并发 App 删除或撤权已清空连接时不重复清退；仍引用缺失或已删 App、无效 grant 时暴露完整性错误。

## 项目删除

删除锁定 Project 和全部历史 Task，再按 ownership、owner Team 共享根、当前权限来源、App、grant、connection 的顺序处理。提交前再次检查 owner Team admin，并拒绝历史 Task 中的有效 Worker claim。新的原始删除标记只标记 Project；App-aware 协调器负责实际连接清退与 impact 更新。

同一事务刷新 Webhook 资格、持久化 Session 清退并捕获内存 retirement ticket；只有确认提交后才执行 ticket 的内存清退。回滚、清理失败和未知提交保留原完成语义，不把未知结果解释为成功。项目历史内容保留，公开读取遵守已删除 Project 的既有行为。

## 空 Team 删除

Team 删除保留既有 admin、Personal Team、原名称、原版本和空 Team 条件。Team 根锁冻结新增使用授权及涉及该 Team 的转移；随后收集当前 grant 的 App 候选，按 UUID 锁齐全部 App 根，再用新语句读取并锁定当前 grant。并发 App 删除已撤销的授权无需再次处理；仍有效却指向缺失 App 的授权是完整性错误。

事务永久撤销该 Team 的使用授权，清退对应连接并推进各 App 的 impactVersion。独立 App、管理员、其他 Team 的授权和历史 PR 保留。无 App 绑定但仍保存开启意愿的项目也在实际转移或删除时关闭意愿。共享停止操作见[Team 使用授权](github-app-team-grants.md)，连接身份与意愿见[项目连接](github-app-project-connection.md)。
