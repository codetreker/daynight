# Worker 只读请求通道

## 结构与职责

[需求](../spec/worker-readonly.md)由独立的只读通道实现。`core/workerreadonly` 拥有连接、请求限额、身份绑定和结果准入；`service/worker` 组装凭证权限与所有者 Worker 观察；`server/worker` 负责 HTTP/WebSocket 编解码及关闭。目录枚举只在 CLI 的 `commands/worker/read-only/directory.ts` 内执行。

该通道不借用任何现有助手 Session，也不创建持久执行记录。Worker 运行时在既有所有者身份下建立连接，读取与助手默认目录相同的 `workingDirectory`。有效配置改变后关闭旧连接，下一连接产生新能力代次；已有任务 claim 和助手冻结配置不受该通道修改。

## 接口

协议名为 `daynight.worker-readonly.v1`。

| 接口 | 用途 |
|---|---|
| `GET /api/v1/me/workers/{workerId}/readonly/channel` | Worker 以 PAT 建立 WebSocket |
| `POST /api/v1/me/workers/{workerId}/readonly/requests` | 所有者提交有界查询，HTTP 请求保持到结果或失败 |

Worker 首帧为 `{type:"hello",protocol,capabilityGeneration,operations:["directory.list"]}`，其中能力代次为 UUID。服务端生成连接 UUID 并返回 `ready`，其身份字段为 `ownerUserId`、`workerId`、`connectionId`、`capabilityGeneration` 和 `protocol`。

HTTP 请求包含 UUID `requestId`、`operation:"directory.list"`、`input`。目录输入的 `path`、`filter`、`showHidden`、`cursor`、`limit` 均可省略；`null` 不等同省略。默认值分别为 Worker cwd、空筛选、false、第一页和 100 项。路径最多 4,096 UTF-8 字节，筛选最多 256 字节，游标最多 4,096 字节。

服务端转发 `type:"request"`，附上全部身份字段、原请求字段和 `timeoutMs:10000`。Worker 的 `type:"result"` 保留同一身份及请求 ID，并且恰好包含以下之一：

- `result:{path,parentPath,entries:[{name,path}],nextCursor}`；父目录与游标可以为 `null`。
- `error:{code,message}`；错误码见需求，消息不包含原生异常或凭证。

业务结果和 Worker 错误均由 HTTP 200 返回完整结果信封；认证、输入及路由失败使用既有 API 错误响应。取消帧为 `type:"cancel"` 和原身份、请求 ID。HTTP 取消使服务端撤销待处理请求并通知 Worker；旧响应不得重新创建请求。

## 生命周期与限额

服务端按 `(ownerUserId,workerId)` 保存进程内连接。新的连接替换旧连接并使其所有待处理请求失败。Worker 每次重连都生成新能力代次；结果必须完整匹配当前连接。凭证定期复核和 ping 每 5 秒进行，握手最多 10 秒，Worker 在 30 秒内未收到帧或 ping 时重连。

HTTP 入口从正文读取开始计入 10 秒期限和并发容量，正文读取最多 5 秒，响应写入另受 15 秒 socket 期限约束。每个连接最多接受 4,096 个不同请求 ID；已结束或取消的 ID 不可复用，耗尽后重新连接。

HTTP 查询没有跨实例结果存储或跨服务实例转发。部署多个服务实例时，Worker 和查询必须路由至同一实例；没有本实例连接时不能宣称已经连接或返回其它机器目录。进程重启后能力必须重新握手，不从旧运行记录推测仍在线。

目录游标用实例内随机密钥签名，绑定规范化路径、目录设备/inode、mtime/ctime、筛选和隐藏选项以及上一页末项。每页流式扫描当前层并只保存 `limit+1` 个候选。结果太大时缩减当前页，并为剩余项提供游标；无法返回一个条目时明确拒绝。

Node 文件系统调用没有可依赖的原生取消机制。浏览器在超时或取消时立即拒绝调用方，但保留后台占用计数，直到原调用及句柄关闭结束。传输层同样保留未结束执行的容量，防止取消后不断开启新工作。关闭通道会取消全部请求，迟到完成不会发送到替代连接。

## 消费者与扩展

Web 的 `api/worker-readonly.ts` 提供 `requestWorkerReadonly` 与 `browseWorkerDirectory`，校验响应用户、Worker、请求 ID、身份字段和容量。账号认证代次改变或调用方 AbortSignal 取消时拒绝返回结果。调用方切换 Worker 或关闭浏览页时必须取消原 signal；可附加当前表单代次判断。只读操作不自动重试。

CLI 的 `WorkerReadOnlyOperations` 是类型化操作扩展点。增加模型发现时应新增明确的输入/输出校验与有界执行器，并更新协议能力，不接受任意命令字符串。目录 UI 与模型具体选项不属于本通道。

## 验证入口

CLI 目录与连接回归位于 `packages/daynight/test/commands/worker/read-only/`，Web 客户端回归位于 `packages/daynight-web/tests/worker-readonly-api.test.ts`。服务端 `core/workerreadonly` 检查业务路由，`server/worker/readonly_test.go` 使用真实 HTTP/WebSocket 和身份数据库检查认证、取消、请求正文期限及关闭。

跨端验收需要先在仓库根目录运行 `pnpm build`，然后在 `packages/daynight-server/` 中执行：

```bash
source scripts/env.sh
# DAYNIGHT_TEST_DATABASE_URL must identify an isolated PostgreSQL database.
go test -race -tags worker_readonly_acceptance ./internal/server/worker \
  -run '^TestReadOnlyNativeWorkerDirectoryAcceptance$' -count=1 -timeout=90s -v
```

该显式验收启动两个独立 Node 只读通道进程，使用真实目录、HTTP/WebSocket、身份存储和文件摘要比较。它不启动任务调度或原生 Agent，不代替生产部署、完整 Worker runtime 或模型发现验收。普通 Go 门禁不依赖 CLI 构建产物，因此该跨语言场景使用单独 build tag。
