# 公共 Markdown 渲染

## 范围

Task、Goal 描述、Task Steps、Markdown 附件的内嵌与独立阅读、Discussion、Session、PR 描述和 Assistant Task 提案共享 Markdown 渲染能力。API、CLI 和存储保留原始 Markdown 字符串。

## 公共阅读行为

正文、标题、代码和表格遵循[公共字号标准](../ui-design.md#web-typography)；正文在不同阅读入口和宽度使用相同阅读角色，代码与表格使用界面角色。

各入口按 CommonMark/GFM 展示标题、段落、强调、列表、任务列表、引用、行内代码、代码块、表格、链接、图片和脚注。文档保留 CommonMark 软换行语义，聊天中的单换行可见；换行不改变代码或图片绑定位置。普通代码保持代码块；只有标记为 `mermaid` 的 fenced code block 进入图表渲染。原始 HTML 作为文本展示，危险 URL 不执行。

多个实例的脚注 ID、引用、返回链接及 `aria-describedby` 指向各自实例，脚注标签与返回提示随应用语言变化。表格以保留原生语义的可聚焦滚动区展示，具有当前语言的可访问名称。表格、宽代码块及图表局部横向滚动，在桌面及 320px 窄屏下不撑宽页面；键盘可访问图表、表格和代码滚动区，且各区均有可访问名称。

Task 和 Goal 描述分别以所属附件根解析相对资源，Steps 使用所属任务根；附件以实际文件目录解析且不能越过附件根。普通附件链接的导航、修饰键和 query/hash 语义及图片暂停、失败和重试由[附件要求](daynight-task-attachments.md#web-管理与预览)拥有。暂停不发起新的来源请求，重试不重建阅读状态。组件自带公共样式，独立阅读无需页面外壳样式。

聊天仅允许 HTTP(S)、mailto 和本实例生成的脚注链接，外链在新标签打开并使用 `noopener noreferrer`。Discussion、PR 描述及提案不读取原始图片来源，以替代内容展示图片。Session 由所属功能核验正文摘要、revision、位置及图片绑定，并管理资源权限和生命周期；无权或无效绑定不读取原始来源。链接中的图片动作位于链接之外，并保持原有顺序。原始 HTML 及代码中的伪图片不读取来源。

## Markdown 图表

语言标记为 `mermaid` 的 fenced code block 支持以下 15 类稳定图表：流程图
（`flowchart`、`graph`、`flowchart-elk`）、时序图 `sequenceDiagram`、类图
`classDiagram`、状态图 `stateDiagram` / `stateDiagram-v2`、实体关系图
`erDiagram`、甘特图 `gantt`、用户旅程 `journey`、饼图 `pie`、象限图
`quadrantChart`、需求图 `requirementDiagram`、XY 图 `xychart`、块图 `block`、
数据包图 `packet`、看板 `kanban` 和事件建模 `eventmodeling`。标题、中文和英文
标签、关系及数据保持各类型的语义；默认流程图使用 Dagre，显式 `flowchart-elk`
使用内置 ELK。实验性或 beta 类型、GitGraph、ZenUML 和第三方插件不纳入支持。
同一文档可混排多张图，流程图的节点、箭头、条件分支及 TD/LR 方向保持可读；
普通 Markdown、代码块、链接及相对图片保持原有语义。

每个图块独立显示当前语言的加载状态、结果、错误和源码入口。无效语法、不支持
的类型、受限资源、配置、超限或渲染失败只影响所属图块，源码保持可检查，其他
正文和后续合法图继续可读。图块最多接受 50,000 个 UTF-16 代码单元；各类型的
节点、边、参与者、消息、任务、分组、数据点或其他结构分别受 500 项限制，
具体计数规则见[设计](../design/shared-markdown.md#mermaid-图表)。
Block 的空间展开、跨度和列数在构建前受限；绘制前根据实际块层级估算的尺寸计算
调用量另以 50,000 次为上限，超限显示局部复杂度错误并保留源码。Gantt 的日期计算
另受每次读取累计 50,000 次实际日历步进限制。普通形状 metadata 和标签中的
字面量 `@{` 按语法处理；图片资源或 `imageSquare` 节点在绘制前拒绝，显示当前语言的资源不可用
提示和源码，不得阻塞后续图块。

图表采用当前浅色阅读配色，标签、关系和数据保持可辨。宽图保持可阅读的文字
尺寸，通过可聚焦的图块局部横向滚动访问；320px 窄屏下页面、阅读容器、标题和
固定操作不得被图形撑宽或遮挡。切换任务或附件、更新内容、关闭或重新打开入口
后，只显示当前内容；旧异步结果不得覆盖新图或产生重复图形，被释放的图块不得留下临时 DOM
或对象 URL。

图表内容不能执行任意脚本或注册可执行点击行为。配置指令和 frontmatter 不能
改写应用的安全设置及主题，须显示局部错误和源码。结果作为静态 SVG 图片展示，
保持原有 Markdown 的 HTML 转义与 URL 策略；该机制不承诺完整网络隔离。
