# Web 品牌标志与语义配色

本文定义 Web 的品牌标志及任务状态、活动和交互的精确色值。用于产品级决策的通用约束见
[UI 设计原则](../ui-design.md)；按业务事实选择样式的规则归各场景需求所有。

## 品牌标志

Web 品牌入口使用装饰性的 D 字母标志，由彼此分离的竖笔与圆弧构成，单色展示也保留两部分
及之间的留白。圆弧使用 `#7567e8`；深色表面的竖笔使用 `#b3a9ff`，浅色表面使用
`color-mix(in srgb, #7567e8 76%, #fff)`。

共享 [`BrandMark`](../../packages/daynight-web/src/ui/BrandMark.tsx) 按实际表面使用对应配色；
父元素保留可访问名称和导航语义，尺寸由使用它的布局决定。
[`favicon.svg`](../../packages/daynight-web/src/assets/favicon.svg) 使用同一图形。竖笔在浏览器默认浅色
方案下使用等效的 `#968bee`，在深色方案下使用 `#b3a9ff`；构建按内容哈希发布该资源。

## 任务状态与交互色

Web 入口加载共享 [`task-state-colors.css`](../../packages/daynight-web/src/styles/task-state-colors.css)。
任务列表、概览、图节点、详情及共享 Step 使用下列角色；适用表面、状态映射和优先级遵循
[任务条目状态背景](../spec/daynight-web.md#任务条目状态背景)。

| 角色 | 默认背景 | 悬停背景 | 边框 | 状态文字、圆点或状态边条 |
|---|---|---|---|---|
| `proposed` | `#F0EBFF` | `#E5DCFF` | `#C9B8EC` | `#64469C` |
| `todo` | `#FAFBFC` | `#F0F3F7` | `#D5DCE5` | `#526174` |
| `in_progress` | `#E9F1FF` | `#DCE8FF` | `#B6CEF4` | `#285B9F` |
| `done` | `#EAF6EF` | `#DCEEE4` | `#B9D9C5` | `#256A48` |
| `cancelled` | `#E9EBEE` | `#DDE1E6` | `#BFC6CE` | `#59616C` |
| `ended` | `#F1F3F5` | `#E4E8EC` | `#C9D0D7` | `#52606D` |
| `attention` | `#FFF7E8` | `#FFF0D6` | `#D4A04A` | `#805B27` |
| `error` / `danger` | `#FFF0EF` | `#FFE2DF` | `#DF9D96` | `#A3322B` |

实际活动使用 `in_progress` 前景；完成进度条的完成色段使用 `done` 前景。普通 Task 行和图节点的
自动执行许可标记复用 `done` 的默认背景、边框与前景。许可标记、完成色段和运行健康指示不表达彼此的含义。

任务和状态表面的标题使用 `#172132`，辅助文字使用 `#556176`，包含图节点元信息、完成标签和负责人信息。
状态文字取对应角色前景；检查前景在默认和悬停背景上的实际对比度。任务和状态控件的键盘焦点使用
`#344054`，图选择与前序轮廓使用 `#52649B`，前序边和箭头使用 `#6762CE`；后继轮廓、边与箭头共用 `#087F8C`。下层保留真实生命周期或 `attention` 的填充色。
[图节点的轮廓几何](daynight-web.md#图节点状态与焦点)由依赖图负责。上述交互色不改变品牌开关、
[Bot 输入区](../spec/bot-session-view.md)或运行健康的用色。
