# Controller 角色指令契约

## 角色与用户输入

`ControllerLaunchTicket.instructions` 是可选的启动角色文本，独立于 `initialPrompt`。Controller 在启动和恢复时将其原文传给 `ProviderOptions.instructions`；角色文本不能通过 `provider.send` 转为用户消息，也不创建 initial operation、turn 或时间线条目。

省略字段表示没有角色配置。提供时必须是包含非空白内容的良构 Unicode 字符串，UTF-8 编码不超过 64 KiB（65,536 字节）。显式 `null`、`undefined`、非字符串、空白文本、未配对 surrogate 和超限内容均拒绝。校验不裁剪、规范化或改写合法文本，换行、首尾空白和组合字符保持原值。

旧 schemaVersion 1 ticket 无需补字段或重写；解析、读回后保持字段缺失和原 hash。未知字段、缺少必填字段以及原有身份、配置或输入约束违规仍须拒绝。角色字段不改变 Task 的无人值守选择或独立 Session 的原生交互权限。

整份序列化 ticket（包括 JSON 转义和结尾换行）最多 6 MiB，读写使用同一上限。写入在创建文件前拒绝超限内容，不能留下写入成功但启动无法读取的 ticket。该预算保留原有 5 MiB 文件空间，并容纳 64 KiB 角色在 JSON 中最坏的六倍转义及字段开销；初始输入与角色自身的字节上限仍分别适用。

## 持久化与恢复责任

角色文本随私有、不可覆盖的 launch ticket 持久化，参与完整 ticket 的内容 hash。同一 launchId 不能改写、追加或移除角色。生成后续 generation 的调用者必须使用首次准备时持久化的冻结角色，不因模板升级重新渲染，也不能丢弃角色字段。

共享 journal 继续按完整 ticket hash、原执行身份、停止状态与精确 native session ID 验证代际恢复。它不另存角色模板、revision 或跨代角色摘要，也不从完整 ticket hash 反推角色；跨代冻结值的选择由 ticket 生产者负责。恢复保留既有输入结果，未知用户操作不可自动重放。

独立会话使用 `initialInput: "none"` 和 `initialPrompt: ""` 时，角色文本仍可存在。初始输入状态为 `not_required`，IPC `submit_initial` 必须拒绝；只有真正的用户请求才能进入发送路径。已有 Task 与无角色 Test 的输入规则保持不变。

## Codex 原生角色

Codex 在 `thread/start` 与 `thread/resume` 中将冻结原文传入 `developerInstructions`。省略 `instructions` 时不得发送该字段，也不得用空字符串覆盖原生配置。角色不能通过 `turn/start`、`turn/steer` 或隐藏用户输入发送；恢复使用同一 native session ID，并保留既有历史。

该字段提供独立于基础提示的 developer 指令，不设置 `baseInstructions`。其原生语义是覆盖该层已有的 developer 配置，不承诺与用户原有 `developer_instructions` 拼接。角色传递不得改变 native PATH、CLI alias 环境、模型、effort 或权限选择；新建沿用原参数规则，恢复不以启动参数重置已有设置。

原生端拒绝角色时，启动必须失败并向调用方传播原错误，关闭本次拥有的原生子进程和传输资源。不得删除角色后重试、降级为用户消息或报告无角色的启动成功。

## Claude 原生追加

Claude 新建和恢复都将角色原文映射为 SDK 的 `systemPrompt: { type: "preset", preset: "claude_code", append: instructions }`，保留 Claude Code 基础提示。无角色时省略 `systemPrompt`，不改动既有默认行为；不得以完整字符串替换系统提示，也不得为角色插入用户消息。

恢复使用原 native session ID 和调用者提供的冻结角色，保持原生 model、effort、权限及 sandbox 配置，不用启动参数覆盖已恢复设置。新建仍按既有参数和 unattended 规则选择设置；角色存在本身不授予额外权限。审批仍通过原交互链路，SDK callback 返回不等于原生工具结果已确认。启动拒绝与流中断必须显式失败，未知输入不能自动重发；关闭继续回收已取得的 SDK 资源。

## Copilot 原生追加

Copilot 新建和精确恢复均将提供的 `instructions` 原文配置为 `systemMessage: { mode: "append", content: instructions }`，保留原生基础提示。没有角色时完全省略 `systemMessage`，不构造空角色或替换提示。角色配置本身不发送用户消息，也不产生初始化 turn。

新建的模型和 reasoning effort 继续按原规则选择：未提供就省略，显式配置才传递。恢复仍以原 native session ID 为准，不使用启动参数覆盖该会话的模型、effort 或审批设置。角色不启用无人值守权限；普通会话继续使用原生交互审批。原生打开或身份核验失败时向调用者传播错误，关闭自己拥有的 runtime，不发送角色作为重试输入，也不新建替代会话。

## 实现边界与验证

该契约提供 ticket 校验、持久化、Controller 到 Provider 的共享传递，以及 Codex、Claude 和 Copilot 的原生角色映射。Bot 的[版本化模板与环境准备](bot-role-environment.md)由 Worker helper 提供，首次持久化、服务端冻结与托管接入由其消费者负责；共享字段和适配器可用不表示完整助手入口已启用，也不证明完整真实原生角色行为。独立 CLI 当前没有角色创建参数。

验证须覆盖旧 Task/Test 字段与 hash 不变、非法输入及准确 UTF-8 边界、同 launchId 的角色改写拒绝、持久 ticket 经停止代际恢复后的原文传递、未知操作不重放，以及三个 Provider 的新建/恢复 options。Codex stdio 夹具还须验证 start/resume 原文、缺省字段、基础提示不覆盖、初始化无用户 turn、首个真实输入与设置保持，以及原生拒绝后的原错误和资源关闭。Claude 适配验证须覆盖新建与恢复的 preset append、无角色时字段缺失、零准备输入、原生设置和审批语义、SDK 启动失败及关闭。共享层模拟与 Provider 夹具仅证明各自传递和失败处理，真实 Provider 行为需独立运行证据。

Copilot 适配验证还须覆盖 create/resume 的原文追加、无角色字段缺失、无初始化发送、模型/effort 与审批保持、打开拒绝及身份错误后的子进程回收。真实 SDK/CLI 的新建与恢复验收使用隔离目录，分别记录原生配置接受、native ID、消息历史与停止结果；不把模拟结果或配置接受表述为完整 Bot 或模型行为验收。

机制见[会话协议设计](../design/task-session-protocol.md#角色指令的共享传递)，输入和身份基础见[独立测试会话需求](controller-test-sessions.md)。
