# 项目设置工作空间设计

[需求](../spec/project-settings.md)定义五组、入口、路由和状态保留；各资源的业务规则仍由原 controller 和对应需求拥有。工作空间以用户和项目为稳定身份，组合执行与提醒、Worker 提示词、GitHub 集成、成员与邀请及项目管理，不复制它们的读写状态机。

## 路由与活动范围

`app/project-settings-route.ts` 定义分组选择和链接，`router.ts` 将旧 `/projects/{id}/members` 直接解析为同项目的 settings + members，不改写历史。URL 是阅读选择的权威来源；无效选择保留项目身份并显示恢复入口。原有 `authError` 处理继续适用。实际切换通过 `BrowserNavigation` 和已有离开屏障，同一选择不新增历史；链接保留原生新标签行为。

`ProjectSettingsPanel` 与 `ProjectAccessBoundary` 按用户和项目维持稳定 owner。工作空间区分同项目 `inWorkspace`、实际展示的 `workspaceActive` 和所选组的 `sectionActive`：切组不结束 `onRoute`，隐藏组停止交互并使用 `hidden` 和 `inert`。共享 Project GET 在活动工作空间读取权威名称、仓库和设置；失败不阻止提示词或成员等独立资源读取。名称不可用时使用项目 ID，不借用其他项目的名称。

成员组由同一工作空间内的 `MembersPanel` 拥有，接收共享项目名称、`onRoute`、活动状态及状态和保留回调。成员、邀请使用原 controller、权限与提交语义；成员变化和资源不可用时刷新项目目录。没有独立成员页面 host 或重复名称读取。设置、GitHub、转移和删除仍共用原 `ProjectManagementGuard`；成员、邀请及个人提示词不加入该 guard。

## 状态与结果所有权

各 controller 分别报告保留事实；工作空间派生 dirty、pending 和 needsAttention 摘要，摘要不决定权限或释放写锁。成员保留包含在途操作、待发布 grant 和 invitation、已展示的 secret、未完成核对的问题及按原 invitation ID 保存的撤销防重复事实。因此暂离工作空间不会卸载仍持有秘密或结果的成员 owner。真实主体或资源失效撤回私有内容和秘密，不把临时隐藏当作失效。

对话框沿用 suspended 机制：隐藏组释放焦点约束但保留原确认，返回时恢复。接受操作时捕获分组展示代际；可信回执、真实自我失权和其他业务安全后果仍按原用户、项目与操作身份处理，不因分组隐藏而等待。关闭确认、重置输入、焦点和自动导航还须匹配原确认、展示代际和位置，旧回执不能改变较新的交互。

工作空间在私有不可用区域之外提供稳定的成员结果 host。成员 controller 将既有无秘密的 grant 等待说明及可信结果发布到该 host，复用原回执和返回动作；结果绑定原用户及工作空间，显示不依赖当前选中成员组。真实失权后仅保留本人可信变更或已确认等待说明及返回入口，撤回标题、名册和秘密。结果发布不以随后 404 推断写入成功，亦不改变另一个项目的导航。

个人提示词导航保护将同项目设置分组、无效分组地址及旧成员地址视为同一工作空间；取消离开时先选择提示词组，再恢复有效焦点。各组阅读位置和编辑选区在工作空间内存中保存；历史恢复先应用可见组再恢复位置。活动工作空间临时使用 manual scroll restoration，离开后恢复浏览器设置。手机导航仅调整自身横向滚动，不覆盖正文位置。

[分组决策](../../.agents/notes/implemented/architecture/2026-11-13-project-settings-workspace.md)和[成员整合决策](../../.agents/notes/implemented/architecture/2026-11-13-project-settings-members.md)记录取舍及代价。
