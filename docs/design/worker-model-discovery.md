# 创建前原生模型能力

## 结构

`commands/worker/read-only/models.ts` 负责输入校验、有效配置、真实 cwd、默认来源与短期分页；`native-selection.ts` 的共享 verifier 负责探测与停止证据。`native-selection-probe.ts` 在被管理的短命进程内读取各 Provider 能力。`discoverWorkerNativeCapabilities` 允许默认未知，原有 `verifyWorkerNativeSelection` 继续严格核验启动选择。

创建前发现使用实际助手的 Web 上下文：Codex 只读取 `config/read` 和完整 `model/list`，不注入 Herdr 的项目信任覆盖；Claude 使用 SDK 自带可执行文件，通过不持久化且不输入消息的查询读取 `supportedModels` 与有效 settings；Copilot 使用助手同源可执行文件及 SessionFs 读取真实配置、将写入留在内存，通过 `model.list/getCurrent` 读取能力。三者均不借用现有 Session。各模型的 effort 由原生字段映射；没有每模型默认字段时保留未知。Herdr 的既有严格验证仍使用其自己的启动参数和可执行文件。

## 操作合同

通过 `daynight.worker-readonly.v1` 的 `model.list` 操作查询。输入必须包含 `provider`（`codex`、`claude` 或 `copilot`）；可选 `cwd`、`model`、`includeHidden`、`limit`、`cursor`，不接受额外字段或 `null`。cwd 为目标平台绝对路径，最多 4096 UTF-8 字节；model 最多 256 字节；limit 为 1–100，默认 100；隐藏项默认排除。

成功 result 包含：

| 字段 | 语义 |
|---|---|
| `schemaVersion:1` | 模型结果版本，与通道版本独立 |
| `provider`、`cwd` | 实际 Provider 和规范化工作目录 |
| `configurationGeneration` | 有效配置、工具目标与检查后的选择身份、Provider、cwd 和显式模型的 SHA-256 指纹 |
| `catalogGeneration` | 本次原生目录快照 UUID |
| `models` | 当前页的模型记录 |
| `defaults` | model 和 reasoningEffort 的 `{value,source}` |
| `selectionError` | `null` 或 `{code,message}`，code 为 unknown_default 或 unsupported_selection |
| `nextCursor` | 签名分页游标；末页为 null |

每个模型记录为 `{id,label,aliases,hidden,reasoningEfforts,defaultReasoningEffort}`。aliases 最多 16 项，effort 最多 32 项；模型 ID 与别名最多 256 字节，label 最多 1024 字节，effort 最多 64 字节。`reasoningEfforts:null` 不提供已确认的可选强度；默认强度未知时为 null。已知默认强度必须属于该模型的原生列表。

defaults 的 source 为 explicit/local/cloud/native/unknown。explicit/local/cloud 必须有值；unknown 必须为 null；native 可为 null，表示原生未报告具体默认强度。模型目录成功不代表当前组合可启动；消费者须处理 selectionError，显式创建还需在首次启动时复核。

## 配置与分页

Worker runtime 从同一有效配置组合应用本地覆盖并保留来源。切换 Provider 时使用该 Provider 自己的原生配置，不复制另一 Provider 参数。明确选择模型不清空 Worker 的明确 effort。

每个无游标请求先准备相关 Provider 的工具选择，再捕获有效配置、工具目标与 `selectionKey`，并重新发现能力，不用持久缓存掩盖能力变化。只读通道以配置和工具目标维持连接，不把新取得的检查证明当作配置变化；模型请求自身在准备后绑定选择身份。准备完成后捕获当时目标；若原连接已失效，请求随之取消。目录完成前或分页期间选择、目标或 cleanup generation 改变则拒绝陈旧结果。只为后续页保留至多 8 个、30 秒的内存快照。游标用实例密钥签名，绑定目录快照和偏移；快照同时绑定查询参数、页大小及配置。仍在原连接上发现身份或配置变化时返回 stale_configuration，通道配置变化也可能先使连接失效；过期、篡改、参数变化或新实例返回 invalid_cursor。完整目录先解析默认并校验组合，再过滤隐藏模型，避免隐藏默认被错误替换。

Go broker 记录每个连接声明的操作和每个待处理请求的操作及 Provider，再按对应 schema 验证结果。旧 Worker 仅声明 directory.list 时，模型查询返回 unsupported。Web 的 `discoverWorkerModels` 返回完整身份信封并校验 Provider，不自行推断目标 Worker 或默认模型。

## 取消与失败

模型查询的 25 秒操作预算包含排队与目录解析；HTTP 和 Web 分别使用 30/32 秒期限，为原生启动、RPC、关闭和进程组停止确认留出时间。目录查询仍为 10/12 秒。关闭通道取消请求并丢弃迟到响应，同时使分页快照失效；Worker 退出等待共享 verifier 处理探测清理。

探测沿用有所有权证明的 supervisor；stdout/stderr 有界，目录 DTO 也独立限制。停止有独立最长 60 秒清理期限。取消后的执行仍占用名额，原始 `BotCliProbeCleanupError` 通过 cause 保留并进入 verifier 的待清理集合，后续查询前重试。

模型错误在既有错误之外增加 invalid_input、capability_error、cleanup_unknown、stale_configuration；能力读取错误与 unknown_default 选择状态不同。错误消息不发送原生异常文本、凭证或进程证明。网络/Provider 拒绝不能伪装空目录；请求超时不能证明子进程已经停止。
