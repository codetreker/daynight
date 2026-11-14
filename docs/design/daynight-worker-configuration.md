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

目标与观测分别拥有版本。目标保存不代表本机应用，观测写入不使编辑草稿失效。配置协议选择报告交换格式；托管模式和工具路径分别通过独立能力头选择闭合字段，旧投影保持原结构。

## 持久化与表示

workers 增加 configuration_revision、configuration_updated_at、desired_configuration、configuration_observation_revision 和 configuration_observation。目标三列同时为空或存在；应用观测独立为空，观测版本初始为 0。迁移不从任务或旧机器报告推测配置。

目标和观测保存受验证 JSONB，公开 revision 为十进制字符串，避免客户端 JSON 数值解析差异。配置标量、原生字段和项目数量受[配置协议](../spec/daynight-worker-configuration.md#目标配置)规定的业务容量约束。preferPlatformSpecificTasks 是独立布尔标量，不进入原生配置元组；应用观测的同名 key 接受 true、false 或 null。agentControlMode 作为同一目标 JSONB 中的 nullable 字段存储，只有旧目标未采纳时为 null。专用存储升级解码识别旧行缺字段，不改变新写入严格结构。项目覆盖以 key 存在性保留继承语义，不把省略改为显式默认值；mode 不属于项目覆盖。

configuration_observation 的 items 只保存旧协议可识别的项；mode 观测及其原序号保存在同一 JSONB 的私有 controlModeObservation 扩展槽。internal/protocol/worker 的存储 codec 拥有该表示，DAO 写入与实际存储字节预算使用同一编码，读取时按序号恢复公开 items。旧服务的结构体解码会忽略扩展槽，回退后不会把未知 mode key 返回给严格旧客户端。旧服务接受新报告并完整替换观测时会移除该扩展；再次升级后没有 mode 应用证据，必须等待 Worker 重新报告，不能复活旧 applied 值。此表示不增加业务列，也不改变公开协议。

toolPaths 保存于同一 desired JSONB，固定三项 choice/null。旧 JSONB 缺少外层字段时由存储解码补三个 null，不改 revision 或时间，不把未采纳状态当作 auto。工具实际观察独立保存于现有 telemetry JSONB，由完整报告替换；后续报告省略扩展会清除原字段，避免旧 Worker 沿用此前成功。此扩展不新增表、列或配置 CRUD。

数据库迁移为已初始化且缺少 preferPlatformSpecificTasks 的目标 JSON 补入 false，保留目标版本、修改时间、观测版本与原应用结果。缺少同名应用观测仍表示等待 Worker 确认，不从迁移后的目标推导已应用。当前完整目标解析始终要求该布尔字段。

配置 GET 按认证 userId/workerId 读取，不施加近期窗口，不续活。快照列表与详情继续使用[快照设计](daynight-worker-snapshots.md)的时间及权限规则。 Bot 创建只读取所选 Worker 的原生配置和成功偏好，其选择规则与完整默认目录由[助手设计](assistant.md#默认解析与偏好事务)维护。

## Worker 行事务

报告复用 Store.WriteWorker。机器观测 upsert 建立或更新记录后，配置分支锁定同一 Worker 行：缺失目标且有合法候选时建立初值；已有目标不被完整候选改写。controlModeBootstrap 仅填尚未采纳的模式，toolPathsBootstrap 分别填尚为 null 的工具。最终候选先完成规范化、编码及预算，再一次持久化；多个工具和模式同时采纳也只升一次目标版本。无变化不写，编码失败回滚整个报告。观测比较自身 baseRevision 后保存。回执来自该事务内最终目标与观测版本。

PUT 也锁定这行，先校验目标版本。协议层只设置内部 PreserveAgentControlMode/PreserveToolPaths 标志，不接受这些标志为业务 JSON。core 在锁内 CAS 后将旧客户端不认识的值合并入候选，再完整规范化、校验新增/修改项目准入、编码预算与深相等比较；不能从旧 GET 或解析器默认值决定保留内容。已采纳的模式或工具 choice 不能清回 null，工具 auto 为正常显式更新。保留相同项目条目或删除失权条目不要求重新取得项目权限。配置事务不进入 Project 写事务，不创建任务锁序或跨任务注册门禁。

并发导入只建立一次初值。观测 CAS 失败不覆盖结果，也不使合法 telemetry 失败；目标 CAS 失败不改变目标。数据库操作、提交与回滚错误保留原链。

## 输入与输出边界

带有效配置协议 1/2 的报告使用 9 MiB 正文预算，普通报告保持 1 MiB；HTTP 在选择额度前拒绝未知或重复协议头。配置报告预算只改变传输准入，不改变 DTO、能力协商、目标和观测存储限制或事务。服务端和入口须先支持 9 MiB，再升级 Worker；旧服务或入口的 413 仍是容量或版本不匹配，不能作为成功回执。

目标、项目覆盖、观测 key 与应用值分别做闭合解析。native 原子组合保证 Agent/model/args 的表示有效，服务端不运行 native preflight。观测只接受闭合诊断字段，不把自由输出带入日志或 HTTP。

对目标配置值和实际存储的、包含 reportedAt 的观测编码后计量，超限在事务提交前拒绝。客户端把本机完整事实与本批 wire 投影分开，以条数、Go JSON 存储编码和完整请求编码同时选择连续前缀。固定保留真实未完成或失败停止核验，其余按持久化 recordId 游标轮转；匹配接纳后才按源记录身份清理失败，且仅当前 generation 的捕获推进游标。未知结果、未发送失败和原停止归属继续留在本机检查点，目标接纳与责任登记不受单批名额阻挡。本机表示与应用机制由[Worker 设计](daynight-worker.md#云端接收与本机提交)拥有。旧协议观测集合上限仍为 1025；模式能力扩展为 1026，新增名额只用于 agentControlMode，非 mode 项最多 1025。旧响应投影删除 mode 后仍可由旧严格客户端解析，旧缓存迁移不丢失已有恢复记录；规范化 JSON 的总字节预算仍独立适用。

服务端仍整体替换本次 observation，不聚合此前各批 items，也不引入 completeness 字段。应用观测保留本批服务器接纳时间；机器报告可以更新，而应用结果仍是此前已接纳的整批状态。消费者将当前目标与所报每项目标版本比较，保持旧实际值和明确等待/失败含义；缺少当前目标项表示本批未观察，不能复用另一批结果宣称成功。

独立 Daynight-Worker-Control-Mode: 1 请求与回显控制 mode 字段及观测项的严格解析和投影，不依赖配置协议 1/2。未协商时去除 mode 及同名观测，保持旧严格消费者可读；新客户端只有确认回显才发送 controlModeBootstrap。模式能力不改变账号、Origin、principal、配置 CAS 和报告身份校验。

Daynight-Worker-Tool-Paths: 1 同样独立协商。HTTP 在业务调用前拒绝重复值和非 1；显式能力选项分别控制 mode 与 tools 的严格解析，不能为滚动升级开放任意未知字段。protocol DTO 在编码前选择投影，旧配置省略 toolPaths、旧详情省略 telemetry.toolPaths；列表只验证并回显能力，维持摘要。客户端工具能力绑定认证 origin/principal，由配置 GET 或已认证 404 确认，不能由报告响应或包版本推断可发送扩展。合法报告回执缺少 mode 或 toolPaths 任一投影时，运行时在下一次报告准备阶段重新读取配置；mode 已存在不停止工具能力发现。字段缺失只安排认证读取，不授予能力；下一次报告按读取结果重新构造，不重放结果未知的写入。

路径验证只处理远端语法，不能查询服务端文件或使用服务本机 filepath 规则替代 Worker 平台。工具观察包含目标、新准入 actual、candidate 和有界 activeSelections；它不进入 native appliedValue，服务验证不会产生执行资格。完整字段及降级规则由[快照协议](../spec/daynight-worker-snapshots.md#工具路径观察)拥有。

旧协议不接受新正文，旧回执不附加配置字段；配置协议 1 遵循完整扩展结构。协议 2 的有限个人 prompt 批次在原报告提交后独立读取，机制由[个人 prompt 设计](worker-prompts.md#配置报告)拥有。能力仅影响配置交换，不成为 Task/claim 或 inventory 的准入条件。

## Web 字段与保存

`ConfigurationControlModeField` 与 `ConfigurationNativeFields` 的全局 Agent、项目 Agent、Model 模式和 Args 模式共用 [NativeSelect](native-select.md) 的 `form`/`fill` 变体，表单高度为 38px。公共组件拥有箭头、文字留白、焦点和禁用外观，配置样式仅安排表单网格与外部布局。选项、继承与自定义联动、重置、反馈和异步保存由配置编辑器拥有。

托管模式仍只有 `herdr` 和 `web` 两个选项。`ConfigurationControlModeField` 的 ref 指向真实 `HTMLSelectElement`，自身 `useLayoutEffect` 在 nullable 草稿未采纳时设置 `selectedIndex=-1`；公共层不增加第三项或选择默认模式。能力不支持时继续禁用，label、可用性说明、反馈的 `aria-describedby` 和项目 Model/Args 的 `aria-controls` 继续关联真实字段。后台复核保留字段节点、焦点和草稿，不从观测值替换编辑输入。

Web 配置编辑器持有提交的账号、Worker、操作、目标版本与草稿快照，并分别记录实际派发和可信响应。准备和准入等待使用操作自己的取消信号；暂停时本地保存分类与 pending 收尾不依赖远程准入。已确认、已派发但未确认、未派发及明确拒绝分别保留其原有结果含义，不把取消解释为服务端回滚。

配置资源安装和必要的后续读取由原编辑器持有并受账号、资源、操作与准入检查；延迟发布可在临时暂停解除后继续，并在被取代或销毁时取消且接收错误。编辑器以内存中的草稿 revision 区分提交后输入，即使新输入恢复到相同值也不能被旧结果清除；新保存仍需原有目标版本、权限和新鲜度检查。暂停期间不自动 GET 或重放 PUT。本地收尾与远程发布分离的选择及其代价见[决策记录](../../.agents/notes/implemented/bug-fix/2026-11-11-worker-configuration-save-settlement.md)。

## 验证边界

真实 PostgreSQL 验证并发导入、独立 CAS、相同值、规范化比较、权限变化、事务失败与持久状态。HTTP 验证认证、Origin、查询/方法拒绝、精确字段、布尔 false、版本和原格式。迁移验证已初始化目标补入 false 而版本、时间、观测、Worker 遥测与任务数据不变；未初始化 Worker 不生成目标。

Web 模块测试验证两选项无选中、能力禁用、继承与自定义、保存/拒绝/未知结果及后台复核中的草稿连续性。`tests/navigation/worker-configuration-arrow.browser.ts` 在生产 App 的受控 API fixture 中检查公共箭头、表单几何、禁用和 forced-colors；`worker-control-mode.browser.ts` 检查真实模式字段和配置交互。箭头回归由 `team-playwright.config.ts` 的 `team-preference` 项目执行，模式回归由 `worker-configuration-navigation-playwright.config.ts` 执行；公共组件矩阵由[公共选择组件](native-select.md#验证责任)拥有。

服务端验证输入和账号归属，不能证明客户端真正准备了仓库或停止了进程；这些结果由本机观察并上报。配置接入不依赖任务清单同步，不改变现有任务恢复行为。
