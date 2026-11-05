# 项目内 Task 搜索接口

`POST /api/v1/projects/{projectId}/tasks/search` 在单个可读项目内搜索完整 Task 标题和 Markdown 描述，包括已完成任务，排除软删除任务。它是无副作用的读取，要求认证与项目读取权限；Cookie 请求遵守现有同源规则，响应禁止缓存。

请求使用严格 JSON：`query` 为必需的原始表达式，`status`、`assignedTo`、`ready`、`allowAgents`、`compatiblePlatform` 为可选筛选，与整个表达式取交集。`limit` 默认 50，范围 1–100；`cursor` 可省略或为 null，续页重复原始表达式与筛选。缺省状态包含所有状态。筛选值沿用普通 Task 列表的含义。

普通词和双引号短语按连续字面子串匹配，仅折叠 ASCII 英文字母大小写。大写独立词 `NOT`、`AND`、`OR` 依次从高到低结合；相邻条件隐含 `AND`，括号改变优先级。`title:` 和 `description:` 限定紧随其后的词或短语，不限定括号组。引号内仅 `\"` 和 `\\` 是转义；其他符号如 `%`、`_`、`*` 和 `?` 均为字面文本。原始查询上限为 8 KiB、128 个条件和 32 层括号。

成功响应包含 `projectId`、分页前的 `total`、`items` 和可为 null 的 `nextCursor`。每项含完整 `id`、`projectId`、`title`、`status`、可为 null 的 `assignedTo`、`updatedAt`、可为 null 的 `context` 和 `match`。`context` 的 `taskId` 与 `title` 标识完整普通依赖连通分量的代表；独立任务为 null。`match.fields` 按 `title`、`description` 顺序列出成立分支中的正向命中，纯否定条件为 `[]`；无正向描述证据时 `descriptionSnippet` 为 null。结果先按正向标题命中降序，再按 `updatedAt` 降序、ID 升序排列。客户端不得把此投影当作完整 Task。

每页的权限、项目围栏、结果、总数和真实上下文来自同一只读快照。续页先检查当前权限；项目 Task 变化使围栏不同时返回 `409 search_changed`，调用者应重新开始查询。闭包超过 20000 节点或 100000 条普通边返回 `400 search_context_limit_exceeded`，`details` 包含实际和最大节点、边计数。语法错误返回 `400 invalid_search_expression`，`details` 含 `reason`、`position`、`length`；位置从 1 开始按原始 Unicode 字符计数，EOF 长度为 0。`reason` 为 `empty_query`、`expected_operand`、`unexpected_token`、`unclosed_group`、`unexpected_closing_group`、`unclosed_quote`、`empty_phrase`、`invalid_escape`、`unknown_field`、`missing_field_value`、`field_group_not_supported`、`query_too_large`、`too_many_terms` 或 `nesting_too_deep`。未知游标及其绑定范围不一致返回 `400 invalid_input`。独立搜索业务期限为 5 秒，超时返回 `504 search_timeout`；调用方取消、底层故障和事务完成故障保留各自错误语义。

[搜索设计](../design/daynight-task-search.md)说明快照、证据和游标机制。普通 Task 读取及写入仍遵循[服务需求](daynight-server.md)。
