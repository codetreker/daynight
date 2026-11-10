# Task Session 定位与历史读取

## 范围

CLI 与 MCP 可在明确的 Project、Task 和 Session 范围内查询当前关联、历史目录、指定 Session 状态，以及 Web Session 的最近或更早 timeline entries。读取不会创建执行、恢复 Worker、改变 claim 或向 Agent 发送内容。Herdr 保留真实身份、状态与 `terminal_recording` 类型，不转换为聊天。

当前关联没有注册时返回 `not_registered`，没有适用执行时返回 `not_applicable`，不以最近历史代替当前。指定 Session 始终绑定其原始执行；Task 的新 claim 不能改变请求目标。目录明确标记 `currentBinding` 和归档事实，默认每页 20 项，最多 200 项。

## 历史页与完整条目

消息读取默认选择最近 20 条 timeline entries，允许 1–200 条，包含工具与交互事件。每页按旧到新排列，`beforeCursor` 继续向前读取。并发追加不改变先前页的边界；`conversation` 只过滤已选页，不追溯补齐数量。过滤后为空仍保留原页游标。

每项保留 `entryId`、`entrySeq`、`revision`、`kind`、真实可得的角色和时间。没有通用时间的条目输出 null。`body` 为完整原始规范条目；装不下时输出 `truncated=true`、有界元数据和 `contentRef`，不伪造错误消息或静默截断。资源只返回描述符和引用，不下载原件或输出二进制/base64。

消息页和正文块的完整响应均不超过 256 KiB，包括 HTTP 换行或 MCP 包络。大条目的 `entry` 读取每次返回最多 32 KiB UTF-8 字符串片段，不切开码点。引用及块携带 SHA256、总字节数、revision、epoch 与偏移；拼接可核对完整规范 JSON。版本变动返回 `content_changed`，epoch 或来源变化返回 `reset_required`，不能混拼。

MCP 历史读取分别发送独立请求，兼容仅含一个调用的 legacy batch；包含历史读取的多调用 batch 在任何工具执行前被拒绝。超大请求 ID 或错误包络也不得突破响应上限，超限返回有界的 `resource_limit_exceeded`，不能先输出半个成功对象。

live 和 archive 游标分域；首次读取按真实可用来源选择，续页保持原来源。live 转归档后必须从归档重新开始。空历史、未就绪、缺件、损坏、部分覆盖和授权失败分别表达；不能把失败包装成空页。

`coverage.state=partial` 保留原条目已截断、资源不可用或归档不完整等可见缺口。`complete` 只说明已取得的条目与资源未暴露缺口，不证明 Provider 原生历史已被完整采集。

## 权限与兼容

每一页和每一个正文块重新检查真实凭据、Task 访问和 Session 归属。OAuth 仅用于本范围的 Task 读取，不扩大 Controller 注册、上传、Bot/Test 或写入权限。历史读取不因原 claim 结束而改投新 Session。

Controller 每次 WebSocket 握手声明内容读取版本，能力只绑定该连接产生的新 fence。未声明的连接不收到新请求；重连未声明会清除旧能力。旧 Controller 的短条目可用既有显示接口读取，`display_budget_exceeded` 必须明确要求升级，不能作为完整原文。

归档读取保留权限、尺寸、摘要和格式检查。客户端只取页或块；服务端旧归档可能物化最多 64 MiB，归档句柄与相应预算保留至响应完成或取消。离线 Worker 不妨碍已有效归档的读取。

CLI 与 MCP 使用同一业务语义。文本逐行转义终端控制字符；JSON 保留正文或显式内容引用。MCP 公开严格 schema 并以协议测试验证，成功读取采用普通编码，不恢复共享运行时输出校验或通用读取字节准入。上述 256 KiB 限制只属于历史页与正文块。

实现机制见[历史读取设计](../design/task-session-history.md)，状态观察见[Session 观察规格](task-session-observation.md)。
