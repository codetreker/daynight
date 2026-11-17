# 历史终端 Session 服务端

## 责任与协议选择

服务端保留已上传 Herdr 录像的只读目录、状态和正文。历史记录保留原来的
`backend` 和 Session 身份，不转换为 Web timeline；读取不连接 Worker，也不恢复、
控制或补传旧执行。未上传的录像仍不可用。独立 Web/Controller Session 的 v1
接口和归档写入继续使用原协议。

历史 HTTP 请求以 `Daynight-Session-Protocol: daynight.session.v2` 显式选择 v2；
无选择使用 v1，未知或矛盾的选择被拒绝。服务端不再接入 v2 注册、实时状态、
Worker channel、消息、录制证据、恢复和归档写入或收尾，也不广告实时 Herdr
能力。仍有内部引用的活动终端实现不构成 HTTP 入口。

## 历史读取

以下路径以 `/api/v1/projects/{projectId}/tasks/{taskId}/sessions` 为前缀，
要求 v2 选择和当前项目访问权限：

| 方法与相对路径 | 结果 |
|---|---|
| `GET /?cursor=...&limit=50` | Task 历史列表，1–200 条，`nextCursor` 分页，包含 Web/Herdr |
| `GET /{sessionId}/archive` | 归档状态；未上传的录像不可用 |
| `GET /{sessionId}/archive/content` | 已验证的原始 JSON 字节，仅 ready 可读 |

历史分页按 created_at/id 稳定排序，不依赖当前 claim。目录、状态与正文读取只
解码持久 `terminal_state` 中的 envelope、owner、运行账本、录制证据和
finalization 身份；未使用的在线控制字段不进入只读记录。成员撤销后拒绝读取；
任务删除后拒绝页面和内容访问。普通附件的替换或删除不能改变权威归档。

正文读取打开持久 `object_path`，核对原 Session 身份、文件大小与 SHA-256，
直接发送存储的原始字节，不重新编码 JSON。读取沿用原权限作用域、归档驻留许可
和发送期限；已准入的正文占用持续到发送结束。旧 JSON 和归档字节不迁移。
[共享归档设计](task-session-protocol.md#归档操作占用)拥有占用与生命周期规则，
[Session v2 契约](session-v2-contract.md)拥有历史格式和摘要规则。
