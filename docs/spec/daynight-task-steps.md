# Task Steps 资源契约

状态：REST、MCP、CLI 和 Web 均不提供 Task Steps 入口。应用服务与专用领域逻辑也已移除。存储接口、专用模型和 DAO 已移除；旧表仍保留。本文拥有退役要求及数据边界。Task 的常规读取、列表、图和同步保持各自资源投影。

## 公开入口退役

以下 `T` 表示 `/api/v1/projects/{projectId}/tasks/{taskId}`。服务不注册 `T/steps`、`T/steps/{stepId}`、`T/steps/{stepId}/status` 或 `T/steps/{stepId}/position`。旧 GET、HEAD、POST、PATCH、DELETE 和 PUT 请求进入既有未知 API 路径处理，返回非成功结果；不得落入 SPA、普通 Task 资源或 Steps 用例。退役路径的 CORS 预检不声明其原有方法。

退役请求不得读取或修改 Steps 存储，不得推进父 Task 版本或更新时间，不得产生领域事件。路径不保留专用重定向、成功空集合或写入兼容适配器。普通 Task、Thread 和附件继续使用其现有路由、认证、项目授权、scope 和错误语义。

MCP 不提供 `task_step_{list,show,add,update,set_status,move,delete}` 或 `daynight://manuals/steps.md`。旧名称返回既有未知工具错误；其他工具和手册保持。

CLI 不提供 `daynight task step`、专用 API 客户端、补全项或 Steps 手册主题。旧命令在配置、Git 和网络之前按未知 Task 操作失败。普通 Task、附件、Thread、Session 和历史 Inbox 解码保持。已安装 skill 沿用现有更新流程，正式 CLI 发布沿用既有版本与发布流程。

## Web 导航

Task 弹窗、独立详情和 Goal 内嵌详情不提供 Steps 页签或请求。旧 `tab=steps` 地址及已保存选择按缺省页签恢复；普通 Task 打开概览，附件路径仍定位对应附件。普通 Task 的访问校验、编辑和附件导航保持。

## 所有权与模型

应用装配不提供旧或 scoped Steps 服务；Steps 用例、领域候选、专用 codec 和 `step.*` 输入策略均已移除。共享 Thread codec、普通 Task 文字策略和共享错误保持各自职责。Steps 存储合同、专用模型和 PostgreSQL DAO 均已移除，生产代码不再读写 `task_steps`；该表仍由现有 schema 管理。普通 Task 使用的 `TaskHeader`、`TouchTask` 和同步语义保留。持久化行和现有父 Task 不因此改写，历史迁移及 checksum 保持。PAT 和 MCP 的可选目录及默认权限不包含 `step:read`、`step:write`。已存凭据及已批准未兑换授权码保留原 scope 和凭据身份；编辑可保留或移除已存旧值，移除后不能重新添加。旧值不授予新的 Task 权限。

尚存的存储记录以父 Task 和 Task 内八位十六进制 ID 定位，保留独立标题、Markdown 说明、四状态和 UTC 微秒内容时间，位置在 Task 内稠密。其状态不决定 Task 完成、review、Worker 调度或 Session 生命周期。普通 Task DTO 不内嵌 Steps。

专用 Steps 业务规则及其测试随用例移除，不再公布文字、候选集合容量或排序操作的应用合同。普通 Task 的存储测试继续证明 SQL、锁、快照、提交及回滚。普通 Task、Thread 和同步读写继续保留各自的授权、版本、事务与错误合同。

## 验证要求

| 编号 | 观察 |
|---|---|
| ST-REST1 | 真实候选服务上的旧集合、单项、status 和 position 路径对原有方法及 HEAD 均非成功；API 请求不回落 SPA。 |
| ST-REST2 | CORS 预检不公布退役路径；请求不调用 Steps 存储，不改变父版本、更新时间或领域事件。 |
| ST-REST3 | 普通 Task、Thread 和附件的成功及拒绝仍使用既有认证、scope、项目授权和错误规则；普通软删除回归不依赖 Steps fixture。 |
| ST-MCP1 | HTTP session 的发现不包含七项工具和专用手册，旧名称明确失败，其他工具与手册保持。 |
| ST-CLI1 | 打包 CLI 的帮助、补全和手册发现均不提供 Steps，旧命令非零退出，普通 Task 保持。 |
| ST-W1 | Web 三种详情入口不请求 Steps；旧地址和历史恢复、附件导航、普通 Task 修改及访问校验保持。 |
| ST-APP1 | 生产应用装配及任务服务不提供旧或 scoped Steps 操作；专用领域用例、codec 和输入策略已移除，Thread codec 仍可用。 |
| ST-APP2 | 普通 Task、Thread、同步读写及其事务与错误验证继续通过；Steps 存储合同、模型和 DAO 均已移除，旧表仍保留。 |

[服务验证说明](../../packages/daynight-server/README.md#task-steps-api)拥有验证入口；源版本、产物及实际结果随对应 PR 和验收材料保存。入口退役不代表生产部署或持久化数据清理已经完成。
