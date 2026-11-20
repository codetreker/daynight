# 公共选择控件呈现

## 职责与依赖

`packages/daynight-web/src/ui/selection-control/` 拥有公共展示参数、无状态 `SelectTrigger` 和装饰箭头。`selection-control.css` 是 `--selection-control-*` 参数、公共展示标识及自定义入口皮肤的唯一所有者。`src/ui/native-select/NativeSelect.tsx` 仍是 Web 原生选择控件的唯一生产声明入口，直接导入的 `native-select.css` 独占原生内部控件与箭头选择器，并引用公共参数。页面通过相对路径导入组件，提供选项、值、事件、权限和业务状态。公共层不依赖认证外壳、API、语言 Provider 或 Session。

原生 `select` 保留浏览器的表单校验、键盘与触摸选择、焦点和多选行为。公共层没有内部选中状态、请求、存储、定时器或自建弹层；箭头只是装饰。采用这一结构的原因及此前局部箭头决策见[决策记录](../../.agents/notes/implemented/architecture/2026-11-14-shared-native-select.md)。配色与一般交互规则由 [UI 原则](../ui-design.md)拥有。

## 使用接口

```tsx
import { NativeSelect } from '../../ui/native-select/NativeSelect';

<label htmlFor="client">Client</label>
<NativeSelect id="client" density="form" value={client}
  onChange={(event) => onClientChange(event.currentTarget.value)}>
  <option value="codex">Codex</option>
  <option value="claude">Claude Code</option>
</NativeSelect>
```

组件接受 `ComponentPropsWithRef<'select'>` 的原生属性，排除 `className` 和 `style`，另提供以下展示属性：

| 属性 | 取值与默认值 | 职责 |
| --- | --- | --- |
| `density` | `compact`、`filter`、`form`；默认 `form` | 选择公共高度；文字使用共享 14px 档 |
| `layout` | `content`、`fill`；默认 `content` | 按内容占位或填满可用宽度 |
| `focusTone` | `default`、`task`；默认 `default` | 普通焦点或 Task/status 焦点颜色 |
| `touchMode` | `none`、`responsive`、`responsive-target`、`container`；默认 `none` | 显式选择触控尺寸规则 |
| `pending` | 布尔值；默认 `false` | 呈现调用者已确定的待定边框 |
| `wrapperClassName` | 可静态解析的 class token 列表 | 外部宽度、所在行、flex/grid 占位和外边距 |

`value`、`defaultValue`、`children`、`multiple`、数字 `size`、`disabled`、`required`、`name`、`form`、`id`、`aria-*`、`data-*`、原生事件与 React 19 `ref` 直接作用于真实 `HTMLSelectElement`。组件不转换空字符串、数字或数组，不增加占位项，不推断首选项，也不捕获或合成 `change`。事件的 `target` 和 `currentTarget` 保持真实控件身份。

调用者继续拥有动态目录缺失项、单独禁用选项、确认与取消恢复、筛选草稿、异步提交及失败恢复。待定态不意味着禁用或成功；`aria-invalid` 来自调用者的实际校验。需要无选中状态时，调用者通过真实 ref 在自己的布局 effect 中设置 `selectedIndex=-1`，保持原选项集合。已有外层 `label` 可以包含公共组件，`htmlFor` 仍指向内部控件的 `id`。

`wrapperClassName` 必须是可静态解析的字符串 token 列表，支持字符串字面量及可解析的字面量组合；不能传入运行时计算的类名。对应 CSS 仅设置外部宽度、外边距及 flex/grid 占位，不得设置内部字体、背景、边框、padding、行高、箭头、焦点、禁用或触控尺寸，也不得添加伪元素箭头。页面选择公开展示属性来表达这些差异；固定列宽或网格位置属于页面布局。

## 自定义菜单入口

`SelectTrigger` 默认渲染真实 `button`，`as="summary"` 渲染真实 `summary` 并保持为 `details` 的直接子元素。区分元素的 props 类型透传真实 ref、ARIA 和事件；button 保留原生 `disabled`。组件排除任意 `className` 和 `style`，静态 `layoutClassName` 仅允许外部宽度、外边距及 flex/grid 定位。`children` 是入口内容，可选 `count` 由公共组件呈现徽标；完整可访问名称由调用者提供。

`density`、`touchMode`、`focusTone` 与 NativeSelect 同名概念一致。公共 host 使用 `selection-control` 标识及对应 data 属性。默认外观为白底、`#344258` 文字、1px `#dce0e8` 边框、6px 圆角、0 10px 内边距、8px 内容间距、系统字体、400 字重和 1.5 行高。内容宽度随文字与计数决定并受容器约束；长负责人省略且保留完整可访问名称。徽标使用共享 12px 档，通常为 18px 高，响应式放大后为 20px 高。箭头共用 10px 装饰路径。

调用者通过真实 `aria-expanded`、`aria-invalid`、禁用和公开 `pending` 提供状态。公共 owner 呈现中性 hover `#f0f3f7`、展开背景 `#eef1f8` 与边框 `#52649b`、禁用、错误和焦点；Task 焦点使用 3px 深色轮廓。summary marker 也由公共层隐藏。菜单 owner 继续管理开关、选中值、目录、网络、存储、定位和焦点恢复。

TaskAssigneeFilter 显式选择 AssigneePicker 的标准入口，任务行、详情和表单的原有人员编辑保留各自呈现。普通状态多选与两种 TagFilter 使用 SelectTrigger，表达式搜索仍使用单选 NativeSelect；这些任务筛选均显式选择 `filter`、`responsive-target`、`task`。细指针始终使用共享 14px 档，宽度大于 800px 且非紧凑布局时高度为 32px，800px 及以下时高度及命中宽度至少 44px；粗指针高度及命中宽度至少 44px，文字不小于 16 CSS px。窄屏自然换行，标签和计数可见。TagFilter 的 352px 面板、共享 14px 档正文、外部 chip 与定位生命周期独立于入口展示，几何变化沿既有观察更新位置。选择共享展示且保留各菜单语义的取舍见[筛选入口决策](../../.agents/notes/implemented/architecture/2026-11-16-shared-selection-presentation.md)。

## 结构与几何

组件使用无交互 `span` 包含原生控件。普通单选另有 `aria-hidden`、`focusable=false`、`pointer-events:none` 的 SVG；容器没有 role、tabIndex 或点击处理。点击箭头区域命中下方真实选择控件。`hidden` 和 `dir` 同时映射到容器与控件，隐藏时不会留下箭头，显式 RTL 使用逻辑末端位置。

容器使用 `inline-grid`、按内容宽度、可收缩的最小宽度和 `max-inline-size:100%`；`fill` 占满所在布局的可用宽度。容器与单选控件保持同一高度，起始对齐，避免表单说明文字拉伸容器后改变箭头中心。

| 模式 | 高度 | 字号 |
| --- | --- | --- |
| `compact` | 24px | 共享 14px 档 |
| `filter` | 32px | 共享 14px 档 |
| `form` | 38px | 共享 14px 档 |

高度为基础最小值；当浏览器字体偏好使文字行高超出时，控件与计数徽标随文字增长，避免裁切。单选起始文字空间为 10px，末端 padding 至少 30px；10×10px 箭头盒距末端 12px，文字至箭头盒至少 8px。箭头路径为 `m2 3.5 3 3 3-3`，使用 `currentColor` 并垂直居中。单选文字单行省略，完整 option 文本保持原样。基础外观为白底、中性 1px 边框与 6px 圆角。

`multiple=true` 或原生 `size>1` 使用列表模式：没有箭头和箭头专属留白，不应用固定单行高度或省略。原生 `size`、滚动、单选列表及多选数组语义保持；公共层继续拥有字体、边框、焦点与禁用外观。

## 状态与触控

公共基础选择器为 `.native-select[data-density] > .native-select__control`，状态规则使用真实属性或伪类限定。样式不依赖导入顺序或 `!important`。`:disabled` 同时覆盖直接禁用与 `fieldset` 继承，决定文字、背景和装饰箭头状态。`pending` 使用 attention 边框，`aria-invalid=true` 的 error 边框优先。3px 焦点轮廓独立保留，普通颜色为 `#8c8cf0`，Task/status 为 `#344054`。forced-colors 使用 `Canvas`、`CanvasText`、`GrayText` 和 `Highlight`，保留边框、箭头与焦点。

`touchMode="responsive"` 在 viewport 不超过 800px 或 `pointer:coarse` 时使用至少 44px 高度，文字选择共享 16px 档并遵循 16 CSS px 触屏下限。`touchMode="responsive-target"` 复用相同的响应式目标尺寸与徽标规则，但在不超过 800px 且 `pointer:fine` 时保留共享 14px 档；粗指针及其他指针环境沿用 `responsive` 的字号规则。`touchMode="container"` 查询命名容器 `native-select-region`：容器宽度不超过 600px 时，高度至少 44px 并保留原字号；粗指针下使用同一触控字号。默认 16px 根字号下触控文字为 16px，根字号增大时随之增长。容器由消费页面的已有 inline-size 容器提供，保留其原名称并追加公共名；内层异名容器不会改变查询目标。普通控件默认 `none`，不因窄 viewport 自动放大。

## 原生弹窗与外层关闭

同模块的 `isNativeSelectPopupOpen(target: EventTarget | null): boolean` 只判断真实 `HTMLSelectElement` 的 `:open` 状态，没有事件副作用。组件不拦截 Escape、Enter 或 change。

拥有对话框、草稿面板或全屏关闭逻辑的调用者先尊重 `defaultPrevented` 与 IME 状态（`isComposing` 或 `keyCode=229`）。Escape 命中打开的原生选择弹窗时，仅阻止继续向外传播，不调用 `preventDefault`，以保留原生取消并保护外层和草稿。其他 Escape 继续执行所在页面的关闭与焦点恢复逻辑。公共层不维护另一份弹窗状态。

## 所有权检查

`packages/daynight-web/scripts/native-select-policy.mts` 先枚举完整 `src/` 中的 TS/TSX 和 CSS，再使用 TypeScript 7 的 `typescript/unstable/sync` 项目 API 与 `typescript/unstable/ast` 遍历源码，包括未被其他模块引用的输入。除公共组件文件外，原生 JSX `select` 和标准 React `createElement` 原生创建均失败；React、`createElement` 和 NativeSelect 的导入别名按实际绑定识别；创建 HTML 控件的标签字符串按大小写不敏感语义判断，JSX 大写组件标识仍保留组件含义。注释、普通字符串与泛型不作为元素声明。

CSS 使用显式开发依赖 `css-tree` 的 AST 分析完整选择器与声明。公共参数声明与 SelectTrigger host、箭头、计数皮肤仅允许公共展示 CSS owner，native 内部选择器仍仅允许 native CSS owner；两者分别检查，不使用宽泛豁免。SelectTrigger 导入别名及静态 `layoutClassName` 别名复用绑定解析与布局白名单，任意 className/style、动态或不可解析布局 token 均拒绝；标准 host 不保留旧 feature 皮肤别名。公共 CSS 外对 `select`、公共 control/arrow 类或对应标记的内部外观覆盖，以及 `wrapperClassName` 布局类的核心外观、伪元素箭头或 `appearance` 恢复均失败。混合选择器、嵌套规则与条件规则仍接受检查，全部生产 select 均位于公共容器内；内部箭头和控件的子节点，以及通过 select 类型或内部标记定位的同一容器内兄弟节点也归公共 CSS 所有；公共容器之外的相邻字段仍由页面管理。`:has()` 的直接子节点及内部兄弟关系按同一结构判断所有权。只有直接子节点关系的全部分支都能证明目标是公共容器的直接子节点时，才把父节点视为可设置外部布局的公共容器；内部后代或混合分支不能获得该布局权限，应改用直接 wrapper 布局类或公共 CSS。仅包含 select 的外层页面祖先不会自动获得内部所有权。以受保护选择器为根的 `@scope` 明确拒绝；布局类使用直接规则，内部样式放入公共 CSS。普通 input/textarea 及其他菜单保持各自所有权。检查没有遗留名单或页面豁免。

诊断包含相对路径、行号和被违反的规则；文件读取、源码/CSS 解析、缺失 AST 及资源释放错误均令命令失败。TypeScript 快照与 API 在成功和失败路径都释放。检查约束直接声明与样式所有权，不能判断任意绘图代码的视觉意图；真实浏览器和独立审查继续负责重复箭头、几何及原生交互。

## 验证责任

`scripts/native-select-policy.test.mts` 验证合法用法、受控违规、别名、字面量组合、单/多选、混合选择器、布局允许项、解析和资源释放失败，并检查实际生产树。`test:harness` 执行该检查，因此 `web:test` 和 CI `quality` 的 harness 阶段均执行所有权规则。可用 `pnpm --filter @codetreker/daynight-web test:select-policy` 单独检查生产树。

`tests/native-select.test.tsx` 验证 props、真实 ref 与事件、label、required/fieldset、hidden/dir、列表与多选、无选中状态及重渲染节点连续性。`tests/navigation/native-select-playwright.config.ts` 直接渲染生产组件与 CSS，拥有公共变体与状态、长文本、中英文、规定宽窄视口、flex/grid、触控容器、forced-colors、缩放和真实浏览器输入证明。执行命令、调度及产物位置见 [Web README](../../packages/daynight-web/README.md#native-select-browser-validation)。

消费页面的受控 API 浏览器 fixture 负责其布局、业务回调、禁用、确认/取消与后台检查连续性。公共矩阵不需要在每个页面重复；模拟 DOM 不能证明绘制几何，`selectOption` 不能证明系统原生菜单或方向键。实际设备与无头浏览器的结论分别记录。
