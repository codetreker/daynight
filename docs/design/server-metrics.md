# 服务端运行时指标

`daynight-server` 使用独立 HTTP listener 暴露 Prometheus 指标；业务 listener
不注册 `/metrics`。部署者显式设置 `DAYNIGHT_METRICS_LISTEN_ADDR` 才启用该
能力，空值禁用。接口没有应用身份认证，网络命名空间、绑定地址和网络规则负责
限定抓取者。配置和操作示例由[服务 README](../../packages/daynight-server/README.md#metrics)
维护。

## 组装和采集

启用时，每个 `service.App` 持有自己的 `prometheus.Registry`，并注册官方默认
GoCollector 和启用 `ReportErrors` 的 ProcessCollector。禁用时 registry 为 nil，
不注册或采集指标。实例不使用全局默认 registry；注册失败使组装失败，不能以
已有 collector 代替。service 持有 registry 和资源，server 接收 registry 并负责
HTTP 暴露；采集器不持有数据库关闭权。

官方 `go_*` 和 `process_*` 描述运行时及当前进程，具体集合取决于平台和构建方式。
Linux 进程指标需要可读取 `/proc`；不支持或读取失败由采集错误显式呈现，不以
零值代替。promhttp 自身的错误计数属于抓取诊断，不是业务请求指标。

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
