# API 输入与资源的候选限额

## 状态和适用范围

服务提供可独立调用的纯候选准入和编码计量，供存量检查及后续在线接线使用。除原本已生效的规则外，本文列出的候选额度尚未改变在线请求、存储读取或文件发布行为。启用前必须检查存量并处理超限记录；不能静默截断、丢弃或改写数据。

文本字段按解码后的 UTF-8 字节计量；Team 和 Project 名称还按 Unicode code points 计量。JSON 额度计入实际编码结构和转义；REST `Encoder` 的终止换行计入响应额度，属性值本身不计属性名、传输外壳或换行。上限值可接受。字段、集合和所属资源额度同时成立。

## 候选业务额度

| 对象 | 上限 |
|---|---:|
| Task/Step 标题、描述 | 分别 1 KiB、64 KiB |
| Task 完整依赖集合 | 15 项，external 为其子集 |
| 每个规范化属性值 | 8 KiB |
| pullRequests 的 url、title | 分别 2 KiB、1 KiB |
| 属性 worker 的 machine.name、nativeSessionId | 各 256 bytes |
| 属性 worker 的 herdr session、workspaceId、paneId | 各 128 bytes |
| 附件实际内容 | 5 MiB |
| Team/Project 名称 | 256 code points 且 1 KiB |
| Project repoUrl | 4 KiB |
| Profile identity ID、name、email | 各 1 KiB |
| Profile avatarUrl、完整编码 | 分别 512 KiB、1 MiB |
| UniAuth 响应、登录 returnPath | 分别 2 MiB、4 KiB |
| 未完成登录 | 每浏览器 5 条，全服务 10000 条 |
| 每用户 active Worker | 100 个，120 秒窗口 |
| Worker machine.name、版本、native model | 各 256 bytes |
| Worker workingDirectory、native arg | 各 4 KiB |
| Worker OS type、arch、release、version | 分别 64、64、256、1024 bytes |
| Worker CPU model | 512 bytes |
| Worker native args、projects、claims、observation items | 分别 128、128、256、1024 项 |
| Worker telemetry、configuration、完整单项编码 | 各 4 MiB |
| Worker maxConcurrent、pollIntervalMs、recoveryLimit | 分别 1–64、1000–60000、0–10 |

现有附件 path 1024 code points、contentType 2048 bytes，以及 Steps、Thread 和 Search 的专用额度继续由各自合同拥有。属性权限、结构、原有文本合法性和身份校验独立于容量检查；只读属性不会因共用额度获得公共写权限。各属性独立计量，不能把它们合并为单个 8 KiB 对象预算。

## 传输候选额度

普通 REST JSON body 保留 1 MiB，普通 MCP body 保留 4 MiB；附件继续通过现有分块流程传输，实际文件候选额度为 5 MiB。候选 raw query、request-target、HTTP/1 请求行和头分别为 24 KiB、48 KiB、64 KiB，通用 encoded cursor 为 16 KiB；既有更小的专用 cursor 限制继续适用。普通 JSON body 读取期限为 15 秒，附件和归档 body 分别为 60 秒和 120 秒。Session、SSE、WebSocket 和长轮询沿用自己的协议及生命周期，不套用普通 body 期限。一般 MCP 输入的实例并发候选上限为 16；新传输限额、期限和并发控制尚未启用。

## 输出与剩余范围

普通 Task 单项候选响应预算为 512 KiB，Task 同步为 64 MiB。已有分页响应预算分别为 Team/Project/Task 4 MiB、Worker/Bot 8 MiB、附件 metadata 2 MiB、邀请/PAT 256 KiB、Search 2 MiB。预算包括实际协议外壳与必要换行。现有完整目录保持完整；本合同不新增目录分页或累计存储配额。目录和历史记录仍可能增长。

容量失败应包含字段、实际计量、上限和单位，不包含原值或秘密。实际在线拒绝、事务时序、传输期限及占用控制仍由各自业务实现及其合同决定。

## 存量检查与启用门槛

启用候选在线限额前，操作方必须停止所有旧规则数据库和文件 writer，并在同一持续静止窗口内使用拟部署的干净源码版本执行只读检查。检查覆盖已删除但仍保留的记录、Task 和 Step、属性、组织与 Profile、Worker 状态和活跃数、附件及各自命名空间中的归档和 transfer 文件。文件只取 stat，不读取正文。未过期的旧 pending login 必须自然消费或到期，不能伪造浏览器归属。

检查使用只读一致快照，但快照和维护锁都不能证明 writer 已停止。只有完整扫描、没有违规或不确定项、来源和数据源匹配且仍处于同一静止窗口的报告才能作为启用依据。报告非空时由资源 owner 明确处理映射；检查不改写或删除数据，也不驱逐 Worker。先备份并完成经授权的收敛，复核每个 owner 的 active Worker 不超过 100，再切换全部写入入口。新源码、不同数据库或存储根、窗口中断均要求重新检查；报告必须可信保管。

报告为有界 JSONL，包含源码、策略和规范摘要，数据库和存储根身份、快照和观察时间、检查计数，以及无正文的违规或不确定项。候选原始输入最多 8 MiB，单候选规范化输出最多 32 MiB；Steps 集合按其 64 MiB 业务预算流式计量。元数据批次最多 100 条且不超过 64 KiB，单个定位信息最多 8 KiB；每条报告最多 16 KiB、完整报告最多 64 MiB 并预留终止摘要。预算耗尽、取消、数据或文件错误都不能产生 clear；无法在预算内判断规范化值时必须报告不确定，不能把原始长度当作业务违规。需要保存为附件时按记录边界拆为不超过 4 MiB 的块并记录顺序、数量和 SHA-256。操作方法与报告字段见 [server 指南](../../packages/daynight-server/README.md#input-limit-inventory)。
