# Worker 云端配置服务端设计

[接口需求](../spec/daynight-worker-configuration.md)拥有数据与可观察结果；[决策记录](../../.agents/notes/archived/architecture/2026-11-04-worker-cloud-configuration.md)保存写入者分离、协议扩展和真实备选的理由。

## 职责与结构

配置作为现有账号级 Worker 的独立子资源。HTTP 负责认证、能力选择和严格 JSON，core/worker 负责规范配置、当前项目准入与版本决策，service/worker 组织事务，store 在 Worker 行上保存目标及应用观测。配置分支不读取或锁定任务数据，不调用认领或恢复操作。

显式 scoped 服务在原事务内分别核对报告、完整目标读取及实际目标变更权限。
Bootstrap 与独立工具路径导入按锁内最终候选判定是否写目标；无变化导入不要求
配置写权限。生产装配使用 scoped 入口，权限与提交后提示词读取的完整边界见
[凭据 Scope 内部合同](credential-scope-internal.md#worker-报告与检查准入)。

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

目标与观测分别拥有版本。目标保存不代表本机应用，观测写入不使编辑草稿失效。配置协议选择报告交换格式；工具路径使用必需的版本 2 合同，Session 归档与平台任务规则分别通过独立能力头选择闭合字段。enableSudoCleanup、enableWindowsProcessCleanup 和 taskTagFilter 直接包含在目标中，不增加字段专用的能力协商。

## 持久化与表示

workers 保存 configuration_revision、configuration_updated_at、desired_configuration、configuration_observation_revision、configuration_observation 和 archive_sessions。目标三列同时为空或存在；应用观测独立为空，观测版本初始为 0。迁移不从任务或旧机器报告推测配置。

目标 JSONB 作为独立原始事实与 revision、修改时间一起读取；读取不以当前候选 schema 的解析结果替代原值。完整 PUT 的候选严格验证，未知或不兼容的已存字段可被合法替换。旧 mode 只保留在原始目标中，完整新候选不会将其恢复。观测按其存储协议解码；公开 revision 为十进制字符串。项目覆盖以 key 存在性保留继承语义。

configuration_observation 的 items 保存除 mode 和 archiveSessions 外的应用项，包括 enableSudoCleanup 和 enableWindowsProcessCleanup；mode 与 archiveSessions 观测保存在同一 JSONB 的私有扩展槽，各自保留可恢复顺序的序号。internal/protocol/worker 的存储 codec 拥有该表示，DAO 写入与实际存储字节预算使用同一编码，读取时按序号恢复公开 items。仍在运行的旧服务忽略未知扩展槽，不会回显这些槽中的 key；直接字段的兼容基线按需求规定。旧报告完整替换观测时会移除扩展，此后必须等待 Worker 重新报告，不能复活旧 applied 值。数据库迁移后，旧二进制重启会因迁移版本超出其已知范围而拒绝启动。

archive_sessions 是 `boolean NOT NULL DEFAULT true` 独立列，迁移为已有 Worker 设为 true，新 Worker 也从 true 开始。它不存入基础 desired JSONB，避免旧服务完整重写该 JSON 时擦除已保存的归档目标。读取时将列与目标组合；目标 revision、修改时间和列值在同一 Worker 行事务中维护。

toolPaths 保存于同一 desired JSONB，新候选固定 Codex/Copilot 两项 choice/null。旧原始目标缺字段或含第三工具时不自动补全或转换。工具实际观察独立保存于现有 telemetry JSONB，由完整报告替换；后续报告省略扩展会清除原字段。

历史平台偏好迁移曾为已初始化目标补入 preferPlatformSpecificTasks:false，保留版本、时间及观察。平台任务规则迁移将实际布尔 false/true 分别改为 platformTaskMode:all/prefer，删除旧成员并推进目标版本与修改时间；未知兄弟和原观察保持。未初始化目标不建立默认配置，版本耗尽使迁移及账本整体回滚。当前领域解析只接受枚举，旧布尔转换集中在 HTTP 协议入口和首次 bootstrap，存储读取不做运行时旧数据修复。部署前必须排空旧配置写入者，数据库迁移锁不能阻止旧服务回写。

另一项迁移只为非 null 且缺少 enableSudoCleanup 的目标补入 false。该变化推进 configuration_revision 并更新 configuration_updated_at；已有该字段的目标和 null 目标保持不变，观测及其他数据不变。若需修改的目标 revision 已耗尽，整个迁移事务失败，不产生同版本不同内容，也不生成应用观察。存储读取兼容历史目标缺字段；首次旧 bootstrap 缺字段时由服务初始化为 false。

任务标签筛选迁移仅对已初始化且缺该成员的 Raw JSONB 用 jsonb_set 补入规范空筛选，保留未知兄弟成员，并推进目标版本和修改时间。版本耗尽时整个迁移失败；已有成员及未初始化目标不变。首次 bootstrap 同样由服务端补空。旧 PUT 省略该成员时在行锁及版本核对内保留原始值，显式输入严格解析；语义等价保持已存显示形式。新增或改变非空筛选前核对最近一批 observation 是否含该 kind，清空及保留不依赖此观察。

配置 GET 按认证 userId/workerId 读取，不施加近期窗口，不续活。快照列表与详情继续使用[快照设计](daynight-worker-snapshots.md)的时间及权限规则。 Bot 创建只读取所选 Worker 的原生配置和成功偏好，其选择规则与完整默认目录由[助手设计](assistant.md#默认解析与偏好事务)维护。

## Worker 行事务

报告复用 Store.WriteWorker。服务层重新解析基础配置 JSON 时单独保留归档候选，避免独立列字段丢失。配置分支锁定 Worker 行：缺失目标且有合法候选时建立初值；已有目标不被完整候选改写。toolPathsBootstrap 只填可应用目标中尚为 null 的两项工具；旧模式或第三工具需要显式纠正，报告不自动转换。观测比较自身 baseRevision 后保存，回执来自事务内最终目标与观测版本。

PUT 也锁定这行，先校验目标版本。平台规则在同一锁内读取当前原始目标及最近接纳观察：旧布尔 true 保留现有 only，false 返回升级冲突；枚举新启用 only 要求本批真实 platformTaskMode 项，保留 only 与明确退出不要求该项。该检查先于 typed 或 Raw 保值分支，避免无关配置编辑擦除严格目标。协议层只设置内部保留标志，不接受这些标志为业务 JSON。core 在锁内 CAS 后将省略的 sudo 和未协商的归档值合并入候选，再完整规范化、校验新增/修改项目准入、编码预算与完整目标比较；未知字段使完整替换产生新版本。无法确认相同的项目条目时重新校验项目访问；不能从旧 GET 或解析器默认值决定保留内容。显式 enableSudoCleanup:false 是普通更新，null 或非布尔类型拒绝。已采纳的工具 choice 不能清回 null，工具 auto 为正常显式更新。保留相同项目条目或删除失权条目不要求重新取得项目权限。配置事务不进入 Project 写事务，不创建任务锁序或跨任务注册门禁。

并发导入只建立一次初值。观测 CAS 失败不覆盖结果，也不使合法 telemetry 失败；目标 CAS 失败不改变目标。数据库操作、提交与回滚错误保留原链。

## 项目事务内的目标读取资源

`ProjectWriteScope.WorkerClaimAdmissionDAO()` 提供与当前项目写事务绑定的窄资源。`ClaimWorkerConfiguration(ctx,userID,workerID)` 只读取目标的 Raw、revision 与修改时间，返回 `*model.WorkerDesiredConfiguration`；不解析完整 typed 配置或应用观测，也不投影独立归档列。返回 nil 表示 Worker 尚不存在或目标尚未初始化，查询、锁等待、取消及数据库失败均保留错误，不解释为空目标。任务领取独立解析 Raw 中的筛选，即使整个 typed 投影不可用也不能放宽限制；仅 nil 目标视为空，已初始化目标缺失或非法成员报错。

已有 Worker 行通过 `SELECT ... FOR UPDATE` 锁定到项目事务提交或回滚，配置 PUT 和报告对该行的写入随之串行。缺行的首次查询没有取得行锁，因此先复用报告的 `worker-admission:<userID>` 账号事务锁，再以独立 READ COMMITTED 语句重读并锁定 Worker；仍缺行时保持账号锁到项目事务结束，阻止首次报告插入穿过读取边界。账号锁的 SQL 由同一 helper 提供，已有行路径不取得该锁，避免将正常跨项目读取串行到账号级。

此资源的锁序为 Project → 调用者已持有的 Task → Worker；缺行时为 Project → Task → 账号准入锁 → Worker 重读。报告仍按账号准入锁 → Worker 写入，配置事务中的项目访问检查保持无项目行锁。读取资源不开启嵌套事务，也不独立提交；[决策记录](../../.agents/notes/implemented/architecture/2026-11-18-worker-claim-target-resource.md)保存窄读取和缺行互斥的取舍。

## 输入与输出边界

带有效配置协议 1/2 的报告使用 9 MiB 正文预算，普通报告保持 1 MiB；HTTP 在选择额度前拒绝未知或重复协议头。配置报告预算只改变传输准入，不改变 DTO、能力协商、目标和观测存储限制或事务。服务端和入口须先支持 9 MiB，再升级 Worker；旧服务或入口的 413 仍是容量或版本不匹配，不能作为成功回执。

目标、项目覆盖、观测 key 与应用值分别做闭合解析。native 原子组合保证 Agent/model/args 的表示有效，服务端不运行 native preflight。观测只接受闭合诊断字段，不把自由输出带入日志或 HTTP。

对目标配置基础 JSON 和实际存储的、包含 reportedAt 的观测编码后计量，超限在事务提交前拒绝。typed 与最终 Raw 预算只排除规范空筛选的固定成员开销；非空值完整计入 4 MiB。配置 PUT 专属正文预算在原 1 MiB 上增加规范空成员及逗号的精确编码长度，其他入口不变。客户端把本机完整事实与本批 wire 投影分开，以条数、Go JSON 存储编码和完整请求编码同时选择连续前缀。固定保留 taskTagFilter 的有界摘要及原优先真实未完成或失败停止核验，其余项（包括全局 native）按持久化 recordId 游标轮转；匹配接纳后才按源记录身份清理失败，且仅当前 generation 的捕获推进游标。未知结果、未发送失败和原停止归属继续留在本机检查点，目标接纳与责任登记不受单批名额阻挡。本机表示与应用机制由[Worker 设计](daynight-worker.md#云端接收与本机提交)拥有。观测项总数最多 1030，除 mode、archiveSessions、enableSudoCleanup、enableWindowsProcessCleanup 和 taskTagFilter 外的项最多 1025；五种项各有一个独立名额，不挤占原项。未协商扩展项的响应省略对应项；规范化 JSON 的总字节预算仍独立适用。

enableSudoCleanup 观察项沿用原 state、targetRevision 与 boolean/null appliedValue；没有该项表示本批未观察，而不是实际关闭。服务端不会替未认识此字段的 Worker 生成应用项。服务端仍整体替换本次 observation，不聚合此前各批 items，也不引入 completeness 字段。应用观测保留本批服务器接纳时间；机器报告可以更新，而应用结果仍是此前已接纳的整批状态。消费者将当前目标与所报每项目标版本比较，保持旧实际值和明确等待/失败含义；缺少当前目标项表示本批未观察，不能复用另一批结果宣称成功。

配置与报告不再接收模式候选或模式观察；Worker 读取云端旧原始目标时，将 agentControlMode 和 toolPaths.herdr 作为未知成员完整保留，并从当前两工具的 known 投影排除。当前必需字段和已知值合法时继续协调；已存 pendingApplication:true 的 schema 10 目标在首次收到同一权威 GET 后也进入协调，提交后持久保存结果，重启仍须取得本进程的实际核验证据。只改变未知成员的后续版本保持原应用身份和在途工作，报告只包含当前 Worker 实际处理的项。完整 PUT 可明确移除退役字段。历史观察解码先恢复模式私有槽，再按原始位置恢复归档私有槽；公开投影移除模式项，保留归档能力的独立投影。

Daynight-Worker-Tool-Paths: 2 对报告、配置与详情必需，缺失或不匹配在业务调用前拒绝并提示升级；列表摘要不设门槛。成功响应回显版本。配置成功响应保留原始目标与未知字段并组合独立归档列，严格写入只接受两工具；配置协议 1/2 和 prompt 继续独立处理。

Daynight-Worker-Platform-Task-Mode: 1 独立协商目标和应用项。HTTP 的 Raw 与 typed 投影都只输出所选字段：新视图为枚举，旧视图为布尔且 only 投影为 true。两个应用 kind 不相互合成，旧视图隐藏新应用项，新视图隐藏旧布尔项。报告仍整体替换观察，因此旧报告会撤回新支持证据，保存不创造观察。配置 GET/HEAD/PUT、报告和详情复用能力校验与回显；CORS 同时允许发送和读取能力头。配置报告的 bootstrap 固定解析旧布尔并转换为领域枚举，服务层内部重新规范化使用领域表示，不再次套用外部候选格式。

Daynight-Worker-Archive-Sessions: 1 独立协商布尔目标与同名观测项。协议 codec 对未协商请求保留原闭合投影，确认后严格解析布尔值；服务回显能力，重复或无效头在业务调用前拒绝。旧 PUT 的值来自锁内实际列而非旧 GET。归档观测的私有槽与 mode 槽都按保存的序号还原，替换报告不保留未提供的旧证据。

路径验证只处理远端语法，不能查询服务端文件或使用服务本机 filepath 规则替代 Worker 平台。工具观察包含目标、新准入 actual、candidate 和有界 activeSelections；它不进入 native appliedValue，服务验证不会产生执行资格。完整字段及降级规则由[快照协议](../spec/daynight-worker-snapshots.md#工具路径观察)拥有。

旧协议不接受新正文，旧回执不附加配置字段；配置协议 1 遵循完整扩展结构。协议 2 的有限个人 prompt 批次在原报告提交后独立读取，机制由[个人 prompt 设计](worker-prompts.md#配置报告)拥有。工具、归档与平台任务规则能力仅影响配置交换，不成为 Task/claim 或 inventory 的准入条件；标签筛选的观察和 claim 准入遵循上述独立规则。

## Web 字段与保存

`ConfigurationNativeFields` 的全局 Agent、项目 Agent、Model 模式和 Args 模式共用 [NativeSelect](native-select.md) 的 `form`/`fill` 变体，表单高度为 38px。公共组件拥有箭头、文字留白、焦点和禁用外观，配置样式仅安排表单网格与外部布局。选项、继承与自定义联动、重置、反馈和异步保存由配置编辑器拥有。

配置表单不编辑托管模式或第三工具。旧字段显示在原始目标中，用户明确保存完整候选时才替换；后台读取、编辑与重置不改写目标。

“工具启动路径 / Tool launch paths”区域及软件版本快捷入口使用同一名称。配置面板从两项工具的当前观测汇总错误、未确认、等待应用、检查中、未检查和已应用状态；未使用自动工具的错误仍显示具体原因。整体配置成功继续要求所有可编辑工具目标均有当前应用证明，单个工具失败不推断为整个 Worker 不可运行。

配置端点使用专用源文本解码，验证 JSON 语法、重复解码键及深度，再从同一响应派生已知视图和完整目标基底。已知视图供表单校验，未知子树保留为已验证 JSON 片段；合并按已知叶子及 projectId 对齐实体，明确删除项目时删除其全部内容。提交冻结原 revision 与合并后的完整 value，回执及未知结果读取按完整语义比较，对象无序、数组有序、数字无损比较；已知项目按 ID 对齐。旧模式及第三工具只在明确保存新候选时移除。后台读取不能替换已有草稿的源基底，确认回执才建立新的提交基底。

平台任务规则主动请求独立能力并核对响应回显；解析器按响应选择枚举或旧布尔投影，完整候选只包含该视图的字段。运行设置以 NativeSelect 编辑规则，使用实际 Worker 平台命名并显示选中说明。最新接纳观察中的真实 platformTaskMode 项决定新启用 only 的资格，保存与派发时重新核查；保留或退出已有 only 不依赖该项。目标、草稿和真实应用分开，能力或观察变化不替换其他编辑；冲突保留草稿，取消恢复目标。旧投影不证明严格模式支持或应用。

任务标签筛选的直接目标和摘要应用项由配置解析器识别。编辑器维护名称、匹配方式与待输入草稿，按标签名称规则校验并比较筛选语义；保存将已知子字段合并进原始基底，保留未知兄弟，回执同时核对筛选语义和未知内容。缺少支持观察时仅允许保留原筛选或清空，并在派发前重新检查；观察更新不替换草稿。Panel 的独立 WebCrypto hook 按账号、Worker 和规范化目标语义隔离异步摘要结果，状态汇总和反馈使用该结果，保存确认不等待摘要。摘要失败只影响应用状态核对；未知字段和未知观察仍阻止汇总误报全部应用。

归档开关沿用运行设置的原生 checkbox、关联帮助和配置反馈。服务回显确认目标字段，最新观察项的存在独立确定 Worker 是否支持编辑；观察版本落后不撤销编辑资格。草稿和基线保留 false 与未提交修改，能力变化不伪造目标或实际值。保存其他字段时以基线保留不可编辑的归档目标，恢复支持后继续原草稿；未知结果必须核对同版本完整目标。

Web 配置编辑器持有提交的账号、Worker、操作、目标版本与草稿快照，并分别记录实际派发和可信响应。准备和准入等待使用操作自己的取消信号；暂停时本地保存分类与 pending 收尾不依赖远程准入。已确认、已派发但未确认、未派发及明确拒绝分别保留其原有结果含义，不把取消解释为服务端回滚。

配置资源安装和必要的后续读取由原编辑器持有并受账号、资源、操作与准入检查；延迟发布可在临时暂停解除后继续，并在被取代或销毁时取消且接收错误。编辑器以内存中的草稿 revision 区分提交后输入，即使新输入恢复到相同值也不能被旧结果清除；新保存仍需原有目标版本、权限和新鲜度检查。暂停期间不自动 GET 或重放 PUT。本地收尾与远程发布分离的选择及其代价见[决策记录](../../.agents/notes/implemented/bug-fix/2026-11-11-worker-configuration-save-settlement.md)。

## 验证边界

真实 PostgreSQL 验证并发导入、独立 CAS、相同值、规范化比较、权限变化、事务失败与持久状态，包括 sudo 字段省略保留、显式关闭及版本冲突。HTTP 验证认证、Origin、查询/方法拒绝、精确字段、布尔 false、版本和原格式。迁移验证历史 preferPlatformSpecificTasks 补值保持版本与时间，以及布尔转 platformTaskMode 推进版本与时间、删除旧字段、保留未知兄弟和未初始化事实。enableSudoCleanup 补值推进版本与时间，已存在字段及未初始化目标不变；涉及推进的 revision 耗尽时整体回滚。迁移均不改变观测、Worker 遥测或任务数据，也不为未初始化 Worker 生成目标。归档列迁移及新建默认、并发旧写入、目标 CAS、回读、观察替换和未协商投影均使用其实际存储与协议边界验证。

Web 模块测试验证继承与自定义、保存/拒绝/未知结果及后台复核中的草稿连续性。`tests/navigation/worker-configuration-arrow.browser.ts` 在生产 App 的受控 API fixture 中检查公共箭头、表单几何、禁用和 forced-colors。箭头回归由 `team-playwright.config.ts` 的 `team-preference` 项目执行；公共组件矩阵由[公共选择组件](native-select.md#验证责任)拥有。

服务端验证输入和账号归属，不能证明客户端真正准备了仓库或停止了进程；这些结果由本机观察并上报。配置接入不依赖任务清单同步，不改变现有任务恢复行为。
