# Web 语言运行时与界面接入设计

状态：生产 `main.tsx`、公开页面、`AuthenticatedApp` 与现有全部第一方组件接入 `packages/daynight-web/src/i18n/`，提供英语与简体中文界面，包括居中 `TaskDetailDialog`。语言运行时与功能接入已实现；原定向生产浏览器场景及其执行入口已移除。[语言需求](../spec/daynight-web-i18n.md)拥有完整 L1–L10 条件，[看板架构](daynight-web.md)继续拥有业务数据、图和生命周期。

## 运行时结构

语言目录、React Context 和原生 `Intl` 共同提供展示能力，两个目录随 Web 构建一同发布。运行时没有翻译服务、语言资源请求、模板字符串解析器或通用状态框架。选型的比较、成本及重审条件见[决策记录](../../.agents/notes/archived/architecture/2026-10-22-web-locale-runtime.md)。

```text
packages/daynight-web/
  src/i18n/
    locale.ts              语言类型、浏览器匹配与初始偏好读取
    messages.ts            公共消息、领域契约与目录选择
    messages/en.ts         英语目录
    messages/zh-CN.ts      简体中文目录
    messages/workspace.ts  导航、页面标题、项目、统计、页签与偏好消息
    messages/graph.ts      图、节点、依赖与 React Flow 消息
    messages/inspection.ts 详情、PR、附件与预览消息
    messages/setup.ts      日常使用引导、成功标志与复制反馈消息
    messages/landing.ts    公开推广、交互演示、身份提示与元数据消息
    formats.ts             按语言缓存的 Intl 格式化器
    LocaleProvider.tsx     展示值、偏好错误及保存操作
    LanguageSelector.tsx   共用原生选择器、错误提示与重试
  tests/helpers/renderWithLocale.tsx  显式语言渲染 helper
```

生产 Application 的公开与认证分支共享常驻 LocaleProvider。messages.landing 拥有
推广、示例文档与记录、FAQ、公开身份提示和元数据；演示的稳定身份与本地选择不依赖
语言，切换保留状态与焦点。[公开入口设计](daynight-landing.md)拥有具体组合。
[AuthenticatedApp](daynight-auth.md) 的 messages.auth 完整英语/简体中文契约拥有
登录、设备授权、账户、项目创建、成员、邀请、令牌及工作空间 Worker 路由文案。
messages.workers 拥有 Worker 列表/详情、观测状态、资源/版本、时间、同步失败与可访问名称；其中 messages.workers.configuration 拥有配置字段、覆盖方式、目标与实际结果、逐项诊断、草稿校验、保存冲突和未知结果核对文案。
入口在绘制前设置当前语言及与路径对应的推广页、指南或鉴权加载标题；后续页面元数据、
路由与会话状态按当前目录更新。
身份变化释放用户内容，但不重建语言 Provider。先前真实 UniAuth 生产验收证据只属于其对应源码与浏览器环境，不能证明当前版本。

## 初始语言与偏好

`Locale` 仅允许 `en` 与 `zh-CN`。`parseLocale(value)` 只接受这两个明确的保存值，其余输入抛出错误。`resolveBrowserLocale({ languages, language })` 按有序浏览器列表选择第一个 `en` 或 `zh` 语言族；没有列表时读取单一语言。中文地区和文字变体统一返回 `zh-CN`，均不支持时返回 `en`。

`resolveInitialLocale()` 接受可注入的 `getStorage` 和浏览器语言信息，默认读取当前浏览器环境。存储读取与自动检测的结果是：

```ts
type InitialLocale = {
  locale: Locale;
  issue: LocaleIssue | null;
};

type LocaleIssue = {
  readonly kind: 'read' | 'invalid' | 'write';
  readonly cause: unknown;
};
```

它优先读取当前 origin 的 `daynight.web.locale`，有效值覆盖浏览器偏好；没有保存值时自动检测，检测本身不写入存储。读取失败或保存值无效时保留对应 issue，再按浏览器规则选择当前语言。`getStorage` 是函数，使获取 localStorage 本身抛出的错误也进入读取或写入失败状态。

`LocaleStorage` 只要求 `getItem` 与 `setItem`。保存的是原始字符串 `en` 或 `zh-CN`，与 `useProjectViewPreferences.ts` 的每项目 JSON 记录独立，不扩展原有格式，不需要数据迁移。语言既不进入 URL，也不参与服务配置、API 或数据库。

## Provider 与订阅

`LocaleProvider` 要求调用方显式传入 `initial: InitialLocale`，可选传入 `getStorage`。这样，入口可以在渲染前解析一次语言，测试也能提供确定的初始状态和故障存储。生产 `main.tsx` 在 `createRoot()` 前完成解析并设置文档信息，再将 `LocaleProvider` 常驻应用根部；独立入口与测试使用相同的显式挂载方式。

展示与偏好通过专用 hooks 访问：

| Hook | 内容与职责 |
|---|---|
| `useI18n()` | 当前 `locale`、`messages` 与 `format`；供文案和格式调用方订阅。 |
| `useLocaleCommands()` | `selectLocale` 与 `retrySave`；供只需要执行动作的调用方使用。 |
| `useLocalePreference()` | 当前 `issue` 及相同保存动作；供选择器和提示使用。 |

Context 的缺省值明确表示未挂载，缺少 Provider 时 hooks 抛出错误。独立页面、原型和测试必须显式选择其 Provider，避免隐式使用机器语言或某个缺省目录。

Provider 使用一份当前 issue 状态，初始值来自 `initial.issue`。选择语言时先更新本页展示，再尝试保存；失败保留选择并将 issue 更新为 `write`，保留原始 `cause`。`retrySave()` 保存当前语言。任意保存成功均将 issue 清为 `null`，包括启动时产生的读取或无效值错误。展示上下文按 locale 保持稳定，单独更新保存错误不替换其消息与格式化器。

`LanguageSelector` 包含可访问名称为 `语言 / Language` 的原生 `select`，不显示独立标签，选项使用 `English` 与 `简体中文`。共享样式为文本和绘制的箭头分别预留空间，箭头距右边框保持固定间距；各入口复用这一布局。每个实例有独立标识，多个实例共享 Provider。错误提示按当前语言从目录映射，不显示原始异常；出现错误时提供本地化的重试保存操作。原生控件保持键盘与焦点行为，语言变化不重建选择器。

## 消息与格式化

`Messages` 是两个目录共同满足的 TypeScript 契约。`common` 拥有 `retrySave`、按 `TaskStatus` 索引的 `status` 和 `requestId`；`language` 拥有标签、选项和保存错误；`workspace`、`graph` 与 `inspection` 分别拥有导航/项目、图和详情/PR/附件消息；
`auth` 拥有登录、账户、项目创建、成员、邀请、令牌、工作空间路由及管理对话框消息；`workers` 拥有账号级 Worker 观测消息；`setup` 拥有 MCP 三步和 CLI 五步的说明、客户端选择、成功标志、Agent 请求示例、链接及复制反馈。组件通过 `useI18n()` 取得领域消息、公共状态与格式化器；相同 task 状态和请求 ID 标签不在领域中重复定义。

固定文本使用字符串；动态文本使用带具名参数的函数，返回完整句子，目录负责语序、标点、单位和复数。调用方不拼接零散英语片段，不提供缺失键时使用另一种语言的静默替代。产品计数消息及格式测试覆盖 0、1 与多项；测试专用消息不进入产品目录。

Session 的指定操作和活动标签从已有英语目录导出只读子集，只在[对应组件位置](task-session-protocol.md#session-view-的阅读与输入状态)读取。该映射是显式产品术语规则，不是缺失翻译时的 fallback。组件保留 LocaleProvider 订阅及周围本地化消息，固定文本使用局部 `lang="en"`；不修改语言偏好、整页语言或共享中文消息值。`SessionDisplayMenu` 的标题、两个模式名、偏好 issue 和保存重试，以及 Conversation 空态都由 `useSessionMessages` 按当前 locale 提供，不进入固定英语子集。偏好只存 mode 与 issue 类别，错误在 render 时翻译；语言改变不创建偏好 store、Session client 或操作。

`getFormats(locale)` 按两种 locale 缓存 `Intl.DateTimeFormat`、`Intl.NumberFormat` 和 `Intl.PluralRules`，提供 `date`、`time`、`dateTime`、`number`、`bytes` 与 `plural`。日期输入接受 `Date`、字符串或数字，沿用本地时区与 `hour12: false`；格式改变不修改输入时间戳。数字按语言分组；字节以精确值加 `B` 展示，不转换为会丢失精度的近似容量。格式化接口保留原生 `Intl` 的输入语义，不增加替代缺失数据的默认值；日期无效时由原生格式化器抛出错误。Worker 的 presentation helper 独立以当前 locale 的 Intl.NumberFormat 将严格 bytes 输入缩放为 B/KiB/MiB/GiB 等 IEC 读数，保留 API 精确值，不改变 getFormats.bytes 的精确 B 行为；相对上报时间使用服务端锚定时间与 Intl.RelativeTimeFormat。

## 生产界面与生命周期

生产入口在 `createRoot()` 前执行初始解析，再把常驻 Provider 放在应用根部。首屏 HTML `lang` 和标题使用解析结果，后续导航与切换同步更新。Provider 不以 locale 作为 `key`，领域组件也不使用 locale 重置实例。

主界面导航与独立 `TaskDetailPage` 共用 `LanguageSelector`。共享 `ManagementDialog` 和 `CreateProjectDialog` 继承当前语言，不渲染选择器或其偏好提示与重试；页面入口继续拥有偏好反馈。普通和全屏图浮层均不渲染自己的选择器或偏好反馈。居中 `TaskDetailDialog` 通过同一个 `LocaleProvider` 订阅应用当前语言，其顶栏保留任务标题、全屏、“…”菜单和关闭入口，新标签链接位于“…”菜单；当前状态菜单与平台切换位于标题下的公共状态行。详情打开时底层页面继续处于 `inert`，模态入口使用既有焦点圈定、Escape 分层和关闭后恢复机制；独立完整详情页保留普通浏览器键盘行为，内部确认窗仍各自拥有模态交互。图浮层标题、关闭、全屏及图控件使用同一目录，语言变化保留当前打开状态、同一图实例和焦点。

Worker 页面订阅 messages.workers，状态存为结构化观测而非已翻译字符串。语言变化更新资源、版本、时间和 last-confirmed 文案，不改变 Worker ID、hook 的读取依赖、冻结状态或单调锚点，不额外发起请求。普通任务状态和 phase 复用已有目录；机器名、路径和实际版本原样显示。

项目摘要与附件请求继续由资源 ID、调度和原有操作触发，详情按摘要业务版本、打开及恢复需要读取；时钟 receipt 不单独重读未变化正文。locale 不进入业务 hook 的请求、取消或订阅依赖；上传、覆盖、删除和刷新期间切换只更新展示。附件预览继续使用原来的 key、URL、DOM 和 iframe 身份，输入与已选文件保持不变。附件删除确认订阅共享语言状态，但不复制语言选择器或偏好提示；页面的既有入口和反馈保留。

图结构与几何继续只依赖 `index/rootId` 和原有布局输入。memoized 的 `TaskNode`、`ChainRow` 和 `DependencyEdges` 在内部订阅展示 Context，更新文案与 ARIA，同时保留节点数据、边路径、视口和初始定位机制。依赖边的昂贵绘制分解以 geometry 为 memo 依赖，语言变化更新可访问文本，同时保留 canonical 路线坐标与绘制片段。React Flow 的无障碍配置由当前消息生成；英文文案必须适配现有节点尺寸。

错误与通知状态保存语义，渲染时翻译。API client 继续返回结构化 `ApiError`、图规模详情和 request ID；服务原始正文不进入安全提示。项目刷新后所选任务被移除的通知保存为 `{ kind: 'selected-task-removed' }`，渲染时读取当前目录。附件异步结果沿用语义状态，完成时以当前语言呈现。既有每项目浏览偏好错误沿用自身的状态与存储格式，由展示层映射当前语言。

语言切换保留项目外层分区、内层任务页签、筛选、打开的图浮层、各自滚动、图平移/缩放、全屏、详情、PR 页码、预览和输入。
概览与任务列表的可访问名称和响应式方向来自同一目录，翻译变化不重新挂载已访问的任务区，也不改变当前滚动 owner。
鉴权界面还保留当前身份、成员观察版本、模态、一次性秘密及进行中的管理请求；
校验、登出/会话、邀请清理和复制通知保存语义值，渲染时查询当前目录。它不主动重置浏览位置；英文自然换行的高度变化需要浏览器几何检查。独立任务徽标按当前负责人统计未完成的范围内单成员 Task；任务链徽标按当前负责人统计范围内含匹配未完成成员的普通分量，并使用独立的中英文提示；Goal 徽标按自身负责人统计非终态 Goal；数字继续通过 `format.number` 格式化，提示使用目录中的“未完成 Goal 数” / “Unfinished Goal count”。状态筛选及语言切换不改变其统计范围，机制见 [Web 设计](daynight-web.md)。

`SetupGuidePage` 订阅同一 `messages.setup`，复制状态保存成功/失败语义；命令维护完整字符串，目录提供本地化的说明、项目名示例及 Agent 请求。语言变化保留页面路由、步骤与 MCP 客户端选择，推进复制 generation 并清理旧提示，旧调用的完成不会覆盖当前语言或新复制状态。客户端变化和卸载也使旧复制结果失效。浮动提示不改变步骤尺寸。指南在认证组件之外使用同一 locale Provider，语言切换及整个阅读生命周期均不发起任何 API 请求。

## 验证与证据归属

基础测试提供显式 `renderWithLocale` helper、可控 storage 和隔离组件 fixture，覆盖浏览器匹配、显式选择优先、自动检测不保存、读写故障、无效值、成功清除错误、多个选择器共享状态、缺少 Provider 失败、完整目录与格式化。`pnpm web:typecheck`、`pnpm web:test` 与 `pnpm web:build` 执行模块检查，覆盖率门槛由 `pnpm web:test` 检查；`pnpm web:test:browser` 单独运行模块浏览器配置。

组件测试验证领域文案、已显示错误重翻译、待完成附件操作期间切换、DOM/预览身份和浏览状态保持。现有组件测试与 standalone 入口显式使用 Provider。受控浏览器 fixture 验证两种语言的键盘操作、窄屏布局及实际焦点、选区和视口；真实服务连接由独立产品组合验证承担。测试结果绑定实际源码和环境，模拟响应与本地浏览器结果不能证明真实服务或部署行为。

原生产浏览器入口及下列三个场景已移除；其方法和结果仅作为对应源码的历史证据，不代表当前自动化：

| 历史场景 | 验证内容 |
|---|---|
| `language-startup-preferences` | 浏览器语言、显式保存、重载与路由、标题和 HTML `lang`，以及用户原始数据。 |
| `language-state-preservation` | 检查图节点/边/视口、选择及全屏切换；检查全屏与模态焦点，并验证详情页签往返保留 PR 页码、附件输入和 iframe 身份及内容；分别挂起上传、覆盖和删除，验证待完成状态和每项写入次数。 |
| `language-errors-and-narrow` | 读/无效值/写入故障与重试、真实隔离数据库故障下错误重译及相同 request ID，两种语言的 1440px/320px 图、对话框与附件布局；图的普通和全屏模式无局部语言入口及占位，长标题、关闭和图操作保持可访问。 |

原场景使用受监控页面与场景级 `en-US` 浏览器 locale，由单一 Playwright project 执行
一次、零 retry。需要精确比较语言切换前后业务请求数量的隔离阶段控制浏览器时钟，
排除独立项目定时器触发；原 `refresh-staleness` 单独验证周期刷新。滚动恢复以测试
进程的单调时钟观察实际 `scrollTop` 的连续稳定状态。原 native/container inventory、
容量入口与聚合器均已移除，其固定场景、运行结果和清理回执只属于原源码；当前仓库
不提供原 `pnpm web:acceptance` 一键入口。

完整生产验收仍须核对相同源码的真实嵌入式服务与生产容器证据，验证 L1–L10，包括首屏、持久保存、键盘操作、两种语言的 1440px/320px 视觉、错误恢复、业务请求数量和资源清理。当前模块测试和受控浏览器 fixture 不提供该完整入口或结果。原型、隔离组件、JSDOM 与本地浏览器各有其证据范围，不能替代真实服务和对应源码的生产验收；缺少实际证据时不能宣称完整通过。
