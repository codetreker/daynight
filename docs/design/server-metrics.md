# 服务端运行时指标

`daynight-server` 使用独立 HTTP listener 暴露 Prometheus 指标；业务 listener
不注册 `/metrics`。部署者通过 YAML 的 `monitoring.metrics_listen_address`
或显式环境变量 `DAYNIGHT_METRICS_LISTEN_ADDR` 启用该能力，空值禁用。接口没有应用身份认证，网络命名空间、绑定地址和网络规则负责
限定抓取者。配置和操作示例由[服务 README](../../packages/daynight-server/README.md#metrics)
维护。

## 组装和采集

启用时，每个 `service.App` 持有自己的 `prometheus.Registry`，并注册官方默认
GoCollector、启用 `ReportErrors` 的 ProcessCollector 和该 App 的 PostgreSQL 池
collector。`Persistence` 从具体 backend 取得并保存 collector。禁用时 registry
为 nil，不注册或采集指标。实例不使用全局默认 registry；注册冲突使组装失败，
不能以已有 collector 代替。service 持有 registry 和资源，server 接收 registry 并负责
HTTP 暴露；采集器不持有数据库关闭权。

官方 `go_*` 和 `process_*` 描述运行时及当前进程，具体集合取决于平台和构建方式。
Linux 进程指标需要可读取 `/proc`；不支持或读取失败由采集错误显式呈现，不以
零值代替。promhttp 自身的错误计数属于抓取诊断，不是业务请求指标。

## 业务请求观测

Runtime 在绑定 listener 前向同一 registry 注册 `httpx.RequestMetrics`；注册冲突
使组装失败。禁用时不注册或观测。业务请求日志和指标共用 `ResponseRecorder`
以及退出时的 finalizer，位于 URI 限制、关闭准入和路由之前。它记录首个最终
status、提交时的 SSE 内容类型、成功 Hijack 和写入错误，并通过
`ResponseController` 与 `Unwrap` 保留流式响应和传输能力。Runtime 直接接收
`net/http` 的响应 writer；它的隐式写入和刷新在传输失败前提交 200，而任意自定义
writer 不提供通用提交状态查询。panic 分类基于原始值，随后沿用已有日志和
`ErrAbortHandler` 行为。请求退出时减少 in-flight 并记录一次计数和耗时；
metrics listener 不经过此包装。

Counter 使用 method、固定 route 模板、mode、status、outcome；Histogram 仅使用
method、route、mode，Gauge 无 labels。method 限定为标准方法或 `OTHER`，空
pattern 为 `unrouted`，不使用原始路径、query 或业务 ID。成功 Hijack 表示
`websocket`，提交的 `text/event-stream` 表示 `sse`，其余为 `http`。流式耗时
覆盖 handler 生命周期；普通 API 延迟查询需限定 `mode="http"`。异常优先级为
panic、abort、写入错误、取消、正常返回。未提交的异常使用 `none`，已提交的
status 保持不变。具体 family 名称、buckets 和运维查询口径由服务 README 维护。

## PostgreSQL 连接池观测

PostgreSQL collector 位于 store 实现，单次采集只读取一次 `Pool.Stat()` 本地
快照，不执行 SQL，也不拥有池的关闭权。连接状态使用固定的 `acquired`、`idle`、
`constructing` labels；其他池指标没有 labels。连接数和上限是 Gauge，获取、
取消及空池等待统计直接以累计 Counter 表达，耗时转换为秒。成功获取和空池等待
采用 pgx 的统计口径，取消的获取不计入成功获取或成功的空池等待。指标名称和
操作含义由[服务 README](../../packages/daynight-server/README.md#metrics)维护。

## HTTP 和生命周期

metrics listener 精确匹配 `GET`、`HEAD /metrics`；同一路径的其他方法返回 405，
其他路径返回 404。promhttp 处理内容协商并支持 Prometheus text 与 OpenMetrics，
响应提交前的 Gather 错误返回 500。响应提交后的编码或写入失败只能停止后续编码并
记录错误，采集者仍须检查响应完整性。并发抓取限制为两个，超出时返回 503。
不使用 handler timeout 或共享 Gather：同步的请求生命周期覆盖实际采集，避免
HTTP 响应结束后采集仍在使用 App 资源。socket 的读头/读/写/空闲超时分别为
5/5/10/60 秒，socket 超时本身不证明 collector 已退出。

Runtime 在 App 启动前绑定业务 listener 和启用的 metrics listener；后者绑定失败
回滚前者。任一 Serve 非预期退出触发整体关闭并回收两个 Serve 结果。关闭时两个
HTTP server 在同一预算内并行停止，metrics 有独立的准入和活动请求跟踪。只有
业务处理、relay、App 工作以及实际 metrics 抓取全部退出后才能关闭 App；超时后
强制关闭连接也不会把未退出的 collector 当成已完成。未完成的关闭保留状态以便
重试，并保留原始错误。

## 部署

[localhost](../../deployment/localhost/README.md) 和
[dev-ci](../../deployment/dev-ci/README.md) 中，server 共享 gateway 网络命名空间，
分别监听 `127.0.0.1:8787` 和 `127.0.0.1:8788`。Nginx 使用两个独立 TCP stream
转发业务与 metrics；Compose 的两个宿主端口均绑定 `127.0.0.1`。dev-ci 的宿主端口
由 Docker 分配，验证使用实际运行镜像和转发路径。仓库不配置采集平台或生产网络。
