# Task Thread CLI 设计

## 职责与依赖

[Thread 需求](../spec/daynight-task-thread.md)定义消息、HTTP、权限与提交结果；
[服务端设计](daynight-task-thread.md)定义持久化和实际 JSON 编码。CLI 提供显式
read/post、同任务引用回复和完整可读文本，独立于 Web Discussion 与执行环境。

Task 描述与附件保存有效要求、方案和正式成果，Thread 保存讨论，Session 保存执行
内容。发言只追加不可变消息，不触发 Agent，不修改 Task 状态、version、时间、属性、
依赖、缓存 epoch 或 task-sync。消息身份为 `(task_id, message_id)`；数据库生成 Id，
CLI 不生成另一种提交身份，不自动重试或按相同正文合并。

| 所有者 | 职责 |
| --- | --- |
| `src/commands/task/definition.ts` | thread/read/post 语法、帮助及叶选项 |
| `src/commands/task/command.ts` | 在普通 done-only claim guard 前分派 Thread |
| `src/commands/task/thread.ts` | 零 I/O 输入校验、项目选择与一次资源调用 |
| `src/api/client.ts` | 认证传输、原始来源解码、响应主体验证与提交确认 |
| `src/api/json-source.ts` | 有界 JSON 区间扫描与重复成员拒绝 |
| `src/api/thread.ts` | 浏览器安全的Thread字段与原始区间解析，供CLI与Web消费 |
| `src/commands/task/thread-rendering.ts` | 完整正文编码、连续页选择和实际文本预算 |
| `src/commands/task/thread-diagnostics.ts` | 受控诊断及远端结果分类 |
| `src/commands/server/runtime.ts` | Operation、取消、确认回执与清理生命周期 |

CLI不依赖Web模块。来源扫描与Thread字段解析是无Node运行时依赖的纯原语，[Web消费者](task-thread-web.md)复用这些解析；账号准入、网络生命周期、终端renderer和浏览器controller仍由各自消费者持有。契约测试对照实际服务响应。收件箱、定向派发、回执、worker 控制、消息修改与
后台消费没有预置接口。

## 命令与输入

```text
daynight task thread read <task-id> [--before-id <message-id> | --after-id <message-id>] [--count=N] [--details] [--project <project-id>]
daynight task thread post <task-id> --body <text> [--reply-to <message-id>] [--claim-id <claim-id>] [--project <project-id>]
```

read 默认最新页，CLI 默认 count=20，且始终显式发送该值；服务的默认 50 不决定 CLI
行为。count 只接受十进制整数 1–100，不 clamp。before/after 互斥。参数 Id 使用完整
36 字符 UUID，接受大写并规范化为小写，不修剪包围空格。

post 保留 body 原始空白，不进行 trim 或换行归一化；拒绝空白正文、NUL、无效 Unicode
及原始 UTF-8 超过 64 KiB。完整资源大小仍由服务判断。replyTo/claimId 缺失时省略，
不发送 null。claim 仅为显式验证的执行来源，不从环境、Task 或 worker 推断。正文以
横线开头时使用 `--body=-example`。两个叶命令均不注册 JSON、时间游标、提交 token、
版本或别名选项。

参数拒绝先于配置、Git 和网络 I/O，退出 2。schema 的 UsageError 保留实际命令定义
对象及规范 path；应用按有效命令树的 Thread/read/post 对象身份选择安全语法诊断。
错误原始 argv 可以保存在内部 cause，stderr 不回显其中的正文。其他命令的错误出口
保持原语义，程序错误不能被当成参数错误吞掉。

## 单次请求与账号准入

每次调用仅加载一次服务 origin/PAT，在同一 ApiClient/Operation 中固定使用。配置文件
在途变化不重新绑定请求。显式项目直接进入 Thread 请求，不先 GET Project、Task、
properties 或当前账号；省略时复用 Git 项目绑定。项目发现后只有一次 Thread GET 或
POST，不自动分页。

路由为 `/api/v1/projects/{projectId}/tasks/{taskId}/thread/messages`。GET 映射
beforeId/afterId、count 和 details；POST 只发送 body 及实际给定的 replyTo/claimId。
认证、no-store、手动 redirect、请求期限与取消复用已有传输。

Thread 成功响应必须包含规范小写 UUID 的 Daynight-User-ID。已有 expectedUserId 时
继续核对，不增加 `/me` 请求。POST 的 author.userId 必须等于该响应准入账号；历史
GET 作者可以是其他账号。401/403 等错误可以无账号头，完整有效错误仍可构成明确拒绝。

## 来源解码与有类型解析

exchange 的 Thread JSON 模式在受限读取、fatal UTF-8 和媒体类型检查后，以完整原始
字符串调用 decodeJsonSource。局部 response context 携带 status、success 和已经准入
的 principalId，来源解码与有类型 parse 使用同一个 context，不新增 wire envelope。

来源扫描保留 container 成员/value 的原始区间。对象键解析成真实字符串后先检查 Set，
再写 Map；`Agent` 与转义等价的键同样冲突。重复成员检查递归覆盖消息、author、
execution 和错误 envelope，先于完整文档的 parseApiJson。扫描循环检查 EOF，限制
深度为 64，损坏/截断输入不能导致无界等待。

GET 的每项原始消息区间都必须不超过 65,536 UTF-8 字节，页面完整传输不超过
262,144；POST 默认消息不超过 65,536。J 的编码所有者是服务 internal/taskthreadjson，
使用 Go HTML 转义 `<>&`、U+2028/U+2029 和无尾随 LF 的实际资源缓冲。CLI 测量原始
区间，不以 JSON.stringify 重编码长度代替。页内逗号和外层空白只计入页面预算。

decoder 拒绝未知字段、缺失必填字段、错误类型、重复 Id、无效顺序和不规范响应 UUID。
displayName 是必填 nullable string，空字符串也合法；Agent 是必填 boolean。replyTo
可以省略但不能为 null。默认消息省略 execution；details 的 Agent 消息必须含完整
claimId/workerId/provider，普通账号必须省略。provider 限于 codex/claude/copilot。
createdAt 必须为真实 UTC 日期和恰好三位毫秒，格式为 `YYYY-MM-DDTHH:mm:ss.SSSZ`。

items 按 `(createdAt,id)` 严格升序，不返回输入边界 Id，不超过请求 count。空页两侧
标记均为 false。客户端不额外请求边界时间；服务解决同任务边界归属和复合顺序。

## 可读文本与正文编码

每条完整消息以固定分隔线隔开，显示 Id、Author 与账号 Id、CreatedAt、可选 ReplyTo
和 Message。Agent 作者增加 `'s Agent` 标签及独立 `Agent: True`。null/空名显示 Account，
不在 wire 数据补造名称或 email。details 用固定标签显示 claim/worker/provider。

作者始终一行，控制字符可见编码；账号 UUID 由 renderer 在最后追加，显示名中的括号
或字段样式文本不定义身份字段。正文不解析 Markdown 或执行 ANSI：反斜线先编码为
`\\`，CR 为 `\r`，DEL 为 `\x7f`，其他不安全控制字符使用小写四位 `\uXXXX`。
LF/TAB 保留。双向格式控制字符、C0/C1、U+2028/U+2029 也使用可见编码。

单行正文在 Message 引号内，双引号转义；多行从 Message 下一行逐行缩进两格，空行与
结尾空片段同样保留。移除固定包装后反向解码能够还原原文，字面 `\x7f` 和真实 DEL
不同。正文中的 Id、分隔线、分页提示不能成为顶层消息边界。

hasMoreBefore 为 true 时仅顶部显示 `... Has more messages before`，hasMoreAfter
为 true 时仅底部显示 `Has more messages after...`。空 latest/before 页显示
`No messages.`；空 after 页显示 `No new messages.`。

## 完整文本预算与连续位置

262,144 字节上限包含最终 stdout 的字段、缩进、分隔线、详情、提示和 LF。先校验全部
响应并渲染完整 block，再以实际 UTF-8 字节选择连续集合。after 取前缀，before/latest
取后缀，最终都升序展示。遗漏前部/后部分别与服务两侧标记作 OR，不截断或跳过消息，
不补发请求。实际输出第一项供历史继续，最后完整消费项供增量继续。

Thread读取在完整校验、渲染和计字节后等待现有stdoutBytes写入确认，使用本次网络与读取
Operation的取消信号；输出失败由Thread安全诊断出口报告，不能将部分输出视为已消费页。

单消息保证依赖逐项 64 KiB 验证与固定包装约束。可变正文/名字最多为服务 JSON 对应
内容的四倍：最坏 DEL 从一字节变四字节，C1 从两字节变六字节。固定资源部分至少
183 字节，最大全部终端包装为 473 字节，因而：

```text
stdoutBytes <= 4 * (J - 183) + 473 = 4J - 259 <= 261885
```

生产编码器测试将最短 wire fixture 精确断言为 183、最长包装精确断言为 473，并检查
各模式上下界。增加包装超出 473 必须让测试失败，再重新证明容量。合法单消息能够
完整显示；每页按实际字节选取更多消息。

POST 回执不能推进已连续读取位置。已经读 A、别人写 B、自己写 C 后仍从 A 查询，
完整消费 B/C 后再推进；历史合并也不推进。CLI 不持久化该位置，空页保留原边界。

## 提交事实与诊断

只有完整验证 201、身份、JSON 来源、消息内容和字节预算才确认提交。body/replyTo 必须
与输入一致，Agent 标记必须对应是否给定 claim。成功只输出 Message posted.、完整 Id
及可选 ReplyTo，不重复正文。

完整有效 4xx 拒绝和 `503 clock_not_advanced` 是明确失败；`message_outcome_unknown`、
普通 5xx、dispatch 后传输/取消/超时、损坏或不完整 201 均为未知。未知结果提示读取正常
Thread 再决定是否发送，CLI 不保存或删除调用者草稿，不自动再次 POST。相同正文不能
证明特定请求成功。

已确认结果携带 project/task/message Id 跨越 runtime 的输出与 finally。后续取消检查
不能改写远端提交事实。回执复用现有stdoutBytes可等待写入器，等待实际写入确认并捕获
异步stdout错误；独立5秒本地输出Operation让已经取消的网络scope不阻止输出已确认回执。
该输出scope在写入后dispose，原网络Operation、输出helper、流、signal listener和timer
仍完整清理。stdout或清理失败退出1，保留确认Id及内部cause并说明本地失败；没有
detached异步任务。

PublicDiagnosticError 保留内部 cause 和安全 publicText/exitCode；最终 formatter 只打印
安全说明。诊断可含规范 operation/phase/Id/status/code/requestId，不输出正文、账号名、
自由服务文本、HTTP body、凭据或 stack。参数错误退出 2，其他失败退出 1，成功退出 0；
失败不把局部页面作为成功输出。

## 验证与文档入口

验证覆盖命令发现、零 I/O 拒绝、一次 Thread 请求、严格来源/字段、账号准入、真实服务
响应一致性、精确资源/输出边界、DEL/C1/LF/TAB 可逆性、连续双向读取、提交结果和确认后
本地失败。真实服务契约验收由
[acceptance_thread_cli_test.go](../../packages/daynight-server/cmd/e2e_tests/acceptance_thread_cli_test.go)
持有，与 `cmd/e2e_tests` 的进程及证据 harness 共用真实认证、隔离PostgreSQL、已构建服务、
安装包归属和资源清理证明。单元 fixture 不替代该验收。CLI 使用仓库现有
typecheck/test/build、版本门禁和安装包检查，安装包 help 与 `daynight --skill` 必须能发现 Thread。

[CLI 指南](../../packages/daynight/README.md#task-discussion-threads)和独立 usage.md 手册
拥有操作说明；using-daynight 源技能持有用途与写入安全规则。实际字节与调用数可以测量，
token 数需标明具体编码器、版本与 fixture，不能由字节套用普遍比例。
