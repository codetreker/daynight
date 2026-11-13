# 项目内 Task 搜索接口

`POST /api/v1/projects/{projectId}/tasks/search` 在单个可读项目内搜索 Task 自身 ID、完整标题和 Markdown 描述，包括已完成资源，排除自身或父 Goal 已删除的资源。它是无副作用的读取，要求认证与项目读取权限；Cookie 请求遵守现有同源规则，响应禁止缓存。

请求使用严格 JSON：`query` 为必需的原始表达式，`status`、`assignedTo`、`ready`、`allowAgents`、`compatiblePlatform`、`tagIds`、`tagMatch` 和 `untagged` 为可选筛选，与整个表达式取交集。`tagIds` 是项目标签 UUID 数组，规范化、去重和排序；`tagMatch` 为 `all`（默认）或 `any`，`untagged` 为布尔值且不能与非空 `tagIds` 同时使用。空集合且非 `untagged` 不限制标签。无效、跨项目或已删除标签返回 `400 invalid_tag_filter`；不得截断超限输入。标签仅按条目自身关联匹配，标签名称不参与文字匹配。`limit` 默认 50，范围 1–100；`cursor` 可省略或为 null，续页重复原始表达式与筛选。缺省状态包含所有状态，包括cancelled；取消不删除搜索记录。筛选值沿用 Task 列表的含义。`type` 缺省为 `task`，可显式选择 `goal`；`parentId` 缺省不筛选，null 只匹配未归属资源，UUID 匹配直接孩子。Goal 不接受非空 Parent。

普通词和双引号短语在自身 ID、完整标题和 Markdown 描述中分别按连续字面子串匹配，任一字段命中即可；仅折叠 ASCII 英文字母大小写。ID 使用完整的带连字符 UUID 文本，支持完整 ID、前缀及任意中间片段，不去除连字符或验证片段为 UUID。大写独立词 `NOT`、`AND`、`OR` 依次从高到低结合；相邻条件隐含 `AND`，括号改变优先级。`id:`、`title:` 和 `description:` 分别将紧随其后的词或短语限定于自身 ID、标题和描述，不限定括号组。引号内仅 `\"` 和 `\\` 是转义；其他符号如 `%`、`_`、`*` 和 `?` 均为字面文本。原始查询上限为 8 KiB、128 个条件和 32 层括号。

成功响应包含 `projectId`、分页前的 `total`、`items` 和可为 null 的 `nextCursor`。每项含完整 `id`、`type`、可空 `parentId`、`projectId`、`title`、`status`、可为 null 的 `assignedTo`、`updatedAt`、必需可空的`cancelledAt`、可为null的`context`、`match` 和必有的 `tags` 引用数组（无标签时为 `[]`）。`context` 的 `taskId` 与 `title` 标识实际存活的父 Goal；Goal 和未归属 Task 为 null。`match.fields` 按 `id`、`title`、`description` 顺序列出成立分支中的正向命中，字段不重复；纯否定条件为 `[]`，无正向描述证据时 `descriptionSnippet` 为 null。完整 ID 精确命中须来自成立分支中的正向默认或 `id:` 条件，其词或短语在 ASCII 折叠后与自身完整 ID 相等。结果先按完整 ID 精确命中、正向标题命中降序，再按 `updatedAt` 降序、ID 升序排列；ID 片段不增加优先级。未成立分支和否定条件不提供证据或提权。cancelledAt仅在取消状态为有效UTC时间，其他状态为null；缺字段不能补默认值。客户端不得把此投影当作完整Task。

每页的权限、标签资格、项目围栏、结果、总数、标签引用和真实上下文来自同一只读快照。续页先检查当前权限；关联标签改名或删除会更新受影响条目的版本；项目完整 typed 资源变化使围栏不同时返回 `409 search_changed`，调用者应重新开始查询。上下文批量读取本页实际父 Goal 的标题；原始表达式、筛选与请求分页限制继续适用。语法错误返回 `400 invalid_search_expression`，`details` 含 `reason`、`position`、`length`；位置从 1 开始按原始 Unicode 字符计数，EOF 长度为 0。`reason` 为 `empty_query`、`expected_operand`、`unexpected_token`、`unclosed_group`、`unexpected_closing_group`、`unclosed_quote`、`empty_phrase`、`invalid_escape`、`unknown_field`、`missing_field_value`、`field_group_not_supported`、`query_too_large`、`too_many_terms` 或 `nesting_too_deep`。未知游标及其绑定范围不一致返回 `400 invalid_input`。独立搜索业务期限为 5 秒，超时返回 `504 search_timeout`；调用方取消、底层故障和事务完成故障保留各自错误语义。

[搜索设计](../design/daynight-task-search.md)说明快照、证据和游标机制。普通 Task 读取及写入仍遵循[服务需求](daynight-server.md)。

MCP `task_search` 使用相同表达式、筛选、排序和续页规则，返回 `projectId`、`total`、`items` 和 `nextCursor`。每项包含 `id`、`type`、`parentId`、`projectId`、`title`、`status`、`context`、`match` 和 `tags`，不含完整描述及其他 Task 元数据。空表达式被拒绝；仅按标签查询使用 `task_list`。无效标签与变化围栏分别返回 `invalid_tag_filter` 和 `search_changed`。
