# Task Steps 架构设计

状态：REST、MCP、CLI 和 Web 的 Steps 入口已退役，Steps 应用服务、专用领域逻辑、codec 和输入策略已移除；Steps 存储合同、专用模型和 DAO 已移除，迁移 124 删除旧表及数据。[资源要求](../spec/daynight-task-steps.md)拥有当前退役合同。

## 目标与边界

公开入口不再提供父 Task 拥有的独立有序 Step 资源。REST 的集合、单项、status 和 position 不注册 handler、DTO 或专用 scope/CORS 路由。旧请求由既有未知 API 路径处理，不调用 Steps 用例，不回落 SPA，也不 touch 父 Task 或产生事件。普通 Task、Thread 和附件沿用各自路由及准入。

迁移删除旧 Steps 数据，不更改父 Task、材料或凭据，也不替代 Task 的整体状态、依赖、Worker 归属及 Session 生命周期。任务材料承载实施顺序和正式成果，Session 承载执行过程，PR 承载 review 迭代；普通 Task 投影不内嵌 Steps。

## 职责与内部数据流

| 位置 | 尚存职责 |
|---|---|
| `internal/core/model/task_header.go` | 普通资源使用的父任务头。 |
| `internal/core/store` | 普通 Task、Thread 和同步的存储合同，不包含 Steps 接口。 |
| `internal/core/task/codec` | 独立的 Thread 资源编码，不包含 Steps 投影或候选容量编码。 |
| `internal/core/store/postgres/task/` 与 `internal/core/store/postgres/internal/task_header.go` | 父任务头读取与锁定，以及普通 Task 的版本和时间更新。 |

生产 `Application` 与 scoped 装配均没有 Steps 字段、端口或构造器。任务服务及 Core 不提供 Steps 用例或候选规则，输入策略目录没有 `step.*` 项。Steps 专用存储实现及测试随接口移除；共享 Thread 编码、普通 Task 文字准入和共享错误保留。

## 存储选择

迁移 `030_task_steps.sql` 创建独立 `task_steps` 行及 Task 内位置唯一约束，历史文件和 checksum 保持。独立行曾支持目标文字局部更新及排序区间写入，避免把完整集合塞入 Task JSON 或借用描述、Session todo。迁移 124 在独立事务中删除旧表及全部记录，不修改父 Task 或正式材料。

旧行以 `(task_id,id)` 定位，Task 软删除曾保留这些行；删表也包括这些记录。历史迁移仍保留原约束和 checksum。

## 应用装配与存储边界

应用层没有 Steps 读取、写入或 scoped 准入调用链。存储接口和 PostgreSQL 实现不再提供 Steps 读取或写入；普通 Task 仍依赖的 `TaskHeader`、`TouchTask` 和共享错误保持原职责。

共享事务所有者继续区分 operation、commit、cleanup 阶段及 committed、not_committed、unknown 完成结果；cleanup 不能把未知提交改成已回滚。普通 Task、Thread、Webhook 和同步继续使用各自现有合同。退役 REST 路径只使用通用未知 API 响应及请求日志；旧请求的 request ID 不能作为业务写入、回滚或数据清理的证明。

## CLI 与 MCP 入口退役

CLI 的命令分派、API 导出、补全和手册主题均不包含 Steps。旧命令在配置、Git 和网络之前失败。通用 HTTP 确认与输出继续服务 Thread 等调用者，历史 Inbox 沿用共同解码。已安装 skill 沿用更新机制。

MCP 不注册七项 `task_step_*` 工具、schema、scope 工具清册或专用手册。旧名称进入共享 Entry 的未知工具错误路径。Task、Thread 和其他工具继续使用原有认证、请求预算与期限。

## Web 资源与单一写入所有者

Web 不请求或保存 Steps，也无写入入口。普通 Task 修改继续由 `TaskDetailSessions` 管理提交生命周期、身份校验和结果核对，详见[详情会话设计](daynight-task-inspection.md#状态与详情会话)。

## Web 呈现、导航与大集合

Web 不展示 Steps 集合。旧 `tab=steps` 地址和已保存的该选项按缺省页签恢复，普通 Task 进入概览，附件路径继续定位附件。详情页签和附件阅读由[任务详情设计](daynight-task-inspection.md#独立完整任务详情)拥有。

### 应用导航准入

`app/navigation.ts` 的窗口级 `BrowserNavigation` 拥有已准入 location、历史条目和离开选择。`Application`、`AuthenticatedApp` 与 `App` 通过 `useBrowserLocation` 订阅该 location，不直接用原生事件卸载 Surface。`navigate`、`replaceRoute` 在写历史前准入；关系跳转与模态详情关闭通过 `requestAction` 在修改本地选择前准入。取消程序导航不写历史，确认只执行一次已选动作。

`TaskDraftBoundary` 将草稿注册绑定到当前 `TaskCacheScope` 实例、Project 和 Task。标签编辑草稿及启用 `trackDraft` 的 Discussion 草稿提供实时 `isDirty` 与 `discard` 回调；切换隐藏页签仍保留注册。独立页的相同 Task 页签/附件导航保持 Surface，不弹放弃确认；模态详情转入独立页会卸载原 Surface，仍需准入。注销只释放注册，不推断放弃。明确放弃调用回调后保留尚未卸载的注册，因此后续新草稿仍受保护；确认动作内部的同步路由调用共享本次准入。

应用导航在 `history.state.__daynightNavigation` 保存窗口内的 segment 标识、entry index、独立 entryId 和可选轻量页面选择，并保留其他 state 字段。页面选择不含业务响应、草稿、秘密或 DOM。完整 URL 只保存在当前导航所有者的内存表中，避免邀请 fragment 被浏览器序列化保留；读取编号条目时，segment、index、entryId 和内存中的精确 URL 必须同时匹配，因此复制了 state 的原生 fragment 仍是未编号条目。启动仅用 `replaceState` 标记当前条目，不添加初始化条目。应用 push 的 index 在同一连续 segment 中按实际步长增加，replace 同步替换该 index 的 URL；邀请消费后的 fragment 清理使用同一所有者替换当前地址和内存记录，保持已准入 location 一致，不分配新 index。未编号邀请的清理移除复制的导航 marker 并保留其他 state，不把清理后的原生条目重新解释成已有编号。从未编号位置发起新的应用写入时，仅为实际写入条目开启新 segment 并释放旧 URL 表，旧 segment 不再参与索引差值恢复；不补标中间的原生历史项。导航所有者释放时清空 URL 表。

对于同一 segment 内有效编号的 Back/Forward，浏览器 URL 已改变时仍呈现已准入 location。脏草稿使导航所有者保留原条目并显示一个离开选择；连续遍历更新最新目标。确认直接采用已到达目标，不追加或重放历史。取消通过 `history.go(fromIndex - observedIndex)` 恢复原条目，恢复状态消费回程事件并阻止新的程序导航，直到完成恢复；不从卸载 cleanup 推断决定。

整文档离开由 `beforeunload` 请求浏览器原生确认。原生 fragment、其他无有效 marker 的历史项及跨 segment 遍历沿用原生行为，不保证取消后恢复原历史位置或保留跨 Task 离开的草稿，存在位置恢复失败或草稿丢失风险。索引差值算法不为这些条目补造数值；后续扩展由同一路由/历史所有者承担。

守卫仅属于当前窗口和活动编辑作用域，不形成业务恢复或路由持久化服务。身份 scope 的同步 abort、已确认项目撤权及父 Task 删除立即终结注册、清理私有草稿并撤销待定选择，不能被保留草稿阻止；暂时读取失败或权限重校验不触发此清理。确认层复用 `TaskConfirmation` 的取消初始焦点、焦点循环及独立 Escape 层，取消返回仍存在的触发器或回退焦点。离开选择出现时先关闭 Task 内的消息详情和附件删除原生对话框，避免浏览器 top layer 将应用确认层变成不可交互；取消导航不重新打开这些子层，也不丢失草稿。

## 凭据、迁移与部署

PAT 和 MCP 的生产目录排除 `step:read`、`step:write`，目录 revision 随可选项及默认值变化。规范化仍认识历史 ID，使已存凭据及已批准未兑换授权码保留原合同；编辑可保留或移除已存旧值，但不能重新添加。混合凭据继续使用其他原有授权，旧值不授予新的 Task scope。迁移 124 删除旧表和数据，不产生逐条事件或导出。

服务迁移严格验证顺序和 checksum。上线前停止并排空所有旧服务及后台工作，迁移锁无法阻止旧进程访问表。失败事务回滚表与 ledger；提交后旧二进制不认识新 ledger，须使用兼容制品向前修复。生产部署仍需独立授权。原始存储与协议取舍见[REST 退役决策](../../.agents/notes/implemented/simplification/2026-11-23-retire-rest-task-steps.md)及其前置记录。

## 验证与组件依赖

真实候选服务验证旧集合、单项及两个 PUT 子资源的原有方法、HEAD、CORS 预检与 SPA 隔离。严格依赖观察证明请求未调用 Steps 用例或存储；持久化及版本观察证明没有父 Task 改写。普通 Task、Thread 和附件继续验证成功及认证、scope、项目权限拒绝，普通软删除回归使用自身 fixture。

应用装配测试执行没有 Steps 服务的生产构造，并保留普通 Task、Thread、共享 Capturer、身份和观察能力的绑定证明。Task、Thread 与同步测试继续验证各自业务、编码和事务行为。PostgreSQL 测试继续拥有普通 Task 的 SQL、锁、快照、提交及回滚证明。Steps 专用 Service、Core 和 codec 测试随其实现移除。真实 MCP HTTP session、打包 CLI 与 Web 测试各自验证入口退役及普通操作。

[服务验证说明](../../packages/daynight-server/README.md#task-steps-api)拥有当前命令，实际源码、产物、环境、状态码和版本组合记录在对应交付证据中。
