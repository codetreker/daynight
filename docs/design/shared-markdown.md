# 公共 Markdown 渲染设计

[要求](../spec/shared-markdown.md)拥有公共渲染和图表的可见行为。`MarkdownView` 位于 `packages/daynight-web/src/ui/markdown/`，提供 document 和 chat 资源模式；Task、Goal、Steps 和附件通过 `MarkdownContent` 适配，Discussion、Session、PR 描述和提案通过同目录的 `ChatMarkdown` 薄适配器使用公共内核。

## 模块与资源

`MarkdownView` 固定 `react-markdown` 与 GFM，拥有公共节点、实例上下文、脚注和公共 CSS。稳定的节点组件处理链接、图片、脚注标题、表格与代码块；只有 Mermaid fenced block 交给图表模块。组件直接导入公共排版、代码、表格、脚注和图表样式，场景通过 `--markdown-*` 参数保留间距、颜色和字重差异。正文、标题、代码、表格及 Daynight 控制的 Mermaid 字号遵循[公共字号标准](../spec/web-typography.md)；描述卡片、消息气泡及附件图片错误与重试外壳由各 feature 拥有。公共 `Messages.markdown` 提供表格、脚注和 Mermaid 双语文案。

调用者提供 document 资源模式：`paused`、`resolveUrl(sourceUrl)`、可选 `onLinkClick(sourceUrl, event)` 与 `renderImage({sourceUrl, url, alt, title})`。`sourceUrl` 是解析器 URI normalize 后、业务转换前的值；转换结果再经过 `defaultUrlTransform`，拒绝结果不能由来源地址恢复为图片加载地址。每次处理使用 WeakMap 将原 HAST 节点与来源关联，避免从预览地址反推附件路径。公共层不读取业务数据、权限或凭据。

实例通过稳定前缀隔离脚注 ID、heading 和 `aria-describedby`。生成的脚注引用和返回链接直接使用本实例 fragment，不经过附件导航；普通链接保留业务转换、安全检查和真实 `href`。暂停时非 fragment 链接不可激活。表格的 `role=region`、可访问名称与 `tabIndex=0` 使局部横向滚动可由键盘使用。

`MarkdownContent` 以来源 URL 分类附件相对图片，使用根或文件目录构造资源规则；附件路径保护、导航、图片请求、失败与重试继续由[附件设计](daynight-task-attachments.md#web-文件树与预览)拥有。公共节点与 components map 保持稳定，普通父级更新与语言切换不以回调身份重建图块或图片。

聊天模式以 AST text 子节点实现可见软换行，保留原文与图片位置。它只放行 HTTP(S)、mailto 和本实例生成的脚注链接，不向图片回调提供原始 URL。无图片能力的调用者显示不可用；受控模式先核验每个给定 UTF-16 半开范围是否对应真实 image 或有 definition 的 imageReference，再允许整组回调；任一无效时整组不呈现并在提交后通知。未绑定节点仍可存在并显示不可用。链接内绘制图片视觉，链接后按 AST 顺序绘制动作，拒绝链接也不丢失动作。Session 的摘要、revision、scope、资源准入及 frame 生命周期仍由 [Session 图片设计](session-image-browser.md#markdown-映射与链接图片)拥有，公共位置核验不授予访问资格。

## Mermaid 图表

`MarkdownView` 将 `mermaid` fenced block 交给共享图表组件，普通 Markdown
无需等待 Mermaid 12.2.0 的动态加载。文档来源以任务根或附件文件目录解析，聊天资源遵守自身准入，不改变
存储格式或权限。显式稳定类型表约束[要求](../spec/shared-markdown.md#markdown-图表)中的
15 类入口和 SDK 识别、解析及绘制 ID；SDK 新增类型不会自动开放。默认流程图使用
Dagre，显式 `flowchart-elk` 使用 SDK 内置布局，其他类型使用各自布局。

SDK 初始化、类型判定、语义预检和绘制共享一个串行队列，避免全局配置互相覆盖。
配置固定 `strict`、应用主题和关闭可配置 HTML labels；拒绝来源中的配置指令及
frontmatter。源码上限为 50,000 个 UTF-16 代码单元。固定版本的 parser DB 提供
语义预算，每项上限 500：流程图、类图、状态图、ER 和需求图分别计节点及边；
时序图分别计参与者及消息/注释/控制标记；Gantt 与 Journey 分别计任务和分组，
Journey 另计参与者且只调用一次有派生副作用的任务 getter；饼图计分区，象限图计
点；XY 分别计 plot、全部数据点及分类轴 categories；Block 计展开后的块和边；
Packet 计行和全部字段；Kanban 计列与卡片；Event Modeling 分别计 box、swimlane
和 relation。异常 DB 结构作为兼容性错误暴露，而非默认为空。

Block 的 `space:N` 在 parser 建立层级时展开，因此先通过安全种子获取固定 SDK 的
lexer，在独立词法会话中检查空间展开总数、跨度和显式列数，避免大数分配；标签
和注释由同一 lexer 区分。解析后还按 SDK 实际绘制树估算 `setBlockSizes` 的调用量：
根的深度为 0 并计一次，深度为 d 的块计 2^d 次，合计上限为 50,000；超限在绘制前转为局部
复杂度错误。该固定版本对每个子节点递归两次，嵌套可能导致指数增长，仅限制块数
不足以约束该路径。估算依据真实层级而非源码或平面节点列表，仅限制尺寸计算调用，
不保证整个 parser 为线性或其同步工作可中断；解析仍受源码长度及展开预算约束。
SDK 升级须重新核对布局算法和预算。Gantt 的日期编译可能逐日循环，固定发布包通过 pnpm
补丁在根入口使用的 chunk 中对每次 `getTasks()` 的所有任务和编译 pass 累计
50,000 次实际日历步进，`clear()` 和读取入口重置预算。超限转为局部复杂度错误并
保留原始 cause；升级 SDK 时须重新验证补丁路径和真实 parser 合同。

流程图及可表达资源节点的类型在绘制前根据 parser 语义拒绝图片节点。图片绘制
等待的 `Image.decode()` 不能由阅读组件的 abort 中断；裸 `Promise.race` 也不能
终止 SDK 工作或释放其共享状态。预检保留普通形状 metadata、标签中的字面量
`@{` 和已解析的转义 key。图片节点支持需要可中断的隔离上下文及新的构建入口、
消息协议、CSP 和资源生命周期。

每次绘制使用唯一 ID 和可测量的离屏容器，成功或失败均清理，隐藏页签不会造成
零尺寸。返回 SVG 的根 `viewBox` 必须有有限且为正的宽高，应用以其设置固有尺寸并
移除根 `max-width` 收缩样式。结果通过 Blob URL 和原生 `img` 展示，不插入阅读
DOM，也不调用 `bindFunctions`。Event Modeling 的合法 XHTML 标签保留在静态图片中。
临时绘图 DOM、自定义样式资源和普通 Markdown 外部图片仍可能产生网络请求，该
机制不提供网络隔离。

图块拥有当前语言的状态、源码和图片资源。异步结果绑定来源与挂载生命周期；内容
变化立即停止呈现旧结果，晚到事件不能改写当前图块，替换和卸载时释放对象 URL。
模块级 renderer 身份稳定，父组件更新不会重建整个阅读树。可聚焦且具备可访问
名称的局部滚动区域保留自然尺寸和键盘阅读；320px 下不撑宽整体页面，概览及附件
正文保留纵向滚动所有权。标签、关系及数据的最终绘制须由真实浏览器验证。原有
[流程图决策](../../.agents/notes/archived/feature/2026-10-24-markdown-flowcharts.md)
及[稳定类型决策](../../.agents/notes/implemented/feature/2026-11-05-stable-mermaid-diagrams.md)
记录取舍。


## 验证

真实解析器测试覆盖文档与聊天换行、语法、脚注隔离、安全 URL、图片范围与表格；附件集成测试覆盖根、目录、导航、暂停与单图重试，Session 测试覆盖绑定、资源准入与 frame 生命周期。图表测试覆盖真实 SDK 类型、预算、队列及资源生命周期；真实浏览器验证图像绘制、双语和窄屏局部滚动。受控绘图测试不能代替真实 SDK 与浏览器绘制。
