# API 输入与资源的候选限额

## 状态和适用范围

服务提供可独立调用的纯候选准入和编码计量，供领域在线接线使用。业务额度仍由各领域实现接入，传输额度的实际状态见下文。不得静默截断、丢弃或改写存量数据；不设离线扫描或统一启用门槛。

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

## 传输额度

普通 REST JSON body 上限为 1 MiB，普通 MCP body 为 4 MiB；附件实际文件的 5 MiB 额度由附件入口接入。raw query、request-target、HTTP/1 请求行与头合计上限分别为 24 KiB、48 KiB、64 KiB，通用 encoded cursor 为 16 KiB；既有更小的专用 cursor 限制继续适用。普通短 body 从读取开始限时 15 秒。附件和归档分别提供 60 秒和 120 秒读取期限合同，由各自入口接入。Session、SSE、WebSocket 和长轮询沿用自己的协议及生命周期，不套用普通 body 期限。认证后的 MCP 预读每实例最多 16 个，独立于工具预算。

## 输出与剩余范围

普通 Task 单项候选响应预算为 512 KiB，Task 同步为 64 MiB。已有分页响应预算分别为 Team/Project/Task 4 MiB、Worker/Bot 8 MiB、附件 metadata 2 MiB、邀请/PAT 256 KiB、Search 2 MiB。预算包括实际协议外壳与必要换行。现有完整目录保持完整；本合同不新增目录分页或累计存储配额。目录和历史记录仍可能增长。

容量失败应包含字段、实际计量、上限和单位，不包含原值或秘密。业务在线拒绝、事务时序和占用控制由各自业务实现及其合同决定。
