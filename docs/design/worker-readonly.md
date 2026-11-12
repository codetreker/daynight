# Worker 只读请求通道

## 结构与职责

[需求](../spec/worker-readonly.md)由独立的只读通道实现。`core/workerreadonly` 拥有连接、请求限额、身份绑定和结果准入；`service/worker` 组装凭证权限与所有者 Worker 观察；`server/worker` 负责 HTTP/WebSocket 编解码及关闭。目录枚举只在 CLI 的 `commands/worker/read-only/directory.ts` 内执行。

`service/worker.NewReadOnly` 接收同一应用 `service/oauth.Authenticator` 的
`RecheckAPIAccess` callback。原 PAT / Session 分支仍在 `WriteIdentity` 中复核当前凭据；
OAuth 用户分支在该 callback 外独立执行 `WriteCredentialFamily`，以固定
`PublicOrigin + "/api/v1"`、`daynight:api`、`societas-bot` binding 调用 `LockAccess`。
只有确认完成才准入；不存在、到期、撤销或 binding 不符返回 unauthenticated，
数据库、清理及结果未知保留原错误链和完成语义；这些错误链中的 deadline 或 cancellation
不被 Broker 归一化成普通 timeout / cancelled。已选取的完成结果先保留其授权失败，再判断
调用方 context；普通成功结果仍在取消或到期后拒绝返回，等待阶段仍按原 select 处理取消。回查只使用真实 user UUID 与 access UUID，
不签发凭据，不重复记录 credential usage。MCP family 不取得一般 readonly 请求权限。

Broker 在请求派发前、Worker 结果交付时和用户返回前都使用保存的原请求者 Principal 回查，
生产者上下文中的 Worker PAT 不替代该用户 access。随后沿用 owner、online、Provider、
连接与能力代次检查。Worker WebSocket 始终要求原 PAT；用户 OAuth 只授予其原用户权限。
应用先构造 OAuth 实例再注入 Broker，并在使用前设置同一 PublicOrigin；两者共享原数据库，
不新增连接池、后台服务或关闭所有权。

该通道不借用任何现有助手 Session，也不创建持久执行记录。Worker 运行时在既有所有者身份下建立连接，读取与助手默认目录相同的 `workingDirectory`。有效配置改变后关闭旧连接，下一连接产生新能力代次；已有任务 claim 和助手冻结配置不受该通道修改。

## 接口

协议名为 `daynight.worker-readonly.v1`。

| 接口 | 用途 |
|---|---|
| `GET /api/v1/me/workers/{workerId}/readonly/channel` | Worker 以 PAT 建立 WebSocket |
| `POST /api/v1/me/workers/{workerId}/readonly/requests` | 所有者提交有界查询，HTTP 请求保持到结果或失败 |

Worker 首帧为 `{type:"hello",protocol,capabilityGeneration,operations:["directory.list","model.list"]}`，其中能力代次为 UUID。旧 Worker 可只声明目录操作；服务端保存连接声明的操作，未声明的查询返回 unsupported。服务端生成连接 UUID 并返回 `ready`，其身份字段为 `ownerUserId`、`workerId`、`connectionId`、`capabilityGeneration` 和 `protocol`。

HTTP 请求包含 UUID `requestId`、`operation:"directory.list"`、`input`。目录输入的 `path`、`filter`、`showHidden`、`cursor`、`limit` 均可省略；`null` 不等同省略。默认值分别为 Worker cwd、空筛选、false、第一页和 100 项。路径最多 4,096 UTF-8 字节，筛选最多 256 字节，游标最多 4,096 字节。

服务端转发 `type:"request"`，附上全部身份字段、原请求字段和按操作确定的 `timeoutMs`：目录为 10000，模型为 30000。Worker 的 `type:"result"` 保留同一身份及请求 ID，并且恰好包含以下之一：

- `result:{path,parentPath,entries:[{name,path}],nextCursor}`；父目录与游标可以为 `null`。
- `error:{code,message}`；错误码见需求，消息不包含原生异常或凭证。

业务结果和 Worker 错误均由 HTTP 200 返回完整结果信封；认证、输入及路由失败使用既有 API 错误响应。取消帧为 `type:"cancel"` 和原身份、请求 ID。HTTP 取消使服务端撤销待处理请求并通知 Worker；旧响应不得重新创建请求。响应交付时的调用方凭证错误只结束对应 HTTP 查询；Worker 凭证或协议错误仍会使共享通道失效。目录结果使用保留已准入 JSON 字节预算的响应编码，避免 HTML 字符转义放大合法页面。

## 生命周期与限额

服务端按 `(ownerUserId,workerId)` 保存进程内连接。新的连接替换旧连接并使其所有待处理请求失败。Worker 每次重连都生成新能力代次；结果必须完整匹配当前连接。凭证定期复核和 ping 每 5 秒进行，握手最多 10 秒，Worker 在 30 秒内未收到帧或 ping 时重连。

HTTP 入口从正文读取开始计入操作期限和并发容量：目录为 10 秒，模型为 30 秒。正文读取最多 5 秒，响应写入另受目录 15 秒、模型 35 秒的 socket 期限约束。转发操作使用独立的截止时间上下文，HTTP 响应保留调用方原上下文，使操作超时后仍能返回 HTTP 504 和 `timeout` 错误正文。调用方已断开时不交付结果。单个请求在权限复核时取消或超时，只结束该请求；不能将调用方上下文错误作为 Worker 凭证失效证据而关闭共享连接。每个连接最多接受 4,096 个不同请求 ID；已结束或取消的 ID 不可复用，耗尽后重新连接。

HTTP 查询没有跨实例结果存储或跨服务实例转发。部署多个服务实例时，Worker 和查询必须路由至同一实例；没有本实例连接时不能宣称已经连接或返回其它机器目录。进程重启后能力必须重新握手，不从旧运行记录推测仍在线。

目录游标用实例内随机密钥签名，绑定规范化路径、目录设备/inode、mtime/ctime、筛选和隐藏选项以及上一页末项。每页流式扫描当前层并只保存 `limit+1` 个候选。结果太大时缩减当前页，并为剩余项提供游标；无法返回一个条目时明确拒绝。

Node 文件系统调用没有可依赖的原生取消机制。浏览器在超时或取消时立即拒绝调用方，但保留后台占用计数，直到原调用及句柄关闭结束。传输层同样保留未结束执行的容量，防止取消后不断开启新工作。关闭通道会取消全部请求，迟到完成不会发送到替代连接。

## 消费者与扩展

Web 的 `api/worker-readonly.ts` 提供 `requestWorkerReadonly` 与 `browseWorkerDirectory`，校验响应用户、Worker、请求 ID、身份字段和容量。账号认证代次改变或调用方 AbortSignal 取消时拒绝返回结果。调用方切换 Worker 或关闭浏览页时必须取消原 signal；可附加当前表单代次判断。只读操作不自动重试。

CLI 的 `WorkerReadOnlyOperations` 是类型化操作扩展点。[模型发现](worker-model-discovery.md)拥有 `model.list` 的输入、结果、原生探测和分页快照；通道不接受任意命令字符串。Go 保存待处理请求的操作和 Provider，据此校验返回值；不能将任意已认证结果当作目录或模型结果。Web 的 `discoverWorkerModels` 同样保留信封并复核 Provider。目录 UI 与模型具体选项不属于通道的通用机制。

## 验证入口

CLI 目录与连接回归位于 `packages/daynight/test/commands/worker/read-only/`，Web 客户端回归位于 `packages/daynight-web/tests/worker-readonly-api.test.ts`。服务端 `core/workerreadonly` 检查业务路由，`service/worker` 使用真实 Broker 检查三阶段原请求者回查，并以真实 family 数据验证正常返回与撤销；`service/oauth` 检查固定 binding、事务完成及错误链。应用装配测试检查共享 OAuth 实例和配置的 audience。`server/worker/readonly_test.go` 使用真实 HTTP/WebSocket 和身份数据库检查认证、取消、请求正文期限及关闭。`cmd/integration_tests` 的正常流程验证完整应用的 Worker PAT 通道、HTTP 派发和结果返回。

跨端验收需要先在仓库根目录运行 `pnpm build`，然后在 `packages/daynight-server/` 中执行：

```bash
source scripts/env.sh
# DAYNIGHT_TEST_DATABASE_URL must identify an isolated PostgreSQL database.
go test -race -tags worker_readonly_acceptance ./internal/server/worker \
  -run '^TestReadOnlyNativeWorker(Directory|Encoding)Acceptance$' -count=1 -timeout=90s -v
```

目录隔离验收启动两个独立 Node 只读通道进程，使用真实目录、HTTP/WebSocket、身份存储和文件摘要比较。编码验收通过真实 Worker 和 HTTP 响应流调用生产 Web typed client，检查包含 HTML 字符及 Unicode 分隔符的目录页、字段完整性和实际字节上限。它不启动任务调度或原生 Agent，不代替生产部署、完整 Worker runtime 或模型发现验收。普通 Go 门禁不依赖 CLI 构建产物，因此该跨语言场景使用单独 build tag。
