# Worker 云端配置服务端设计

[接口需求](../spec/daynight-worker-configuration.md)拥有数据与可观察结果；[决策记录](../../.agents/notes/archived/architecture/2026-11-04-worker-cloud-configuration.md)保存写入者分离、协议扩展和真实备选的理由。

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

目标与观测分别拥有版本。目标保存不代表本机应用，观测写入不使编辑草稿失效。配置协议选择报告交换格式；工具协议版本 2 确认两工具线形。enableSudoCleanup 直接包含在目标中。

## 持久化与表示

workers 增加 configuration_revision、configuration_updated_at、desired_configuration、configuration_observation_revision 和 configuration_observation。目标三列同时为空或存在；应用观测独立为空，观测版本初始为 0。迁移不从任务或旧机器报告推测配置。

目标和观测保存在 JSONB，公开 revision 为十进制字符串。新写入按[配置协议](../spec/daynight-worker-configuration.md#目标配置)严格验证；项目覆盖以 key 存在性保留继承语义。旧目标以原始 JSON 保存和读取，不更改 revision 或丢弃旧字段。PUT 将旧目标用于 CAS 和项目比较，候选按新 schema 完整替换。

旧 observation 中的模式项只作为历史数据读取；新报告不接受或产生模式项。新报告完整替换观测，不合并历史结果。

toolPaths 是新目标中的 codex/copilot 两项 choice/null。工具观察独立保存于 telemetry JSONB，由完整报告替换；旧观察只投影已有 Web 工具事实。新写入不补造旧工具值。

数据库迁移为已初始化且缺少 preferPlatformSpecificTasks 的目标 JSON 补入 false，保留目标版本、修改时间、观测版本与原应用结果。缺少同名应用观测仍表示等待 Worker 确认，不从迁移后的目标推导已应用。当前完整目标解析始终要求该布尔字段。

另一项迁移只为非 null 且缺少 enableSudoCleanup 的目标补入 false。该变化推进 configuration_revision 并更新 configuration_updated_at；已有该字段的目标和 null 目标保持不变，观测及其他数据不变。若需修改的目标 revision 已耗尽，整个迁移事务失败，不产生同版本不同内容，也不生成应用观察。存储读取兼容历史目标缺字段；首次旧 bootstrap 缺字段时由服务初始化为 false。

配置 GET 按认证 userId/workerId 读取，不施加近期窗口，不续活。快照列表与详情继续使用[快照设计](daynight-worker-snapshots.md)的时间及权限规则。 Bot 创建只读取所选 Worker 的原生配置和成功偏好，其选择规则与完整默认目录由[助手设计](assistant.md#默认解析与偏好事务)维护。

## Worker 行事务

报告复用 Store.WriteWorker。机器观测 upsert 建立或更新记录后，配置分支锁定同一 Worker 行：缺失目标且有合法候选时建立初值；已有目标不被完整候选改写。toolPathsBootstrap 分别填尚为 null 的工具，最终候选先规范化、编码及预算，再一次持久化；无变化不写，失败回滚全部采纳。观测比较自身 baseRevision 后保存。

PUT 锁定 Worker 行并校验目标版本，省略 enableSudoCleanup 时在行锁内保留当前值。候选按新 schema 完整规范化，校验新增或修改项目的准入、编码预算与深相等；显式 false 为普通更新，null 或非布尔类型拒绝。已采纳工具 choice 不能清回 null。保留相同项目条目或删除失权条目不要求重新取得项目权限。

并发导入只建立一次初值。观测 CAS 失败不覆盖结果，也不使合法 telemetry 失败；目标 CAS 失败不改变目标。数据库操作、提交与回滚错误保留原链。

## 输入与输出边界

带有效配置协议 1/2 的报告使用 9 MiB 正文预算，普通报告保持 1 MiB；HTTP 在选择额度前拒绝未知或重复协议头。配置报告预算只改变传输准入，不改变 DTO、能力协商、目标和观测存储限制或事务。服务端和入口须先支持 9 MiB，再升级 Worker；旧服务或入口的 413 仍是容量或版本不匹配，不能作为成功回执。

目标、项目覆盖、观测 key 与应用值分别做闭合解析。native 原子组合保证 Agent/model/args 的表示有效，服务端不运行 native preflight。观测只接受闭合诊断字段，不把自由输出带入日志或 HTTP。

对目标配置值和实际存储的、包含 reportedAt 的观测编码后计量，超限在事务提交前拒绝。客户端把本机完整事实与本批 wire 投影分开，以条数、Go JSON 存储编码和完整请求编码同时选择连续前缀。固定保留真实未完成或失败停止核验，其余按持久化 recordId 游标轮转；匹配接纳后才按源记录身份清理失败，且仅当前 generation 的捕获推进游标。未知结果、未发送失败和原停止归属继续留在本机检查点，目标接纳与责任登记不受单批名额阻挡。本机表示与应用机制由[Worker 设计](daynight-worker.md#云端接收与本机提交)拥有。服务端每批最多接受 1027 项，CLI 投影最多发送 1025 项。规范化 JSON 的总字节预算仍独立适用。

enableSudoCleanup 观察项沿用原 state、targetRevision 与 boolean/null appliedValue；没有该项表示本批未观察，而不是实际关闭。服务端不会替未认识此字段的 Worker 生成应用项。服务端仍整体替换本次 observation，不聚合此前各批 items，也不引入 completeness 字段。应用观测保留本批服务器接纳时间；机器报告可以更新，而应用结果仍是此前已接纳的整批状态。消费者将当前目标与所报每项目标版本比较，保持旧实际值和明确等待/失败含义；缺少当前目标项表示本批未观察，不能复用另一批结果宣称成功。

HTTP 在业务处理前对配置、报告和详情要求 `Daynight-Worker-Tool-Paths: 2`，成功响应回显；列表保持原摘要。客户端验证回显，缺失时提示升级而不降级。Worker 的配置专用源文本保留旧目标和未知字段；服务端新写入仍严格验证。具体资源范围与旧目标修正由[配置协议](../spec/daynight-worker-configuration.md#工具路径协议)拥有。

路径验证只处理远端语法，不能查询服务端文件或使用服务本机 filepath 规则替代 Worker 平台。工具观察包含目标、新准入 actual、candidate 和有界 activeSelections；它不进入 native appliedValue，服务验证不会产生执行资格。完整字段及降级规则由[快照协议](../spec/daynight-worker-snapshots.md#工具路径观察)拥有。

旧协议不接受新正文，旧回执不附加配置字段；配置协议 1 遵循完整扩展结构。协议 2 的有限个人 prompt 批次在原报告提交后独立读取，机制由[个人 prompt 设计](worker-prompts.md#配置报告)拥有。工具协议准备必须在领取新任务前完成；不改变 Task/claim 或 inventory 的线形。

## Web 字段与保存

`ConfigurationNativeFields` 的全局 Agent、项目 Agent、Model 模式和 Args 模式共用 [NativeSelect](native-select.md) 的 `form`/`fill` 变体，表单高度为 38px。公共组件拥有箭头、文字留白、焦点和禁用外观，配置编辑器拥有继承、反馈和异步保存。

表单不提供托管模式选择。旧目标及不支持字段保持可查看，编辑草稿独立；仅用户明确保存完整新配置时替换旧目标。

配置端点使用专用源文本解码，验证 JSON 语法、重复解码键及深度，再从同一响应派生已知视图和完整目标基底。已知视图供表单校验，未知子树保留为已验证 JSON 片段；合并按已知叶子及 projectId 对齐实体，明确删除项目时删除其全部内容。提交冻结原 revision 与合并后的完整 value，回执及未知结果读取按完整语义比较，对象无序、数组有序、数字无损比较；已知项目按 ID 对齐。提交使用严格两工具新结构。后台读取不能替换已有草稿的源基底，确认回执才建立新的提交基底。

Web 配置编辑器持有提交的账号、Worker、操作、目标版本与草稿快照，并分别记录实际派发和可信响应。准备和准入等待使用操作自己的取消信号；暂停时本地保存分类与 pending 收尾不依赖远程准入。已确认、已派发但未确认、未派发及明确拒绝分别保留其原有结果含义，不把取消解释为服务端回滚。

配置资源安装和必要的后续读取由原编辑器持有并受账号、资源、操作与准入检查；延迟发布可在临时暂停解除后继续，并在被取代或销毁时取消且接收错误。编辑器以内存中的草稿 revision 区分提交后输入，即使新输入恢复到相同值也不能被旧结果清除；新保存仍需原有目标版本、权限和新鲜度检查。暂停期间不自动 GET 或重放 PUT。本地收尾与远程发布分离的选择及其代价见[决策记录](../../.agents/notes/implemented/bug-fix/2026-11-11-worker-configuration-save-settlement.md)。

## 验证边界

真实 PostgreSQL 验证并发导入、独立 CAS、相同值、规范化比较、权限变化、事务失败与持久状态，包括 sudo 字段省略保留、显式关闭及版本冲突。HTTP 验证认证、Origin、查询/方法拒绝、精确字段、布尔 false、版本和原格式。迁移验证 preferPlatformSpecificTasks 补值保持版本与时间；enableSudoCleanup 补值推进版本与时间，已存在字段及未初始化目标不变，revision 耗尽时整体回滚。两者均不改变观测、Worker 遥测或任务数据，也不为未初始化 Worker 生成目标。

Web 模块测试验证旧目标展示、明确保存修正、继承与自定义、保存/拒绝/未知结果及后台复核中的草稿连续性。公共组件矩阵由[公共选择组件](native-select.md#验证责任)拥有。

服务端验证输入和账号归属，不能证明客户端真正准备了仓库或停止了进程；这些结果由本机观察并上报。配置接入不依赖任务清单同步，不改变现有任务恢复行为。
