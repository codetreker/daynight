# Worker 个人 prompt 服务端接口

三层 prompt 分别归属当前用户、当前用户与项目、当前用户与 Worker。项目普通成员可以编辑自己的项目 prompt；它不是共享项目设置。服务端按认证用户隔离正文。Worker 的配置报告可以在同一次响应中获取指定层的正文，不授予任务执行资格。实现机制见[设计](../design/worker-prompts.md)。

## 编辑资源

| 方法 | 路径 | 资源 |
| --- | --- | --- |
| GET、HEAD、PUT | `/api/v1/me/worker-prompt` | 当前用户 |
| GET、HEAD、PUT | `/api/v1/me/projects/{projectId}/worker-prompt` | 当前用户可访问的项目 |
| GET、HEAD、PUT | `/api/v1/me/workers/{workerId}/prompt` | 当前用户的已注册 Worker |

路径 UUID 必须规范，禁止查询参数。Worker 不要求在线或近期报告。PAT 和浏览器会话沿用现有认证；Cookie 写入要求精确主站 Origin。认证响应带 `Daynight-User-ID` 和 `Cache-Control: no-store`；错误带 requestId。其他方法返回 405 和 `Allow: GET, HEAD, PUT`。项目不存在、删除或失权以及 Worker 不存在或不属于当前用户返回 404；未配置不返回 404。

资源闭合且包含 `scope`、`scopeId`、`revision`、`text` 和 `updatedAt`。scope 为 `user`、`project` 或 `worker`，scopeId 为相应资源的规范 UUID。revision 为 `0..9223372036854775807` 的规范十进制字符串。未配置返回 `revision:"0"`、空正文和 `updatedAt:null`；正版本有 RFC3339 时间，正文可以为空。读取不创建记录。单资源响应预算为 6 MiB + 4 KiB。

PUT 必须且只能提供 `{expectedUserId,revision,text}`。expectedUserId 为草稿所属用户的规范 UUID，与当前认证用户不符时返回 409 `identity_mismatch`，不读取或写入资源。先检查版本，再比较正文：版本陈旧返回 409 `version_conflict`，相同版本和正文为 no-op；真实变化递增版本，最大版本的真实变化返回 409 `version_exhausted`。首次保存非空正文创建版本 1；首次保存空正文为 no-op。清空保留记录并递增版本，防止旧版本重新有效。

正文原样保存，不 trim 或解释。允许空、多行、普通空白及标记；拒绝无效 UTF-8、孤立 surrogate、NUL、除 TAB/LF/CR 外的 C0、DEL 和 C1 控制字符。严格 JSON 拒绝重复、未知、缺失或 null 字段、错误类型和尾随数据。完整 PUT JSON 上限 1 MiB，超过返回 413 `payload_too_large`；其他非法输入返回 400 `invalid_input`。事务结果未知不能当作未写入，读取只能核对当前事实，不能证明原请求已提交。

## 配置报告同步

原报告正文仍为 1 MiB 上限。无配置标记及 `Daynight-Worker-Configuration: 1` 保留各自既有合同。协议 2 发送 `Daynight-Worker-Configuration: 2`，并在单个 `Daynight-Worker-Prompts` header 中携带 ASCII JSON selector 数组；原报告 JSON 不增加 prompt 字段。header 最多 1024 字节，数组最多三个不同 key，空数组有效。重复 header、非 ASCII、重复或未知字段、重复 key、非法 UUID/revision、尾随 JSON、空 header 及协议与 header 的无效组合在调用报告写入前以 400 拒绝。

selector 为 `{key,knownRevision}`，key 为 `{scope:"user"}`、`{scope:"worker"}` 或 `{scope:"project",projectId}`；`knownRevision` 是规范版本字符串或 null。null 表示没有已确认正文，`"0"` 表示已确认未配置。user 与 worker 的实际 ID 由认证身份和路径决定。

协议 2 的回执保留原 `observedAt`、`lastReportedAt` 及 configuration 的 `desired`、`observationRevision`、`observationAccepted`，并增加同序同数的 `prompts`。每项携带原 key 和以下闭合状态之一：

| status | 附加字段 | 含义 |
| --- | --- | --- |
| `value` | `value`：完整资源 | 版本未知或与当前不同，包括虚拟空资源 |
| `unchanged` | `revision` | 权限通过且已知版本与当前相同 |
| `unavailable` | 无 | 项目不存在、删除或明确失权 |
| `error` | `error`：`unavailable` 或 `timeout` | 只读批次暂时失败 |

原报告确认提交后才读取 prompt；只读批次失败仍返回原报告确认及每个 key 的安全错误。原报告失败不读取 prompt。只读快照受请求取消和最多五秒期限约束；查询不聚合账号项目全集。协议 2 响应预算为 48 MiB，完整传输最多三份合法正文，不截断。正文和原始数据库错误不写入诊断。
