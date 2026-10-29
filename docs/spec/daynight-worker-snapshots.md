# Worker 运行快照接口

本文定义账号级 Worker 最新运行快照的服务端协议。[设计](../design/daynight-worker-snapshots.md)拥有事务、查询与存储机制；[任务认领协议](../design/daynight-worker-claims.md)继续拥有任务执行归属。

Worker 快照是认证客户端主动提交的观测。服务端校验格式、账号及任务归属，不执行系统采集或启动执行进程。硬件和版本数据是客户端提供的展示信息，机器名称及 machine.id 不构成认证身份。

## 资源与认证

| 方法 | 路径 | 成功结果 |
|---|---|---|
| POST | `/api/v1/me/workers/{workerId}/report` | `200`，`{observedAt,lastReportedAt}` |
| GET | `/api/v1/me/workers` | `200`，`{observedAt,items,nextCursor}` |
| GET | `/api/v1/me/workers/{workerId}` | `200`，`{observedAt,worker}` |

三个端点及方法拒绝路径均要求认证，沿用 PAT、浏览器会话和 Cookie 写入的精确主站 Origin 规则。响应为 `no-store`，包含认证的 `Daynight-User-ID`。GET 同样支持 HEAD；其他方法返回带 Allow 的 405。

Worker 资源键为认证账号与规范 workerId 的组合。workerId、machine.id 和任务引用 ID 必须是带连字符 UUID，并由服务规范化。body 不接受 userId。其他账号、未知或超过近期窗口的 Worker 详情统一为 `404 not_found`。

## 上报结构

请求为 UTF-8 `application/json`，最多 1 MiB。必须是单个对象；各层字段名区分大小写，未知字段、重复键、缺少必填字段、错误分支字段及尾随 JSON 均为 `400 invalid_input`。报告端点不接受查询参数。

所有顶层字段必填：

| 字段 | 内容 |
|---|---|
| machine | `{id,name}`；id 为 UUID，name 为非空白文本 |
| platform | `linux`、`macos` 或 `windows` |
| workingDirectory | 非空白的工作目录文本，说明磁盘数据的作用范围 |
| sampledAt | 客户端采样时刻 |
| os | Probe，成功值为 `{type,release,version,arch}`，四项均为非空白文本 |
| cpu | Probe，成功值为 `{model,logicalProcessors,usagePercent}` |
| memory | Probe，成功值为 `{usedBytes,totalBytes}` |
| disk | Probe，成功值为 `{availableBytes,totalBytes}` |
| versions | `{daynight,herdr,codex,copilot}`；daynight 为非空白版本文本，其余为下述探测结果 |
| taskInventory | 显式 null，或完整 `{observedAt,claims}` 对象 |

文本必须是无 NUL 的有效 UTF-8。日期使用有效、非零的 RFC3339 时刻，响应转换为 UTC。客户端 sampledAt、checkedAt 和 inventory observedAt 只说明数据来源，不决定在线状态。

### 探测结果

每个 Probe 仅允许所处状态的字段：

| 状态 | 必填结构与适用范围 |
|---|---|
| ok | `{state:"ok",checkedAt,value}` |
| error | `{state:"error",checkedAt,code}` |
| not_installed | `{state:"not_installed",checkedAt}`，仅 Codex/Copilot |
| not_running | `{state:"not_running",checkedAt}`，仅 Herdr |

error 的 code 仅接受 `not_found`、`permission_denied`、`timeout`、`command_failed`、`invalid_output`、`invalid_sample`、`out_of_range`、`io_error`、`unavailable`。成功不能携带 code，失败不能携带 value，特殊安装/运行状态不能携带两者。

CPU model 是非空白文本，logicalProcessors 是 `1..9007199254740991` 的整数，usagePercent 是有限的 `0..100` 数值。容量字段是 `0..9007199254740991` 的整数；usedBytes、availableBytes 不超过对应 totalBytes。整数条件按 JSON 数值含义判断，不接受非整数或超出可精确表示范围的值。

版本探测的成功值为非空白字符串。未安装、未运行和检测失败是独立结果，不以 null 或空字符串代替。某项探测为 error 不影响其他有效字段的保存，也不使一份格式正确的机器报告失效。

### 任务清单

非 null 的 taskInventory 必须包含有效 observedAt 和显式 claims 数组；空数组表示已知无任务，null/missing claims 无效。每项仅包含必填 `{projectId,taskId,claimId}`，同一规范化 taskId 不得重复。

服务端根据这些引用读取当前任务，只接受认证账号与 workerId 拥有的相同 active claim，且 task 为 in_progress、未删除、账号仍有项目权限。任务标题、项目名、status、phase 和 agent 均取服务端数据，客户端不能提供这些权威字段。已完成、已撤回、转交或失权的普通竞态省略对应引用；不存在与不可访问的目标不通过省略差异泄漏给调用者。

报告发送的是完整观测清单，不按 maxConcurrent 截断。恢复清单可以大于当前并发设置；既有 1 MiB 传输上限仍适用，超限明确失败。

## 最新快照与时间

一次有效报告原子保存服务端 observation 时间、telemetry 和规范化任务快照。lastReportedAt 是数据库采集的报告 observation，不是客户端时刻；迟到的较旧 observation 不能覆盖较新内容或使 lastReportedAt 倒退。响应 observedAt 是服务端时间样本。

| taskInventory 情况 | taskObservationState 与任务结果 |
|---|---|
| null，尚无已知快照 | unavailable，taskObservedAt 和 activeTaskCount 为 null，tasks 为 [] |
| null，已有已知快照 | stale，保留原任务与观测时刻 |
| 完整清单，包括 [] | observed，保存本次规范化任务；空结果的 activeTaskCount 为 0 |

连续 null 不会把从未同步的 Worker 变成已知空闲。inventoryObservedAt 是客户端清单来源时间；taskObservedAt 是服务端生成该任务快照的时间；lastReportedAt 是本次机器报告时间。stale 的硬件数据可以较新，任务观测仍带原时间。

读取不会刷新 lastReportedAt。近期条件为 `lastReportedAt >= observedAt - 72h`，恰好 72 小时仍可见。在线状态由 `observedAt - lastReportedAt < 120s` 派生，恰好 120 秒为 offline；接口提供时间事实，不持久化或返回可续活的在线标记。

离线和移出近期列表只影响观测可见性，不释放/撤回 claim、不改变 task 状态、版本、执行计时或本机数据。新资源只由有效报告登记，不从旧 claim 或任务更新时间合成活跃记录。

## 列表与详情

列表只接受 limit 和 cursor；limit 默认 50，范围 1–100。显式空值、重复或未知参数为输入错误。items 始终为数组，nextCursor 为字符串或 null。

每项摘要包含：

```text
workerId, machine, platform, lastReportedAt,
taskObservationState, taskObservedAt, activeTaskCount
```

activeTaskCount 是当前有权限访问的快照任务数。它不是实时任务归属统计；unavailable 为 null，observed/stale 为过滤后整数，包括 0。列表不复制完整 telemetry。

详情 worker 在摘要字段之外包含 telemetry、inventoryObservedAt、tasks。telemetry 使用报告中的结构，tasks 始终为数组；每项为 `{projectId,taskId,claimId,title,projectName,status,phase,agent}`。status 和 phase 是上报时的规范化值；agent 沿用当前 claim 枚举，包含 codex、copilot、claude。

每次读取都按当前项目成员关系和 task 未删除状态过滤保存的任务，摘要计数与详情数组使用同一可见性规则。当前 claim 后续完成或转交不会抹掉仍有权限访问的旧观测；被删除或失去项目权限的任务及其旧标题不再返回。任务链接读取的当前详情与历史观测各有其时间含义。

分页使用不可变 `(created_at,worker_id)` 位置，cursor 绑定资源类型和认证账号。持续更新的 lastReportedAt 不作为位置；换账号或不匹配的 cursor 返回输入错误。每页是各自一致的读取快照，跨页期间的新注册或重新活跃记录可在下一轮遍历出现。

## 错误与可观察结果

格式与约束错误沿用 `400 invalid_input`，未认证为 401，未知/他人/超窗详情为 404，存储失败为清洗后的 500。失败响应保留既有 requestId，SQL、连接串、完整遥测、原生命令输出和凭据不进入诊断。

必须能够观察账号隔离、null/空/旧清单、部分采集错误、乱序报告、当前权限变化、完成后的历史任务、时间窗口和稳定分页。存储失败保留错误链，不能伪装成成功或空列表。
