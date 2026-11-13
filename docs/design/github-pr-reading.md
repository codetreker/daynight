# 项目 GitHub PR 读取

Project 成员通过 `GET /api/v1/projects/{projectId}/github` 读取连接配置及持久化同步事实，通过 `GET /api/v1/projects/{projectId}/pull-requests` 读取摘要页，通过 `GET /api/v1/projects/{projectId}/pull-requests/{number}` 读取完整详情。读取不访问 GitHub；服务未配置或连接断开时仍可读取保留的数据。没有连接行时返回虚拟未连接状态，不创建存储行。部署配置决定 `serviceAvailable`，与连接和观测版本无关。

项目读取权限、连接、计数和页面或详情在同一只读快照内验证与读取。版本、revision、GitHub ID、PR number 和计数以十进制字符串输出；可空事实明确输出 null，仓库可见性未解析时也保持未知。摘要不包含 description，详情保留原始 Markdown，空字符串和 null 不合并。缺失资源、读取失败和成功空页各自表达，取消传播为错误。

列表按 number 降序读取，支持 `state=active|closed|merged|all`（默认 active）、字面大小写不敏感的标题或编号子串 `q`（最多 1024 UTF-8 bytes）、`limit`（默认 20，范围 1–100）和可选 cursor。counts 独立于 q 和状态筛选，total 对应当前筛选。游标绑定 Project、条件、页大小、首次读取上界、锚点和方向，条件不匹配或格式错误予以拒绝。后续新编号不会插入已有页；已有记录变化仍可改变页面和计数，空锚定页保留返回路径。

连接状态、初始化、渠道运行标记和错误来自已保存事实；完整成功属于特定 generation，旧 generation 的成功不能证明重新连接完成。读取不启动连接或后台同步。存储字段与快照约束见 [GitHub PR 存储](github-pr-storage.md)。

## Web 详情组件

`PullRequestDetailDialog` 接收当前 userId、Project、PR number 和关闭回调，独立读取详情，不复用 Task UUID 详情。调用方负责 Project 读取资格与后台核对时机；核对中的读取可暂停，已展示的对话框和交互状态保持挂载。身份或资格撤销时清除详情并取消请求。响应通过用户身份头和目标编号校验，读取 generation 及精确 revision 防止旧结果覆盖新观察。读取失败与空正文分别呈现，恢复性失败保留已显示数据。

详情显示状态、作者、源与目标分支、完整 SHA、时间及 GitHub 外链，缺失作者或来源明确标识。description 使用基础 Markdown 和 GFM，图片不加载，raw HTML、Mermaid 和嵌入内容不执行；原文以文本节点展示。后台内容更新保留对话框、原文选择、焦点和阅读位置。该组件不开放 Project 导航入口，列表负责挂载和调度核对。
