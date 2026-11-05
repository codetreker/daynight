# Herdr 持续录制与归档收尾

本文拥有 macOS Worker 的采样、本地源、最终归档及保留资源机制。[运行生命周期](herdr-worker-lifecycle.md)拥有原进程身份和停止证明，[输入仲裁](herdr-input-arbitration.md)拥有输入授权；[Session v2 契约](../spec/session-v2.md)拥有交换格式。终端画面是可见屏幕采样，不是完整 PTY 输出或无限 scrollback。

## 采集与本地责任

运行准备时在 Worker 数据目录创建 `herdr-recordings/<sessionId>/`，持久保存原 owner、claim、Session 和每代 recording responsibility。新目录逐级创建并同步自身及父目录，确认祖先目录项持久后才创建子目录；既有目录也同步父目录，以覆盖先前 mkdir 成功但父目录同步失败的重试。同步失败中止准备，不能发布已保存画面。服务端确认同一责任后才启动原生输入。采集段由 lifecycle journal 分配，采样器消费该段；采样在首条 assignment 前启动，不依赖 viewer 或网络投递。

每轮使用原私有 daemon 的 `session.snapshot`、`pane.process_info`、PTY 尺寸与 `pane.read(source=visible,format=ansi)`，读取前后核对原运行、workspace、pane、terminal、shell 和几何。观察不 attach、不 resize、不恢复 agent。ANSI 只保留文本及 v2 白名单样式，OSC、DCS 和其他控制数据不进入网页可执行上下文。

每轮结束至少等待 350ms。不同完整画面先提交 selected 意图，再写临时帧、fsync、原子 rename、同步父目录，最后登记文件及索引；完成登记后才发布 `recorded=true`。索引采用带哈希链的 append journal，每次提交同步落盘。相同内容与尺寸保留一个帧，观察区间每 5 秒或正常停采时 checkpoint。重启只承认持久边界，重新采集创建新段并保留 restart gap；未 checkpoint 的持续时间不延长上一画面。恢复尚未持久结束的段时，即使 claim 已终态且不会再启动采样，也保留 `checkpoint_lost` 缺失标记或既有未结束 gap；该标记不声称观察了停机期间的画面，也不估算停机持续时间。已有持久 `segment_end` 则读回原结束边界，不增加中断；该代已记录 `recording_limit` 且源已封段时，即使 lifecycle 尚未提交停止意图，恢复也不能重新累计该段时长或改写其结束边界。普通 complete 源不会因无法分配新段而获得这一限额恢复例外；该路径继续拒绝恢复，不能隐去后续未观察区间。源封段与 lifecycle 停止分别持久化，后者滞后只需收敛原边界；重复恢复保持幂等。恢复段末单独依据 journal 已持久覆盖的位置，包含帧、checkpoint、gap 起点和已提交的 `gap_end`；它不能退回最后一帧的观察位置。gap 结束已提交、下一帧尚未选择时，新的缺失标记接在已结束 gap 之后，原 gap 和帧索引都保持不变。没有墙钟字段的 `gap_end` 只推进单调时间范围，不推算新的墙钟时间。

restart 边界由 hash-linked journal 中已登记的 run 与 segment 关系投影，覆盖相邻每一代及同代相邻采集段。只完成准备、尚未打开采集段的空代也有原 recording responsibility；其边界端点保留 `segmentId=null`，不能跳过该代直连前后的实际段。segment 事件携带的原前段关联仍须核验，不能以重新生成边界掩盖错误关联。投影不新增观察时长、画面或停止证明，不改写旧 journal；重开与重复关闭保持同一结果。空代边界和采集中断共同计入 gap 数量及 metadata 预算。

录制与输入共享原 Session 身份，但各自承担持久责任。nativeSessionId 从未知变为已知时，同代录制段只作单向身份补齐，不改变帧和已关闭段的观察边界。selected 文件未登记时仅可按原意图核验并恢复；已登记文件缺失、原始字节 hash 不符、错误归属或损坏 journal 均为 failed，不能静默删帧或转换为 unavailable。

## 有界退化和实时投递

单帧最多 256 KiB，尺寸每维最多 1000，最多 100000 个不同帧、1000 个段、1000 个 gap。最终 JSON 最多 64 MiB，其中 `files` 与 `index` 的精确序列化预算为 60 MiB，metadata 为 4 MiB；嵌入 JSON 字符串的转义开销计入预算。到达限制停止新增录制，以预留末尾 gap 记录截断，保留已有帧并形成 partial。记录磁盘失败不能承诺可用 partial，需保留 failed 责任。恢复采集时若已无新段预算，保留原活动终端绑定，以截断 gap 结束录制，不中止业务 agent；后续新运行必须在启动任何原生资源前通过段、代次及完整 metadata 预算检查。

metadata 准入使用与最终包相同的 canonical JSON 计算 owner、运行、段、gap、unavailable 说明和外层字段的 UTF-8 字节数；已完成的运行与停止证明按实际值精确计数。尚未形成的停止证明预留每代最多 1000 个进程身份，未知 native 字符串按 256 字节及其最大 JSON 转义开销预留；已知进程与 boot 身份使用实际值。未结束段的时长按 19 位整数预留，未知 nativeSessionId、全部剩余 gap 槽及候选新段同时计入；新运行的未分配绑定也按协议上限预留。该准入值包含保守预留，不等于最终包实测大小。最终封存仍对实际 JSON 严格检查 60 MiB、4 MiB 和 64 MiB 三个上限，不能只检查段与 gap 而遗漏运行停止证明。

实时完整帧允许覆盖一个尚未发送的旧帧，发送无进展达到 10 秒终止该投递；采样和落盘不等待 viewer。快照只在当前 binding、fence 与服务端已确认的完整 ledger 一致时发送。首次输入后的 nativeSessionId 补齐也会改变 ledger；输入后观察和普通轮询必须同步这一变化，未知结果继续对账原请求，确认后补发当前完整缓存帧。画面没有变化也能恢复投递，无需重启 Worker。已成功传输的输入 receipt 先通知执行层，再等待 ledger 同步；同步错误继续暴露并保留待对账请求，不能使原 assignment 回到待发送状态。重连可以发布当前完整画面，但不重放未知输入。live 的 `recorded=false` 不证明该画面已落盘。历史保存不因慢 viewer 丢弃登记内容。

## 不可变归档

执行槽与远端归档分离。本地所有原运行有 stopped proof、采集段已关闭后可释放执行槽；服务端 ledger 尚未同步仍需保留收尾责任。shutdown 保留原 claim 和 Session，不封最终归档。只有原 claim 已终态或已被其他 claim 替代时，才在独立收尾队列处理该 Session。

收尾先核验原生命周期与全部登记源，发布每代 closed recording evidence，再以持久的 finalizationId 请求服务端冻结。任务删除后的 410 终态仍保留原 owner 收尾责任；停止 ledger 的未知结果和归档进度均通过原 owner PAT 专用 `/archive/state` 读回，普通 Session 状态入口继续拒绝已删除任务。服务端冻结与恢复授权在同一 Session 锁下互斥。只有读回原 finalizationId 后才建立最终 seal；同一 seal 的正文、hash、size、completeness 固定，上传重试不能重建不同正文。可见的 journal 内容不替代持久确认；读取 receipt 或处置意图时重新完成文件与目录同步，失败则不能据此删除资源。

`herdr-archives/` 采用相同的目录持久化机制，独立保存 finalization/evidence 请求、seal、receipt、重试时间和处置记录。响应丢失先观察原 state 或 receipt；远端已 ready 时恢复原回执，不重新启动 agent、不重复输入。服务端校验并读回上传正文，Worker 再核对不可变 receipt 的原 fence、finalizationId、hash、size 和 completeness。

合法未启用录制，或无采集错误且首帧前正常结束，取得带明确原因的 unavailable 终态回执。首帧前崩溃且没有持久正常结束的运行保留 failed，不能当作正常零帧。捕获故障零帧、缺失源、旧运行没有 recording responsibility 均不能走该分支。旧内容不被猜成零帧，也不补造历史录制责任。

短暂失败持久退避 5 秒至 5 分钟，每轮最多一个历史归档。权限失效保留原 owner 并停止自动上传，需恢复原权限后显式 retry。永久损坏停止内容重试；必要时只继续收敛服务端 failed 状态。ready 后本地源继续保留，不新增自动 GC。

## 资源门禁与人工处置

保留资源最多 20 个 worktree、待归档源共 2 GiB；实际可用磁盘低于 1 GiB 阻止新 claim。ready 源仍影响实际磁盘可用量。同 task 的旧 worktree 仍预留原路径，不能被新 claim 覆盖。stop_unknown 保留执行槽；已运行的其他任务不因资源门槛被停止。

claim 登记先于 worktree 准备，因此已终态的登记可能从未创建任何资源。这类责任使用独立持久退休记录收敛：核验原 owner 的当前认证与原 claim 的权威终态，在原 claim 串行区间确认没有在途执行、准备、运行、采集段、注册或输入责任，并同时核对实际工作目录、Git 注册、录制源与归档源均不存在。空 `preparation` 和空 `runs` 本身不足以证明未创建 worktree；准备中断留下的目录或 Git 注册、读取错误及未知终态都继续保留责任。退休提交核对原生命周期版本，重启后幂等结束同一 claim 的本机任务与清理计划；退休记录禁止再次启动该 claim，并从保留资源与待停止集合中排除。本机任务和清理计划已收敛后，不再用历史路径阻止项目映射变更；收敛尚未完成时继续核验原路径并阻止新准入。此路径不删除文件，不生成 native stop proof、录制内容或 ready/unavailable receipt，也不触碰同 task 后继 claim 的资源。

正常 worktree 删除要求先持久保存 ready/unavailable receipt，再复用原 Git 身份、占用检查和安全删除机制；中断后只继续该删除，不改变历史归档。持久删除记录还承担本地调度收敛责任：核对原 owner、worktree、停止证明与回执或已完成的显式 delete 后，幂等结束对应本机任务并删除其清理计划，再移除内存中的收尾占位。SQLite 写失败保留删除记录，重启继续收敛；不能仅因资源不再列入保留集合就丢弃该责任，也不能影响同 task 的其他 claim。保留资源、待停止记录、容量和旧 claim 屏障必须一致采用已验证的持久删除决策；显式 delete 完成后，尚未同步的 stopped ledger 不能重新占槽或阻挡后继 claim。该决策不修改 ledger hash，不伪造服务端确认；未完成删除或无法验证原身份及停止证明时继续保留责任。人工 `worker resources` 入口列出原 claim/Session、停止证据、源与工作区、归档状态和处置结果。命令格式由 [CLI 手册](../../packages/daynight/README.md)拥有。

显式处置要求匹配原 project/task/claim/session/worktree、已确认停止、当前原 owner 身份与终态 claim，以及操作 ID、动作和确认。abandon 停止重试并保留资源；delete 先持久处置意图，核对源目录 inode 身份，复用安全 Git 删除并删除所选源。原 owner PAT 的身份校验不能代替 claim 终态证明：任务读取的 `404/not_found` 可能隐藏已撤销的项目访问权限，必须拒绝处置；只有已核验的终态任务或明确且结果已确认的 `410/task_deleted` 才能作为远端结束证据。未知停止、错身份、仍可恢复的 active claim 和未确认请求均拒绝。处置记录与归档真相分开，不能伪造 ready 或 unavailable；不提供自动过期删除。

## 验证边界

文件、journal、SQLite 生命周期和上传响应丢失测试验证持久顺序与恢复拒绝；真实隔离 macOS daemon 验证只读采样、原生几何及资源开销。模拟服务端和进程 fixture 不证明真实 provider 执行业务，也不替代统一 Session 页面与最终组合验收。运行计数、体积、CPU 和具体 revision 随交付证据保存，不作为固定性能承诺。
