# Web 公共复制按钮设计

## 公共呈现

[`src/ui/copy-button/`](../../packages/daynight-web/src/ui/copy-button/) 的展示控件自导入 CSS，统一拥有原生 `type="button"`、装饰性双方框图标与内部状态样式。16px 图标始终可见；纯图标按钮为 26px 方形，预留 1px 透明边框。默认背景和边框透明且无阴影；启用时悬停采用白底与 `#dce0e8` 边框，不移动相邻内容。键盘 `:focus-visible` 使用 3px `#344054` 轮廓和 2px 偏移，在白底和选中背景上均可见。禁用及 `aria-disabled="true"` 不显示启用悬停样式；保留触控可达性和既有禁用语义，包括可聚焦的 `aria-disabled` 控件。

调用者提供本地化可访问名称和 `title`、事件、原生属性以及外部位置、宽度与间距；文字操作保留可见文字及成功文案。不得叠加通用 `.button` 皮肤或由调用者覆盖共享内部呈现。

## 剪贴板行为与反馈

`ValueCopyButton` 承接 Task 行及 Task／Goal 详情共同的提交中状态、值及卸载隔离；详情通知仍由各自宿主持有。Team、Setup、Webhook、秘密对话框和 Worker 路径继续分别拥有准入、剪贴板写入、重复提交防护、反馈、失败恢复及迟到结果隔离。共享呈现不合并业务状态。取舍见[复制控件决策](../../.agents/notes/implemented/architecture/2026-11-16-shared-copy-button.md)。
