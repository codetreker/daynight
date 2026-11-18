# Task Session v2 历史录像要求

## 范围与消费方

Session v2 保留已上传的 Herdr 终端录像及其原有身份、格式和只读访问。服务端提供历史列表、归档状态与正文读取；Web 根据历史记录展示已验证的录像或不可用状态。历史读取不连接 Herdr，不获取执行控制，也不恢复、停止或清理旧运行。Worker 注册、控制、输入、恢复和录像写入入口已退役。

终端画面不具备消息、turn、结构化审批或 `provider_accepted` 语义；`native_timeline` 继续使用现有 Web Session 语义。v1 历史文件保留原 schema、hash 和权限，不原地升级或附加 v2 字段。具体字段和校验机制由[契约设计](../design/session-v2-contract.md)拥有。

## 版本、身份与权限

历史 v2 使用 `daynight.session.v2`、`schemaVersion=2`、`projectionVersion=1`、`agentControlMode=herdr` 和 `contentKind=terminal_recording`。HTTP 使用 `Daynight-Session-Protocol` 选择协议；未知协议或内容种类明确拒绝，不解释为其他格式。读取必须保留原 Session、claim、执行代次、Project、Task、Worker、worktree、owner 和 `serverOrigin` 身份。Herdr 原生 ID 与 Daynight UUID 分别校验，原生字符串和数字按各自类型比较。

历史访问沿用原 Session 权限；重新领取任务不会改变原 Session 的身份或权限，撤销访问后不得继续读取。正文读取受[共享归档占用及传输期限](task-sessions.md#内容归属与结束后历史)约束。结构解析成功或文件自带 hash 均不能证明访问授权或来源。

## 归档状态与完整性

历史状态保留 `pending`、`ready`、`unavailable`、`failed`。只有 `ready` 提供正文；其状态包含正文 SHA-256、字节长度、完整性和 `finalizationId`。`unavailable` 表示历史记录中的合法无录像原因；`failed` 和 `pending` 不视为可播放正文。读取失败或损坏不能靠移除引用、改写状态或将数据降为 partial 来掩盖。

服务端对读取的正文核验存储长度和原始字节 hash、严格格式及原 Session 身份，并核对保存的运行、录制责任和已关闭证据。每代选中和登记的帧数与归档来源摘要必须匹配；采集错误只能在符合记录限制的 partial 归档中由对应 gap 表达。浏览器还须核对状态、原始正文 hash 和长度、归档身份、`finalizationId` 与完整性后才显示画面。

`complete` 表示声明的采样范围没有已知中断，不承诺包含全部 PTY 输出。`partial` 保留明确 gap；播放器到 gap 时停止并由用户选择继续。段重启或运行代次边界必须有对应 gap；无帧运行保留其原因和无内容证据。已登记文件缺失、hash 错误、跨 Session/运行/段归属、无序或重复引用均属损坏。

## 画面与格式限额

每帧是可独立渲染的完整画面，`full=true`，只允许文本与白名单颜色、bold、italic、underline、inverse。不能包含原始 ANSI、HTML、脚本、OSC 剪贴板、外部资源或可执行链接；渲染器创建文本节点。Unicode 字符数不等于终端 cell 宽度，reader 不得据此截断宽字符或组合字符。

| 项目 | 上限或固定值 |
|---|---|
| 原始归档 JSON | 64 MiB |
| 规范序列化的帧文件及时间索引 | 60 MiB |
| 其余规范归档元数据 | 4 MiB |
| 单帧原始 JSON | 256 KiB |
| 帧 / 段 / gap / 运行代次 | 100000 / 1000 / 1000 / 1000 |
| width / height | 正整数，各不超过 1000 |
| 每行文本 | 16 KiB UTF-8，最多 1000 个样式片段 |
| 原生文本标识 | 256 UTF-8 字节，无控制字符 |
| 序号 | 十进制字符串，0..9223372036854775807；generation 和 frameSeq 必须正数 |
| 历史采样策略字段 | 350ms / 5 秒 |

## 验证

TS 和 Go 对共享原始字节样本验证保留的归档格式和拒绝条件，包括非法 UTF-8、重复或未知字段、序号范围、原生 ID、完整帧、排序、缺文件、跨段和运行归属、完整性及 hash。常规测试覆盖紧凑正反例和边界；大规模压力测试使用独立入口，不进入常规 CI。历史访问权限、服务端存储与浏览器播放由各自实现的测试验证；格式校验不能替代这些验证。
